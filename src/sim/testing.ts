/**
 * Self-contained fixtures for simulation tests and tools: game data, stat blocks and run
 * configs built inline, so sim tests never depend on the tuned content in src/data.
 */

import type { RuleSpec } from '../data/rules';
import { BASE_STATS } from '../data/stats';
import type { Modifier, StatBlock, StatId } from '../data/stats';
import type { TagMask } from '../data/tags';
import { ENEMY_IDS } from '../data/types';
import type { EnemyDef, EnemyId, GameData, WaveTable } from '../data/types';
import { centerDamage, compileBuild } from './build/compile';
import { createSimulation } from './simulation';
import { NO_INPUT } from './types';
import type { InputFrame, RunConfig, RunResult, SimEvent } from './types';

/** Enemy stats following docs/GDD.md §2.4. */
export const TEST_ENEMIES: Readonly<Record<EnemyId, EnemyDef>> = {
  triangle: {
    id: 'triangle',
    shape: 'triangle',
    hpMult: 0.5,
    speed: 220,
    radius: 16,
    contactDamage: 8,
    dropMult: 0.5,
    cores: 0,
    color: 0xff4fd8,
  },
  square: {
    id: 'square',
    shape: 'square',
    hpMult: 1,
    speed: 110,
    radius: 20,
    contactDamage: 15,
    dropMult: 1,
    cores: 0,
    color: 0x5b6cff,
  },
  pentagon: {
    id: 'pentagon',
    shape: 'pentagon',
    hpMult: 1,
    speed: 150,
    radius: 22,
    contactDamage: 12,
    dropMult: 1,
    cores: 0,
    splitInto: { enemy: 'shard', count: 3 },
    color: 0x3fe07a,
  },
  shard: {
    id: 'shard',
    shape: 'triangle',
    hpMult: 0.25,
    speed: 260,
    radius: 10,
    contactDamage: 4,
    dropMult: 0.25,
    cores: 0,
    color: 0xa6f7bf,
  },
  hexagon: {
    id: 'hexagon',
    shape: 'hexagon',
    hpMult: 3.5,
    speed: 90,
    radius: 34,
    contactDamage: 30,
    dropMult: 3.5,
    cores: 1,
    color: 0xa45cff,
  },
  boss: {
    id: 'boss',
    shape: 'octagon',
    hpMult: 6,
    speed: 60,
    radius: 70,
    contactDamage: 100,
    dropMult: 6,
    cores: 3,
    color: 0xff3d8b,
  },
};

export const TEST_WAVES: WaveTable = {
  rules: [
    { enemy: 'triangle', fromWave: 1, base: 6, perWave: 0.6, maxCount: 40 },
    { enemy: 'square', fromWave: 3, base: 2, perWave: 0.3, maxCount: 20 },
    { enemy: 'pentagon', fromWave: 8, base: 1, perWave: 0.2, maxCount: 12 },
  ],
  eliteEvery: 5,
  bossEvery: 10,
  spawnDurationSec: 1,
  waveTimerSec: 8,
};

export interface TestDataOverrides {
  readonly enemies?: Partial<Record<EnemyId, Partial<EnemyDef>>>;
  readonly waves?: Partial<WaveTable>;
}

/** Fixture game data (no talents); overrides are merged per enemy and into the wave table. */
export function makeTestData(overrides: TestDataOverrides = {}): GameData {
  const enemies = {} as Record<EnemyId, EnemyDef>;
  for (const id of ENEMY_IDS) enemies[id] = { ...TEST_ENEMIES[id], ...overrides.enemies?.[id] };
  return { enemies, waves: { ...TEST_WAVES, ...overrides.waves }, talents: [] };
}

/**
 * One wave of `count` stationary squares with HP multiplier `hpMult` (immortal by default), all
 * released on the first tick; no elites, bosses or later waves.
 */
export function stationarySquares(count: number, hpMult = 1e12): GameData {
  return makeTestData({
    enemies: { square: { hpMult, speed: 0 } },
    waves: {
      rules: [{ enemy: 'square', fromWave: 1, base: count, perWave: 0, maxCount: count }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
    },
  });
}

/**
 * Stat block from BASE_STATS plus overrides, which are both its base and its values, with the
 * given scoped modifiers: tagged or untagged increased/more damage, e.g. maskProbeMods(). Flat
 * changes belong in the overrides.
 */
export function makeStats(
  values: Partial<Record<StatId, number>> = {},
  scoped: readonly Modifier[] = [],
): StatBlock {
  const stats = { ...BASE_STATS, ...values };
  return { base: stats, values: stats, scoped, triggers: [], conversions: [] };
}

/**
 * Damage multiplier of a center instance with tags `mask` for `stats` and `rules` outside a run
 * (centerDamage of a fresh compileBuild): a primary hit with these tags deals values.damage ×
 * this before crits.
 */
export function damageRow(
  stats: StatBlock,
  mask: TagMask,
  rules: readonly RuleSpec[] = [],
): number {
  return centerDamage(compileBuild(stats, rules), mask);
}

export function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return { seed: 1, stats: makeStats(), rules: [], startWave: 1, mode: 'auto', ...overrides };
}

export interface RecordedRun {
  /** Copied events of every tick; index i holds the events of tick i + 1. */
  readonly ticks: readonly (readonly SimEvent[])[];
  readonly result: RunResult;
}

/** Runs a simulation to its end with a constant input, keeping every tick's events. */
export function recordRun(
  config: RunConfig,
  data: GameData,
  input: InputFrame = NO_INPUT,
): RecordedRun {
  const sim = createSimulation(config, data);
  const ticks: SimEvent[][] = [];
  while (!sim.state.finished) ticks.push(sim.step(input).slice());
  return { ticks, result: sim.result() };
}

/**
 * Tagged damage modifiers that give each of the 16 M1 tag masks its own damage multiplier,
 * 1 + 0.07 × mask (bit for bit once folded in data order, as ModTable rows do), so a damage
 * instance that picks the wrong mask changes the result (tools/balance/fingerprint.ts and
 * GOLDEN_BUILDS).
 */
export function maskProbeMods(): Modifier[] {
  return [
    { stat: 'damage', kind: 'increased', value: 0.07, tags: ['hit'] },
    { stat: 'damage', kind: 'increased', value: 0.14, tags: ['crit'] },
    { stat: 'damage', kind: 'increased', value: 0.28, tags: ['burn'] },
    { stat: 'damage', kind: 'increased', value: 0.56, tags: ['chain'] },
  ];
}

type EventOf<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;

/** The events of one type in a run's ticks (RecordedRun.ticks), in order. */
export function eventsOf<T extends SimEvent['type']>(
  ticks: readonly (readonly SimEvent[])[],
  type: T,
): EventOf<T>[] {
  return ticks.flat().filter((event): event is EventOf<T> => event.type === type);
}

/**
 * Keys of every M1 event type, in a fixed order. Fingerprints and the golden test hash events
 * through projectEvent, so a key added to one of these types later leaves their hashes alone;
 * an event type missing here is new and is hashed whole.
 */
export const M1_EVENT_KEYS = {
  waveStarted: ['wave'],
  waveCleared: ['wave'],
  enemySpawned: ['enemyId', 'enemy'],
  attack: ['projectileId', 'targetId'],
  hit: ['targetId', 'x', 'y', 'amount', 'crit', 'chainIndex', 'fromX', 'fromY'],
  ignite: ['targetId', 'stacks'],
  burnSpread: ['enemyId', 'x', 'y', 'radius', 'targets'],
  burnTick: ['targetId', 'x', 'y', 'amount'],
  enemyKilled: ['enemyId', 'enemy', 'x', 'y', 'shards', 'cores'],
  playerHit: ['enemyId', 'damage', 'lifeLeft'],
  runEnded: ['reason'],
} as const satisfies { readonly [T in SimEvent['type']]?: readonly (keyof EventOf<T>)[] };

/** The event as [type, ...its M1 keys' values]; an event type M1 did not have, unchanged. */
export function projectEvent(event: SimEvent): unknown {
  const keys = (M1_EVENT_KEYS as Partial<Record<string, readonly string[]>>)[event.type];
  if (keys === undefined) return event;
  const fields = event as unknown as Readonly<Record<string, unknown>>;
  return [event.type, ...keys.map((key) => fields[key])];
}

/** Enemy types of M1, in RunResult.damageTakenBy order. */
const M1_ENEMY_IDS = [
  'triangle',
  'square',
  'pentagon',
  'shard',
  'hexagon',
  'boss',
] as const satisfies readonly EnemyId[];

/** The RunResult fields M1 had, in a fixed order (see projectEvent). */
export function projectResult(result: RunResult): unknown[] {
  const { damage } = result;
  return [
    result.startWave,
    result.highestWaveReached,
    result.highestWaveCleared,
    result.clearedStartWave,
    result.endReason,
    result.ticks,
    result.shards,
    result.cores,
    result.kills,
    [damage.hit, damage.crit, damage.burn, damage.chain],
    result.maxHit,
    result.overkillSeconds,
    result.leaks,
    result.damageTaken,
    M1_ENEMY_IDS.map((id) => [result.damageTakenBy[id].hits, result.damageTakenBy[id].damage]),
    result.killedBy,
  ];
}

export interface GoldenBuild {
  readonly stats: StatBlock;
  readonly rules: readonly RuleSpec[];
}

/**
 * Searing Crits as data (src/data/talents.ts): crits ignite whatever the ignite roll, non-crit
 * hits deal half.
 */
export const SEARING_CRITS_MODS: readonly Modifier[] = [
  { stat: 'igniteAlways', kind: 'flat', value: 1, tags: ['crit'] },
  { stat: 'damage', kind: 'more', value: -0.5, tags: ['hit'], notTags: ['crit'] },
];

/**
 * The bridge notables' chances as data, in talent order: Flashpoint (+30% ignite on crits),
 * Conduction (+25% ignite on chain jumps) and Static Focus (+10% crit chance per jump).
 */
export const BRIDGE_MODS: readonly Modifier[] = [
  { stat: 'igniteChance', kind: 'flat', value: 0.3, tags: ['crit'] },
  { stat: 'igniteChance', kind: 'flat', value: 0.25, tags: ['chain'] },
  { stat: 'critChance', kind: 'flat', value: 0.1, scaling: { per: 'chainJump' } },
];

const golden = (
  values: Partial<Record<StatId, number>>,
  rules: readonly RuleSpec[] = [],
  modifiers: readonly Modifier[] = [],
) => ({
  stats: makeStats(values, [...maskProbeMods(), ...modifiers]),
  rules,
});

const CRIT = { critChance: 0.4, critMultiplier: 3, damage: 40 };
const BURN = { igniteChance: 0.6, burnDamage: 2, burnMaxStacks: 8, damage: 30 };
const CHAIN = { chainCount: 3.4, chainRetention: 0.8, chainRange: 300, damage: 30 };
const VOLLEY = { projectileCount: 3.5, attackSpeed: 6, damage: 25 };
const PANDEMIC: RuleSpec = { id: 'pandemic', spreadRadius: 250, spreadEffect: 0.4, hitMore: -0.3 };

/**
 * Builds of src/sim/golden.test.ts on makeTestData(): each M1 stat archetype, each M1 rule on
 * the archetype it acts on (Searing Crits and the bridge notables as data), and every damage
 * mask probed through maskProbeMods.
 */
export const GOLDEN_BUILDS: Readonly<Record<string, GoldenBuild>> = {
  plain: golden({}),
  crit: golden(CRIT),
  burn: golden(BURN),
  chain: golden(CHAIN),
  volley: golden(VOLLEY),
  steady: golden(CRIT, [{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'shot' }]),
  pandemic: golden(BURN, [PANDEMIC]),
  // Fast, sure ignites so stacks pile past the cap that eternalFlame lifts.
  eternalPandemic: golden({ ...BURN, igniteChance: 1, attackSpeed: 8 }, [
    { id: 'eternalFlame', durationMore: -0.5 },
    PANDEMIC,
  ]),
  overload: golden(CHAIN, [{ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2 }]),
  glass: golden(VOLLEY, [{ id: 'glassCannon', damageMore: 1 }]),
  searing: golden({ ...CRIT, igniteChance: 0.2 }, [], SEARING_CRITS_MODS),
  bridges: golden(
    { critChance: 0.3, igniteChance: 0.3, chainCount: 2.5, damage: 30 },
    [],
    BRIDGE_MODS,
  ),
};
