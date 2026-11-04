/* Helpers shared by the kernels. Internal to libstego, not part of the FFI interface. */
#ifndef STEGO_COMMON_H
#define STEGO_COMMON_H

#include <stdint.h>

#include "stego.h"

/* Validates dimensions and returns the pixel count, or 0 when they are out of range. */
static inline uint64_t stego_pixel_count(uint32_t width, uint32_t height) {
  if (width == 0 || height == 0 || width > STEGO_MAX_SIDE || height > STEGO_MAX_SIDE) return 0;
  uint64_t pixels = (uint64_t)width * height;
  return pixels > STEGO_MAX_PIXELS ? 0 : pixels;
}

/* Rounds half up and clamps to 0..255. Written without libm so TinyCC can build it too. */
static inline uint8_t stego_clamp_u8(double v) {
  if (!(v > 0.0)) return 0; /* also maps NaN to 0 */
  if (v >= 255.0) return 255;
  return (uint8_t)(v + 0.5);
}

#endif
