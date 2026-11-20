/**
 * Attacks of the robustness lab, on RGBA pixels. JPEG and resize go through `Bun.Image`, so their
 * input is encoded as PNG first; blur runs in `@stego/native`.
 */

import type { Attack, AttackType, Scenario } from "@stego/contracts";
import { gaussianBlur } from "@stego/native";
import { resize, toJpeg } from "./pipeline.ts";
import { decodeRgba, encodePng, type RgbaImage } from "./png.ts";

export type ApplyAttack = (image: RgbaImage) => Promise<RgbaImage>;

/** Filter for both the resize attack and the scale back to the original size. */
const RESIZE_FILTER = "lanczos3";

const attacks: { [T in AttackType]: (attack: Extract<Attack, { type: T }>) => ApplyAttack } = {
  /** JPEG has no alpha channel, so the result is fully opaque (alpha 255). */
  jpeg:
    ({ quality }) =>
    async (image) =>
      decodeRgba(await toJpeg(await encodePng(image), quality)),
  resize: ({ scale }) => {
    if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
      throw new RangeError(`resize scale must be in (0, 1], got ${scale}`);
    }
    return (image) =>
      resizeTo(
        image,
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      );
  },
  blur:
    ({ sigma }) =>
    async (image) =>
      gaussianBlur(image, sigma),
};

async function resizeTo(image: RgbaImage, width: number, height: number): Promise<RgbaImage> {
  return decodeRgba(await resize(await encodePng(image), width, height, RESIZE_FILTER));
}

/**
 * Applies one attack and returns a new image; `image` is not mutated. Out-of-range parameters
 * reject with a `RangeError`.
 */
export async function applyAttack(image: RgbaImage, attack: Attack): Promise<RgbaImage> {
  const create = attacks[attack.type] as (attack: Attack) => ApplyAttack;
  return create(attack)(image);
}

/**
 * Applies the attacks in order. When they changed the size, the result is scaled back to the size
 * of `image` with the same filter, so the decoder sees the original grid (non-blind decoding, see
 * DESIGN.md). The attacks only check that their parameters are safe to run; callers at the API
 * boundary must parse the scenario with the `Scenario` schema from `@stego/contracts`.
 */
export async function applyScenario(image: RgbaImage, scenario: Scenario): Promise<RgbaImage> {
  let current = image;
  for (const attack of scenario) current = await applyAttack(current, attack);
  if (current.width === image.width && current.height === image.height) return current;
  return resizeTo(current, image.width, image.height);
}
