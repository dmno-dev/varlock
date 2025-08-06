/** A simple queue implementation for sequential execution of async operations */
export class SimpleQueue {
  private queue: Array<() => Promise<any>> = [];
  private processing = false;

  /** Add a task to the queue and return a promise that resolves when the task is complete */
  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });

      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const task = this.queue.shift();

    if (task) {
      try {
        await task();
      } finally {
        this.processing = false;
        this.processQueue();
      }
    }
  }
}
