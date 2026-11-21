/*
 * Multi-level 2-D Haar DWT on luminance with quantisation index modulation (QIM).
 *
 * The transform is the orthonormal Haar step along rows, then columns, repeated on the LL quadrant
 * (Mallat layout, in place). Only the top-left region with sides that are multiples of 2^level is
 * transformed; the rest is left untouched. Luminance is Y of stego_rgba_to_ycbcr, in double.
 *
 * QIM with step d: bit 0 sits on k * d, bit 1 on k * d + d / 2; reading takes the nearer lattice.
 *
 * Back in 8-bit RGB: each pixel's luma change is rounded and added to R, G and B, then clamped.
 * The embedder reads the result back like the extractor and moves wrongly decoded coefficients
 * again, up to STEGO_DWT_MAX_PASSES times; leftovers are counted in *failed. An LL coefficient can
 * only lie in [0, 255 * 2^level], so its target is the nearest lattice point inside that range.
 */
#include <string.h>

#include "common.h"

#define HAAR_NORM 0.70710678118654752440

/* Largest step: keeps coefficient / step small enough for the int64 conversion in dwt_floor. */
#define MAX_STEP 65536.0

/* Floor without libm, valid for |x| below 2^62. */
static inline double dwt_floor(double x) {
  int64_t i = (int64_t)x;
  return (double)(x < (double)i ? i - 1 : i);
}

typedef struct {
  uint32_t width;
  uint32_t level;
  /* Range a coefficient of the band can take: bounded for LL, open for the detail bands. */
  double lowest, highest;
  /* Transformed region: sides are multiples of 2^level. */
  uint32_t region_w, region_h;
  /* Band rectangle at the chosen level inside the plane. */
  uint32_t band_x, band_y, band_w, band_h;
} dwt_geometry;

static dwt_geometry geometry(uint32_t width, uint32_t height, uint32_t band, uint32_t level) {
  dwt_geometry g;
  g.width = width;
  g.level = level;
  g.band_w = width >> level;
  g.band_h = height >> level;
  g.region_w = g.band_w << level;
  g.region_h = g.band_h << level;
  g.lowest = band == STEGO_DWT_LL ? 0.0 : -1e300;
  g.highest = band == STEGO_DWT_LL ? 255.0 * (double)(1u << level) : 1e300;
  g.band_x = band == STEGO_DWT_HL ? g.band_w : 0;
  g.band_y = band == STEGO_DWT_LH ? g.band_h : 0;
  return g;
}

static inline double luma(const uint8_t *px) {
  return 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
}

/* One Haar step on the top-left cw x ch block of a plane with the given stride. */
static void haar_forward(double *p, uint32_t stride, uint32_t cw, uint32_t ch, double *line) {
  for (uint32_t y = 0; y < ch; y++) {
    double *row = p + (uint64_t)y * stride;
    for (uint32_t i = 0; i < cw / 2; i++) {
      line[i] = (row[2 * i] + row[2 * i + 1]) * HAAR_NORM;
      line[cw / 2 + i] = (row[2 * i] - row[2 * i + 1]) * HAAR_NORM;
    }
    memcpy(row, line, (size_t)cw * sizeof(double));
  }
  for (uint32_t x = 0; x < cw; x++) {
    for (uint32_t i = 0; i < ch / 2; i++) {
      double a = p[(uint64_t)(2 * i) * stride + x], b = p[(uint64_t)(2 * i + 1) * stride + x];
      line[i] = (a + b) * HAAR_NORM;
      line[ch / 2 + i] = (a - b) * HAAR_NORM;
    }
    for (uint32_t y = 0; y < ch; y++)
      p[(uint64_t)y * stride + x] = line[y];
  }
}

static void haar_inverse(double *p, uint32_t stride, uint32_t cw, uint32_t ch, double *line) {
  for (uint32_t x = 0; x < cw; x++) {
    for (uint32_t i = 0; i < ch / 2; i++) {
      double lo = p[(uint64_t)i * stride + x], hi = p[(uint64_t)(ch / 2 + i) * stride + x];
      line[2 * i] = (lo + hi) * HAAR_NORM;
      line[2 * i + 1] = (lo - hi) * HAAR_NORM;
    }
    for (uint32_t y = 0; y < ch; y++)
      p[(uint64_t)y * stride + x] = line[y];
  }
  for (uint32_t y = 0; y < ch; y++) {
    double *row = p + (uint64_t)y * stride;
    for (uint32_t i = 0; i < cw / 2; i++) {
      line[2 * i] = (row[i] + row[cw / 2 + i]) * HAAR_NORM;
      line[2 * i + 1] = (row[i] - row[cw / 2 + i]) * HAAR_NORM;
    }
    memcpy(row, line, (size_t)cw * sizeof(double));
  }
}

static void forward(double *p, const dwt_geometry *g, double *line) {
  for (uint32_t l = 0; l < g->level; l++)
    haar_forward(p, g->width, g->region_w >> l, g->region_h >> l, line);
}

static void inverse(double *p, const dwt_geometry *g, double *line) {
  for (uint32_t l = g->level; l-- > 0;)
    haar_inverse(p, g->width, g->region_w >> l, g->region_h >> l, line);
}

static void load_luma(double *plane, const uint8_t *rgba, const dwt_geometry *g) {
  for (uint32_t y = 0; y < g->region_h; y++)
    for (uint32_t x = 0; x < g->region_w; x++) {
      uint64_t at = (uint64_t)y * g->width + x;
      plane[at] = luma(rgba + at * 4);
    }
}

/* Rounds every plane value half up and adds it to R, G and B, clamped to 0..255. */
static void add_to_rgb(uint8_t *rgba, const double *plane, const dwt_geometry *g) {
  for (uint32_t y = 0; y < g->region_h; y++)
    for (uint32_t x = 0; x < g->region_w; x++) {
      uint64_t at = (uint64_t)y * g->width + x;
      double d = dwt_floor(plane[at] + 0.5);
      if (d == 0.0) continue;
      for (int c = 0; c < 3; c++)
        rgba[at * 4 + c] = stego_clamp_u8((double)rgba[at * 4 + c] + d);
    }
}

/* Plane position of the i-th coefficient of the band. */
static inline double *coefficient(double *plane, const dwt_geometry *g, uint64_t i) {
  return plane + (uint64_t)(g->band_y + i / g->band_w) * g->width + g->band_x + i % g->band_w;
}

/* Sets every plane value to zero except the first bit_count coefficients of the band. */
static void clear_except_prefix(double *plane, const dwt_geometry *g, uint64_t bit_count) {
  for (uint32_t y = 0; y < g->region_h; y++)
    for (uint32_t x = 0; x < g->region_w; x++) {
      int in_band = x >= g->band_x && y >= g->band_y && x - g->band_x < g->band_w &&
                    y - g->band_y < g->band_h;
      uint64_t i = in_band ? (uint64_t)(y - g->band_y) * g->band_w + (x - g->band_x) : 0;
      if (!in_band || i >= bit_count) plane[(uint64_t)y * g->width + x] = 0.0;
    }
}

static inline unsigned decode(double c, double step) {
  double r = c - step * dwt_floor(c / step);
  return r >= step / 4 && r < step * 3 / 4;
}

/* Nearest lattice point of the bit, moved one step inward when it lies outside the range. */
static inline double quantise(double c, unsigned bit, double step, const dwt_geometry *g) {
  double offset = bit ? step / 2 : 0.0;
  double q = dwt_floor((c - offset) / step + 0.5) * step + offset;
  if (q > g->highest && q - step >= g->lowest) q -= step;
  if (q < g->lowest && q + step <= g->highest) q += step;
  return q;
}

static int32_t dwt_check(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                         uint32_t band, uint32_t level, double step, const uint8_t *bits,
                         uint64_t bit_count, const double *plane, uint64_t plane_bytes,
                         const double *scratch, uint64_t scratch_bytes) {
  if (!rgba || !plane || !scratch || (!bits && bit_count > 0)) return STEGO_E_NULL;
  uint64_t n = stego_pixel_count(width, height);
  if (n == 0) return STEGO_E_DIMENSIONS;
  if (band > STEGO_DWT_LH || level < 1 || level > STEGO_DWT_MAX_LEVEL || !(step > 0.0) ||
      step > MAX_STEP)
    return STEGO_E_ARGUMENT;
  uint64_t line = width > height ? width : height;
  if (rgba_bytes != n * 4 || plane_bytes != n * sizeof(double) ||
      scratch_bytes != line * sizeof(double) ||
      bit_count > (uint64_t)(width >> level) * (height >> level))
    return STEGO_E_LENGTH;
  return STEGO_OK;
}

int32_t stego_dwt_qim_embed(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width,
                            uint32_t height, uint32_t band, uint32_t level, double step,
                            const uint8_t *bits, uint64_t bit_count, double *plane,
                            uint64_t plane_bytes, double *scratch, uint64_t scratch_bytes,
                            uint8_t *out, uint64_t out_bytes, uint64_t *failed,
                            uint64_t failed_bytes) {
  int32_t status = dwt_check(rgba, rgba_bytes, width, height, band, level, step, bits, bit_count,
                             plane, plane_bytes, scratch, scratch_bytes);
  if (status != STEGO_OK) return status;
  if (!out || !failed) return STEGO_E_NULL;
  if (out_bytes != rgba_bytes || failed_bytes != sizeof(uint64_t)) return STEGO_E_LENGTH;

  memmove(out, rgba, rgba_bytes);
  *failed = 0;
  if (bit_count == 0) return STEGO_OK;

  dwt_geometry g = geometry(width, height, band, level);
  for (uint32_t pass = 0;; pass++) {
    load_luma(plane, out, &g);
    forward(plane, &g, scratch);

    /* The plane becomes the change to apply: the move onto the lattice for the embedded
     * coefficients (all of them on the first pass, the wrongly decoded ones after) and zero
     * elsewhere. */
    clear_except_prefix(plane, &g, bit_count);
    uint64_t wrong = 0;
    for (uint64_t i = 0; i < bit_count; i++) {
      double *c = coefficient(plane, &g, i);
      unsigned bit = bits[i] & 1u;
      int bad = decode(*c, step) != bit;
      wrong += (uint64_t)bad;
      *c = pass == 0 || bad ? quantise(*c, bit, step, &g) - *c : 0.0;
    }

    if (pass > 0 && (wrong == 0 || pass == STEGO_DWT_MAX_PASSES)) {
      *failed = wrong;
      return STEGO_OK;
    }
    inverse(plane, &g, scratch);
    add_to_rgb(out, plane, &g);
  }
}

int32_t stego_dwt_qim_extract(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width,
                              uint32_t height, uint32_t band, uint32_t level, double step,
                              double *plane, uint64_t plane_bytes, double *scratch,
                              uint64_t scratch_bytes, uint8_t *bits, uint64_t bit_count) {
  int32_t status = dwt_check(rgba, rgba_bytes, width, height, band, level, step, bits, bit_count,
                             plane, plane_bytes, scratch, scratch_bytes);
  if (status != STEGO_OK) return status;
  if (bit_count == 0) return STEGO_OK;

  dwt_geometry g = geometry(width, height, band, level);
  load_luma(plane, rgba, &g);
  forward(plane, &g, scratch);
  for (uint64_t i = 0; i < bit_count; i++)
    bits[i] = (uint8_t)decode(*coefficient(plane, &g, i), step);
  return STEGO_OK;
}
