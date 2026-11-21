/** Every slot is taken; the caller should tell the client to retry shortly. */
export class BusyError extends Error {
  override readonly name = "BusyError";
}

export interface ConcurrencyLimit {
  /** Runs `task` when a slot is free, otherwise rejects with `BusyError` at once: nothing queues. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** At most `slots` tasks at a time in this process. */
export function createConcurrencyLimit(slots: number): ConcurrencyLimit {
  if (!Number.isInteger(slots) || slots < 1) {
    throw new RangeError(`slots must be a positive integer, got ${slots}`);
  }
  let running = 0;
  return {
    async run(task) {
      if (running >= slots) throw new BusyError("All slots are busy");
      running++;
      try {
        return await task();
      } finally {
        running--;
      }
    },
  };
}
