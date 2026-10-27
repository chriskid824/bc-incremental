/**
 * Self-contained fixtures for simulation tests and tools: game data, stat blocks, run configs
 * and run contexts built inline, so sim tests never depend on the tuned content in src/data;
 * and the brute-force references the tests' oracles compare against.
 */

import { isFiniteNum, num } from '../core/num';
import { createRng, deriveSeed } from '../core/rng';
import type { Rng, RngStreamName } from '../core/rng';
import { targetDamage } from '../data/curve';
import type { SourcedEmitter } from '../data/emitters';
import { V3_ENEMIES } from '../data/enemiesV3';
import type { RuleSpec, SignatureSpec } from '../data/rules';
import { BASE_STATS, NO_EXTRAS } from '../data/stats';
import type { Modifier, SourcedTrigger, StatBlock, StatExtras, StatId } from '../data/stats';
import type { TagMask } from '../data/tags';
import type { TriggerSpec } from '../data/triggers';
import { ENEMY_IDS } from '../data/types';
import type { EnemyDef, EnemyId, GameData, V3WaveRules, WaveTable } from '../data/types';
import { centerDamage, compileBuild } from './build/compile';
import { CHAIN_HIT_CAP, PROJECTILE_CAP, SUMMON_CAP } from './caps';
import type { GridItem } from './grid';
import type { TestModule } from './rules';
import { createSimulation } from './simulation';
import { createRunContext } from './systems/context';
import type { Enemy, RunContext, WaveRecord } from './systems/context';
import { rebuildGrid } from './systems/grid';
import { addEnemy } from './systems/spawn';
import { startDueWave } from './systems/waves';
import { DRONE_KIND_TURRET, NO_INPUT } from './types';
import type { CounterId, InputFrame, RunConfig, RunResult, SimEvent, SimState } from './types';

/**
 * Enemy stats following docs/GDD.md §2.4, then the v3 types of src/data/enemiesV3.ts unchanged
 * (docs/v3 C7 design §1.2), which only TEST_V3_WAVES spawns.
 */
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
    tough: false,
    boss: false,
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
    tough: false,
    boss: false,
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
    tough: false,
    boss: false,
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
    tough: false,
    boss: false,
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
    tough: true,
    boss: false,
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
    tough: true,
    boss: true,
  },
  ...V3_ENEMIES,
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

/**
 * TEST_WAVES as a v3 run's (docs/v3 C7 design §1.2): the v3 types' rules at src/data/wavesV3.ts's
 * first waves with fixture counts, and its `v3` block, copied so that tuning the content moves
 * no fixture.
 */
export const TEST_V3_WAVES: WaveTable & { readonly v3: V3WaveRules } = {
  ...TEST_WAVES,
  rules: [
    ...TEST_WAVES.rules,
    { enemy: 'shielder', fromWave: 12, base: 1, perWave: 0.2, maxCount: 8 },
    { enemy: 'regenerator', fromWave: 16, base: 1, perWave: 0.2, maxCount: 8 },
    { enemy: 'dasher', fromWave: 22, base: 1, perWave: 0.2, maxCount: 8 },
    { enemy: 'shooter', fromWave: 32, base: 1, perWave: 0.2, maxCount: 8 },
    { enemy: 'summoner', fromWave: 42, base: 1, perWave: 0.2, maxCount: 8 },
  ],
  v3: {
    enemyCap: 400,
    bossRotation: ['onion'],
    affixes: [
      { fromWave: 5, count: 1 },
      { fromWave: 25, count: 2 },
      { fromWave: 60, count: 3 },
    ],
    treasure: { enemy: 'treasure', fromWave: 15, every: 5 },
  },
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

/** makeTestData of a v3 run: the wave overrides are merged into TEST_V3_WAVES. */
export function v3TestData(overrides: TestDataOverrides = {}): GameData {
  return makeTestData({ ...overrides, waves: { ...TEST_V3_WAVES, ...overrides.waves } });
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
 * given scoped modifiers: tagged or untagged increased/more damage, e.g. maskProbeMods(), and
 * the given triggers (`extras`, as collectExtras gives them). Flat changes belong in the
 * overrides.
 */
export function makeStats(
  values: Partial<Record<StatId, number>> = {},
  scoped: readonly Modifier[] = [],
  extras: StatExtras = NO_EXTRAS,
): StatBlock {
  const stats = { ...BASE_STATS, ...values };
  return { base: stats, values: stats, scoped, ...extras };
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

/** An enemy of placedEnemies: its type and exact position, radius, speed and hp. */
export interface PlacedEnemy {
  readonly x: number;
  readonly y: number;
  /** 'square' when omitted. */
  readonly type?: EnemyId;
  /** The type's radius when omitted. */
  readonly radius?: number;
  /** Arena units per second; 0 (standing still) when omitted. */
  readonly speed?: number;
  /** Its hp and max hp; 1e12 (immortal in practice) when omitted. */
  readonly hp?: number;
}

export interface PlacedOptions {
  readonly stats?: StatBlock;
  readonly rules?: readonly RuleSpec[];
  readonly signature?: SignatureSpec;
  readonly modules?: readonly TestModule[];
  readonly seed?: number;
  /**
   * The run's data, for its enemy types (radius, splits, drops); its waves are started but
   * never released, so only the placed enemies exist. Fixture enemies without waves when
   * omitted.
   */
  readonly data?: GameData;
}

/**
 * Fixture data whose first wave has no enemies and whose next one is far away. Its rules name
 * M1's wave types at a count of 0: none spawns, but the run can spawn them (reachableEnemies),
 * so ctx.shotPad covers the placed enemies as in a run of the fixture's waves.
 */
const noWaves = (): GameData =>
  makeTestData({
    waves: {
      rules: [
        { enemy: 'triangle', fromWave: 1, base: 0, perWave: 0, maxCount: 0 },
        { enemy: 'square', fromWave: 1, base: 0, perWave: 0, maxCount: 0 },
        { enemy: 'pentagon', fromWave: 1, base: 0, perWave: 0, maxCount: 0 },
      ],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
    },
  });

/**
 * A run context on tick 1 (ctx.now and state.tick both 1, as in a run) holding exactly the
 * `placed` enemies, in order (ids 1, 2, …): each at its position, with its radius, speed and hp,
 * in the start wave's record, and the grid rebuilt for the tick's queries. Nothing has moved or
 * attacked; the events of the wave start and the spawns are cleared. For tests of systems and
 * executors that need exact geometry.
 */
export function placedEnemies(
  placed: readonly PlacedEnemy[],
  options: PlacedOptions = {},
): RunContext {
  const config = makeConfig({
    seed: options.seed ?? 1,
    stats: options.stats ?? makeStats(),
    rules: options.rules ?? [],
    ...(options.signature === undefined ? {} : { signature: options.signature }),
  });
  const data = options.data ?? noWaves();
  const ctx = createRunContext(config, data, options.modules);
  ctx.now = 1;
  ctx.state.tick = 1;
  startDueWave(ctx);
  const rec = ctx.current as WaveRecord;
  const player = ctx.player;
  for (const spec of placed) {
    const type = data.enemies[spec.type ?? 'square'];
    const def: EnemyDef = {
      ...type,
      radius: spec.radius ?? type.radius,
      speed: spec.speed ?? 0,
    };
    const dx = spec.x - player.x;
    const dy = spec.y - player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0) addEnemy(ctx, def, rec, dx / dist, dy / dist, dist);
    else addEnemy(ctx, def, rec, 1, 0, 0);
    const enemy = ctx.enemies.at(-1) as Enemy;
    // addEnemy places it along its unit vector, which can be an ulp off the asked position.
    enemy.x = enemy.prevX = spec.x;
    enemy.y = enemy.prevY = spec.y;
    const hp = num(spec.hp ?? 1e12);
    Object.assign(enemy, { hp, maxHp: hp });
  }
  ctx.events.length = 0;
  rebuildGrid(ctx);
  return ctx;
}

/**
 * The position of every RNG stream of the run (Rng.snapshot()), by stream name: equal before
 * and after something that draws nothing.
 */
export function rngPositions(ctx: RunContext): Record<RngStreamName, ReturnType<Rng['snapshot']>> {
  return {
    spawn: ctx.spawnRng.snapshot(),
    split: ctx.splitRng.snapshot(),
    combat: ctx.combatRng.snapshot(),
    drops: ctx.dropsRng.snapshot(),
    trigger: ctx.triggerRng.snapshot(),
    effects: ctx.effectsRng.snapshot(),
    affixes: ctx.sys.affixes.rng.snapshot(),
  };
}

/**
 * Reference: squared distance from (px, py) to the segment from (ax, ay) to (bx, by), ends
 * included; a point when both ends are equal. The point's distance to an end when it lies
 * beyond that end, else its distance to the line (the cross product over the length).
 */
export function segDistSqRef(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const toAx = px - ax;
  const toAy = py - ay;
  if (dx * toAx + dy * toAy <= 0) return toAx * toAx + toAy * toAy;
  const toBx = px - bx;
  const toBy = py - by;
  if (dx * toBx + dy * toBy >= 0) return toBx * toBx + toBy * toBy;
  const cross = dx * toAy - dy * toAx;
  return (cross * cross) / (dx * dx + dy * dy);
}

/**
 * Reference: the alive items within squared distance radiusSq (inclusive) of (x, y), in source
 * order, by a scan of all of them: what SpatialGrid.within returns.
 */
export function withinRef<T extends GridItem>(
  items: readonly T[],
  x: number,
  y: number,
  radiusSq: number,
): T[] {
  return items.filter((item) => {
    const dx = item.x - x;
    const dy = item.y - y;
    return item.alive && dx * dx + dy * dy <= radiusSq;
  });
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

/**
 * Pandemic as data (src/data/talents.ts), its trigger and its modifier: a burning enemy's burns
 * spread on death to the enemies within 250 at 40% strength, and hits deal 30% less.
 */
export const PANDEMIC_TRIGGER: TriggerSpec = {
  on: 'diedWithAilment',
  when: [{ victimHas: 'burn' }],
  do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 250, effect: 0.4 }],
};
export const PANDEMIC_MODS: readonly Modifier[] = [
  { stat: 'damage', kind: 'more', value: -0.3, tags: ['hit'] },
];

/** Stat extras (makeStats) with these triggers, credited to the center as an M1 node's are. */
export function centerTriggers(triggers: readonly TriggerSpec[]): StatExtras {
  return {
    triggers: triggers.map((spec) => ({ source: 'center', spec })),
    conversions: [],
    emitters: [],
  };
}

const golden = (
  values: Partial<Record<StatId, number>>,
  rules: readonly RuleSpec[] = [],
  modifiers: readonly Modifier[] = [],
  triggers: readonly TriggerSpec[] = [],
) => ({
  stats: makeStats(values, [...maskProbeMods(), ...modifiers], centerTriggers(triggers)),
  rules,
});

const CRIT = { critChance: 0.4, critMultiplier: 3, damage: 40 };
const BURN = { igniteChance: 0.6, burnDamage: 2, burnMaxStacks: 8, damage: 30 };
const CHAIN = { chainCount: 3.4, chainRetention: 0.8, chainRange: 300, damage: 30 };
const VOLLEY = { projectileCount: 3.5, attackSpeed: 6, damage: 25 };

/**
 * Builds of src/sim/golden.test.ts on makeTestData(): each M1 stat archetype, each M1 rule on
 * the archetype it acts on (Searing Crits and the bridge notables as data, Pandemic as a data
 * trigger), and every damage mask probed through maskProbeMods.
 */
export const GOLDEN_BUILDS: Readonly<Record<string, GoldenBuild>> = {
  plain: golden({}),
  crit: golden(CRIT),
  burn: golden(BURN),
  chain: golden(CHAIN),
  volley: golden(VOLLEY),
  steady: golden(CRIT, [{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'shot' }]),
  pandemic: golden(BURN, [], PANDEMIC_MODS, [PANDEMIC_TRIGGER]),
  // Fast, sure ignites so stacks pile past the cap that eternalFlame lifts.
  eternalPandemic: golden(
    { ...BURN, igniteChance: 1, attackSpeed: 8 },
    [{ id: 'eternalFlame', durationMore: -0.5 }],
    PANDEMIC_MODS,
    [PANDEMIC_TRIGGER],
  ),
  overload: golden(CHAIN, [{ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2 }]),
  glass: golden(VOLLEY, [{ id: 'glassCannon', damageMore: 1 }]),
  searing: golden({ ...CRIT, igniteChance: 0.2 }, [], SEARING_CRITS_MODS),
  bridges: golden(
    { critChance: 0.3, igniteChance: 0.3, chainCount: 2.5, damage: 30 },
    [],
    BRIDGE_MODS,
  ),
};

/** The start wave of every stress-family bench scenario (tools/balance/bench.ts). */
export const STRESS_START_WAVE = 30;

/**
 * The stress fixture (docs/v3/implementation-plan-v3.md §6): every wave 18 triangles, 11
 * squares and 4 pentagons, a new wave every second, with slower enemies than the fixture's,
 * so a build of stressStats() keeps about 300 alive from tick 300 on.
 */
export const stressData = (): GameData =>
  makeTestData({
    waves: {
      rules: [
        { enemy: 'triangle', fromWave: 1, base: 18, perWave: 0, maxCount: 999 },
        { enemy: 'square', fromWave: 1, base: 11, perWave: 0, maxCount: 999 },
        { enemy: 'pentagon', fromWave: 1, base: 4, perWave: 0, maxCount: 999 },
      ],
      eliteEvery: 5,
      bossEvery: 1000,
      spawnDurationSec: 1,
      waveTimerSec: 1,
    },
    enemies: {
      triangle: { speed: 110 },
      square: { speed: 55 },
      pentagon: { speed: 75 },
      shard: { speed: 130 },
      hexagon: { speed: 45 },
    },
  });

/**
 * The v3 crowd fixture of the `enemies` bench scenario (C7/F18, docs/v3 C7 design §2.7): every
 * wave from wave 1 holds 13 triangles, 8 squares, 3 pentagons, 2 shielders, 2 regenerators, 2
 * dashers, 1 shooter and 1 summoner, with one elite of two affixes, so every affix rule, every
 * behaviour, the bullets and the defences run at once. A new wave every second as stressData,
 * whose slower walkers it keeps, with the v3 enemy cap of 400, no boss and no treasure. Run with
 * stressStats() from STRESS_START_WAVE for the stress family's 30 s it holds about 300–400 alive
 * from tick 300 on: §2.7's own counts (10/6/2 walkers) held 266 at seed 1, so the three walker
 * counts alone are scaled to reach the band, which the scenario's own numbers are tuned for
 * (§2.7's Run line); every other count is §2.7's. It is not in the stress family, so no alive
 * band is gated on it.
 */
export const v3StressData = (): GameData =>
  v3TestData({
    waves: {
      ...TEST_V3_WAVES,
      rules: [
        { enemy: 'triangle', fromWave: 1, base: 13, perWave: 0, maxCount: 999 },
        { enemy: 'square', fromWave: 1, base: 8, perWave: 0, maxCount: 999 },
        { enemy: 'pentagon', fromWave: 1, base: 3, perWave: 0, maxCount: 999 },
        { enemy: 'shielder', fromWave: 1, base: 2, perWave: 0, maxCount: 999 },
        { enemy: 'regenerator', fromWave: 1, base: 2, perWave: 0, maxCount: 999 },
        { enemy: 'dasher', fromWave: 1, base: 2, perWave: 0, maxCount: 999 },
        { enemy: 'shooter', fromWave: 1, base: 1, perWave: 0, maxCount: 999 },
        { enemy: 'summoner', fromWave: 1, base: 1, perWave: 0, maxCount: 999 },
      ],
      eliteEvery: 1,
      bossEvery: 1000,
      spawnDurationSec: 1,
      waveTimerSec: 1,
      v3: {
        ...TEST_V3_WAVES.v3,
        enemyCap: 400,
        affixes: [{ fromWave: 1, count: 2 }],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
    enemies: {
      triangle: { speed: 110 },
      square: { speed: 55 },
      pentagon: { speed: 75 },
      shard: { speed: 130 },
      hexagon: { speed: 45 },
    },
  });

/**
 * The stress build: bench.ts's normal build, immortal, but with its frontier at the stress start
 * wave itself (normal's is ten waves past its start wave), so enemies pile up; `values` override
 * its stats, `extras` add triggers, conversions and emitter grants, `scoped` scoped modifiers.
 */
export const stressStats = (
  values: Partial<Record<StatId, number>> = {},
  extras?: StatExtras,
  scoped: readonly Modifier[] = [],
): StatBlock =>
  makeStats(
    {
      damage: targetDamage(STRESS_START_WAVE) / 2.5,
      attackSpeed: 4,
      critChance: 0.25,
      critMultiplier: 2,
      igniteChance: 0.4,
      chainCount: 2,
      maxLife: 1e12,
      ...values,
    },
    scoped,
    extras,
  );

/**
 * The summon fuzz (docs/v3 C5 design D22, §8.1 C5.5): seeded random builds of drones and
 * turrets, run with checks, by src/sim/summonFuzz.test.ts (20 builds, 600 ticks) and
 * tools/balance/fuzzSummons.ts (more, for longer). Build i is drawn on a stream of its own
 * (deriveSeed(seed, `summonFuzz:${i}`)), so a longer list starts with a shorter one's builds and
 * a failure names a build anyone can rebuild: summonFuzzBuilds(i + 1)[i].
 */
export const SUMMON_FUZZ_SEED = 1028;
/** The start waves every fuzz build runs from. */
export const SUMMON_FUZZ_START_WAVES = [1, 30] as const;

/**
 * What a fuzz build stands for, in turn by its index: the swarm (drones only, then with
 * turrets), the swarm with turrets only, M1 with a zero-row grant and a one-drone grant (then
 * with random grants), M1 with turret-only grants (then behind a zero-row one), summons up to
 * and past SUMMON_CAP (the swarm's 20 + 4 beside a grant, then two grants), a test module's
 * summonCap above SUMMON_CAP, one below it (which leaves the cap at SUMMON_CAP), turrets that
 * fill PROJECTILE_CAP, chains long enough for CHAIN_HIT_CAP (then by a forking policy), and an
 * attack speed of 0 (then 0.5). Each shape's two variants take turns on every pass through the
 * shapes.
 */
export const SUMMON_FUZZ_SHAPES = [
  'swarm',
  'swarmTurrets',
  'grants',
  'turretGrants',
  'capFill',
  'capRaised',
  'capLowered',
  'shotFill',
  'chainFill',
  'idle',
] as const;
export type SummonFuzzShape = (typeof SUMMON_FUZZ_SHAPES)[number];

/** A fuzz build: its run's config but the start wave, its data and its test modules' settings. */
export interface SummonFuzzBuild {
  readonly index: number;
  /** The seed it was drawn from, and its runs' seed. */
  readonly seed: number;
  readonly shape: SummonFuzzShape;
  /** Its data: the stress fixture (stressData) or the plain one (makeTestData). */
  readonly stress: boolean;
  readonly stats: StatBlock;
  readonly rules: readonly RuleSpec[];
  /** The swarm signature's [drones, turrets], which its test module sets; null for M1's volley. */
  readonly swarm: readonly [number, number] | null;
  /** Each drone grant's [drones, turrets], in StatBlock.emitters order. */
  readonly grants: readonly (readonly [number, number])[];
  /** A test module's summonCap; null for none. */
  readonly summonCap: number | null;
  /**
   * The cadence a tick hook writes on every emitter: a constant, 'random' for a value in
   * [0.3, 3] redrawn every 7–40 ticks (on a stream of the hook's own), or null for none.
   */
  readonly cadence: number | 'random' | null;
  /** A test module's chain policy (forks of 2, extra jumps at 0.5) for the signature's chains. */
  readonly policy: boolean;
}

/** The fuzz's droneImpact triggers: poison, a blast and a pulse zone at the impact. */
const IMPACT_TRIGGERS: readonly TriggerSpec[] = [
  { on: 'droneImpact', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }] },
  { on: 'droneImpact', do: [{ kind: 'explode', radius: 60, damagePct: 0.3, maxTargets: 5 }] },
  {
    on: 'droneImpact',
    do: [{ kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0.25 }],
  },
];

/** The fuzz's repeats (repeatAttack): 回聲 and 多重施法 (C4.9), and two on hits and kills. */
const REPEAT_TRIGGERS: readonly SourcedTrigger[] = [
  {
    source: 'outer.combo',
    spec: { on: 'nthAttack', every: 5, do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }] },
  },
  {
    source: 'outer.combo',
    spec: {
      on: 'nthAttack',
      every: 12,
      do: [{ kind: 'repeatAttack', count: 2, damagePct: 1, timing: 'nextAttack' }],
    },
  },
  {
    source: 'center',
    spec: {
      on: 'hit',
      when: [{ hitIs: 'signature' }, { chance: 0.05 }],
      do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.3, timing: 'now' }],
    },
  },
  {
    source: 'center',
    spec: {
      on: 'kill',
      when: [{ chance: 0.3 }],
      do: [{ kind: 'repeatAttack', count: 3, damagePct: 0.4, timing: 'nextAttack' }],
    },
  },
];

/** M1's keystone rules the fuzz draws from (glassCannon left out: its life of 1 ends runs). */
const FUZZ_RULES: readonly RuleSpec[] = [
  { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'shot' },
  { id: 'steadyAim', everyNth: 4, critMultiplierMore: 0.5, counts: 'attack' },
  { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2 },
  { id: 'eternalFlame', durationMore: -0.5 },
];

/** A whole number in [lo, hi]. */
const intIn = (rng: Rng, lo: number, hi: number): number => lo + rng.int(hi - lo + 1);
/** A number in [lo, hi), uniform in its logarithm. */
const logIn = (rng: Rng, lo: number, hi: number): number => lo * (hi / lo) ** rng.next();

/** The fuzz's first `count` builds from `seed`. */
export function summonFuzzBuilds(count: number, seed = SUMMON_FUZZ_SEED): SummonFuzzBuild[] {
  return Array.from({ length: count }, (_, index) => summonFuzzBuild(index, seed));
}

/**
 * Build `index`: its shape's summons (whole counts; a grant within data validation's 1–24 slots
 * but for zero-row ones, which the sim allows, CHK7-7) and stats over BASE_STATS: damage from
 * wave 1's to past wave 30's, attack speed and projectiles, crits, ailment chances, chains,
 * immortal; M1's damage table (maskProbeMods) and at times its other data (Pandemic, Searing
 * Crits, the bridge notables) and a keystone; for the swarm, at times a droneImpact trigger; at
 * times the repeats, a cadence and a chain policy.
 */
function summonFuzzBuild(index: number, base: number): SummonFuzzBuild {
  const seed = deriveSeed(base, `summonFuzz:${index}`);
  const rng = createRng(seed);
  const shape = SUMMON_FUZZ_SHAPES[index % SUMMON_FUZZ_SHAPES.length] as SummonFuzzShape;
  // The shape's other variant on every second pass through the shapes.
  const second = Math.floor(index / SUMMON_FUZZ_SHAPES.length) % 2 === 1;
  const values: Partial<Record<StatId, number>> = {
    damage: logIn(rng, 2, 7000),
    attackSpeed: logIn(rng, 1, 16),
    projectileCount: rng.range(0.3, 4),
    critChance: rng.range(0, 0.6),
    critMultiplier: rng.range(1.5, 4),
    igniteChance: rng.chance(0.7) ? rng.range(0, 0.8) : 0,
    poisonChance: rng.chance(0.5) ? rng.range(0, 0.5) : 0,
    bleedChance: rng.chance(0.4) ? rng.range(0, 0.5) : 0,
    shockChance: rng.chance(0.4) ? rng.range(0, 0.5) : 0,
    chainCount: rng.range(0, 4),
    chainRange: rng.range(150, 600),
    maxLife: 1e12,
  };
  let stress = rng.chance(0.3);
  let swarm: [number, number] | null = null;
  const grants: [number, number][] = [];
  let summonCap: number | null = null;
  let policy: boolean | null = null;
  switch (shape) {
    case 'swarm':
      swarm = [intIn(rng, 1, 12), second ? intIn(rng, 1, 4) : 0];
      break;
    case 'swarmTurrets':
      swarm = [0, intIn(rng, 1, 6)];
      break;
    case 'grants':
      if (second) {
        for (let k = intIn(rng, 2, 3); k > 0; k--) {
          const drones = intIn(rng, 0, 8);
          grants.push([drones, intIn(rng, drones === 0 ? 1 : 0, 4)]);
        }
      } else {
        // One drone on emitter 2, past the pool's one row: per-slot and per-emitter arrays differ.
        grants.push([0, 0], [1, 0]);
        values.attackSpeed = logIn(rng, 4, 16);
      }
      break;
    case 'turretGrants':
      if (second) grants.push([0, 0]);
      for (let k = intIn(rng, 1, 2); k > 0; k--) grants.push([0, intIn(rng, 1, 4)]);
      break;
    case 'capFill':
      if (second) {
        grants.push([intIn(rng, 12, 20), intIn(rng, 0, 4)], [intIn(rng, 6, 12), intIn(rng, 0, 4)]);
      } else {
        swarm = [20, 4];
        grants.push([intIn(rng, 2, 8), intIn(rng, 0, 3)]);
      }
      break;
    case 'capRaised':
      summonCap = rng.pick([32, 40, 48]);
      swarm = [intIn(rng, 16, 24), intIn(rng, 2, 4)];
      grants.push([intIn(rng, 12, 20), intIn(rng, 0, 4)]);
      if (second) grants.push([0, intIn(rng, 6, 12)]);
      break;
    case 'capLowered':
      summonCap = intIn(rng, 4, 20);
      swarm = [intIn(rng, 8, 16), intIn(rng, 1, 4)];
      grants.push([intIn(rng, 4, 12), intIn(rng, 0, 3)]);
      break;
    case 'shotFill':
      if (second) grants.push([0, 24]);
      else swarm = [intIn(rng, 2, 4), intIn(rng, 16, 20)];
      values.attackSpeed = rng.range(40, 64);
      values.projectileCount = rng.range(5, 8);
      stress = true;
      break;
    case 'chainFill':
      swarm = [intIn(rng, 8, 12), intIn(rng, 2, 4)];
      values.damage = logIn(rng, 1, 4);
      values.chainCount = rng.range(33, 48);
      values.chainRange = 2000;
      values.chainRetention = 0.9;
      policy = second;
      stress = true;
      break;
    case 'idle':
      if (second) grants.push([intIn(rng, 1, 6), intIn(rng, 1, 4)]);
      else swarm = [intIn(rng, 1, 8), intIn(rng, 1, 4)];
      values.attackSpeed = second ? 0.5 : 0;
      break;
  }
  const triggers: SourcedTrigger[] = [];
  if (swarm !== null && rng.chance(0.6)) {
    triggers.push({ source: 'center', spec: rng.pick(IMPACT_TRIGGERS) });
  }
  if (rng.chance(0.5)) triggers.push(...REPEAT_TRIGGERS.filter(() => rng.chance(0.6)));
  const scoped: Modifier[] = maskProbeMods();
  if (rng.chance(0.2)) {
    triggers.push({ source: 'center', spec: PANDEMIC_TRIGGER });
    scoped.push(...PANDEMIC_MODS);
  }
  if (rng.chance(0.15)) scoped.push(...SEARING_CRITS_MODS);
  if (rng.chance(0.15)) scoped.push(...BRIDGE_MODS);
  const rules = rng.chance(0.3) ? [rng.pick(FUZZ_RULES)] : [];
  const draw = rng.next();
  const cadence = draw < 0.2 ? rng.range(0.3, 3) : draw < 0.4 ? 'random' : null;
  const emitters: SourcedEmitter[] = grants.map(([drones, turrets], k) => ({
    source: k % 2 === 0 ? 'outer.summon' : 'hub',
    grant: {
      kind: 'drone',
      drones,
      turrets,
      damagePct: rng.range(0.2, 1.5),
      turretDamagePct: rng.range(0.1, 1),
      name: `g${k}`,
    },
  }));
  return {
    index,
    seed,
    shape,
    stress,
    stats: makeStats(values, scoped, { triggers, conversions: [], emitters }),
    rules,
    swarm,
    grants,
    summonCap,
    cadence,
    policy: policy ?? rng.chance(0.3),
  };
}

/** The build's name in failures and reports: its index, its seed and its shape. */
export const summonFuzzName = (build: SummonFuzzBuild): string =>
  `build ${build.index} (seed ${build.seed}, ${build.shape})`;

/** The summons the build asks for: the swarm's and every grant's drones and turrets. */
export const summonFuzzRows = (build: SummonFuzzBuild): number =>
  (build.swarm === null ? 0 : build.swarm[0] + build.swarm[1]) +
  build.grants.reduce((sum, [drones, turrets]) => sum + drones + turrets, 0);

/** The run's summon cap by the design's rule (D15): the largest of SUMMON_CAP and its module's. */
export const summonFuzzCap = (build: SummonFuzzBuild): number =>
  Math.max(SUMMON_CAP, build.summonCap ?? 0);

/** A run of the build from `startWave`, `ticks` long. */
export function summonFuzzConfig(
  build: SummonFuzzBuild,
  startWave: number,
  ticks: number,
): RunConfig {
  return {
    seed: build.seed,
    stats: build.stats,
    rules: build.rules,
    ...(build.swarm === null ? {} : { signature: { id: 'swarm' } }),
    startWave,
    mode: 'auto',
    maxTicks: ticks,
  };
}

/**
 * The build's test modules, new for each run: the swarm's counts, the cadence, the chain policy
 * and the summonCap.
 */
export function summonFuzzModules(build: SummonFuzzBuild): TestModule[] {
  const modules: TestModule[] = [];
  const { swarm, cadence } = build;
  if (swarm !== null) {
    modules.push((b) => {
      const params = b.signature().swarm;
      if (params !== null) Object.assign(params, { drones: swarm[0], turrets: swarm[1] });
    });
  }
  if (typeof cadence === 'number') {
    modules.push(
      (b) =>
        void b.hook('tick', (ctx) => {
          for (const em of ctx.emitters) em.cadence = cadence;
        }),
    );
  } else if (cadence === 'random') {
    modules.push((b) => {
      const rng = createRng(deriveSeed(build.seed, 'cadence'));
      let value = 1;
      let switchAt = 0;
      b.hook('tick', (ctx) => {
        if (ctx.now >= switchAt) {
          value = rng.range(0.3, 3);
          switchAt = ctx.now + 7 + rng.int(34);
        }
        for (const em of ctx.emitters) em.cadence = value;
      });
    });
  }
  if (build.policy) {
    modules.push((b) => {
      const spec = b.chainPolicy();
      spec.branchFirst = 2;
      spec.branchLater = 2;
      spec.extraJumpChance = 0.5;
    });
  }
  if (build.summonCap !== null)
    modules.push(Object.assign(() => undefined, { summonCap: build.summonCap }));
  return modules;
}

/**
 * A failure of the fuzz: a NaN or infinite hp or position (nonFinite), a count past its cap
 * (cap), summons placed or refused other than the cap allows (layout), two runs that differ
 * (hash), or a run that threw (threw).
 */
export interface SummonFuzzFailure {
  readonly kind: 'nonFinite' | 'cap' | 'layout' | 'hash' | 'threw';
  readonly text: string;
}

/**
 * The fuzz's checks of a run's state after a tick (and at tick 0), under summon cap `cap`: every
 * enemy's hp and position and every summon's position (turrets' included) finite, at most `cap`
 * summons, at most PROJECTILE_CAP shot pool shots and at most PROJECTILE_CAP projectiles and
 * shots in flight together, and with the run's `counters`, no attack past CHAIN_HIT_CAP hits.
 * Appends a failure to `out` for each that fails.
 */
export function checkSummonTick(
  state: SimState,
  cap: number,
  counters: Readonly<Record<CounterId, number>> | null,
  out: SummonFuzzFailure[],
): void {
  const at = `tick ${state.tick}`;
  const nonFinite = (text: string): void => void out.push({ kind: 'nonFinite', text });
  for (const enemy of state.enemies) {
    if (!isFiniteNum(enemy.hp)) nonFinite(`${at}: enemy ${enemy.id} hp ${enemy.hp}`);
    if (!Number.isFinite(enemy.x)) nonFinite(`${at}: enemy ${enemy.id} x ${enemy.x}`);
    if (!Number.isFinite(enemy.y)) nonFinite(`${at}: enemy ${enemy.id} y ${enemy.y}`);
  }
  const { drones } = state;
  for (let s = 0; s < state.droneCount; s++) {
    const name = `${drones.kind[s] === DRONE_KIND_TURRET ? 'turret' : 'drone'} ${drones.id[s]}`;
    const x = drones.x[s] as number;
    const y = drones.y[s] as number;
    if (!Number.isFinite(x)) nonFinite(`${at}: ${name} x ${x}`);
    if (!Number.isFinite(y)) nonFinite(`${at}: ${name} y ${y}`);
  }
  const over = (text: string): void => void out.push({ kind: 'cap', text: `${at}: ${text}` });
  if (state.droneCount > cap) over(`${state.droneCount} summons, past the cap ${cap}`);
  if (state.shotCount > PROJECTILE_CAP) over(`${state.shotCount} shots, past PROJECTILE_CAP`);
  const inFlight = state.projectiles.length + state.shotCount;
  if (inFlight > PROJECTILE_CAP) over(`${inFlight} projectiles and shots, past PROJECTILE_CAP`);
  const peak = counters?.chainHitsPeak ?? 0;
  if (peak > CHAIN_HIT_CAP) over(`chainHitsPeak ${peak}, past CHAIN_HIT_CAP`);
}

/** What one fuzz run did, with its failures. */
export interface SummonFuzzRun {
  /** The hash of every tick's events, then the result (createRunHash). */
  readonly hash: string;
  readonly failures: readonly SummonFuzzFailure[];
  readonly ticks: number;
  /** The run's summon cap (summonFuzzCap), the summons asked for and those placed at tick 0. */
  readonly cap: number;
  readonly rows: number;
  readonly placed: number;
  /** The most shot pool shots, and projectiles and shots together, in flight after a tick. */
  readonly peakShots: number;
  readonly peakInFlight: number;
  /** Impacts of drones, impacts of repeats (droneId −1), turret firings and their shots. */
  readonly impacts: number;
  readonly repeatImpacts: number;
  readonly firings: number;
  readonly turretShots: number;
  readonly kills: number;
  /** The result's counters; null when the run stopped early. */
  readonly counters: Readonly<Record<CounterId, number>> | null;
}

/**
 * Runs the build from `startWave` for `ticks` ticks with its test modules and then `extra`,
 * checking its state at tick 0 and after every tick (checkSummonTick, with the counters a tick
 * hook of its own reads), and that its summons are placed and refused as the cap says: at tick 0,
 * min(rows, cap) placed, and at the end summonCapped the rest. It stops at the first tick that
 * fails, and when the simulation throws.
 */
export function runSummonFuzz(
  build: SummonFuzzBuild,
  startWave: number,
  ticks: number,
  extra: readonly TestModule[] = [],
): SummonFuzzRun {
  const cap = summonFuzzCap(build);
  const rows = summonFuzzRows(build);
  const failures: SummonFuzzFailure[] = [];
  const hash = createRunHash();
  const seen: { ctx: RunContext | null } = { ctx: null };
  const watch: TestModule = (b) =>
    void b.hook('tick', (ctx) => {
      seen.ctx = ctx;
    });
  const run = {
    ticks: 0,
    placed: 0,
    peakShots: 0,
    peakInFlight: 0,
    impacts: 0,
    repeatImpacts: 0,
    firings: 0,
    turretShots: 0,
    kills: 0,
  };
  let counters: Readonly<Record<CounterId, number>> | null = null;
  try {
    const data = build.stress ? stressData() : makeTestData();
    const modules = [...summonFuzzModules(build), ...extra, watch];
    const sim = createSimulation(summonFuzzConfig(build, startWave, ticks), data, modules);
    const { state } = sim;
    run.placed = state.droneCount;
    const placed = Math.min(rows, cap);
    if (run.placed !== placed) {
      failures.push({
        kind: 'layout',
        text: `tick 0: ${run.placed} summons placed of ${rows}, not ${placed} (cap ${cap})`,
      });
    }
    checkSummonTick(state, cap, null, failures);
    while (failures.length === 0 && !state.finished) {
      const events = sim.step(NO_INPUT);
      run.ticks = state.tick;
      hash.update(JSON.stringify(events));
      for (const event of events) {
        if (event.type === 'impact') {
          if (event.droneId >= 0) run.impacts++;
          else run.repeatImpacts++;
        } else if (event.type === 'turretFire') {
          run.firings++;
          run.turretShots += event.count;
        }
      }
      run.peakShots = Math.max(run.peakShots, state.shotCount);
      run.peakInFlight = Math.max(run.peakInFlight, state.projectiles.length + state.shotCount);
      checkSummonTick(state, cap, seen.ctx?.counters ?? null, failures);
    }
    if (failures.length === 0) {
      const result = sim.result();
      hash.update(JSON.stringify(result));
      counters = result.counters;
      run.kills = result.kills;
      if (counters.summonCapped !== rows - run.placed) {
        failures.push({
          kind: 'layout',
          text: `summonCapped ${counters.summonCapped}, not the ${rows - run.placed} refused`,
        });
      }
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    failures.push({ kind: 'threw', text: `tick ${run.ticks + 1}: threw ${text}` });
  }
  return { hash: hash.digest(), failures, cap, rows, counters, ...run };
}

/** A fuzz case: a build's two runs from one start wave, and their failures. */
export interface SummonFuzzCase {
  readonly build: SummonFuzzBuild;
  readonly startWave: number;
  readonly runs: readonly [SummonFuzzRun, SummonFuzzRun];
  /** Each run's failures, naming the build, the wave and the run, then a hash mismatch. */
  readonly failures: readonly SummonFuzzFailure[];
}

/**
 * Runs the build from `startWave` twice (runSummonFuzz), each run with the test modules
 * `plant()` returns, and compares the two runs' hashes.
 */
export function runSummonFuzzCase(
  build: SummonFuzzBuild,
  startWave: number,
  ticks: number,
  plant: () => readonly TestModule[] = () => [],
): SummonFuzzCase {
  const runs = [
    runSummonFuzz(build, startWave, ticks, plant()),
    runSummonFuzz(build, startWave, ticks, plant()),
  ] as const;
  const name = `${summonFuzzName(build)} from wave ${startWave}`;
  const failures = runs.flatMap((run, r) =>
    run.failures.map((failure) => ({ ...failure, text: `${name}, run ${r + 1}: ${failure.text}` })),
  );
  const [first, second] = runs;
  if (first.hash !== second.hash) {
    failures.push({ kind: 'hash', text: `${name}: runs differ (${first.hash}, ${second.hash})` });
  }
  return { build, startWave, runs, failures };
}

/**
 * A running 64-bit hash of strings (two 32-bit lanes, mixed as cyrb53 does), for comparing two
 * runs without node:crypto. Equal digests say that the inputs were equal, with a very high
 * probability; it is no fingerprint to record.
 */
export function createRunHash(): { update(text: string): void; digest(): string } {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  return {
    update(text) {
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
      }
    },
    digest() {
      const a = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      const b = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      const hex = (v: number): string => (v >>> 0).toString(16).padStart(8, '0');
      return hex(b) + hex(a);
    },
  };
}
