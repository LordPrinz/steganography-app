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

static void png_case(uint32_t w, uint32_t h) {
  uint64_t n = (uint64_t)w * h, lines = n * 4 + h, rgb_lines = n * 3 + h;
  uint8_t *rgba = alloc(n * 4), *out = alloc(n * 4), *filtered = alloc(lines),
          *rgb = alloc(rgb_lines);
  for (uint64_t i = 0; i < n * 4; i++)
    rgba[i] = next_byte();

  for (uint32_t f = 0; f <= STEGO_PNG_FILTER_ADAPTIVE; f++) {
    EXPECT(stego_png_filter(rgba, n * 4, w, h, f, filtered, lines) == STEGO_OK);
    EXPECT(stego_png_unfilter(filtered, lines, w, h, 4, out, n * 4) == STEGO_OK);
    EXPECT(memcmp(rgba, out, n * 4) == 0);
  }

  /* RGB rows are widened to RGBA in place; random rows with every filter type exercise that. */
  for (uint64_t i = 0; i < rgb_lines; i++)
    rgb[i] = next_byte();
  for (uint64_t y = 0; y < h; y++)
    rgb[y * ((uint64_t)w * 3 + 1)] = (uint8_t)(y % 5);
  EXPECT(stego_png_unfilter(rgb, rgb_lines, w, h, 3, out, n * 4) == STEGO_OK);
  EXPECT(out[3] == 255 && out[n * 4 - 1] == 255);

  EXPECT(stego_png_filter(rgba, n * 4 - 1, w, h, 0, filtered, lines) == STEGO_E_LENGTH);
  EXPECT(stego_png_filter(rgba, n * 4, w, h, 0, filtered, lines - 1) == STEGO_E_LENGTH);
  EXPECT(stego_png_unfilter(filtered, lines + 1, w, h, 4, out, n * 4) == STEGO_E_LENGTH);
  EXPECT(stego_png_unfilter(filtered, lines, w, h, 4, out, n * 4 - 1) == STEGO_E_LENGTH);
  EXPECT(stego_png_unfilter(rgb, rgb_lines, w, h, 4, out, n * 4) == STEGO_E_LENGTH);

  /* A bad filter byte in the last row is caught before any pixel is written. */
  filtered[lines - (uint64_t)w * 4 - 1] = 5;
  memset(out, 0xab, n * 4);
  EXPECT(stego_png_unfilter(filtered, lines, w, h, 4, out, n * 4) == STEGO_E_ARGUMENT);
  EXPECT(out[0] == 0xab);

  free(rgba);
  free(out);
  free(filtered);
  free(rgb);
}

static void png_invalid(void) {
  uint8_t rgba[4] = {0}, lines[5] = {0};

  EXPECT(stego_png_filter(NULL, 4, 1, 1, 0, lines, 5) == STEGO_E_NULL);
  EXPECT(stego_png_filter(rgba, 4, 1, 1, 0, NULL, 5) == STEGO_E_NULL);
  EXPECT(stego_png_unfilter(NULL, 5, 1, 1, 4, rgba, 4) == STEGO_E_NULL);
  EXPECT(stego_png_unfilter(lines, 5, 1, 1, 4, NULL, 4) == STEGO_E_NULL);

  EXPECT(stego_png_filter(rgba, 4, 1, 1, STEGO_PNG_FILTER_ADAPTIVE + 1, lines, 5) ==
         STEGO_E_ARGUMENT);
  for (uint32_t channels = 0; channels <= 8; channels++)
    if (channels != 3 && channels != 4)
      EXPECT(stego_png_unfilter(lines, 5, 1, 1, channels, rgba, 4) == STEGO_E_ARGUMENT);

  static const uint32_t bad[][2] = {{0, 1}, {1, 0}, {STEGO_MAX_SIDE + 1, 1}, {65536, 65536}};
  for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
    uint32_t w = bad[i][0], h = bad[i][1];
    EXPECT(stego_png_filter(rgba, 4, w, h, 0, lines, 5) == STEGO_E_DIMENSIONS);
    EXPECT(stego_png_unfilter(lines, 5, w, h, 4, rgba, 4) == STEGO_E_DIMENSIONS);
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

static void metrics_case(uint32_t w, uint32_t h) {
  uint64_t n = (uint64_t)w * h;
  uint8_t *a = alloc(n * 4), *b = alloc(n * 4);
  uint64_t sb = (uint64_t)w * STEGO_SSIM_SCRATCH_ROWS * sizeof(double);
  double *out = alloc(sizeof(double)), *scratch = alloc(sb);
  uint64_t *errors = alloc(sizeof(uint64_t));
  for (uint64_t i = 0; i < n * 4; i++)
    a[i] = next_byte();
  memcpy(b, a, n * 4);

  EXPECT(stego_luma_mse(a, n * 4, b, n * 4, w, h, out, sizeof(double)) == STEGO_OK);
  EXPECT(*out == 0.0);
  int32_t expected =
      w >= STEGO_SSIM_MIN_SIDE && h >= STEGO_SSIM_MIN_SIDE ? STEGO_OK : STEGO_E_DIMENSIONS;
  EXPECT(stego_luma_ssim(a, n * 4, b, n * 4, w, h, scratch, sb, out, sizeof(double)) == expected);
  if (expected == STEGO_OK) EXPECT(*out == 1.0);

  /* Treated as bit arrays, the two buffers differ exactly where the low bit was flipped. */
  for (uint64_t i = 0; i < n * 4; i += 3)
    b[i] ^= 1;
  EXPECT(stego_bit_errors(a, n * 4, b, n * 4, errors, sizeof(uint64_t)) == STEGO_OK);
  EXPECT(*errors == (n * 4 + 2) / 3);
  EXPECT(stego_luma_mse(a, n * 4, b, n * 4, w, h, out, sizeof(double)) == STEGO_OK);
  EXPECT(*out > 0.0);
  if (expected == STEGO_OK) {
    EXPECT(stego_luma_ssim(a, n * 4, b, n * 4, w, h, scratch, sb, out, sizeof(double)) == STEGO_OK);
    EXPECT(*out < 1.0);
  }

  /* Buffers one byte off are rejected before any access. */
  EXPECT(stego_luma_mse(a, n * 4 - 1, b, n * 4, w, h, out, sizeof(double)) == STEGO_E_LENGTH);
  EXPECT(stego_luma_ssim(a, n * 4, b, n * 4 + 1, w, h, scratch, sb, out, sizeof(double)) ==
         STEGO_E_LENGTH);
  EXPECT(stego_luma_ssim(a, n * 4, b, n * 4, w, h, scratch, sb, out, sizeof(double) - 1) ==
         STEGO_E_LENGTH);
  EXPECT(stego_bit_errors(a, n * 4, b, n * 4 - 1, errors, sizeof(uint64_t)) == STEGO_E_LENGTH);
  if (expected == STEGO_OK) {
    EXPECT(stego_luma_ssim(a, n * 4, b, n * 4, w, h, scratch, sb - 1, out, sizeof(double)) ==
           STEGO_E_LENGTH);
    EXPECT(stego_luma_ssim(a, n * 4, b, n * 4, w, h, scratch, sb + 1, out, sizeof(double)) ==
           STEGO_E_LENGTH);
  }

  free(a);
  free(b);
  free(out);
  free(scratch);
  free(errors);
}

static void metrics_invalid(void) {
  uint8_t a[4] = {0};
  double out = 0, scratch[STEGO_SSIM_SCRATCH_ROWS] = {0};
  uint64_t errors = 0;

  EXPECT(stego_luma_mse(NULL, 4, a, 4, 1, 1, &out, sizeof out) == STEGO_E_NULL);
  EXPECT(stego_luma_mse(a, 4, NULL, 4, 1, 1, &out, sizeof out) == STEGO_E_NULL);
  EXPECT(stego_luma_mse(a, 4, a, 4, 1, 1, NULL, sizeof out) == STEGO_E_NULL);
  EXPECT(stego_luma_ssim(NULL, 4, a, 4, 1, 1, scratch, sizeof scratch, &out, sizeof out) ==
         STEGO_E_NULL);
  EXPECT(stego_luma_ssim(a, 4, a, 4, 1, 1, scratch, sizeof scratch, NULL, sizeof out) ==
         STEGO_E_NULL);
  EXPECT(stego_luma_ssim(a, 4, a, 4, 1, 1, NULL, sizeof scratch, &out, sizeof out) == STEGO_E_NULL);
  EXPECT(stego_bit_errors(NULL, 4, a, 4, &errors, sizeof errors) == STEGO_E_NULL);
  EXPECT(stego_bit_errors(a, 4, a, 4, NULL, sizeof errors) == STEGO_E_NULL);
  /* Empty bit arrays may come without a pointer. */
  EXPECT(stego_bit_errors(NULL, 0, NULL, 0, &errors, sizeof errors) == STEGO_OK);
  EXPECT(errors == 0);

  static const uint32_t bad[][2] = {{0, 1}, {1, 0}, {STEGO_MAX_SIDE + 1, 1}, {65536, 65536}};
  for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
    EXPECT(stego_luma_mse(a, 4, a, 4, bad[i][0], bad[i][1], &out, sizeof out) ==
           STEGO_E_DIMENSIONS);
    EXPECT(stego_luma_ssim(a, 4, a, 4, bad[i][0], bad[i][1], scratch, sizeof scratch, &out,
                           sizeof out) == STEGO_E_DIMENSIONS);
  }
}

static void dct_case(uint32_t w, uint32_t h, uint8_t fill) {
  uint64_t n = (uint64_t)w * h, capacity = (uint64_t)(w / 8) * (h / 8);
  uint8_t *rgba = alloc(n * 4), *out = alloc(n * 4), *bits = alloc(capacity + 1),
          *read = alloc(capacity + 1);
  double *scratch = alloc(STEGO_DCT_SCRATCH_DOUBLES * sizeof(double));
  uint64_t sb = STEGO_DCT_SCRATCH_DOUBLES * sizeof(double);
  /* fill 0 and 255 force clipping on every block; anything else is random. */
  for (uint64_t i = 0; i < n * 4; i++)
    rgba[i] = fill ? (fill == 1 ? next_byte() : fill) : 0;
  for (uint64_t i = 0; i < capacity; i++)
    bits[i] = next_byte() & 1;

  EXPECT(stego_dct_embed(rgba, n * 4, w, h, 4, 1, 3, 2, 25.0, bits, capacity, scratch, sb, out,
                         n * 4) == STEGO_OK);
  EXPECT(stego_dct_extract(out, n * 4, w, h, 4, 1, 3, 2, read, capacity, scratch, sb) == STEGO_OK);
  EXPECT(memcmp(bits, read, capacity) == 0);
  for (uint64_t i = 3; i < n * 4; i += 4)
    EXPECT(out[i] == rgba[i]);

  /* Another pair at the corner of the block, and no bits at all. */
  EXPECT(stego_dct_embed(rgba, n * 4, w, h, 0, 7, 7, 7, 8.0, bits, capacity, scratch, sb, out,
                         n * 4) == STEGO_OK);
  EXPECT(stego_dct_extract(out, n * 4, w, h, 0, 7, 7, 7, read, capacity, scratch, sb) == STEGO_OK);
  EXPECT(memcmp(bits, read, capacity) == 0);
  EXPECT(stego_dct_embed(rgba, n * 4, w, h, 1, 0, 0, 1, 25.0, NULL, 0, scratch, sb, out, n * 4) ==
         STEGO_OK);
  EXPECT(memcmp(rgba, out, n * 4) == 0);

  /* Output overlapping the input is rejected, also when it is shifted by a single byte. */
  EXPECT(stego_dct_embed(rgba, n * 4, w, h, 4, 1, 3, 2, 25.0, bits, capacity, scratch, sb, rgba,
                         n * 4) == STEGO_E_ARGUMENT);

  /* One bit past the capacity and buffers one byte off are rejected before any access. */
  EXPECT(stego_dct_embed(rgba, n * 4, w, h, 4, 1, 3, 2, 25.0, bits, capacity + 1, scratch, sb, out,
                         n * 4) == STEGO_E_LENGTH);
  EXPECT(stego_dct_extract(out, n * 4, w, h, 4, 1, 3, 2, read, capacity + 1, scratch, sb) ==
         STEGO_E_LENGTH);
  EXPECT(stego_dct_embed(rgba, n * 4, w, h, 4, 1, 3, 2, 25.0, bits, capacity, scratch, sb - 1, out,
                         n * 4) == STEGO_E_LENGTH);
  EXPECT(stego_dct_embed(rgba, n * 4, w, h, 4, 1, 3, 2, 25.0, bits, capacity, scratch, sb, out,
                         n * 4 - 1) == STEGO_E_LENGTH);

  free(rgba);
  free(out);
  free(bits);
  free(read);
  free(scratch);
}

static void dct_invalid(void) {
  uint8_t rgba[8 * 8 * 4] = {0}, out[8 * 8 * 4] = {0}, bits[1] = {0};
  double scratch[STEGO_DCT_SCRATCH_DOUBLES] = {0};
  uint64_t sb = sizeof scratch;

#define EMBED(u1, v1, u2, v2, strength)                                                            \
  stego_dct_embed(rgba, sizeof rgba, 8, 8, u1, v1, u2, v2, strength, bits, 1, scratch, sb, out,    \
                  sizeof out)
  EXPECT(EMBED(1, 1, 2, 1, 10.0) == STEGO_OK);
  EXPECT(EMBED(0, 0, 2, 1, 10.0) == STEGO_E_ARGUMENT);
  EXPECT(EMBED(1, 1, 0, 0, 10.0) == STEGO_E_ARGUMENT);
  EXPECT(EMBED(1, 1, 1, 1, 10.0) == STEGO_E_ARGUMENT);
  EXPECT(EMBED(8, 1, 2, 1, 10.0) == STEGO_E_ARGUMENT);
  EXPECT(EMBED(1, 8, 2, 1, 10.0) == STEGO_E_ARGUMENT);
  EXPECT(EMBED(1, 1, 2, 1, 0.0) == STEGO_E_ARGUMENT);
  EXPECT(EMBED(1, 1, 2, 1, -1.0) == STEGO_E_ARGUMENT);
  EXPECT(EMBED(1, 1, 2, 1, NAN) == STEGO_E_ARGUMENT);
  EXPECT(EMBED(1, 1, 2, 1, STEGO_DCT_MAX_STRENGTH + 1.0) == STEGO_E_ARGUMENT);
#undef EMBED

  EXPECT(stego_dct_embed(NULL, sizeof rgba, 8, 8, 1, 1, 2, 1, 10.0, bits, 1, scratch, sb, out,
                         sizeof out) == STEGO_E_NULL);
  EXPECT(stego_dct_embed(rgba, sizeof rgba, 8, 8, 1, 1, 2, 1, 10.0, NULL, 1, scratch, sb, out,
                         sizeof out) == STEGO_E_NULL);
  EXPECT(stego_dct_embed(rgba, sizeof rgba, 8, 8, 1, 1, 2, 1, 10.0, bits, 1, NULL, sb, out,
                         sizeof out) == STEGO_E_NULL);
  EXPECT(stego_dct_embed(rgba, sizeof rgba, 8, 8, 1, 1, 2, 1, 10.0, bits, 1, scratch, sb, NULL,
                         sizeof out) == STEGO_E_NULL);
  EXPECT(stego_dct_extract(rgba, sizeof rgba, 8, 8, 1, 1, 2, 1, NULL, 1, scratch, sb) ==
         STEGO_E_NULL);

  static const uint32_t bad[][2] = {{0, 1}, {1, 0}, {STEGO_MAX_SIDE + 1, 1}, {65536, 65536}};
  for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
    EXPECT(stego_dct_embed(rgba, sizeof rgba, bad[i][0], bad[i][1], 1, 1, 2, 1, 10.0, bits, 0,
                           scratch, sb, out, sizeof out) == STEGO_E_DIMENSIONS);
    EXPECT(stego_dct_extract(rgba, sizeof rgba, bad[i][0], bad[i][1], 1, 1, 2, 1, bits, 0, scratch,
                             sb) == STEGO_E_DIMENSIONS);
  }
}

static void dwt_case(uint32_t w, uint32_t h, uint32_t band, uint32_t level) {
  uint64_t n = (uint64_t)w * h, line = w > h ? w : h;
  uint64_t capacity = (uint64_t)(w >> level) * (h >> level);
  uint64_t pb = n * sizeof(double), lb = line * sizeof(double), fb = sizeof(uint64_t);
  uint8_t *rgba = alloc(n * 4), *out = alloc(n * 4), *bits = alloc(capacity + 1),
          *read = alloc(capacity + 1);
  double *plane = alloc(pb), *scratch = alloc(lb);
  uint64_t *failed = alloc(fb);
  for (uint64_t i = 0; i < n * 4; i++)
    rgba[i] = next_byte();
  for (uint64_t i = 0; i < capacity; i++)
    bits[i] = next_byte() & 1;

  EXPECT(stego_dwt_qim_embed(rgba, n * 4, w, h, band, level, 40.0, bits, capacity, plane, pb,
                             scratch, lb, out, n * 4, failed, fb) == STEGO_OK);
  EXPECT(stego_dwt_qim_extract(out, n * 4, w, h, band, level, 40.0, plane, pb, scratch, lb, read,
                               capacity) == STEGO_OK);
  uint64_t wrong = 0;
  for (uint64_t i = 0; i < capacity; i++)
    wrong += bits[i] != read[i];
  EXPECT(wrong == *failed);
  for (uint64_t i = 3; i < n * 4; i += 4)
    EXPECT(out[i] == rgba[i]);

  /* Nothing to embed leaves the image alone; NULL bits are fine then. */
  EXPECT(stego_dwt_qim_embed(rgba, n * 4, w, h, band, level, 40.0, NULL, 0, plane, pb, scratch, lb,
                             out, n * 4, failed, fb) == STEGO_OK);
  EXPECT(memcmp(rgba, out, n * 4) == 0 && *failed == 0);
  EXPECT(stego_dwt_qim_extract(out, n * 4, w, h, band, level, 40.0, plane, pb, scratch, lb, NULL,
                               0) == STEGO_OK);

  /* Pure white and black saturate every channel; the correction passes must stay in bounds. */
  for (uint32_t value = 0; value <= 255; value += 255) {
    memset(rgba, (int)value, n * 4);
    EXPECT(stego_dwt_qim_embed(rgba, n * 4, w, h, band, level, 8.0, bits, capacity, plane, pb,
                               scratch, lb, out, n * 4, failed, fb) == STEGO_OK);
  }

  /* One bit past the capacity and buffers one byte off are rejected before any access. */
  EXPECT(stego_dwt_qim_embed(rgba, n * 4, w, h, band, level, 40.0, bits, capacity + 1, plane, pb,
                             scratch, lb, out, n * 4, failed, fb) == STEGO_E_LENGTH);
  EXPECT(stego_dwt_qim_extract(out, n * 4, w, h, band, level, 40.0, plane, pb, scratch, lb, read,
                               capacity + 1) == STEGO_E_LENGTH);
  EXPECT(stego_dwt_qim_embed(rgba, n * 4 - 1, w, h, band, level, 40.0, bits, 0, plane, pb, scratch,
                             lb, out, n * 4, failed, fb) == STEGO_E_LENGTH);
  EXPECT(stego_dwt_qim_embed(rgba, n * 4, w, h, band, level, 40.0, bits, 0, plane, pb - 1, scratch,
                             lb, out, n * 4, failed, fb) == STEGO_E_LENGTH);
  EXPECT(stego_dwt_qim_embed(rgba, n * 4, w, h, band, level, 40.0, bits, 0, plane, pb, scratch,
                             lb + 1, out, n * 4, failed, fb) == STEGO_E_LENGTH);
  EXPECT(stego_dwt_qim_embed(rgba, n * 4, w, h, band, level, 40.0, bits, 0, plane, pb, scratch, lb,
                             out, n * 4 + 1, failed, fb) == STEGO_E_LENGTH);
  EXPECT(stego_dwt_qim_embed(rgba, n * 4, w, h, band, level, 40.0, bits, 0, plane, pb, scratch, lb,
                             out, n * 4, failed, fb - 1) == STEGO_E_LENGTH);
  EXPECT(stego_dwt_qim_extract(out, n * 4, w, h, band, level, 40.0, plane, pb, scratch, lb - 1,
                               read, 0) == STEGO_E_LENGTH);

  free(rgba);
  free(out);
  free(bits);
  free(read);
  free(plane);
  free(scratch);
  free(failed);
}

static void dwt_invalid(void) {
  uint8_t rgba[4] = {0}, out[4] = {0}, bits[1] = {0};
  double plane[1] = {0}, scratch[1] = {0};
  uint64_t failed = 0;
#define EMBED(rgba_, w, h, band, level, step, bits_, plane_, scratch_, out_, failed_)              \
  stego_dwt_qim_embed(rgba_, 4, w, h, band, level, step, bits_, 0, plane_, 8, scratch_, 8, out_,   \
                      4, failed_, 8)

  EXPECT(EMBED(NULL, 1, 1, 0, 1, 8.0, bits, plane, scratch, out, &failed) == STEGO_E_NULL);
  EXPECT(EMBED(rgba, 1, 1, 0, 1, 8.0, bits, NULL, scratch, out, &failed) == STEGO_E_NULL);
  EXPECT(EMBED(rgba, 1, 1, 0, 1, 8.0, bits, plane, NULL, out, &failed) == STEGO_E_NULL);
  EXPECT(EMBED(rgba, 1, 1, 0, 1, 8.0, bits, plane, scratch, NULL, &failed) == STEGO_E_NULL);
  EXPECT(EMBED(rgba, 1, 1, 0, 1, 8.0, bits, plane, scratch, out, NULL) == STEGO_E_NULL);
  EXPECT(stego_dwt_qim_embed(rgba, 4, 1, 1, 0, 1, 8.0, NULL, 1, plane, 8, scratch, 8, out, 4,
                             &failed, 8) == STEGO_E_NULL);
  EXPECT(stego_dwt_qim_extract(NULL, 4, 1, 1, 0, 1, 8.0, plane, 8, scratch, 8, bits, 0) ==
         STEGO_E_NULL);
  EXPECT(stego_dwt_qim_extract(rgba, 4, 1, 1, 0, 1, 8.0, NULL, 8, scratch, 8, bits, 0) ==
         STEGO_E_NULL);
  EXPECT(stego_dwt_qim_extract(rgba, 4, 1, 1, 0, 1, 8.0, plane, 8, NULL, 8, bits, 0) ==
         STEGO_E_NULL);
  EXPECT(stego_dwt_qim_extract(rgba, 4, 1, 1, 0, 1, 8.0, plane, 8, scratch, 8, NULL, 1) ==
         STEGO_E_NULL);

  /* Band, level and step out of range, including NaN and infinity. */
  static const uint32_t bad_band[] = {STEGO_DWT_LH + 1, UINT32_MAX};
  static const uint32_t bad_level[] = {0, STEGO_DWT_MAX_LEVEL + 1, UINT32_MAX};
  static const double bad_step[] = {0.0, -1.0, NAN, INFINITY, -INFINITY, 255.5, 65536.5, 1e300};
  for (size_t i = 0; i < sizeof bad_band / sizeof bad_band[0]; i++)
    EXPECT(EMBED(rgba, 1, 1, bad_band[i], 1, 8.0, bits, plane, scratch, out, &failed) ==
           STEGO_E_ARGUMENT);
  for (size_t i = 0; i < sizeof bad_level / sizeof bad_level[0]; i++)
    EXPECT(EMBED(rgba, 1, 1, 0, bad_level[i], 8.0, bits, plane, scratch, out, &failed) ==
           STEGO_E_ARGUMENT);
  for (size_t i = 0; i < sizeof bad_step / sizeof bad_step[0]; i++) {
    EXPECT(EMBED(rgba, 1, 1, 0, 1, bad_step[i], bits, plane, scratch, out, &failed) ==
           STEGO_E_ARGUMENT);
    EXPECT(stego_dwt_qim_extract(rgba, 4, 1, 1, 0, 1, bad_step[i], plane, 8, scratch, 8, bits, 0) ==
           STEGO_E_ARGUMENT);
  }

  static const uint32_t bad[][2] = {{0, 1}, {1, 0}, {STEGO_MAX_SIDE + 1, 1}, {65536, 65536}};
  for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
    EXPECT(EMBED(rgba, bad[i][0], bad[i][1], 0, 1, 8.0, bits, plane, scratch, out, &failed) ==
           STEGO_E_DIMENSIONS);
    EXPECT(stego_dwt_qim_extract(rgba, 4, bad[i][0], bad[i][1], 0, 1, 8.0, plane, 8, scratch, 8,
                                 bits, 0) == STEGO_E_DIMENSIONS);
  }
#undef EMBED
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
    png_case(shapes[i][0], shapes[i][1]);
  png_invalid();

  for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++)
    lsb_case(shapes[i][0], shapes[i][1], 1);
  /* Every bit depth on small shapes; the largest images already ran with one bit. */
  for (uint32_t k = 2; k <= STEGO_LSB_MAX_BITS; k++) {
    lsb_case(3, 5, k);
    lsb_case(37, 23, k);
  }
  lsb_invalid();

  /* Random pixels, then all black and all white, where every block is clipped. */
  for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++)
    dct_case(shapes[i][0], shapes[i][1], 1);
  dct_case(37, 23, 0);
  dct_case(37, 23, 255);
  dct_invalid();

  for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++)
    blur_case(shapes[i][0], shapes[i][1], 3);
  /* Kernels much wider than the image, up to the longest allowed. */
  blur_case(1, 1, STEGO_BLUR_MAX_TAPS);
  blur_case(3, 5, 61);
  blur_case(37, 23, STEGO_BLUR_MAX_TAPS);
  blur_invalid();

  for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++)
    metrics_case(shapes[i][0], shapes[i][1]);
  metrics_case(11, 11);
  metrics_case(11, 40);
  metrics_invalid();

  /* Every band and level on small shapes (the odd ones leave a remainder); the large images run
   * the LL band at level 1. */
  for (uint32_t band = STEGO_DWT_LL; band <= STEGO_DWT_LH; band++)
    for (uint32_t level = 1; level <= STEGO_DWT_MAX_LEVEL; level++) {
      dwt_case(1, 1, band, level);
      dwt_case(3, 5, band, level);
      dwt_case(37, 23, band, level);
      dwt_case(64, 40, band, level);
    }
  dwt_case(257, 3, STEGO_DWT_HL, 1);
  for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++) {
    dwt_case(shapes[i][0], shapes[i][1], STEGO_DWT_LL, 1);
  }
  dwt_invalid();

  if (failures) {
    fprintf(stderr, "sanitize: %d check(s) failed\n", failures);
    return 1;
  }
  printf("sanitize: all checks passed\n");
  return 0;
}
