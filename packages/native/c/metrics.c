/*
 * Quality metrics: mean squared error and SSIM on luminance, and bit error counting.
 *
 * Luminance is Y from stego_rgba_to_ycbcr (BT.601 full range, rounded to float), so the metrics see
 * the same plane the transform methods embed in. Alpha is ignored.
 *
 * SSIM follows Wang et al. 2004: an 11 x 11 Gaussian window with sigma 1.5, K1 = 0.01, K2 = 0.03,
 * L = 255, population (not sample) variances, averaged over every position where the window lies
 * fully inside the image. That is scikit-image's structural_similarity with gaussian_weights=True,
 * sigma=1.5, use_sample_covariance=False, data_range=255.
 */
#include "common.h"

#define SSIM_WINDOW STEGO_SSIM_MIN_SIDE

/* exp(-x^2 / (2 * 1.5^2)) for x = -5..5, normalised to sum to 1; written out to avoid libm. */
static const double SSIM_WEIGHTS[SSIM_WINDOW] = {
    0.00102838008447911, 0.007598758135239185, 0.03600077212843083, 0.10936068950970002,
    0.2130055377112537,  0.26601172486179436,  0.2130055377112537,  0.10936068950970002,
    0.03600077212843083, 0.007598758135239185, 0.00102838008447911,
};

static const double SSIM_C1 = (0.01 * 255.0) * (0.01 * 255.0);
static const double SSIM_C2 = (0.03 * 255.0) * (0.03 * 255.0);

/* Same expression as the Y plane in color.c, including the rounding to float. */
static inline double luma(const uint8_t *pixel) {
  double r = pixel[0], g = pixel[1], b = pixel[2];
  return (float)(0.299 * r + 0.587 * g + 0.114 * b);
}

/* Checks the arguments of the two image metrics and returns the pixel count, or a status. */
static int32_t pair_check(const uint8_t *a, uint64_t a_bytes, const uint8_t *b, uint64_t b_bytes,
                          uint32_t width, uint32_t height, const double *out, uint64_t out_bytes,
                          uint64_t *pixels) {
  if (!a || !b || !out) return STEGO_E_NULL;
  uint64_t n = stego_pixel_count(width, height);
  if (n == 0) return STEGO_E_DIMENSIONS;
  if (a_bytes != n * 4 || b_bytes != n * 4 || out_bytes != sizeof(double)) return STEGO_E_LENGTH;
  *pixels = n;
  return STEGO_OK;
}

int32_t stego_luma_mse(const uint8_t *a, uint64_t a_bytes, const uint8_t *b, uint64_t b_bytes,
                       uint32_t width, uint32_t height, double *mse, uint64_t mse_bytes) {
  uint64_t n = 0;
  int32_t status = pair_check(a, a_bytes, b, b_bytes, width, height, mse, mse_bytes, &n);
  if (status != STEGO_OK) return status;

  double sum = 0.0;
  for (uint64_t i = 0; i < n; i++) {
    double d = luma(a + i * 4) - luma(b + i * 4);
    sum += d * d;
  }
  *mse = sum / (double)n;
  return STEGO_OK;
}

/* Converts image row `row` to luminance in its slot of the 11-row ring. */
static void load_row(const uint8_t *rgba, uint32_t width, uint32_t row, double *ring) {
  const uint8_t *src = rgba + (uint64_t)row * width * 4;
  double *dst = ring + (uint64_t)(row % SSIM_WINDOW) * width;
  for (uint32_t x = 0; x < width; x++)
    dst[x] = luma(src + (uint64_t)x * 4);
}

int32_t stego_luma_ssim(const uint8_t *a, uint64_t a_bytes, const uint8_t *b, uint64_t b_bytes,
                        uint32_t width, uint32_t height, double *scratch, uint64_t scratch_bytes,
                        double *ssim, uint64_t ssim_bytes) {
  uint64_t n = 0;
  int32_t status = pair_check(a, a_bytes, b, b_bytes, width, height, ssim, ssim_bytes, &n);
  if (status != STEGO_OK) return status;
  if (!scratch) return STEGO_E_NULL;
  if (width < SSIM_WINDOW || height < SSIM_WINDOW) return STEGO_E_DIMENSIONS;
  uint64_t w = width;
  if (scratch_bytes != STEGO_SSIM_SCRATCH_ROWS * w * sizeof(double)) return STEGO_E_LENGTH;

  /* Two rings of 11 luminance rows, then five rows of vertically filtered sums. */
  double *ya = scratch, *yb = ya + SSIM_WINDOW * w;
  double *mx = yb + SSIM_WINDOW * w, *my = mx + w, *mxx = my + w, *myy = mxx + w, *mxy = myy + w;

  uint32_t out_w = width - (SSIM_WINDOW - 1), out_h = height - (SSIM_WINDOW - 1);
  for (uint32_t row = 0; row < SSIM_WINDOW - 1; row++) {
    load_row(a, width, row, ya);
    load_row(b, width, row, yb);
  }

  double total = 0.0;
  for (uint32_t oy = 0; oy < out_h; oy++) {
    load_row(a, width, oy + SSIM_WINDOW - 1, ya);
    load_row(b, width, oy + SSIM_WINDOW - 1, yb);

    for (uint64_t x = 0; x < w; x++) {
      double sx = 0.0, sy = 0.0, sxx = 0.0, syy = 0.0, sxy = 0.0;
      for (uint32_t k = 0; k < SSIM_WINDOW; k++) {
        uint64_t at = (uint64_t)((oy + k) % SSIM_WINDOW) * w + x;
        double wk = SSIM_WEIGHTS[k], va = ya[at], vb = yb[at];
        sx += wk * va;
        sy += wk * vb;
        sxx += wk * va * va;
        syy += wk * vb * vb;
        sxy += wk * va * vb;
      }
      mx[x] = sx;
      my[x] = sy;
      mxx[x] = sxx;
      myy[x] = syy;
      mxy[x] = sxy;
    }

    for (uint32_t ox = 0; ox < out_w; ox++) {
      double ux = 0.0, uy = 0.0, uxx = 0.0, uyy = 0.0, uxy = 0.0;
      for (uint32_t k = 0; k < SSIM_WINDOW; k++) {
        double wk = SSIM_WEIGHTS[k];
        ux += wk * mx[ox + k];
        uy += wk * my[ox + k];
        uxx += wk * mxx[ox + k];
        uyy += wk * myy[ox + k];
        uxy += wk * mxy[ox + k];
      }
      double vx = uxx - ux * ux, vy = uyy - uy * uy, vxy = uxy - ux * uy;
      total += ((2.0 * ux * uy + SSIM_C1) * (2.0 * vxy + SSIM_C2)) /
               ((ux * ux + uy * uy + SSIM_C1) * (vx + vy + SSIM_C2));
    }
  }

  *ssim = total / ((double)out_w * out_h);
  return STEGO_OK;
}

int32_t stego_bit_errors(const uint8_t *a, uint64_t a_bytes, const uint8_t *b, uint64_t b_bytes,
                         uint64_t *errors, uint64_t errors_bytes) {
  if ((!a && a_bytes > 0) || (!b && b_bytes > 0) || !errors) return STEGO_E_NULL;
  if (a_bytes != b_bytes || errors_bytes != sizeof(uint64_t)) return STEGO_E_LENGTH;

  uint64_t count = 0;
  for (uint64_t i = 0; i < a_bytes; i++)
    count += (a[i] ^ b[i]) & 1u;
  *errors = count;
  return STEGO_OK;
}
