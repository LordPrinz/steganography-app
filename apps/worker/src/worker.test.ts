import { describe, expect, mock, test } from "bun:test";
import { type ClaimedJob, JobError, type JobQueue, type OperationType } from "@stego/db";
import { createWorker } from "./worker.ts";

const silent = { error: () => {} };

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
    claim: mock(async () => pending.shift() ?? null),
    extend: mock<JobQueue["extend"]>(async () => true),
    complete: mock<JobQueue["complete"]>(async () => true),
    fail: mock<JobQueue["fail"]>(async () => true),
  };
}

describe("worker", () => {
  test("dispatches each job to the handler for its type and completes it with the result", async () => {
    const queue = fakeQueue([fakeJob("a"), fakeJob("b", "decode")]);
    const worker = createWorker({
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
    const worker = createWorker({ queue, log: { error }, handlers: { encode: async () => null } });

    await worker.run();
    expect(error).toHaveBeenCalledWith("Job a attempt 1: lease lost, outcome discarded");
  });

  test("run() cannot be started twice", async () => {
    const worker = createWorker({
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
    const worker = createWorker({ queue, log: silent, pollIntervalMs: 5, handlers: {} });
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
    const worker = createWorker({ queue, log: silent, pollIntervalMs: 60_000, handlers: {} });
    const done = worker.run();
    await Bun.sleep(5);
    const start = performance.now();
    worker.stop();
    await done;
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("a queue error is logged and the loop keeps polling", async () => {
    const error = mock(() => {});
    let calls = 0;
    const queue = {
      claim: mock(async () => {
        calls++;
        if (calls === 1) throw new Error("connection lost");
        worker.stop();
        return null;
      }),
      extend: mock<JobQueue["extend"]>(async () => true),
      complete: mock<JobQueue["complete"]>(async () => true),
      fail: mock<JobQueue["fail"]>(async () => true),
    };
    const worker = createWorker({
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
});
