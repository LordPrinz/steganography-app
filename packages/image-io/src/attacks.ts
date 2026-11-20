/**
 * Attacks of the robustness lab, on RGBA pixels. JPEG and resize go through `Bun.Image`, so their
 * input is encoded as PNG first; blur runs in `@stego/native`.
 */

import type { Attack, AttackType, Scenario } from "@stego/contracts";
import { gaussianBlur } from "@stego/native";
import { resize, toJpeg } from "./pipeline.ts";
import { decodeRgba, encodePng, type RgbaImage } from "./png.ts";

export type ApplyAttack = (image: RgbaImage) => Promise<RgbaImage>;

const attacks: { [T in AttackType]: (attack: Extract<Attack, { type: T }>) => ApplyAttack } = {
  jpeg:
    ({ quality }) =>
    async (image) =>
      decodeRgba(await toJpeg(await encodePng(image), quality)),
  resize:
    ({ scale }) =>
    (image) =>
      resizeTo(
        image,
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      ),
  blur:
    ({ sigma }) =>
    async (image) =>
      gaussianBlur(image, sigma),
};

async function resizeTo(image: RgbaImage, width: number, height: number): Promise<RgbaImage> {
  return decodeRgba(await resize(await encodePng(image), width, height));
}

export function applyAttack(image: RgbaImage, attack: Attack): Promise<RgbaImage> {
  const create = attacks[attack.type] as (attack: Attack) => ApplyAttack;
  return create(attack)(image);
}

/**
 * Applies the attacks in order. When they changed the size, the result is scaled back to the size
 * of `image`, so the decoder sees the original grid (non-blind decoding, see DESIGN.md).
 */
export async function applyScenario(image: RgbaImage, scenario: Scenario): Promise<RgbaImage> {
  let current = image;
  for (const attack of scenario) current = await applyAttack(current, attack);
  if (current.width === image.width && current.height === image.height) return current;
  return resizeTo(current, image.width, image.height);
}
