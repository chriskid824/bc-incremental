/**
 * The balance pool's jobs (docs/v3 C10 design §1.1): an M1 session, a character session or a
 * measure's probe runs, run in-process or on a worker thread (pool.ts). A job and its result are
 * plain data, so both cross postMessage unchanged and the output never depends on where a job ran.
 */

import { runPool } from './pool';
import type { PoolRun } from './pool';
import { runSession } from './session';
import type { SessionConfig, SessionResult } from './session';
import { runMeasure } from './v3/measures';
import type { MeasureId, MeasureInput, MeasureReading } from './v3/measures';
import { runCharacterSession } from './v3/session';
import type { CharacterSessionConfig, CharacterSessionResult } from './v3/session';

/**
 * One job: an M1 session, a character session, or a measure (tools/balance/v3/measures.ts, whose
 * MeasureId names it and whose input it reads).
 */
export type BalanceJob =
  | { readonly kind: 'm1'; readonly config: SessionConfig }
  | { readonly kind: 'character'; readonly config: CharacterSessionConfig }
  | { readonly kind: 'measure'; readonly measure: MeasureId; readonly input: MeasureInput };

export type JobResult =
  | { readonly kind: 'm1'; readonly result: SessionResult }
  | { readonly kind: 'character'; readonly result: CharacterSessionResult }
  | { readonly kind: 'measure'; readonly measure: MeasureId; readonly result: MeasureReading };

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
    case 'measure':
      return { kind: 'measure', measure: job.measure, result: runMeasure(job.measure, job.input) };
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
