const POLL_INTERVAL_MS = 1_000;

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

console.info("Worker started");
while (running) {
  // Job pickup (SELECT … FOR UPDATE SKIP LOCKED) lands with the job queue issue.
  await Bun.sleep(POLL_INTERVAL_MS);
}
console.info("Worker stopped");
