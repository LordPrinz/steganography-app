import { afterAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { createMemoryWake } from "./wake.memory.ts";
import { createRedisWakePublisher, createRedisWakeSource } from "./wake.redis.ts";
import type { WakePublisher, WakeSource } from "./wake.ts";

// Shared contract for every wake adapter. The Redis one runs when TEST_REDIS_URL is set (CI provides it).
const redisUrl = Bun.env.TEST_REDIS_URL;
const clients: RedisClient[] = [];
function client(): RedisClient {
  const created = new RedisClient(redisUrl as string, { enableOfflineQueue: false });
  clients.push(created);
  return created;
}
afterAll(() => {
  for (const c of clients) c.close();
});

interface Pair {
  publisher: WakePublisher;
  source: WakeSource;
}

const adapters: [string, () => Promise<Pair>][] = [
  [
    "memory",
    async () => {
      const wake = createMemoryWake();
      return { publisher: wake, source: wake };
    },
  ],
];
if (redisUrl) {
  adapters.push([
    "redis",
    async () => {
      const channel = `test:${crypto.randomUUID()}`;
      const subscriber = client();
      await subscriber.connect();
      const publisher = client();
      await publisher.connect();
      return {
        publisher: createRedisWakePublisher(publisher, { channel }),
        source: createRedisWakeSource(subscriber, { channel }),
      };
    },
  ]);
}

async function until(done: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await Bun.sleep(5);
}

describe.each(adapters)("wake channel (%s)", (_name, make) => {
  test("a notify reaches the listener", async () => {
    const { publisher, source } = await make();
    let wakes = 0;
    const stop = source.listen(() => wakes++);
    await Bun.sleep(50);
    await publisher.notify();
    await until(() => wakes > 0);
    expect(wakes).toBeGreaterThan(0);
    await stop();
  });

  test("a stopped listener hears nothing", async () => {
    const { publisher, source } = await make();
    let wakes = 0;
    const stop = source.listen(() => wakes++);
    await Bun.sleep(50);
    await stop();
    await publisher.notify();
    await Bun.sleep(100);
    expect(wakes).toBe(0);
  });
});

describe.skipIf(!redisUrl)("wake channel on Redis only", () => {
  test("notify logs and resolves while Redis is down", async () => {
    const down = new RedisClient("redis://127.0.0.1:1", { enableOfflineQueue: false });
    const logged: unknown[][] = [];
    const publisher = createRedisWakePublisher(down, {
      log: { error: (...args: unknown[]) => void logged.push(args) },
    });
    await publisher.notify();
    expect(logged).toHaveLength(1);
    down.close();
  });

  test("the subscription is renewed after a reconnect", async () => {
    const channel = `test:${crypto.randomUUID()}`;
    const subscriber = client();
    await subscriber.connect();
    const publisher = client();
    await publisher.connect();
    let wakes = 0;
    createRedisWakeSource(subscriber, { channel }).listen(() => wakes++);
    await Bun.sleep(50);

    // Kills every pubsub client on this Redis, so run this only against a disposable instance.
    await publisher.send("CLIENT", ["KILL", "TYPE", "pubsub"]);
    await until(() => subscriber.connected);

    // The resubscribe races the first publishes, so publish until one gets through.
    const notifier = createRedisWakePublisher(publisher, { channel });
    for (let i = 0; i < 40 && wakes === 0; i++) {
      await notifier.notify();
      await Bun.sleep(50);
    }
    expect(wakes).toBeGreaterThan(0);

    // Settled: one publish must give exactly one call, so the reconnect left no second listener.
    await Bun.sleep(100);
    const before = wakes;
    await notifier.notify();
    await Bun.sleep(150);
    expect(wakes - before).toBe(1);
  });

  test("notify gives up on a stalled connection instead of hanging", async () => {
    const stalled = { publish: () => new Promise<number>(() => {}) } as unknown as RedisClient;
    const logged: unknown[][] = [];
    const publisher = createRedisWakePublisher(stalled, {
      timeoutMs: 50,
      log: { error: (...args: unknown[]) => void logged.push(args) },
    });
    const start = performance.now();
    await publisher.notify();
    expect(performance.now() - start).toBeLessThan(500);
    expect(logged).toHaveLength(1);
  });
});
