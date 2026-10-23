import { describe, expect, it } from 'vitest';
import { ROW_ENEMIES } from '../../../src/data/web';
import { DEFAULT_WEB_ECONOMY } from '../../../src/meta/web';
import { csvField } from '../csv';
import {
  budgetCsv,
  characterCurveCheckCsv,
  characterMilestonesCsv,
  characterRowAt,
  characterRunsCsv,
  characterSummaryTable,
  V3_PACING_TARGETS,
  V3_RUN_COLUMNS,
} from './report';
import { runCharacterSession, V3_MILESTONE_WAVES } from './session';
import type { CharacterRunRow, CharacterSessionConfig, CharacterSessionResult } from './session';

const config = (overrides: Partial<CharacterSessionConfig>): CharacterSessionConfig => ({
  character: 'fire',
  strategy: 'default',
  session: 0,
  seed: 1,
  minutes: 2,
  startWave: { kind: 'max' },
  economy: DEFAULT_WEB_ECONOMY,
  menuSeconds: 20,
  content: { fixture: 'B5' },
  scope: 'full',
  ...overrides,
});

const results = [
  runCharacterSession(config({})),
  runCharacterSession(config({ session: 1 })),
  runCharacterSession(config({ strategy: 'cheapest' })),
];
const lines = (csv: string): string[][] =>
  csv
    .trimEnd()
    .split('\n')
    .map((line) => line.split(','));

describe('v3 report', () => {
  it('writes one runs.csv row per run, with the per-type columns', () => {
    expect(V3_RUN_COLUMNS.slice(0, 5)).toEqual([
      'character',
      'scope',
      'strategy',
      'session',
      'run',
    ]);
    expect(V3_RUN_COLUMNS.slice(36, 41)).toEqual([
      'centerShare',
      'leaks_triangle',
      'contact_triangle',
      'bullet_triangle',
      'leaks_square',
    ]);
    expect(V3_RUN_COLUMNS.slice(-5)).toEqual([
      'leaks_elite',
      'contact_elite',
      'bullet_elite',
      'bombs',
      'bought',
    ]);
    expect(V3_RUN_COLUMNS).toHaveLength(37 + 11 * 3 + 2);
    const [header, ...rows] = lines(characterRunsCsv(results));
    expect(header).toEqual(V3_RUN_COLUMNS);
    expect(rows).toHaveLength(results.reduce((sum, result) => sum + result.rows.length, 0));
    const at = (name: string): number => V3_RUN_COLUMNS.indexOf(name);
    const first = rows[0] as string[];
    const row = results[0]?.rows[0] as CharacterRunRow;
    expect(first.slice(0, 5)).toEqual(['fire', 'full', 'default', '0', '1']);
    expect(first[at('leaks_triangle')]).toBe(String(row.byType.triangle.leaks));
    // Blank while runs have no bullet tallies (before C7.4b), the tally once they do.
    expect(first[at('bullet_pentagon')]).toBe(csvField(row.byType.pentagon.bullet));
    expect(first[at('bombs')]).toBe(String(row.bombs));
  });

  it('writes the runs.csv columns in the order of the design (§1.4)', () => {
    expect(V3_RUN_COLUMNS).toEqual([
      'character',
      'scope',
      'strategy',
      'session',
      'run',
      'minutes',
      'startWave',
      'highestWaveReached',
      'highestWaveCleared',
      'endReason',
      'runSeconds',
      'cycleBest',
      'bestWave',
      'prestiges',
      'kills',
      'leaks',
      'damageTaken',
      'killedBy',
      'shardsFromRun',
      'skipShards',
      'coresFromRun',
      'skipCores',
      'shardsBank',
      'coresBank',
      'purchases',
      'nodesCenter',
      'nodesHub',
      'nodesOuter',
      'outersUsed',
      'keystones',
      'fusionCores',
      'dmgCenter',
      'dmgHub',
      'dmgOuter',
      'dmgFusion',
      'dmgAsc',
      'centerShare',
      ...ROW_ENEMIES.flatMap((r) => [`leaks_${r}`, `contact_${r}`, `bullet_${r}`]),
      'leaks_elite',
      'contact_elite',
      'bullet_elite',
      'bombs',
      'bought',
    ]);
  });

  it('writes each milestone, counter and quantile in its own column', () => {
    const base = results[0] as CharacterSessionResult;
    const first = base.rows[0] as CharacterRunRow;
    const synthetic: CharacterSessionResult = {
      ...base,
      milestones: {
        minutesToWave: Object.fromEntries(
          V3_MILESTONE_WAVES.map((wave, i) => [wave, i < 3 ? i + 0.5 : null]),
        ),
        firstOuterNode: 3.25,
        firstFusionCore: 4.25,
        firstKeystoneAffordable: 5.25,
        firstKeystone: 6.25,
        prestigePoint: { minutes: 7.25, purchases: 68 },
        centerThreshold: 8.25,
        wall: { minutes: 9.25, wave: 55 },
      },
      rows: [
        {
          ...first,
          bestWave: 33,
          budget: {
            effectBudgetTicks: 1,
            effectsDropped: 2,
            summonCapped: 3,
            chainHitCapped: 4,
            projectilesCapped: 5,
            enemyCapDelayed: null,
            enemySpawnsSkipped: 7,
          },
          bombs: 8,
        },
      ],
      endMinutes: 10.5,
      stop: 'prestigePoint',
    };
    expect(lines(characterMilestonesCsv([synthetic]))[1]).toEqual([
      'fire',
      'full',
      'default',
      '0',
      '0.5',
      '1.5',
      '2.5',
      ...Array.from({ length: V3_MILESTONE_WAVES.length - 3 }, () => ''),
      '3.25',
      '4.25',
      '5.25',
      '6.25',
      '7.25',
      '68',
      '8.25',
      '9.25',
      '55',
      '1',
      '10.5',
      '33',
      'prestigePoint',
    ]);
    expect(lines(budgetCsv([synthetic]))[1]).toEqual([
      ...['fire', 'full', 'default', '0', '1'],
      ...['1', '2', '3', '4', '5', '', '7', '8'],
    ]);

    // Four sessions stopped at their prestige point after one run: read at 0 min, and carried.
    const at = (bestWave: number): CharacterSessionResult => ({
      ...synthetic,
      rows: [{ ...first, minutes: 1, bestWave }],
      endMinutes: 2,
    });
    const curve = lines(characterCurveCheckCsv([10, 12, 14, 16].map(at)));
    const quantiles = ['11.5', '13', '14.5'];
    expect(curve[1]).toEqual([
      'fire',
      'full',
      'default',
      '0',
      'start',
      '4',
      '0',
      '3',
      ...quantiles,
      'no',
    ]);
    expect(curve[2]).toEqual([
      ...['fire', 'full', 'default', '10', 'first notable', '4', '4', '15'],
      ...quantiles,
      'yes',
    ]);
  });

  it('writes the milestones, the budget counters and the curve check', () => {
    const [milestones, ...sessions] = lines(characterMilestonesCsv(results));
    expect(milestones).toContain('minToWave100');
    expect(milestones?.slice(-4)).toEqual(['runs', 'endMinutes', 'endBestWave', 'stop']);
    expect(sessions).toHaveLength(3);
    expect(sessions[0]?.at(-1)).toBe('budget');

    const [budget, ...runs] = lines(budgetCsv(results));
    expect(budget?.slice(5)).toEqual([
      'effectBudgetTicks',
      'effectsDropped',
      'summonCapped',
      'chainHitCapped',
      'projectilesCapped',
      'enemyCapDelayed',
      'enemySpawnsSkipped',
      'bombs',
    ]);
    expect(runs[0]?.slice(5, 7)).toEqual(['0', '0']);
    // C7.5's two counters: blank while runs lack them, their values once they have them.
    const { budget: counters } = results[0]?.rows[0] as CharacterRunRow;
    expect(runs[0]?.slice(10, 12)).toEqual(
      [counters.enemyCapDelayed, counters.enemySpawnsSkipped].map(csvField),
    );

    const [curve, ...points] = lines(characterCurveCheckCsv(results));
    expect(curve).toEqual([
      'character',
      'scope',
      'strategy',
      'minutes',
      'event',
      'sessions',
      'carried',
      'targetWave',
      'waveP25',
      'waveMedian',
      'waveP75',
      'withinTolerance',
    ]);
    expect(V3_PACING_TARGETS.at(-1)).toEqual({ minutes: 300, frontierWave: 100, event: 'clear' });
    expect(points).toHaveLength(2 * V3_PACING_TARGETS.length);
    expect(points[0]?.slice(0, 7)).toEqual(['fire', 'full', 'default', '0', 'start', '2', '0']);
    expect(points[2]?.slice(5)).toEqual(['0', '0', '22', '', '', '', 'n/a']);
    expect(characterSummaryTable(results)).toMatch(/^character strategy +wave@10/);
  });

  it('reads a session at a minute as the pacing check does, carrying one stopped at its prestige point', () => {
    const row = (minutes: number, bestWave: number) => ({ minutes, bestWave }) as CharacterRunRow;
    const session = (stop: CharacterSessionResult['stop']): CharacterSessionResult => ({
      ...(results[0] as CharacterSessionResult),
      rows: [row(1, 3), row(2, 5), row(3, 30)],
      endMinutes: 3.3,
      stop,
    });
    const stopped = session('prestigePoint');
    expect(characterRowAt(stopped, 0)).toEqual({ row: row(1, 3), carried: false });
    expect(characterRowAt(stopped, 2.5)).toEqual({ row: row(2, 5), carried: false });
    expect(characterRowAt(stopped, 3.2)).toEqual({ row: row(3, 30), carried: false });
    expect(characterRowAt(stopped, 40)).toEqual({ row: row(3, 30), carried: true });
    expect(characterRowAt(session('budget'), 40)).toBeNull();
    expect(characterRowAt(session('budget'), 3.3)).toEqual({ row: row(3, 30), carried: false });
  });

  it('reads a run that ends at the very minute as ended by then', () => {
    const row = (minutes: number, bestWave: number) => ({ minutes, bestWave }) as CharacterRunRow;
    const session: CharacterSessionResult = {
      ...(results[0] as CharacterSessionResult),
      rows: [row(1, 3), row(2, 5), row(3, 30)],
      endMinutes: 3.3,
      stop: 'budget',
    };
    expect(characterRowAt(session, 2)).toEqual({ row: row(2, 5), carried: false });
    expect(characterRowAt(session, 3)).toEqual({ row: row(3, 30), carried: false });
  });

  it("checks each character's sessions apart, in the curve check and the summary", () => {
    const fire = results[0] as CharacterSessionResult;
    const ice: CharacterSessionResult = {
      ...fire,
      character: 'ice',
      rows: fire.rows.map((row) => ({ ...row, character: 'ice' })),
    };
    const sessions = [fire, ice, results[1] as CharacterSessionResult];
    const [, ...points] = lines(characterCurveCheckCsv(sessions));
    const n = V3_PACING_TARGETS.length;
    expect(points.map((point) => point[0])).toEqual([
      ...Array.from({ length: n }, () => 'fire'),
      ...Array.from({ length: n }, () => 'ice'),
    ]);
    // At 0 min: fire's two sessions, ice's one.
    expect([points[0]?.slice(4, 6), points[n]?.slice(4, 6)]).toEqual([
      ['start', '2'],
      ['start', '1'],
    ]);
    const summary = characterSummaryTable(sessions);
    expect(summary).toMatch(/^fire default /m);
    expect(summary).toMatch(/^ice default /m);
  });

  it("writes the last run's bestWave as endBestWave", () => {
    const base = results[0] as CharacterSessionResult;
    const first = base.rows[0] as CharacterRunRow;
    const two: CharacterSessionResult = {
      ...base,
      rows: [
        { ...first, bestWave: 3 },
        { ...first, run: 2, bestWave: 5 },
      ],
    };
    const [header, row] = lines(characterMilestonesCsv([two]));
    expect(row?.[header?.indexOf('runs') ?? -1]).toBe('2');
    expect(row?.[header?.indexOf('endBestWave') ?? -1]).toBe('5');
  });
});
