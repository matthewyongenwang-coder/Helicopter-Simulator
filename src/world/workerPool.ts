import type { WorkerRequest, WorkerResponse } from './chunkWorker';

type JobRequest = Exclude<WorkerRequest, { type: 'init' }>;
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

interface Job {
  id: number;
  request: JobRequest;
  /** Lower runs first. Evaluated when a worker becomes free, so it can follow the camera. */
  priority: () => number;
  done: (res: WorkerResponse) => void;
  cancelled: boolean;
}

export interface JobHandle {
  cancel(): void;
}

/** A small pool of chunk workers with a priority queue and cancellation. */
export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  private running = new Map<number, Job>();
  /** Which job each busy worker is on. */
  private busy = new Map<Worker, number>();
  private nextId = 1;

  constructor(seed: number, count: number) {
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.onResult(w, e.data);
      w.onerror = (e) => this.onCrash(w, e);
      w.postMessage({ type: 'init', seed } satisfies WorkerRequest);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** Jobs waiting or in flight. */
  get pending(): number {
    return this.queue.length + this.running.size;
  }

  submit(request: DistributiveOmit<JobRequest, 'id'>, priority: () => number, done: (res: WorkerResponse) => void): JobHandle {
    const job: Job = { id: this.nextId++, request: { ...request, id: 0 } as JobRequest, priority, done, cancelled: false };
    job.request.id = job.id;
    this.queue.push(job);
    this.pump();
    return {
      cancel: () => {
        job.cancelled = true;
      },
    };
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      // Pick the most urgent live job.
      let best = -1, bestP = Infinity;
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const j = this.queue[i];
        if (j.cancelled) {
          this.queue.splice(i, 1);
          if (best > i) best--;
          continue;
        }
        const p = j.priority();
        // `best < 0` keeps the queue moving even if a priority comes back NaN.
        if (best < 0 || p < bestP) {
          bestP = p;
          best = i;
        }
      }
      if (best < 0) return;
      const job = this.queue.splice(best, 1)[0];
      const w = this.idle.pop()!;
      this.running.set(job.id, job);
      this.busy.set(w, job.id);
      w.postMessage(job.request);
    }
  }

  private onResult(w: Worker, res: WorkerResponse): void {
    const job = this.running.get(res.id);
    this.running.delete(res.id);
    this.busy.delete(w);
    if (!this.idle.includes(w)) this.idle.push(w);
    if (res.type === 'error') console.error(`World generation failed (${job?.request.type ?? 'job'} ${res.id}): ${res.message}`);
    else if (job && !job.cancelled) job.done(res);
    this.pump();
  }

  /** The worker itself failed (a script error outside a job): free whatever it was doing. */
  private onCrash(w: Worker, e: ErrorEvent): void {
    e.preventDefault();
    console.error(`World worker error: ${e.message}`);
    const id = this.busy.get(w);
    if (id !== undefined) this.running.delete(id);
    this.busy.delete(w);
    if (!this.idle.includes(w)) this.idle.push(w);
    this.pump();
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    this.queue.length = 0;
    this.running.clear();
    this.busy.clear();
  }
}
