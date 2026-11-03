/**
 * V1a and V1b's view members and their render helpers (src/render/simViews.ts): a zone's slow by
 * its slot through ZonePoolState's record and slow, the pool's own arrays, as zones are added,
 * end and are evicted; and ShotPoolState.launched, written at every shot's spawn and carried
 * through the pool's compaction, with a lob's flight progress from it.
 */

import { describe, expect, it } from 'vitest';
import type { SignatureSpec } from '../data/rules';
import type { GroundZoneSpec, TriggerSpec } from '../data/triggers';
import { ZONE_SOURCE_CAP } from '../sim/caps';
import { runEffect } from '../sim/effects/execute';
import { createEffectEntry } from '../sim/effects/queue';
import { SHATTER_TRIGGER } from '../sim/effects/types';
import type { CompiledTrigger } from '../sim/effects/types';
import type { Payload } from '../sim/emitters/types';
import type { TestModule } from '../sim/rules';
import { createSimulation } from '../sim/simulation';
import type { RunContext } from '../sim/systems/context';
import {
  compactShots,
  MOTION_HOMING,
  MOTION_LOB,
  MOTION_STRAIGHT,
  spawnShot,
  stepShot,
} from '../sim/systems/shots';
import { stepZones } from '../sim/systems/zones';
import { centerTriggers, makeConfig, makeStats, makeTestData, placedEnemies } from '../sim/testing';
import { NO_INPUT } from '../sim/types';
import type { ShotPoolState, SimEvent, ZonePoolState } from '../sim/types';
import { lobProgress, zoneSlowAt } from './simViews';

type ZoneEvent = Extract<SimEvent, { type: 'zone' }>;
type LobEvent = Extract<SimEvent, { type: 'lob' }>;

/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

/** A trigger that never fires here, holding one effect a test runs by hand. */
const idle = (effect: GroundZoneSpec): TriggerSpec => ({
  on: 'periodic',
  every: 1000,
  do: [effect],
});
const zone = (durationSec: number, slow?: number): GroundZoneSpec => ({
  kind: 'groundZone',
  radius: 40,
  durationSec,
  damagePctPerSec: 0,
  ...(slow === undefined ? {} : { slow }),
});

/** Four groundZone effects on center: their slows (the third has none) and durations. */
const ZONES = [zone(1, 0.25), zone(2, 0.5), zone(0.5), zone(3, 0.75)];
const SLOWS = [0.25, 0.5, 0, 0.75];

function zoneCtx(): RunContext {
  return placedEnemies([], {
    stats: makeStats({ damage: 400, critChance: 0 }, [], centerTriggers(ZONES.map(idle))),
  });
}

/** Runs zone effect k at a spot of its own; returns the tick's events, the zone's first. */
function addZoneOf(ctx: RunContext, k: number, spot: number): SimEvent[] {
  const entry = createEffectEntry();
  entry.effect = (ctx.build.triggers[FIRST + k] as CompiledTrigger).effectStart;
  entry.depth = 0;
  entry.origin = -1;
  entry.source = 0;
  entry.x = 200 + (spot % 30) * 50;
  entry.y = 200 + (Math.floor(spot / 30) % 16) * 50;
  ctx.events.length = 0;
  runEffect(ctx, entry);
  return ctx.events.slice();
}

describe('ZonePoolState.record and slow (V1a), read by zoneSlowAt', () => {
  it('are the pool’s own arrays: the view copies nothing', () => {
    const ctx = zoneCtx();
    const view: ZonePoolState = ctx.state.zones;
    expect(view.record).toBe(ctx.sys.zones.record);
    expect(view.slow).toBe(ctx.sys.zones.slow);
  });

  it('reads each zone’s slow by its slot as older zones end and are evicted, 0 for a slowless zone', () => {
    const ctx = zoneCtx();
    const slowOf = new Map<number, number>();
    let spot = 0;
    let checked = 0;
    let bySlotWrong = 0;
    let moved = 0;
    let evictions = 0;
    let slowless = 0;
    for (let t = 0; t < 420; t++) {
      // A zone every few ticks, cycling through the four; now and then a burst past
      // ZONE_SOURCE_CAP, so the source's oldest are evicted and the slots close up.
      const burst = t % 140 === 70 ? ZONE_SOURCE_CAP + 2 : t % 7 === 0 ? 1 : 0;
      for (let b = 0; b < burst; b++) {
        const k = (t + b) % ZONES.length;
        const events = addZoneOf(ctx, k, spot++);
        const added = events.find((event): event is ZoneEvent => event.type === 'zone');
        slowOf.set(added?.id ?? -1, SLOWS[k] as number);
        evictions += events.filter((e) => e.type === 'zoneEnd' && e.evicted).length;
        checkSlots();
      }
      ctx.now = ++ctx.state.tick;
      ctx.events.length = 0;
      stepZones(ctx);
      checkSlots();
    }
    function checkSlots(): void {
      const z = ctx.state.zones;
      for (let s = 0; s < ctx.state.zoneCount; s++) {
        const expected = slowOf.get(z.id[s] as number);
        expect(zoneSlowAt(z, s), `tick ${ctx.now} slot ${s}`).toBe(expected);
        if (z.slow[s] !== expected) bySlotWrong++;
        if (z.record[s] !== s) moved++;
        if (expected === 0) slowless++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
    // The slot is not the record: a read of slow by slot is wrong somewhere.
    expect(bySlotWrong).toBeGreaterThan(200);
    expect(moved).toBeGreaterThan(500);
    expect(evictions).toBeGreaterThan(0);
    expect(slowless).toBeGreaterThan(50);
    expect(ctx.counters.zonesEvicted).toBe(evictions);
  });

  it('reads the lob’s fire zones’ slow, 0 without one, and each effect zone’s own, in a run', () => {
    const slowFire: TestModule = (b) => {
      const lob = b.signature().lob;
      if (lob !== null) lob.zone.slow = 0.3;
    };
    const stats = makeStats(
      { damage: 8, maxLife: 1e6, attackSpeed: 6, projectileCount: 2 },
      [],
      centerTriggers([
        { on: 'hit', when: [{ chance: 0.3 }], do: [zone(1.5, 0.4)] },
        { on: 'kill', do: [zone(0.75)] },
      ]),
    );
    const read = (modules: readonly TestModule[]): Map<string, number> => {
      const sim = createSimulation(
        makeConfig({ seed: 5, stats, signature: { id: 'magmaBomb' }, startWave: 8, maxTicks: 900 }),
        makeTestData(),
        modules,
      );
      // Each zone's slow as read at every tick, by kind and slow, counted.
      const seen = new Map<string, number>();
      while (!sim.state.finished) {
        sim.step(NO_INPUT);
        const z = sim.state.zones;
        for (let s = 0; s < sim.state.zoneCount; s++) {
          const key = `${z.signature[s] === 1 ? 'signature' : 'effect'} ${zoneSlowAt(z, s)}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
      return seen;
    };
    const slowed = read([slowFire]);
    expect([...slowed.keys()].sort()).toEqual(['effect 0', 'effect 0.4', 'signature 0.3']);
    for (const n of slowed.values()) expect(n).toBeGreaterThan(30);
    expect([...read([]).keys()].sort()).toEqual(['effect 0', 'effect 0.4', 'signature 0']);
  });
});

describe('ShotPoolState.launched (V1b)', () => {
  /** The run's volley payload, which every shot here carries. */
  const payloadOf = (ctx: RunContext): Payload => (ctx.emitters[0] as { payload: Payload }).payload;

  it('is the tick each shot was spawned, straight, homing and lobbed alike', () => {
    const ctx = placedEnemies([{ x: 1500, y: 540 }]);
    const p = payloadOf(ctx);
    const target = ctx.enemies[0] ?? null;
    const spawned: [number, number][] = [];
    for (const [now, motion] of [
      [3, MOTION_STRAIGHT],
      [7, MOTION_HOMING],
      [12, MOTION_LOB],
      [12, MOTION_STRAIGHT],
    ] as const) {
      ctx.now = now;
      const s = spawnShot(
        ctx,
        motion,
        0,
        0,
        1,
        0,
        now + 100,
        p,
        1,
        1,
        0,
        0,
        -1,
        false,
        -1,
        -1,
        target,
      );
      spawned.push([s, now]);
    }
    const shots: ShotPoolState = ctx.state.shots;
    expect(spawned.map(([s]) => shots.launched[s])).toEqual([3, 7, 12, 12]);
    expect(Array.from(shots.motion.subarray(0, 4))).toEqual([0, 1, 2, 0]);
  });

  it('is carried through the compaction when earlier shots end', () => {
    const ctx = placedEnemies([{ x: 1700, y: 100 }]);
    const p = payloadOf(ctx);
    // Six straight shots launched on ticks 1 .. 6, flying away from the enemy; shots 1, 2 and 4
    // (slots 0, 1, 3) expire on tick 8, the others later.
    const untils = [8, 8, 40, 8, 40, 40];
    untils.forEach((until, k) => {
      ctx.now = k + 1;
      spawnShot(
        ctx,
        MOTION_STRAIGHT,
        600,
        540,
        -1,
        0,
        until,
        p,
        1,
        1,
        0,
        0,
        -1,
        false,
        -1,
        -1,
        null,
      );
    });
    const shots = ctx.state.shots;
    const ids = Array.from(shots.id.subarray(0, 6));
    ctx.now = 8;
    for (let s = 0; s < ctx.shots.count; s++) stepShot(ctx, s);
    compactShots(ctx);
    expect(ctx.state.shotCount).toBe(3);
    expect(Array.from(shots.id.subarray(0, 3))).toEqual([ids[2], ids[4], ids[5]]);
    expect(Array.from(shots.launched.subarray(0, 3))).toEqual([3, 5, 6]);
    expect(Array.from(shots.until.subarray(0, 3))).toEqual([40, 40, 40]);
  });

  it.each([
    ['lobbed', { id: 'magmaBomb' }, MOTION_LOB],
    ['straight', { id: 'iceFan' }, MOTION_STRAIGHT],
    ['homing', { id: 'swarm' }, MOTION_HOMING],
  ] as const)(
    'holds each %s shot’s launch tick in a run, the tick it first shows, wherever its slot moves',
    (_name, signature: SignatureSpec, motion) => {
      // Effect shots, straight and homing, beside the signature's: shots end out of id order, so
      // the compaction moves the later ones down.
      const stats = makeStats(
        { damage: 6, maxLife: 1e6, attackSpeed: 6, projectileCount: 2 },
        [],
        centerTriggers([
          {
            on: 'hit',
            when: [{ chance: 0.5 }],
            do: [{ kind: 'projectiles', count: 3, aim: 'radial', damagePct: 0.2 }],
          },
          { on: 'kill', do: [{ kind: 'projectiles', count: 1, aim: 'target', damagePct: 0.3 }] },
        ]),
      );
      const sim = createSimulation(
        makeConfig({ seed: 2, stats, signature, startWave: 8, maxTicks: 1200 }),
        makeTestData(),
      );
      const firstSeen = new Map<number, number>();
      const slotOf = new Map<number, number>();
      const lobs = new Map<number, LobEvent>();
      let checked = 0;
      let moved = 0;
      let lobsChecked = 0;
      while (!sim.state.finished) {
        const events = sim.step(NO_INPUT);
        const tick = sim.state.tick;
        for (const event of events) if (event.type === 'lob') lobs.set(event.id, event);
        const shots = sim.state.shots;
        for (let s = 0; s < sim.state.shotCount; s++) {
          const id = shots.id[s] as number;
          if (!firstSeen.has(id)) firstSeen.set(id, tick);
          expect(shots.launched[s], `shot ${id} at tick ${tick}`).toBe(firstSeen.get(id));
          if (slotOf.has(id) && slotOf.get(id) !== s && shots.motion[s] === motion) moved++;
          slotOf.set(id, s);
          if (shots.motion[s] === motion) checked++;
          const lob = lobs.get(id);
          if (lob !== undefined) {
            // The lob event's tick is its launch and landAt its until.
            expect([shots.launched[s], shots.until[s]]).toEqual([firstSeen.get(id), lob.landAt]);
            lobsChecked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(100);
      expect(moved).toBeGreaterThan(10);
      if (motion === MOTION_LOB) expect(lobsChecked).toBeGreaterThan(100);
    },
  );
});

describe('lobProgress (V1b)', () => {
  /** A pool of one lobbed shot launched on tick 10 that lands on tick 40. */
  const one = (launched: number, until: number): ShotPoolState => ({
    id: Int32Array.of(1),
    motion: Uint8Array.of(MOTION_LOB),
    x: Float64Array.of(0),
    y: Float64Array.of(0),
    vx: Float64Array.of(0),
    vy: Float64Array.of(0),
    until: Int32Array.of(until),
    form: Uint8Array.of(0),
    launched: Int32Array.of(launched),
  });

  it('is 0 on the launch tick, 1 on the landing tick and linear between, clamped outside', () => {
    const shots = one(10, 40);
    expect([10, 25, 40, 31, 9, 41].map((now) => lobProgress(shots, 0, now))).toEqual([
      0, 0.5, 1, 0.7, 0, 1,
    ]);
    // A frame between ticks: SimState.tick − 1 + alpha.
    expect(lobProgress(shots, 0, 24 + 0.25)).toBeCloseTo(14.25 / 30, 12);
  });

  it('reads 1 for a shot that lands on its launch tick, never NaN', () => {
    expect(lobProgress(one(10, 10), 0, 10)).toBe(1);
    expect(lobProgress(one(10, 9), 0, 10)).toBe(1);
  });

  it('runs 0 to 1 over every lobbed shot’s flight in a run, from the lob event to its landing', () => {
    const stats = makeStats({ damage: 6, maxLife: 1e6, attackSpeed: 6, projectileCount: 2 });
    const sim = createSimulation(
      makeConfig({ seed: 3, stats, signature: { id: 'magmaBomb' }, startWave: 8, maxTicks: 900 }),
      makeTestData(),
    );
    const progress = new Map<number, number[]>();
    let inFlight = new Set<number>();
    while (!sim.state.finished) {
      const events = sim.step(NO_INPUT);
      for (const event of events) if (event.type === 'lob') progress.set(event.id, []);
      const shots = sim.state.shots;
      inFlight = new Set();
      for (let s = 0; s < sim.state.shotCount; s++) {
        const id = shots.id[s] as number;
        inFlight.add(id);
        progress.get(id)?.push(lobProgress(shots, s, sim.state.tick));
      }
    }
    let flights = 0;
    for (const [id, seen] of progress) {
      // Bombs still flying when the run ends have not landed.
      if (seen.length === 0 || inFlight.has(id)) continue;
      // Shown from its launch tick (0) to the tick before it lands, rising by 1/flightTicks.
      expect(seen[0]).toBe(0);
      const step = seen[1] as number;
      expect(step).toBeGreaterThan(0);
      seen.forEach((value, k) => expect(value).toBeCloseTo(k * step, 12));
      expect((seen.length - 1) * step + step).toBeCloseTo(1, 12);
      flights++;
    }
    expect(flights).toBeGreaterThan(20);
  });
});
