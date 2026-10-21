import { DsearchError } from '@dsearch/contracts';
type Waiter = { start: () => void; abort: () => void; signal?: AbortSignal };
/** One app-wide native lane. Waiting cancellation removes the request before any model starts. */
export class HeavyLane {
  private held = false;
  private readonly queue: Waiter[] = [];
  get busy(): boolean { return this.held; }
  get queued(): number { return this.queue.length; }
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new DsearchError('CANCELLED');
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { signal, start: () => { signal.removeEventListener('abort', waiter.abort); this.held = true; resolve(); }, abort: () => { const index = this.queue.indexOf(waiter); if (index >= 0) this.queue.splice(index, 1); reject(new DsearchError('CANCELLED')); } };
      if (!this.held) waiter.start(); else { this.queue.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true }); }
    });
    let released = false;
    return () => { if (released) return;released = true;this.held = false;this.queue.shift()?.start(); };
  }
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try { if (signal.aborted) throw new DsearchError('CANCELLED');return await operation(); }
    finally { release(); }
  }
}
