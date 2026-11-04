/*
 * Public C interface of libstego, loaded from TypeScript through bun:ffi.
 *
 * Conventions for every exported function:
 * - The caller (JavaScript) allocates all buffers. Nothing allocated here outlives a call.
 * - Each buffer comes with its length in bytes, so sizes are checked here again even though
 *   the TypeScript client has already validated them.
 * - The return value is a status code: STEGO_OK or one of the negative errors below.
 */
#ifndef STEGO_H
#define STEGO_H

#include <stdint.h>

/* Bumped whenever an exported signature or behaviour changes; the client refuses a mismatch. */
#define STEGO_ABI_VERSION 1

enum {
  STEGO_OK = 0,
  /* A required pointer is NULL. */
  STEGO_E_NULL = -1,
  /* Width or height is zero or above STEGO_MAX_SIDE, or there are more than STEGO_MAX_PIXELS. */
  STEGO_E_DIMENSIONS = -2,
  /* A buffer length does not match the image dimensions. */
  STEGO_E_LENGTH = -3,
};

/* Longest accepted side; leaves room for non-square images within the pixel limit. */
#define STEGO_MAX_SIDE 16384u
/* Same as MAX_PIXELS in image-io (4096 x 4096). */
#define STEGO_MAX_PIXELS (4096u * 4096u)

int32_t stego_abi_version(void);

/*
 * RGBA (8 bits per channel) to Y, Cb, Cr planes (float, 0..255) plus the alpha plane.
 * BT.601 full range, the JPEG/JFIF definition.
 */
int32_t stego_rgba_to_ycbcr(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width,
                            uint32_t height, float *y, uint64_t y_bytes, float *cb,
                            uint64_t cb_bytes, float *cr, uint64_t cr_bytes, uint8_t *alpha,
                            uint64_t alpha_bytes);

/* Inverse of stego_rgba_to_ycbcr: rounds half up and clamps every channel to 0..255. */
int32_t stego_ycbcr_to_rgba(const float *y, uint64_t y_bytes, const float *cb, uint64_t cb_bytes,
                            const float *cr, uint64_t cr_bytes, const uint8_t *alpha,
                            uint64_t alpha_bytes, uint32_t width, uint32_t height, uint8_t *rgba,
                            uint64_t rgba_bytes);

#endif
