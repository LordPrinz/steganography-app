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
  /* A buffer length does not match the image dimensions, or exceeds what they can hold. */
  STEGO_E_LENGTH = -3,
  /* A scalar argument is out of range (e.g. an unknown mode or parameter value). */
  STEGO_E_ARGUMENT = -4,
  /* A DCT block could not be made to hold its bit, even with the largest margin tried. */
  STEGO_E_EMBED = -5,
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

/* Filter type that picks the cheapest of the five filters for each row. */
#define STEGO_PNG_FILTER_ADAPTIVE 5u

/*
 * Reverses PNG filtering of 8-bit RGB (channels 3) or RGBA (channels 4) scanlines: height rows of
 * one filter-type byte followed by width * channels bytes. Writes RGBA; RGB gets alpha 255.
 * Returns STEGO_E_ARGUMENT for another channel count or a filter type above 4.
 */
int32_t stego_png_unfilter(const uint8_t *scanlines, uint64_t scanlines_bytes, uint32_t width,
                           uint32_t height, uint32_t channels, uint8_t *rgba, uint64_t rgba_bytes);

/*
 * Filters RGBA pixels into PNG scanlines (height * (1 + width * 4) bytes). filter 0..4 applies that
 * filter to every row; STEGO_PNG_FILTER_ADAPTIVE chooses per row by the minimum sum of absolute
 * differences.
 */
int32_t stego_png_filter(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                         uint32_t filter, uint8_t *scanlines, uint64_t scanlines_bytes);

/* Highest bits_per_channel accepted by the LSB kernels. */
#define STEGO_LSB_MAX_BITS 8u

/*
 * Copies rgba to out and writes bits (one per byte, only the lowest bit is used) into the low
 * bits_per_channel bits of the R, G and B channels. bit_count may be at most
 * width * height * 3 * bits_per_channel; channels past the last bit keep their value.
 */
int32_t stego_lsb_embed(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                        uint32_t bits_per_channel, const uint8_t *bits, uint64_t bit_count,
                        uint8_t *out, uint64_t out_bytes);

/* Reads the first bit_count bits written by stego_lsb_embed, one per byte (0 or 1). */
int32_t stego_lsb_extract(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                          uint32_t bits_per_channel, uint8_t *bits, uint64_t bit_count);

/* Longest kernel accepted by stego_blur_separable. */
#define STEGO_BLUR_MAX_TAPS 255u

/*
 * Convolves the R, G and B channels with kernel (an odd number of taps, at most
 * STEGO_BLUR_MAX_TAPS) along both axes, repeating edge pixels, then rounds and clamps to 0..255.
 * Alpha is copied. scratch holds width * 3 doubles; out must not overlap rgba.
 */
int32_t stego_blur_separable(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width,
                             uint32_t height, const double *kernel, uint64_t kernel_bytes,
                             double *scratch, uint64_t scratch_bytes, uint8_t *out,
                             uint64_t out_bytes);

/*
 * Mean squared error between the luminance (Y as in stego_rgba_to_ycbcr) of two RGBA images of the
 * same size, written to *mse. Alpha is ignored.
 */
int32_t stego_luma_mse(const uint8_t *a, uint64_t a_bytes, const uint8_t *b, uint64_t b_bytes,
                       uint32_t width, uint32_t height, double *mse, uint64_t mse_bytes);

/* Smallest side SSIM accepts: one 11 x 11 window. */
#define STEGO_SSIM_MIN_SIDE 11u
/* Rows of width doubles in the SSIM scratch buffer. */
#define STEGO_SSIM_SCRATCH_ROWS (2u * STEGO_SSIM_MIN_SIDE + 5u)

/*
 * Mean SSIM (Wang et al. 2004, 11 x 11 Gaussian window, sigma 1.5, K1 0.01, K2 0.03, L 255)
 * between the luminance of two RGBA images of the same size, written to *ssim. scratch holds
 * width * STEGO_SSIM_SCRATCH_ROWS doubles.
 */
int32_t stego_luma_ssim(const uint8_t *a, uint64_t a_bytes, const uint8_t *b, uint64_t b_bytes,
                        uint32_t width, uint32_t height, double *scratch, uint64_t scratch_bytes,
                        double *ssim, uint64_t ssim_bytes);

/* Counts positions where the lowest bits of a and b differ (one bit per byte, equal lengths). */
int32_t stego_bit_errors(const uint8_t *a, uint64_t a_bytes, const uint8_t *b, uint64_t b_bytes,
                         uint64_t *errors, uint64_t errors_bytes);

/* Largest strength accepted by stego_dct_embed. */
#define STEGO_DCT_MAX_STRENGTH 1024.0
/* How many times stego_dct_embed doubles a block's margin after a failed check. */
#define STEGO_DCT_ATTEMPTS 6u
/* Doubles in the DCT scratch buffer: the basis functions of the two coefficients, 64 each. */
#define STEGO_DCT_SCRATCH_DOUBLES 128u

/*
 * Koch-Zhao: embeds bits[i] (lowest bit) in 8 x 8 luminance block i, row-major, by making the
 * magnitudes of the DCT coefficients (u1, v1) and (u2, v2) differ by at least strength, the larger
 * being the first for a 1. Frequencies are 0..7 (u horizontal, v vertical), the two positions
 * differ and neither is DC. bit_count may be at most (width / 8) * (height / 8); pixels outside
 * whole blocks and the alpha channel are copied. Returns STEGO_E_EMBED when a block cannot hold its
 * bit. scratch holds STEGO_DCT_SCRATCH_DOUBLES doubles. out must not overlap rgba
 * (STEGO_E_ARGUMENT).
 */
int32_t stego_dct_embed(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                        uint32_t u1, uint32_t v1, uint32_t u2, uint32_t v2, double strength,
                        const uint8_t *bits, uint64_t bit_count, double *scratch,
                        uint64_t scratch_bytes, uint8_t *out, uint64_t out_bytes);

/* Reads the first bit_count bits written by stego_dct_embed, one per byte (0 or 1). */
int32_t stego_dct_extract(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                          uint32_t u1, uint32_t v1, uint32_t u2, uint32_t v2, uint8_t *bits,
                          uint64_t bit_count, double *scratch, uint64_t scratch_bytes);

#endif
