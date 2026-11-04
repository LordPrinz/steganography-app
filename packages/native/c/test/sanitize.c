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

int main(void) {
  EXPECT(stego_abi_version() == STEGO_ABI_VERSION);

  /* The last two shapes are the largest images the limits allow. */
  static const uint32_t shapes[][2] = {{1, 1},   {1, 7},   {7, 1},        {3, 5},      {8, 8},
                                       {37, 23}, {257, 3}, {16384, 1024}, {4096, 4096}};
  for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++)
    color_case(shapes[i][0], shapes[i][1]);
  color_invalid();

  if (failures) {
    fprintf(stderr, "sanitize: %d check(s) failed\n", failures);
    return 1;
  }
  printf("sanitize: all checks passed\n");
  return 0;
}
