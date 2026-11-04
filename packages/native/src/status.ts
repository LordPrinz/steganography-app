/** Status codes returned by libstego (see c/stego.h). */
const STATUS = {
  [-1]: "null-pointer",
  [-2]: "invalid-dimensions",
  [-3]: "length-mismatch",
} as const satisfies Record<number, string>;

export type NativeStatus = (typeof STATUS)[keyof typeof STATUS] | "unknown";

/** A kernel rejected its arguments. The client validates first, so this signals a bug in the client. */
export class NativeKernelError extends Error {
  override readonly name = "NativeKernelError";
  constructor(
    readonly kernel: string,
    readonly status: NativeStatus,
    readonly code: number,
  ) {
    super(`${kernel} failed: ${status} (${code})`);
  }
}

export function check(kernel: string, code: number): void {
  if (code === 0) return;
  const status = STATUS[code as keyof typeof STATUS] ?? "unknown";
  throw new NativeKernelError(kernel, status, code);
}
