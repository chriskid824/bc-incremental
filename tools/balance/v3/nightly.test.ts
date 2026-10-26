import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CalibrationEntry, Content } from '../../../src/data/web';
import { fixtureContent } from '../../../src/data/web/testing';
import { WEB_FUZZ_BUILDS, WEB_FUZZ_SEED } from '../../../src/meta/web/fuzz';
import { auditStart } from '../../../src/meta/web/invest';
import type { CliIo } from '../cli';
import type { BalanceJob, JobResult } from '../jobs';
import { DEAD_BOARD_MINUTES } from './checks/boards';
import { planOutputs } from './checks/cli';
import { comboName, DOUBLE_SEEDS, TRIPLE_SEEDS } from './checks/fusions';
import type { FuzzInput, FuzzReading } from './checks/fuzz';
import { m1UnitId, m1Units, PROBE_BASELINE } from './checks/m1';
import type { M1Input, M1Reading } from './checks/m1';
import { checksCsv } from './checks/report';
import { checkSet, derivedReads, derivedUnits, evaluate, exitCodeOf, runPlan } from './checks/run';
import type { RunJobs } from './checks/run';
import { BASE_C7, NO_C7, sessionResult, testWave } from './checks/testing';
import type { CheckResult } from './checks/types';
import { webOf } from './content';
import type {
  ComboInput,
  DeadBoardInput,
  EnemyRowInput,
  KeystoneInput,
  OuterRowInput,
} from './measures';
import {
  decodeExact,
  encodeExact,
  formatPlanJson,
  fuzzSeedOf,
  main,
  nightlyPlan,
  parseNightlyArgs,
  parsePlanJson,
  partOf,
  planShards,
  runShard,
  shardDir,
  TRIPLE_PARTS,
  unitCharacter,
} from './nightly';
import type { NightlyDeps, NightlySet, RecordedUnit } from './nightly';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BASELINE = readFileSync(join(REPO, PROBE_BASELINE), 'utf8');
/** A fixed commit: its first six hex digits seed the fuzz. */
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bc-nightly-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function capture(): CliIo & { readonly lines: string[] } {
  const lines: string[] = [];
  const push = (message: string): void => void lines.push(message);
  return { lines, log: push, warn: push, error: push };
}

const read = (dir: string, name: string): string => readFileSync(join(dir, name), 'utf8');

/**
 * A stub balance job: a default session holds the 30-min snapshot, and from session 1 on the
 * prestige point too, so a probes shard replays two sessions one worker at a time; another
 * strategy's session holds none; each measure reads numbers from its input.
 */
function answer(job: BalanceJob): JobResult {
  if (job.kind === 'character') {
    const { character, session, strategy, content } = job.config;
    const progress = auditStart(webOf(content, character, 'full'), false);
    const earned = { shards: 100 * (session + 1), cores: session + 1 };
    const snapshots =
      strategy !== 'default'
        ? []
        : [
            ...(session >= 1 ? [{ minutes: 'prestige' as const, progress, earned }] : []),
            { minutes: DEAD_BOARD_MINUTES, progress, earned },
          ];
    return {
      kind: 'character',
      result: sessionResult(character, session, { strategy, snapshots }),
    };
  }
  if (job.kind !== 'measure') throw new Error(`unexpected job ${job.kind}`);
  const parts = { bought: [], unpaid: [], refused: null };
  switch (job.measure) {
    case 'keystone': {
      const { character, star, seed } = job.input as KeystoneInput;
      const result = { character, star, seed, with: 15 + (seed % 3), without: 10, route: [] };
      return {
        kind: 'measure',
        measure: 'keystone',
        result: { ...result, refused: null, refunded: [] },
      };
    }
    case 'enemyRow': {
      const { character, column, answer: answered, seed } = job.input as EnemyRowInput;
      const run = testWave({ clearSeconds: 10 + seed });
      const result = { character, column, answer: answered, seed, node: null, purchases: [], run };
      return { kind: 'measure', measure: 'enemyRow', result: { ...result, refused: null } };
    }
    case 'outerRow': {
      const { character, outer, column, seed } = job.input as OuterRowInput;
      const result = {
        character,
        outer,
        column,
        seed,
        ...parts,
        run: testWave({ clearSeconds: 7 }),
      };
      return { kind: 'measure', measure: 'outerRow', result };
    }
    case 'deadBoard': {
      const { character, outer, seed } = job.input as DeadBoardInput;
      const result = { character, outer, seed, x: 30 + seed + (outer?.length ?? 0), ...parts };
      return { kind: 'measure', measure: 'deadBoard', result };
    }
    case 'double':
    case 'triple': {
      const { character, outers, seed } = job.input as ComboInput;
      const ratio = 1 + comboName(outers).length / 100 + seed / 1000;
      const result = { character, outers, seed, base: 10, with: 10 * ratio, ratio, refused: null };
      return { kind: 'measure', measure: job.measure, result };
    }
    case 'm1': {
      const { tool } = job.input as M1Input;
      const probe = tool === 'probe' ? BASELINE : null;
      const result: M1Reading = {
        tool,
        exitCode: 0,
        output: `${tool} ok`,
        json: probe,
        baseline: probe,
      };
      return { kind: 'measure', measure: 'm1', result };
    }
    case 'fuzz': {
      const { only } = job.input as FuzzInput;
      const result: FuzzReading = {
        name: only,
        runs: 2,
        ticks: 50,
        stopped: false,
        highestWaveCleared: 2,
        failures: [],
      };
      return { kind: 'measure', measure: 'fuzz', result };
    }
    default:
      throw new Error(`unexpected measure ${job.measure}`);
  }
}

/** A pool of `answer`s, recording each call's jobs. */
const stubPool =
  (calls: BalanceJob[][] = []): RunJobs =>
  (jobs, workers) => {
    calls.push([...jobs]);
    return Promise.resolve({
      results: jobs.map(answer),
      mode: workers > 1 ? 'workers' : 'in-process',
      workers,
      fallbackReason: null,
    });
  };

/** The world a test fixes: the stub pool, a clock that never moves, a date, the commit and a ref. */
const fixed = (overrides: NightlyDeps = {}): NightlyDeps => ({
  checks: { sessions: 2, c7: BASE_C7 },
  run: stubPool(),
  now: () => new Date(Date.UTC(2026, 9, 28, 19, 17)),
  clock: () => 0,
  commit: () => SHA,
  ref: () => 'main',
  ...overrides,
});

const planOf = (set: NightlySet, content: 'B1' | 'B2', deps = fixed()) =>
  nightlyPlan({
    set,
    quick: true,
    content: { fixture: content },
    commit: SHA,
    checks: deps.checks,
  });

/** Every shard of the quick nightly on `content`, run one by one into a directory. */
async function shardsOf(content: 'B1' | 'B2', set: NightlySet = 'nightly'): Promise<string> {
  const dir = join(root, `shards-${content}`);
  const args = [
    '--quick',
    '--content',
    `fixture:${content}`,
    ...(set === 'weekly' ? ['--weekly'] : []),
  ];
  for (const spec of planOf(set, content).json.shards) {
    expect(await main([...args, '--shard', spec.id, '--out', dir], capture(), fixed())).toBe(0);
  }
  return dir;
}

/** Rewrites a shard file through `change`, exactly encoded. */
function edit(
  dir: string,
  shard: string,
  name: string,
  change: (file: Record<string, unknown>) => unknown,
): void {
  const file = join(shardDir(dir, shard), name);
  writeFileSync(
    file,
    encodeExact(change(decodeExact(readFileSync(file, 'utf8')) as Record<string, unknown>)),
  );
}

let merges = 0;

/** A merge of `dir` into a fresh directory: its exit code, its lines and the directory. */
async function mergeOf(dir: string): Promise<{ code: number; lines: string[]; out: string }> {
  const io = capture();
  merges += 1;
  const out = join(root, `merged-${merges}`);
  const code = await main(['--merge', dir, '--out', out], io, fixed());
  return { code, lines: io.lines, out };
}

describe('the nightly plan', () => {
  it('deals part [i, n] every n-th unit from i, each unit in exactly one part, n = 1, 2, 3 (OWN 1)', () => {
    const units = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(partOf(units, 0, 1)).toEqual(units);
    expect([0, 1].map((i) => partOf(units, i, 2))).toEqual([
      ['a', 'c', 'e', 'g'],
      ['b', 'd', 'f'],
    ]);
    expect([0, 1, 2].map((i) => partOf(units, i, 3))).toEqual([
      ['a', 'd', 'g'],
      ['b', 'e'],
      ['c', 'f'],
    ]);
    for (const n of [1, 2, 3]) {
      const parts = Array.from({ length: n }, (_, i) => partOf(units, i, n));
      expect(parts.flat().sort()).toEqual(units);
    }
    expect(TRIPLE_PARTS).toBe(1);
  });

  it("seeds the fuzz at WEB_FUZZ_SEED + the commit's first six hex digits (OWN 6)", () => {
    expect(fuzzSeedOf(SHA)).toBe(WEB_FUZZ_SEED + 0xabcdef);
    expect(fuzzSeedOf(SHA)).toBe(11_260_404);
    expect(fuzzSeedOf('unknown')).toBe(WEB_FUZZ_SEED);
    const plan = planOf('nightly', 'B1');
    expect(plan.json.fuzzSeed).toBe(11_260_404);
    const seeds = plan.checks.units.flatMap((unit) =>
      unit.job.kind === 'measure' && unit.job.measure === 'fuzz'
        ? [(unit.job.input as FuzzInput).seed]
        : [],
    );
    expect(seeds).toHaveLength(WEB_FUZZ_BUILDS);
    expect(new Set(seeds)).toEqual(new Set([11_260_404]));
  });

  it('plans only the global shards with units before B1, as Plan JSON v1 (OWN 6)', () => {
    for (const set of ['nightly', 'weekly'] as const) {
      const plan = nightlyPlan({ set, quick: false, content: 'registered', commit: SHA });
      expect(plan.json).toEqual({
        version: 1,
        set,
        quick: false,
        content: 'registered',
        commit: SHA,
        fuzzSeed: 11_260_404,
        shards: [{ id: 'global-m1', kind: 'm1' }],
      });
      expect(plan.units.get('global-m1')).toEqual(m1Units());
    }
  });

  it("plans each character's shards, then the globals, every one with units; the weekly adds the triples (OWN 6)", () => {
    const nightly = planOf('nightly', 'B2');
    const ids = (set: NightlySet) => planOf(set, 'B2').json.shards.map((spec) => spec.id);
    expect(nightly.json.shards).toEqual([
      { id: 'fire-sessions', kind: 'sessions', character: 'fire' },
      { id: 'fire-probes', kind: 'probes', character: 'fire' },
      { id: 'fire-doubles', kind: 'doubles', character: 'fire' },
      { id: 'summon-sessions', kind: 'sessions', character: 'summon' },
      { id: 'summon-probes', kind: 'probes', character: 'summon' },
      { id: 'summon-doubles', kind: 'doubles', character: 'summon' },
      { id: 'global-m1', kind: 'm1' },
      { id: 'global-fuzz', kind: 'fuzz' },
    ]);
    expect(ids('weekly')).toEqual([
      'fire-sessions',
      'fire-probes',
      'fire-doubles',
      'fire-triples',
      'summon-sessions',
      'summon-probes',
      'summon-doubles',
      'summon-triples',
      'global-m1',
      'global-fuzz',
    ]);
    const weekly = planOf('weekly', 'B2');
    expect(weekly.json.shards[3]).toEqual({
      id: 'fire-triples',
      kind: 'triples',
      character: 'fire',
      part: [0, 1],
    });
    for (const plan of [nightly, weekly]) {
      // Every first-phase unit in exactly one shard.
      const held = plan.json.shards.flatMap((spec) =>
        (plan.units.get(spec.id) ?? []).map((unit) => unit.id),
      );
      expect([...held].sort()).toEqual(plan.checks.units.map((unit) => unit.id).sort());
      // Every shard has units: a probes shard at least its second phase's.
      for (const spec of plan.json.shards) {
        const own = plan.units.get(spec.id) ?? [];
        if (spec.kind !== 'probes') expect(own.length, spec.id).toBeGreaterThan(0);
        else
          expect(
            derivedReads(plan.checks, spec.character ?? 'fire').sessions.length,
          ).toBeGreaterThan(0);
        for (const unit of own) expect(unitCharacter(unit)).toBe(spec.character ?? null);
      }
    }
    expect(nightly.units.get('fire-sessions')).toHaveLength(10 * 2);
    expect(nightly.units.get('fire-doubles')).toHaveLength(6 * DOUBLE_SEEDS);
    expect(weekly.units.get('summon-triples')).toHaveLength(4 * TRIPLE_SEEDS);
    expect(nightly.units.get('global-m1')).toHaveLength(2);
    expect(nightly.units.get('global-fuzz')).toHaveLength(WEB_FUZZ_BUILDS);
  });

  it('plans no shard without units: one fusion gives no doubles or triples shard (OWN 6)', () => {
    const b1 = fixtureContent('B1');
    const poison = b1.outers.poison;
    if (poison === undefined) throw new Error('B1 has no poison outer');
    const one: Content = { ...b1, outers: { poison } };
    const checks = checkSet('weekly', one, { fixture: 'B1' }, { c7: NO_C7 });
    expect(planShards(checks).shards.map((spec) => spec.id)).toEqual([
      'fire-sessions',
      'fire-probes',
      'global-m1',
      'global-fuzz',
    ]);
  });

  it("puts a fusion's strength and mirror units in its character's probes shard", () => {
    const entry: CalibrationEntry = {
      coef: 0.5,
      status: 'ok',
      median: 1.2,
      min: 1.1,
      max: 1.3,
      seeds: 2,
      startWave: 1,
      digest: 'x',
    };
    const content: Content = {
      ...fixtureContent('B5'),
      calibrated: { 'fire.summon': entry, 'summon.fire': entry },
    };
    const checks = checkSet('nightly', content, { fixture: 'B5' }, { c7: NO_C7, sessions: 1 });
    const { units } = planShards(checks);
    const measures = (id: string): string[] =>
      (units.get(id) ?? []).map((unit) =>
        unit.job.kind === 'measure'
          ? `${unit.job.measure} ${(unit.job.input as { key: string }).key}`
          : unit.id,
      );
    expect(measures('fire-probes')).toEqual([
      'fusionStrength fire.summon',
      'fusionStrength fire.summon',
      'mirror fire.summon',
      'mirror fire.summon',
    ]);
    expect(measures('summon-probes')).toEqual([
      'fusionStrength summon.fire',
      'fusionStrength summon.fire',
      'mirror summon.fire',
      'mirror summon.fire',
    ]);
    expect(measures('ice-probes')).toEqual([]);
  });

  it('prints Plan JSON v1 exactly and reads it back; refuses another version or an unknown field (OWN 6)', () => {
    const plan = planOf('weekly', 'B1');
    const text = formatPlanJson(plan.json);
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'version',
      'set',
      'quick',
      'content',
      'commit',
      'fuzzSeed',
      'shards',
    ]);
    expect(json).toMatchObject({
      version: 1,
      set: 'weekly',
      quick: true,
      content: 'fixture:B1',
      commit: SHA,
      fuzzSeed: 11_260_404,
    });
    expect(parsePlanJson(text)).toEqual(plan.json);
    const with_ = (change: Record<string, unknown>): string =>
      JSON.stringify({ ...json, ...change });
    expect(() => parsePlanJson(with_({ version: 2 }))).toThrow(
      'nightly plan: version 2; this nightly reads version 1',
    );
    expect(() => parsePlanJson(with_({ version: '1' }))).toThrow('nightly plan: version "1"');
    expect(() => parsePlanJson(with_({ extra: true }))).toThrow(
      'nightly plan: unknown field extra',
    );
    expect(() => parsePlanJson(with_({ set: 'pr' }))).toThrow('nightly plan: set pr');
    expect(() => parsePlanJson(with_({ shards: [{ id: 'x', kind: 'nightly' }] }))).toThrow(
      'nightly plan: shard 0: kind nightly',
    );
    expect(() =>
      parsePlanJson(with_({ shards: [{ id: 'x', kind: 'triples', part: [1, 1] }] })),
    ).toThrow('nightly plan: shard 0: part [1,1]');
    expect(() => parsePlanJson(with_({ shards: [{ id: 'x', kind: 'm1', weekly: true }] }))).toThrow(
      'nightly plan: shard 0: unknown field weekly',
    );
  });

  it('keeps exactly what JSON loses: ±Infinity, NaN, −0 and undefined fields', () => {
    const value = {
      a: Infinity,
      b: -Infinity,
      c: NaN,
      d: -0,
      e: undefined,
      f: [1, Infinity, null],
      // Data shaped like a tag, or keyed like one, stays data.
      g: { h: 'text', i: 0, j: { $number: 'not a tag' }, k: { $undefined: true }, $$l: [-0] },
    };
    const back = decodeExact(encodeExact(value)) as typeof value;
    expect(back).toStrictEqual(value);
    expect(Object.is(back.d, -0)).toBe(true);
    expect('e' in back).toBe(true);
    const session = answer(planOf('nightly', 'B1').checks.units[1]?.job as BalanceJob);
    expect(decodeExact(encodeExact(session))).toStrictEqual(session);
  });
});

describe('npm run nightly', () => {
  it('parses its modes and refuses what a mode does not take (exit 2)', async () => {
    expect(parseNightlyArgs(['--plan', '--weekly', '--quick', '--json'])).toMatchObject({
      mode: 'plan',
      set: 'weekly',
      quick: true,
      json: true,
      content: 'registered',
    });
    expect(parseNightlyArgs(['--shard', 'fire-sessions', '--out', 'o'])).toMatchObject({
      mode: 'shard',
      shard: 'fire-sessions',
      out: 'o',
    });
    expect(parseNightlyArgs(['--merge', 'in', '--out', 'o', '--summary', 's.md'])).toMatchObject({
      mode: 'merge',
      merge: 'in',
      out: 'o',
      summary: 's.md',
    });
    expect(parseNightlyArgs(['--content', 'fixture:B2'])).toMatchObject({
      mode: 'local',
      content: { fixture: 'B2' },
      out: join('out', 'nightly'),
    });
    expect(parseNightlyArgs(['--help'])).toBeNull();
    for (const argv of [
      ['--plan', '--shard', 'x'],
      ['--json'],
      ['--shard', 'x'],
      ['--merge', 'x'],
      ['--merge', 'x', '--out', 'o', '--weekly'],
      ['--merge', 'x', '--out', 'o', '--content', 'fixture'],
      ['--plan', '--out', 'o'],
      ['--shard', 'x', '--out', 'o', '--summary', 's'],
      ['--workers', '0'],
      ['--content', 'nope'],
      ['--bogus'],
    ]) {
      expect(() => parseNightlyArgs(argv), argv.join(' ')).toThrow();
    }
    const io = capture();
    expect(await main(['--json'], io, fixed())).toBe(2);
    expect(await main(['--shard', 'nowhere', '--out', join(root, 'x')], io, fixed())).toBe(2);
    expect(io.lines).toContain("No shard 'nowhere' in the plan: global-m1");
    const plan = capture();
    expect(
      await main(['--plan', '--json', '--content', 'fixture:B1', '--quick'], plan, fixed()),
    ).toBe(0);
    expect(parsePlanJson(plan.lines.join('\n'))).toEqual(planOf('nightly', 'B1').json);
  });

  it("merges the shards into the local run's outputs, every CSV written from the merged results (lead ruling U17)", async () => {
    const args = ['--quick', '--content', 'fixture:B2', '--workers', '2'];
    const local = join(root, 'local');
    const io = capture();
    const code = await main([...args, '--out', local], io, fixed());

    // In memory: the same plan through runPlan, evaluated and written by the checks' writers.
    const nightly = planOf('nightly', 'B2');
    const run = await runPlan(nightly.checks, 1, () => {}, stubPool());
    const rows = evaluate(nightly.checks, run.results);
    expect(code).toBe(exitCodeOf(rows));
    expect(read(local, 'checks.csv')).toBe(checksCsv(rows));
    expect((JSON.parse(read(local, 'checks.json')) as { results: CheckResult[] }).results).toEqual(
      JSON.parse(JSON.stringify(rows)),
    );
    const outputs = planOutputs(nightly.checks, run.results);
    expect(outputs.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'keystones.csv',
        'enemy_row.csv',
        'outer_row.csv',
        'dead_boards.csv',
        'dead_nodes.csv',
        'doubles.csv',
      ]),
    );
    for (const [name, text] of outputs) expect(read(local, name), name).toBe(text);
    expect(io.lines).toContain(
      'Shards: fire-sessions 0 s, fire-probes 0 s (0 s replaying 2 sessions), fire-doubles 0 s, ' +
        'summon-sessions 0 s, summon-probes 0 s (0 s replaying 2 sessions), summon-doubles 0 s, ' +
        'global-m1 0 s, global-fuzz 0 s',
    );

    // Shard by shard into another directory, every shard's CSV fragments overwritten, then merged.
    const dir = await shardsOf('B2');
    let fragments = 0;
    for (const id of readdirSync(join(dir, 'shards'))) {
      for (const name of readdirSync(shardDir(dir, id)).filter((file) => file.endsWith('.csv'))) {
        writeFileSync(join(shardDir(dir, id), name), 'character\ntampered\n');
        fragments += 1;
      }
    }
    expect(fragments).toBeGreaterThan(6);
    const merged = await mergeOf(dir);
    expect(merged.code).toBe(code);
    const files = readdirSync(local).filter((name) => name !== 'shards');
    expect(readdirSync(merged.out).sort()).toEqual([...files].sort());
    for (const name of files) expect(read(merged.out, name), name).toBe(read(local, name));
  }, 120_000);

  it("names a missing shard and exits 1, in the plan's order, not the directory's (OWN 7)", async () => {
    const dir = await shardsOf('B1');
    // The plan's order: fire-sessions, fire-probes, fire-doubles; the directory's: doubles first.
    rmSync(shardDir(dir, 'fire-doubles'), { recursive: true });
    rmSync(shardDir(dir, 'fire-sessions'), { recursive: true });
    const io = capture();
    const out = join(root, 'report');
    const summary = join(root, 'summary.md');
    expect(await main(['--merge', dir, '--out', out, '--summary', summary], io, fixed())).toBe(1);
    expect(io.lines.filter((line) => line.includes(' is missing: '))).toEqual([
      `  shard fire-sessions is missing: no ${join('shards', 'fire-sessions', 'meta.json')}`,
      `  shard fire-doubles is missing: no ${join('shards', 'fire-doubles', 'meta.json')}`,
    ]);
    expect(io.lines).toContain(
      '  unit session:fire:default:0 of shard fire-sessions has no result',
    );
    // Nothing is evaluated or written but the summary's note.
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(summary, 'utf8')).toMatch(
      /^# §4 checks: the merge stopped\n\n- shard fire-sessions is missing: /,
    );
  }, 60_000);

  it('requires a result for every planned unit and none outside the plan (lead ruling U13)', async () => {
    const dir = await shardsOf('B1');
    let dropped = '';
    edit(dir, 'fire-doubles', 'units.json', (file) => {
      const [first, second, ...rest] = file.units as RecordedUnit[];
      dropped = (first as RecordedUnit).id;
      const foreign = { ...(second as RecordedUnit), id: 'measure:double:fire:nope:0' };
      return { ...file, units: [second, foreign, ...rest] };
    });
    edit(dir, 'global-m1', 'units.json', (file) => {
      const [first, ...rest] = file.units as RecordedUnit[];
      const job = first?.job as Extract<BalanceJob, { kind: 'measure' }>;
      return { ...file, units: [{ ...first, job: { ...job, input: { tool: 'probe' } } }, ...rest] };
    });
    cpSync(shardDir(dir, 'global-fuzz'), shardDir(dir, 'global-extra'), { recursive: true });
    const { code, lines, out } = await mergeOf(dir);
    expect(code).toBe(1);
    expect(lines).toEqual(
      expect.arrayContaining([
        '  shard global-extra is not in the plan',
        '  unit measure:double:fire:nope:0 from shard fire-doubles is not one of its planned units',
        `  unit ${dropped} of shard fire-doubles has no result`,
        `  unit ${m1UnitId('fingerprint')} from shard global-m1 ran other inputs than the plan's`,
      ]),
    );
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it('refuses a shard that ran on another commit, naming it, whether or not the merge reads its own', async () => {
    const dir = await shardsOf('B1');
    const other = '0123456789abcdef0123456789abcdef01234567';
    edit(dir, 'fire-doubles', 'meta.json', (meta) => ({ ...meta, commit: other }));
    const { code, lines, out } = await mergeOf(dir);
    expect(code).toBe(1);
    expect(lines).toContain(`  shard fire-doubles ran on commit ${other}; the merge is on ${SHA}`);
    expect(existsSync(out)).toBe(false);
    // A merge whose own commit is unread takes the first shard's, and still refuses the others.
    const io = capture();
    const unread = join(root, 'merged-unread');
    const deps = fixed({ commit: () => 'unknown' });
    expect(await main(['--merge', dir, '--out', unread], io, deps)).toBe(1);
    expect(io.lines).toContain(
      `  shard fire-sessions ran on commit ${SHA}; the merge is on ${other}`,
    );
    expect(existsSync(unread)).toBe(false);
  }, 60_000);

  it('replays the sessions its second phase reads, records none of them, and runs exactly derivedUnits (lead ruling U11)', async () => {
    const nightly = planOf('nightly', 'B1', fixed({ checks: { sessions: 4, c7: BASE_C7 } }));
    const spec = nightly.json.shards.find((candidate) => candidate.id === 'fire-probes');
    if (spec === undefined) throw new Error('no fire-probes');
    const calls: BalanceJob[][] = [];
    const ran = await runShard(
      nightly,
      spec,
      1,
      () => {},
      stubPool(calls),
      () => 0,
    );
    // Session 0 holds the 30-min snapshot, session 1 the prestige point too: two, one at a time.
    expect(ran.replayed).toEqual(['session:fire:default:0', 'session:fire:default:1']);
    expect(calls.slice(0, 2)).toEqual(
      [0, 1].map((session) => [nightly.checks.units[session]?.job]),
    );
    expect(calls).toHaveLength(3);
    expect(ran.units.filter((unit) => unit.job.kind === 'character')).toEqual([]);
    const sessions = Object.fromEntries(
      nightly.checks.units
        .filter((unit) => unit.job.kind === 'character')
        .map((unit) => [unit.id, answer(unit.job)]),
    );
    const expected = derivedUnits(nightly.checks, sessions).filter(
      (unit) => unitCharacter(unit) === 'fire',
    );
    expect(expected.map((unit) => (unit.job.kind === 'measure' ? unit.job.measure : ''))).toEqual(
      expect.arrayContaining(['keystone', 'enemyRow', 'outerRow', 'deadBoard']),
    );
    expect(ran.units.map(({ id, job, derived }) => ({ id, job, derived }))).toEqual(
      expected.map(({ id, job }) => ({ id, job, derived: true })),
    );
    // On four workers it plays the four sessions in one call and runs the same units.
    const four = await runShard(
      nightly,
      spec,
      4,
      () => {},
      stubPool(),
      () => 0,
    );
    expect(four.replayed).toHaveLength(4);
    expect(four.units).toEqual(ran.units);
  });

  it('refuses a probes shard whose second-phase units are not what the merged sessions give (lead ruling U11)', async () => {
    const dir = await shardsOf('B1');
    let changed = '';
    let removed = '';
    edit(dir, 'fire-probes', 'units.json', (file) => {
      const units = file.units as RecordedUnit[];
      const keystone = units.findIndex(
        (unit) => unit.job.kind === 'measure' && unit.job.measure === 'keystone',
      );
      const unit = units[keystone] as RecordedUnit;
      const job = unit.job as Extract<BalanceJob, { kind: 'measure' }>;
      changed = unit.id;
      removed = (units.at(-1) as RecordedUnit).id;
      const input = job.input as KeystoneInput;
      const edited = { ...unit, job: { ...job, input: { ...input, seed: input.seed + 100 } } };
      return {
        ...file,
        units: units.slice(0, -1).map((other, i) => (i === keystone ? edited : other)),
      };
    });
    const { code, lines } = await mergeOf(dir);
    expect(code).toBe(1);
    expect(lines).toEqual(
      expect.arrayContaining([
        `  second-phase unit ${changed}: shard fire-probes ran other inputs than the merged sessions give`,
        `  second-phase unit ${removed} of shard fire-probes has no result`,
      ]),
    );
  }, 60_000);

  it('refuses a shard file of another version or an unknown kind, never reading it as noData (lead ruling U14)', async () => {
    const dir = await shardsOf('B1');
    edit(dir, 'fire-doubles', 'units.json', (file) => ({ ...file, version: 2 }));
    edit(dir, 'global-m1', 'meta.json', (file) => ({ ...file, version: 2 }));
    let session = '';
    edit(dir, 'fire-sessions', 'units.json', (file) => {
      const [first, ...rest] = file.units as RecordedUnit[];
      session = (first as RecordedUnit).id;
      return { ...file, units: [{ ...first, job: { ...first?.job, kind: 'warp' } }, ...rest] };
    });
    let build = '';
    edit(dir, 'global-fuzz', 'units.json', (file) => {
      const [first, ...rest] = file.units as RecordedUnit[];
      build = (first as RecordedUnit).id;
      const job = { ...first?.job, measure: 'teleport' };
      const result = { ...first?.result, measure: 'teleport' };
      return { ...file, units: [{ ...first, job, result }, ...rest] };
    });
    const { code, lines, out } = await mergeOf(dir);
    expect(code).toBe(1);
    expect(lines).toEqual(
      expect.arrayContaining([
        '  shard fire-doubles: units.json version 2; this nightly reads version 1',
        '  shard global-m1: meta.json version 2; this nightly reads version 1',
        `  shard fire-sessions: unit ${session} has an unknown job kind 'warp'`,
        `  shard global-fuzz: unit ${build} has an unknown measure 'teleport'`,
      ]),
    );
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it('runs only the global shards on the registered content: every check noCenter but m1, exit 0', async () => {
    const out = join(root, 'registered');
    const io = capture();
    expect(await main(['--out', out], io, fixed({ checks: { c7: NO_C7 } }))).toBe(0);
    expect(readdirSync(join(out, 'shards'))).toEqual(['global-m1']);
    const { results } = JSON.parse(read(out, 'checks.json')) as { results: CheckResult[] };
    expect(results.filter((row) => row.id === 'm1').map((row) => row.status)).toEqual([
      'pass',
      'pass',
      'info',
    ]);
    const others = results.filter((row) => row.id !== 'm1');
    expect(others.filter((row) => row.reason?.id !== 'noCenter')).toEqual([]);
  }, 60_000);
});

// ---- .github/workflows/nightly.yml ----

const WORKFLOW = readFileSync(join(REPO, '.github', 'workflows', 'nightly.yml'), 'utf8');
const SHARED_REF = '${{ inputs.ref || vars.NIGHTLY_REF || github.ref }}';

/** The workflow's jobs, each one's lines by its name (the keys two spaces in under `jobs:`). */
function jobsOf(text: string): Map<string, string[]> {
  const lines = text.split('\n');
  const jobs = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
    const name = /^ {2}([\w-]+):$/.exec(line)?.[1];
    if (name !== undefined) {
      current = [];
      jobs.set(name, current);
    } else if (/^\S/.test(line)) {
      break;
    } else {
      current?.push(line);
    }
  }
  return jobs;
}

/** A job's steps: each `- ` item six spaces in, with its lines up to the next. */
function stepsOf(job: readonly string[]): string[][] {
  const steps: string[][] = [];
  for (const line of job) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (/^ {8}/.test(line) || line.trim() === '') steps.at(-1)?.push(line);
  }
  return steps.map((step) => {
    const lines = [...step];
    while (lines.at(-1)?.trim() === '') lines.pop();
    return lines;
  });
}

/** A step's `run:` script: its one line, or its block's lines; null without one. */
function runOf(step: readonly string[]): string | null {
  const at = step.findIndex((line) => /^ {6}(- )?run: |^ {8}run: /.test(line));
  if (at < 0) return null;
  const line = step[at] as string;
  const column = line.indexOf('run:');
  const rest = line.slice(column + 'run:'.length).trim();
  if (rest !== '|') return rest;
  const body: string[] = [];
  for (const next of step.slice(at + 1)) {
    if (next.trim() !== '' && next.search(/\S/) <= column) break;
    body.push(next);
  }
  return body.join('\n').trimEnd();
}

/** A step's `env:` keys. */
function envOf(step: readonly string[]): string[] {
  const at = step.findIndex((line) => /^ {8}env:$/.test(line));
  if (at < 0) return [];
  const keys: string[] = [];
  for (const line of step.slice(at + 1)) {
    const key = /^ {10}(\w+): /.exec(line)?.[1];
    if (key === undefined) break;
    keys.push(key);
  }
  return keys;
}

/** Every `npm run nightly` command of a script, its arguments after `--`, the redirect dropped. */
const nightlyCommands = (script: string): string[] =>
  script
    .split('\n')
    .filter((line) => /npm run (--silent )?nightly -- /.test(line))
    .map((line) => (line.split(' nightly -- ')[1] as string).replace(/\s*>.*$/, '').trim());

/** A command's arguments with the shell's variables set: `flag` and the step's env. */
const argvOf = (command: string, flag: string): string[] =>
  command
    .replaceAll('$flag', flag)
    .replaceAll('"$SHARD"', 'fire-sessions')
    .replaceAll('"$GITHUB_STEP_SUMMARY"', 'summary.md')
    .split(/\s+/)
    .filter((word) => word !== '');

describe('.github/workflows/nightly.yml (OWN 8)', () => {
  const jobs = jobsOf(WORKFLOW);
  const steps = [...jobs.values()].flatMap(stepsOf);

  it('runs at 03:17 Asia/Taipei by a UTC cron, with no timezone key (lead ruling L11)', () => {
    expect(WORKFLOW).toMatch(/^ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: '17 19 \* \* \*'\n/m);
    expect(WORKFLOW.match(/cron:/g)).toHaveLength(1);
    expect(WORKFLOW).not.toMatch(/timezone/);
    expect(WORKFLOW).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}ref:\n/m);
    expect(WORKFLOW).toMatch(/^ {6}set:\n(?: {8}.*\n)*? {8}options: \[nightly, weekly\]\n/m);
  });

  it('reads the repository only, never cancels a run in progress, and groups runs by the shared ref', () => {
    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(WORKFLOW).not.toMatch(/: write/);
    expect(WORKFLOW).toContain(
      `concurrency:\n  group: nightly-${SHARED_REF}\n  cancel-in-progress: false\n`,
    );
    expect(WORKFLOW).not.toMatch(/cancel-in-progress: true/);
  });

  it('has the plan, shard and report jobs with their time limits; the report runs unless the plan failed', () => {
    expect([...jobs.keys()]).toEqual(['plan', 'shard', 'report']);
    const key = (job: string, name: string): string | undefined =>
      jobs
        .get(job)
        ?.find((line) => line.startsWith(`    ${name}: `))
        ?.slice(`    ${name}: `.length);
    expect(['plan', 'shard', 'report'].map((job) => key(job, 'timeout-minutes'))).toEqual([
      '10',
      '120',
      '15',
    ]);
    expect(key('shard', 'needs')).toBe('plan');
    expect(key('report', 'needs')).toBe('[plan, shard]');
    expect(key('report', 'if')).toBe("always() && needs.plan.result == 'success'");
    expect(key('plan', 'if')).toBeUndefined();
    expect(jobs.get('shard')).toEqual(
      expect.arrayContaining([
        '    strategy:',
        '      fail-fast: false',
        '      matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}',
      ]),
    );
  });

  it("uses ci.yml's majors, Node 22 with npm's cache, and checks out the shared ref in every job (lead ruling L5, F11)", () => {
    const uses = WORKFLOW.match(/uses: \S+/g) ?? [];
    expect(new Set(uses)).toEqual(
      new Set([
        'uses: actions/checkout@v4',
        'uses: actions/setup-node@v4',
        'uses: actions/upload-artifact@v4',
        'uses: actions/download-artifact@v4',
      ]),
    );
    for (const [name, job] of jobs) {
      const [checkout, node, install] = stepsOf(job);
      expect(checkout, name).toEqual([
        '      - uses: actions/checkout@v4',
        '        with:',
        `          ref: ${SHARED_REF}`,
      ]);
      expect(node, name).toEqual([
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 22',
        '          cache: npm',
      ]);
      expect(install, name).toEqual(['      - run: npm ci']);
    }
  });

  it('keeps every upload with if: always() and overwrite: true (a re-run job uploads again): the shards 7 days, the report 90; the report downloads them all', () => {
    const uploads = steps.filter((step) => step[0]?.includes('actions/upload-artifact@v4'));
    expect(uploads).toEqual([
      [
        '      - uses: actions/upload-artifact@v4',
        '        if: always()',
        '        with:',
        '          name: nightly-${{ matrix.shard }}',
        '          path: nightly-out/',
        '          retention-days: 7',
        '          overwrite: true',
      ],
      [
        '      - uses: actions/upload-artifact@v4',
        '        if: always()',
        '        with:',
        '          name: nightly-report',
        '          path: nightly-report/',
        '          retention-days: 90',
        '          overwrite: true',
      ],
    ]);
    expect(steps.find((step) => step[0]?.includes('actions/download-artifact@v4'))).toEqual([
      '      - uses: actions/download-artifact@v4',
      '        with:',
      '          pattern: nightly-*',
      '          merge-multiple: true',
      '          path: nightly-in',
    ]);
  });

  it('passes inputs, vars, the matrix and job outputs to scripts only through env (lead ruling L12)', () => {
    const scripts = steps.flatMap((step) => {
      const script = runOf(step);
      return script === null ? [] : [{ script, env: envOf(step) }];
    });
    expect(scripts).toHaveLength(6);
    for (const { script, env } of scripts) {
      expect(script).not.toContain('${{');
      // Every variable the shell reads (outside single quotes) is the step's env, the runner's or
      // one the script sets itself.
      const shell = script.replace(/'[^']*'/g, "''");
      const own = [...shell.matchAll(/^\s*(\w+)=/gm)].map((match) => match[1]);
      const known = new Set([
        ...env,
        ...own,
        'RUNNER_TEMP',
        'GITHUB_OUTPUT',
        'GITHUB_STEP_SUMMARY',
      ]);
      for (const [, name] of shell.matchAll(/\$\{?(\w+)/g))
        expect(known, `$${name}`).toContain(name);
    }
    const plan = scripts.find(({ script }) => script.includes('--plan'));
    expect(plan?.env).toEqual(['EVENT', 'SET', 'TRIPLES_WEEKDAY']);
    expect(WORKFLOW).toContain("          TRIPLES_WEEKDAY: '3'\n");
    // The weekly: Wednesday in Asia/Taipei, not the runner's UTC.
    expect(plan?.script).toContain('[ "$(TZ=Asia/Taipei date +%u)" = "$TRIPLES_WEEKDAY" ]');
    expect(plan?.script).toContain('[ "$EVENT" = workflow_dispatch ] && [ "$SET" = weekly ]');
  });

  it("runs nightly.ts' CLI: the plan as JSON, a shard into the uploaded directory, the merge of the downloaded ones", () => {
    const commands = steps.flatMap((step) => nightlyCommands(runOf(step) ?? ''));
    expect(commands).toHaveLength(3);
    for (const flag of ['', '--weekly']) {
      const [plan, shard, merge] = commands.map((command) =>
        parseNightlyArgs(argvOf(command, flag)),
      );
      expect(plan).toMatchObject({
        mode: 'plan',
        json: true,
        set: flag === '' ? 'nightly' : 'weekly',
      });
      expect(shard).toMatchObject({ mode: 'shard', shard: 'fire-sessions', out: 'nightly-out' });
      expect(merge).toMatchObject({
        mode: 'merge',
        merge: 'nightly-in',
        out: 'nightly-report',
        summary: 'summary.md',
      });
    }
    expect(WORKFLOW).toContain(
      'npm run --silent nightly -- --plan $flag --json > "$RUNNER_TEMP/plan.json"',
    );
  });

  it('turns Plan JSON v1 into the shard matrix, refusing another version', () => {
    const script = /node -e '\n([\s\S]*?)\n\s*' "\$RUNNER_TEMP\/plan\.json"/.exec(WORKFLOW)?.[1];
    if (script === undefined) throw new Error('no plan conversion');
    const file = join(root, 'plan.json');
    const convert = (json: string) => {
      writeFileSync(file, json);
      return spawnSync(process.execPath, ['-e', script, file], { encoding: 'utf8' });
    };
    const plan = planOf('nightly', 'B1').json;
    const ok = convert(formatPlanJson(plan));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(
      `matrix=${JSON.stringify({ include: plan.shards.map((spec) => ({ shard: spec.id })) })}\n`,
    );
    const other = convert(JSON.stringify({ ...plan, version: 2 }));
    expect(other.status).not.toBe(0);
    expect(other.stderr).toContain('Plan JSON version 2; this workflow reads 1');
  });
});
