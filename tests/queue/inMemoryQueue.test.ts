import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryQueue } from "../../apps/server/src/queue/inMemoryQueue";

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("Timed out waiting for queue condition");
}

test("queue processes jobs in enqueue order when concurrency is 1", async () => {
  const queue = new InMemoryQueue<number>({ concurrency: 1 });
  const processed: number[] = [];

  queue.start(async (job) => {
    processed.push(job);
  });

  for (let i = 0; i < 5; i += 1) {
    queue.enqueue(i);
  }

  await waitFor(() => processed.length === 5);
  assert.deepEqual(processed, [0, 1, 2, 3, 4]);
});

test("queue respects configured concurrency", async () => {
  const queue = new InMemoryQueue<number>({ concurrency: 2 });
  let inFlight = 0;
  let maxInFlight = 0;
  let completed = 0;

  queue.start(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    inFlight -= 1;
    completed += 1;
  });

  for (let i = 0; i < 8; i += 1) {
    queue.enqueue(i);
  }

  await waitFor(() => completed === 8, 4_000);
  assert.ok(maxInFlight <= 2);
});

test("queue calls onError and continues processing", async () => {
  const failures: number[] = [];
  const processed: number[] = [];

  const queue = new InMemoryQueue<number>({
    concurrency: 1,
    onError: (_error, job) => failures.push(job)
  });

  queue.start(async (job) => {
    if (job === 1 || job === 3) {
      throw new Error(`boom_${job}`);
    }
    processed.push(job);
  });

  [0, 1, 2, 3, 4].forEach((job) => queue.enqueue(job));

  await waitFor(() => failures.length === 2 && processed.length === 3);
  assert.deepEqual(failures, [1, 3]);
  assert.deepEqual(processed, [0, 2, 4]);
});
