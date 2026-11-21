import type { RedisClient } from "bun";
import { WAKE_CHANNEL, type WakePublisher, type WakeSource } from "./wake.ts";

export interface RedisWakeOptions {
  channel?: string;
  log?: Pick<Console, "error">;
  /** How long `notify` waits for Redis before giving up. */
  timeoutMs?: number;
}

/**
 * Publishes on a shared client. `notify` never throws and gives up after `timeoutMs`, so a dead or
 * half-open connection cannot hold up the enqueue response: callers may simply await it.
 */
export function createRedisWakePublisher(
  client: RedisClient,
  { channel = WAKE_CHANNEL, log = console, timeoutMs = 500 }: RedisWakeOptions = {},
): WakePublisher {
  return {
    async notify() {
      let timer: Timer | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(reject, timeoutMs, new Error(`no answer from Redis in ${timeoutMs} ms`));
      });
      try {
        await Promise.race([client.publish(channel, "1"), timeout]);
      } catch (error) {
        log.error(
          "Could not publish the job wake-up; the worker will find the job by polling:",
          error,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Subscribes on a client of its own: a subscribed connection can run almost no other command. Pair it
 * with `keepConnected`; a subscription does not survive a reconnect, so it is renewed on every connect.
 */
export function createRedisWakeSource(
  client: RedisClient,
  { channel = WAKE_CHANNEL, log = console }: RedisWakeOptions = {},
): WakeSource {
  return {
    listen(onWake) {
      const listener = () => onWake();
      // Bun keeps the old listener across a reconnect, so drop it first or each reconnect adds a copy.
      let subscribed = false;
      const subscribe = async () => {
        try {
          if (subscribed) await client.unsubscribe(channel, listener).catch(() => {});
          subscribed = false;
          await client.subscribe(channel, listener);
          subscribed = true;
        } catch (error) {
          log.error("Could not subscribe to the job wake-up channel:", error);
        }
      };
      client.onconnect = () => void subscribe();
      if (client.connected) void subscribe();
      return async () => {
        client.onconnect = null;
        if (subscribed) await client.unsubscribe(channel, listener).catch(() => {});
        subscribed = false;
      };
    },
  };
}
