import type { KeysetCursor } from "@stego/db";
import { z } from "zod";

const CursorPayload = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

/** The opaque string a client passes back to continue a listing. */
export function encodeCursor({ createdAt, id }: KeysetCursor): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
}

/** The cursor behind an opaque string from `nextCursor`, or null when it is not one. */
export function decodeCursor(cursor: string): KeysetCursor | null {
  try {
    const parsed = CursorPayload.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
