/**
 * The nightly (docs/v3 C10 design §1.6; docs/ARCHITECTURE.md §12): implementation-plan-v3 §4's
 * nightly and weekly sets (checks/run.ts) split into shards, so .github/workflows/nightly.yml runs
 * them as a matrix and one job merges and reports them:
 *
 *   npm run nightly -- [--weekly] [--quick] [--content <c>] [--out out/nightly]    plan, every shard, merge
 *   npm run nightly -- --plan [--weekly] [--quick] [--content <c>] [--json]        the plan (Plan JSON v1)
 *   npm run nightly -- --shard <id> [--weekly] [--quick] [--content <c>] --out <dir>   one shard's units
 *   npm run nightly -- --merge <dir> --out <dir> [--summary <file>]                evaluate and report
 *
 * The plan is a function of the set, --quick, the content and the commit, so every job recomputes
 * it from the code it checked out. A shard runs its units (`measure` jobs and sessions) on the
 * balance pool and writes <dir>/shards/<id>/: units.json (every unit's job and result, exactly),
 * its CSV fragments for inspection and meta.json, last. The merge reads the shards the plan names,
 * refuses a missing, foreign or unreadable one, checks every unit has a result, evaluates every
 * check (run.ts' pure evaluate) and writes report.md, checks.json, checks.csv, summary.md and every
 * check's CSV from the merged results. Exit codes: 0 no unaccepted FAIL, 1 an unaccepted FAIL or a
 * missing shard, 2 usage, 3 a crash; a shard exits 0 once its files are written.
 */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CHARACTER_IDS } from '../../../src/data/sources';
import type { CharacterId } from '../../../src/data/sources';
import { WEB_FUZZ_SEED } from '../../../src/meta/web/fuzz';
import type { CliIo } from '../cli';
import { runJobs } from '../jobs';
import type { BalanceJob, JobResult } from '../jobs';
import { fromGit, planOutputs, readRef } from './checks/cli';
import {
  checksCsv,
  checksJson,
  formatDate,
  reportMarkdown,
  reportTerminal,
  SUMMARY_MAX_BYTES,
  trimSummary,
} from './checks/report';
import type { ReportHeader } from './checks/report';
import {
  checkSet,
  derivedReads,
  derivedUnits,
  evaluate,
  exitCodeOf,
  NIGHTLY_SESSIONS,
  PR_SESSIONS,
} from './checks/run';
import type { CheckSetOptions, RunJobs } from './checks/run';
import type { CheckPlan, PlanUnit, UnitResults } from './checks/types';
import { formatContentRef, parseContentRef, resolveContent } from './content';
import type { ContentRef, ScopeName } from './content';
import { MEASURE_IDS } from './measures';

/** The sets the nightly runs: the weekly is the nightly with the triples. */
export type NightlySet = 'nightly' | 'weekly';

export const SHARD_KINDS = ['sessions', 'probes', 'doubles', 'triples', 'm1', 'fuzz'] as const;
export type ShardKind = (typeof SHARD_KINDS)[number];

/** A shard of the plan: `<c>-<kind>` for a character's, `global-<kind>` for the rest. */
export interface ShardSpec {
  readonly id: string;
  readonly kind: ShardKind;
  readonly character?: CharacterId;
  /** The triples' part [i, n]: every n-th of the character's triple units from i. */
  readonly part?: readonly [number, number];
}

/** Plan JSON v1 (design §1.6), what nightly.yml's plan job turns into the shard matrix. */
export interface PlanJson {
  readonly version: 1;
  readonly set: NightlySet;
  readonly quick: boolean;
  readonly content: string;
  readonly commit: string;
  readonly fuzzSeed: number;
  readonly shards: readonly ShardSpec[];
}

/** The Plan JSON, units.json and meta.json version this nightly writes and reads, and no other. */
export const NIGHTLY_VERSION = 1;
/**
 * Parts the weekly's triples of each character are split in (初始值): 165 × 16 runs ≤ 72,000
 * ticks (calibrate.ts' PROBE_MAX_TICKS) take 7–24 min on 4 cores at 9–30 µs a tick (C6AB:426), so
 * one part each; 18 weekly jobs stay under 20 concurrent (G3).
 */
export const TRIPLE_PARTS = 1;
/** A shard's target wall time in minutes (初始值): far under GitHub's 6 h a job (G3); never gated. */
export const SHARD_TARGET_MINUTES = 45;
/**
 * The scopes the nightly's sessions play (初始值): checkSet's `full` until B2 adds `demoA` for the
 * Demo's wave-40 pacing rows (design §3.2).
 */
export const NIGHTLY_SCOPES: readonly ScopeName[] = ['full'];

const NIGHTLY_SETS: readonly NightlySet[] = ['nightly', 'weekly'];

/**
 * The fuzz's seed for `commit` (design §1.6): WEB_FUZZ_SEED plus the commit's first six hex
 * digits, so the nightly draws builds CI's fuzz:web did not; WEB_FUZZ_SEED when the commit is
 * unread (not hex).
 */
export const fuzzSeedOf = (commit: string): number =>
  /^[0-9a-f]{6}/i.test(commit) ? WEB_FUZZ_SEED + parseInt(commit.slice(0, 6), 16) : WEB_FUZZ_SEED;

/** Part [i, n] of `items`: every n-th item from index i. */
export const partOf = <T>(items: readonly T[], i: number, n: number): T[] =>
  items.filter((_, index) => index % n === i);

/** The shard kind a unit runs in: a session, or the measure's. */
export function shardKindOf(unit: PlanUnit): ShardKind {
  const { job } = unit;
  if (job.kind === 'character') return 'sessions';
  if (job.kind !== 'measure')
    throw new Error(`Unit '${unit.id}': no shard runs a '${job.kind}' job`);
  switch (job.measure) {
    case 'double':
      return 'doubles';
    case 'triple':
      return 'triples';
    case 'm1':
      return 'm1';
    case 'fuzz':
      return 'fuzz';
    default:
      return 'probes';
  }
}

/** The character a unit measures, or null for the global ones (m1, fuzz). */
export function unitCharacter(unit: PlanUnit): CharacterId | null {
  const { job } = unit;
  if (job.kind === 'character') return job.config.character;
  if (job.kind !== 'measure') return null;
  const input = job.input as { readonly character?: CharacterId; readonly key?: string };
  if (input.character !== undefined) return input.character;
  if (input.key !== undefined) return input.key.split('.')[0] as CharacterId;
  return null;
}

/** A plan: its JSON, the checks' plan and each shard's first-phase units by shard id. */
export interface NightlyPlan {
  readonly json: PlanJson;
  readonly checks: CheckPlan;
  readonly units: ReadonlyMap<string, readonly PlanUnit[]>;
}

export interface NightlyOptions {
  readonly set: NightlySet;
  readonly quick: boolean;
  readonly content: ContentRef;
  readonly commit: string;
  /** Test seams: checkSet's options; quick and the fuzz seed are the plan's. */
  readonly checks?: CheckSetOptions | undefined;
}

/** The plan's shards in order, and each one's first-phase units by shard id. */
export interface PlanShards {
  readonly shards: readonly ShardSpec[];
  readonly units: ReadonlyMap<string, readonly PlanUnit[]>;
}

/**
 * The shards of `checks` (design §1.6), only those with units: per character `<c>-sessions`
 * (every strategy's sessions), `<c>-probes` (strength and the mirrors, and the second phase's
 * measures, which read the character's sessions: lead ruling U11), `<c>-doubles`, in the weekly
 * `<c>-triples` in TRIPLE_PARTS parts; then `global-m1` and `global-fuzz`. Every first-phase unit
 * is in exactly one shard.
 */
export function planShards(checks: CheckPlan): PlanShards {
  const shards: ShardSpec[] = [];
  const units = new Map<string, readonly PlanUnit[]>();
  const add = (spec: ShardSpec, of: readonly PlanUnit[]): void => {
    shards.push(spec);
    units.set(spec.id, of);
  };
  const ofKind = (kind: ShardKind, character: CharacterId | null): PlanUnit[] =>
    checks.units.filter((unit) => shardKindOf(unit) === kind && unitCharacter(unit) === character);
  for (const character of checks.characters) {
    const sessions = ofKind('sessions', character);
    if (sessions.length > 0)
      add({ id: `${character}-sessions`, kind: 'sessions', character }, sessions);
    const probes = ofKind('probes', character);
    const reads = derivedReads(checks, character);
    if (probes.length > 0 || reads.sessions.length > 0 || reads.whole.length > 0) {
      add({ id: `${character}-probes`, kind: 'probes', character }, probes);
    }
    const doubles = ofKind('doubles', character);
    if (doubles.length > 0)
      add({ id: `${character}-doubles`, kind: 'doubles', character }, doubles);
    const triples = ofKind('triples', character);
    for (let i = 0; i < TRIPLE_PARTS; i++) {
      const part = partOf(triples, i, TRIPLE_PARTS);
      if (part.length === 0) continue;
      const id = TRIPLE_PARTS === 1 ? `${character}-triples` : `${character}-triples-${i}`;
      add({ id, kind: 'triples', character, part: [i, TRIPLE_PARTS] }, part);
    }
  }
  for (const kind of ['m1', 'fuzz'] as const) {
    const global = ofKind(kind, null);
    if (global.length > 0) add({ id: `global-${kind}`, kind }, global);
  }
  const assigned = [...units.values()].reduce((sum, of) => sum + of.length, 0);
  if (assigned !== checks.units.length) {
    throw new Error(`The shards hold ${assigned} of the plan's ${checks.units.length} units`);
  }
  return { shards, units };
}

/** The plan (design §1.6): the set's checks (checkSet) at the commit's fuzzSeed, and its shards. */
export function nightlyPlan(options: NightlyOptions): NightlyPlan {
  const fuzzSeed = fuzzSeedOf(options.commit);
  const checks = checkSet(options.set, resolveContent(options.content), options.content, {
    ...options.checks,
    quick: options.quick,
    fuzzSeed,
  });
  const { shards, units } = planShards(checks);
  return {
    json: {
      version: NIGHTLY_VERSION,
      set: options.set,
      quick: options.quick,
      content: formatContentRef(options.content),
      commit: options.commit,
      fuzzSeed,
      shards,
    },
    checks,
    units,
  };
}

// ---- Plain data, exactly ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const NUMBER_TAG = '$number';
const UNDEFINED_TAG = '$undefined';

/** A data key starting with '$' gains one more, so no data reads as a tag; decoding drops it. */
const escapeKey = (key: string): string => (key.startsWith('$') ? `$${key}` : key);
const unescapeKey = (key: string): string => (key.startsWith('$$') ? key.slice(1) : key);

/**
 * JSON that keeps what JSON.stringify loses: ±Infinity, NaN and −0 (a session's "never" is ∞)
 * and undefined fields, each as a one-key tag object; decodeExact gives the value back.
 */
export const encodeExact = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) => {
    if (typeof field === 'number' && (!Number.isFinite(field) || Object.is(field, -0))) {
      return { [NUMBER_TAG]: Object.is(field, -0) ? '-0' : String(field) };
    }
    if (field === undefined) return { [UNDEFINED_TAG]: true };
    if (isRecord(field) && Object.keys(field).some((key) => key.startsWith('$'))) {
      return Object.fromEntries(Object.entries(field).map(([key, at]) => [escapeKey(key), at]));
    }
    return field;
  });

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === NUMBER_TAG && typeof record[NUMBER_TAG] === 'string') {
    return Number(record[NUMBER_TAG]);
  }
  if (keys.length === 1 && keys[0] === UNDEFINED_TAG && record[UNDEFINED_TAG] === true) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    Object.defineProperty(out, unescapeKey(key), {
      value: revive(record[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** encodeExact's text as the value it encoded. */
export const decodeExact = (text: string): unknown => revive(JSON.parse(text) as unknown);

// ---- Plan JSON ----

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) throw new Error(`${what}: unknown field ${extra.join(', ')}`);
}

/** The plan as JSON, one line per field: what `--plan --json` prints. */
export const formatPlanJson = (json: PlanJson): string => JSON.stringify(json, null, 2);

/**
 * Plan JSON v1 read back, exactly the shape §1.6 gives: any other version, a missing or unknown
 * field, an unknown shard kind or character, or a bad part is refused.
 */
export function parsePlanJson(text: string): PlanJson {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('nightly plan: not a JSON object');
  if (value.version !== NIGHTLY_VERSION) {
    throw new Error(
      `nightly plan: version ${JSON.stringify(value.version)}; this nightly reads version ` +
        `${NIGHTLY_VERSION}`,
    );
  }
  onlyKeys(
    value,
    ['version', 'set', 'quick', 'content', 'commit', 'fuzzSeed', 'shards'],
    'nightly plan',
  );
  const { set, quick, content, commit, fuzzSeed, shards } = value;
  if (!NIGHTLY_SETS.includes(set as NightlySet))
    throw new Error(`nightly plan: set ${String(set)}`);
  if (typeof quick !== 'boolean') throw new Error('nightly plan: quick is not a boolean');
  if (typeof content !== 'string') throw new Error('nightly plan: content is not a string');
  parseContentRef(content);
  if (typeof commit !== 'string') throw new Error('nightly plan: commit is not a string');
  if (!Number.isSafeInteger(fuzzSeed)) throw new Error('nightly plan: fuzzSeed is not an integer');
  if (!Array.isArray(shards)) throw new Error('nightly plan: shards is not a list');
  const specs = shards.map((shard: unknown, index): ShardSpec => {
    const what = `nightly plan: shard ${index}`;
    if (!isRecord(shard)) throw new Error(`${what} is not an object`);
    onlyKeys(shard, ['id', 'kind', 'character', 'part'], what);
    const { id, kind, character, part } = shard;
    if (typeof id !== 'string' || id === '') throw new Error(`${what}: id is not a string`);
    if (!SHARD_KINDS.includes(kind as ShardKind)) throw new Error(`${what}: kind ${String(kind)}`);
    if (character !== undefined && !CHARACTER_IDS.includes(character as CharacterId)) {
      throw new Error(`${what}: character ${String(character)}`);
    }
    if (
      part !== undefined &&
      !(
        Array.isArray(part) &&
        part.length === 2 &&
        part.every(Number.isSafeInteger) &&
        (part[0] as number) >= 0 &&
        (part[0] as number) < (part[1] as number)
      )
    ) {
      throw new Error(`${what}: part ${JSON.stringify(part)}`);
    }
    return {
      id,
      kind: kind as ShardKind,
      ...(character === undefined ? {} : { character: character as CharacterId }),
      ...(part === undefined ? {} : { part: [part[0] as number, part[1] as number] as const }),
    };
  });
  return {
    version: NIGHTLY_VERSION,
    set: set as NightlySet,
    quick,
    content,
    commit,
    fuzzSeed: fuzzSeed as number,
    shards: specs,
  };
}

// ---- Shards ----

/** One unit as a shard records it: its job, its result, and whether it is a second-phase unit. */
export interface RecordedUnit {
  readonly id: string;
  readonly derived: boolean;
  readonly job: BalanceJob;
  readonly result: JobResult;
}

export interface ShardRun {
  readonly spec: ShardSpec;
  readonly units: readonly RecordedUnit[];
  /** The sessions a probes shard replayed for its second phase (lead ruling U11), and their time. */
  readonly replayed: readonly string[];
  readonly replaySeconds: number;
  readonly seconds: number;
  /** How each pool call ran: 'in-process' or 'k workers'. */
  readonly modes: readonly string[];
}

/** The plan's unit `id`; throws when it has none. */
function planUnit(plan: CheckPlan, id: string): PlanUnit {
  const unit = plan.units.find((candidate) => candidate.id === id);
  if (unit === undefined) throw new Error(`No unit '${id}' in the plan`);
  return unit;
}

/**
 * The session results derivedUnits reads for `character`'s units (derivedReads), replayed from
 * the plan's own session units (lead ruling U11): the first character's sessions read whole by
 * the legacy units, and the character's default sessions in index order, `workers` at a time,
 * until every snapshot it reads is held, since derivedUnits takes each snapshot from the
 * lowest-index session holding it.
 */
async function replaySessions(
  plan: CheckPlan,
  character: CharacterId,
  workers: number,
  log: (message: string) => void,
  run: RunJobs,
  modes: string[],
): Promise<Record<string, JobResult>> {
  const reads = derivedReads(plan, character);
  const results: Record<string, JobResult> = {};
  const play = async (ids: readonly string[]): Promise<void> => {
    if (ids.length === 0) return;
    const pool = await run(
      ids.map((id) => planUnit(plan, id).job),
      workers,
      log,
    );
    ids.forEach((id, index) => {
      results[id] = pool.results[index] as JobResult;
    });
    modes.push(pool.mode === 'workers' ? `${pool.workers} workers` : 'in-process');
  };
  const held = (): boolean =>
    reads.snapshots.every((minutes) =>
      reads.sessions.some((id) => {
        const result = results[id];
        return (
          result?.kind === 'character' &&
          result.result.snapshots.some((snapshot) => snapshot.minutes === minutes)
        );
      }),
    );
  await play(reads.whole);
  const batch = Math.max(1, workers);
  for (let next = 0; next < reads.sessions.length && !held(); next += batch) {
    await play(reads.sessions.slice(next, next + batch));
  }
  return results;
}

/**
 * Runs shard `spec` of the plan: its first-phase units, and for `<c>-probes` the second phase's
 * units of c, derived from the replayed sessions exactly as runPlan derives them; on up to
 * `workers` workers. The replayed sessions are not recorded: they are `<c>-sessions`' results.
 */
export async function runShard(
  nightly: NightlyPlan,
  spec: ShardSpec,
  workers: number,
  log: (message: string) => void = () => {},
  run: RunJobs = runJobs,
  clock: () => number = () => performance.now(),
): Promise<ShardRun> {
  const started = clock();
  const own = nightly.units.get(spec.id);
  if (own === undefined) throw new Error(`No shard '${spec.id}' in the plan`);
  const modes: string[] = [];
  let derived: PlanUnit[] = [];
  let replayed: string[] = [];
  let replaySeconds = 0;
  if (spec.kind === 'probes' && spec.character !== undefined) {
    const character = spec.character;
    const replayStarted = clock();
    const replay = await replaySessions(nightly.checks, character, workers, log, run, modes);
    replaySeconds = (clock() - replayStarted) / 1000;
    replayed = Object.keys(replay);
    derived = derivedUnits(nightly.checks, replay).filter(
      (unit) => unitCharacter(unit) === character,
    );
  }
  const units = [...own, ...derived];
  const results: JobResult[] = [];
  if (units.length > 0) {
    const pool = await run(
      units.map((unit) => unit.job),
      workers,
      log,
    );
    results.push(...pool.results);
    modes.push(pool.mode === 'workers' ? `${pool.workers} workers` : 'in-process');
  }
  return {
    spec,
    units: units.map((unit, index) => ({
      id: unit.id,
      derived: index >= own.length,
      job: unit.job,
      result: results[index] as JobResult,
    })),
    replayed,
    replaySeconds,
    seconds: (clock() - started) / 1000,
    modes,
  };
}

/** A shard's meta.json: what ran it, on what, and how long it took. */
export interface ShardMeta {
  readonly version: 1;
  readonly shard: string;
  readonly kind: ShardKind;
  readonly character?: CharacterId;
  readonly part?: readonly [number, number];
  readonly ref: string;
  readonly commit: string;
  readonly content: string;
  readonly set: NightlySet;
  readonly quick: boolean;
  readonly seconds: number;
  readonly units: number;
  readonly derived: number;
  readonly replayed: readonly string[];
  readonly replaySeconds: number;
  readonly modes: readonly string[];
}

const tenths = (seconds: number): number => Number(seconds.toFixed(1));

/** A shard's directory under `dir`. */
export const shardDir = (dir: string, id: string): string => join(dir, 'shards', id);

/**
 * Writes a shard's files under `dir`/shards/<id>/, replacing what was there: units.json, its CSV
 * fragments (the outputs its own results fill, for inspection; the merge never reads them) and
 * meta.json, last, so a shard cut short has none.
 */
export function writeShard(dir: string, nightly: NightlyPlan, shard: ShardRun, ref: string): void {
  const into = shardDir(dir, shard.spec.id);
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  writeFileSync(
    join(into, 'units.json'),
    encodeExact({
      version: NIGHTLY_VERSION,
      shard: shard.spec.id,
      kind: shard.spec.kind,
      units: shard.units,
    }) + '\n',
  );
  const own: Record<string, JobResult> = {};
  for (const unit of shard.units) own[unit.id] = unit.result;
  for (const [name, text] of planOutputs(nightly.checks, own)) {
    if (text.trimEnd().includes('\n')) writeFileSync(join(into, name), text);
  }
  const meta: ShardMeta = {
    version: NIGHTLY_VERSION,
    shard: shard.spec.id,
    kind: shard.spec.kind,
    ...(shard.spec.character === undefined ? {} : { character: shard.spec.character }),
    ...(shard.spec.part === undefined ? {} : { part: shard.spec.part }),
    ref,
    commit: nightly.json.commit,
    content: nightly.json.content,
    set: nightly.json.set,
    quick: nightly.json.quick,
    seconds: tenths(shard.seconds),
    units: shard.units.length,
    derived: shard.units.filter((unit) => unit.derived).length,
    replayed: shard.replayed,
    replaySeconds: tenths(shard.replaySeconds),
    modes: shard.modes,
  };
  writeFileSync(join(into, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

// ---- The merge ----

const JOB_KINDS: readonly string[] = ['m1', 'character', 'measure'];

/** A shard file's meta.json, read: the fields the merge compares, or why it is refused. */
function readMeta(dir: string, id: string): ShardMeta | string {
  let text: string;
  try {
    text = readFileSync(join(shardDir(dir, id), 'meta.json'), 'utf8');
  } catch {
    return `shard ${id} is missing: no ${join('shards', id, 'meta.json')}`;
  }
  let meta: unknown;
  try {
    meta = JSON.parse(text);
  } catch (error) {
    return `shard ${id}: meta.json is not JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!isRecord(meta)) return `shard ${id}: meta.json is not an object`;
  if (meta.version !== NIGHTLY_VERSION) {
    return `shard ${id}: meta.json version ${JSON.stringify(meta.version)}; this nightly reads version ${NIGHTLY_VERSION}`;
  }
  if (meta.shard !== id) return `shard ${id}: meta.json names shard ${JSON.stringify(meta.shard)}`;
  if (
    !SHARD_KINDS.includes(meta.kind as ShardKind) ||
    typeof meta.commit !== 'string' ||
    typeof meta.content !== 'string' ||
    !NIGHTLY_SETS.includes(meta.set as NightlySet) ||
    typeof meta.quick !== 'boolean' ||
    typeof meta.seconds !== 'number'
  ) {
    return `shard ${id}: meta.json is not a shard's meta`;
  }
  return meta as unknown as ShardMeta;
}

/** Why a recorded unit's kinds are refused (lead ruling U14), or null when they are known. */
function unknownKind(unit: Record<string, unknown>): string | null {
  const { job, result } = unit;
  if (!isRecord(job) || !isRecord(result)) return 'no job or no result';
  if (!JOB_KINDS.includes(job.kind as string)) return `an unknown job kind '${String(job.kind)}'`;
  if (result.kind !== job.kind)
    return `a '${String(result.kind)}' result for a '${String(job.kind)}' job`;
  if (job.kind !== 'measure') return null;
  if (!(MEASURE_IDS as readonly unknown[]).includes(job.measure)) {
    return `an unknown measure '${String(job.measure)}'`;
  }
  return result.measure === job.measure
    ? null
    : `a '${String(result.measure)}' reading for a '${String(job.measure)}' measure`;
}

/** A shard's units.json, read: its units, or why it is refused (an unknown version or kind). */
function readUnits(dir: string, spec: ShardSpec): RecordedUnit[] | string {
  let text: string;
  try {
    text = readFileSync(join(shardDir(dir, spec.id), 'units.json'), 'utf8');
  } catch {
    return `shard ${spec.id} is missing: no ${join('shards', spec.id, 'units.json')}`;
  }
  let file: unknown;
  try {
    file = decodeExact(text);
  } catch (error) {
    return `shard ${spec.id}: units.json is not JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!isRecord(file)) return `shard ${spec.id}: units.json is not an object`;
  if (file.version !== NIGHTLY_VERSION) {
    return `shard ${spec.id}: units.json version ${JSON.stringify(file.version)}; this nightly reads version ${NIGHTLY_VERSION}`;
  }
  if (file.shard !== spec.id || file.kind !== spec.kind) {
    return `shard ${spec.id}: units.json holds shard ${JSON.stringify(file.shard)} of kind ${JSON.stringify(file.kind)}`;
  }
  if (!Array.isArray(file.units)) return `shard ${spec.id}: units.json has no unit list`;
  const units: RecordedUnit[] = [];
  for (const unit of file.units as unknown[]) {
    if (!isRecord(unit) || typeof unit.id !== 'string' || typeof unit.derived !== 'boolean') {
      return `shard ${spec.id}: units.json holds a unit without an id`;
    }
    const why = unknownKind(unit);
    if (why !== null) return `shard ${spec.id}: unit ${unit.id} has ${why}`;
    units.push(unit as unknown as RecordedUnit);
  }
  return units;
}

/** What the merge read: the plan and every result, or the errors that refuse it (exit 1). */
export type MergeRead =
  | {
      readonly ok: true;
      readonly nightly: NightlyPlan;
      readonly results: UnitResults;
      readonly metas: readonly ShardMeta[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface MergeOptions {
  /** The merge's own commit: every shard must have run on it; 'unknown' takes the shards'. */
  readonly commit: string;
  readonly checks?: CheckSetOptions | undefined;
}

/**
 * Reads `dir`'s shards against the plan they name (design §1.6; lead rulings U11, U13, U14):
 * the set, --quick, the content and the commit from their meta.json, all the same and the commit
 * the merge's own; then the plan's shards in the plan's order, each present and readable (a
 * missing one is named), no shard outside the plan, a result for every plan unit and only for
 * the plan's units, and the second-phase units the probes shards ran exactly those derivedUnits
 * gives on the merged sessions, with JSON-identical inputs.
 */
export function readShards(dir: string, options: MergeOptions): MergeRead {
  let found: string[];
  try {
    found = readdirSync(join(dir, 'shards')).sort();
  } catch {
    return { ok: false, errors: [`no shard in ${dir}: no ${join(dir, 'shards')}`] };
  }
  const metas = found.map((id) => readMeta(dir, id));
  const read = metas.filter((meta): meta is ShardMeta => typeof meta !== 'string');
  const [first] = read;
  if (first === undefined) {
    const why = metas.filter((meta): meta is string => typeof meta === 'string');
    return { ok: false, errors: [`no readable shard in ${dir}`, ...why] };
  }
  const commit = options.commit === 'unknown' ? first.commit : options.commit;
  const errors: string[] = [];
  for (const meta of read) {
    const differs = (['content', 'set', 'quick'] as const).filter(
      (key) => meta[key] !== first[key],
    );
    if (differs.length > 0) {
      errors.push(
        `shard ${meta.shard} ran ${differs.map((key) => `${key} ${String(meta[key])}`).join(', ')}; ` +
          `shard ${first.shard} ran ${differs.map((key) => `${key} ${String(first[key])}`).join(', ')}`,
      );
    }
    if (meta.commit !== commit) {
      errors.push(`shard ${meta.shard} ran on commit ${meta.commit}; the merge is on ${commit}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const nightly = nightlyPlan({
    set: first.set,
    quick: first.quick,
    content: parseContentRef(first.content),
    commit,
    checks: options.checks,
  });
  const planned = new Set(nightly.json.shards.map((spec) => spec.id));
  for (const id of found) {
    if (!planned.has(id)) errors.push(`shard ${id} is not in the plan`);
  }
  const results: Record<string, JobResult> = {};
  const from = new Map<string, string>();
  const derived = new Map<string, { readonly shard: string; readonly job: BalanceJob }>();
  const used: ShardMeta[] = [];
  for (const spec of nightly.json.shards) {
    const meta = readMeta(dir, spec.id);
    if (typeof meta === 'string') {
      errors.push(meta);
      continue;
    }
    const units = readUnits(dir, spec);
    if (typeof units === 'string') {
      errors.push(units);
      continue;
    }
    used.push(meta);
    const own = new Map((nightly.units.get(spec.id) ?? []).map((unit) => [unit.id, unit]));
    for (const unit of units) {
      if (from.has(unit.id)) {
        errors.push(
          `unit ${unit.id} comes from shard ${from.get(unit.id) ?? '?'} and shard ${spec.id}`,
        );
        continue;
      }
      if (unit.derived) {
        if (spec.kind !== 'probes') {
          errors.push(`shard ${spec.id} holds a second-phase unit ${unit.id}`);
          continue;
        }
        derived.set(unit.id, { shard: spec.id, job: unit.job });
      } else {
        const planUnitOf = own.get(unit.id);
        if (planUnitOf === undefined) {
          errors.push(`unit ${unit.id} from shard ${spec.id} is not one of its planned units`);
          continue;
        }
        if (encodeExact(unit.job) !== encodeExact(planUnitOf.job)) {
          errors.push(`unit ${unit.id} from shard ${spec.id} ran other inputs than the plan's`);
          continue;
        }
      }
      from.set(unit.id, spec.id);
      results[unit.id] = unit.result;
    }
  }
  for (const spec of nightly.json.shards) {
    for (const unit of nightly.units.get(spec.id) ?? []) {
      if (!(unit.id in results)) errors.push(`unit ${unit.id} of shard ${spec.id} has no result`);
    }
  }
  const expected = derivedUnits(nightly.checks, results);
  const ids = new Set(expected.map((unit) => unit.id));
  for (const unit of expected) {
    const ran = derived.get(unit.id);
    const shard = `${unitCharacter(unit) ?? 'global'}-probes`;
    if (ran === undefined) {
      errors.push(`second-phase unit ${unit.id} of shard ${shard} has no result`);
    } else if (encodeExact(ran.job) !== encodeExact(unit.job)) {
      errors.push(
        `second-phase unit ${unit.id}: shard ${ran.shard} ran other inputs than the merged sessions give`,
      );
    }
  }
  for (const [id, ran] of derived) {
    if (!ids.has(id)) {
      errors.push(
        `second-phase unit ${id} from shard ${ran.shard} is not one the merged sessions give`,
      );
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, nightly, results, metas: used };
}

// ---- The CLI ----

const DEFAULT_OUT = join('out', 'nightly');

const HELP = `Usage: npm run nightly -- [options]

implementation-plan-v3 §4's nightly and weekly checks, in shards (.github/workflows/nightly.yml):

  (no mode)          plan, run every shard into <out>/shards/, merge into <out> (default ${DEFAULT_OUT})
  --plan             print the plan: its shards and their units; --json prints Plan JSON v${NIGHTLY_VERSION}
  --shard <id>       run one shard of the plan into <out>/shards/<id>/
  --merge <dir>      merge <dir>/shards/ into <out>: report.md, checks.json, checks.csv, summary.md, CSVs

  --weekly           the weekly set: the nightly with the triples
  --quick            ${PR_SESSIONS} default sessions a character, not ${NIGHTLY_SESSIONS}
  --content <c>      registered | fixture | fixture:<B1..B5> (default registered); not with --merge,
                     which reads the set, --quick and the content from the shards
  --out <dir>        output directory (required with --shard and --merge)
  --summary <file>   append report.md, cut to ${SUMMARY_MAX_BYTES} bytes ($GITHUB_STEP_SUMMARY in CI)
  --workers <k>      worker threads (default min(4, CPUs))
  --help             show this help

Exit codes: 0 no unaccepted FAIL (n/a and info never fail), 1 an unaccepted FAIL or a missing,
foreign or unreadable shard, 2 usage, 3 a crash. A shard exits 0 once its files are written.`;

export type NightlyMode = 'local' | 'plan' | 'shard' | 'merge';

export interface NightlyArgs {
  readonly mode: NightlyMode;
  readonly set: NightlySet;
  readonly quick: boolean;
  readonly content: ContentRef;
  readonly json: boolean;
  /** --shard's id, --merge's directory. */
  readonly shard: string | null;
  readonly merge: string | null;
  readonly out: string;
  readonly summary: string | null;
  readonly workers: number;
}

/** Parses the arguments; null for --help. Throws on invalid input. */
export function parseNightlyArgs(argv: readonly string[]): NightlyArgs | null {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      plan: { type: 'boolean', default: false },
      shard: { type: 'string' },
      merge: { type: 'string' },
      weekly: { type: 'boolean', default: false },
      quick: { type: 'boolean', default: false },
      content: { type: 'string' },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
      summary: { type: 'string' },
      workers: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return null;
  const modes = [
    ...(values.plan ? ['--plan'] : []),
    ...(values.shard !== undefined ? ['--shard'] : []),
    ...(values.merge !== undefined ? ['--merge'] : []),
  ];
  if (modes.length > 1) throw new Error(`${modes.join(' and ')} cannot run together`);
  const mode: NightlyMode = values.plan
    ? 'plan'
    : values.shard !== undefined
      ? 'shard'
      : values.merge !== undefined
        ? 'merge'
        : 'local';
  const refuse = (flag: string, given: boolean): void => {
    if (given)
      throw new Error(
        `${flag} does not apply to ${mode === 'local' ? 'a local run' : `--${mode}`}`,
      );
  };
  refuse('--json', values.json && mode !== 'plan');
  refuse('--out', values.out !== undefined && mode === 'plan');
  refuse('--summary', values.summary !== undefined && (mode === 'plan' || mode === 'shard'));
  refuse('--weekly', values.weekly && mode === 'merge');
  refuse('--quick', values.quick && mode === 'merge');
  refuse('--content', values.content !== undefined && mode === 'merge');
  if ((mode === 'shard' || mode === 'merge') && values.out === undefined) {
    throw new Error(`--${mode} needs --out <dir>`);
  }
  if (values.shard !== undefined && values.shard.trim() === '')
    throw new Error('--shard needs an id');
  if (values.merge !== undefined && values.merge.trim() === '')
    throw new Error('--merge needs a directory');
  let workers = Math.max(1, Math.min(4, availableParallelism()));
  if (values.workers !== undefined) {
    workers = Number(values.workers);
    if (values.workers.trim() === '' || !Number.isInteger(workers) || workers < 1) {
      throw new Error(`--workers must be an integer >= 1, got '${values.workers}'`);
    }
  }
  return {
    mode,
    set: values.weekly ? 'weekly' : 'nightly',
    quick: values.quick,
    content: parseContentRef(values.content ?? 'registered'),
    json: values.json,
    shard: values.shard ?? null,
    merge: values.merge ?? null,
    out: values.out ?? DEFAULT_OUT,
    summary: values.summary ?? null,
    workers,
  };
}

/**
 * The checked-out commit: `git rev-parse HEAD`, since under workflow_dispatch GITHUB_SHA names the
 * workflow's ref and not the `ref` input checked out; else GITHUB_SHA; else 'unknown'.
 */
export function readHead(): string {
  const head = fromGit(undefined, ['rev-parse', 'HEAD']);
  return head === 'unknown' ? fromGit(process.env.GITHUB_SHA, ['rev-parse', 'HEAD']) : head;
}

/** The checked-out branch (actions/checkout makes one for a branch ref), else checks/cli's readRef. */
export function readCheckedOutRef(): string {
  const branch = fromGit(undefined, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch === 'unknown' || branch === 'HEAD' ? readRef() : branch;
}

/** What main reads from the world; tests pass their own. */
export interface NightlyDeps {
  /** checkSet's options in place of its defaults (quick and the fuzz seed are the plan's). */
  readonly checks?: CheckSetOptions;
  readonly run?: RunJobs;
  readonly now?: () => Date;
  /** Milliseconds, for the wall times. */
  readonly clock?: () => number;
  readonly commit?: () => string;
  readonly ref?: () => string;
}

const CONSOLE: CliIo = {
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/** The errors the merge stopped on, cut to the first ERRORS_SHOWN. */
const ERRORS_SHOWN = 50;

const errorLines = (errors: readonly string[]): string[] => [
  ...errors.slice(0, ERRORS_SHOWN),
  ...(errors.length > ERRORS_SHOWN ? [`… and ${errors.length - ERRORS_SHOWN} more`] : []),
];

/** The plan as the terminal prints it: one line per shard with its units. */
function planText(nightly: NightlyPlan): string {
  const { json } = nightly;
  return [
    `nightly plan v${json.version}: ${json.set}${json.quick ? ' (quick)' : ''} on ${json.content}, ` +
      `commit ${json.commit}, fuzzSeed ${json.fuzzSeed}, scopes ${NIGHTLY_SCOPES.join(', ')}`,
    ...json.shards.map(
      (spec) =>
        `  ${spec.id}: ${spec.kind}, ${nightly.units.get(spec.id)?.length ?? 0} units` +
        (spec.kind === 'probes' ? ' and the second phase' : '') +
        (spec.part === undefined ? '' : `, part [${spec.part[0]}, ${spec.part[1]}]`),
    ),
  ].join('\n');
}

/** Merges `dir`'s shards into `out` and reports; resolves to the exit code. */
async function merge(
  dir: string,
  args: Pick<NightlyArgs, 'out' | 'summary'>,
  io: CliIo,
  deps: NightlyDeps,
): Promise<number> {
  const commit = (deps.commit ?? readHead)();
  const read = readShards(dir, { commit, checks: deps.checks });
  if (!read.ok) {
    io.error(`The merge stopped: ${read.errors.length} problems with ${dir}'s shards`);
    for (const line of errorLines(read.errors)) io.error(`  ${line}`);
    if (args.summary !== null) {
      appendFileSync(
        args.summary,
        trimSummary(
          [
            '# §4 checks: the merge stopped',
            '',
            ...errorLines(read.errors).map((line) => `- ${line}`),
          ].join('\n') + '\n',
        ),
      );
    }
    return 1;
  }
  const { nightly, results, metas } = read;
  const plan = nightly.checks;
  const rows = evaluate(plan, results);
  const header: ReportHeader = {
    ref: (deps.ref ?? readCheckedOutRef)(),
    commit: nightly.json.commit,
    date: formatDate((deps.now ?? (() => new Date()))()),
    wallSeconds: metas.reduce((sum, meta) => sum + meta.seconds, 0),
  };
  const outputs = planOutputs(plan, results);
  const files = [
    'report.md',
    'checks.json',
    'checks.csv',
    'summary.md',
    ...outputs.map(([name]) => name),
  ];
  const markdown = reportMarkdown(header, plan, rows, files);
  const summary = trimSummary(markdown);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'report.md'), markdown);
  writeFileSync(join(args.out, 'checks.json'), checksJson(header, plan, rows));
  writeFileSync(join(args.out, 'checks.csv'), checksCsv(rows));
  writeFileSync(join(args.out, 'summary.md'), summary);
  for (const [name, text] of outputs) writeFileSync(join(args.out, name), text);
  if (args.summary !== null) appendFileSync(args.summary, summary);
  io.log(
    `Shards: ${metas
      .map(
        (meta) =>
          `${meta.shard} ${meta.seconds} s` +
          (meta.replayed.length > 0
            ? ` (${meta.replaySeconds} s replaying ${meta.replayed.length} sessions)`
            : ''),
      )
      .join(', ')}`,
  );
  io.log(reportTerminal(header, plan, rows, files, args.out));
  return exitCodeOf(rows);
}

/** Runs one shard of the plan into `out` and says how long it took. */
async function shard(
  nightly: NightlyPlan,
  spec: ShardSpec,
  args: Pick<NightlyArgs, 'out' | 'workers'>,
  io: CliIo,
  deps: NightlyDeps,
): Promise<void> {
  const ran = await runShard(
    nightly,
    spec,
    args.workers,
    (message) => io.warn(message),
    deps.run,
    deps.clock,
  );
  writeShard(args.out, nightly, ran, (deps.ref ?? readCheckedOutRef)());
  const derived = ran.units.filter((unit) => unit.derived).length;
  io.warn(
    `shard ${spec.id}: ${ran.units.length} units` +
      (spec.kind === 'probes'
        ? ` (${derived} second-phase; ${ran.replayed.length} sessions replayed in ${tenths(ran.replaySeconds)} s)`
        : '') +
      ` in ${tenths(ran.seconds)} s on ${ran.modes.join(', ') || 'no pool'} ` +
      `(SHARD_TARGET_MINUTES ${SHARD_TARGET_MINUTES}: printed, never gated)`,
  );
}

/** The CLI: parses `argv` and runs its mode; resolves to the exit code. */
export async function main(
  argv: readonly string[],
  io: CliIo = CONSOLE,
  deps: NightlyDeps = {},
): Promise<number> {
  let args: NightlyArgs | null;
  try {
    args = parseNightlyArgs(argv);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error(`\n${HELP}`);
    return 2;
  }
  if (args === null) {
    io.log(HELP);
    return 0;
  }
  try {
    if (args.mode === 'merge') return await merge(args.merge as string, args, io, deps);
    const nightly = nightlyPlan({
      set: args.set,
      quick: args.quick,
      content: args.content,
      commit: (deps.commit ?? readHead)(),
      checks: deps.checks,
    });
    if (args.mode === 'plan') {
      io.log(args.json ? formatPlanJson(nightly.json) : planText(nightly));
      return 0;
    }
    if (args.mode === 'shard') {
      const spec = nightly.json.shards.find((candidate) => candidate.id === args.shard);
      if (spec === undefined) {
        io.error(
          `No shard '${String(args.shard)}' in the plan: ` +
            (nightly.json.shards.map((candidate) => candidate.id).join(', ') || 'none'),
        );
        return 2;
      }
      await shard(nightly, spec, args, io, deps);
      return 0;
    }
    io.warn(planText(nightly));
    rmSync(join(args.out, 'shards'), { recursive: true, force: true });
    for (const spec of nightly.json.shards) await shard(nightly, spec, args, io, deps);
    return await merge(args.out, args, io, deps);
  } catch (error) {
    io.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 3;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 3;
    },
  );
}
