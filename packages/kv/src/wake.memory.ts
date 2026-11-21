import type { WakePublisher, WakeSource } from "./wake.ts";

/** In-process pair for tests: a notify reaches every listener of the same pair. */
export function createMemoryWake(): WakePublisher & WakeSource {
  const listeners = new Set<() => void>();
  return {
    async notify() {
      for (const listener of listeners) listener();
    },
    listen(onWake) {
      listeners.add(onWake);
      return async () => {
        listeners.delete(onWake);
      };
    },
  };
}
