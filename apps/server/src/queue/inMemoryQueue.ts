export type QueueWorker<T> = (job: T) => Promise<void>;

type QueueOptions<T> = {
  concurrency?: number;
  onError?: (error: unknown, job: T) => void;
};

export class InMemoryQueue<T> {
  private readonly queue: T[] = [];
  private readonly concurrency: number;
  private readonly onError?: (error: unknown, job: T) => void;
  private worker?: QueueWorker<T>;
  private inFlight = 0;

  constructor(options: QueueOptions<T> = {}) {
    this.concurrency = options.concurrency ?? 1;
    this.onError = options.onError;
  }

  start(worker: QueueWorker<T>): void {
    this.worker = worker;
    void this.drain();
  }

  enqueue(job: T): void {
    this.queue.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (!this.worker) return;

    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job === undefined) continue;

      this.inFlight += 1;

      void this.worker(job)
        .catch((error) => this.onError?.(error, job))
        .finally(() => {
          this.inFlight -= 1;
          void this.drain();
        });
    }
  }
}
