import { describe, expect, it } from 'vitest';
import { add, mul, num, sub, toNumber, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import { createStreams } from '../../core/rng';
import type { RuleSpec } from '../../data/rules';
import type { Modifier, StatBlock, StatId } from '../../data/stats';
import type { GroundZoneSpec, TriggerSpec } from '../../data/triggers';
import { applyBurn } from '../ailments/apply';
import { enemySlow } from '../ailments/frost';
import { RING_POISON } from '../ailments/rings';
import { compileCondition, conditionsMet, IN_ZONE } from '../build/eval';
import { PULSE_TICKS, SIGNATURE_ZONE_CAP, ZONE_CAP, ZONE_SOURCE_CAP } from '../caps';
import { hitWithPayload } from '../combat/hit';
import { createEffectEntry } from '../effects/queue';
import { applyStacks, runEffect, runEffectQueue } from '../effects/execute';
import { appliedFlag, CRIT_HIT, HIT_EVENT, SIGNATURE } from '../effects/flags';
import { EVENT, MAX_DEPTH, SHATTER_TRIGGER } from '../effects/types';
import type { CompiledTrigger } from '../effects/types';
import { runAura } from '../emitters/aura';
import { ALWAYS_IGNITES, PHASE_TICKS } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { centerTriggers, makeStats, placedEnemies, rngPositions, v3TestData } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { updateAilments } from './ailments';
import type { BurnStack, Enemy, RunContext } from './context';
import { ARMOURED, SHIELDED } from './enemyRecord';
import type { EnemyV3 } from './enemyRecord';
import { moveEnemies } from './movement';
import { addZone, hitPulse, hoistPulseRows, stepZones } from './zones';

type PulseEvent = Extract<SimEvent, { type: 'pulse' }>;

/** Every hit ailment chance at .5. */
const HALF = {
  critChance: 0.5,
  igniteChance: 0.5,
  poisonChance: 0.5,
  bleedChance: 0.5,
  shockChance: 0.5,
} as const;

/** The always stats of every hit ailment, on every hit. */
const ALWAYS: readonly Modifier[] = (
  ['igniteAlways', 'poisonAlways', 'bleedAlways', 'shockAlways'] as const
).map((stat) => ({ stat, kind: 'flat', value: 1 }));

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

/** The effect, depth and origin of each queued entry, in queue order. */
const queuedOf = (ctx: RunContext): number[][] => {
  const q = ctx.effectQueue;
  return Array.from({ length: q.size }, (_, n) => {
    const at = (q.head + n) & q.capMask;
    return [q.effect[at] as number, q.depth[at] as number, q.origin[at] as number];
  });
};

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

  it.each([1, MAX_DEPTH])(
    'a poison term made at depth %i queues the ailmentApplied triggers it fires one deeper, not its own',
    (depth) => {
      const onPoison: TriggerSpec['when'] = [{ ailment: 'poison' }];
      const spec: GroundZoneSpec = { ...ZONE, damagePctPerSec: 0, ailment: 'poison' };
      const ctx = placedEnemies([near(0, 0)], {
        stats: zoneStats([
          { on: 'ailmentApplied', when: onPoison, do: [spec] },
          { on: 'ailmentApplied', when: onPoison, do: [{ kind: 'heal', lifePct: 0.1 }] },
        ]),
      });
      // The first trigger is the origin of its zone's poison, so rule 3 keeps it from firing.
      runAt(ctx, effectOf(ctx, 0), Z.x, Z.y, { depth, origin: FIRST });
      untilPhase(ctx, 1);
      expect([enemy(ctx, 1).poisonStacks, enemy(ctx, 1).ailDepth]).toEqual([1, depth]);
      const heals = [effectOf(ctx, 1), depth + 1, FIRST + 1];
      expect(queuedOf(ctx)).toEqual(depth < MAX_DEPTH ? [heals] : []);
    },
  );

  it('rolls crit, ignite, poison, bleed and shock per enemy in id order, on the effects stream', () => {
    const values = { ...HALF, frostOnHit: 0.3 };
    const placed = [0, 10, 20, 30, 40].map((dx) => near(dx, 0));
    const ctx = placedEnemies(placed, { stats: zoneStats([idle(ZONE)], values) });
    const twin = placedEnemies(placed, { stats: zoneStats([idle(ZONE)], values) });
    runAt(ctx, effectOf(ctx, 0));
    const [pulse] = pulsesOf(untilPulse(ctx));
    expect(pulse?.hits).toBe(5);
    // The twin replays the pulse's draws: per enemy, its crit, ignite, poison, bleed and shock.
    const rolls = Array.from({ length: 25 }, () => twin.effectsRng.chance(0.5));
    expect(rngPositions(ctx)).toEqual(rngPositions(twin));
    expect(new Set(rolls)).toEqual(new Set([true, false]));
    ctx.enemies.forEach((e, k) => {
      const [crit, ignite, poison, bleed, shock] = rolls.slice(5 * k, 5 * k + 5);
      expect(pulse?.crits.includes(e.id), `enemy ${e.id}`).toBe(crit);
      expect([e.burnStacks, e.poisonStacks, e.bleedUntil > 0, e.shockStacks, e.frost]).toEqual([
        ignite ? 1 : 0,
        poison ? 1 : 0,
        bleed,
        shock ? 1 : 0,
        0.3,
      ]);
    });
  });

  it.each([
    ['0', 0, []],
    ['1', 1, []],
    ['0 with every always stat', 0, ALWAYS],
  ] as const)('draws only its crit rolls with every ailment chance at %s', (_, chance, scoped) => {
    const values = {
      critChance: 0.5,
      igniteChance: chance,
      poisonChance: chance,
      bleedChance: chance,
      shockChance: chance,
    };
    // A projectile-only poison chance makes the build roll its dots, at 0 on the zone's hits.
    const mods: Modifier[] = [
      { stat: 'poisonChance', kind: 'flat', value: 0.5, tags: ['projectile'] },
      ...scoped,
    ];
    const placed = [0, 10, 20, 30, 40].map((dx) => near(dx, 0));
    const ctx = placedEnemies(placed, { stats: zoneStats([idle(ZONE)], values, mods) });
    const twin = placedEnemies(placed, { stats: zoneStats([idle(ZONE)], values, mods) });
    expect(ctx.rollsDots).toBe(true);
    runAt(ctx, effectOf(ctx, 0));
    expect(pulsesOf(untilPulse(ctx))[0]?.hits).toBe(5);
    for (let n = 0; n < 5; n++) twin.effectsRng.chance(0.5);
    expect(rngPositions(ctx)).toEqual(rngPositions(twin));
    const applies = chance === 1 || scoped.length > 0;
    for (const e of ctx.enemies) {
      expect([e.burnStacks, e.poisonStacks, e.bleedUntil > 0, e.shockStacks]).toEqual(
        applies ? [1, 1, true, 1] : [0, 0, false, 0],
      );
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

  it('lists only its own crits in each pulse event, fewer than its hits and than the last’s', () => {
    // Hits on normal enemies crit, the boss's never; enemy 2 dies of the first pulse's crit.
    const onNormal: Modifier = {
      stat: 'critChance',
      kind: 'flat',
      value: 1,
      when: [{ targetKind: 'normal' }],
    };
    const placed = [near(0, 0), near(10, 0, { hp: 150 }), near(20, 0, { type: 'boss' })];
    const ctx = placedEnemies(placed, { stats: zoneStats([idle(ZONE)], {}, [onNormal]) });
    runAt(ctx, effectOf(ctx, 0));
    expect(pulsesOf(untilPulse(ctx))).toMatchObject([{ hits: 3, crits: [1, 2] }]);
    expect(enemy(ctx, 2).alive).toBe(false);
    // Each pulse counts its crits from 0 and its event takes crits[0 .. critCount): not
    // [1, 2, 1] (the last pulse's count kept), nor [1, 2] (the stale 2 past it).
    expect(pulsesOf(untilPulse(ctx))).toMatchObject([{ hits: 2, crits: [1] }]);
    expect(ctx.sys.pulse.crits).toEqual([1, 2]);
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

  it('applies its terms to an enemy whose shield blocked its hit in full, as to one it hit (R1)', () => {
    const spec: GroundZoneSpec = { ...ZONE, ailment: 'poison', addFrostPerSec: 1, slow: 0.3 };
    const ctx = placedEnemies(
      [near(0, 0, { type: 'shielder', hp: 1e6 }), near(10, 0, { type: 'square', hp: 1e6 })],
      { stats: zoneStats([idle(spec)]), data: v3TestData() },
    );
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    expect(one.v3?.defence).toBe(SHIELDED);
    runAt(ctx, effectOf(ctx, 0));
    // The pulse hits for 100: the shielder's shield blocks it, the square takes it.
    expect(pulsesOf(untilPulse(ctx))).toEqual([
      { type: 'pulse', kind: 'zone', id: 1, hits: 1, total: num(100), crits: [] },
    ]);
    expect([toNumber(one.hp), toNumber(two.hp)]).toEqual([1e6, 1e6 - 100]);
    // Its poison term, frost and slow on both alike.
    const terms = (e: Enemy) => [e.poisonStacks, e.frost, e.zoneSlow];
    expect(terms(one)).toEqual([1, 0.25, 0.3]);
    expect(terms(one)).toEqual(terms(two));
  });
});

describe('zone hit ailments (Q4 B)', () => {
  const heal: TriggerSpec['do'] = [{ kind: 'heal', lifePct: 0.01 }];

  /** zoneStats, with each trigger of its own source. */
  const sourced = (
    triggers: readonly (readonly [string, TriggerSpec])[],
    values: Partial<Record<StatId, number>> = {},
  ): StatBlock =>
    makeStats({ damage: 400, critChance: 0, critMultiplier: 2, ...values }, [], {
      triggers: triggers.map(([source, spec]) => ({ source, spec })),
      conversions: [],
      emitters: [],
    });

  /** Every hit ailment on crits only: its chance at 1, or its always stat. */
  const ON_CRITS = {
    chances: (['igniteChance', 'poisonChance', 'bleedChance', 'shockChance'] as const).map(
      (stat): Modifier => ({ stat, kind: 'flat', value: 1, tags: ['crit'] }),
    ),
    'always stats': ALWAYS.map((mod): Modifier => ({ ...mod, tags: ['crit'] })),
  };
  /** Every hit ailment chance at 0 (BASE_STATS has igniteChance .1). */
  const NO_AILMENTS = { igniteChance: 0, poisonChance: 0, bleedChance: 0, shockChance: 0 };

  it('a zone without damage rolls nothing, adds no burn credit and applies only its term', () => {
    const spec: GroundZoneSpec = { ...ZONE, damagePctPerSec: 0, ailment: 'poison' };
    // A fusion zone, whose ignites would be credited apart from the signature's.
    const ctx = placedEnemies([near(0, 0), near(10, 0)], {
      stats: sourced([['fusion.fire.poison', idle(spec)]], { ...HALF, frostOnHit: 0.3 }),
    });
    const effect = effectOf(ctx, 0);
    const p = ctx.effectPayloads[effect] as Payload;
    expect([p.aggregate, p.rollsAilments]).toEqual([true, false]);
    // The signature stays the build's only burn applier.
    expect(ctx.burnMixed).toBe(false);
    runAt(ctx, effect);
    const before = rngPositions(ctx);
    untilPhase(ctx, 1);
    expect(rngPositions(ctx)).toEqual(before);
    for (const e of ctx.enemies) {
      expect([
        e.hitMark,
        e.burnStacks,
        e.poisonStacks,
        e.bleedUntil,
        e.shockStacks,
        e.frost,
      ]).toEqual([0, 0, 1, 0, 0, 0]);
    }
  });

  it.each([
    ['fusion.fire.aura', 1, true],
    ['fusion.fire.aura', 0, false],
    ['outer.fire', 1, false],
    ['outer.fire', 0, false],
  ] as const)(
    'a %s zone of damagePctPerSec %i beside the signature mixes the burn credits: %s',
    (source, damagePctPerSec, mixed) => {
      const spec: GroundZoneSpec = { ...ZONE, damagePctPerSec };
      const ctx = placedEnemies([], { stats: sourced([[source, idle(spec)]]) });
      const p = ctx.effectPayloads[effectOf(ctx, 0)] as Payload;
      expect(p.rollsAilments).toBe(damagePctPerSec > 0);
      // A damaging zone is a burn applier; only a fusion's credit differs from the signature's
      // (ailmentCredit gives every other applier's burns the same credit).
      expect(ctx.burnMixed).toBe(mixed);
    },
  );

  it('raises the ailment events of hitWithPayload on a copy, no hit event, and a hit-only total', () => {
    const values = { ...HALF, frostOnHit: 0.3 };
    const placed = [0, 10, 20, 30, 40, 45].map((dx) => near(dx, 0));
    const ctx = placedEnemies(placed, { stats: zoneStats([idle(ZONE)], values) });
    const copy = placedEnemies(placed, { stats: zoneStats([idle(ZONE)], values) });
    runAt(ctx, effectOf(ctx, 0));
    const before = ctx.enemies.map((e) => e.hp);
    const events = untilPulse(ctx);
    // The copy's hits: at the pulse's tick and scale, at the zone's depth 0 from no trigger.
    copy.now = ctx.now;
    const p = copy.effectPayloads[effectOf(copy, 0)] as Payload;
    for (const e of copy.enemies) hitWithPayload(copy, e, p, 0, 0.25, null, null, false, 0, -1);
    expect(events.filter((event) => event.type !== 'pulse')).toEqual(copy.events);
    expect(ctx.enemies.map((e) => e.hp)).toEqual(copy.enemies.map((e) => e.hp));
    expect(events.some((event) => event.type === 'hit')).toBe(false);
    const count = (type: SimEvent['type']): number =>
      events.filter((event) => event.type === type).length;
    const held = (has: (e: Enemy) => boolean): number => ctx.enemies.filter(has).length;
    expect(count('ignite')).toBe(held((e) => e.burnStacks > 0));
    expect(count('ailmentApplied')).toBe(
      held((e) => e.poisonStacks > 0) +
        held((e) => e.bleedUntil > 0) +
        held((e) => e.shockStacks > 0),
    );
    expect([count('ignite'), count('ailmentApplied')].every((n) => n > 0)).toBe(true);
    // The pulse's total is what its hits took; the burns they lit deal theirs at the burn step.
    const pulse = pulsesOf(events)[0] as PulseEvent;
    let lost: Num = ZERO;
    ctx.enemies.forEach((e, n) => {
      lost = add(lost, sub(before[n] as Num, e.hp));
    });
    expect(pulse.total).toBe(lost);
    expect(toNumber(pulse.total)).toBe(100 * 6 + 100 * pulse.crits.length);
  });

  it.each([1, MAX_DEPTH])(
    'a zone at depth %i queues the ailmentApplied triggers its ignites fire one deeper, not its own',
    (depth) => {
      const onBurn: TriggerSpec['when'] = [{ ailment: 'burn' }];
      const ctx = placedEnemies([near(0, 0), near(10, 0)], {
        stats: zoneStats(
          [
            { on: 'ailmentApplied', when: onBurn, do: [ZONE] },
            { on: 'ailmentApplied', when: onBurn, do: heal },
          ],
          { igniteChance: 1 },
        ),
      });
      // The zone of the first trigger, made by its entry at `depth`: that trigger is the origin
      // of its hits' ignites, so rule 3 keeps it from firing on them.
      runAt(ctx, effectOf(ctx, 0), Z.x, Z.y, { depth, origin: FIRST });
      untilPulse(ctx);
      expect(ctx.enemies.map((e) => e.burnStacks)).toEqual([1, 1]);
      const heals = [effectOf(ctx, 1), depth + 1, FIRST + 1];
      expect(queuedOf(ctx)).toEqual(depth < MAX_DEPTH ? [heals, heals] : []);
    },
  );

  it('applies the rolled ailments of a quiet pulse, and they fire their triggers', () => {
    const ctx = placedEnemies([near(0, 0), near(10, 0)], {
      stats: zoneStats(
        [
          idle(ZONE),
          { on: 'hit', when: [{ hitIs: 'signature' }], do: heal },
          { on: 'ailmentApplied', when: [{ ailment: 'burn' }], do: heal },
        ],
        { igniteChance: 1 },
      ),
    });
    runAt(ctx, effectOf(ctx, 0));
    const events = untilPulse(ctx);
    expect(ctx.sys.pulse.quiet).toBe(true);
    expect(ctx.enemies.map((e) => e.burnStacks)).toEqual([1, 1]);
    expect(events.filter((event) => event.type === 'ignite')).toHaveLength(2);
    // The ailmentApplied trigger queues a heal per ignite; the hit trigger takes no zone hit.
    const heals = [effectOf(ctx, 2), 1, FIRST + 2];
    expect(queuedOf(ctx)).toEqual([heals, heals]);
  });

  it.each([1, 2])(
    'a damaging poison zone of %i stacks adds its hit’s rolled stack, then its own',
    (stacks) => {
      const spec: GroundZoneSpec = { ...ZONE, ailment: 'poison', ailmentStacks: stacks };
      const ctx = placedEnemies([near(0, 0), near(10, 0)], {
        stats: zoneStats([idle(spec)], { igniteChance: 0, poisonChance: 1 }),
      });
      runAt(ctx, effectOf(ctx, 0));
      for (let pulse = 1; pulse <= 2; pulse++) {
        const events = untilPulse(ctx);
        for (const e of ctx.enemies) {
          expect(e.poisonStacks).toBe(pulse * (1 + stacks));
          const applied = events.flatMap((event) =>
            event.type === 'ailmentApplied' && event.targetId === e.id ? [event.stacks] : [],
          );
          // The roll's stack comes first: 1 then 1 + stacks, not stacks then 1 + stacks.
          const first = (pulse - 1) * (1 + stacks);
          expect(applied).toEqual([first + 1, first + 1 + stacks]);
        }
      }
    },
  );

  it('freezes each enemy once a pulse through frostOnHit 1 and a frost term', () => {
    const spec: GroundZoneSpec = { ...ZONE, addFrostPerSec: 2 };
    const ctx = placedEnemies([near(0, 0), near(10, 0)], {
      stats: zoneStats([idle(spec)], { igniteChance: 0, frostOnHit: 1 }),
    });
    runAt(ctx, effectOf(ctx, 0));
    const events = untilPulse(ctx);
    // frostOnHit fills each meter, before the term; a frozen enemy takes no more frost.
    const freezes = events.flatMap((event) => (event.type === 'freeze' ? [event.targetId] : []));
    expect(freezes).toEqual([1, 2]);
    for (const e of ctx.enemies) expect(e.frozenUntil).toBeGreaterThan(ctx.now);
  });

  it('replaces the burn with the least damage left when its ignite meets the records cap', () => {
    const ctx = placedEnemies([near(0, 0)], {
      stats: zoneStats([idle(ZONE)], { igniteChance: 1, burnMaxStacks: 2 }),
    });
    const e = enemy(ctx, 1);
    applyBurn(ctx, e, num(1000), 600, 0, ctx.burnCredit, 1);
    applyBurn(ctx, e, num(1), 600, 0, ctx.burnCredit, 1);
    runAt(ctx, effectOf(ctx, 0));
    const events = untilPulse(ctx);
    // The zone's burn: its hit's 100 × burnDamage, for burnDuration.
    expect(e.burns.map((stack) => [toNumber(stack.dps), stack.end])).toEqual([
      [1000, 600],
      [100 * ctx.burnDamage, ctx.now + ctx.burnTicks],
    ]);
    expect(events.filter((event) => event.type === 'ignite')).toEqual([
      { type: 'ignite', targetId: 1, stacks: 2 },
    ]);
  });

  it.each([
    ['chances', 0],
    ['chances', 1],
    ['always stats', 0],
    ['always stats', 1],
  ] as const)(
    'rolls its ailments on the row of the crit roll’s outcome: %s on crits, crit chance %i',
    (kind, critChance) => {
      const ctx = placedEnemies([near(0, 0), near(10, 0)], {
        stats: zoneStats([idle(ZONE)], { ...NO_AILMENTS, critChance }, ON_CRITS[kind]),
      });
      expect(ctx.rollsDots).toBe(true);
      runAt(ctx, effectOf(ctx, 0));
      const [pulse] = pulsesOf(untilPulse(ctx));
      expect(pulse?.crits).toEqual(critChance === 1 ? [1, 2] : []);
      // Ignite, then poison, bleed and shock (rollDots), read on the crit row: only crits apply.
      for (const e of ctx.enemies) {
        expect([e.burnStacks, e.poisonStacks, e.bleedUntil > 0, e.shockStacks]).toEqual(
          critChance === 1 ? [1, 1, true, 1] : [0, 0, false, 0],
        );
      }
    },
  );

  it('applies a crit’s poison and bleed on their crit rows', () => {
    // A crit's poison and bleed deal 'more 1', past the crit multiplier (2) of its base.
    const scoped = (['poison', 'bleed'] as const).map((dot): Modifier => ({
      stat: 'damage',
      kind: 'more',
      value: 1,
      tags: [dot, 'crit'],
    }));
    const dots = (critChance: number): number[] => {
      const ctx = placedEnemies([near(0, 0)], {
        stats: zoneStats(
          [idle(ZONE)],
          { ...NO_AILMENTS, critChance, poisonChance: 1, bleedChance: 1 },
          scoped,
        ),
      });
      runAt(ctx, effectOf(ctx, 0));
      untilPulse(ctx);
      const e = enemy(ctx, 1);
      // The damage the poison ring (the center's) has yet to deal, and the bleed's dps.
      return [ctx.rings.remaining[e.rings[RING_POISON] as number] as number, toNumber(e.bleedDps)];
    };
    const plain = dots(0);
    expect(plain.every((n) => n > 0)).toBe(true);
    expect(dots(1)).toEqual(plain.map((n) => 4 * n));
  });

  it('raises a freeze with its hit’s flags, which carry CRIT_HIT on a crit', () => {
    // No trigger condition on freeze reads hit flags (hitIs takes hit, crit and kill events);
    // an onCenterEvent hook sees them.
    const freezes = (critChance: number): [number, boolean, boolean][] => {
      const seen: [number, boolean, boolean][] = [];
      const spy: TestModule = (b) =>
        b.hook('onCenterEvent', (_ctx, ev) => {
          if (ev.event !== EVENT.freeze) return;
          const flags = ev.flags;
          seen.push([ev.target?.id ?? 0, (flags & HIT_EVENT) !== 0, (flags & CRIT_HIT) !== 0]);
        });
      const ctx = placedEnemies([near(0, 0), near(10, 0)], {
        stats: zoneStats([idle(ZONE)], { ...NO_AILMENTS, critChance, frostOnHit: 1 }),
        modules: [spy],
      });
      runAt(ctx, effectOf(ctx, 0));
      untilPulse(ctx);
      return seen;
    };
    expect(freezes(0)).toEqual([
      [1, true, false],
      [2, true, false],
    ]);
    expect(freezes(1)).toEqual([
      [1, true, true],
      [2, true, true],
    ]);
  });
});

describe('zone pulse burns at the records cap (Q4/F4)', () => {
  const heal: TriggerSpec['do'] = [{ kind: 'heal', lifePct: 0.01 }];

  /**
   * One enemy in a fusion's damaging zone (the first data trigger's ZONE), at a records cap of
   * 2, whose hits ignite on a drawn roll (.99) and roll nothing else; an ailmentApplied trigger
   * on burns, then the triggers `more`. A burn of the fusion's would set burnFusionCredit.
   */
  function capped(rules: readonly RuleSpec[] = [], more: readonly TriggerSpec[] = []): RunContext {
    const triggers: TriggerSpec[] = [
      { on: 'ailmentApplied', when: [{ ailment: 'burn' }], do: heal },
      ...more,
    ];
    const stats = makeStats(
      { damage: 400, critChance: 0, igniteChance: 0.99, burnMaxStacks: 2 },
      [],
      {
        triggers: [
          { source: 'fusion.fire.aura', spec: idle(ZONE) },
          ...triggers.map((spec) => ({ source: 'center', spec })),
        ],
        conversions: [],
        emitters: [],
      },
    );
    return placedEnemies([near(0, 0)], { stats, rules });
  }

  /**
   * One enemy, or the enemies `placed`, in a status-only zone (the first data trigger's ZONE) of
   * `source`, a fusion's unless named, whose burn term applies `stacks` stacks at
   * ailmentDamagePct `pct`, at a records cap of `cap`, with these stat `values` and scoped
   * modifiers; an ailmentApplied trigger on burns.
   */
  function termCapped(
    stacks: number,
    cap = 2,
    {
      rules = [],
      source = 'fusion.fire.aura',
      pct = 1,
      values = {},
      scoped = [],
      placed = [near(0, 0)],
    }: {
      rules?: readonly RuleSpec[];
      source?: string;
      pct?: number;
      values?: Partial<Record<StatId, number>>;
      scoped?: readonly Modifier[];
      placed?: readonly PlacedEnemy[];
    } = {},
  ): RunContext {
    const term: GroundZoneSpec = {
      ...ZONE,
      damagePctPerSec: 0,
      ailment: 'burn',
      ailmentStacks: stacks,
      ailmentDamagePct: pct,
    };
    const stats = makeStats({ damage: 400, critChance: 0, burnMaxStacks: cap, ...values }, scoped, {
      triggers: [
        { source, spec: idle(term) },
        { source: 'center', spec: { on: 'ailmentApplied', when: [{ ailment: 'burn' }], do: heal } },
      ],
      conversions: [],
      emitters: [],
    });
    return placedEnemies(placed, { stats, rules });
  }

  /** A burn stack of `dps` until tick `end` on the enemy, at depth 2, with the center's credit. */
  const burn = (ctx: RunContext, dps: Num | number, end = 600, depth = 2): void =>
    applyBurn(
      ctx,
      enemy(ctx, 1),
      typeof dps === 'number' ? num(dps) : dps,
      end,
      depth,
      ctx.burnCredit,
      1,
    );

  /** Everything a burn of the records changes on an enemy. */
  const burnState = (e: Enemy) => ({
    burns: e.burns.map((stack) => ({ ...stack })),
    burnStacks: e.burnStacks,
    pending: [e.burnPending, e.burnPendC, e.burnPendO, e.burnPendF],
    burnNextEnd: e.burnNextEnd,
    ailDepth: e.ailDepth,
    burnFusionCredit: e.burnFusionCredit,
  });

  const ignites = (events: readonly SimEvent[]): SimEvent[] =>
    events.filter((event) => event.type === 'ignite');

  /** The ring pool, its typed arrays as strings. */
  const ringsOf = (c: RunContext) =>
    Object.entries(c.rings).map(([key, v]: [string, unknown]) => [
      key,
      ArrayBuffer.isView(v) ? String(v) : v,
    ]);

  /** The heal the ailmentApplied trigger queues for a burn of the zone's (depth 0). */
  const healOf = (ctx: RunContext): number[] => [effectOf(ctx, 1), 1, FIRST + 1];

  /** hitWithPayload's hit of the zone's payload on `copy`'s enemy at tick `now`, at its scale. */
  function hitCopy(copy: RunContext, now: number): void {
    copy.now = now;
    copy.events.length = 0;
    const p = copy.effectPayloads[effectOf(copy, 0)] as Payload;
    hitWithPayload(copy, enemy(copy, 1), p, 0, 0.25, null, null, false, 0, -1);
  }

  /**
   * applyStacks' `stacks` burn stacks of the zone's payload at ailmentDamagePct `pct` on `copy`'s
   * enemy at tick `now`, at the zone's depth: the as-built rule of the applyAilment executor.
   */
  function termCopy(copy: RunContext, now: number, stacks: number, pct = 1): void {
    copy.now = now;
    copy.events.length = 0;
    const p = copy.effectPayloads[effectOf(copy, 0)] as Payload;
    applyStacks(copy, 'burn', enemy(copy, 1), p, mul(p.baseDamage, pct), stacks, 0, -1);
  }

  /** The flags each queued entry carries, in queue order. */
  const queuedFlags = (ctx: RunContext): number[] => {
    const q = ctx.effectQueue;
    return Array.from({ length: q.size }, (_, n) => q.flags[(q.head + n) & q.capMask] as number);
  };

  /** Ticks to zone `id`'s next pulse; `before` runs in that tick, before the zone stage. */
  function atPulse(ctx: RunContext, id: number, before?: () => void): SimEvent[] {
    while (mod15(ctx.now + 1) !== mod15(id)) tick(ctx);
    return tick(ctx, before);
  }

  it('refuses a burn with less damage than every stack has left: nothing changes or fires', () => {
    // The pulse's burn, 150 dps for 72 ticks, has less total than 1000 or 500 dps for 584
    // ticks, and more than 1 dps for 584.
    const twin = (weak: number) => {
      const ctx = capped();
      burn(ctx, 1000);
      burn(ctx, weak);
      runAt(ctx, effectOf(ctx, 0));
      const e = enemy(ctx, 1);
      const before = { state: burnState(e), rng: rngPositions(ctx) };
      return { ctx, e, before, events: untilPulse(ctx) };
    };
    const refused = twin(500);
    const accepted = twin(1);
    // Accepted: the 1-dps stack replaced by the zone's burn, at its depth, with its credit.
    const now = accepted.ctx.now;
    const [kept, lit] = accepted.e.burns as [BurnStack, BurnStack];
    expect(toNumber(kept.dps)).toBe(1000);
    expect([toNumber(lit.dps), lit.end, lit.depth]).toEqual([
      100 * accepted.ctx.burnDamage,
      now + accepted.ctx.burnTicks,
      0,
    ]);
    expect(accepted.e.burnFusionCredit).toBe(lit.source);
    expect(toNumber(accepted.e.burnPending)).toBeGreaterThan(0);
    expect(ignites(accepted.events)).toEqual([{ type: 'ignite', targetId: 1, stacks: 2 }]);
    expect(queuedOf(accepted.ctx)).toEqual([healOf(accepted.ctx)]);
    // Refused: no stack, bank, depth or credit moves, and no ignite event or trigger.
    expect(refused.ctx.now).toBe(now);
    expect(refused.before.state.burnFusionCredit).toBe(-1);
    expect(burnState(refused.e)).toEqual(refused.before.state);
    expect(ignites(refused.events)).toEqual([]);
    expect(queuedOf(refused.ctx)).toEqual([]);
    // The ignite roll is drawn before the cap's check: the streams move, and alike.
    expect(rngPositions(refused.ctx)).not.toEqual(refused.before.rng);
    expect(rngPositions(refused.ctx)).toEqual(rngPositions(accepted.ctx));
  });

  it('refuses or takes the burn of a hit a shield blocks as of one that lands (C7.3)', () => {
    // capped()'s run with a shielder of a v3 run: its shield blocks every hit of the zone's, so
    // blockedHit (src/sim/combat/defend.ts) applies the pulse hit's burn, through applyPulseBurn.
    const twin = (weak: number) => {
      const stats = makeStats(
        { damage: 400, critChance: 0, igniteChance: 0.99, burnMaxStacks: 2 },
        [],
        {
          triggers: [
            { source: 'fusion.fire.aura', spec: idle(ZONE) },
            {
              source: 'center',
              spec: { on: 'ailmentApplied', when: [{ ailment: 'burn' }], do: heal },
            },
          ],
          conversions: [],
          emitters: [],
        },
      );
      const ctx = placedEnemies([near(0, 0, { type: 'shielder' })], { stats, data: v3TestData() });
      const e = enemy(ctx, 1);
      expect(e.v3?.defence).toBe(SHIELDED);
      burn(ctx, 1000);
      burn(ctx, weak);
      runAt(ctx, effectOf(ctx, 0));
      const before = { state: burnState(e), hp: e.hp };
      return { ctx, e, before, events: atPulse(ctx, 1) };
    };
    const refused = twin(500);
    const accepted = twin(1);
    for (const { ctx, e, before, events } of [refused, accepted]) {
      // Blocked in full: no damage, pulse event or hitBlocked (a pulse's pushes none).
      expect(e.hp).toBe(before.hp);
      expect(ctx.sys.pulse.hits).toBe(0);
      expect(events.filter((event) => event.type !== 'ignite')).toEqual([]);
    }
    expect(burnState(refused.e)).toEqual(refused.before.state);
    expect(ignites(refused.events)).toEqual([]);
    expect(queuedOf(refused.ctx)).toEqual([]);
    const [kept, lit] = accepted.e.burns as [BurnStack, BurnStack];
    expect([toNumber(kept.dps), toNumber(lit.dps)]).toEqual([1000, 100 * accepted.ctx.burnDamage]);
    expect(ignites(accepted.events)).toEqual([{ type: 'ignite', targetId: 1, stacks: 2 }]);
    expect(queuedOf(accepted.ctx)).toEqual([healOf(accepted.ctx)]);
  });

  it('replaces the weakest stack with a stronger burn, as hitWithPayload does on a copy', () => {
    const make = (): RunContext => {
      const ctx = capped();
      burn(ctx, 1000);
      burn(ctx, 1);
      return ctx;
    };
    const ctx = make();
    const copy = make();
    runAt(ctx, effectOf(ctx, 0));
    const events = untilPulse(ctx);
    hitCopy(copy, ctx.now);
    const e = enemy(ctx, 1);
    expect(burnState(e)).toEqual(burnState(enemy(copy, 1)));
    expect(e.burns.map((stack) => toNumber(stack.dps))).toEqual([1000, 100 * ctx.burnDamage]);
    // The replaced stack's damage so far is banked.
    expect(toNumber(e.burnPending)).toBeGreaterThan(0);
    expect(events.filter((event) => event.type !== 'pulse')).toEqual(copy.events);
    expect(ignites(events)).toEqual([{ type: 'ignite', targetId: 1, stacks: 2 }]);
    expect(queuedOf(ctx)).toEqual(queuedOf(copy));
    expect(queuedOf(ctx)).toEqual([healOf(ctx)]);
    expect(rngPositions(ctx)).toEqual(rngPositions(copy));
  });

  it.each([
    [0, false],
    [-1, true],
  ])(
    'with a stack of 2 × its dps for half its ticks and %i more, replaces that stack: %s',
    (offset, replaced) => {
      // The pulse's burn, read off a twin below the cap.
      const twin = capped();
      runAt(twin, effectOf(twin, 0));
      untilPulse(twin);
      const lit = enemy(twin, 1).burns[0] as BurnStack;
      expect(lit.end - twin.now).toBe(twin.burnTicks);
      expect(twin.burnTicks % 2).toBe(0);
      // At the pulse's tick: 2 × its dps for half its ticks (offset 0: the same damage left),
      // then 1000 dps.
      const ctx = capped();
      runAt(ctx, effectOf(ctx, 0));
      let before = burnState(enemy(ctx, 1));
      const events = atPulse(ctx, 1, () => {
        burn(ctx, mul(lit.dps, 2), ctx.now + ctx.burnTicks / 2 + offset);
        burn(ctx, 1000);
        ctx.events.length = 0;
        before = burnState(enemy(ctx, 1));
      });
      expect(ctx.now).toBe(twin.now);
      const e = enemy(ctx, 1);
      expect(toNumber((e.burns[0] as BurnStack).dps)).toBe(toNumber(lit.dps) * (replaced ? 1 : 2));
      if (!replaced) expect(burnState(e)).toEqual(before);
      expect(ignites(events)).toHaveLength(replaced ? 1 : 0);
      expect(queuedOf(ctx)).toEqual(replaced ? [healOf(ctx)] : []);
    },
  );

  it('replaces the first of two equally weak stacks', () => {
    const ctx = capped();
    burn(ctx, 1, 600, 2);
    burn(ctx, 1, 600, 1);
    runAt(ctx, effectOf(ctx, 0));
    untilPulse(ctx);
    expect(enemy(ctx, 1).burns.map((stack) => [toNumber(stack.dps), stack.depth])).toEqual([
      [100 * ctx.burnDamage, 0],
      [1, 1],
    ]);
  });

  it.each([
    ['below the cap', [600]],
    ['beside a stack that ends on its tick', [1 + PULSE_TICKS, 600]],
  ] as const)('adds a burn weaker than the others %s, as addBurn does', (_, ends) => {
    const make = (): RunContext => {
      const ctx = capped();
      for (const end of ends) burn(ctx, 1000, end);
      return ctx;
    };
    const ctx = make();
    const copy = make();
    runAt(ctx, effectOf(ctx, 0));
    const events = untilPulse(ctx);
    // Zone 1, made at tick 1, pulses first at tick 16.
    expect(ctx.now).toBe(1 + PULSE_TICKS);
    hitCopy(copy, ctx.now);
    const e = enemy(ctx, 1);
    expect(burnState(e)).toEqual(burnState(enemy(copy, 1)));
    // The ended stack is banked and dropped, and the new one added after the live one.
    expect(e.burns.map((stack) => toNumber(stack.dps))).toEqual([1000, 100 * ctx.burnDamage]);
    expect(events.filter((event) => event.type !== 'pulse')).toEqual(copy.events);
    expect(queuedOf(ctx)).toEqual([healOf(ctx)]);
  });

  it.each([
    [
      'an applyAilment effect',
      (ctx: RunContext): void => {
        const entry = createEffectEntry();
        entry.effect = effectOf(ctx, 2);
        entry.target = enemy(ctx, 1);
        entry.source = 0;
        runEffect(ctx, entry);
      },
    ],
    [
      'a hitWithPayload ignite',
      (ctx: RunContext): void => {
        const p = ctx.effectPayloads[effectOf(ctx, 0)] as Payload;
        hitWithPayload(ctx, enemy(ctx, 1), p, 0, 0.25, null, null, false, 0, -1);
      },
    ],
  ])('%s still replaces the weakest stack at the cap, though weaker', (_, apply) => {
    // A zone's own burn term takes the pulse burns' rule (its tests below).
    const ctx = capped([], [idle({ kind: 'applyAilment', ailment: 'burn', damagePct: 1 })]);
    burn(ctx, 1000);
    burn(ctx, 500);
    apply(ctx);
    const now = ctx.now;
    const [kept, lit] = enemy(ctx, 1).burns as [BurnStack, BurnStack];
    expect(toNumber(kept.dps)).toBe(1000);
    expect(lit.start).toBe(now);
    expect(toNumber(mul(lit.dps, lit.end - now))).toBeLessThan(500 * (600 - now));
  });

  it('adds a pulse burn to the burn rings, which have no cap, as applyBurn does', () => {
    const make = (): RunContext => {
      const ctx = capped([{ id: 'eternalFlame', durationMore: 0 }]);
      applyBurn(ctx, enemy(ctx, 1), num(1000), 600, 2, ctx.burnCredit, 3);
      return ctx;
    };
    const ctx = make();
    const copy = make();
    expect(ctx.burnRings).toBe(true);
    runAt(ctx, effectOf(ctx, 0));
    const events = untilPulse(ctx);
    hitCopy(copy, ctx.now);
    expect(enemy(ctx, 1).burnStacks).toBe(4);
    expect(burnState(enemy(ctx, 1))).toEqual(burnState(enemy(copy, 1)));
    expect(ringsOf(ctx)).toEqual(ringsOf(copy));
    expect(events.filter((event) => event.type !== 'pulse')).toEqual(copy.events);
    expect(ignites(events)).toEqual([{ type: 'ignite', targetId: 1, stacks: 4 }]);
    expect(queuedOf(ctx)).toEqual([healOf(ctx)]);
  });

  it.each([
    ['a pulse hit’s burn', (): RunContext => capped()],
    ['a burn term’s stack', (): RunContext => termCapped(1)],
  ])('%s weighs the weakest stack’s damage left, not its whole total', (_, make) => {
    // The new burn, D dps for burnTicks from the pulse's tick, read off a twin below the cap.
    const twin = make();
    runAt(twin, effectOf(twin, 0));
    const at = untilPhase(twin, 1);
    const lit = enemy(twin, 1).burns[0] as BurnStack;
    expect([twin.burnTicks, lit.start, lit.end]).toEqual([72, at, at + 72]);
    // 1.125 × D for 72 ticks, applied 8 ticks before the pulse, has 64 × 1.125 × D = 72 × D
    // left there, the new burn's whole total, while its own whole total is 81 × D.
    const strong = mul(lit.dps, 1.125);
    expect(mul(strong, 64)).toBe(mul(lit.dps, 72));
    expect(mul(strong, 72)).toBeGreaterThan(mul(lit.dps, 72));
    /** The pulse's tick, at a cap of 2: 1000 dps, then that stack applied `ago` ticks before. */
    const run = (ago: number) => {
      const ctx = make();
      runAt(ctx, effectOf(ctx, 0));
      burn(ctx, 1000);
      while (ctx.now < at - ago) tick(ctx);
      burn(ctx, strong, ctx.now + ctx.burnTicks);
      let events: SimEvent[] = [];
      while (ctx.now < at) events = tick(ctx);
      return { e: enemy(ctx, 1), events, queued: queuedOf(ctx), heal: healOf(ctx) };
    };
    // As much damage left as the new burn's: refused.
    const equal = run(8);
    expect(equal.e.burns.map((stack) => [stack.dps, stack.start])).toEqual([
      [1000, 1],
      [strong, at - 8],
    ]);
    expect(ignites(equal.events)).toEqual([]);
    expect(equal.queued).toEqual([]);
    // A tick less left: replaced, the trigger fired.
    const less = run(9);
    expect(less.e.burns.map((stack) => [stack.dps, stack.start])).toEqual([
      [1000, 1],
      [lit.dps, at],
    ]);
    expect(ignites(less.events)).toHaveLength(1);
    expect(less.queued).toEqual([less.heal]);
  });

  describe('a zone’s own burn term', () => {
    it('refuses a stack with less damage than every stack has left: nothing changes, fires or draws', () => {
      // The term's stack, 600 dps for 72 ticks, has less total than 1000 or 500 dps for 584
      // ticks, and more than 1 dps for 584.
      const twin = (weak: number) => {
        const ctx = termCapped(1);
        burn(ctx, 1000);
        burn(ctx, weak);
        runAt(ctx, effectOf(ctx, 0));
        const e = enemy(ctx, 1);
        const before = { state: burnState(e), rng: rngPositions(ctx) };
        return { ctx, e, before, events: atPulse(ctx, 1) };
      };
      const refused = twin(500);
      const accepted = twin(1);
      // Accepted: the 1-dps stack replaced by the term's, at its depth, with its credit.
      const now = accepted.ctx.now;
      expect(now).toBe(1 + PULSE_TICKS);
      const [kept, lit] = accepted.e.burns as [BurnStack, BurnStack];
      expect(toNumber(kept.dps)).toBe(1000);
      expect([toNumber(lit.dps), lit.end, lit.depth]).toEqual([
        400 * accepted.ctx.burnDamage,
        now + accepted.ctx.burnTicks,
        0,
      ]);
      expect(accepted.e.burnFusionCredit).toBe(lit.source);
      expect(toNumber(accepted.e.burnPending)).toBeGreaterThan(0);
      expect(accepted.events).toEqual([{ type: 'ignite', targetId: 1, stacks: 2 }]);
      expect(queuedOf(accepted.ctx)).toEqual([healOf(accepted.ctx)]);
      // Refused: no stack, bank, depth or credit moves, and no ignite event or trigger.
      expect(refused.ctx.now).toBe(now);
      expect(refused.before.state.burnFusionCredit).toBe(-1);
      expect(burnState(refused.e)).toEqual(refused.before.state);
      expect(refused.events).toEqual([]);
      expect(queuedOf(refused.ctx)).toEqual([]);
      // A term draws nothing, applied or refused.
      expect(rngPositions(refused.ctx)).toEqual(refused.before.rng);
      expect(rngPositions(accepted.ctx)).toEqual(accepted.before.rng);
    });

    it('replaces the weakest stack with a stronger one, as applyStacks does on a copy', () => {
      const make = (): RunContext => {
        const ctx = termCapped(1);
        burn(ctx, 1000);
        burn(ctx, 1);
        return ctx;
      };
      const ctx = make();
      const copy = make();
      runAt(ctx, effectOf(ctx, 0));
      // A payload's flags do not reach the term's trigger, which fires with none, as
      // applyStacks' does.
      const zones = ctx.sys.zones;
      const record = zones.record[0] as number;
      zones.payload[record] = { ...(zones.payload[record] as Payload), flags: ALWAYS_IGNITES };
      const events = atPulse(ctx, 1);
      termCopy(copy, ctx.now, 1);
      const e = enemy(ctx, 1);
      expect(burnState(e)).toEqual(burnState(enemy(copy, 1)));
      expect(e.burns.map((stack) => toNumber(stack.dps))).toEqual([1000, 400 * ctx.burnDamage]);
      // The replaced stack's damage so far is banked.
      expect(toNumber(e.burnPending)).toBeGreaterThan(0);
      expect(events).toEqual(copy.events);
      expect(events).toEqual([{ type: 'ignite', targetId: 1, stacks: 2 }]);
      expect(queuedOf(ctx)).toEqual(queuedOf(copy));
      expect(queuedOf(ctx)).toEqual([healOf(ctx)]);
      expect(queuedFlags(ctx)).toEqual(queuedFlags(copy));
      expect(queuedFlags(ctx)).toEqual([appliedFlag('burn')]);
    });

    it.each([
      ['below the cap', [1000]],
      ['at the cap, in place of a weaker stack', [1000, 1, 1000]],
    ] as const)(
      'takes applyStacks’ dps and credit, from base × ailmentDamagePct through the burn row, %s',
      (_, held) => {
        // An outer zone's term at .6, with 300% increased damage on crits: its stack is the
        // payload's base × .6 through the burn row, not the crit row, with the burn credit of an
        // outer applier, not the zone's source.
        const crit: Modifier = { stat: 'damage', kind: 'increased', value: 3, tags: ['crit'] };
        const make = (): RunContext => {
          const ctx = termCapped(1, 3, { source: 'outer.ice', pct: 0.6, scoped: [crit] });
          for (const dps of held) burn(ctx, dps);
          return ctx;
        };
        const ctx = make();
        const copy = make();
        runAt(ctx, effectOf(ctx, 0));
        const events = atPulse(ctx, 1);
        termCopy(copy, ctx.now, 1, 0.6);
        const e = enemy(ctx, 1);
        const lit = e.burns[1] as BurnStack;
        const p = ctx.effectPayloads[effectOf(ctx, 0)] as Payload;
        expect([toNumber(lit.dps), lit.start]).toEqual([240 * ctx.burnDamage, ctx.now]);
        expect(lit.source).not.toBe(p.source);
        expect(burnState(e)).toEqual(burnState(enemy(copy, 1)));
        expect(events).toEqual(copy.events);
        expect(ignites(events)).toHaveLength(1);
        expect(queuedOf(ctx)).toEqual([healOf(ctx)]);
      },
    );

    it('reads its dps on each enemy, through the scoped modifiers that enemy meets', () => {
      // 100% increased damage on bosses: the boss's stack has twice the normal enemy's dps.
      const onBoss: Modifier = {
        stat: 'damage',
        kind: 'increased',
        value: 1,
        when: [{ targetKind: 'boss' }],
      };
      const placed = [near(0, 0), near(10, 0, { type: 'boss' })];
      const ctx = termCapped(1, 2, { placed, scoped: [onBoss] });
      const copy = termCapped(1, 2, { placed, scoped: [onBoss] });
      runAt(ctx, effectOf(ctx, 0));
      const events = atPulse(ctx, 1);
      // applyStacks' stack on each enemy of the copy, in id order.
      const ids = [1, 2];
      copy.now = ctx.now;
      const p = copy.effectPayloads[effectOf(copy, 0)] as Payload;
      for (const id of ids) {
        applyStacks(copy, 'burn', enemy(copy, id), p, p.baseDamage, 1, 0, -1);
      }
      const dps = (id: number): number[] =>
        enemy(ctx, id).burns.map((stack) => toNumber(stack.dps));
      expect(ids.map(dps)).toEqual([[400 * ctx.burnDamage], [800 * ctx.burnDamage]]);
      const states = (c: RunContext) => ids.map((id) => burnState(enemy(c, id)));
      expect(states(ctx)).toEqual(states(copy));
      expect(events).toEqual(copy.events);
      expect(queuedOf(ctx)).toEqual(queuedOf(copy));
    });

    it('checks its stacks in turn: one meeting a stack it has just placed is refused', () => {
      // At a cap of 5, exactly two stacks have less left than one of the term's 3 stacks.
      const make = (): RunContext => {
        const ctx = termCapped(3, 5);
        for (const dps of [1000, 1, 1000, 1, 1000]) burn(ctx, dps);
        return ctx;
      };
      const ctx = make();
      const copy = make();
      runAt(ctx, effectOf(ctx, 0));
      const rng = rngPositions(ctx);
      const events = atPulse(ctx, 1);
      // Its first two stacks replace the two weak ones in turn; its third has as much left as
      // the least a stack has, one of its own, and is refused: two stacks of applyStacks.
      termCopy(copy, ctx.now, 2);
      const e = enemy(ctx, 1);
      const lit = 400 * ctx.burnDamage;
      expect(e.burns.map((stack) => [toNumber(stack.dps), stack.start])).toEqual([
        [1000, 1],
        [lit, ctx.now],
        [1000, 1],
        [lit, ctx.now],
        [1000, 1],
      ]);
      expect(burnState(e)).toEqual(burnState(enemy(copy, 1)));
      expect(events).toEqual(copy.events);
      expect(ignites(events)).toEqual([
        { type: 'ignite', targetId: 1, stacks: 5 },
        { type: 'ignite', targetId: 1, stacks: 5 },
      ]);
      expect(queuedOf(ctx)).toEqual([healOf(ctx)]);
      expect(rngPositions(ctx)).toEqual(rng);
      // As built, the third replaced its sibling with its like: a third ignite.
      const asBuilt = make();
      termCopy(asBuilt, ctx.now, 3);
      expect(ignites(asBuilt.events)).toHaveLength(3);
    });

    it('checks the stacks after one that fills the cap: they meet that one and are refused', () => {
      // At a cap of 3 with two strong stacks, its first stack is added below the cap and fills
      // it; its next two meet that stack, now the weakest, at an equal total.
      const make = (): RunContext => {
        const ctx = termCapped(3, 3);
        burn(ctx, 1000);
        burn(ctx, 1000);
        return ctx;
      };
      const ctx = make();
      const copy = make();
      runAt(ctx, effectOf(ctx, 0));
      const events = atPulse(ctx, 1);
      termCopy(copy, ctx.now, 1);
      const e = enemy(ctx, 1);
      const lit = 400 * ctx.burnDamage;
      expect(e.burns.map((stack) => toNumber(stack.dps))).toEqual([1000, 1000, lit]);
      expect(burnState(e)).toEqual(burnState(enemy(copy, 1)));
      expect(events).toEqual(copy.events);
      expect(events).toEqual([{ type: 'ignite', targetId: 1, stacks: 3 }]);
      expect(queuedOf(ctx)).toEqual([healOf(ctx)]);
    });

    it('comes after its zone’s hit: a damaging zone’s ignite is added first, then its stacks', () => {
      const spec: GroundZoneSpec = { ...ZONE, ailment: 'burn', ailmentStacks: 2 };
      const ctx = placedEnemies([near(0, 0)], {
        stats: zoneStats([idle(spec)], { igniteChance: 1, burnMaxStacks: 5 }),
      });
      runAt(ctx, effectOf(ctx, 0));
      const events = untilPulse(ctx);
      // The hit's burn of its 100 × burnDamage, then the term's two of the payload's 400.
      const [hit, term] = [100 * ctx.burnDamage, 400 * ctx.burnDamage];
      expect(enemy(ctx, 1).burns.map((stack) => toNumber(stack.dps))).toEqual([hit, term, term]);
      expect(ignites(events)).toEqual(
        [1, 2, 3].map((stacks) => ({ type: 'ignite', targetId: 1, stacks })),
      );
    });

    it.each([
      ['below the cap', [600]],
      ['beside two stacks that end on its tick', [1 + PULSE_TICKS, 1 + PULSE_TICKS, 600]],
    ] as const)('adds its stacks %s as applyStacks does, one ignite each', (_, ends) => {
      const make = (): RunContext => {
        const ctx = termCapped(2, 3);
        for (const end of ends) burn(ctx, 1000, end);
        return ctx;
      };
      const ctx = make();
      const copy = make();
      runAt(ctx, effectOf(ctx, 0));
      const events = atPulse(ctx, 1);
      expect(ctx.now).toBe(1 + PULSE_TICKS);
      termCopy(copy, ctx.now, 2);
      const e = enemy(ctx, 1);
      expect(burnState(e)).toEqual(burnState(enemy(copy, 1)));
      // Ended stacks are banked and dropped, and the term's two added after the live one.
      const lit = 400 * ctx.burnDamage;
      expect(e.burns.map((stack) => toNumber(stack.dps))).toEqual([1000, lit, lit]);
      expect(events).toEqual(copy.events);
      expect(ignites(events)).toEqual([
        { type: 'ignite', targetId: 1, stacks: 2 },
        { type: 'ignite', targetId: 1, stacks: 3 },
      ]);
      expect(queuedOf(ctx)).toEqual([healOf(ctx)]);
    });

    it('joins the burn rings, which have no cap, as applyStacks does: one ignite', () => {
      const make = (): RunContext => {
        const ctx = termCapped(3, 2, { rules: [{ id: 'eternalFlame', durationMore: 0 }] });
        applyBurn(ctx, enemy(ctx, 1), num(1000), 600, 2, ctx.burnCredit, 3);
        return ctx;
      };
      const ctx = make();
      const copy = make();
      expect(ctx.burnRings).toBe(true);
      runAt(ctx, effectOf(ctx, 0));
      const events = atPulse(ctx, 1);
      termCopy(copy, ctx.now, 3);
      expect(enemy(ctx, 1).burnStacks).toBe(6);
      expect(burnState(enemy(ctx, 1))).toEqual(burnState(enemy(copy, 1)));
      expect(ringsOf(ctx)).toEqual(ringsOf(copy));
      expect(events).toEqual(copy.events);
      expect(events).toEqual([{ type: 'ignite', targetId: 1, stacks: 6 }]);
      expect(queuedOf(ctx)).toEqual([healOf(ctx)]);
    });

    it.each([1, MAX_DEPTH])(
      'made at depth %i, queues the ailmentApplied triggers its stacks fire one deeper, not its own',
      (depth) => {
        const onBurn: TriggerSpec['when'] = [{ ailment: 'burn' }];
        const term: GroundZoneSpec = { ...ZONE, damagePctPerSec: 0, ailment: 'burn' };
        const ctx = placedEnemies([near(0, 0)], {
          stats: zoneStats([
            { on: 'ailmentApplied', when: onBurn, do: [term] },
            { on: 'ailmentApplied', when: onBurn, do: heal },
          ]),
        });
        // The zone of the first trigger, made by its entry at `depth`: that trigger is the origin
        // of its term's burns, so rule 3 keeps it from firing on them.
        runAt(ctx, effectOf(ctx, 0), Z.x, Z.y, { depth, origin: FIRST });
        atPulse(ctx, 1);
        const e = enemy(ctx, 1);
        expect([e.burnStacks, e.ailDepth]).toEqual([1, depth]);
        const heals = [effectOf(ctx, 1), depth + 1, FIRST + 1];
        expect(queuedOf(ctx)).toEqual(depth < MAX_DEPTH ? [heals] : []);
      },
    );

    it('refuses a damaging zone’s weaker burn term at the cap too, raising and queuing nothing', () => {
      const term: GroundZoneSpec = { ...ZONE, ailment: 'burn' };
      const stats = makeStats(
        { damage: 400, critChance: 0, burnMaxStacks: 2, igniteChance: 0 },
        [],
        {
          triggers: [
            { source: 'fusion.fire.aura', spec: idle(term) },
            {
              source: 'center',
              spec: { on: 'ailmentApplied', when: [{ ailment: 'burn' }], do: heal },
            },
          ],
          conversions: [],
          emitters: [],
        },
      );
      const ctx = placedEnemies([near(0, 0)], { stats });
      burn(ctx, 1000);
      burn(ctx, 500);
      runAt(ctx, effectOf(ctx, 0));
      const e = enemy(ctx, 1);
      const before = burnState(e);
      const events = atPulse(ctx, 1);
      expect(events.filter((ev) => ev.type === 'pulse')).toHaveLength(1);
      expect(ignites(events)).toEqual([]);
      expect(burnState(e)).toEqual(before);
      expect(queuedOf(ctx)).toEqual([]);
    });

    it('applies its burn term before its frost term (ignite, then freeze)', () => {
      const term: GroundZoneSpec = {
        ...ZONE,
        damagePctPerSec: 0,
        ailment: 'burn',
        addFrostPerSec: 8,
      };
      const ctx = placedEnemies([near(0, 0)], { stats: zoneStats([idle(term)]) });
      runAt(ctx, effectOf(ctx, 0));
      const events = atPulse(ctx, 1);
      const kinds = events.filter((ev) => ev.type === 'ignite' || ev.type === 'freeze');
      expect(kinds.map((ev) => ev.type)).toEqual(['ignite', 'freeze']);
    });

    it('applies a poison term before its frost term (ailmentApplied, then freeze)', () => {
      const term: GroundZoneSpec = {
        ...ZONE,
        damagePctPerSec: 0,
        ailment: 'poison',
        addFrostPerSec: 8,
      };
      const ctx = placedEnemies([near(0, 0)], { stats: zoneStats([idle(term)]) });
      runAt(ctx, effectOf(ctx, 0));
      const events = atPulse(ctx, 1);
      const kinds = events.filter((ev) => ev.type === 'ailmentApplied' || ev.type === 'freeze');
      expect(kinds.map((ev) => ev.type)).toEqual(['ailmentApplied', 'freeze']);
    });

    it('adds, raises and fires nothing in a build without burn duration', () => {
      const ctx = termCapped(1, 2, { values: { burnDuration: 0 } });
      expect(ctx.burnTicks).toBe(0);
      runAt(ctx, effectOf(ctx, 0));
      const e = enemy(ctx, 1);
      const before = burnState(e);
      const events = atPulse(ctx, 1);
      expect(e.burns).toEqual([]);
      expect(burnState(e)).toEqual(before);
      expect(events).toEqual([]);
      expect(queuedOf(ctx)).toEqual([]);
    });
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
  /**
   * A seeded run of fixtures: random hp, shock and freeze, crits, hooks and listeners, and from
   * C4.6c the rolls of rollsOf.
   */
  const FIXTURES = Array.from({ length: 48 }, (_, n) => n);
  /** The chances of the rolls: 0 and 1 draw nothing, .3 and .7 draw one chance each. */
  const CHANCES = [0, 0.3, 0.7, 1] as const;
  const heal: TriggerSpec['do'] = [{ kind: 'heal', lifePct: 0.01 }];
  /**
   * Modifiers that set the burn row apart from the hit row and a crit's rows from a plain hit's:
   * a burn reads its damage on its own slot row, a crit's burn on the crit one, and a crit's
   * frostOnHit on the crit row.
   */
  const ROW_MODS: readonly Modifier[] = [
    { stat: 'damage', kind: 'more', value: 1, tags: ['burn'] },
    { stat: 'damage', kind: 'more', value: 0.5, tags: ['burn', 'crit'] },
    { stat: 'frostOnHit', kind: 'flat', value: 0.2, tags: ['crit'] },
  ];

  /**
   * The rolls of fixture n (C4.6c, Q4 (B)): crit, ignite, poison, bleed and shock chances from
   * CHANCES, each taking every value, and crit every pair with ignite and with shock, in any 16
   * fixtures in a row; the always rows on every seventh; frostOnHit 0, .3 or 1, with a freeze
   * listener when above 0; an ailmentApplied trigger on one ailment; the burn and crit rows told
   * apart (ROW_MODS) on half; burn rings (eternalFlame) on five fixtures in ten; burnMaxStacks 2
   * on every third, whose even enemies start at that cap; and a payload copy that rolls no
   * ailments on every fifth.
   */
  function rollsOf(n: number) {
    const [a, b] = [n % 4, Math.floor(n / 4) % 4];
    const chance = (k: number): number => CHANCES[(a + k * b) % 4] as number;
    const frostOnHit = [0, 0.3, 1][Math.floor(n / 2) % 3] as number;
    const capped = n % 3 === 1;
    const ailment = (['burn', 'poison', 'bleed', 'shock'] as const)[Math.floor(n / 3) % 4];
    const listeners: TriggerSpec[] = [
      { on: 'ailmentApplied', when: [{ ailment: ailment ?? 'burn' }], do: heal },
    ];
    if (frostOnHit > 0) listeners.push({ on: 'freeze', do: heal });
    return {
      values: {
        critChance: chance(0),
        igniteChance: chance(1),
        poisonChance: chance(2),
        bleedChance: chance(3),
        shockChance: CHANCES[b] as number,
        frostOnHit,
        ...(capped ? { burnMaxStacks: 2 } : {}),
      },
      scoped: [...(n % 7 === 3 ? ALWAYS : []), ...(Math.floor(n / 3) % 2 === 1 ? ROW_MODS : [])],
      rules: Math.floor(n / 5) % 2 === 1 ? [{ id: 'eternalFlame' as const, durationMore: 0 }] : [],
      listeners,
      /** The payload hitPulse and hitWithPayload both take. */
      payload: (p: Payload): Payload => (n % 5 === 4 ? { ...p, rollsAilments: false } : p),
      /** Burns of dps 1000 and 1 on every even enemy: the cap, where an ignite replaces the 1. */
      prepare(ctx: RunContext): void {
        if (!capped) return;
        ctx.enemies.forEach((e, k) => {
          if (k % 2 !== 0) return;
          applyBurn(ctx, e, num(1000), 600, 0, ctx.burnCredit, 1);
          applyBurn(ctx, e, num(1), 600, 0, ctx.burnCredit, 1);
        });
        ctx.events.length = 0;
      },
    };
  }

  /**
   * What the rolls change, beside each test's own list: the enemies whole, the ring pool (its
   * arrays as strings, which compare far faster), the queued entries and the applied flags.
   */
  const rolledState = (ctx: RunContext) => ({
    enemies: ctx.enemies.map(({ def: _def, rec: _rec, ...e }) => e),
    rings: Object.entries(ctx.rings).map(([key, v]: [string, unknown]) => [
      key,
      ArrayBuffer.isView(v) ? String(v) : v,
    ]),
    queued: queuedOf(ctx),
    applied: [ctx.bleedApplied, ctx.frostApplied],
    freezeLimiter: ctx.freezeLimiter,
    damage: [ctx.damageBurn, ctx.damagePoison, ctx.damageBleed],
  });

  it.each(FIXTURES)('equals hitWithPayload on an aggregate payload (fixture %i)', (n) => {
    const r = createStreams(1000 + n).spawn;
    const rolls = rollsOf(n);
    const values = {
      ...rolls.values,
      critMultiplier: 1.5 + r.next(),
      frozenDamageTaken: 0.5,
      shockEffect: 0.2,
    };
    const scoped: Modifier[] = [
      ...(n % 4 === 0
        ? [{ stat: 'damage', kind: 'more', value: 0.5, tags: ['zone'] } as const]
        : []),
      ...rolls.scoped,
    ];
    const conversions =
      n % 5 === 0 ? [{ source: 'center', spec: { to: 'cold' as const, fraction: 0.4 } }] : [];
    const triggers: TriggerSpec[] = [idle(ZONE), ...rolls.listeners];
    if (n % 2 === 1) triggers.push({ on: 'hit', do: heal });
    if (n % 3 === 2) triggers.push({ on: 'crit', do: heal });
    const hooks: TestModule[] =
      n % 6 === 1
        ? [(b) => b.hook('modifyDamage', (_ctx, _hit, amount) => add(amount, num(7)))]
        : [];
    const placed = Array.from({ length: 10 }, (_, k) =>
      near(4 * k, 0, { hp: Math.round(50 + r.next() * 300) }),
    );
    // On every fourth from 2 the zone is a fusion's, whose burns are credited apart (burnMixed).
    const fused = n % 4 === 2;
    const make = (): RunContext => {
      const stats = makeStats({ damage: 400, ...values }, scoped, {
        ...centerTriggers(triggers),
        triggers: triggers.map((spec, k) => ({
          source: fused && k === 0 ? 'fusion.fire.aura' : 'center',
          spec,
        })),
        conversions,
      });
      const ctx = placedEnemies(placed, {
        stats,
        rules: rolls.rules,
        modules: hooks,
        seed: 7 + n,
      });
      ctx.enemies.forEach((e, k) => {
        if (k % 3 === 0) {
          e.shockStacks = 2;
          e.shockUntil = 1000;
        }
        if (k % 4 === 1) e.frozenUntil = 1000;
      });
      rolls.prepare(ctx);
      return ctx;
    };
    const a = make();
    const b = make();
    const scale = 0.25 + r.next();
    const pa = rolls.payload(a.effectPayloads[effectOf(a, 0)] as Payload);
    const pb = rolls.payload(b.effectPayloads[effectOf(b, 0)] as Payload);
    expect([pa.aggregate, a.burnMixed]).toEqual([true, fused]);
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
      counters: { ...ctx.counters },
      ...rolledState(ctx),
    });
    expect(state(a)).toEqual(state(b));
    expect(a.events.some((event) => event.type === 'hit')).toBe(false);
    if (n % 3 === 1) expect(a.sys.pulse.hits).toBeGreaterThan(0);
  });

  it.each(FIXTURES)(
    'equals hitWithPayload when every hit and crit trigger takes only signature hits (fixture %i)',
    (n) => {
      const r = createStreams(2000 + n).spawn;
      const rolls = rollsOf(n);
      const triggers: TriggerSpec[] = [idle(ZONE)];
      // Hit triggers, crit triggers or both; crit chance from CHANCES; depth 1 or MAX_DEPTH, at
      // which fire counts each listened event in triggerDepthCapped: every mix in 24 fixtures.
      const listens = n % 3;
      if (listens !== 2) triggers.push({ on: 'hit', when: [{ hitIs: 'signature' }], do: heal });
      if (listens !== 1) triggers.push({ on: 'crit', when: [{ hitIs: 'signature' }], do: heal });
      const depth = Math.floor(n / 12) % 2 === 0 ? 1 : MAX_DEPTH;
      // The rolls' ailmentApplied and freeze triggers, which quiet leaves alone, queue at depth 1
      // only: at MAX_DEPTH their events would count in triggerDepthCapped too.
      if (depth === 1) triggers.push(...rolls.listeners);
      // Some survive their hit, whose dispatch is the quiet one, and some die of it.
      const placed = Array.from({ length: 10 }, (_, k) =>
        near(4 * k, 0, { hp: Math.round(50 + r.next() * 600) }),
      );
      const make = (): RunContext => {
        const stats = makeStats(
          { damage: 400, critMultiplier: 2, ...rolls.values },
          rolls.scoped,
          centerTriggers(triggers),
        );
        const ctx = placedEnemies(placed, { stats, rules: rolls.rules, seed: 11 + n });
        rolls.prepare(ctx);
        return ctx;
      };
      const a = make();
      const b = make();
      const scale = 0.1 + 0.6 * r.next();
      const pa = rolls.payload(a.effectPayloads[effectOf(a, 0)] as Payload);
      const pb = rolls.payload(b.effectPayloads[effectOf(b, 0)] as Payload);
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
        ...rolledState(ctx),
      });
      expect(state(a)).toEqual(state(b));
      // Each hit's events, lethal or not, reach fire once: at MAX_DEPTH each listened one counts.
      const pulse = a.sys.pulse;
      const capped = (listens !== 2 ? pulse.hits : 0) + (listens !== 1 ? pulse.critCount : 0);
      expect(a.counters.triggerDepthCapped).toBe(depth === MAX_DEPTH ? capped : 0);
    },
  );

  /**
   * The enemies of the defended cases below (C7.3, docs/v3 C7 design §2.4): shielders at even
   * ids, the first so sturdy that its shield blocks every hit, the others only the smaller ones,
   * and squares that die to some hits, every one armoured but the first (armour()).
   */
  const defendedPlaced = (r: { next(): number }): PlacedEnemy[] =>
    Array.from({ length: 10 }, (_, k) =>
      near(
        4 * k,
        0,
        k % 2 === 0
          ? { type: 'shielder', hp: k === 0 ? 1e9 : Math.round(1000 + r.next() * 4000) }
          : { type: 'square', hp: Math.round(50 + r.next() * 600) },
      ),
    );
  const armour = (ctx: RunContext): void => {
    ctx.enemies.forEach((e, k) => {
      if (k % 2 === 1 && k > 1) (e.v3 as EnemyV3).defence |= ARMOURED;
    });
  };

  it.each(FIXTURES)(
    'equals hitWithPayload on shielded and armoured enemies (fixture %i; OWN test 10)',
    (n) => {
      const r = createStreams(3000 + n).spawn;
      const rolls = rollsOf(n);
      const values = {
        ...rolls.values,
        critMultiplier: 1.5 + r.next(),
        frozenDamageTaken: 0.5,
        shockEffect: 0.2,
      };
      // Poison through a block on every fourth fixture from 1, armour passed on crits from 2.
      const scoped: Modifier[] = [
        ...rolls.scoped,
        ...(n % 4 === 1
          ? [{ stat: 'ailmentOnBlock', kind: 'flat', value: 1, tags: ['poison'] } as const]
          : []),
        ...(n % 4 === 2
          ? [{ stat: 'ignoreArmour', kind: 'flat', value: 1, tags: ['crit'] } as const]
          : []),
      ];
      // A cold part, which the shields test, or a poison part, which passes them.
      const poisonPart = n % 5 === 3;
      const conversions =
        n % 5 === 0
          ? [{ source: 'center', spec: { to: 'cold' as const, fraction: 0.4 } }]
          : poisonPart
            ? [{ source: 'center', spec: { to: 'poison' as const, fraction: 0.5 } }]
            : [];
      const triggers: TriggerSpec[] = [idle(ZONE), ...rolls.listeners];
      if (n % 2 === 1) triggers.push({ on: 'hit', do: heal });
      if (n % 3 === 2) triggers.push({ on: 'crit', do: heal });
      const placed = defendedPlaced(r);
      const make = (): RunContext => {
        const stats = makeStats({ damage: 400, ...values }, scoped, {
          ...centerTriggers(triggers),
          conversions,
        });
        const ctx = placedEnemies(placed, {
          stats,
          rules: rolls.rules,
          seed: 17 + n,
          data: v3TestData(),
        });
        armour(ctx);
        ctx.enemies.forEach((e, k) => {
          if (k % 3 === 0) {
            e.shockStacks = 2;
            e.shockUntil = 1000;
          }
          if (k % 4 === 1) e.frozenUntil = 1000;
        });
        rolls.prepare(ctx);
        return ctx;
      };
      const a = make();
      const b = make();
      const scale = 0.25 + r.next();
      const pa = rolls.payload(a.effectPayloads[effectOf(a, 0)] as Payload);
      const pb = rolls.payload(b.effectPayloads[effectOf(b, 0)] as Payload);
      hoistPulseRows(a, a.sys.pulse, pa);
      for (let k = 0; k < a.enemies.length; k++) {
        const [ea, eb] = [a.enemies[k] as Enemy, b.enemies[k] as Enemy];
        if (ea.alive) hitPulse(a, a.sys.pulse, ea, pa, scale, 1, FIRST);
        if (eb.alive) hitWithPayload(b, eb, pb, 0, scale, null, null, false, 1, FIRST);
      }
      const state = (ctx: RunContext) => ({
        hp: ctx.enemies.map((e) => [e.hp, e.alive, e.killDepth]),
        tallies: [ctx.damageHit, ctx.damageCrit, ctx.damagePoison, ctx.maxHit, ctx.kills],
        bySource: ctx.bySource.slice(0, 4),
        rng: rngPositions(ctx),
        pulse: { ...ctx.sys.pulse, row: 0, critRow: 0, crits: [...ctx.sys.pulse.crits] },
        events: ctx.events.slice(),
        queue: queuedOf(ctx),
        life: ctx.player.life,
        counters: { ...ctx.counters },
        ...rolledState(ctx),
      });
      expect(state(a)).toEqual(state(b));
      // No hit raised an event: a pulse's blocked ones push no hitBlocked either.
      expect(a.events.some((event) => event.type === 'hit' || event.type === 'hitBlocked')).toBe(
        false,
      );
      // The pulse counts and totals the hits that landed, and those alone.
      const struck = a.enemies.filter((e) => e.hp !== e.maxHp);
      const first = a.enemies[0] as Enemy;
      if (!poisonPart) expect(struck).not.toContain(first);
      expect(a.sys.pulse.hits).toBe(struck.length);
      const lost = struck.reduce((sum, e) => sum + toNumber(sub(e.maxHp, e.hp)), 0);
      expect(toNumber(a.sys.pulse.total)).toBeCloseTo(lost, 6);
      // A sure ignite burns the first shielder, whose shield blocked the hit.
      const sure = rolls.values.igniteChance === 1 || n % 7 === 3;
      if (sure && pa.rollsAilments && !poisonPart) {
        const ignited = a.events.some((e) => e.type === 'ignite' && e.targetId === first.id);
        expect(ignited).toBe(true);
      }
    },
  );

  it.each(FIXTURES)(
    'equals hitWithPayload on shielded and armoured enemies when every hit and crit trigger takes only signature hits (fixture %i; OWN test 10)',
    (n) => {
      const r = createStreams(4000 + n).spawn;
      const rolls = rollsOf(n);
      const triggers: TriggerSpec[] = [idle(ZONE)];
      const listens = n % 3;
      if (listens !== 2) triggers.push({ on: 'hit', when: [{ hitIs: 'signature' }], do: heal });
      if (listens !== 1) triggers.push({ on: 'crit', when: [{ hitIs: 'signature' }], do: heal });
      const depth = Math.floor(n / 12) % 2 === 0 ? 1 : MAX_DEPTH;
      if (depth === 1) triggers.push(...rolls.listeners);
      const placed = defendedPlaced(r);
      const make = (): RunContext => {
        const stats = makeStats(
          { damage: 400, critMultiplier: 2, ...rolls.values },
          rolls.scoped,
          centerTriggers(triggers),
        );
        const ctx = placedEnemies(placed, {
          stats,
          rules: rolls.rules,
          seed: 19 + n,
          data: v3TestData(),
        });
        armour(ctx);
        rolls.prepare(ctx);
        return ctx;
      };
      const a = make();
      const b = make();
      const scale = 0.1 + 0.6 * r.next();
      const pa = rolls.payload(a.effectPayloads[effectOf(a, 0)] as Payload);
      const pb = rolls.payload(b.effectPayloads[effectOf(b, 0)] as Payload);
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
        ...rolledState(ctx),
      });
      expect(state(a)).toEqual(state(b));
      // Only the hits that landed reach fire: the first shielder's never does.
      const pulse = a.sys.pulse;
      expect(pulse.hits).toBe(a.enemies.filter((e) => e.hp !== e.maxHp).length);
      expect(pulse.hits).toBeLessThan(a.enemies.length);
      const capped = (listens !== 2 ? pulse.hits : 0) + (listens !== 1 ? pulse.critCount : 0);
      expect(a.counters.triggerDepthCapped).toBe(depth === MAX_DEPTH ? capped : 0);
    },
  );

  it('returns false for a hit the defences block in full and true for any other (R1)', () => {
    /**
     * hitPulse of the zone's payload at scale 1, a hit of 100, on each of `placed` in turn: what
     * it returned, and whether each enemy is alive after it.
     */
    const returns = (
      placed: readonly PlacedEnemy[],
      { poison = 0, m1 = false }: { poison?: number; m1?: boolean } = {},
    ): { returned: boolean[]; alive: boolean[] } => {
      const conversions =
        poison > 0 ? [{ source: 'center', spec: { to: 'poison' as const, fraction: poison } }] : [];
      const stats = makeStats({ damage: 400, critChance: 0, igniteChance: 0 }, [], {
        ...centerTriggers([idle(ZONE)]),
        conversions,
      });
      const ctx = placedEnemies(placed, { stats, ...(m1 ? {} : { data: v3TestData() }) });
      expect(ctx.enemies.every((e) => (e.v3 === null) === m1)).toBe(true);
      const p = ctx.effectPayloads[effectOf(ctx, 0)] as Payload;
      hoistPulseRows(ctx, ctx.sys.pulse, p);
      const returned = ctx.enemies.map((e) => hitPulse(ctx, ctx.sys.pulse, e, p, 1, 0, -1));
      // A hit returns false exactly when it adds nothing to the pulse.
      expect(ctx.sys.pulse.hits).toBe(returned.filter((r) => r).length);
      return { returned, alive: ctx.enemies.map((e) => e.alive) };
    };
    // Blocked, landed, on an enemy without defences, and a kill.
    const placed = [
      near(0, 0, { type: 'shielder', hp: 1e6 }),
      near(4, 0, { type: 'shielder', hp: 500 }),
      near(8, 0, { type: 'square', hp: 1e6 }),
      near(12, 0, { type: 'square', hp: 50 }),
    ];
    expect(returns(placed)).toEqual({
      returned: [false, true, true, true],
      alive: [true, true, true, false],
    });
    // A converted hit the shield blocks in part: its hit part, not its poison part.
    expect(returns(placed.slice(0, 1), { poison: 0.5 }).returned).toEqual([true]);
    // An M1 run's enemy, which has no record.
    expect(returns([near(0, 0)], { m1: true }).returned).toEqual([true]);
  });

  it('lets an aura pulse’s blocked hit add nothing to its hits or total, and still burn (OWN test 10)', () => {
    // A shielder whose shield blocks every pulse hit and a square, both within the aura.
    const ctx = placedEnemies(
      [near(-250, 0, { type: 'shielder', hp: 1e6 }), near(-220, 0, { type: 'square', hp: 1e6 })],
      {
        stats: makeStats({ damage: 10, critChance: 0, igniteChance: 1 }, [], {
          triggers: [],
          conversions: [],
          emitters: [{ source: 'outer.aura', grant: { kind: 'aura' } }],
        }),
        data: v3TestData(),
      },
    );
    const em = ctx.emitters[1] as EmitterRuntime;
    ctx.now = (3 + 4 * em.index) % PHASE_TICKS;
    runAura(ctx, em);
    const [one, two] = ctx.enemies as [Enemy, Enemy];
    // A pulse hit deals 2.5: the shielder's is blocked, the square's lands.
    expect([toNumber(one.hp), toNumber(two.hp)]).toEqual([1e6, 1e6 - 2.5]);
    expect(pulsesOf(ctx.events)).toEqual([
      { type: 'pulse', kind: 'aura', id: 1, hits: 1, total: num(2.5), crits: [] },
    ]);
    expect(ctx.events.some((event) => event.type === 'hitBlocked')).toBe(false);
    // Both ignite: the blocked hit's burn goes through applyPulseBurn as the landed one's.
    expect(
      ctx.events.flatMap((event) => (event.type === 'ignite' ? [event.targetId] : [])),
    ).toEqual([1, 2]);
    expect(one.burns.map((b) => b.dps)).toEqual(two.burns.map((b) => b.dps));
  });

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
      // One enemy in every zone; it never dies, so each pulse hits it once. Its hits roll no
      // ailment (igniteChance 0), so each pulse raises its pulse event only.
      const ctx = placedEnemies([near(0, 0, { hp: 1e15 })], {
        stats: zoneStats([idle(ZONE)], { igniteChance: 0 }),
      });
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
