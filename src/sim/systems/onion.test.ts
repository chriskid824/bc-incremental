/**
 * The onion boss (docs/v3 C7 design §2.8, src/sim/systems/onion.ts): its shells break at the two
 * lethal tests, a hit's (applyHitDamage) and a damage-over-time step's (dealDot), whatever path
 * the damage took; a break bursts, refills and kills nothing, the damage past the shell
 * discarded (lead ruling L6); the last shell bursts too and falls through to the kill, which pays
 * the drops once. The design's OWN tests are named in their titles, each with the bug it plants;
 * calibration's (OWN test 9) is in src/meta/web/calibrate.test.ts. Onions here are placed with
 * their shell's hp as their max life, and stand still.
 */

import { describe, expect, it } from 'vitest';
import { mul, num, toNumber } from '../../core/num';
import type { EmitterGrant } from '../../data/emitters';
import { ORBIT_DEFAULTS } from '../../data/emitters';
import type { RuleSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { addFrost } from '../ailments/frost';
import { doomed } from '../ailments/apply';
import { BURN_TICK_INTERVAL } from '../ailments/records';
import { CENTER } from '../build/sources';
import { hitWithPayload } from '../combat/hit';
import { dispatchPendingKills } from '../effects/dispatch';
import { runEffectQueue } from '../effects/execute';
import { KILL_BY_HIT, KILL_BY_POISON, KILLED } from '../effects/flags';
import { runAura } from '../emitters/aura';
import { runOrbit } from '../emitters/orbit';
import { createPayload, ROWS } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import {
  eventsOf,
  makeStats,
  placedEnemies,
  rngPositions,
  TEST_ENEMIES,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, TICK_RATE } from '../types';
import type { SimEvent } from '../types';
import { updateAilments } from './ailments';
import { resolveContacts } from './contact';
import type { Enemy, RunContext, WaveRecord } from './context';
import { impactAt } from './drones';
import type { EnemyV3 } from './enemyRecord';
import { addEnemy } from './spawn';
import { startWave } from './waves';
import { addZone, stepZones } from './zones';

const TAU = Math.PI * 2;

/** The player, at the arena's centre; the enemies stand on the line to its right. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const at = (dx: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y,
  ...more,
});
/** An onion `dx` right of the player whose shell holds `hp`. */
const onionAt = (dx: number, hp = 100): PlacedEnemy => at(dx, { type: 'onion', hp });

/** Damage 10, and no crits or ignites unless a test says so: a hit deals exactly its base. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 } as const;
const HEAL: TriggerSpec['do'] = [{ kind: 'heal', lifePct: 0.01 }];

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly triggers?: readonly TriggerSpec[];
  readonly emitters?: readonly (readonly [string, EmitterGrant])[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
  readonly data?: GameData;
  readonly seed?: number;
}

/**
 * placedEnemies on a v3 run's data (v3TestData unless `data` says otherwise), so every enemy
 * holds its record, with these stats over NO_ROLLS, center triggers, emitter grants, rules and
 * modules.
 */
function scene(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: (options.emitters ?? []).map(([source, grant]) => ({ source, grant })),
    }),
    data: options.data ?? v3TestData(),
    rules: options.rules ?? [],
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const record = (e: Enemy): EnemyV3 => e.v3 as EnemyV3;
const hp = (e: Enemy): number => toNumber(e.hp);
const signature = (ctx: RunContext): Payload => (ctx.emitters[0] as EmitterRuntime).payload;
const emitter = (ctx: RunContext, i = 1): EmitterRuntime => ctx.emitters[i] as EmitterRuntime;

/** A payload of the signature's tags, sources, stream and rows at base damage `damage`. */
function payload(ctx: RunContext, damage: number): Payload {
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
    rowsOf: p,
  });
}

/** A primary emitter hit of `p` on `target` at scale 1, at `depth`, from no trigger. */
const hit = (ctx: RunContext, target: Enemy, p: Payload, depth = 0): boolean =>
  hitWithPayload(ctx, target, p, 0, 1, null, null, false, depth, -1);

/** The onionLayer events as [onion, layersLeft]. */
const layers = (ctx: RunContext): [number, number][] =>
  eventsOf([ctx.events], 'onionLayer').map((e) => [e.enemyId, e.layersLeft]);
const killed = (ctx: RunContext): number[] =>
  eventsOf([ctx.events], 'enemyKilled').map((e) => e.enemyId);
const spawned = (ctx: RunContext): number =>
  eventsOf([ctx.events], 'enemySpawned').filter((e) => e.enemy === 'triangle').length;

/** The event types in order, a run of one type as `type×n`. */
function shape(events: readonly SimEvent[]): string[] {
  const out: string[] = [];
  let last = '';
  let n = 0;
  const flush = (): void => {
    if (n > 0) out.push(n === 1 ? last : `${last}×${n}`);
  };
  for (const e of events) {
    if (e.type === last) n++;
    else {
      flush();
      last = e.type;
      n = 1;
    }
  }
  flush();
  return out;
}

/** Steps the ailments every tick up to the next damage-over-time step, on tick `to`. */
function stepTo(ctx: RunContext, to: number): void {
  while (ctx.now < to) {
    ctx.now++;
    updateAilments(ctx);
  }
}

/** What one shell's break left of the onion, and what it raised. */
function oneBreak(ctx: RunContext, onion: Enemy) {
  return {
    layersLeft: record(onion).layersLeft,
    alive: onion.alive,
    full: onion.hp === onion.maxHp,
    layers: layers(ctx),
    killed: killed(ctx),
    burst: spawned(ctx),
  };
}

const BROKEN_ONCE = { layersLeft: 2, alive: true, full: true, killed: [], burst: 12 };

describe('the shells', () => {
  it('break one a lethal hit, three in one tick, the last bursting too and killing (OWN test 1)', () => {
    // Planted bug: two bursts and no last-layer burst.
    const ctx = scene([onionAt(300)]);
    const onion = enemy(ctx, 1);
    expect(record(onion).layersLeft).toBe(3);
    const after: [number, boolean, number][] = [];
    for (let n = 0; n < 3; n++) {
      hit(ctx, onion, payload(ctx, 150));
      after.push([record(onion).layersLeft, onion.alive, hp(onion)]);
    }
    expect(after).toEqual([
      [2, true, 100],
      [1, true, 100],
      [0, false, -50],
    ]);
    expect(eventsOf([ctx.events], 'onionLayer')).toEqual(
      [2, 1, 0].map((layersLeft) => ({
        type: 'onionLayer',
        enemyId: 1,
        layersLeft,
        x: onion.x,
        y: onion.y,
      })),
    );
    // Each break's burst follows its hit and comes before its onionLayer; the kill comes last.
    const one = ['hit', 'enemySpawned×12', 'onionLayer'];
    expect(shape(ctx.events)).toEqual([...one, ...one, ...one, 'enemyKilled']);
    expect(killed(ctx)).toEqual([1]);
    expect(spawned(ctx)).toBe(36);
    expect(ctx.enemies.length).toBe(37);
    expect(ctx.kills).toBe(1);
  });

  it('take one shell a hit of 10 × its hp, the excess discarded, the hit event whole (OWN test 7)', () => {
    // Planted bugs: a carry-over loop breaking a shell per layer's hp; the overkill kept.
    const ctx = scene([onionAt(300)]);
    const onion = enemy(ctx, 1);
    hit(ctx, onion, payload(ctx, 1000));
    expect(oneBreak(ctx, onion)).toEqual({ ...BROKEN_ONCE, layers: [[1, 2]] });
    expect(hp(onion)).toBe(100);
    // The hit event and the tallies keep the hit's full amount.
    expect(eventsOf([ctx.events], 'hit').map((e) => toNumber(e.amount))).toEqual([1000]);
    expect(toNumber(ctx.maxHit)).toBe(1000);
    expect(toNumber(ctx.damageHit)).toBe(1000);
    // The next lethal hit takes the next shell, and only it.
    hit(ctx, onion, payload(ctx, 1e9));
    expect([record(onion).layersLeft, onion.alive, hp(onion)]).toEqual([1, true, 100]);
  });

  it('hold one shell’s share of the def’s hpMult when spawned, the def keeping the total', () => {
    // Planted bug: the full hpMult on every shell.
    const ctx = scene([]);
    const rec = ctx.current as WaveRecord;
    addEnemy(ctx, ctx.data.enemies.onion, rec, 1, 0, 600);
    addEnemy(ctx, ctx.data.enemies.square, rec, 1, 0, 600);
    const [onion, square] = [enemy(ctx, 1), enemy(ctx, 2)];
    expect(TEST_ENEMIES.onion.hpMult).toBe(28);
    expect(onion.hp).toBe(mul(num(28 / 3), rec.stdHp));
    expect([onion.maxHp, record(onion).layersLeft]).toEqual([onion.hp, 3]);
    // Every other def keeps its hp, and has no shell.
    expect(square.hp).toBe(mul(num(1), rec.stdHp));
    expect(record(square).layersLeft).toBe(0);
  });
});

describe('every kill path (OWN test 2)', () => {
  // Planted bug: the check only in hitWithPayload, which pulses and damage over time pass by.
  it('breaks a shell at an emitter hit: an orb the tough grid pass finds at the onion’s radius 70', () => {
    // On tick 15 ring 0's one orb sits RING_0 below the player; the onion's edge meets it.
    const ring = ORBIT_DEFAULTS.ringRadius[0];
    const reach = 70 + ORBIT_DEFAULTS.orbRadius;
    const ctx = scene([{ x: PLAYER.x - reach + 1, y: PLAYER.y + ring, type: 'onion', hp: 1 }], {
      emitters: [['outer.aura', { kind: 'orbit', count: 1 }]],
    });
    const onion = enemy(ctx, 1);
    expect([onion.tough, onion.radius > ctx.shotPad]).toEqual([true, true]);
    ctx.now = 15;
    const a = (TAU * ORBIT_DEFAULTS.revPerSec * 15) / TICK_RATE;
    const orb = { x: PLAYER.x + ring * Math.cos(a), y: PLAYER.y + ring * Math.sin(a) };
    expect(Math.hypot(onion.x - orb.x, onion.y - orb.y)).toBeGreaterThan(
      ORBIT_DEFAULTS.orbRadius + ctx.shotPad,
    );
    runOrbit(ctx, emitter(ctx));
    expect(oneBreak(ctx, onion)).toEqual({ ...BROKEN_ONCE, layers: [[1, 2]] });
  });

  it('breaks a shell at an aura’s pulse', () => {
    const ctx = scene([onionAt(100, 1)], { emitters: [['outer.aura', { kind: 'aura' }]] });
    const onion = enemy(ctx, 1);
    // The aura at emitter index 1 pulses on the ticks of remainder 7 by 15.
    ctx.now = 7;
    runAura(ctx, emitter(ctx));
    expect(eventsOf([ctx.events], 'pulse').map((e) => e.hits)).toEqual([1]);
    expect(oneBreak(ctx, onion)).toEqual({ ...BROKEN_ONCE, layers: [[1, 2]] });
  });

  it('breaks a shell at a zone’s tick', () => {
    const ctx = scene([onionAt(300, 1)]);
    const onion = enemy(ctx, 1);
    const p = signature(ctx);
    addZone(ctx, true, onion.x, onion.y, 50, 4, p, 1, p.source, -1, 0, -1);
    ctx.events.length = 0;
    while (layers(ctx).length === 0 && ctx.now < 40) {
      ctx.now++;
      stepZones(ctx);
    }
    expect(eventsOf([ctx.events], 'pulse').map((e) => e.hits)).toEqual([1]);
    expect(oneBreak(ctx, onion)).toEqual({ ...BROKEN_ONCE, layers: [[1, 2]] });
  });

  it.each([
    ['burn', { igniteChance: 1 }, 'burnTick'],
    ['poison', { poisonChance: 1 }, 'dotTick'],
    ['bleed', { bleedChance: 1 }, 'dotTick'],
  ] as const)('breaks a shell at a %s step', (_ailment, values, tick) => {
    const ctx = scene([onionAt(300, 1e6)], { values });
    const onion = enemy(ctx, 1);
    hit(ctx, onion, payload(ctx, 10));
    // A step of a few hp now empties the shell.
    onion.hp = num(1e-9);
    ctx.events.length = 0;
    stepTo(ctx, BURN_TICK_INTERVAL);
    expect(shape(ctx.events)).toEqual([tick, 'enemySpawned×12', 'onionLayer']);
    expect(oneBreak(ctx, onion)).toEqual({ ...BROKEN_ONCE, layers: [[1, 2]] });
    expect(hp(onion)).toBe(1e6);
  });

  it('bursts the last shell at a damage-over-time step too, and the step kills the onion', () => {
    const ctx = scene([onionAt(300, 1e6)], { values: { poisonChance: 1 } });
    const onion = enemy(ctx, 1);
    hit(ctx, onion, payload(ctx, 10));
    record(onion).layersLeft = 1;
    onion.hp = num(1e-9);
    ctx.events.length = 0;
    stepTo(ctx, BURN_TICK_INTERVAL);
    expect(shape(ctx.events)).toEqual(['dotTick', 'enemySpawned×12', 'onionLayer', 'enemyKilled']);
    expect(layers(ctx)).toEqual([[1, 0]]);
    expect([onion.alive, onion.killKind]).toEqual([false, KILL_BY_POISON]);
  });

  it('breaks a shell at a shatter, which takes the frozen victim’s max life', () => {
    const ctx = scene([at(0, { hp: 1000 }), onionAt(60, 100)], { values: { frostOnHit: 0.1 } });
    const [victim, onion] = [enemy(ctx, 1), enemy(ctx, 2)];
    ctx.now = 5;
    addFrost(ctx, victim, 1, CENTER);
    victim.hp = num(1e-9);
    hit(ctx, victim, payload(ctx, 10));
    expect(victim.alive).toBe(false);
    dispatchPendingKills(ctx);
    ctx.now++;
    ctx.events.length = 0;
    runEffectQueue(ctx);
    // 15 % of the victim's 1000 on a shell of 100.
    expect(eventsOf([ctx.events], 'hit').map((e) => [e.targetId, toNumber(e.amount)])).toEqual([
      [2, 150],
    ]);
    expect(oneBreak(ctx, onion)).toEqual({ ...BROKEN_ONCE, layers: [[2, 2]] });
  });

  it('breaks a shell at thorns, and the onion it leaves leaks at the same touch', () => {
    const ctx = scene([at(0, { type: 'onion', hp: 20 })], {
      values: { maxLife: 1000 },
      emitters: [['outer.thorns', { kind: 'thorns' }]],
    });
    const onion = enemy(ctx, 1);
    resolveContacts(ctx);
    // Thorns 3 × damage 10: 30 on a shell of 20.
    expect(shape(ctx.events)).toEqual(['hit', 'enemySpawned×12', 'onionLayer', 'playerHit']);
    expect(oneBreak(ctx, onion)).toEqual({
      ...BROKEN_ONCE,
      alive: false,
      layers: [[1, 2]],
    });
    expect(ctx.kills).toBe(0);
  });

  it('breaks a shell at a drone’s impact', () => {
    const ctx = scene([onionAt(300, 1)], {
      emitters: [['outer.summon', { kind: 'drone', drones: 1 }]],
    });
    const onion = enemy(ctx, 1);
    const em = emitter(ctx);
    impactAt(ctx, 0, onion, em.payload, em, false, 0, -1);
    expect(oneBreak(ctx, onion)).toEqual({ ...BROKEN_ONCE, layers: [[1, 2]] });
  });
});

describe('a break is no kill', () => {
  it('raises no KILLED-flagged hit trigger or onHit call, no kill trigger and no onKill hook (OWN test 3)', () => {
    // Planted bug: the check at killEnemy's top (C3D's placement), past the KILLED dispatch.
    const onHit: number[] = [];
    let onKill = 0;
    const watch: TestModule = (b) => {
      b.hook('onHit', (_ctx, h) => {
        onHit.push(h.flags);
      });
      b.hook('onKill', () => {
        onKill++;
      });
    };
    const ctx = scene([onionAt(300)], {
      values: { igniteChance: 1 },
      triggers: [
        { on: 'hit', do: HEAL },
        { on: 'kill', do: HEAL },
      ],
      modules: [watch],
    });
    const onion = enemy(ctx, 1);
    const q = ctx.effectQueue;
    hit(ctx, onion, payload(ctx, 150), 2);
    expect(record(onion).layersLeft).toBe(2);
    // One hit trigger, the surviving hit's, without KILLED; one onHit call, likewise.
    expect(q.size).toBe(1);
    expect((q.flags[q.head] as number) & KILLED).toBe(0);
    expect(onHit.map((flags) => flags & KILLED)).toEqual([0]);
    expect([onKill, ctx.pendingCount, ctx.kills]).toEqual([0, 0, 0]);
    expect([onion.killDepth, onion.killKind]).toEqual([0, 0]);
    // The breaking hit goes on as a surviving one: it ignited.
    expect(eventsOf([ctx.events], 'ignite').map((e) => e.targetId)).toEqual([1]);
    expect(onion.burns.length).toBe(1);
    // The last shell's hit kills as any lethal hit: KILLED, the kill trigger and the hook.
    q.size = 0;
    hit(ctx, onion, payload(ctx, 150), 2);
    hit(ctx, onion, payload(ctx, 150), 2);
    expect(onHit.map((flags) => flags & KILLED)).toEqual([0, 0, KILLED]);
    expect([onKill, ctx.pendingCount, ctx.kills]).toEqual([1, 1, 1]);
    expect([onion.killDepth, onion.killKind]).toEqual([2, KILL_BY_HIT]);
  });

  it('pays the drops once, at the last shell: 16 × and 3 cores, × toughDropMult (OWN test 4)', () => {
    // Planted bug: drops per layer.
    for (const toughDropMult of [1, 2]) {
      const ctx = scene([onionAt(300)], { values: { toughDropMult } });
      const onion = enemy(ctx, 1);
      const state = ctx.state;
      const seen: [number, number][] = [];
      for (let n = 0; n < 3; n++) {
        hit(ctx, onion, payload(ctx, 150));
        seen.push([toNumber(state.shards), state.cores]);
      }
      const rec = onion.rec;
      const shards = toNumber(mul(mul(num(16), rec.shardsPerStd), ctx.shardGain)) * toughDropMult;
      expect(seen).toEqual([
        [0, 0],
        [0, 0],
        [shards, 3 * toughDropMult],
      ]);
      expect(
        eventsOf([ctx.events], 'enemyKilled').map((e) => [toNumber(e.shards), e.cores]),
      ).toEqual([[shards, 3 * toughDropMult]]);
    }
  });

  it('keeps the onion’s burn, poison, bleed, shock and frost: they tick on after a break (OWN test 8)', () => {
    // Planted bug: releaseAilments on a break, which ends its rings (eternalFlame's burns too).
    for (const rules of [[], [{ id: 'eternalFlame', durationMore: 0 }]] as const) {
      // The onion and a square beside it, which no step breaks, take the same hit.
      const ctx = scene([onionAt(300, 1e6), at(360, { hp: 1e6 })], {
        values: {
          igniteChance: 1,
          poisonChance: 1,
          bleedChance: 1,
          shockChance: 1,
          frostOnHit: 0.1,
        },
        rules,
      });
      const [onion, square] = [enemy(ctx, 1), enemy(ctx, 2)];
      for (const e of [onion, square]) hit(ctx, e, payload(ctx, 10));
      const held = (e: Enemy) => ({
        burns: e.burns.length,
        rings: Array.from(e.rings, (r) => r >= 0),
        dotRings: e.dotRings,
        stacks: [e.burnStacks, e.poisonStacks],
        bleedUntil: e.bleedUntil,
        shock: [e.shockStacks, e.shockUntil],
        frost: [e.frost, e.frozenUntil, e.frostLockUntil],
      });
      expect(held(onion)).toEqual(held(square));
      expect(onion.dotRings).toBe(rules.length === 0 ? 1 : 2);
      onion.hp = num(1e-9);
      ctx.events.length = 0;
      stepTo(ctx, BURN_TICK_INTERVAL);
      // The burn broke the shell; the step went on to its poison and bleed.
      const ticks = ['burnTick', 'dotTick×2'];
      expect(shape(ctx.events)).toEqual([
        'burnTick',
        'enemySpawned×12',
        'onionLayer',
        'dotTick×2',
        ...ticks,
      ]);
      expect(held(onion)).toEqual(held(square));
      ctx.events.length = 0;
      stepTo(ctx, 2 * BURN_TICK_INTERVAL);
      expect(shape(ctx.events)).toEqual([...ticks, ...ticks]);
      const dots = (id: number): unknown[] =>
        ctx.events.flatMap((e) =>
          e.type === 'burnTick' && e.targetId === id
            ? [['burn', e.amount]]
            : e.type === 'dotTick' && e.targetId === id
              ? [[e.ailment, e.amount]]
              : [],
        );
      expect(dots(1)).toEqual(dots(2));
      expect(held(onion)).toEqual(held(square));
      expect([record(onion).layersLeft, onion.alive]).toEqual([2, true]);
    }
  });

  it('fires the step’s ailmentTick triggers on an onion whose shell a step broke', () => {
    // Planted bug: dealDot returning true on a break, which skips them.
    const ctx = scene([onionAt(300, 1e6)], {
      values: { igniteChance: 1 },
      triggers: [{ on: 'ailmentTick', every: 0.25, when: [{ ailment: 'burn' }], do: HEAL }],
    });
    const onion = enemy(ctx, 1);
    hit(ctx, onion, payload(ctx, 10));
    onion.hp = num(1e-9);
    stepTo(ctx, BURN_TICK_INTERVAL);
    expect(layers(ctx)).toEqual([[1, 2]]);
    expect(ctx.effectQueue.size).toBe(1);
  });
});

describe('the bursts', () => {
  it('spray the onion’s rim on the split stream, in its wave, extra and without affixes', () => {
    // Planted bugs: the spawn stream; no origin, so counted in the wave and able to draw affixes.
    const ctx = scene([onionAt(300)]);
    const ref = scene([onionAt(300)]);
    const onion = enemy(ctx, 1);
    const before = rngPositions(ctx);
    hit(ctx, onion, payload(ctx, 150));
    const children = ctx.enemies.slice(1);
    expect(children.map((c) => c.type)).toEqual(Array<string>(12).fill('triangle'));
    for (const c of children) {
      expect(Math.hypot(c.x - onion.x, c.y - onion.y)).toBeCloseTo(70, 9);
      expect(c.rec).toBe(onion.rec);
      expect([record(c).extra, record(c).affixes]).toEqual([true, 0]);
      expect([c.hp, c.maxHp]).toEqual([
        mul(num(0.5), onion.rec.stdHp),
        mul(num(0.5), onion.rec.stdHp),
      ]);
    }
    // Twelve angles on the split stream, and no other draw but the hit's own.
    for (let n = 0; n < 12; n++) ref.splitRng.range(0, TAU);
    const after = rngPositions(ctx);
    expect(after.split).toEqual(ref.splitRng.snapshot());
    expect(after.spawn).toEqual(before.spawn);
    expect(after.drops).toEqual(before.drops);
    expect(after.affixes).toEqual(before.affixes);
  });

  it('put the children in the onion’s own wave record, whatever wave is open', () => {
    // Planted bug: the children given the run's current record: they would join wave 2's.
    const ctx = scene([onionAt(300)]);
    const onion = enemy(ctx, 1);
    const own = onion.rec;
    startWave(ctx, 2);
    const later = ctx.current as WaveRecord;
    expect(later).not.toBe(own);
    const [ownAlive, laterAlive, first] = [own.alive, later.alive, ctx.enemies.length];
    hit(ctx, onion, payload(ctx, 150));
    const children = ctx.enemies.slice(first);
    expect(children).toHaveLength(12);
    for (const c of children) {
      expect(c.rec).toBe(own);
      expect(c.wave).toBe(own.wave);
    }
    expect([own.alive, later.alive]).toEqual([ownAlive + 12, laterAlive]);
  });

  it('skip and count the children past the enemy cap, and the shell breaks all the same (OWN test 5)', () => {
    // Planted bug: addEnemy directly, past the cap.
    const capped = (enemyCap: number): GameData =>
      v3TestData({ waves: { v3: { ...TEST_V3_WAVES.v3, enemyCap } } });
    const ctx = scene([onionAt(300), at(400), at(420), at(440), at(460)], { data: capped(10) });
    const ref = scene([onionAt(300)], { data: capped(10) });
    const onion = enemy(ctx, 1);
    hit(ctx, onion, payload(ctx, 150));
    // Five alive: room for five of the twelve.
    expect([spawned(ctx), ctx.counters.enemySpawnsSkipped, ctx.enemies.length]).toEqual([5, 7, 10]);
    expect([record(onion).layersLeft, onion.alive, hp(onion)]).toEqual([2, true, 100]);
    hit(ctx, onion, payload(ctx, 150));
    expect([spawned(ctx), ctx.counters.enemySpawnsSkipped, ctx.enemies.length]).toEqual([
      5, 19, 10,
    ]);
    expect(layers(ctx)).toEqual([
      [1, 2],
      [1, 1],
    ]);
    // A skipped child draws its angle all the same.
    for (let n = 0; n < 24; n++) ref.splitRng.range(0, TAU);
    expect(rngPositions(ctx).split).toEqual(ref.splitRng.snapshot());
  });

  it('spray the last shell’s burst while the dying onion still holds its slot under the cap', () => {
    // C7.5's hand-off: the onion is alive until killEnemy, so at the cap its burst loses a child.
    const ctx = scene([onionAt(300)], {
      data: v3TestData({ waves: { v3: { ...TEST_V3_WAVES.v3, enemyCap: 12 } } }),
    });
    const onion = enemy(ctx, 1);
    record(onion).layersLeft = 1;
    hit(ctx, onion, payload(ctx, 150));
    expect([spawned(ctx), ctx.counters.enemySpawnsSkipped]).toEqual([11, 1]);
    expect(shape(ctx.events)).toEqual(['hit', 'enemySpawned×11', 'onionLayer', 'enemyKilled']);
    expect(onion.alive).toBe(false);
  });
});

describe('doomed (OWN test 6)', () => {
  it('is false while the onion holds more than its last shell, and true at its last', () => {
    // Planted bugs: the check missing; layersLeft > 0 in place of > 1.
    const ctx = scene([onionAt(300, 1e6), at(360, { hp: 1e6 })], {
      values: { igniteChance: 1, burnDamage: 10 },
    });
    const [onion, square] = [enemy(ctx, 1), enemy(ctx, 2)];
    for (const e of [onion, square]) {
      hit(ctx, e, payload(ctx, 10));
      // Far less than the burn has left to deal.
      e.hp = num(1);
    }
    const doom = (layersLeft: number): boolean => {
      record(onion).layersLeft = layersLeft;
      return doomed(ctx, onion);
    };
    expect([doom(3), doom(2), doom(1)]).toEqual([false, false, true]);
    expect(doomed(ctx, square)).toBe(true);
  });
});
