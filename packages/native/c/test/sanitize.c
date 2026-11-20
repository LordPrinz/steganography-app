/*
 * Memory-safety harness, built with -fsanitize=address,undefined by `bun run native:sanitize`.
 *
 * Buffers handed over from JavaScript live in the JS heap, where ASan has no redzones, so an
 * overflow there goes unnoticed. Here every buffer is malloc'ed with its exact size and any
 * out-of-bounds access aborts. The TypeScript tests cover correctness in depth; this file drives
 * every kernel through many shapes, the size limits and invalid arguments, and checks round trips.
 * Each new kernel adds a case.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../stego.h"

static int failures = 0;

#define EXPECT(cond)                                                                               \
  do {                                                                                             \
    if (!(cond)) {                                                                                 \
      fprintf(stderr, "%s:%d: expected %s\n", __FILE__, __LINE__, #cond);                          \
      failures++;                                                                                  \
    }                                                                                              \
  } while (0)

static uint32_t rng = 0x9e3779b9u;
static uint8_t next_byte(void) {
  rng ^= rng << 13;
  rng ^= rng >> 17;
  rng ^= rng << 5;
  return (uint8_t)rng;
}

static void *alloc(uint64_t bytes) {
  void *p = malloc(bytes);
  if (!p) {
    fprintf(stderr, "out of memory\n");
    exit(2);
  }
  return p;
}

static void color_case(uint32_t w, uint32_t h) {
  uint64_t n = (uint64_t)w * h, pb = n * sizeof(float);
  uint8_t *rgba = alloc(n * 4), *alpha = alloc(n), *out = alloc(n * 4);
  float *y = alloc(pb), *cb = alloc(pb), *cr = alloc(pb);
  for (uint64_t i = 0; i < n * 4; i++)
    rgba[i] = next_byte();

  EXPECT(stego_rgba_to_ycbcr(rgba, n * 4, w, h, y, pb, cb, pb, cr, pb, alpha, n) == STEGO_OK);
  EXPECT(stego_ycbcr_to_rgba(y, pb, cb, pb, cr, pb, alpha, n, w, h, out, n * 4) == STEGO_OK);
  EXPECT(memcmp(rgba, out, n * 4) == 0);

  /* Lengths one byte off in either direction are rejected before any access. */
  EXPECT(stego_rgba_to_ycbcr(rgba, n * 4 + 1, w, h, y, pb, cb, pb, cr, pb, alpha, n) ==
         STEGO_E_LENGTH);
  EXPECT(stego_rgba_to_ycbcr(rgba, n * 4, w, h, y, pb - 1, cb, pb, cr, pb, alpha, n) ==
         STEGO_E_LENGTH);
  EXPECT(stego_ycbcr_to_rgba(y, pb, cb, pb, cr, pb, alpha, n - 1, w, h, out, n * 4) ==
         STEGO_E_LENGTH);
  EXPECT(stego_ycbcr_to_rgba(y, pb, cb, pb, cr, pb, alpha, n, w, h, out, n * 4 - 1) ==
         STEGO_E_LENGTH);

  /* Out-of-range and NaN floats must be clamped before the integer conversion. */
  for (uint64_t i = 0; i < n; i++)
    cb[i] = cr[i] = 128.0f;
  y[0] = NAN;
  EXPECT(stego_ycbcr_to_rgba(y, pb, cb, pb, cr, pb, alpha, n, w, h, out, n * 4) == STEGO_OK);
  EXPECT(out[0] == 0 && out[1] == 0 && out[2] == 0);
  y[n - 1] = INFINITY;
  EXPECT(stego_ycbcr_to_rgba(y, pb, cb, pb, cr, pb, alpha, n, w, h, out, n * 4) == STEGO_OK);
  EXPECT(out[(n - 1) * 4] == 255 && out[(n - 1) * 4 + 1] == 255 && out[(n - 1) * 4 + 2] == 255);
  cb[0] = -INFINITY;
  cr[n - 1] = 1e30f;
  EXPECT(stego_ycbcr_to_rgba(y, pb, cb, pb, cr, pb, alpha, n, w, h, out, n * 4) == STEGO_OK);

  free(rgba);
  free(alpha);
  free(out);
  free(y);
  free(cb);
  free(cr);
}

static void color_invalid(void) {
  /* Buffers sized for a 1 x 1 image, so the checks hold whatever order C tests them in. */
  uint8_t rgba[4] = {0}, alpha[1] = {0}, out[4] = {0};
  float y[1] = {0}, cb[1] = {0}, cr[1] = {0};

  /* Each pointer NULL in turn. */
  EXPECT(stego_rgba_to_ycbcr(NULL, 4, 1, 1, y, 4, cb, 4, cr, 4, alpha, 1) == STEGO_E_NULL);
  EXPECT(stego_rgba_to_ycbcr(rgba, 4, 1, 1, NULL, 4, cb, 4, cr, 4, alpha, 1) == STEGO_E_NULL);
  EXPECT(stego_rgba_to_ycbcr(rgba, 4, 1, 1, y, 4, NULL, 4, cr, 4, alpha, 1) == STEGO_E_NULL);
  EXPECT(stego_rgba_to_ycbcr(rgba, 4, 1, 1, y, 4, cb, 4, NULL, 4, alpha, 1) == STEGO_E_NULL);
  EXPECT(stego_rgba_to_ycbcr(rgba, 4, 1, 1, y, 4, cb, 4, cr, 4, NULL, 1) == STEGO_E_NULL);
  EXPECT(stego_ycbcr_to_rgba(NULL, 4, cb, 4, cr, 4, alpha, 1, 1, 1, out, 4) == STEGO_E_NULL);
  EXPECT(stego_ycbcr_to_rgba(y, 4, NULL, 4, cr, 4, alpha, 1, 1, 1, out, 4) == STEGO_E_NULL);
  EXPECT(stego_ycbcr_to_rgba(y, 4, cb, 4, NULL, 4, alpha, 1, 1, 1, out, 4) == STEGO_E_NULL);
  EXPECT(stego_ycbcr_to_rgba(y, 4, cb, 4, cr, 4, NULL, 1, 1, 1, out, 4) == STEGO_E_NULL);
  EXPECT(stego_ycbcr_to_rgba(y, 4, cb, 4, cr, 4, alpha, 1, 1, 1, NULL, 4) == STEGO_E_NULL);

  /* Dimensions: zero, a side above STEGO_MAX_SIDE, valid sides above STEGO_MAX_PIXELS. 65536^2
   * would also overflow 32-bit arithmetic. */
  static const uint32_t bad[][2] = {{0, 1},        {1, 0},         {STEGO_MAX_SIDE + 1, 1},
                                    {16384, 1025}, {16384, 16384}, {65536, 65536}};
  for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
    uint32_t w = bad[i][0], h = bad[i][1];
    EXPECT(stego_rgba_to_ycbcr(rgba, 4, w, h, y, 4, cb, 4, cr, 4, alpha, 1) == STEGO_E_DIMENSIONS);
    EXPECT(stego_ycbcr_to_rgba(y, 4, cb, 4, cr, 4, alpha, 1, w, h, out, 4) == STEGO_E_DIMENSIONS);
  }
}

static void lsb_case(uint32_t w, uint32_t h, uint32_t k) {
  uint64_t n = (uint64_t)w * h, capacity = n * 3 * k;
  uint8_t *rgba = alloc(n * 4), *out = alloc(n * 4), *bits = alloc(capacity),
          *read = alloc(capacity);
  for (uint64_t i = 0; i < n * 4; i++)
    rgba[i] = next_byte();
  for (uint64_t i = 0; i < capacity; i++)
    bits[i] = next_byte() & 1;

  EXPECT(stego_lsb_embed(rgba, n * 4, w, h, k, bits, capacity, out, n * 4) == STEGO_OK);
  EXPECT(stego_lsb_extract(out, n * 4, w, h, k, read, capacity) == STEGO_OK);
  EXPECT(memcmp(bits, read, capacity) == 0);
  for (uint64_t i = 3; i < n * 4; i += 4)
    EXPECT(out[i] == rgba[i]);

  /* A partial embed and an empty one; NULL bits are fine when there are none. */
  EXPECT(stego_lsb_embed(rgba, n * 4, w, h, k, bits, 1, out, n * 4) == STEGO_OK);
  EXPECT(stego_lsb_embed(rgba, n * 4, w, h, k, NULL, 0, out, n * 4) == STEGO_OK);
  EXPECT(memcmp(rgba, out, n * 4) == 0);
  EXPECT(stego_lsb_extract(out, n * 4, w, h, k, NULL, 0) == STEGO_OK);

  /* One bit past the capacity and image buffers one byte off are rejected before any access. */
  EXPECT(stego_lsb_embed(rgba, n * 4, w, h, k, bits, capacity + 1, out, n * 4) == STEGO_E_LENGTH);
  EXPECT(stego_lsb_extract(out, n * 4, w, h, k, read, capacity + 1) == STEGO_E_LENGTH);
  EXPECT(stego_lsb_embed(rgba, n * 4 - 1, w, h, k, bits, 1, out, n * 4) == STEGO_E_LENGTH);
  EXPECT(stego_lsb_embed(rgba, n * 4, w, h, k, bits, 1, out, n * 4 + 1) == STEGO_E_LENGTH);
  EXPECT(stego_lsb_extract(rgba, n * 4 + 1, w, h, k, read, 1) == STEGO_E_LENGTH);

  free(rgba);
  free(out);
  free(bits);
  free(read);
}

static void lsb_invalid(void) {
  uint8_t rgba[4] = {0}, out[4] = {0}, bits[3] = {0};

  EXPECT(stego_lsb_embed(NULL, 4, 1, 1, 1, bits, 3, out, 4) == STEGO_E_NULL);
  EXPECT(stego_lsb_embed(rgba, 4, 1, 1, 1, NULL, 3, out, 4) == STEGO_E_NULL);
  EXPECT(stego_lsb_embed(rgba, 4, 1, 1, 1, bits, 3, NULL, 4) == STEGO_E_NULL);
  EXPECT(stego_lsb_extract(NULL, 4, 1, 1, 1, bits, 3) == STEGO_E_NULL);
  EXPECT(stego_lsb_extract(rgba, 4, 1, 1, 1, NULL, 3) == STEGO_E_NULL);

  static const uint32_t bad_k[] = {0, STEGO_LSB_MAX_BITS + 1, UINT32_MAX};
  for (size_t i = 0; i < sizeof bad_k / sizeof bad_k[0]; i++) {
    EXPECT(stego_lsb_embed(rgba, 4, 1, 1, bad_k[i], bits, 3, out, 4) == STEGO_E_ARGUMENT);
    EXPECT(stego_lsb_extract(rgba, 4, 1, 1, bad_k[i], bits, 3) == STEGO_E_ARGUMENT);
  }

  static const uint32_t bad[][2] = {{0, 1}, {1, 0}, {STEGO_MAX_SIDE + 1, 1}, {65536, 65536}};
  for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
    EXPECT(stego_lsb_embed(rgba, 4, bad[i][0], bad[i][1], 1, bits, 3, out, 4) ==
           STEGO_E_DIMENSIONS);
    EXPECT(stego_lsb_extract(rgba, 4, bad[i][0], bad[i][1], 1, bits, 3) == STEGO_E_DIMENSIONS);
  }
}

static void blur_case(uint32_t w, uint32_t h, uint64_t taps) {
  uint64_t n = (uint64_t)w * h, sb = (uint64_t)w * 3 * sizeof(double), kb = taps * sizeof(double);
  uint8_t *rgba = alloc(n * 4), *out = alloc(n * 4);
  double *kernel = alloc(kb), *scratch = alloc(sb);
  for (uint64_t i = 0; i < n * 4; i++)
    rgba[i] = next_byte();
  for (uint64_t i = 0; i < taps; i++)
    kernel[i] = 1.0 / (double)taps;

  EXPECT(stego_blur_separable(rgba, n * 4, w, h, kernel, kb, scratch, sb, out, n * 4) == STEGO_OK);
  for (uint64_t i = 3; i < n * 4; i += 4)
    EXPECT(out[i] == rgba[i]);

  /* A one-tap identity kernel returns the input. */
  kernel[0] = 1.0;
  EXPECT(stego_blur_separable(rgba, n * 4, w, h, kernel, sizeof(double), scratch, sb, out, n * 4) ==
         STEGO_OK);
  EXPECT(memcmp(rgba, out, n * 4) == 0);

  /* Weights that overflow or are NaN still clamp before the integer conversion. */
  kernel[0] = INFINITY;
  EXPECT(stego_blur_separable(rgba, n * 4, w, h, kernel, sizeof(double), scratch, sb, out, n * 4) ==
         STEGO_OK);
  kernel[0] = NAN;
  EXPECT(stego_blur_separable(rgba, n * 4, w, h, kernel, sizeof(double), scratch, sb, out, n * 4) ==
         STEGO_OK);

  /* Buffers one byte off are rejected before any access. */
  EXPECT(stego_blur_separable(rgba, n * 4 - 1, w, h, kernel, kb, scratch, sb, out, n * 4) ==
         STEGO_E_LENGTH);
  EXPECT(stego_blur_separable(rgba, n * 4, w, h, kernel, kb, scratch, sb - 1, out, n * 4) ==
         STEGO_E_LENGTH);
  EXPECT(stego_blur_separable(rgba, n * 4, w, h, kernel, kb, scratch, sb, out, n * 4 + 1) ==
         STEGO_E_LENGTH);
  EXPECT(stego_blur_separable(rgba, n * 4, w, h, kernel, kb - 1, scratch, sb, out, n * 4) ==
         STEGO_E_LENGTH);

  free(rgba);
  free(out);
  free(kernel);
  free(scratch);
}

static void blur_invalid(void) {
  uint8_t rgba[4] = {0}, out[4] = {0};
  double kernel[3] = {0.25, 0.5, 0.25}, scratch[3] = {0};
  uint64_t kb = sizeof kernel, sb = sizeof scratch;

  EXPECT(stego_blur_separable(NULL, 4, 1, 1, kernel, kb, scratch, sb, out, 4) == STEGO_E_NULL);
  EXPECT(stego_blur_separable(rgba, 4, 1, 1, NULL, kb, scratch, sb, out, 4) == STEGO_E_NULL);
  EXPECT(stego_blur_separable(rgba, 4, 1, 1, kernel, kb, NULL, sb, out, 4) == STEGO_E_NULL);
  EXPECT(stego_blur_separable(rgba, 4, 1, 1, kernel, kb, scratch, sb, NULL, 4) == STEGO_E_NULL);

  /* Even tap counts (including none) and kernels longer than the limit. */
  EXPECT(stego_blur_separable(rgba, 4, 1, 1, kernel, 0, scratch, sb, out, 4) == STEGO_E_ARGUMENT);
  EXPECT(stego_blur_separable(rgba, 4, 1, 1, kernel, 2 * sizeof(double), scratch, sb, out, 4) ==
         STEGO_E_ARGUMENT);
  EXPECT(stego_blur_separable(rgba, 4, 1, 1, kernel, (STEGO_BLUR_MAX_TAPS + 2) * sizeof(double),
                              scratch, sb, out, 4) == STEGO_E_ARGUMENT);

  static const uint32_t bad[][2] = {{0, 1}, {1, 0}, {STEGO_MAX_SIDE + 1, 1}, {65536, 65536}};
  for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++)
    EXPECT(stego_blur_separable(rgba, 4, bad[i][0], bad[i][1], kernel, kb, scratch, sb, out, 4) ==
           STEGO_E_DIMENSIONS);
}

int main(void) {
  EXPECT(stego_abi_version() == STEGO_ABI_VERSION);

  /* The last two shapes are the largest images the limits allow. */
  static const uint32_t shapes[][2] = {{1, 1},   {1, 7},   {7, 1},        {3, 5},      {8, 8},
                                       {37, 23}, {257, 3}, {16384, 1024}, {4096, 4096}};
  for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++)
    color_case(shapes[i][0], shapes[i][1]);
  color_invalid();

  for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++)
    lsb_case(shapes[i][0], shapes[i][1], 1);
  /* Every bit depth on small shapes; the largest images already ran with one bit. */
  for (uint32_t k = 2; k <= STEGO_LSB_MAX_BITS; k++) {
    lsb_case(3, 5, k);
    lsb_case(37, 23, k);
  }
  lsb_invalid();

  for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++)
    blur_case(shapes[i][0], shapes[i][1], 3);
  /* Kernels much wider than the image, up to the longest allowed. */
  blur_case(1, 1, STEGO_BLUR_MAX_TAPS);
  blur_case(3, 5, 61);
  blur_case(37, 23, STEGO_BLUR_MAX_TAPS);
  blur_invalid();

  if (failures) {
    fprintf(stderr, "sanitize: %d check(s) failed\n", failures);
    return 1;
  }
  printf("sanitize: all checks passed\n");
  return 0;
}
