/**
 * The balance pool's jobs (docs/v3 C10 design §1.1): an M1 session or a character session, run
 * in-process or on a worker thread (pool.ts). A job and its result are plain data, so both cross
 * postMessage unchanged and the output never depends on where a job ran.
 */

import { runPool } from './pool';
import type { PoolRun } from './pool';
import { runSession } from './session';
import type { SessionConfig, SessionResult } from './session';
import { runCharacterSession } from './v3/session';
import type { CharacterSessionConfig, CharacterSessionResult } from './v3/session';

/** One job. C10.2 adds a `measure` kind, with its tools/balance/v3/measures.ts. */
export type BalanceJob =
  | { readonly kind: 'm1'; readonly config: SessionConfig }
  | { readonly kind: 'character'; readonly config: CharacterSessionConfig };

export type JobResult =
  | { readonly kind: 'm1'; readonly result: SessionResult }
  | { readonly kind: 'character'; readonly result: CharacterSessionResult };

/** Either session config; an M1 one has no character (SessionConfig.character is never set). */
export type AnySessionConfig = SessionConfig | CharacterSessionConfig;

export const jobOf = (config: AnySessionConfig): BalanceJob =>
  config.character === undefined ? { kind: 'm1', config } : { kind: 'character', config };

/** Runs one job here, in this thread. */
export function runJob(job: BalanceJob): JobResult {
  switch (job.kind) {
    case 'm1':
      return { kind: 'm1', result: runSession(job.config) };
    case 'character':
      return { kind: 'character', result: runCharacterSession(job.config) };
  }
}

/** Runs every job on up to `workers` worker threads (in-process for one); results in job order. */
export function runJobs(
  jobs: readonly BalanceJob[],
  workers: number,
  log: (message: string) => void = () => {},
): Promise<PoolRun<JobResult>> {
  return runPool(
    jobs,
    workers,
    log,
    () => jobs.map(runJob),
    (results) => results,
  );
}
