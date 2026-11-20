/*
 * LSB embedding in the R, G and B channels; alpha is copied unchanged.
 *
 * Bit i goes to colour channel i / k (R, G, B of pixel 0, then pixel 1, ...), where k is
 * bits_per_channel. Within a channel the k bits fill the low bits MSB first, so with k = 2 the
 * pair (b0, b1) becomes bit 1 and bit 0 of the channel value. A bit is read from its own position
 * only, which makes extracting n bits a prefix of extracting more.
 */
#include <string.h>

#include "common.h"

/* Checks the arguments both kernels share; bit_count may not exceed the capacity. */
static int32_t lsb_check(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                         uint32_t bits_per_channel, const uint8_t *bits, uint64_t bit_count) {
  if (!rgba || (!bits && bit_count > 0)) return STEGO_E_NULL;
  uint64_t n = stego_pixel_count(width, height);
  if (n == 0) return STEGO_E_DIMENSIONS;
  if (bits_per_channel < 1 || bits_per_channel > STEGO_LSB_MAX_BITS) return STEGO_E_ARGUMENT;
  if (rgba_bytes != n * 4 || bit_count > n * 3 * bits_per_channel) return STEGO_E_LENGTH;
  return STEGO_OK;
}

static inline uint64_t channel_offset(uint64_t channel) { return channel / 3 * 4 + channel % 3; }

int32_t stego_lsb_embed(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                        uint32_t bits_per_channel, const uint8_t *bits, uint64_t bit_count,
                        uint8_t *out, uint64_t out_bytes) {
  int32_t status = lsb_check(rgba, rgba_bytes, width, height, bits_per_channel, bits, bit_count);
  if (status != STEGO_OK) return status;
  if (!out) return STEGO_E_NULL;
  if (out_bytes != rgba_bytes) return STEGO_E_LENGTH;

  memmove(out, rgba, rgba_bytes);
  for (uint64_t i = 0; i < bit_count; i++) {
    uint64_t at = channel_offset(i / bits_per_channel);
    unsigned shift = bits_per_channel - 1 - (unsigned)(i % bits_per_channel);
    out[at] = (uint8_t)((out[at] & ~(1u << shift)) | ((bits[i] & 1u) << shift));
  }
  return STEGO_OK;
}

int32_t stego_lsb_extract(const uint8_t *rgba, uint64_t rgba_bytes, uint32_t width, uint32_t height,
                          uint32_t bits_per_channel, uint8_t *bits, uint64_t bit_count) {
  int32_t status = lsb_check(rgba, rgba_bytes, width, height, bits_per_channel, bits, bit_count);
  if (status != STEGO_OK) return status;

  for (uint64_t i = 0; i < bit_count; i++) {
    uint64_t at = channel_offset(i / bits_per_channel);
    unsigned shift = bits_per_channel - 1 - (unsigned)(i % bits_per_channel);
    bits[i] = (rgba[at] >> shift) & 1u;
  }
  return STEGO_OK;
}
