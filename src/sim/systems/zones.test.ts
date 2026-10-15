import { describe, expect, it } from 'vitest';
import { add, num, sub, toNumber, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import { createStreams } from '../../core/rng';
import type { Modifier, StatBlock, StatId } from '../../data/stats';
import type { GroundZoneSpec, TriggerSpec } from '../../data/triggers';
import { enemySlow } from '../ailments/frost';
import { compileCondition, conditionsMet, IN_ZONE } from '../build/eval';
import { PULSE_TICKS, SIGNATURE_ZONE_CAP, ZONE_CAP, ZONE_SOURCE_CAP } from '../caps';
import { hitWithPayload } from '../combat/hit';
import { createEffectEntry } from '../effects/queue';
import { runEffect, runEffectQueue } from '../effects/execute';
import { SIGNATURE } from '../effects/flags';
import { MAX_DEPTH, SHATTER_TRIGGER } from '../effects/types';
import type { CompiledTrigger } from '../effects/types';
import type { Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { centerTriggers, makeStats, placedEnemies, rngPositions } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { updateAilments } from './ailments';
import type { Enemy, RunContext } from './context';
import { moveEnemies } from './movement';
import { addZone, hitPulse, hoistPulseRows, stepZones } from './zones';

type PulseEvent = Extract<SimEvent, { type: 'pulse' }>;

/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

/** Where the zones of these tests stand: 300 right of the player. */
const Z = { x: ARENA_WIDTH / 2 + 300, y: ARENA_HEIGHT / 2 };
/** An enemy (dx, dy) from Z. */
const near = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: Z.x + dx,
  y: Z.y + dy,
  ...extra,
});

/** A trigger that never fires in these tests, so its effects run only when a test runs them. */
const idle = (...effects: TriggerSpec['do']): TriggerSpec => ({
  on: 'periodic',
  every: 1000,
  do: effects,
});

/** A zone of radius 50 for 1 s that hits for 100% of the damage stat a second. */
const ZONE: GroundZoneSpec = { kind: 'groundZone', radius: 50, durationSec: 1, damagePctPerSec: 1 };

/**
 * Stats with damage 400 (a pulse of ZONE hits for 100) and no crits unless `values` say so,
 * with these center triggers and scoped modifiers.
 */
const zoneStats = (
  triggers: readonly TriggerSpec[],
  values: Partial<Record<StatId, number>> = {},
  scoped: readonly Modifier[] = [],
): StatBlock =>
  makeStats({ damage: 400, critChance: 0, critMultiplier: 2, ...values }, scoped, {
    ...centerTriggers(triggers),
  });

/** The index of the first effect of data trigger `k` (0: the first data trigger). */
const effectOf = (ctx: RunContext, k: number): number =>
  (ctx.build.triggers[FIRST + k] as CompiledTrigger).effectStart;

/** The enemy with id `id` (placedEnemies numbers them 1, 2, … in order). */
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** Runs effect `effect` at (x, y), as its trigger's entry at `depth` from `origin` would. */
function runAt(
  ctx: RunContext,
  effect: number,
  x = Z.x,
  y = Z.y,
  {
    depth = 0,
    origin = -1,
    source = -1,
  }: { depth?: number; origin?: number; source?: number } = {},
): void {
  const entry = createEffectEntry();
  entry.effect = effect;
  entry.depth = depth;
  entry.origin = origin;
  entry.source = source >= 0 ? source : (ctx.build.effects[effect]?.source ?? 0);
  entry.x = x;
  entry.y = y;
  runEffect(ctx, entry);
}

/**
 * The next tick of `ctx`: `before` runs where the projectile stage would, then the zone stage,
 * then `after`, where the effect stage would. Returns the tick's events.
 */
function tick(ctx: RunContext, before?: () => void, after?: () => void): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  ctx.events.length = 0;
  before?.();
  stepZones(ctx);
  after?.();
  return ctx.events.slice();
}

/** Ticks until the zone stage raises a pulse event; returns that tick's events. */
function untilPulse(ctx: RunContext, limit = 2 * PULSE_TICKS): SimEvent[] {
  for (let n = 0; n < limit; n++) {
    const events = tick(ctx);
    if (events.some((event) => event.type === 'pulse')) return events;
  }
  throw new Error('no pulse');
}

/** Ticks until zone `id` pulses, whether it hit anything or not; returns that tick. */
function untilPhase(ctx: RunContext, id: number): number {
  for (let n = 0; n < 2 * PULSE_TICKS; n++) {
    const t = ctx.now + 1;
    tick(ctx);
    if (t % PULSE_TICKS === id % PULSE_TICKS) return t;
  }
  throw new Error('no phase');
}

const pulsesOf = (events: readonly SimEvent[]): PulseEvent[] =>
  events.filter((event): event is PulseEvent => event.type === 'pulse');

const mod15 = (n: number): number => ((n % PULSE_TICKS) + PULSE_TICKS) % PULSE_TICKS;

describe('zone pulses (C8)', () => {
  it.each(['before', 'after'] as const)(
    'a 1.5 s zone created %s the zone stage pulses 6 times, in its phase, in every phase',
    (stage) => {
      const spec: GroundZoneSpec = { ...ZONE, durationSec: 1.5 };
      const ctx = placedEnemies([near(0, 0)], { stats: zoneStats([idle(spec)]) });
      const effect = effectOf(ctx, 0);
      const created = new Map<number, number>();
      const pulses = new Map<number, number[]>();
      const ends = new Map<number, number>();
      for (let t = 2; t <= 2 + 2 * 14 + 6 * PULSE_TICKS + 1; t++) {
        // Zone k at tick 2 + 2k has id k + 1, so (id − tick) mod 15 takes all 15 values.
        const make =
          t % 2 === 0 && t <= 2 + 2 * 14
            ? () => {
                runAt(ctx, effect);
                created.set(ctx.sys.zones.nextId, t);
              }
            : undefined;
        const events = tick(
          ctx,
          stage === 'before' ? make : undefined,
          stage === 'after' ? make : undefined,
        );
        for (const event of events) {
          if (event.type === 'pulse') pulses.set(event.id, [...(pulses.get(event.id) ?? []), t]);
          if (event.type === 'zoneEnd') ends.set(event.id, t);
        }
      }
      expect(new Set([...created].map(([id, t]) => mod15(id - t))).size).toBe(PULSE_TICKS);
      for (const [id, t] of created) {
        const ticks = pulses.get(id) ?? [];
        expect(ticks, `zone ${id}`).toHaveLength(6);
        for (const at of ticks) {
          expect(mod15(at)).toBe(mod15(id));
          expect(at).toBeGreaterThan(t);
          expect(at).toBeLessThanOrEqual(t + 6 * PULSE_TICKS);
        }
        expect(ends.get(id)).toBe(t + 6 * PULSE_TICKS);
      }
      expect(ctx.sys.zones.count).toBe(0);
    },
  );

  it('rounds the duration to whole pulses, one at least', () => {
    const ctx = placedEnemies([], {
      stats: zoneStats([idle({ ...ZONE, durationSec: 0.3 }, { ...ZONE, durationSec: 2.2 })]),
    });
    runAt(ctx, effectOf(ctx, 0));
    runAt(ctx, effectOf(ctx, 0) + 1);
    const z = ctx.sys.zones;
    expect([z.expiresAt[0], z.expiresAt[1]]).toEqual([1 + PULSE_TICKS, 1 + 9 * PULSE_TICKS]);
  });
});

describe('zone caps (K5)', () => {
  /** An empty arena with one groundZone effect, and a function adding its zones by source. */
  function pool() {
    const ctx = placedEnemies([], { stats: zoneStats([idle(ZONE)]) });
    const effect = effectOf(ctx, 0);
    const p = ctx.effectPayloads[effect] as Payload;
    const zones = ctx.sys.zones;
    const addOf = (source: number, signature = false): number => {
      addZone(ctx, signature, Z.x, Z.y, 50, 8, p, 0.25, source, signature ? -1 : effect, 0, -1);
      expect(ctx.state.zoneCount).toBe(zones.count);
      return zones.nextId;
    };
    const live = (): number[] => Array.from(zones.id.subarray(0, zones.count));
    const evicted = (): number[] =>
      ctx.events.flatMap((event) => (event.type === 'zoneEnd' && event.evicted ? [event.id] : []));
    return { ctx, zones, addOf, live, evicted };
  }

  it('evicts the oldest zone of a source past its 16th', () => {
    const { ctx, zones, addOf, live, evicted } = pool();
    const ids = Array.from({ length: ZONE_SOURCE_CAP }, () => addOf(3));
    addOf(4);
    expect(evicted()).toEqual([]);
    const id = addOf(3);
    expect(evicted()).toEqual([ids[0]]);
    expect(ctx.counters.zonesEvicted).toBe(1);
    expect(live()).toEqual([...ids.slice(1), (ids.at(-1) as number) + 1, id]);
    expect(zones.perSource[3]).toBe(ZONE_SOURCE_CAP);
    expect(zones.live).toBe(ZONE_SOURCE_CAP + 1);
  });

  it('evicts the oldest zone of any source when 64 are live and a new source adds one', () => {
    const { ctx, zones, addOf, live, evicted } = pool();
    for (let n = 0; n < ZONE_CAP; n++) addOf(1 + (n % 4));
    expect(zones.live).toBe(ZONE_CAP);
    addOf(9);
    expect(evicted()).toEqual([1]);
    expect(ctx.counters.zonesEvicted).toBe(1);
    expect(live()[0]).toBe(2);
    expect(zones.live).toBe(ZONE_CAP);
    expect([zones.perSource[1], zones.perSource[9]]).toEqual([ZONE_SOURCE_CAP - 1, 1]);
  });

  it.each([1, 8, 15])(
    'evicts the oldest zone of any source when 64 are live and the new source holds %i',
    (own) => {
      const { ctx, zones, addOf, live, evicted } = pool();
      // The oldest zone is another source's; the new zone's source holds `own` of the 64.
      const first = addOf(1);
      for (let n = 0; n < own; n++) addOf(7);
      for (let n = 1 + own; n < ZONE_CAP; n++) addOf(1 + (n % 4));
      expect([zones.live, zones.perSource[7]]).toEqual([ZONE_CAP, own]);
      const id = addOf(7);
      expect(evicted()).toEqual([first]);
      expect(live()[0]).toBe(first + 1);
      expect(live().at(-1)).toBe(id);
      expect([zones.live, zones.perSource[7]]).toEqual([ZONE_CAP, own + 1]);
      expect(ctx.counters.zonesEvicted).toBe(1);
    },
  );

  it('keeps the 16 signature zones apart from the effect zones', () => {
    const { ctx, zones, addOf, live, evicted } = pool();
    const signature = Array.from({ length: SIGNATURE_ZONE_CAP }, () => addOf(0, true));
    for (let n = 0; n < ZONE_CAP; n++) addOf(1 + (n % 4));
    expect(zones.count).toBe(ZONE_CAP + SIGNATURE_ZONE_CAP);
    // A full effect pool evicts its oldest effect zone, not the older signature zones.
    addOf(9);
    expect(evicted()).toEqual([SIGNATURE_ZONE_CAP + 1]);
    expect(live().slice(0, SIGNATURE_ZONE_CAP)).toEqual(signature);
    // A 17th signature zone evicts the oldest signature zone.
    const next = addOf(0, true);
    expect(evicted()).toEqual([SIGNATURE_ZONE_CAP + 1, signature[0]]);
    expect([zones.live, zones.liveSignature]).toEqual([ZONE_CAP, SIGNATURE_ZONE_CAP]);
    expect(live().at(-1)).toBe(next);
    expect(ctx.counters.zonesEvicted).toBe(2);
  });

  it('keeps SimState.zones and zoneCount on the pool through adds, evictions and expiry', () => {
    const { ctx, zones, addOf } = pool();
    expect(ctx.state.zones).toBe(zones);
    for (let n = 0; n <= ZONE_SOURCE_CAP; n++) addOf(2);
    expect(ctx.state.zoneCount).toBe(ZONE_SOURCE_CAP);
    for (let n = 0; n < 8 * PULSE_TICKS; n++) {
      tick(ctx);
      expect(ctx.state.zoneCount).toBe(zones.count);
    }
    expect(zones.count).toBe(0);
    expect([zones.live, zones.perSource[2]]).toEqual([0, 0]);
  });
});

describe('zone hits and terms', () => {
  it('a zone without damage hits nothing, and its poison equals an applyAilment of its pct', () => {
    const spec: GroundZoneSpec = {
      kind: 'groundZone',
      radius: 50,
      durationSec: 0.25,
      damagePctPerSec: 0,
      ailment: 'poison',
      ailmentStacks: 2,
      ailmentDamagePct: 0.6,
    };
    const ctx = placedEnemies([near(0, 0), near(0, 400)], {
      stats: zoneStats([
        idle(spec),
        idle({ kind: 'applyAilment', ailment: 'poison', stacks: 2, damagePct: 0.6 }),
      ]),
    });
    const [inZone, other] = [enemy(ctx, 1), enemy(ctx, 2)];
    runAt(ctx, effectOf(ctx, 0));
    const t = untilPhase(ctx, 1);
    // The applyAilment executor on the other enemy, the same tick, after the zone stage.
    const entry = createEffectEntry();
    entry.effect = effectOf(ctx, 1);
    entry.target = other;
    entry.source = 0;
    runEffect(ctx, entry);
    expect(ctx.damageHit).toBe(ZERO);
    expect(inZone.hitMark).toBe(0);
    expect(inZone.poisonStacks).toBe(2);
    expect(other.poisonStacks).toBe(2);
    for (let n = 1; n <= 300; n++) {
      ctx.now = t + n;
      updateAilments(ctx);
    }
    expect(toNumber(inZone.hp)).toBeLessThan(1e12);
    expect(inZone.hp).toBe(other.hp);
  });

  it('carries the depth and origin of the entry that made it to its hits, kills and terms', () => {
    const spec: GroundZoneSpec = { ...ZONE, ailment: 'burn' };
    const ctx = placedEnemies([near(0, 0), near(10, 0, { hp: 50 })], {
      stats: zoneStats([
        { on: 'hit', do: [spec] },
        { on: 'hit', do: [{ kind: 'heal', lifePct: 0.1 }] },
      ]),
    });
    runAt(ctx, effectOf(ctx, 0), Z.x, Z.y, { depth: 1, origin: FIRST });
    const z = ctx.sys.zones;
    expect([z.depth[0], z.origin[0]]).toEqual([1, FIRST]);
    untilPulse(ctx);
    // The killed enemy died at the zone's depth; the survivor's burn has it too.
    expect(enemy(ctx, 2).alive).toBe(false);
    expect(enemy(ctx, 2).killDepth).toBe(1);
    expect(enemy(ctx, 1).ailDepth).toBe(1);
    // Its hits raised hit events at depth 1 from the zone's trigger: the zone's own trigger does
    // not fire on them (rule 3), the other queues its heal one deeper.
    const q = ctx.effectQueue;
    const queued = Array.from({ length: q.size }, (_, n) => {
      const at = (q.head + n) & q.capMask;
      return [q.effect[at], q.depth[at], q.origin[at]];
    });
    expect(queued).toEqual([
      [effectOf(ctx, 1), 2, FIRST + 1],
      [effectOf(ctx, 1), 2, FIRST + 1],
    ]);
  });

  it('draws only the crit rolls of its hits, on the effects stream', () => {
    const values = {
      critChance: 0.5,
      igniteChance: 0.5,
      poisonChance: 0.5,
      bleedChance: 0.5,
      shockChance: 0.5,
      frostOnHit: 0.3,
    };
    const placed = [0, 10, 20, 30, 40].map((dx) => near(dx, 0));
    const ctx = placedEnemies(placed, { stats: zoneStats([idle(ZONE)], values) });
    const twin = placedEnemies(placed, { stats: zoneStats([idle(ZONE)], values) });
    runAt(ctx, effectOf(ctx, 0));
    const [pulse] = pulsesOf(untilPulse(ctx));
    expect(pulse?.hits).toBe(5);
    for (let n = 0; n < 5; n++) twin.effectsRng.chance(0.5);
    expect(rngPositions(ctx)).toEqual(rngPositions(twin));
    for (const e of ctx.enemies) {
      expect([e.burnStacks, e.poisonStacks, e.bleedUntil, e.shockStacks, e.frost]).toEqual([
        0, 0, 0, 0, 0,
      ]);
    }
  });

  it('raises one pulse event per pulse, its total the hp its hits took', () => {
    const placed = [0, 10, 20, 30, 40, 45].map((dx, n) => near(dx, 0, { hp: n < 2 ? 150 : 1e6 }));
    const ctx = placedEnemies(placed, { stats: zoneStats([idle(ZONE)], { critChance: 0.5 }) });
    runAt(ctx, effectOf(ctx, 0));
    const before = ctx.enemies.map((e) => e.hp);
    const events = untilPulse(ctx);
    const pulses = pulsesOf(events);
    expect(pulses).toHaveLength(1);
    const pulse = pulses[0] as PulseEvent;
    expect(events.some((event) => event.type === 'hit')).toBe(false);
    let lost: Num = ZERO;
    ctx.enemies.forEach((e, n) => {
      lost = add(lost, sub(before[n] as Num, e.hp));
    });
    expect(pulse).toMatchObject({ kind: 'zone', id: 1, hits: 6 });
    expect(pulse.total).toBe(lost);
    // 100 a hit, 200 a crit (critMultiplier 2).
    expect(toNumber(pulse.total)).toBe(100 * 6 + 100 * pulse.crits.length);
    expect(pulse.crits.every((id) => id >= 1 && id <= 6)).toBe(true);
    expect(enemy(ctx, 1).alive).toBe(pulse.crits.includes(1) ? false : true);
  });

  it('hits every enemy within it exactly once a pulse while it freezes them (P11)', () => {
    const spec: GroundZoneSpec = { ...ZONE, radius: 90, addFrostPerSec: 8 };
    const crowd = Array.from({ length: 12 }, (_, n) =>
      near(60 * Math.cos(n * 0.5), 60 * Math.sin(n * 0.5)),
    );
    const ctx = placedEnemies(crowd, {
      stats: zoneStats(
        [
          idle(spec),
          { on: 'freeze', do: [{ kind: 'applyAilment', ailment: 'shock' }] },
          { on: 'freeze', do: [{ kind: 'addFrost', amount: 1, radius: 90 }] },
          { on: 'hit', do: [{ kind: 'heal', lifePct: 0.01 }] },
        ],
        { freezeDuration: 2 },
      ),
    });
    runAt(ctx, effectOf(ctx, 0));
    const events = untilPulse(ctx);
    const [pulse] = pulsesOf(events);
    expect(pulse?.hits).toBe(12);
    expect(events.filter((event) => event.type === 'freeze')).toHaveLength(12);
    for (const e of ctx.enemies) {
      // One 100 hit each (frozen enemies take more only after the hit that froze them).
      expect(toNumber(sub(num(1e12), e.hp))).toBe(100);
    }
  });

  it('applies its frost through its source, and the freeze it fills at its depth', () => {
    const ctx = placedEnemies([near(0, 0)], {
      stats: zoneStats([
        idle({ ...ZONE, damagePctPerSec: 0, addFrostPerSec: 2 }),
        { on: 'freeze', do: [{ kind: 'heal', lifePct: 0.1 }] },
      ]),
    });
    runAt(ctx, effectOf(ctx, 0), Z.x, Z.y, { depth: 1, origin: FIRST, source: 5 });
    // addFrostPerSec 2 adds 0.5 a pulse: the second pulse fills the meter.
    untilPhase(ctx, 1);
    expect(enemy(ctx, 1).frost).toBe(0.5);
    expect(ctx.effectQueue.size).toBe(0);
    untilPhase(ctx, 1);
    expect(enemy(ctx, 1).frozenUntil).toBeGreaterThan(ctx.now);
    expect(enemy(ctx, 1).frostApplier).toBe(5);
    const q = ctx.effectQueue;
    expect(q.size).toBe(1);
    expect([q.effect[q.head], q.depth[q.head], q.origin[q.head]]).toEqual([
      effectOf(ctx, 1),
      2,
      FIRST + 1,
    ]);
  });
});

describe('zone slow', () => {
  function slowed(frost = 0) {
    const ctx = placedEnemies([near(0, 0), near(0, 10, { type: 'boss' }), near(0, 200)], {
      stats: zoneStats([idle({ ...ZONE, damagePctPerSec: 0, slow: 0.25 })]),
    });
    for (const e of ctx.enemies) e.frost = frost;
    runAt(ctx, effectOf(ctx, 0));
    expect(ctx.sys.zones.slowApplied).toBe(false);
    const t = untilPhase(ctx, 1);
    return { ctx, t };
  }

  it('slows the enemies in it, bosses in full, for 16 ticks after a pulse', () => {
    const { ctx, t } = slowed();
    const [inside, boss, outside] = [enemy(ctx, 1), enemy(ctx, 2), enemy(ctx, 3)];
    expect(ctx.sys.zones.slowApplied).toBe(true);
    expect([inside.zoneSlow, inside.zoneSlowUntil]).toEqual([0.25, t + 16]);
    expect(enemySlow(ctx, inside, t)).toBe(0.25);
    expect(enemySlow(ctx, boss, t)).toBe(0.25);
    expect(enemySlow(ctx, outside, t)).toBe(0);
    expect(enemySlow(ctx, inside, t + 15)).toBe(0.25);
    expect(enemySlow(ctx, inside, t + 16)).toBe(0);
  });

  it('takes the larger of its slow and the frost slow', () => {
    // frostSlowCap 0.3: a meter of 0.5 slows 0.15, below the zone's 0.25; a full one 0.3.
    expect(enemySlow(slowed(0.5).ctx, enemy(slowed(0.5).ctx, 1), slowed(0.5).t)).toBe(0.25);
    const full = slowed(1);
    expect(enemySlow(full.ctx, enemy(full.ctx, 1), full.t)).toBe(0.3);
  });

  it('keeps the strongest live slow, and the movement stage walks slowed enemies less', () => {
    const ctx = placedEnemies([near(0, 0, { speed: 60 })], {
      stats: zoneStats([
        idle({ ...ZONE, damagePctPerSec: 0, slow: 0.5 }),
        idle({ ...ZONE, damagePctPerSec: 0, slow: 0.2 }),
      ]),
    });
    const e = enemy(ctx, 1);
    runAt(ctx, effectOf(ctx, 0));
    runAt(ctx, effectOf(ctx, 1));
    untilPhase(ctx, 1);
    untilPhase(ctx, 2);
    expect(e.zoneSlow).toBe(0.5);
    const dist = e.dist;
    moveEnemies(ctx);
    expect(dist - e.dist).toBeCloseTo((60 / 60) * 0.5, 12);
  });
});

describe('inZone', () => {
  /** Fire zones mark, ice zones do not: only 'outer.fire' is named by an inZone condition. */
  function marked() {
    const more: Modifier = {
      stat: 'damage',
      kind: 'more',
      value: 1,
      when: [{ inZone: 'outer.fire' }],
    };
    const stats = makeStats({ damage: 400, critChance: 0 }, [more], {
      triggers: [
        { source: 'outer.fire', spec: idle({ ...ZONE, damagePctPerSec: 0, slow: 0.1 }) },
        { source: 'outer.ice', spec: idle({ ...ZONE, damagePctPerSec: 0, slow: 0.1 }) },
        {
          source: 'center',
          spec: { on: 'hit', when: [{ inZone: 'outer.ice' }], do: [{ kind: 'heal', lifePct: 1 }] },
        },
      ],
      conversions: [],
      emitters: [],
    });
    const ctx = placedEnemies([near(0, 0), near(0, 300)], { stats });
    return ctx;
  }

  it('marks only for the sources an inZone condition names', () => {
    const ctx = marked();
    const fire = ctx.sources.index('outer.fire');
    const ice = ctx.sources.index('outer.ice');
    const stamps = ctx.sys.zones.stampSources;
    expect([stamps[fire], stamps[ice], stamps[0]]).toEqual([1, 1, 0]);
    const conds = ctx.build.mods.flatMap((m) => m.cond ?? []);
    expect(conds).toEqual([{ code: IN_ZONE, a: fire, b: 0 }]);
  });

  it('holds while the enemy is marked, and only for the zone source it names', () => {
    const ctx = marked();
    const fire = ctx.sources.index('outer.fire');
    const inFire = [compileCondition({ inZone: 'outer.fire' }, undefined, ctx.sources)];
    const inIce = [compileCondition({ inZone: 'outer.ice' }, undefined, ctx.sources)];
    const e = enemy(ctx, 1);
    expect(conditionsMet(inFire, e, ctx.now, 0)).toBe(false);
    runAt(ctx, effectOf(ctx, 0));
    const t = untilPhase(ctx, 1);
    expect([e.zoneSource, e.zoneUntil]).toEqual([fire, t + 16]);
    expect(conditionsMet(inFire, e, t, 0)).toBe(true);
    expect(conditionsMet(inIce, e, t, 0)).toBe(false);
    expect(conditionsMet(inFire, enemy(ctx, 2), t, 0)).toBe(false);
    expect(conditionsMet(inFire, e, t + 15, 0)).toBe(true);
    expect(conditionsMet(inFire, e, t + 16, 0)).toBe(false);
  });

  it('raises the damage of hits on the enemies its source marks, through a modifier', () => {
    const ctx = marked();
    runAt(ctx, effectOf(ctx, 0));
    runAt(ctx, effectOf(ctx, 1), Z.x, Z.y + 300);
    const fire = untilPhase(ctx, 1);
    const ice = untilPhase(ctx, 2);
    const [inFire, inIce] = [enemy(ctx, 1), enemy(ctx, 2)];
    expect([inFire.zoneUntil, inIce.zoneUntil]).toEqual([fire + 16, ice + 16]);
    const p = (ctx.emitters[0] as { payload: Payload }).payload;
    const lost = (e: Enemy): number => {
      const before = e.hp;
      hitWithPayload(ctx, e, p, 0, 1, null, null, false, 0, -1);
      return toNumber(sub(before, e.hp));
    };
    // The modifier names outer.fire: 'more 1' doubles the hit on the enemy fire marked.
    expect(lost(inFire)).toBe(2 * lost(inIce));
  });

  it('is not marked by a zone whose source no condition names', () => {
    const ctx = placedEnemies([near(0, 0)], {
      stats: zoneStats([idle({ ...ZONE, damagePctPerSec: 0, slow: 0.1 })]),
    });
    runAt(ctx, effectOf(ctx, 0));
    untilPhase(ctx, 1);
    expect(enemy(ctx, 1).zoneSlow).toBe(0.1);
    expect([enemy(ctx, 1).zoneSource, enemy(ctx, 1).zoneUntil]).toEqual([-1, 0]);
  });

  it('throws when compiled without the run’s sources', () => {
    expect(() => compileCondition({ inZone: 'outer.fire' })).toThrow(/per-event/);
  });
});

describe('the zone stage', () => {
  it('does nothing with no zone', () => {
    const ctx = placedEnemies([near(0, 0)], { stats: zoneStats([idle(ZONE)]) });
    ctx.grid.within = () => {
      throw new Error('queried');
    };
    const acc = ctx.sys.pulse;
    acc.hits = 7;
    expect(tick(ctx)).toEqual([]);
    expect(acc.hits).toBe(7);
  });

  it('adds no zone from inside a pulse: the kills and freezes it causes only queue', () => {
    const killZone: GroundZoneSpec = { ...ZONE, radius: 30 };
    const crowd = Array.from({ length: 8 }, (_, n) =>
      near(5 * n, 0, { hp: n % 2 === 0 ? 50 : 1e6 }),
    );
    const ctx = placedEnemies(crowd, {
      stats: zoneStats(
        [
          idle({ ...ZONE, radius: 60, addFrostPerSec: 8 }),
          { on: 'kill', do: [killZone] },
          { on: 'freeze', do: [killZone] },
        ],
        { freezeDuration: 2 },
      ),
    });
    runAt(ctx, effectOf(ctx, 0));
    const zones = ctx.sys.zones;
    const before = zones.nextId;
    // The zone's first pulse kills and freezes; the zones those trigger are only queued.
    untilPhase(ctx, before);
    expect(ctx.enemies.some((e) => !e.alive)).toBe(true);
    expect(ctx.events.some((event) => event.type === 'freeze')).toBe(true);
    expect([zones.nextId, zones.count]).toEqual([before, 1]);
    expect(ctx.effectQueue.size).toBeGreaterThan(0);
    runEffectQueue(ctx);
    expect(zones.nextId).toBeGreaterThan(before);
  });
});

describe('hitPulse', () => {
  /** A seeded run of fixtures: random hp, shock and freeze, crits, hooks and listeners. */
  const FIXTURES = Array.from({ length: 24 }, (_, n) => n);

  it.each(FIXTURES)('equals hitWithPayload on an aggregate payload (fixture %i)', (n) => {
    const r = createStreams(1000 + n).spawn;
    const values = {
      critChance: [0, 0.4, 1][n % 3] as number,
      critMultiplier: 1.5 + r.next(),
      frozenDamageTaken: 0.5,
      shockEffect: 0.2,
    };
    const scoped: Modifier[] =
      n % 4 === 0 ? [{ stat: 'damage', kind: 'more', value: 0.5, tags: ['zone'] }] : [];
    const conversions =
      n % 5 === 0 ? [{ source: 'center', spec: { to: 'cold' as const, fraction: 0.4 } }] : [];
    const triggers: TriggerSpec[] = [idle(ZONE)];
    if (n % 2 === 1) triggers.push({ on: 'hit', do: [{ kind: 'heal', lifePct: 0.01 }] });
    if (n % 3 === 2) triggers.push({ on: 'crit', do: [{ kind: 'heal', lifePct: 0.01 }] });
    const hooks: TestModule[] =
      n % 6 === 1
        ? [(b) => b.hook('modifyDamage', (_ctx, _hit, amount) => add(amount, num(7)))]
        : [];
    const placed = Array.from({ length: 10 }, (_, k) =>
      near(4 * k, 0, { hp: Math.round(50 + r.next() * 300) }),
    );
    const make = (): RunContext => {
      const stats = makeStats({ damage: 400, ...values }, scoped, {
        ...centerTriggers(triggers),
        conversions,
      });
      const ctx = placedEnemies(placed, { stats, modules: hooks, seed: 7 + n });
      ctx.enemies.forEach((e, k) => {
        if (k % 3 === 0) {
          e.shockStacks = 2;
          e.shockUntil = 1000;
        }
        if (k % 4 === 1) e.frozenUntil = 1000;
      });
      return ctx;
    };
    const a = make();
    const b = make();
    const scale = 0.25 + r.next();
    const pa = a.effectPayloads[effectOf(a, 0)] as Payload;
    const pb = b.effectPayloads[effectOf(b, 0)] as Payload;
    expect(pa.aggregate).toBe(true);
    hoistPulseRows(a, a.sys.pulse, pa);
    for (let k = 0; k < a.enemies.length; k++) {
      const [ea, eb] = [a.enemies[k] as Enemy, b.enemies[k] as Enemy];
      if (ea.alive) hitPulse(a, a.sys.pulse, ea, pa, scale, 1, FIRST);
      if (eb.alive) hitWithPayload(b, eb, pb, 0, scale, null, null, false, 1, FIRST);
    }
    const state = (ctx: RunContext) => ({
      hp: ctx.enemies.map((e) => [e.hp, e.alive, e.killDepth]),
      tallies: [ctx.damageHit, ctx.damageCrit, ctx.damageChain, ctx.maxHit, ctx.kills],
      bySource: ctx.bySource.slice(0, 4),
      rng: rngPositions(ctx),
      pulse: { ...ctx.sys.pulse, row: 0, critRow: 0, crits: [...ctx.sys.pulse.crits] },
      events: ctx.events.slice(),
      queue: ctx.effectQueue.size,
      life: ctx.player.life,
    });
    expect(state(a)).toEqual(state(b));
    expect(a.events.some((event) => event.type === 'hit')).toBe(false);
    if (n % 3 === 1) expect(a.sys.pulse.hits).toBeGreaterThan(0);
  });

  it.each(FIXTURES)(
    'equals hitWithPayload when every hit and crit trigger takes only signature hits (fixture %i)',
    (n) => {
      const r = createStreams(2000 + n).spawn;
      const heal: TriggerSpec['do'] = [{ kind: 'heal', lifePct: 0.01 }];
      const triggers: TriggerSpec[] = [idle(ZONE)];
      // Hit triggers, crit triggers or both; crit chance 0, .4 or 1; depth 1 or MAX_DEPTH, at
      // which fire counts each listened event in triggerDepthCapped: every mix in 18 fixtures.
      const listens = Math.floor(n / 6) % 3;
      if (listens !== 2) triggers.push({ on: 'hit', when: [{ hitIs: 'signature' }], do: heal });
      if (listens !== 1) triggers.push({ on: 'crit', when: [{ hitIs: 'signature' }], do: heal });
      const critChance = [0, 0.4, 1][Math.floor(n / 2) % 3] as number;
      const depth = n % 2 === 0 ? 1 : MAX_DEPTH;
      // Some survive their hit, whose dispatch is the quiet one, and some die of it.
      const placed = Array.from({ length: 10 }, (_, k) =>
        near(4 * k, 0, { hp: Math.round(50 + r.next() * 600) }),
      );
      const make = (): RunContext => {
        const stats = makeStats(
          { damage: 400, critChance, critMultiplier: 2 },
          [],
          centerTriggers(triggers),
        );
        return placedEnemies(placed, { stats, seed: 11 + n });
      };
      const a = make();
      const b = make();
      const scale = 0.1 + 0.6 * r.next();
      const pa = a.effectPayloads[effectOf(a, 0)] as Payload;
      const pb = b.effectPayloads[effectOf(b, 0)] as Payload;
      hoistPulseRows(a, a.sys.pulse, pa);
      expect(a.sys.pulse.quiet).toBe(true);
      for (let k = 0; k < a.enemies.length; k++) {
        const [ea, eb] = [a.enemies[k] as Enemy, b.enemies[k] as Enemy];
        if (ea.alive) hitPulse(a, a.sys.pulse, ea, pa, scale, depth, FIRST);
        if (eb.alive) hitWithPayload(b, eb, pb, 0, scale, null, null, false, depth, FIRST);
      }
      const state = (ctx: RunContext) => ({
        hp: ctx.enemies.map((e) => [e.hp, e.alive, e.killDepth]),
        tallies: [ctx.damageHit, ctx.damageCrit, ctx.maxHit, ctx.kills],
        bySource: ctx.bySource.slice(0, 4),
        counters: { ...ctx.counters },
        rng: rngPositions(ctx),
        hits: ctx.sys.pulse.hits,
        total: ctx.sys.pulse.total,
        crits: ctx.sys.pulse.crits.slice(0, ctx.sys.pulse.critCount),
        events: ctx.events.slice(),
        queue: ctx.effectQueue.size,
        triggerState: [ctx.triggerState.readyAt.slice(), ctx.triggerState.count.slice()],
      });
      expect(state(a)).toEqual(state(b));
      // Each hit's events, lethal or not, reach fire once: at MAX_DEPTH each listened one counts.
      const pulse = a.sys.pulse;
      const capped = (listens !== 2 ? pulse.hits : 0) + (listens !== 1 ? pulse.critCount : 0);
      expect(a.counters.triggerDepthCapped).toBe(depth === MAX_DEPTH ? capped : 0);
    },
  );

  it('is not quiet for a hit or crit trigger on other hits, an onHit hook or a signature payload', () => {
    const quietOf = (triggers: TriggerSpec[], flags = 0, modules: TestModule[] = []): boolean => {
      const ctx = placedEnemies([near(0, 0)], { stats: zoneStats(triggers), modules });
      const p = ctx.effectPayloads[effectOf(ctx, 0)] as Payload;
      hoistPulseRows(ctx, ctx.sys.pulse, { ...p, flags: p.flags | flags });
      return ctx.sys.pulse.quiet;
    };
    const heal: TriggerSpec['do'] = [{ kind: 'heal', lifePct: 0.01 }];
    const onlySignature: TriggerSpec = { on: 'hit', when: [{ hitIs: 'signature' }], do: heal };
    const onHit: TestModule = (b) => b.hook('onHit', () => {});
    expect(quietOf([idle(ZONE), onlySignature])).toBe(true);
    expect(quietOf([idle(ZONE), onlySignature], SIGNATURE)).toBe(false);
    expect(quietOf([idle(ZONE), onlySignature, { on: 'crit', do: heal }])).toBe(false);
    expect(quietOf([idle(ZONE), { on: 'hit', do: heal }])).toBe(false);
    expect(quietOf([idle(ZONE), onlySignature], 0, [onHit])).toBe(false);
    // Nothing listens to hits: hitPulse skips their dispatch before it reads quiet.
    expect(quietOf([idle(ZONE)])).toBe(false);
  });
});

describe('zone pool against a model (K5, C8)', () => {
  /** A zone of the model: what its events and its pulses' totals show of it. */
  interface ModelZone {
    readonly id: number;
    readonly source: number;
    readonly signature: boolean;
    readonly created: number;
    readonly expiresAt: number;
    readonly total: number;
  }

  it.each([1, 2, 3])(
    'raises the model events, in order, through evictions, expiry and reused slots (seed %i)',
    (seed) => {
      const r = createStreams(seed).spawn;
      // One enemy in every zone; it never dies, so each pulse hits it once.
      const ctx = placedEnemies([near(0, 0, { hp: 1e15 })], { stats: zoneStats([idle(ZONE)]) });
      const effect = effectOf(ctx, 0);
      const p = ctx.effectPayloads[effect] as Payload;
      const zones = ctx.sys.zones;
      const model: ModelZone[] = [];
      let nextId = 0;
      // Evictions of each kind: a signature zone, a source's, any source's.
      const kinds = [0, 0, 0];
      const oldestOf = (match: (zone: ModelZone) => boolean): number => model.findIndex(match);
      const records = ZONE_CAP + SIGNATURE_ZONE_CAP;
      // The records are bytes (ZonePool.record).
      expect(records).toBeLessThanOrEqual(256);
      /** The view holds the model's live zones, in id order; each record is used or free, once. */
      const expectView = (): void => {
        expect(ctx.state.zoneCount).toBe(model.length);
        expect(Array.from(zones.id.subarray(0, zones.count))).toEqual(model.map((zone) => zone.id));
        expect(Array.from(zones.signature.subarray(0, zones.count))).toEqual(
          model.map((zone) => (zone.signature ? 1 : 0)),
        );
        const held = [
          ...zones.record.subarray(0, zones.count),
          ...zones.free.subarray(0, zones.freeCount),
        ];
        expect(held.sort((x, y) => x - y)).toEqual(Array.from({ length: records }, (_, k) => k));
      };
      for (let step = 0; step < 900; step++) {
        const expected: unknown[] = [];
        if (r.next() < 0.3) {
          // The zone stage: pulses in id order, then each zone at or past its last tick ends.
          const now = ctx.now + 1;
          for (const zone of [...model]) {
            if (
              zone.created < now &&
              now <= zone.expiresAt &&
              zone.id % PULSE_TICKS === now % PULSE_TICKS
            ) {
              expected.push({
                type: 'pulse',
                kind: 'zone',
                id: zone.id,
                hits: 1,
                total: zone.total,
                crits: [],
              });
            }
            if (now >= zone.expiresAt) {
              expected.push({ type: 'zoneEnd', id: zone.id, evicted: false });
              model.splice(model.indexOf(zone), 1);
            }
          }
          expect(tick(ctx)).toEqual(expected);
          expectView();
          continue;
        }
        // An add: a signature zone, or an effect zone of one of six sources (more than the
        // pool's 64 hold at 16 each; source 1 adds the most, so it meets its own cap too), with
        // its own scale, so its pulses' totals name it.
        const signature = r.next() < 0.2;
        const source = signature ? 0 : r.next() < 0.4 ? 1 : 2 + r.int(5);
        const pulses = 2 + r.int(8);
        const scale = 0.25 * (1 + r.int(8));
        const effects = model.filter((zone) => !zone.signature);
        let evict = -1;
        let kind = -1;
        if (signature) {
          if (model.length - effects.length >= SIGNATURE_ZONE_CAP) {
            [evict, kind] = [oldestOf((z) => z.signature), 0];
          }
        } else if (effects.filter((zone) => zone.source === source).length >= ZONE_SOURCE_CAP) {
          [evict, kind] = [oldestOf((z) => !z.signature && z.source === source), 1];
        } else if (effects.length >= ZONE_CAP) {
          [evict, kind] = [oldestOf((z) => !z.signature), 2];
        }
        if (kind >= 0) kinds[kind] = (kinds[kind] as number) + 1;
        if (evict >= 0) {
          expected.push({ type: 'zoneEnd', id: (model[evict] as ModelZone).id, evicted: true });
          model.splice(evict, 1);
        }
        const id = ++nextId;
        const expiresAt = ctx.now + PULSE_TICKS * pulses;
        model.push({ id, source, signature, created: ctx.now, expiresAt, total: 400 * scale });
        expected.push({
          type: 'zone',
          id,
          x: Z.x,
          y: Z.y,
          radius: 50,
          expiresAt,
          source,
          signature,
        });
        ctx.events.length = 0;
        addZone(
          ctx,
          signature,
          Z.x,
          Z.y,
          50,
          pulses,
          p,
          scale,
          source,
          signature ? -1 : effect,
          0,
          -1,
        );
        expect(ctx.events).toEqual(expected);
        expectView();
      }
      expect(ctx.counters.zonesEvicted).toBe(kinds.reduce((a, b) => a + b, 0));
      for (const n of kinds) expect(n).toBeGreaterThan(10);
    },
  );
});
