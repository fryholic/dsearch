import { DsearchError } from '@dsearch/contracts';
export type NativePriority = 'interactive' | 'background';
type Waiter = { priority: NativePriority; start: () => void; abort: () => void };
/** One app-wide native lane. Search wins up to three grants before a waiting build gets a turn. */
export class HeavyLane {
  private held = false;
  private interactiveStreak = 0;
  private readonly queue: Waiter[] = [];
  get busy(): boolean { return this.held; }
  get queued(): number { return this.queue.length; }
  get interactiveQueued(): number { return this.queue.filter(w => w.priority === 'interactive').length; }
  async acquire(signal: AbortSignal, priority: NativePriority = 'interactive'): Promise<() => void> {
    if (signal.aborted) throw new DsearchError('CANCELLED');
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { priority, start: () => {
        signal.removeEventListener('abort', waiter.abort);this.held = true;
        this.interactiveStreak = priority === 'background' ? 0 : Math.min(3, this.interactiveStreak + 1);resolve();
      }, abort: () => { const index = this.queue.indexOf(waiter);if (index >= 0) this.queue.splice(index, 1);reject(new DsearchError('CANCELLED')); } };
      if (!this.held) waiter.start();else { this.queue.push(waiter);signal.addEventListener('abort', waiter.abort, { once: true }); }
    });
    let released = false;
    return () => {
      if (released) return;released = true;this.held = false;
      const interactive = this.queue.findIndex(w => w.priority === 'interactive'), background = this.queue.findIndex(w => w.priority === 'background');
      const index = background >= 0 && (interactive < 0 || this.interactiveStreak >= 3) ? background : interactive;
      if (index >= 0) this.queue.splice(index, 1)[0]!.start();
    };
  }
  async run<T>(signal: AbortSignal, operation: () => Promise<T>, priority: NativePriority = 'interactive'): Promise<T> {
    const release = await this.acquire(signal, priority);
    try { if (signal.aborted) throw new DsearchError('CANCELLED');return await operation(); }
    finally { release(); }
  }
}
