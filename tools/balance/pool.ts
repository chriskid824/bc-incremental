/**
 * Runs balance jobs (tools/balance/jobs.ts) in parallel on worker_threads, one whole session per
 * job, falling back to in-process execution when workers cannot start. Results come back in job
 * order, so the output never depends on the worker count or scheduling.
 */

import { Worker } from 'node:worker_threads';
import type { BalanceJob, JobResult } from './jobs';
import { runSession } from './session';
import type { SessionConfig, SessionResult } from './session';

/** Main → worker. */
export type JobMessage =
  | { readonly type: 'job'; readonly index: number; readonly job: BalanceJob }
  | { readonly type: 'stop' };

/** Worker → main. */
export type WorkerMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'result'; readonly index: number; readonly result: JobResult }
  | { readonly type: 'failed'; readonly index: number; readonly message: string };

/**
 * Plain-JS entry that registers tsx and then loads worker.ts. Passing
 * `execArgv: ['--import', 'tsx']` to a .ts worker is not enough on Node 22: the worker loads
 * but tsx's resolver is not active there, so extensionless imports fail.
 */
const WORKER_ENTRY = new URL('./worker-boot.mjs', import.meta.url);

/** A session threw inside a worker; rerunning it in-process would fail the same way. */
export class SessionError extends Error {
  override readonly name = 'SessionError';
}

export interface PoolRun<T = SessionResult> {
  /** Results in the order of the input jobs. */
  readonly results: T[];
  readonly mode: 'workers' | 'in-process';
  readonly workers: number;
  /** Why the worker pool was abandoned, when it was. */
  readonly fallbackReason: string | null;
}

export function runInProcess(configs: readonly SessionConfig[]): SessionResult[] {
  return configs.map((config) => runSession(config));
}

/** Rejects with SessionError when a job fails, with a plain Error when a worker does. */
export function runInWorkers(
  jobs: readonly BalanceJob[],
  workerCount: number,
): Promise<JobResult[]> {
  const count = Math.max(1, Math.min(workerCount, jobs.length));
  return new Promise((resolve, reject) => {
    const results: (JobResult | undefined)[] = new Array<JobResult | undefined>(jobs.length);
    const workers: Worker[] = [];
    /** Workers told to stop because the queue is empty; they exit on their own. */
    const stopped = new Set<Worker>();
    let next = 0;
    let done = 0;
    let exited = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      for (const worker of workers) void worker.terminate();
      reject(error);
    };

    const dispatch = (worker: Worker): void => {
      let message: JobMessage;
      if (next < jobs.length) {
        message = { type: 'job', index: next, job: jobs[next] as BalanceJob };
        next++;
      } else {
        message = { type: 'stop' };
        stopped.add(worker);
      }
      worker.postMessage(message);
    };

    for (let i = 0; i < count; i++) {
      const worker = new Worker(WORKER_ENTRY, { execArgv: [] });
      workers.push(worker);
      worker.on('message', (message: WorkerMessage) => {
        if (settled) return;
        if (message.type === 'ready') {
          dispatch(worker);
        } else if (message.type === 'result') {
          results[message.index] = message.result;
          done++;
          dispatch(worker);
        } else {
          fail(new SessionError(message.message));
        }
      });
      worker.on('error', (error) => fail(error));
      worker.on('exit', (code) => {
        exited++;
        if (settled) return;
        if (!stopped.has(worker)) {
          fail(new Error(`Balance worker exited with code ${code} before finishing its jobs`));
        } else if (exited === count) {
          if (done !== jobs.length) {
            fail(new Error(`Balance workers returned ${done} of ${jobs.length} jobs`));
            return;
          }
          settled = true;
          resolve(results as JobResult[]);
        }
      });
    }
  });
}

/**
 * Runs every job with up to `workerCount` workers, or in-process (`inProcess`) for one worker,
 * `fromWorkers` reading the workers' results. If the pool fails for a reason other than a job's
 * error, logs it and reruns everything in-process.
 */
export async function runPool<T>(
  jobs: readonly BalanceJob[],
  workerCount: number,
  log: (message: string) => void,
  inProcess: () => T[],
  fromWorkers: (results: JobResult[]) => T[],
): Promise<PoolRun<T>> {
  const count = Math.min(workerCount, jobs.length);
  if (count <= 1) {
    return { results: inProcess(), mode: 'in-process', workers: 1, fallbackReason: null };
  }
  try {
    const results = fromWorkers(await runInWorkers(jobs, count));
    return { results, mode: 'workers', workers: count, fallbackReason: null };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    log(`Worker pool failed (${reason}); running in-process instead.`);
    return {
      results: inProcess(),
      mode: 'in-process',
      workers: 1,
      fallbackReason: reason,
    };
  }
}

/** An M1 job's session result; runSessions' jobs are M1 jobs only. */
function m1Result(result: JobResult): SessionResult {
  if (result.kind !== 'm1') throw new Error(`Expected an M1 session result, got '${result.kind}'`);
  return result.result;
}

/**
 * Runs every M1 session with up to `workerCount` workers, or in-process for one worker, each
 * config as an `m1` job; as runPool, it falls back to in-process when the pool fails.
 */
export function runSessions(
  configs: readonly SessionConfig[],
  workerCount: number,
  log: (message: string) => void = () => {},
): Promise<PoolRun> {
  return runPool(
    configs.map((config): BalanceJob => ({ kind: 'm1', config })),
    workerCount,
    log,
    () => runInProcess(configs),
    (results) => results.map(m1Result),
  );
}
