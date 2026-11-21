/*
 * Koch-Zhao embedding in the 8 x 8 DCT blocks of the luminance.
 *
 * Block i (row-major over whole blocks; a remainder of fewer than 8 pixels on the right and bottom
 * edges is never touched) holds bit i. With the orthonormal DCT-II coefficients c1 and c2 at the
 * two configured positions, the bit is read as 1 when |c1| > |c2| and as 0 otherwise.
 *
 * Embedding pushes the two magnitudes apart until they differ by at least the strength P, keeping
 * their mean and signs, and spreads the change over the block as c1 and c2 times their basis
 * functions. Only two coefficients are needed, so no full transform runs. The change is added to
 * R, G and B alike, which moves Y by exactly that amount and leaves Cb and Cr alone.
 *
 * Rounding to 8 bits and clamping at 0 and 255 disturb the coefficients, so every block is checked
 * the way extraction reads it. When the check fails the margin doubles and the block is redone from
 * the original pixels. A block that still fails after STEGO_DCT_ATTEMPTS doublings makes the call
 * return STEGO_E_EMBED. Hence extract(embed(image)) always gives back the bits.
 *
 * Arithmetic is double in a fixed order with -ffp-contract=off; the cosines come from a table of
 * cos(k * pi / 16) so no libm is needed.
 */
#include <stdint.h>
#include <string.h>

#include "common.h"

#define BLOCK 8u
#define BLOCK_PIXELS (BLOCK * BLOCK)

/* cos(k * pi / 16) for k = 0..8. */
static const double COS16[9] = {1.0,
                                0.98078528040323043,
                                0.92387953251128674,
                                0.83146961230254524,
                                0.70710678118654757,
                                0.55557023301960229,
                                0.38268343236508984,
                                0.19509032201612833,
                                0.0};

/* cos((2 * x + 1) * f * pi / 16) with the argument folded into the table's range. */
static double cos_term(uint32_t x, uint32_t f) {
  uint32_t k = (2 * x + 1) * f % 32; /* the period of the argument in units of pi / 16 */
  if (k > 16) k = 32 - k;
  return k <= 8 ? COS16[k] : -COS16[16 - k];
}

/* Orthonormal scaling of frequency f: sqrt(1/8) for f = 0, sqrt(2/8) otherwise. */
static double scale(uint32_t f) { return f == 0 ? 0.35355339059327379 : 0.5; }

/* basis[j * 8 + i] for horizontal frequency u and vertical frequency v. */
static void make_basis(double *basis, uint32_t u, uint32_t v) {
  double s = scale(u) * scale(v);
  for (uint32_t j = 0; j < BLOCK; j++)
    for (uint32_t i = 0; i < BLOCK; i++)
      basis[j * BLOCK + i] = s * (cos_term(i, u) * cos_term(j, v));
}

static inline double luma(const uint8_t *p) { return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]; }

/* Coefficient of the block whose top-left pixel is at byte offset `origin`. */
static double coefficient(const uint8_t *rgba, uint64_t origin, uint32_t width,
                          const double *basis) {
  double sum = 0.0;
  for (uint32_t j = 0; j < BLOCK; j++)
    for (uint32_t i = 0; i < BLOCK; i++)
      sum += luma(rgba + origin + ((uint64_t)j * width + i) * 4) * basis[j * BLOCK + i];
  return sum;
}

static int32_t dct_check(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                         uint32_t u1, uint32_t v1, uint32_t u2, uint32_t v2, const uint8_t *bits,
                         uint64_t bit_count, const double *scratch, uint64_t scratch_bytes) {
  if (!rgba || !scratch || (!bits && bit_count > 0)) return STEGO_E_NULL;
  uint64_t n = stego_pixel_count(width, height);
  if (n == 0) return STEGO_E_DIMENSIONS;
  if (u1 >= BLOCK || v1 >= BLOCK || u2 >= BLOCK || v2 >= BLOCK) return STEGO_E_ARGUMENT;
  if ((u1 == 0 && v1 == 0) || (u2 == 0 && v2 == 0) || (u1 == u2 && v1 == v2))
    return STEGO_E_ARGUMENT;
  if (rgba_bytes != n * 4 || scratch_bytes != STEGO_DCT_SCRATCH_DOUBLES * sizeof(double) ||
      bit_count > (uint64_t)(width / BLOCK) * (height / BLOCK))
    return STEGO_E_LENGTH;
  return STEGO_OK;
}

static inline uint64_t block_origin(uint64_t block, uint32_t width) {
  uint64_t per_row = width / BLOCK;
  return ((block / per_row) * BLOCK * width + (block % per_row) * BLOCK) * 4;
}

/* Magnitudes with hi - lo = margin, centred on the old mean, lo never below zero. */
static void spread(double a, double b, double margin, int bit, double *a_new, double *b_new) {
  double mid = (a + b) / 2.0;
  double hi = mid + margin / 2.0, lo = mid - margin / 2.0;
  if (lo < 0.0) {
    lo = 0.0;
    hi = margin;
  }
  *a_new = bit ? hi : lo;
  *b_new = bit ? lo : hi;
}

static inline double magnitude(double c) { return c < 0.0 ? -c : c; }

static inline int decodes_as(double c1, double c2, int bit) {
  return (magnitude(c1) > magnitude(c2)) == (bit != 0);
}

int32_t stego_dct_embed(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                        uint32_t u1, uint32_t v1, uint32_t u2, uint32_t v2, double strength,
                        const uint8_t *bits, uint64_t bit_count, double *scratch,
                        uint64_t scratch_bytes, uint8_t *out, uint64_t out_bytes) {
  int32_t status = dct_check(rgba, rgba_bytes, width, height, u1, v1, u2, v2, bits, bit_count,
                             scratch, scratch_bytes);
  if (status != STEGO_OK) return status;
  if (!out) return STEGO_E_NULL;
  if (out_bytes != rgba_bytes) return STEGO_E_LENGTH;
  /* The retry loop reads rgba after writing out, so the buffers must be disjoint. */
  uintptr_t in_start = (uintptr_t)rgba, out_start = (uintptr_t)out;
  if (in_start < out_start + out_bytes && out_start < in_start + rgba_bytes)
    return STEGO_E_ARGUMENT;
  if (!(strength > 0.0) || strength > STEGO_DCT_MAX_STRENGTH) return STEGO_E_ARGUMENT;

  double *basis1 = scratch, *basis2 = scratch + BLOCK_PIXELS;
  make_basis(basis1, u1, v1);
  make_basis(basis2, u2, v2);

  memcpy(out, rgba, rgba_bytes);
  for (uint64_t block = 0; block < bit_count; block++) {
    uint64_t origin = block_origin(block, width);
    int bit = bits[block] & 1;
    double c1 = coefficient(rgba, origin, width, basis1);
    double c2 = coefficient(rgba, origin, width, basis2);
    double a = magnitude(c1), b = magnitude(c2);
    int satisfied = (bit ? a - b : b - a) >= strength;

    double margin = strength;
    int done = 0;
    for (unsigned attempt = 0; attempt <= STEGO_DCT_ATTEMPTS && !done; attempt++, margin *= 2.0) {
      double a_new = a, b_new = b;
      if (!satisfied) spread(a, b, margin, bit, &a_new, &b_new);
      double d1 = (c1 < 0.0 ? -a_new : a_new) - c1, d2 = (c2 < 0.0 ? -b_new : b_new) - c2;
      for (uint32_t j = 0; j < BLOCK; j++)
        for (uint32_t i = 0; i < BLOCK; i++) {
          uint64_t at = origin + ((uint64_t)j * width + i) * 4;
          double d = d1 * basis1[j * BLOCK + i] + d2 * basis2[j * BLOCK + i];
          out[at] = stego_clamp_u8(rgba[at] + d);
          out[at + 1] = stego_clamp_u8(rgba[at + 1] + d);
          out[at + 2] = stego_clamp_u8(rgba[at + 2] + d);
        }
      done = decodes_as(coefficient(out, origin, width, basis1),
                        coefficient(out, origin, width, basis2), bit);
    }
    if (!done) return STEGO_E_EMBED;
  }
  return STEGO_OK;
}

int32_t stego_dct_extract(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                          uint32_t u1, uint32_t v1, uint32_t u2, uint32_t v2, uint8_t *bits,
                          uint64_t bit_count, double *scratch, uint64_t scratch_bytes) {
  int32_t status = dct_check(rgba, rgba_bytes, width, height, u1, v1, u2, v2, bits, bit_count,
                             scratch, scratch_bytes);
  if (status != STEGO_OK) return status;

  double *basis1 = scratch, *basis2 = scratch + BLOCK_PIXELS;
  make_basis(basis1, u1, v1);
  make_basis(basis2, u2, v2);
  for (uint64_t block = 0; block < bit_count; block++) {
    uint64_t origin = block_origin(block, width);
    double c1 = coefficient(rgba, origin, width, basis1);
    double c2 = coefficient(rgba, origin, width, basis2);
    bits[block] = magnitude(c1) > magnitude(c2);
  }
  return STEGO_OK;
}
