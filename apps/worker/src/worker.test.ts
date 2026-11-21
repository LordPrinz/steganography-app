import { describe, expect, mock, test } from "bun:test";
import { type ClaimedJob, JobError, type JobQueue, type OperationType } from "@stego/db";
import { createMemoryStore, createMessageHandoff } from "@stego/kv";
import type { JobHandler } from "./handlers.ts";
import { createWorker } from "./worker.ts";

const silent = { error: () => {} };
const handoff = createMessageHandoff(createMemoryStore());

function fakeJob(id: string, type: OperationType = "encode"): ClaimedJob {
  return {
    id,
    operation_id: `op-${id}`,
    status: "running",
    attempts: 1,
    error: null,
    run_after: new Date(),
    locked_at: new Date(),
    finished_at: null,
    created_at: new Date(),
    operation: {
      id: `op-${id}`,
      user_id: "u",
      type,
      method: "lsb",
      source_image_id: null,
      params: {},
    },
  };
}

function fakeQueue(jobs: ClaimedJob[]) {
  const pending = [...jobs];
  return {
    maxAttempts: 3,
    claim: mock<JobQueue["claim"]>(async () => pending.shift() ?? null),
    extend: mock<JobQueue["extend"]>(async () => true),
    complete: mock<JobQueue["complete"]>(async () => true),
    fail: mock<JobQueue["fail"]>(async () => true),
  };
}

describe("worker", () => {
  test("dispatches each job to the handler for its type and completes it with the result", async () => {
    const queue = fakeQueue([fakeJob("a"), fakeJob("b", "decode")]);
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      pollIntervalMs: 5,
      handlers: {
        encode: async (job) => ({ encoded: job.id }),
        decode: async () => {
          worker.stop();
          return undefined;
        },
      },
    });

    await worker.run();
    expect(queue.complete.mock.calls).toEqual([
      [expect.objectContaining({ id: "a" }), { encoded: "a" }],
      [expect.objectContaining({ id: "b" }), null],
    ]);
    expect(queue.fail).not.toHaveBeenCalled();
  });

  test("a throwing handler fails the attempt so the queue can retry it", async () => {
    const queue = fakeQueue([fakeJob("a")]);
    const boom = new Error("boom");
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      handlers: {
        encode: async () => {
          worker.stop();
          throw boom;
        },
      },
    });

    await worker.run();
    expect(queue.fail).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), boom, {
      retry: true,
    });
    expect(queue.complete).not.toHaveBeenCalled();
  });

  test("a database error while completing does not count as a failed attempt", async () => {
    const queue = fakeQueue([fakeJob("a")]);
    queue.complete.mockImplementation(async () => {
      worker.stop();
      throw new Error("connection reset");
    });
    const error = mock(() => {});
    const worker = createWorker({
      handoff,
      queue,
      log: { error },
      handlers: { encode: async () => ({ ok: true }) },
    });

    await worker.run();
    expect(queue.fail).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Job queue error:", expect.any(Error));
  });

  test("logs when the lease was lost and the outcome was discarded", async () => {
    const queue = fakeQueue([fakeJob("a")]);
    queue.complete.mockImplementation(async () => {
      worker.stop();
      return false;
    });
    const error = mock(() => {});
    const worker = createWorker({
      handoff,
      queue,
      log: { error },
      handlers: { encode: async () => null },
    });

    await worker.run();
    expect(error).toHaveBeenCalledWith("Job a attempt 1: lease lost, outcome discarded");
  });

  test("run() cannot be started twice", async () => {
    const worker = createWorker({
      handoff,
      queue: fakeQueue([]),
      log: silent,
      pollIntervalMs: 60_000,
      handlers: {},
    });
    const done = worker.run();
    await expect(worker.run()).rejects.toThrow("Worker is already running");
    worker.stop();
    await done;
  });

  test("a job type without a handler fails without retries", async () => {
    const queue = fakeQueue([fakeJob("a", "experiment")]);
    const worker = createWorker({ handoff, queue, log: silent, pollIntervalMs: 5, handlers: {} });
    const done = worker.run();
    while (queue.fail.mock.calls.length === 0) await Bun.sleep(1);
    worker.stop();
    await done;

    const [job, error, options] = queue.fail.mock.calls[0] ?? [];
    expect(job?.id).toBe("a");
    expect(error).toEqual(new JobError("no_handler"));
    expect(options).toEqual({ retry: false });
  });

  test("stop() lets the job in progress finish and then picks up nothing new", async () => {
    const queue = fakeQueue([fakeJob("a"), fakeJob("b")]);
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    const { promise: release, resolve: releaseJob } = Promise.withResolvers<void>();
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      handlers: {
        encode: async () => {
          markStarted();
          await release;
          return { ok: true };
        },
      },
    });

    const done = worker.run();
    await started;
    worker.stop();
    let finished = false;
    void done.then(() => {
      finished = true;
    });
    await Bun.sleep(10);
    expect(finished).toBe(false);

    releaseJob();
    await done;
    expect(queue.complete).toHaveBeenCalledTimes(1);
    expect(queue.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), { ok: true });
    expect(queue.claim).toHaveBeenCalledTimes(1);
  });

  test("stop() wakes an idle worker without waiting for the poll interval", async () => {
    const queue = fakeQueue([]);
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      pollIntervalMs: 60_000,
      handlers: {},
    });
    const done = worker.run();
    await Bun.sleep(5);
    const start = performance.now();
    worker.stop();
    await done;
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("wake() claims a job that appeared during a long pause", async () => {
    const queue = fakeQueue([]);
    const done = Promise.withResolvers<void>();
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      pollIntervalMs: 60_000,
      handlers: {
        encode: async () => {
          done.resolve();
        },
      },
    });
    const run = worker.run();
    await Bun.sleep(5);
    queue.claim.mockImplementationOnce(async () => fakeJob("late"));
    const start = performance.now();
    worker.wake();
    await done.promise;
    expect(performance.now() - start).toBeLessThan(500);
    worker.stop();
    await run;
  });

  test("a wake() that arrives while a claim is in flight is not lost", async () => {
    const queue = fakeQueue([]);
    const claimed = Promise.withResolvers<void>();
    let calls = 0;
    queue.claim.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        // The job shows up after this empty answer was decided, and the hint arrives before the worker pauses.
        await Bun.sleep(5);
        return null;
      }
      claimed.resolve();
      return null;
    });
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      pollIntervalMs: 60_000,
      handlers: {},
    });
    const run = worker.run();
    worker.wake();
    await Promise.race([claimed.promise, Bun.sleep(500)]);
    expect(calls).toBe(2);
    worker.stop();
    await run;
  });

  test("a burst of wake() calls leads to one extra claim, not one per call", async () => {
    const queue = fakeQueue([]);
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      pollIntervalMs: 60_000,
      handlers: {},
    });
    const run = worker.run();
    await Bun.sleep(5);
    expect(queue.claim).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) worker.wake();
    await Bun.sleep(50);
    expect(queue.claim).toHaveBeenCalledTimes(2);
    worker.stop();
    await run;
  });

  test("a queue error is logged and the loop keeps polling", async () => {
    const error = mock(() => {});
    const queue = fakeQueue([]);
    queue.claim.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });
    queue.claim.mockImplementationOnce(async () => {
      worker.stop();
      return null;
    });
    const worker = createWorker({
      handoff,
      queue,
      log: { error },
      pollIntervalMs: 1,
      handlers: {},
    });

    await worker.run();
    expect(queue.claim).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("Job queue error:", expect.any(Error));
  });

  test("a job past its timeout is aborted and failed without retry", async () => {
    const queue = fakeQueue([fakeJob("a")]);
    let signal: AbortSignal | undefined;
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      jobTimeoutMs: 20,
      handlers: {
        encode: (_job, context) => {
          signal = context.signal;
          worker.stop();
          return new Promise(() => {}); // never settles, ignores the signal
        },
      },
    });

    await worker.run();
    expect(signal?.aborted).toBe(true);
    const [, error, options] = queue.fail.mock.calls[0] ?? [];
    expect(error).toEqual(new JobError("timeout"));
    expect(options).toEqual({ retry: false });
    expect(queue.complete).not.toHaveBeenCalled();
  });

  test("renews the lease while a job runs and aborts it once the lease is lost", async () => {
    const queue = fakeQueue([fakeJob("a")]);
    queue.extend.mockImplementation(async () => queue.extend.mock.calls.length < 3);
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      heartbeatMs: 5,
      handlers: {
        encode: (_job, { signal }) => {
          worker.stop();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          });
        },
      },
    });

    await worker.run();
    expect(queue.extend).toHaveBeenCalledTimes(3);
    expect(queue.fail.mock.calls[0]?.[1]).toEqual(new JobError("lease_lost"));
  });

  test("run() cannot start a second loop while a stopped one is still finishing its job", async () => {
    const queue = fakeQueue([fakeJob("a")]);
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    const { promise: release, resolve: releaseJob } = Promise.withResolvers<void>();
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      handlers: {
        encode: async () => {
          markStarted();
          await release;
          return null;
        },
      },
    });

    const done = worker.run();
    await started;
    worker.stop();
    await expect(worker.run()).rejects.toThrow("Worker is already running");
    releaseJob();
    await done;
  });

  test("does not stack lease renewals while one is still in flight", async () => {
    const queue = fakeQueue([fakeJob("a")]);
    const { promise: slowExtend, resolve: finishExtend } = Promise.withResolvers<boolean>();
    queue.extend.mockImplementation(() => slowExtend);
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      heartbeatMs: 2,
      handlers: {
        encode: async () => {
          worker.stop();
          await Bun.sleep(30);
          return null;
        },
      },
    });

    await worker.run();
    expect(queue.extend).toHaveBeenCalledTimes(1);
    finishExtend(true);
  });

  test("rejects invalid timer options", () => {
    const queue = fakeQueue([]);
    expect(() => createWorker({ handoff, queue, handlers: {}, heartbeatMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => createWorker({ handoff, queue, handlers: {}, jobTimeoutMs: 2 ** 31 })).toThrow(
      RangeError,
    );
  });

  describe("message handoff", () => {
    function run(options: {
      queue: ReturnType<typeof fakeQueue>;
      store?: ReturnType<typeof createMemoryStore>;
      handler: JobHandler;
      log?: Pick<Console, "error">;
    }) {
      const store = options.store ?? createMemoryStore();
      const worker = createWorker({
        queue: options.queue,
        handoff: createMessageHandoff(store),
        log: options.log ?? silent,
        pollIntervalMs: 1,
        handlers: {
          encode: async (job, context) => {
            worker.stop();
            return options.handler(job, context);
          },
        },
      });
      return { store, done: worker.run() };
    }

    test("the handler reads the message and it is deleted once the job succeeds", async () => {
      const store = createMemoryStore();
      await store.set("op:op-a:message", "hello", 60_000);
      let seen: string | undefined;
      const queue = fakeQueue([fakeJob("a")]);
      const { done } = run({
        queue,
        store,
        handler: async (_job, context) => {
          seen = await context.message();
          expect(await store.get("op:op-a:message")).toBe("hello");
          return { ok: true };
        },
      });
      await done;
      expect(seen).toBe("hello");
      expect(await store.get("op:op-a:message")).toBeNull();
    });

    test("a missing message fails the job without retry as message_expired", async () => {
      const queue = fakeQueue([fakeJob("a")]);
      const { done } = run({
        queue,
        handler: (_job, context) => context.message().then(() => ({})),
      });
      await done;
      const [, error, options] = queue.fail.mock.calls[0] ?? [];
      expect(error).toEqual(new JobError("message_expired"));
      expect(options).toEqual({ retry: false });
    });

    test("a retryable failure keeps the message, the last attempt deletes it", async () => {
      const store = createMemoryStore();
      await store.set("op:op-a:message", "hello", 60_000);
      const failing: JobHandler = async () => {
        throw new Error("transient");
      };

      const first = fakeQueue([fakeJob("a")]);
      await run({ queue: first, store, handler: failing }).done;
      expect(await store.get("op:op-a:message")).toBe("hello");

      const last = fakeQueue([{ ...fakeJob("a"), attempts: 3 }]);
      await run({ queue: last, store, handler: failing }).done;
      expect(await store.get("op:op-a:message")).toBeNull();
    });

    test("a job that lost its lease leaves the message to the new owner", async () => {
      const store = createMemoryStore();
      await store.set("op:op-a:message", "hello", 60_000);
      const queue = fakeQueue([fakeJob("a")]);
      queue.complete.mockImplementation(async () => false);
      await run({ queue, store, handler: async () => null }).done;
      expect(await store.get("op:op-a:message")).toBe("hello");
    });

    test("reveal stores the decoded message under op:{id}:revealed", async () => {
      const queue = fakeQueue([fakeJob("a", "encode")]);
      const { store, done } = run({
        queue,
        handler: async (_job, context) => {
          await context.reveal("decoded");
          return { ok: true };
        },
      });
      await done;
      expect(await store.get("op:op-a:revealed")).toBe("decoded");
    });

    test("a failing delete is logged and does not fail the job", async () => {
      const error = mock(() => {});
      const queue = fakeQueue([fakeJob("a")]);
      const broken = createMemoryStore();
      broken.del = async () => {
        throw new Error("redis down");
      };
      await run({ queue, store: broken, log: { error }, handler: async () => null }).done;
      expect(queue.complete).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("Job a: could not delete the message:", expect.any(Error));
    });
  });

  test("claims nothing while not ready, then resumes", async () => {
    const queue = fakeQueue([fakeJob("a")]);
    let calls = 0;
    const worker = createWorker({
      handoff,
      queue,
      log: silent,
      pollIntervalMs: 1,
      ready: async () => ++calls > 3,
      handlers: {
        encode: async () => {
          worker.stop();
          return null;
        },
      },
    });
    await worker.run();
    expect(calls).toBe(4);
    expect(queue.complete).toHaveBeenCalledTimes(1);
  });
});
