/**
 * The CI performance check of tools/balance/bench.ts (docs/v3/implementation-plan-v3.md §6), as
 * pure functions of measured run times; bench.ts times the runs.
 *
 * The reference is the current build's normal workload, timed in the same process as the
 * scenarios: each scenario's timed runs alternate with reference runs, so a slower or busier
 * machine slows both alike. A scenario's ratio is its median run time ÷ the median of the
 * reference runs timed with it. bench.baseline.json records every ratio (--check --write), and a
 * check fails when a ratio exceeds RATIO_LIMIT × the recorded one. A slowdown of the whole
 * simulation moves the reference with every scenario, so the check also fails when the
 * reference's own median run exceeds NORMAL_BUDGET_MS, §6's budget for a 3-minute run.
 */

/** A scenario fails above this multiple of its recorded ratio (§6). */
export const RATIO_LIMIT = 1.5;
/** The reference (normal) fails above this median run time, ms (§6). */
export const NORMAL_BUDGET_MS = 50;

/** Run times of one checked entry, a scenario or one variant of it, in ms. */
export interface EntryTimings {
  /** The scenario id, with its variant in parentheses: 'poisonBoss (5 stacks)'. */
  readonly id: string;
  readonly ms: readonly number[];
  /** The reference runs that alternated with them. */
  readonly referenceMs: readonly number[];
}

export interface BenchTimings {
  /** Every timed reference run of the check, ms. */
  readonly reference: readonly number[];
  readonly entries: readonly EntryTimings[];
}

/** bench.baseline.json: each entry's ratio to the reference, in check order. */
export interface BenchBaseline {
  readonly ratios: Readonly<Record<string, number>>;
}

export interface BenchCheck {
  readonly ok: boolean;
  /** The report, one line per entry, then the reference. */
  readonly lines: readonly string[];
  /** What --write records: the measured ratios over the recorded ones. */
  readonly baseline: BenchBaseline;
}

/** Recorded ratios keep this many decimals. */
const RATIO_DECIMALS = 3;

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** The ratio of an entry: its median run ÷ the median of the reference runs timed with it. */
export const entryRatio = (entry: EntryTimings): number =>
  median(entry.ms) / median(entry.referenceMs);

/** Parses bench.baseline.json; throws unless it has a positive ratio per entry. */
export function parseBaseline(text: string): BenchBaseline {
  const parsed: unknown = JSON.parse(text);
  const ratios =
    typeof parsed === 'object' && parsed !== null ? (parsed as { ratios?: unknown }).ratios : null;
  if (typeof ratios !== 'object' || ratios === null || Array.isArray(ratios)) {
    throw new Error('bench baseline: expected {"ratios": {"<scenario>": <ratio>, …}}');
  }
  for (const [id, ratio] of Object.entries(ratios)) {
    if (typeof ratio !== 'number' || !(ratio > 0) || !Number.isFinite(ratio)) {
      throw new Error(`bench baseline: ratio of '${id}' must be a positive number`);
    }
  }
  return { ratios: ratios as Record<string, number> };
}

export const formatBaseline = (baseline: BenchBaseline): string =>
  `${JSON.stringify(baseline, null, 2)}\n`;

const ms = (value: number): string => `${value.toFixed(1)} ms`;

/**
 * Checks `timings` against the `recorded` baseline (null when there is none), where `known` are
 * the entries bench.ts can check, in check order. Without `write`: every timed entry needs a
 * recorded ratio and stays within RATIO_LIMIT × it, the baseline names no unknown entry, and
 * the reference's median run is within NORMAL_BUDGET_MS. With `write`, only the reference's
 * budget can fail, and the returned baseline holds the measured ratios, the recorded ones of
 * known entries not timed this time, and nothing else.
 */
export function checkBench(
  timings: BenchTimings,
  recorded: BenchBaseline | null,
  known: readonly string[],
  write: boolean,
): BenchCheck {
  const lines: string[] = [];
  let ok = true;
  const fail = (line: string): void => {
    ok = false;
    lines.push(`${line}: FAILED`);
  };
  const measured = new Map<string, number>();
  for (const entry of timings.entries) {
    if (!known.includes(entry.id)) throw new Error(`Unknown bench entry '${entry.id}'`);
    measured.set(entry.id, entryRatio(entry));
  }
  const old = recorded?.ratios ?? {};

  if (!write && recorded === null) {
    fail('no recorded ratios; record them with npm run bench -- --check --write');
  }
  for (const entry of timings.entries) {
    const ratio = measured.get(entry.id) as number;
    const line =
      `${entry.id}: median ${ms(median(entry.ms))}, ` +
      `reference ${ms(median(entry.referenceMs))}, ratio ${ratio.toFixed(RATIO_DECIMALS)}`;
    const was = old[entry.id];
    if (write) {
      lines.push(`${line}, recorded`);
    } else if (recorded === null) {
      lines.push(line);
    } else if (was === undefined) {
      fail(`${line}, no recorded ratio (npm run bench -- --check --write)`);
    } else {
      const limit = RATIO_LIMIT * was;
      const text = `${line} (recorded ${was}, limit ${limit.toFixed(RATIO_DECIMALS)})`;
      if (ratio > limit) fail(text);
      else lines.push(`${text}: ok`);
    }
  }
  for (const id of Object.keys(old)) {
    if (known.includes(id)) continue;
    if (write) lines.push(`${id}: no such scenario, dropped`);
    else fail(`${id}: recorded, but no such scenario (npm run bench -- --check --write)`);
  }

  const normal = median(timings.reference);
  const reference =
    `normal (reference): median ${ms(normal)} over ${timings.reference.length} runs ` +
    `(budget ${NORMAL_BUDGET_MS} ms)`;
  if (!(normal <= NORMAL_BUDGET_MS)) fail(reference);
  else lines.push(`${reference}: ok`);

  const ratios: Record<string, number> = {};
  for (const id of known) {
    const ratio = measured.get(id);
    const value = ratio === undefined ? old[id] : Number(ratio.toFixed(RATIO_DECIMALS));
    if (value !== undefined) ratios[id] = value;
  }
  return { ok, lines, baseline: { ratios } };
}
