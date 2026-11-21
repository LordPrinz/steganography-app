import { CapacityExceededError, capacity, hide, reveal } from "./codec.ts";
import { type ConfiguredMethod, MethodId, type RgbaImage } from "./types.ts";

/** One message and the configured method that hides it. */
export interface Layer {
  readonly method: ConfiguredMethod;
  readonly message: string;
}

/**
 * Thrown when a layer does not reveal exactly after all layers are embedded, so the layers cannot
 * share this image. `layer` is the index in the caller's list; the message text stays out of the error.
 */
export class LayerConflictError extends Error {
  readonly layer: number;

  constructor(layer: number) {
    super(`Layer ${layer} does not survive the other layers`);
    this.name = "LayerConflictError";
    this.layer = layer;
  }
}

/**
 * Embedding order, first to last (ADR 9). A later layer overwrites or disturbs an earlier one, and
 * the measurements say what each can take: LSB is wiped by any later method, DWT is damaged by a
 * later DCT embed and DCT is not damaged by a later DWT embed, so LSB goes last and DCT first.
 */
const EMBED_ORDER: Record<MethodId, number> = {
  [MethodId.DctKochZhao]: 0,
  [MethodId.DwtQim]: 1,
  [MethodId.Lsb]: 2,
};

/** Message bytes each of `methods` can hold on its own, in the given order (see `capacity`). */
export function capacityLayered(
  width: number,
  height: number,
  methods: readonly ConfiguredMethod[],
): number[] {
  return methods.map((method) => capacity(width, height, method));
}

/**
 * Hides every layer in one image. Layers are embedded in a fixed order, whatever order they are
 * given in, and each one embeds its own frame, so `reveal(result, layer.method)` reads it back.
 * Capacities are independent: each layer holds what `capacity` reports for its method.
 *
 * Throws `RangeError` for two layers with the same method id (a reveal could not tell them apart),
 * `CapacityExceededError` with `layer` set when a message does not fit its method, and
 * `LayerConflictError` when a layer would not reveal exactly from the result.
 */
export function hideLayered(image: RgbaImage, layers: readonly Layer[]): RgbaImage {
  const ids = new Set(layers.map((layer) => layer.method.id));
  if (ids.size !== layers.length) {
    throw new RangeError("Layers must use different methods");
  }

  const ordered = layers
    .map((layer, index) => ({ ...layer, index }))
    .sort((a, b) => EMBED_ORDER[a.method.id] - EMBED_ORDER[b.method.id]);

  let stego = image;
  for (const { method, message, index } of ordered) {
    try {
      stego = hide(stego, message, method);
    } catch (error) {
      if (!(error instanceof CapacityExceededError)) throw error;
      throw new CapacityExceededError(error.needed, error.available, index);
    }
  }

  for (const { method, message, index } of ordered) {
    const result = reveal(stego, method);
    if (!result.ok || result.message !== message) throw new LayerConflictError(index);
  }
  return stego;
}
