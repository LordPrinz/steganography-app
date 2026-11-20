# Produces the scikit-image SSIM and PSNR reference values hard-coded in test/metrics.test.ts.
#
# The images are rebuilt with the same xorshift32 generator as test/random.ts, and luminance is
# rounded to float32 like the Y plane of stego_rgba_to_ycbcr. Run from the repository root:
#
#   uvx --with scikit-image==0.26.0 --with numpy==2.5.5 python -I packages/native/test/oracle/ssim_reference.py
#
# Not part of the test suite; rerun it only when the reference images change.
import numpy as np
import skimage
from skimage.metrics import peak_signal_noise_ratio, structural_similarity


def random_bytes(n, seed=0x9E3779B9):
    out = np.empty(n, dtype=np.int64)
    x = (seed & 0xFFFFFFFF) or 1
    for i in range(n):
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        out[i] = x & 0xFF
    return out


def noisy(base, seed, amp):
    noise = random_bytes(base.size, seed)
    return np.clip(base + noise % (2 * amp + 1) - amp, 0, 255)


def gradient(w, h):
    y, x, c = np.meshgrid(np.arange(h), np.arange(w), np.arange(4), indexing="ij")
    return ((x * 7 + y * 3 + c * 40) % 256).reshape(-1)


def luma(rgba, w, h):
    p = rgba.reshape(h, w, 4).astype(np.float64)
    y = 0.299 * p[..., 0] + 0.587 * p[..., 1] + 0.114 * p[..., 2]
    return y.astype(np.float32).astype(np.float64)


def report(name, a, b, w, h):
    ya, yb = luma(a, w, h), luma(b, w, h)
    ssim = structural_similarity(
        ya, yb, data_range=255, gaussian_weights=True, sigma=1.5, use_sample_covariance=False
    )
    psnr = peak_signal_noise_ratio(ya, yb, data_range=255)
    print(f"{name}: ssim={float(ssim)!r} psnr={float(psnr)!r}")


print("skimage", skimage.__version__, "numpy", np.__version__)
w, h = 32, 24
rnd = random_bytes(w * h * 4, 1)
report("random vs noisy (±10)", rnd, noisy(rnd, 2, 10), w, h)
g = gradient(w, h)
report("gradient vs noisy (±3)", g, noisy(g, 3, 3), w, h)
report("gradient vs random", g, rnd, w, h)
w, h = 11, 11
g = gradient(w, h)
report("11 x 11 gradient vs noisy (±20)", g, noisy(g, 4, 20), w, h)
