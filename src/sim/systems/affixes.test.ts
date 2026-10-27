/**
 * The elite affixes (docs/v3 C7 design §2.7, src/data/affixes.ts, src/sim/systems/affixes.ts):
 * the picks, the eight rules and 元素護盾's seven ailment entries. §2.7's OWN tests are named in
 * their titles as (OWN test N), each with a comment naming the planted bug it kills; the rest pin
 * the edge cases and the lead's rulings L2 (the ward is a counter of hit damage, reading A), L4
 * (a child the cap refuses is counted) and L5 (冰霜 reaches the emitters that read cadence).
 *
 * The enemies stand on the line to the player's right, so an enemy `dx` away has dist `dx`;
 * `spawn` gives one its affixes through its spawn origin, as a 增殖 child gets its parent's, so a
 * test does not depend on what a seed draws. The hexagon is v3 data's only elite (tough and no
 * boss); quietV3's types keep their fixture life ratios × HP_SCALE, so the hits a test measures
 * never kill what they land on.
 */

import { describe, expect, it } from 'vitest';
import { mul, num, toNumber, ZERO } from '../../core/num';
import { createRng } from '../../core/rng';
import {
  AFFIX_ARMOURED,
  AFFIX_BERSERK,
  AFFIX_FROST,
  AFFIX_GUARDIAN,
  AFFIX_IDS,
  AFFIX_MULTIPLY,
  AFFIX_REGEN,
  AFFIX_SWIFT,
  AFFIX_WARD,
} from '../../data/affixes';
import type { SourcedEmitter } from '../../data/emitters';
import type { Modifier, StatId } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import { ENEMY_IDS } from '../../data/types';
import type { EnemyDef, EnemyId, GameData, V3WaveRules } from '../../data/types';
import {
  applyBurn,
  applyPoison,
  applyPulseBurn,
  spreadBurn,
  spreadPoison,
} from '../ailments/apply';
import { addBleed } from '../ailments/bleed';
import { addFrost } from '../ailments/frost';
import { addBurn } from '../ailments/records';
import { remainingOf } from '../ailments/remaining';
import { addShock, takenMult } from '../ailments/shock';
import { updateAilments } from './ailments';
import { CENTER } from '../build/sources';
import { ARMOUR_TAKEN } from '../combat/defend';
import { hitWithPayload } from '../combat/hit';
import { createPayload, IGNORE_SHIELD, ROWS } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import {
  eventsOf,
  makeStats,
  placedEnemies,
  rngPositions,
  TEST_ENEMIES,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import type { PlacedEnemy, TestDataOverrides } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DT } from '../types';
import type { SimEvent } from '../types';
import {
  affixCount,
  BERSERK_BELOW,
  BERSERK_MULT,
  FROST_CADENCE,
  FROST_RANGE,
  GUARD_RADIUS,
  guarded,
  MULTIPLY_COUNT,
  MULTIPLY_DROP,
  MULTIPLY_HP,
  MULTIPLY_RADIUS,
  pickAffixes,
  SWIFT_MULT,
  WARD_AILMENT_MULT,
  WARD_BREAK_PCT,
  WARDED,
} from './affixes';
import { resolveContacts } from './contact';
import type { BurnStack, Enemy, RunContext, WaveRecord } from './context';
import { compact, killEnemy, removeEnemy } from './death';
import { stepDrones } from './drones';
import { stepEnemyAi } from './enemyAi';
import { ARMOURED, SHIELDED, STOPPED } from './enemyRecord';
import type { EnemyV3 } from './enemyRecord';
import { rebuildGrid } from './grid';
import { moveEnemies } from './movement';
import { addEnemy, releaseEnemies } from './spawn';
import { startWave } from './waves';

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** The treasure schedule of TEST_V3_WAVES moved past every wave a test reaches. */
const NO_TREASURE = { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 };
/** No crits and no ignites unless a test says so: a hit deals exactly its base. */
const NO_ROLLS = { critChance: 0, igniteChance: 0 };

/** × on every fixture type's life, so the hits a test measures leave their target alive. */
const HP_SCALE = 1e9;

/** The fixture types at HP_SCALE × their life, their ratios kept (the hexagon's 3.5 of it). */
function bigLife(): Partial<Record<EnemyId, Partial<EnemyDef>>> {
  const enemies: Partial<Record<EnemyId, Partial<EnemyDef>>> = {};
  for (const id of ENEMY_IDS) enemies[id] = { hpMult: TEST_ENEMIES[id].hpMult * HP_SCALE };
  return enemies;
}

/**
 * A v3 table whose waves hold no enemy, elite, boss, affix or treasure (docs/v3 C7 design §1.9),
 * so that only the enemies a test places or spawns exist, with the v3 block of `v3`
 * (TEST_V3_WAVES.v3 spread, as v3TestData's merge is shallow) and bigLife's enemies under
 * `enemies`.
 */
function quietV3(
  v3: Partial<V3WaveRules> = {},
  enemies: TestDataOverrides['enemies'] = {},
): GameData {
  return v3TestData({
    enemies: { ...bigLife(), ...enemies },
    waves: {
      rules: [{ enemy: 'triangle', fromWave: 1, base: 0, perWave: 0, maxCount: 0 }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
      v3: { ...TEST_V3_WAVES.v3, affixes: [], treasure: NO_TREASURE, ...v3 },
    },
  });
}

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly mods?: readonly Modifier[];
  readonly grants?: readonly SourcedEmitter[];
  readonly triggers?: readonly TriggerSpec[];
  readonly data?: GameData;
  readonly seed?: number;
}

/** placedEnemies on quietV3's data unless `options.data`, with these stats over NO_ROLLS. */
function placed(enemies: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(enemies, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, options.mods ?? [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    data: options.data ?? quietV3(),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
}

/**
 * An enemy of `type` carrying the affix bits `bits`, added to the open wave `dx` to the player's
 * right (and `dy` below), then moved to exactly that spot as placedEnemies does: a spawn whose
 * origin gives it its affixes, so it draws none.
 */
function spawn(ctx: RunContext, type: EnemyId, dx: number, bits: number, dy = 0): Enemy {
  const def = ctx.data.enemies[type];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const [ux, uy] = dist > 0 ? [dx / dist, dy / dist] : [1, 0];
  addEnemy(ctx, def, ctx.current as WaveRecord, ux as number, uy as number, dist, {
    hpScale: 1,
    radiusScale: 1,
    dropScale: 1,
    extra: false,
    affixes: bits,
  });
  const enemy = ctx.enemies.at(-1) as Enemy;
  enemy.x = enemy.prevX = PLAYER.x + dx;
  enemy.y = enemy.prevY = PLAYER.y + dy;
  rebuildGrid(ctx);
  ctx.events.length = 0;
  return enemy;
}

const record = (e: Enemy): EnemyV3 => e.v3 as EnemyV3;
const hp = (e: Enemy): number => toNumber(e.hp);
const warded = (e: Enemy): boolean => (record(e).defence & WARDED) !== 0;
const signature = (ctx: RunContext): Payload => (ctx.emitters[0] as EmitterRuntime).payload;

/**
 * A payload of the signature's tags, sources, stream and rows at base damage `damage`, with the
 * bypass bits `bypass`.
 */
function payload(ctx: RunContext, damage: number, bypass = 0): Payload {
  const p = signature(ctx);
  return createPayload({
    baseDamage: num(damage),
    tags: p.tags,
    source: p.source,
    jumpSource: p.jumpSource,
    flags: 0,
    rng: p.rng,
    chains: false,
    rollsAilments: true,
    canCrit: true,
    damageMode: ROWS,
    raisesChainJump: false,
    bypass,
    rowsOf: p,
  });
}

/** A primary emitter hit of `damage` on `target`: what hitWithPayload returned. */
const hit = (ctx: RunContext, target: Enemy, damage: number): boolean =>
  hitWithPayload(ctx, target, payload(ctx, damage), 0, 1, null, null, false, 0, -1);

/** Runs tick ctx.now's enemy AI and movement stages, then moves on: the tick's events. */
function tick(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  stepEnemyAi(ctx);
  moveEnemies(ctx);
  const events = [...ctx.events];
  ctx.now++;
  ctx.state.tick++;
  rebuildGrid(ctx);
  return events;
}

/** Every emitter's cadence, which 冰霜 writes (refreshCadence). */
const cadences = (ctx: RunContext): number[] => ctx.emitters.map((em) => em.cadence);

describe('the picks (gd:703, C7/F21)', () => {
  it('counts affixes by the wave: the largest count whose fromWave it has reached (OWN test 1)', () => {
    // Plants `>` for `≥`: the wave an entry starts at would still draw the count before it.
    const table = TEST_V3_WAVES.v3.affixes;
    expect(table).toEqual([
      { fromWave: 5, count: 1 },
      { fromWave: 25, count: 2 },
      { fromWave: 60, count: 3 },
    ]);
    expect([4, 5, 24, 25, 59, 60].map((wave) => affixCount(wave, table))).toEqual([
      0, 1, 1, 2, 2, 3,
    ]);
    // Wave 1 and an empty table draw nothing; a count holds until the next entry.
    expect([1, 6, 26, 61, 1000].map((wave) => affixCount(wave, table))).toEqual([0, 1, 2, 3, 3]);
    expect(affixCount(1000, [])).toBe(0);
    // The largest count reached, not the last entry's: validation only orders `fromWave`.
    const falls = [
      { fromWave: 1, count: 3 },
      { fromWave: 5, count: 1 },
    ];
    expect([1, 4, 5, 60].map((wave) => affixCount(wave, falls))).toEqual([3, 3, 3, 3]);
  });

  it('draws that many distinct affixes, uniformly, on the affixes stream (OWN test 2)', () => {
    // Plants the picks on `spawn`: the other streams would move with them.
    const rng = createRng(7);
    const counts = new Map<string, number>(AFFIX_IDS.map((id) => [id, 0]));
    const draws = 8000;
    for (let i = 0; i < draws; i++) {
      const bits = pickAffixes(rng, 1);
      const drawn = AFFIX_IDS.filter((_, index) => (bits & (1 << index)) !== 0);
      expect(drawn).toHaveLength(1);
      counts.set(drawn[0] as string, (counts.get(drawn[0] as string) as number) + 1);
    }
    // χ² over the eight ids, 7 degrees of freedom: 24.32 is p = 0.999.
    const expected = draws / AFFIX_IDS.length;
    const chi = [...counts.values()].reduce(
      (sum, seen) => sum + (seen - expected) ** 2 / expected,
      0,
    );
    expect(chi).toBeLessThan(24.32);
    // Three affixes at a time are distinct, and a count of 0 draws nothing at all.
    for (let i = 0; i < 200; i++) {
      const bits = pickAffixes(rng, 3);
      expect(AFFIX_IDS.filter((_, index) => (bits & (1 << index)) !== 0)).toHaveLength(3);
    }
    const before = rng.snapshot();
    expect(pickAffixes(rng, 0)).toBe(0);
    expect(rng.snapshot()).toEqual(before);
    // A draw depends on its stream alone, never on the calls before it (a fresh [0 … 7] each
    // time): the same seed draws the same affixes before and after other draws.
    const first = [1, 2, 3].map((count) => pickAffixes(createRng(11), count));
    for (let i = 0; i < 20; i++) pickAffixes(createRng(100 + i), 3);
    expect([1, 2, 3].map((count) => pickAffixes(createRng(11), count))).toEqual(first);
  });

  it('moves no other stream than affixes, and none at all without an affix table (OWN test 2)', () => {
    // Plants the picks on `spawn`: this run's spawn position would move.
    const release = (data: GameData): RunContext => {
      const ctx = placedEnemies([], { data });
      releaseEnemies(ctx);
      return ctx;
    };
    const elites = (v3: Partial<V3WaveRules>): GameData =>
      v3TestData({
        waves: {
          rules: [{ enemy: 'triangle', fromWave: 1, base: 3, perWave: 0, maxCount: 3 }],
          eliteEvery: 1,
          bossEvery: 1000,
          spawnDurationSec: 0,
          waveTimerSec: 1000,
          v3: { ...TEST_V3_WAVES.v3, treasure: NO_TREASURE, ...v3 },
        },
      });
    const drawn = release(elites({ affixes: [{ fromWave: 1, count: 3 }] }));
    const none = release(elites({ affixes: [] }));
    const drawnAt = rngPositions(drawn);
    const noneAt = rngPositions(none);
    expect({ ...drawnAt, affixes: noneAt.affixes }).toEqual(noneAt);
    expect(drawnAt.affixes).not.toEqual(noneAt.affixes);
    // The elite of the wave with no table drew nothing: its stream stands where it started.
    expect(noneAt.affixes).toEqual(rngPositions(placedEnemies([], { data: elites({}) })).affixes);
    const elite = drawn.enemies.find((e) => e.type === 'hexagon') as Enemy;
    expect(AFFIX_IDS.filter((_, i) => (record(elite).affixes & (1 << i)) !== 0)).toHaveLength(3);
    expect(record(none.enemies.find((e) => e.type === 'hexagon') as Enemy).affixes).toBe(0);
  });

  it('draws for an elite alone: no boss, no plain type, and nothing for given bits (OWN test 5)', () => {
    // Plants dropping `!def.boss`, and re-picking for inherited bits: both would draw here.
    const ctx = placed([], { data: quietV3({ affixes: [{ fromWave: 1, count: 1 }] }) });
    const rng = ctx.sys.affixes.rng;
    const before = rng.snapshot();
    const rec = ctx.current as WaveRecord;
    const { triangle, boss, onion, hexagon } = ctx.data.enemies;
    // A plain type is no elite; a boss is tough but never one (gd:703 「菁英」).
    expect([triangle, boss, onion, hexagon].map((def) => [def.tough, def.boss])).toEqual([
      [false, false],
      [true, true],
      [true, true],
      [true, false],
    ]);
    for (const def of [triangle, boss, onion]) {
      addEnemy(ctx, def, rec, 1, 0, 400);
      expect(record(ctx.enemies.at(-1) as Enemy).affixes, def.id).toBe(0);
      expect(rng.snapshot(), def.id).toEqual(before);
    }
    // The elite takes given bits as they are, and draws nothing for them.
    const child = spawn(ctx, hexagon.id, 400, AFFIX_SWIFT | AFFIX_WARD);
    expect(record(child).affixes).toBe(AFFIX_SWIFT | AFFIX_WARD);
    expect(rng.snapshot()).toEqual(before);
    // With no origin it draws its wave's count, which moves the stream.
    addEnemy(ctx, hexagon, rec, 1, 0, 400);
    const elite = ctx.enemies.at(-1) as Enemy;
    expect(rng.snapshot()).not.toEqual(before);
    expect(AFFIX_IDS.filter((_, i) => (record(elite).affixes & (1 << i)) !== 0)).toHaveLength(1);
  });

  it('draws the count of the wave the elite belongs to, however late the cap released it', () => {
    // Plants the count read from the run's current wave: a delayed elite would draw wave 26's.
    // A cap of 1 and waves whose only enemy is their elite: the square placed in wave 1 holds
    // the field, so wave 1's elite waits (enemyCapDelayed) until it is freed.
    const data = quietV3(
      {
        enemyCap: 1,
        affixes: [
          { fromWave: 1, count: 1 },
          { fromWave: 26, count: 3 },
        ],
      },
      {},
    );
    const elite = { ...data.waves, eliteEvery: 1, spawnDurationSec: 0 };
    const ctx = placed([{ x: PLAYER.x + 400, y: PLAYER.y }], {
      data: { ...data, waves: elite },
    });
    expect(ctx.current?.wave).toBe(1);
    releaseEnemies(ctx);
    expect(ctx.counters.enemyCapDelayed).toBe(1);
    expect(ctx.enemies.map((e) => e.type)).toEqual(['square']);
    // Wave 26 opens over it, and the field is freed: wave 1's elite is the first released.
    startWave(ctx, 26);
    const freeField = (): void => {
      for (const enemy of ctx.enemies.filter((e) => e.alive)) removeEnemy(ctx, enemy);
      compact(ctx);
    };
    freeField();
    ctx.now++;
    ctx.state.tick++;
    releaseEnemies(ctx);
    const drawnBy = (enemy: Enemy): number =>
      AFFIX_IDS.filter((_, i) => (record(enemy).affixes & (1 << i)) !== 0).length;
    const first = ctx.enemies.filter((e) => e.alive);
    expect(first.map((e) => [e.type, e.wave])).toEqual([['hexagon', 1]]);
    expect(drawnBy(first[0] as Enemy)).toBe(1);
    // Wave 26's own elite draws three.
    freeField();
    ctx.now++;
    ctx.state.tick++;
    releaseEnemies(ctx);
    const second = ctx.enemies.filter((e) => e.alive);
    expect(second.map((e) => [e.type, e.wave])).toEqual([['hexagon', 26]]);
    expect(drawnBy(second[0] as Enemy)).toBe(3);
  });
});

describe('迅捷 (gd:707)', () => {
  it('doubles the walk step, on the record and on the enemy (OWN test 3: swift)', () => {
    // Plants 迅捷 on baseStep but not stepDist: the first tick's walk would be its def's.
    const ctx = placed([]);
    const def = ctx.data.enemies.hexagon;
    const plain = spawn(ctx, 'hexagon', 500, 0);
    const swift = spawn(ctx, 'hexagon', 500, AFFIX_SWIFT, 1);
    expect(record(plain).baseStep).toBe(def.speed * DT);
    expect(record(swift).baseStep).toBe(def.speed * DT * SWIFT_MULT);
    expect([plain.stepDist, swift.stepDist]).toEqual([def.speed * DT, def.speed * DT * SWIFT_MULT]);
    const [plainBefore, swiftBefore] = [plain.dist, swift.dist];
    tick(ctx);
    expect(plainBefore - plain.dist).toBeCloseTo(def.speed * DT, 10);
    expect(swiftBefore - swift.dist).toBeCloseTo(def.speed * DT * SWIFT_MULT, 10);
    expect(SWIFT_MULT).toBe(2);
  });
});

describe('堅甲 (gd:708)', () => {
  it('halves a hit that lands, and leaves the burn alone (OWN test 3: armoured)', () => {
    // Plants the at-spawn effects running for drawn bits only: an inherited 堅甲 would not armour.
    const ctx = placed([]);
    const plain = spawn(ctx, 'hexagon', 400, 0);
    const armoured = spawn(ctx, 'hexagon', 400, AFFIX_ARMOURED, 1);
    expect(record(plain).defence).toBe(0);
    expect(record(armoured).defence).toBe(ARMOURED);
    const before = hp(plain);
    hit(ctx, plain, 100);
    hit(ctx, armoured, 100);
    expect(before - hp(plain)).toBe(100);
    expect(before - hp(armoured)).toBe(100 * ARMOUR_TAKEN);
    // Burn passes both defences (gd:53): the same dps on either.
    applyBurn(ctx, plain, num(8), ctx.now + 60, 0, CENTER, 1);
    applyBurn(ctx, armoured, num(8), ctx.now + 60, 0, CENTER, 1);
    expect(toNumber(remainingOf(ctx, armoured, 'burn'))).toBe(
      toNumber(remainingOf(ctx, plain, 'burn')),
    );
  });
});

describe('再生 (gd:709)', () => {
  it('regains the regenerator’s share of life a second, through the AI step (OWN test 3: regen)', () => {
    // Plants 再生 reading its own def's regen: the hexagon has none, so nothing would heal.
    const ctx = placed([]);
    const rate = ctx.data.enemies.regenerator.behaviour;
    expect(rate).toEqual({ kind: 'regen', lifePctPerSec: 0.08 });
    const plain = spawn(ctx, 'hexagon', 500, 0);
    const regen = spawn(ctx, 'hexagon', 500, AFFIX_REGEN, 1);
    expect([record(plain).regen, record(regen).regen]).toEqual([0, 0.08]);
    // Only the regenerating one has per-tick work.
    expect(ctx.sys.enemyAi.list).toEqual([regen]);
    const max = toNumber(regen.maxHp);
    regen.hp = mul(regen.maxHp, 0.5);
    plain.hp = mul(plain.maxHp, 0.5);
    tick(ctx);
    expect((hp(regen) - max * 0.5) / (max * 0.08 * DT)).toBeCloseTo(1, 9);
    expect(hp(plain)).toBe(max * 0.5);
  });
});

describe('守護 (gd:710)', () => {
  it('lends the shielder’s block to others in range, inclusive, never to itself (OWN test 3: guardian)', () => {
    // Plants `<` for `≤` at GUARD_RADIUS, and a guardian shielding itself: the neighbour at
    // exactly 160 would take the hit, and the guardian's own hit would be blocked.
    const ctx = placed([]);
    expect(GUARD_RADIUS).toBe(160);
    const guardian = spawn(ctx, 'hexagon', 300, AFFIX_GUARDIAN);
    const near = spawn(ctx, 'square', 300 + GUARD_RADIUS, 0, 0);
    const far = spawn(ctx, 'square', 300 + GUARD_RADIUS + 1, 0, 0);
    expect(ctx.sys.affixes.guardians).toEqual([guardian]);
    expect(ctx.sys.affixes.guardBlockPct).toBe(0.15);
    expect([guarded(ctx, near), guarded(ctx, far), guarded(ctx, guardian)]).toEqual([
      true,
      false,
      false,
    ]);
    // A hit below 15 % of the neighbour's max life is blocked; the one past the radius lands.
    const threshold = toNumber(mul(near.maxHp, 0.15));
    const nearHp = hp(near);
    expect(hit(ctx, near, threshold - 1)).toBe(false);
    expect(hp(near)).toBe(nearHp);
    expect(eventsOf([ctx.events], 'hitBlocked').map((e) => e.targetId)).toEqual([near.id]);
    expect(hit(ctx, far, threshold - 1)).toBe(true);
    expect(hp(far)).toBe(nearHp - (threshold - 1));
    // The guardian takes its own small hit, and the record keeps no shield.
    const guardHp = hp(guardian);
    expect(hit(ctx, guardian, 1)).toBe(true);
    expect(hp(guardian)).toBe(guardHp - 1);
    expect(record(near).defence & SHIELDED).toBe(0);
    expect(record(guardian).defence).toBe(0);
    // A hit that ignores shields passes the lent one too (破盾, C7.3's bypass bit).
    const ignoring = payload(ctx, threshold - 1, IGNORE_SHIELD);
    expect(hitWithPayload(ctx, near, ignoring, 0, 1, null, null, false, 0, -1)).toBe(true);
    expect(hp(near)).toBe(nearHp - (threshold - 1));
    // A hit at or above the threshold lands on the guarded neighbour.
    expect(hit(ctx, near, threshold)).toBe(true);
    expect(hp(near)).toBe(nearHp - (threshold - 1) - threshold);
  });

  it('stops shielding once it is dead, in the same tick', () => {
    // Plants a dead guardian still shielding: the neighbour's small hit would be blocked.
    const ctx = placed([]);
    const guardian = spawn(ctx, 'hexagon', 300, AFFIX_GUARDIAN);
    const near = spawn(ctx, 'square', 300 + 100, 0, 0);
    const threshold = toNumber(mul(near.maxHp, 0.15));
    expect(hit(ctx, near, threshold - 1)).toBe(false);
    killEnemy(ctx, guardian, -1, 0);
    expect(guardian.alive).toBe(false);
    // Still on the list until the next step compacts it, and no longer shielding.
    expect(ctx.sys.affixes.guardians).toEqual([guardian]);
    expect(guarded(ctx, near)).toBe(false);
    const nearHp = hp(near);
    expect(hit(ctx, near, threshold - 1)).toBe(true);
    expect(hp(near)).toBe(nearHp - (threshold - 1));
    // The step drops it.
    tick(ctx);
    expect(ctx.sys.affixes.guardians).toEqual([]);
  });

  it('leaves an enemy with a shield of its own on its own threshold', () => {
    // Plants the scan for an enemy that holds SHIELDED: a guardian's 15 % would replace its own.
    // In v3 data the shielder alone has a shield, at guardBlockPct's 15 %; a square given a
    // stronger one shows which threshold a guarded shield holder keeps.
    const ctx = placed([], {
      data: quietV3({}, { square: { behaviour: { kind: 'shield', blockBelowPct: 0.4 } } }),
    });
    spawn(ctx, 'hexagon', 300, AFFIX_GUARDIAN);
    const near = spawn(ctx, 'square', 300 + 100, 0, 0);
    expect([record(near).blockPct, guarded(ctx, near)]).toEqual([0.4, true]);
    // A hit of 30 % passes the guardian's 15 % but not its own 40 %: blocked.
    const nearHp = hp(near);
    expect(hit(ctx, near, toNumber(mul(near.maxHp, 0.3)))).toBe(false);
    expect(hp(near)).toBe(nearHp);
  });

  it('lends its block to an armoured enemy, tested before the armour (L8)', () => {
    // Plants the scan skipped for an enemy that holds ARMOURED: 堅甲 alone would halve the small
    // hit instead of the lent shield blocking it.
    const ctx = placed([]);
    spawn(ctx, 'hexagon', 300, AFFIX_GUARDIAN);
    const near = spawn(ctx, 'square', 300 + 100, AFFIX_ARMOURED, 0);
    expect([record(near).defence, guarded(ctx, near)]).toEqual([ARMOURED, true]);
    const threshold = toNumber(mul(near.maxHp, ctx.sys.affixes.guardBlockPct));
    const nearHp = hp(near);
    // Below the lent threshold: blocked in full.
    expect(hit(ctx, near, threshold - 1)).toBe(false);
    expect(hp(near)).toBe(nearHp);
    // At it: it passes the lent shield, then the armour halves it.
    expect(hit(ctx, near, threshold)).toBe(true);
    expect(hp(near)).toBe(nearHp - threshold * ARMOUR_TAKEN);
  });

  it('lends its block to another guardian in range, while that one lives (design §2.7)', () => {
    // Plants a guardian never guarded: §2.7 lends the block to any v3 enemy some other live
    // guardian stands near, a guardian included, so two side by side cover each other.
    const ctx = placed([]);
    const first = spawn(ctx, 'hexagon', 300, AFFIX_GUARDIAN);
    const second = spawn(ctx, 'hexagon', 300 + 100, AFFIX_GUARDIAN);
    expect(ctx.sys.affixes.guardians).toEqual([first, second]);
    expect([guarded(ctx, first), guarded(ctx, second)]).toEqual([true, true]);
    const threshold = toNumber(mul(first.maxHp, ctx.sys.affixes.guardBlockPct));
    const firstHp = hp(first);
    expect(hit(ctx, first, threshold - 1)).toBe(false);
    expect(hp(first)).toBe(firstHp);
    // With the other one dead it is on its own again: it never guards itself.
    killEnemy(ctx, second, -1, 0);
    expect(guarded(ctx, first)).toBe(false);
    expect(hit(ctx, first, threshold - 1)).toBe(true);
    expect(hp(first)).toBe(firstHp - (threshold - 1));
  });

  it('measures its reach around itself, not along the line to the player', () => {
    // Plants the range taken as the difference of the two distances to the player: the enemy
    // the same distance away on another side would count as guarded.
    const ctx = placed([]);
    spawn(ctx, 'hexagon', 300, AFFIX_GUARDIAN);
    // As far from the player as the guardian, but 300√2 from it.
    const across = spawn(ctx, 'square', 0, 0, 300);
    // GUARD_RADIUS from the guardian exactly, off the guardian's line.
    const beside = spawn(ctx, 'square', 300, 0, GUARD_RADIUS);
    expect([guarded(ctx, across), guarded(ctx, beside)]).toEqual([false, true]);
    const threshold = toNumber(mul(across.maxHp, ctx.sys.affixes.guardBlockPct));
    const acrossHp = hp(across);
    expect(hit(ctx, across, threshold - 1)).toBe(true);
    expect(hp(across)).toBe(acrossHp - (threshold - 1));
    expect(hit(ctx, beside, threshold - 1)).toBe(false);
  });
});

describe('增殖 (gd:711)', () => {
  it('leaves two smaller elites with its other affixes at its death (OWN test 3: multiply)', () => {
    // Plants children at full hp, radius or drops, and children keeping 增殖: each shows here.
    const ctx = placed([]);
    const parent = spawn(ctx, 'hexagon', 400, AFFIX_MULTIPLY | AFFIX_SWIFT);
    const def = ctx.data.enemies.hexagon;
    const before = rngPositions(ctx);
    killEnemy(ctx, parent, -1, 0);
    // The children's angles are drawn on the split stream, as a split child's are (C7/F8): the
    // spawn and affixes streams do not move, and the inherited bits draw no pick.
    const after = rngPositions(ctx);
    expect(after.split).not.toEqual(before.split);
    expect([after.spawn, after.affixes]).toEqual([before.spawn, before.affixes]);
    const children = ctx.enemies.filter((e) => e.alive);
    expect(children).toHaveLength(MULTIPLY_COUNT);
    expect([MULTIPLY_COUNT, MULTIPLY_HP, MULTIPLY_RADIUS, MULTIPLY_DROP]).toEqual([
      2, 0.25, 0.7, 0.25,
    ]);
    for (const child of children) {
      expect(child.type).toBe('hexagon');
      expect(child.wave).toBe(parent.wave);
      expect(toNumber(child.maxHp)).toBeCloseTo(toNumber(parent.maxHp) * MULTIPLY_HP, 6);
      expect(child.radius).toBeCloseTo(def.radius * MULTIPLY_RADIUS, 10);
      expect(child.contactDist).toBeCloseTo(30 + def.radius * MULTIPLY_RADIUS, 10);
      const v = record(child);
      expect(v.dropScale).toBeCloseTo(MULTIPLY_DROP, 10);
      expect(v.extra).toBe(true);
      // Every other affix, with its at-spawn effect, and never 增殖 again.
      expect(v.affixes).toBe(AFFIX_SWIFT);
      expect(child.stepDist).toBe(def.speed * DT * SWIFT_MULT);
      // On the parent's rim, which is 400 from the player ± its radius.
      const dist = Math.hypot(child.x - parent.x, child.y - parent.y);
      expect(dist).toBeCloseTo(parent.radius, 6);
    }
    // A child's own death multiplies nothing.
    killEnemy(ctx, children[0] as Enemy, -1, 0);
    expect(ctx.enemies.filter((e) => e.alive)).toEqual([children[1]]);
  });

  it('spawns none at the enemy cap and counts each refused child (OWN test 4, L4)', () => {
    // Plants 增殖 skipping the cap: the run would hold more than its cap alive.
    const ctx = placed([], { data: quietV3({ enemyCap: 2 }) });
    const parent = spawn(ctx, 'hexagon', 400, AFFIX_MULTIPLY);
    const other = spawn(ctx, 'square', 500, 0);
    expect(ctx.counters.enemySpawnsSkipped).toBe(0);
    // The parent's removal frees its own slot, so one child fits and the other does not.
    killEnemy(ctx, parent, -1, 0);
    expect(ctx.enemies.filter((e) => e.alive)).toHaveLength(2);
    expect(ctx.counters.enemySpawnsSkipped).toBe(1);
    expect(other.alive).toBe(true);
    // With no room at all, both are refused and counted. `spawn` is addEnemy, which the cap does
    // not hold back, so the two placed enemies fill a cap of 1 between them.
    const full = placed([], { data: quietV3({ enemyCap: 1 }) });
    const alone = spawn(full, 'hexagon', 400, AFFIX_MULTIPLY);
    spawn(full, 'square', 500, 0);
    expect(full.counters.enemySpawnsSkipped).toBe(0);
    killEnemy(full, alone, -1, 0);
    expect(full.enemies.filter((e) => e.alive).map((e) => e.type)).toEqual(['square']);
    expect(full.counters.enemySpawnsSkipped).toBe(MULTIPLY_COUNT);
  });

  it('places its children where a toSplitChildren transfer reaches them', () => {
    // Plants 增殖 before `split`: the transfer's range (ctx.enemies[first ..]) would miss them.
    const ctx = placed([], {
      triggers: [
        {
          on: 'kill',
          do: [
            {
              kind: 'spreadAilment',
              ailment: 'poison',
              radius: 100,
              effect: 0.4,
              toSplitChildren: 0.5,
            },
          ],
        },
      ],
    });
    const elite = spawn(ctx, 'hexagon', 400, AFFIX_MULTIPLY);
    applyPoison(ctx, elite, num(100), ctx.now + 600, 0, CENTER, 4);
    // At a tick whose damage-over-time step has run, a spread moves exactly its share.
    ctx.now = 15;
    updateAilments(ctx);
    const before = toNumber(remainingOf(ctx, elite, 'poison'));
    expect(before).toBeGreaterThan(0);
    // The kill's transfer gives each of its children half of its poison (kill step 2b).
    killEnemy(ctx, elite, -1, 0);
    const children = ctx.enemies.filter((e) => e.alive);
    expect(children.map((child) => child.type)).toEqual(Array(MULTIPLY_COUNT).fill('hexagon'));
    for (const child of children) {
      expect(toNumber(remainingOf(ctx, child, 'poison')) / before).toBeCloseTo(0.5, 9);
      expect(child.poisonStacks).toBe(2);
    }
    expect(ctx.sys.split.passedCount).toBe(0);
  });

  it('puts its children in its own wave record, whatever wave is open', () => {
    // Plants the children given the run's current record: they would join wave 2's.
    const ctx = placed([]);
    const parent = spawn(ctx, 'hexagon', 400, AFFIX_MULTIPLY);
    const own = parent.rec;
    startWave(ctx, 2);
    const later = ctx.current as WaveRecord;
    expect(later).not.toBe(own);
    const [ownAlive, laterAlive] = [own.alive, later.alive];
    killEnemy(ctx, parent, -1, 0);
    const children = ctx.enemies.filter((e) => e.alive);
    expect(children).toHaveLength(MULTIPLY_COUNT);
    for (const child of children) {
      expect(child.rec).toBe(own);
      expect(child.wave).toBe(own.wave);
      expect(toNumber(child.maxHp)).toBeCloseTo(toNumber(parent.maxHp) * MULTIPLY_HP, 6);
    }
    expect([own.alive, later.alive]).toEqual([ownAlive - 1 + MULTIPLY_COUNT, laterAlive]);
  });

  it('leaves no children when it leaks: only a kill multiplies', () => {
    // Plants a leak multiplying too: two children would walk on from the player.
    const ctx = placed([]);
    const parent = spawn(ctx, 'hexagon', 10, AFFIX_MULTIPLY);
    expect(parent.dist).toBeLessThanOrEqual(parent.contactDist);
    const before = rngPositions(ctx);
    resolveContacts(ctx);
    expect([parent.alive, parent.rec.leaked]).toEqual([false, true]);
    expect(ctx.enemies.filter((e) => e.alive)).toEqual([]);
    expect(rngPositions(ctx).split).toEqual(before.split);
    expect(ctx.counters.enemySpawnsSkipped).toBe(0);
  });

  it('draws both children’s angles whatever room the cap leaves (design §2.3, Z6)', () => {
    // Plants the cap test before the angle draw: a refused child would leave the split stream
    // where it was, so every later split, summon and burst would depend on the occupancy.
    const run = (cap: number): RunContext => {
      const ctx = placed([], { data: quietV3({ enemyCap: cap }) });
      const parent = spawn(ctx, 'hexagon', 400, AFFIX_MULTIPLY);
      spawn(ctx, 'square', 500, 0);
      killEnemy(ctx, parent, -1, 0);
      return ctx;
    };
    const [room, one, none] = [run(400), run(2), run(1)];
    expect([room, one, none].map((ctx) => ctx.counters.enemySpawnsSkipped)).toEqual([0, 1, 2]);
    expect(rngPositions(one).split).toEqual(rngPositions(room).split);
    expect(rngPositions(none).split).toEqual(rngPositions(room).split);
  });

  it('gives its children a ward of their own life, and their own counter (元素護盾, Z4)', () => {
    // Plants the children's counter taken from the parent's life: a child would need four times
    // its share of hit damage to break.
    const ctx = placed([]);
    const parent = spawn(ctx, 'hexagon', 400, AFFIX_MULTIPLY | AFFIX_WARD);
    killEnemy(ctx, parent, -1, 0);
    const children = ctx.enemies.filter((e) => e.alive);
    expect(children).toHaveLength(MULTIPLY_COUNT);
    for (const child of children) {
      expect(record(child).affixes).toBe(AFFIX_WARD);
      expect(warded(child)).toBe(true);
      expect(record(child).wardLeft).toBe(mul(child.maxHp, WARD_BREAK_PCT));
      expect(
        toNumber(record(child).wardLeft) / toNumber(mul(parent.maxHp, WARD_BREAK_PCT)),
      ).toBeCloseTo(MULTIPLY_HP, 12);
    }
    // Its own counter in hit damage breaks it.
    const child = children[0] as Enemy;
    hit(ctx, child, toNumber(record(child).wardLeft));
    expect(warded(child)).toBe(false);
    expect(eventsOf([ctx.events], 'wardBroken')).toEqual([
      { type: 'wardBroken', targetId: child.id },
    ]);
  });

  it('shrinks a toSplitChildren transfer onto warded children, keeping its stack counts', () => {
    // Plants the ward on the stack counts of a move too: the children would get fewer stacks.
    const ctx = placed([], {
      triggers: [
        {
          on: 'kill',
          do: [
            {
              kind: 'spreadAilment',
              ailment: 'poison',
              radius: 100,
              effect: 0.4,
              toSplitChildren: 0.5,
            },
          ],
        },
      ],
    });
    const elite = spawn(ctx, 'hexagon', 400, AFFIX_MULTIPLY | AFFIX_WARD);
    applyPoison(ctx, elite, num(100), ctx.now + 600, 0, CENTER, 4);
    ctx.now = 15;
    updateAilments(ctx);
    const before = toNumber(remainingOf(ctx, elite, 'poison'));
    expect(elite.poisonStacks).toBe(4);
    killEnemy(ctx, elite, -1, 0);
    const children = ctx.enemies.filter((e) => e.alive);
    expect(children).toHaveLength(MULTIPLY_COUNT);
    for (const child of children) {
      expect(warded(child)).toBe(true);
      expect(toNumber(remainingOf(ctx, child, 'poison')) / before).toBeCloseTo(
        0.5 * WARD_AILMENT_MULT,
        9,
      );
      expect(child.poisonStacks).toBe(2);
    }
  });
});

describe('狂暴 (gd:712)', () => {
  it('doubles its step and contact damage below half life, and gives them back above it (OWN test 3: berserk)', () => {
    // Plants `≤` for `<` at BERSERK_BELOW, and contactMult left at 2 after healing.
    const ctx = placed([]);
    const def = ctx.data.enemies.hexagon;
    const berserk = spawn(ctx, 'hexagon', 500, AFFIX_BERSERK);
    const v = record(berserk);
    expect([BERSERK_BELOW, BERSERK_MULT]).toEqual([0.5, 2]);
    expect(ctx.sys.enemyAi.list).toEqual([berserk]);
    // At exactly half life it is not raging (strictly below).
    berserk.hp = mul(berserk.maxHp, BERSERK_BELOW);
    tick(ctx);
    expect([v.contactMult, berserk.stepDist]).toEqual([1, def.speed * DT]);
    berserk.hp = mul(berserk.maxHp, 0.4);
    tick(ctx);
    expect([v.contactMult, berserk.stepDist]).toEqual([
      BERSERK_MULT,
      def.speed * DT * BERSERK_MULT,
    ]);
    // Healed back above half life, both are 1 again.
    berserk.hp = mul(berserk.maxHp, 0.6);
    tick(ctx);
    expect([v.contactMult, berserk.stepDist]).toEqual([1, def.speed * DT]);
    // It needs no timer: a frozen elite still reads its life.
    berserk.hp = mul(berserk.maxHp, 0.1);
    berserk.frozenUntil = ctx.now + 60;
    tick(ctx);
    expect(v.contactMult).toBe(BERSERK_MULT);
    // A standing elite keeps the step its behaviour wrote; only the contact damage rages.
    v.state |= STOPPED;
    berserk.stepDist = 0;
    tick(ctx);
    expect([v.contactMult, berserk.stepDist]).toEqual([BERSERK_MULT, 0]);
  });

  it('joins the AI step’s list once, whatever else it carries', () => {
    // Plants a second join for 狂暴: the list would hold the elite twice.
    const ctx = placed([]);
    const both = spawn(ctx, 'hexagon', 500, AFFIX_BERSERK | AFFIX_REGEN);
    const neither = spawn(ctx, 'hexagon', 500, AFFIX_WARD, 1);
    expect(ctx.sys.enemyAi.list).toEqual([both]);
    const v = record(both);
    expect([v.regen, (v.affixes & AFFIX_BERSERK) !== 0]).toEqual([0.08, true]);
    // The regeneration and the rage both run, once each.
    const max = toNumber(both.maxHp);
    both.hp = mul(both.maxHp, 0.4);
    tick(ctx);
    expect(hp(both) - max * 0.4).toBeCloseTo(max * 0.08 * DT, 6);
    expect(v.contactMult).toBe(BERSERK_MULT);
    expect(ctx.sys.enemyAi.list).toEqual([both]);
    expect(neither.stepDist).toBe(ctx.data.enemies.hexagon.speed * DT);
  });

  it('rages from its 迅捷 step: the two multiply (design §2.7, Z7)', () => {
    // Plants the rage written from the def's speed instead of baseStep: a swift elite would
    // lose 迅捷 while it rages and after.
    const ctx = placed([]);
    const def = ctx.data.enemies.hexagon;
    const elite = spawn(ctx, 'hexagon', 500, AFFIX_SWIFT | AFFIX_BERSERK);
    const v = record(elite);
    expect(elite.stepDist).toBe(def.speed * DT * SWIFT_MULT);
    elite.hp = mul(elite.maxHp, 0.4);
    tick(ctx);
    expect([v.contactMult, elite.stepDist]).toEqual([
      BERSERK_MULT,
      def.speed * DT * SWIFT_MULT * BERSERK_MULT,
    ]);
    elite.hp = mul(elite.maxHp, 0.6);
    tick(ctx);
    expect([v.contactMult, elite.stepDist]).toEqual([1, def.speed * DT * SWIFT_MULT]);
  });

  it('reads its life after this tick’s regeneration, frozen or not (Z7)', () => {
    // Plants 狂暴 before 再生 in either branch of the walk: the elite that regeneration lifts
    // past half life this tick would still rage at it.
    const ctx = placed([]);
    const walking = spawn(ctx, 'hexagon', 500, AFFIX_REGEN | AFFIX_BERSERK);
    const frozen = spawn(ctx, 'hexagon', 500, AFFIX_REGEN | AFFIX_BERSERK, 1);
    frozen.frozenUntil = ctx.now + 60;
    // Half a tick's regeneration below half life: this tick's regeneration ends the rage.
    const below = BERSERK_BELOW - (record(walking).regen * DT) / 2;
    for (const elite of [walking, frozen]) {
      elite.hp = mul(elite.maxHp, below);
      expect(record(elite).contactMult).toBe(1);
    }
    tick(ctx);
    for (const elite of [walking, frozen]) {
      expect(hp(elite)).toBeGreaterThan(toNumber(mul(elite.maxHp, BERSERK_BELOW)));
      expect(record(elite).contactMult).toBe(1);
    }
    expect(walking.stepDist).toBe(record(walking).baseStep);
  });
});

describe('元素護盾 (gd:713, lead ruling L2 reading A)', () => {
  const dps = 100;
  const end = (ctx: RunContext): number => ctx.now + 600;

  it('starts at WARD_BREAK_PCT of max life and shrinks every ailment applied (OWN test 3: ward)', () => {
    // Plants the ward missing in addBurn: the burn record would hold its whole dps.
    const ctx = placed([]);
    const plain = spawn(ctx, 'hexagon', 400, 0);
    const ward = spawn(ctx, 'hexagon', 400, AFFIX_WARD, 1);
    expect([WARD_BREAK_PCT, WARD_AILMENT_MULT]).toEqual([0.3, 0.25]);
    expect(record(plain).wardLeft).toBe(ZERO);
    expect(record(ward).wardLeft).toBe(mul(ward.maxHp, WARD_BREAK_PCT));
    expect(record(ward).defence).toBe(WARDED);
    // 1. addBurn (a burn record).
    expect(ctx.burnRings).toBe(false);
    applyBurn(ctx, plain, num(dps), end(ctx), 0, CENTER, 1);
    applyBurn(ctx, ward, num(dps), end(ctx), 0, CENTER, 1);
    expect(toNumber(remainingOf(ctx, ward, 'burn'))).toBeCloseTo(
      toNumber(remainingOf(ctx, plain, 'burn')) * WARD_AILMENT_MULT,
      6,
    );
  });

  it('shrinks a zone’s burn through addBurnIfStronger, and compares it warded (OWN test 3: ward, addBurnIfStronger)', () => {
    // Plants the ward missing at addBurnIfStronger's cap test: the warded stack would give way
    // to a burn weaker than the one it was applied from.
    const ctx = placed([], { values: { burnMaxStacks: 1 } });
    const plain = spawn(ctx, 'hexagon', 400, 0);
    const ward = spawn(ctx, 'hexagon', 400, AFFIX_WARD, 1);
    expect(applyPulseBurn(ctx, plain, num(dps), end(ctx), 0, CENTER, 1)).toBe(true);
    expect(applyPulseBurn(ctx, ward, num(dps), end(ctx), 0, CENTER, 1)).toBe(true);
    expect(toNumber(remainingOf(ctx, ward, 'burn'))).toBeCloseTo(
      toNumber(remainingOf(ctx, plain, 'burn')) * WARD_AILMENT_MULT,
      6,
    );
    // At the cap a weaker burn is refused on both: on the warded one it is weighed warded too.
    expect(applyPulseBurn(ctx, plain, num(dps * 0.75), end(ctx), 0, CENTER, 1)).toBe(false);
    expect(applyPulseBurn(ctx, ward, num(dps * 0.75), end(ctx), 0, CENTER, 1)).toBe(false);
  });

  it('shrinks a ring’s poison through addToRing (OWN test 3: ward, addToRing)', () => {
    // Plants the ward missing in addToRing: the poison ring would hold its whole dps.
    const ctx = placed([]);
    const plain = spawn(ctx, 'hexagon', 400, 0);
    const ward = spawn(ctx, 'hexagon', 400, AFFIX_WARD, 1);
    applyPoison(ctx, plain, num(dps), end(ctx), 0, CENTER, 3);
    applyPoison(ctx, ward, num(dps), end(ctx), 0, CENTER, 3);
    expect(toNumber(remainingOf(ctx, ward, 'poison'))).toBeCloseTo(
      toNumber(remainingOf(ctx, plain, 'poison')) * WARD_AILMENT_MULT,
      6,
    );
    // The stack counts are the same: only the damage is shrunk.
    expect(ward.poisonStacks).toBe(plain.poisonStacks);
  });

  it('shrinks a spread onto itself, not the source’s stacks (OWN test 3: ward, moveRings)', () => {
    // Plants the ward applied to the source's rings: the source would lose damage.
    const ctx = placed([]);
    const source = spawn(ctx, 'square', 400, 0);
    const plain = spawn(ctx, 'square', 410, 0);
    const ward = spawn(ctx, 'hexagon', 420, AFFIX_WARD);
    applyPoison(ctx, source, num(dps), end(ctx), 0, CENTER, 4);
    const before = toNumber(remainingOf(ctx, source, 'poison'));
    spreadPoison(ctx, source, { radius: 200, radiusSq: 200 ** 2, effect: 0.5 }, 1, Infinity, 0);
    expect(toNumber(remainingOf(ctx, source, 'poison'))).toBe(before);
    expect(toNumber(remainingOf(ctx, ward, 'poison'))).toBeCloseTo(
      toNumber(remainingOf(ctx, plain, 'poison')) * WARD_AILMENT_MULT,
      6,
    );
  });

  it('shrinks a bleed before it is compared (OWN test 3: ward, addBleed)', () => {
    // Plants the ward applied after the comparison: a warded bleed would replace a stronger one.
    const ctx = placed([]);
    const plain = spawn(ctx, 'hexagon', 400, 0);
    const ward = spawn(ctx, 'hexagon', 400, AFFIX_WARD, 1);
    expect(addBleed(ctx, plain, num(dps), end(ctx), 0, CENTER)).toBe(true);
    expect(addBleed(ctx, ward, num(dps), end(ctx), 0, CENTER)).toBe(true);
    expect(toNumber(ward.bleedDps)).toBeCloseTo(dps * WARD_AILMENT_MULT, 6);
    expect(toNumber(plain.bleedDps)).toBe(dps);
    // A second bleed of the same damage does not take the slot: the comparison is warded too.
    expect(addBleed(ctx, ward, num(dps), end(ctx), 0, CENTER)).toBe(false);
    expect(toNumber(ward.bleedDps)).toBeCloseTo(dps * WARD_AILMENT_MULT, 6);
  });

  it('shrinks the frost a hit applies (OWN test 3: ward, addFrost)', () => {
    // Plants the ward missing in addFrost: the meter would fill four times as fast.
    const ctx = placed([]);
    const plain = spawn(ctx, 'hexagon', 400, 0);
    const ward = spawn(ctx, 'hexagon', 400, AFFIX_WARD, 1);
    expect(addFrost(ctx, plain, 0.4, CENTER)).toBe(false);
    expect(addFrost(ctx, ward, 0.4, CENTER)).toBe(false);
    expect(plain.frost).toBeCloseTo(0.4, 10);
    expect(ward.frost).toBeCloseTo(0.4 * WARD_AILMENT_MULT, 10);
  });

  it('shrinks the shock term of the damage taken, not the stacks (OWN test 3: ward, takenMult)', () => {
    // Plants the shock stacks reduced instead of the term, and the frozen term reduced too.
    const ctx = placed([], { values: { shockChance: 1, shockMaxStacks: 5, shockEffect: 0.2 } });
    const plain = spawn(ctx, 'hexagon', 400, 0);
    const ward = spawn(ctx, 'hexagon', 400, AFFIX_WARD, 1);
    expect(addShock(ctx, plain, 3, 0)).toBe(true);
    expect(addShock(ctx, ward, 3, 0)).toBe(true);
    expect([plain.shockStacks, ward.shockStacks]).toEqual([3, 3]);
    expect(takenMult(ctx, plain)).toBeCloseTo(1 + 0.2 * 3, 10);
    expect(takenMult(ctx, ward)).toBeCloseTo(1 + 0.2 * 3 * WARD_AILMENT_MULT, 10);
    // The frozen term is not shrunk: only the shock term is.
    plain.frozenUntil = ctx.now + 60;
    ward.frozenUntil = ctx.now + 60;
    const frozen = ctx.frozenDamageTaken;
    expect(frozen).toBeGreaterThan(0);
    expect(takenMult(ctx, ward)).toBeCloseTo(1 + frozen + 0.2 * 3 * WARD_AILMENT_MULT, 10);
    expect(takenMult(ctx, plain)).toBeCloseTo(1 + frozen + 0.2 * 3, 10);
  });

  it('breaks after WARD_BREAK_PCT of its max life in hit damage, once (OWN test 3: ward, break)', () => {
    // Plants WARDED cleared at `< 0` only, and wardBroken pushed on every later hit.
    const ctx = placed([]);
    const ward = spawn(ctx, 'hexagon', 400, AFFIX_WARD);
    const v = record(ward);
    const counter = toNumber(mul(ward.maxHp, WARD_BREAK_PCT));
    expect(toNumber(v.wardLeft)).toBe(counter);
    // A hit takes life in full and the counter by what it landed (reading A).
    const before = hp(ward);
    hit(ctx, ward, counter / 2);
    expect(hp(ward)).toBe(before - counter / 2);
    expect(toNumber(v.wardLeft)).toBeCloseTo(counter / 2, 6);
    expect(warded(ward)).toBe(true);
    expect(eventsOf([ctx.events], 'wardBroken')).toEqual([]);
    // The hit that takes it to exactly 0 breaks it.
    ctx.events.length = 0;
    hit(ctx, ward, counter / 2);
    expect(toNumber(v.wardLeft)).toBeCloseTo(0, 6);
    expect(warded(ward)).toBe(false);
    expect(eventsOf([ctx.events], 'wardBroken')).toEqual([
      { type: 'wardBroken', targetId: ward.id },
    ]);
    // No second event, and ailments are no longer shrunk.
    ctx.events.length = 0;
    hit(ctx, ward, 10);
    expect(eventsOf([ctx.events], 'wardBroken')).toEqual([]);
    applyBurn(ctx, ward, num(dps), end(ctx), 0, CENTER, 1);
    expect(toNumber((ward.burns[0] as BurnStack).dps)).toBe(dps);
    // An armoured one still goes through defend after the break, and pushes no second event:
    // the hit of twice its counter lands the counter through 堅甲 and breaks it exactly.
    const both = spawn(ctx, 'hexagon', 400, AFFIX_WARD | AFFIX_ARMOURED, 2);
    hit(ctx, both, toNumber(record(both).wardLeft) / ARMOUR_TAKEN);
    expect(warded(both)).toBe(false);
    expect(eventsOf([ctx.events], 'wardBroken')).toEqual([
      { type: 'wardBroken', targetId: both.id },
    ]);
    ctx.events.length = 0;
    hit(ctx, both, 10);
    expect(eventsOf([ctx.events], 'wardBroken')).toEqual([]);
  });

  it('keeps its counter where a hit was blocked in full, and shrinks nothing else', () => {
    // Plants a full block subtracting the hit: a blocked hit would break the ward.
    const ctx = placed([]);
    const ward = spawn(ctx, 'shielder', 400, AFFIX_WARD);
    const v = record(ward);
    expect(v.defence).toBe(SHIELDED | WARDED);
    const counter = toNumber(v.wardLeft);
    const threshold = toNumber(mul(ward.maxHp, v.blockPct));
    expect(hit(ctx, ward, threshold - 1)).toBe(false);
    expect(toNumber(v.wardLeft)).toBe(counter);
    // A hit that passes the shield lowers it by what it landed, not by its damage.
    expect(hit(ctx, ward, threshold)).toBe(true);
    expect(toNumber(v.wardLeft)).toBeCloseTo(counter - threshold, 6);
  });

  it('lets the hit that breaks it apply its own ailments unwarded', () => {
    // Plants the ward applied after the hit's ailments: they would be shrunk too.
    const ctx = placed([], { values: { igniteChance: 1, burnDamage: 1 } });
    const ward = spawn(ctx, 'hexagon', 400, AFFIX_WARD);
    const plain = spawn(ctx, 'hexagon', 400, 0, 1);
    expect(toNumber(ward.maxHp)).toBe(toNumber(plain.maxHp));
    // One hit past the whole counter: it breaks the ward, then ignites unwarded.
    hit(ctx, ward, toNumber(mul(ward.maxHp, WARD_BREAK_PCT)));
    expect(warded(ward)).toBe(false);
    hit(ctx, plain, toNumber(mul(plain.maxHp, WARD_BREAK_PCT)));
    expect(ward.burnStacks).toBe(1);
    expect(toNumber(remainingOf(ctx, ward, 'burn'))).toBeCloseTo(
      toNumber(remainingOf(ctx, plain, 'burn')),
      6,
    );
  });

  it('compares the warded damage in addBurnIfStronger and wards it once (OWN test 7)', () => {
    // Plants the ward applied twice through addBurnIfStronger (the comparison and addBurn).
    const ctx = placed([], { values: { burnMaxStacks: 1 } });
    const ward = spawn(ctx, 'hexagon', 400, AFFIX_WARD);
    expect(ctx.burnCap).toBe(1);
    // The first stack is the warded dps, applied once.
    expect(applyPulseBurn(ctx, ward, num(dps), end(ctx), 0, CENTER, 1)).toBe(true);
    const stack = ward.burns[0] as BurnStack;
    expect(toNumber(stack.dps)).toBeCloseTo(dps * WARD_AILMENT_MULT, 6);
    // At the cap, a weaker pulse burn is refused: the comparison is warded as well, so a dps
    // that would beat the unwarded stack but not the warded one changes nothing.
    expect(applyPulseBurn(ctx, ward, num(dps / 2), end(ctx), 0, CENTER, 1)).toBe(false);
    expect(toNumber((ward.burns[0] as BurnStack).dps)).toBeCloseTo(dps * WARD_AILMENT_MULT, 6);
    // A stronger one replaces it, warded exactly once.
    expect(applyPulseBurn(ctx, ward, num(dps * 2), end(ctx), 0, CENTER, 1)).toBe(true);
    expect(toNumber((ward.burns[0] as BurnStack).dps)).toBeCloseTo(dps * 2 * WARD_AILMENT_MULT, 6);
    expect(ward.burns).toHaveLength(1);
  });

  it('shrinks a burn spread onto it through addBurn, the source keeping its stacks', () => {
    // Plants the ward read from the spread's source: the receivers would differ the other way.
    const ctx = placed([]);
    const source = spawn(ctx, 'square', 400, 0);
    const plain = spawn(ctx, 'square', 410, 0);
    const ward = spawn(ctx, 'hexagon', 420, AFFIX_WARD);
    addBurn(ctx, source, num(dps), end(ctx), 0, CENTER);
    const before = toNumber(remainingOf(ctx, source, 'burn'));
    const spread = { radius: 200, radiusSq: 200 ** 2, effect: 0.5 };
    ctx.events.length = 0;
    // The spreadAilment effect's own path, which copies the records (spreadBurns).
    spreadBurn(ctx, source, spread, 0);
    expect(toNumber(remainingOf(ctx, source, 'burn'))).toBe(before);
    expect(toNumber(remainingOf(ctx, ward, 'burn'))).toBeCloseTo(
      toNumber(remainingOf(ctx, plain, 'burn')) * WARD_AILMENT_MULT,
      6,
    );
  });

  it('keeps a spread’s stack counts on a warded receiver: only the damage shrinks (Z8)', () => {
    // Plants the ward on moveRings' stack share too: the warded receiver would get fewer stacks.
    const ctx = placed([]);
    const source = spawn(ctx, 'square', 400, 0);
    const plain = spawn(ctx, 'square', 410, 0);
    const ward = spawn(ctx, 'hexagon', 420, AFFIX_WARD);
    applyPoison(ctx, source, num(dps), end(ctx), 0, CENTER, 4);
    spreadPoison(ctx, source, { radius: 200, radiusSq: 200 ** 2, effect: 0.5 }, 1, Infinity, 0);
    expect(plain.poisonStacks).toBe(4);
    expect(ward.poisonStacks).toBe(plain.poisonStacks);
    expect(source.poisonStacks).toBe(4);
  });
});

describe('冰霜 (gd:714, lead ruling L5)', () => {
  it('slows every emitter’s cadence to 0.75 within 300, and gives it back exactly (OWN test 3: frost)', () => {
    // Plants `<` for `≤` at FROST_RANGE, factors multiplied per elite, and refreshCadence only
    // on the way down.
    const ctx = placed([]);
    expect([FROST_RANGE, FROST_CADENCE]).toEqual([300, 0.75]);
    expect(cadences(ctx)).toEqual(ctx.emitters.map(() => 1));
    // Two frost elites, one at exactly the range and one past it.
    const near = spawn(ctx, 'hexagon', FROST_RANGE, AFFIX_FROST);
    const far = spawn(ctx, 'hexagon', FROST_RANGE + 1, AFFIX_FROST, 0);
    expect(ctx.sys.affixes.frostElites).toEqual([near, far]);
    expect([near.dist, far.dist]).toEqual([FROST_RANGE, FROST_RANGE + 1]);
    near.stepDist = 0;
    far.stepDist = 0;
    tick(ctx);
    expect(ctx.sys.affixes.frostFactor).toBe(FROST_CADENCE);
    expect(cadences(ctx)).toEqual(ctx.emitters.map(() => FROST_CADENCE));
    // One factor however many are in range: no stacking.
    far.dist = FROST_RANGE - 50;
    tick(ctx);
    expect(ctx.sys.affixes.frostFactor).toBe(FROST_CADENCE);
    expect(cadences(ctx)).toEqual(ctx.emitters.map(() => FROST_CADENCE));
    far.dist = FROST_RANGE + 1;
    // The one at exactly the range is what counts: push it out and the factor is exactly 1.
    near.dist = FROST_RANGE + 1;
    tick(ctx);
    expect(ctx.sys.affixes.frostFactor).toBe(1);
    expect(cadences(ctx)).toEqual(ctx.emitters.map(() => 1));
    // A dead frost elite does not count, and leaves the list.
    near.dist = FROST_RANGE;
    tick(ctx);
    expect(ctx.sys.affixes.frostFactor).toBe(FROST_CADENCE);
    removeEnemy(ctx, near);
    tick(ctx);
    expect(ctx.sys.affixes.frostFactor).toBe(1);
    expect(ctx.sys.affixes.frostElites).toEqual([far]);
  });

  it('reaches the drones’ speed and dock time through em.cadence (OWN test 6)', () => {
    // Plants cadence written on the volley emitters only: the drones would keep their speed.
    const grants = [{ source: 'outer.summon', grant: { kind: 'drone' as const, drones: 1 } }];
    // What one drone tick does with and without a frost elite in range: how far its dock time
    // ran down, and how far it flew once the dock was over.
    const droneTick = (frost: boolean): { dock: number; dash: number } => {
      const ctx = placed([{ x: PLAYER.x + 600, y: PLAYER.y }], { grants });
      if (frost) {
        const elite = spawn(ctx, 'hexagon', FROST_RANGE, AFFIX_FROST);
        elite.stepDist = 0;
      }
      stepEnemyAi(ctx);
      const ds = ctx.sys.drones;
      expect(ds.count).toBe(1);
      ds.dockLeft[0] = 100;
      stepDrones(ctx);
      const dock = 100 - (ds.dockLeft[0] as number);
      ds.dockLeft[0] = 0;
      stepDrones(ctx);
      const dash = Math.hypot(
        (ds.x[0] as number) - (ds.prevX[0] as number),
        (ds.y[0] as number) - (ds.prevY[0] as number),
      );
      return { dock, dash };
    };
    const plain = droneTick(false);
    expect(plain.dock).toBeGreaterThan(0);
    expect(plain.dash).toBeGreaterThan(0);
    const slowed = droneTick(true);
    expect(slowed.dock).toBeCloseTo(plain.dock * FROST_CADENCE, 10);
    expect(slowed.dash).toBeCloseTo(plain.dash * FROST_CADENCE, 10);
  });

  it('leaves every cadence at 1 while its frost elites are all out of range', () => {
    // Plants the factor taken from a frost elite at any distance: 400 is past FROST_RANGE.
    const ctx = placed([]);
    spawn(ctx, 'hexagon', 400, AFFIX_FROST);
    tick(ctx);
    expect(ctx.sys.affixes.frostFactor).toBe(1);
    expect(cadences(ctx)).toEqual(ctx.emitters.map(() => 1));
  });

  it('gives the cadence back when its last frost elite dies in range', () => {
    // Plants the factor left alone once the list is empty: the run would keep 0.75 for good.
    const ctx = placed([]);
    const elite = spawn(ctx, 'hexagon', FROST_RANGE - 100, AFFIX_FROST);
    elite.stepDist = 0;
    tick(ctx);
    expect(cadences(ctx)).toEqual(ctx.emitters.map(() => FROST_CADENCE));
    killEnemy(ctx, elite, -1, 0);
    tick(ctx);
    expect(ctx.sys.affixes.frostElites).toEqual([]);
    expect(ctx.sys.affixes.frostFactor).toBe(1);
    expect(cadences(ctx)).toEqual(ctx.emitters.map(() => 1));
  });
});

describe('the affix state', () => {
  it('starts empty, with a cadence factor of exactly 1, and an M1 run never fills it', () => {
    const v3 = placed([]);
    expect(v3.sys.affixes.frostFactor).toBe(1);
    expect([v3.sys.affixes.guardians, v3.sys.affixes.frostElites]).toEqual([[], []]);
    expect(v3.sys.affixes.guardBlockPct).toBe(0.15);
    // An M1 run has no record and no affix: the lists stay empty and the picks never draw.
    const m1 = placedEnemies([{ x: PLAYER.x + 400, y: PLAYER.y, type: 'hexagon' }]);
    const before = m1.sys.affixes.rng.snapshot();
    const enemy = m1.enemies[0] as Enemy;
    expect(enemy.v3).toBeNull();
    expect([m1.sys.affixes.guardians, m1.sys.affixes.frostElites]).toEqual([[], []]);
    expect(m1.sys.affixes.rng.snapshot()).toEqual(before);
    expect(m1.sys.affixes.guardBlockPct).toBe(0.15);
    for (let i = 0; i < 10; i++) {
      stepDrones(m1);
      m1.now++;
    }
    expect(cadences(m1)).toEqual(m1.emitters.map(() => 1));
  });

  it('keeps both lists in id order, as they join and through the step’s compaction', () => {
    // Plants a compaction that swaps the last entry into a dead one's place.
    const ctx = placed([]);
    const both = AFFIX_GUARDIAN | AFFIX_FROST;
    const elites = [600, 700, 800, 900].map((dx) => spawn(ctx, 'hexagon', dx, both));
    const ids = (list: readonly Enemy[]): number[] => list.map((e) => e.id);
    const sorted = ids(elites);
    expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
    expect([ids(ctx.sys.affixes.guardians), ids(ctx.sys.affixes.frostElites)]).toEqual([
      sorted,
      sorted,
    ]);
    // The first dies: the step drops it and keeps the rest in their order.
    killEnemy(ctx, elites[0] as Enemy, -1, 0);
    tick(ctx);
    const rest = sorted.slice(1);
    expect([ids(ctx.sys.affixes.guardians), ids(ctx.sys.affixes.frostElites)]).toEqual([
      rest,
      rest,
    ]);
  });

  it('numbers bit i of the record for AFFIX_IDS[i] (Z3)', () => {
    // Plants two AFFIX_* bits swapped: the renderer and the balance checks, which read bit i as
    // AFFIX_IDS[i], would name the wrong affix.
    expect([
      AFFIX_SWIFT,
      AFFIX_ARMOURED,
      AFFIX_REGEN,
      AFFIX_GUARDIAN,
      AFFIX_MULTIPLY,
      AFFIX_BERSERK,
      AFFIX_WARD,
      AFFIX_FROST,
    ]).toEqual(AFFIX_IDS.map((_, i) => 1 << i));
    expect(AFFIX_IDS).toEqual([
      'swift',
      'armoured',
      'regen',
      'guardian',
      'multiply',
      'berserk',
      'ward',
      'frost',
    ]);
  });
});
