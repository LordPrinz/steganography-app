/** Channel the API publishes on after a job was enqueued. The message is empty on purpose. */
export const WAKE_CHANNEL = "jobs:enqueued";

/**
 * API side. A hint that a job may be waiting; the queue in Postgres stays the source of truth, so a lost
 * hint only delays the job until the worker's next poll.
 */
export interface WakePublisher {
  /** Call after the transaction that inserted the job committed. Best effort: never throws. */
  notify(): Promise<void>;
}

/** Worker side. */
export interface WakeSource {
  /**
   * Calls `onWake` for every hint, possibly several times in a row, so callers coalesce. Resubscribes
   * after a reconnect. Returns a function that stops listening.
   */
  listen(onWake: () => void): () => Promise<void>;
}
