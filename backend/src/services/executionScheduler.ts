/** A shared, FIFO, abortable scheduler. A slot is handed directly to the next waiter. */
export class ExecutionScheduler {
  private pools = new Map<string, { active: number; limit: number; queue: Array<() => void> }>();

  setLimit(key: string, limit: number) {
    const pool = this.pools.get(key) || { active: 0, limit: 1, queue: [] };
    pool.limit = Math.max(1, Math.floor(limit || 1));
    this.pools.set(key, pool);
    while (pool.active < pool.limit && pool.queue.length) pool.queue.shift()!();
  }

  acquire(key: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const pool = this.pools.get(key) || { active: 0, limit: 1, queue: [] };
    this.pools.set(key, pool);
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = pool.queue.indexOf(grant);
        if (index !== -1) pool.queue.splice(index, 1);
        reject(signal.reason);
      };
      const grant = () => {
        signal.removeEventListener("abort", abort);
        pool.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          pool.active--;
          while (pool.active < pool.limit && pool.queue.length) pool.queue.shift()!();
        });
      };
      signal.addEventListener("abort", abort, { once: true });
      if (pool.active < pool.limit && !pool.queue.length) grant();
      else pool.queue.push(grant);
    });
  }
}

export const executionScheduler = new ExecutionScheduler();
