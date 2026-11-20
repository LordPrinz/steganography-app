/*
 * PNG scanline filters (PNG spec, section 9) for 8-bit images. zlib and the chunk format stay in
 * TypeScript; these are the per-byte loops on either side of inflate/deflate.
 *
 * Unsigned byte arithmetic wraps mod 256 exactly as the spec requires.
 */
#include <stddef.h>

#include "common.h"

enum { FILTER_NONE, FILTER_SUB, FILTER_UP, FILTER_AVERAGE, FILTER_PAETH };

static inline uint8_t paeth(uint8_t a, uint8_t b, uint8_t c) {
  int p = (int)a + b - c;
  int pa = p > a ? p - a : a - p;
  int pb = p > b ? p - b : b - p;
  int pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/* The predictor for byte i of a row: a = left, b = above, c = above-left (0 outside the image). */
static inline uint8_t predict(uint32_t filter, const uint8_t *row, const uint8_t *prev, uint64_t i,
                              uint32_t bpp) {
  uint8_t a = i >= bpp ? row[i - bpp] : 0;
  uint8_t b = prev ? prev[i] : 0;
  uint8_t c = prev && i >= bpp ? prev[i - bpp] : 0;
  switch (filter) {
  case FILTER_SUB:
    return a;
  case FILTER_UP:
    return b;
  case FILTER_AVERAGE:
    return (uint8_t)(((unsigned)a + b) >> 1);
  case FILTER_PAETH:
    return paeth(a, b, c);
  default:
    return 0;
  }
}

/* Spreads `width` packed RGB pixels at the start of `row` to RGBA in place, back to front. */
static void rgb_to_rgba_in_place(uint8_t *row, uint32_t width) {
  for (uint64_t x = width; x-- > 0;) {
    row[x * 4 + 3] = 255;
    row[x * 4 + 2] = row[x * 3 + 2];
    row[x * 4 + 1] = row[x * 3 + 1];
    row[x * 4] = row[x * 3];
  }
}

int32_t stego_png_unfilter(const uint8_t *scanlines, uint64_t scanlines_bytes, uint32_t width,
                           uint32_t height, uint32_t channels, uint8_t *rgba, uint64_t rgba_bytes) {
  if (!scanlines || !rgba) return STEGO_E_NULL;
  uint64_t n = stego_pixel_count(width, height);
  if (n == 0) return STEGO_E_DIMENSIONS;
  if (channels != 3 && channels != 4) return STEGO_E_ARGUMENT;
  uint64_t stride = (uint64_t)width * channels;
  if (scanlines_bytes != (stride + 1) * height || rgba_bytes != n * 4) return STEGO_E_LENGTH;
  for (uint64_t y = 0; y < height; y++)
    if (scanlines[y * (stride + 1)] > FILTER_PAETH) return STEGO_E_ARGUMENT;

  /*
   * Each row is unfiltered packed at the start of its RGBA row. An RGB row is only spread to RGBA
   * after the next row has used it as its "above" row, so no scratch buffer is needed.
   */
  for (uint64_t y = 0; y < height; y++) {
    const uint8_t *in = scanlines + y * (stride + 1);
    uint8_t *row = rgba + y * (uint64_t)width * 4;
    uint8_t *prev = y > 0 ? row - (uint64_t)width * 4 : NULL;
    uint32_t filter = in[0];
    for (uint64_t i = 0; i < stride; i++)
      row[i] = (uint8_t)(in[i + 1] + predict(filter, row, prev, i, channels));
    if (channels == 3 && prev) rgb_to_rgba_in_place(prev, width);
  }
  if (channels == 3) rgb_to_rgba_in_place(rgba + (n - width) * 4, width);
  return STEGO_OK;
}

/* Sum of |filtered byte| read as signed, the libpng heuristic for choosing a filter per row. */
static uint64_t row_cost(uint32_t filter, const uint8_t *row, const uint8_t *prev,
                         uint64_t stride) {
  uint64_t cost = 0;
  for (uint64_t i = 0; i < stride; i++) {
    int8_t v = (int8_t)(uint8_t)(row[i] - predict(filter, row, prev, i, 4));
    cost += (uint64_t)(v < 0 ? -v : v);
  }
  return cost;
}

int32_t stego_png_filter(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                         uint32_t filter, uint8_t *scanlines, uint64_t scanlines_bytes) {
  if (!rgba || !scanlines) return STEGO_E_NULL;
  uint64_t n = stego_pixel_count(width, height);
  if (n == 0) return STEGO_E_DIMENSIONS;
  if (filter > STEGO_PNG_FILTER_ADAPTIVE) return STEGO_E_ARGUMENT;
  uint64_t stride = (uint64_t)width * 4;
  if (rgba_bytes != n * 4 || scanlines_bytes != (stride + 1) * height) return STEGO_E_LENGTH;

  for (uint64_t y = 0; y < height; y++) {
    const uint8_t *row = rgba + y * stride;
    const uint8_t *prev = y > 0 ? row - stride : NULL;
    uint32_t chosen = filter;
    if (filter == STEGO_PNG_FILTER_ADAPTIVE) {
      uint64_t best = UINT64_MAX;
      for (uint32_t f = FILTER_NONE; f <= FILTER_PAETH; f++) {
        uint64_t cost = row_cost(f, row, prev, stride);
        if (cost < best) {
          best = cost;
          chosen = f;
        }
      }
    }
    uint8_t *out = scanlines + y * (stride + 1);
    out[0] = (uint8_t)chosen;
    for (uint64_t i = 0; i < stride; i++)
      out[i + 1] = (uint8_t)(row[i] - predict(chosen, row, prev, i, 4));
  }
  return STEGO_OK;
}
