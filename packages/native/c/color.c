/*
 * RGB <-> YCbCr, BT.601 full range (JPEG/JFIF). DCT and DWT embed in luminance, so every
 * transform method starts and ends here.
 *
 * Arithmetic is done in double in a fixed order and stored as float. The TypeScript oracle in
 * test/oracle/color.ts performs the same operations, which with -ffp-contract=off gives
 * bit-identical planes on every platform.
 */
#include "common.h"

int32_t stego_rgba_to_ycbcr(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width,
                            uint32_t height, float *y, uint64_t y_bytes, float *cb,
                            uint64_t cb_bytes, float *cr, uint64_t cr_bytes, uint8_t *alpha,
                            uint64_t alpha_bytes) {
  if (!rgba || !y || !cb || !cr || !alpha) return STEGO_E_NULL;
  uint64_t n = stego_pixel_count(width, height);
  if (n == 0) return STEGO_E_DIMENSIONS;
  uint64_t plane = n * sizeof(float);
  if (rgba_bytes != n * 4 || y_bytes != plane || cb_bytes != plane || cr_bytes != plane ||
      alpha_bytes != n)
    return STEGO_E_LENGTH;

  for (uint64_t i = 0; i < n; i++) {
    double r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    y[i] = (float)(0.299 * r + 0.587 * g + 0.114 * b);
    cb[i] = (float)(128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b);
    cr[i] = (float)(128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b);
    alpha[i] = rgba[i * 4 + 3];
  }
  return STEGO_OK;
}

int32_t stego_ycbcr_to_rgba(const float *y, uint64_t y_bytes, const float *cb, uint64_t cb_bytes,
                            const float *cr, uint64_t cr_bytes, const uint8_t *alpha,
                            uint64_t alpha_bytes, uint32_t width, uint32_t height, uint8_t *rgba,
                            uint64_t rgba_bytes) {
  if (!y || !cb || !cr || !alpha || !rgba) return STEGO_E_NULL;
  uint64_t n = stego_pixel_count(width, height);
  if (n == 0) return STEGO_E_DIMENSIONS;
  uint64_t plane = n * sizeof(float);
  if (y_bytes != plane || cb_bytes != plane || cr_bytes != plane || alpha_bytes != n ||
      rgba_bytes != n * 4)
    return STEGO_E_LENGTH;

  for (uint64_t i = 0; i < n; i++) {
    double l = y[i], u = (double)cb[i] - 128.0, v = (double)cr[i] - 128.0;
    rgba[i * 4] = stego_clamp_u8(l + 1.402 * v);
    rgba[i * 4 + 1] = stego_clamp_u8(l - 0.344136 * u - 0.714136 * v);
    rgba[i * 4 + 2] = stego_clamp_u8(l + 1.772 * u);
    rgba[i * 4 + 3] = alpha[i];
  }
  return STEGO_OK;
}
