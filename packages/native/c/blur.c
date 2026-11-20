/*
 * Separable blur of the R, G and B channels; alpha is copied unchanged.
 *
 * The caller passes a normalised, symmetric 1-D kernel (a Gaussian, built in TypeScript) with an
 * odd number of taps. Each output row is computed in two passes: a vertical pass reads the input
 * rows around it into the scratch row (doubles), then a horizontal pass over the scratch row writes
 * the output. Pixels past the border repeat the edge pixel. No rounding happens between the passes.
 */
#include "common.h"

static inline uint32_t clamp_index(int64_t i, uint32_t size) {
  if (i < 0) return 0;
  if (i >= (int64_t)size) return size - 1;
  return (uint32_t)i;
}

int32_t stego_blur_separable(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width,
                             uint32_t height, const double *kernel, uint64_t kernel_bytes,
                             double *scratch, uint64_t scratch_bytes, uint8_t *out,
                             uint64_t out_bytes) {
  if (!rgba || !kernel || !scratch || !out) return STEGO_E_NULL;
  uint64_t n = stego_pixel_count(width, height);
  if (n == 0) return STEGO_E_DIMENSIONS;
  if (rgba_bytes != n * 4 || out_bytes != rgba_bytes) return STEGO_E_LENGTH;
  if (scratch_bytes != (uint64_t)width * 3 * sizeof(double)) return STEGO_E_LENGTH;
  if (kernel_bytes % sizeof(double) != 0) return STEGO_E_LENGTH;
  uint64_t taps = kernel_bytes / sizeof(double);
  if (taps % 2 == 0 || taps > STEGO_BLUR_MAX_TAPS) return STEGO_E_ARGUMENT;
  int64_t radius = (int64_t)(taps / 2);

  for (uint32_t y = 0; y < height; y++) {
    for (uint64_t i = 0; i < (uint64_t)width * 3; i++)
      scratch[i] = 0.0;
    for (int64_t k = -radius; k <= radius; k++) {
      double w = kernel[k + radius];
      const uint8_t *row = rgba + (uint64_t)clamp_index((int64_t)y + k, height) * width * 4;
      for (uint32_t x = 0; x < width; x++)
        for (unsigned c = 0; c < 3; c++)
          scratch[(uint64_t)x * 3 + c] += w * row[(uint64_t)x * 4 + c];
    }

    const uint8_t *in_row = rgba + (uint64_t)y * width * 4;
    uint8_t *out_row = out + (uint64_t)y * width * 4;
    for (uint32_t x = 0; x < width; x++) {
      for (unsigned c = 0; c < 3; c++) {
        double sum = 0.0;
        for (int64_t k = -radius; k <= radius; k++)
          sum += kernel[k + radius] * scratch[(uint64_t)clamp_index((int64_t)x + k, width) * 3 + c];
        out_row[(uint64_t)x * 4 + c] = stego_clamp_u8(sum);
      }
      out_row[(uint64_t)x * 4 + 3] = in_row[(uint64_t)x * 4 + 3];
    }
  }
  return STEGO_OK;
}
