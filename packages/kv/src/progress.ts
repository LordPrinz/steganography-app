import type { KeyValueStore } from "./store.ts";

/** How long a progress report outlives its last update; a stalled job stops showing progress. */
export const PROGRESS_TTL_MS = 10 * 60_000;

export interface Progress {
  done: number;
  total: number;
}

/**
 * Live progress of a long job (an experiment), kept in Redis only: it changes every few hundred
 * milliseconds and is worthless once the job is final. Keys are built from the operation id alone.
 */
export interface ProgressStore {
  /** Worker: records how far the job is. */
  put(operationId: string, progress: Progress, ttlMs?: number): Promise<void>;
  /** API: null when nothing was reported or the report expired. The caller checks ownership first. */
  get(operationId: string): Promise<Progress | null>;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export function createProgressStore(kv: KeyValueStore): ProgressStore {
  const key = (id: string) => `op:${id}:progress`;

  return {
    put: (operationId, progress, ttlMs = PROGRESS_TTL_MS) =>
      kv.set(
        key(operationId),
        JSON.stringify({ done: progress.done, total: progress.total }),
        ttlMs,
      ),
    async get(operationId) {
      const raw = await kv.get(key(operationId));
      if (raw === null) return null;
      try {
        const { done, total } = JSON.parse(raw) as Partial<Progress>;
        return isCount(done) && isCount(total) && total > 0 ? { done, total } : null;
      } catch {
        return null;
      }
    },
  };
}
