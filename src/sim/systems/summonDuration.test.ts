/**
 * E4's summonDuration stat (召喚物存在時間, docs/v3/game-design-v3.md :199 ◆蜂王漿; lead ruling
 * R5): every timed row a spawnDrone effect appends lives max(1, round(lifeSec × 60 ×
 * max(0, summonDuration))) ticks, the stat read once a run at the drone pool's fill
 * (SpawnSpecs.lifeTicks). At 1 the life is the base's, bit for bit; the stat reaches no fixed
 * row, zone, shot or dock time. Each test names in a comment the planted bug it kills.
 */

import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import type { DroneGrant, SourcedEmitter } from '../../data/emitters';
import type { StatId } from '../../data/stats';
import type { SpawnDroneSpec, TriggerSpec } from '../../data/triggers';
import { runEffect } from '../effects/execute';
import { createEffectEntry } from '../effects/queue';
import type { CompiledEffectKind } from '../effects/types';
import type { EmitterRuntime } from '../emitters/types';
import { makeStats, placedEnemies } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, TICK_RATE } from '../types';
import type { SimEvent } from '../types';
import type { RunContext } from './context';
import { stepDrones } from './drones';
import { rebuildGrid } from './grid';
import { NEVER_LEAVES } from './systemState';
import type { SpawnSpecs } from './systemState';

type ExpireEvent = Extract<SimEvent, { type: 'droneExpire' }>;

/** The player, at the arena's centre. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };

const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...more,
});
const drone = (fields: Omit<DroneGrant, 'kind'>): SourcedEmitter => ({
  source: 'outer.summon',
  grant: { kind: 'drone', ...fields },
});
/** A trigger that never fires in these tests (no enemy reaches the player): it holds `effects`. */
const holder = (...effects: TriggerSpec['do']): TriggerSpec => ({ on: 'heroHit', do: effects });
const spirit = (lifeSec: number, fields: Partial<SpawnDroneSpec> = {}): SpawnDroneSpec => ({
  kind: 'spawnDrone',
  lifeSec,
  damagePct: 1,
  ...fields,
});

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly grants?: readonly SourcedEmitter[];
  readonly triggers?: readonly TriggerSpec[];
}

/** placedEnemies with these grants and triggers over NO_ROLLS. */
function field(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'outer.summon', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
  });
}

const specsOf = (ctx: RunContext): SpawnSpecs => ctx.sys.drones.specs as SpawnSpecs;
/** The indexes of the build's compiled effects of `kind`, in order. */
const effectsOf = (ctx: RunContext, kind: CompiledEffectKind): number[] =>
  ctx.build.effects.flatMap((fx, i) => (fx.kind === kind ? [i] : []));

/** Runs compiled effect `effect` through its executor on the current tick at `point`. */
function run(ctx: RunContext, effect: number, point: { readonly x: number; readonly y: number }) {
  const entry = createEffectEntry();
  entry.effect = effect;
  entry.depth = 1;
  entry.origin = -1;
  entry.x = point.x;
  entry.y = point.y;
  runEffect(ctx, entry);
}

/** The next tick's drone stage; returns its events. */
function next(ctx: RunContext): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  rebuildGrid(ctx);
  ctx.events.length = 0;
  stepDrones(ctx);
  return ctx.events.slice();
}

describe('the summonDuration stat (lead ruling R5)', () => {
  /** Lives in seconds, some on a half tick: 1.5, 2.25 and 0.24 ticks among them. */
  const LIVES = [4, 2.5, 0.025, 1 / 60, 0.004, 3.3];
  const lifeTicksAt = (summonDuration: number): number[] => {
    const ctx = field([], {
      values: { summonDuration },
      triggers: [holder(...LIVES.map((lifeSec) => spirit(lifeSec)))],
    });
    const specs = specsOf(ctx);
    return effectsOf(ctx, 'spawnDrone').map((f) => specs.lifeTicks[f] as number);
  };

  it('gives each spawnDrone max(1, round(lifeSec × 60 × summonDuration)) ticks, × before the rounding', () => {
    // Planted bug: the stat applied after the rounding (0.025 s is 1.5 ticks: round(1.5) × 1.5
    // = 3, where round(2.25) = 2).
    expect(lifeTicksAt(1)).toEqual([240, 150, 2, 1, 1, 198]);
    expect(lifeTicksAt(1.5)).toEqual([360, 225, 2, 2, 1, 297]);
    expect(lifeTicksAt(2)).toEqual([480, 300, 3, 2, 1, 396]);
    expect(lifeTicksAt(0.5)).toEqual([120, 75, 1, 1, 1, 99]);
  });

  it('gives each row one tick at 0 and below, where the stat is clamped', () => {
    // A planted missing clamp at 0 is equivalent: max(1, ·) holds every negative life at 1.
    expect(lifeTicksAt(0)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(lifeTicksAt(-0.5)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('is the base’s life at 1, bit for bit, over 500 seeded lives', () => {
    // Planted bug: any reordering at 1 (lifeSec × summonDuration first, then × 60) that moves a
    // half-tick life.
    const rng = createRng(4242);
    const lives = Array.from({ length: 500 }, () => rng.int(600) / 60 + rng.next() / 120);
    const ctx = field([], {
      triggers: [holder(...lives.map((lifeSec) => spirit(lifeSec)))],
    });
    const specs = specsOf(ctx);
    const got = effectsOf(ctx, 'spawnDrone').map((f) => specs.lifeTicks[f] as number);
    expect(got).toEqual(lives.map((lifeSec) => Math.max(1, Math.round(lifeSec * TICK_RATE))));
  });

  it('lets a row live its lifeTicks from its spawn: a 2 s spirit leaves on time 180 ticks on at 1.5', () => {
    // Planted bug: the executor's round(lifeSec × 60) kept (the stat read nowhere but the table).
    const leaves = (summonDuration: number): number[] => {
      const ctx = field([], {
        values: { summonDuration, attackSpeed: 0 },
        triggers: [holder(spirit(2))],
      });
      ctx.now = ctx.state.tick = 7;
      run(ctx, effectsOf(ctx, 'spawnDrone')[0] as number, P);
      expect(ctx.sys.drones.until[0]).toBe(7 + (specsOf(ctx).lifeTicks[0] as number));
      const out: number[] = [];
      for (let n = 0; n < 400 && ctx.sys.drones.count > 0; n++) {
        const expired = next(ctx).filter((e): e is ExpireEvent => e.type === 'droneExpire');
        for (const e of expired) out.push(ctx.now, e.cause === 'time' ? 1 : 0);
      }
      return out;
    };
    expect(leaves(1)).toEqual([7 + 120, 1]);
    expect(leaves(1.5)).toEqual([7 + 180, 1]);
  });

  it('reads the stat once, at the fill: a later change of the run’s value moves no life', () => {
    // Planted bug: the executor reading build.values.summonDuration at the spawn.
    const ctx = field([], { values: { summonDuration: 1.5 }, triggers: [holder(spirit(2))] });
    (ctx.build.values as Record<StatId, number>).summonDuration = 3;
    run(ctx, effectsOf(ctx, 'spawnDrone')[0] as number, P);
    expect(ctx.sys.drones.until[0]).toBe(ctx.now + 180);
  });

  it('reaches no fixed row, zone, shot or dock time: summonDuration 2.5 changes only the lives', () => {
    // Planted bugs: the stat on the fixed rows' NEVER_LEAVES; on a groundZone's duration; on the
    // turret shots' life; on the drones' dock time or cooldown.
    const build = (summonDuration: number) => {
      const ctx = field([at(300, 0)], {
        values: { summonDuration, projectileCount: 1 },
        grants: [drone({ drones: 2, turrets: 1 })],
        triggers: [
          holder(
            spirit(2),
            { kind: 'groundZone', radius: 50, durationSec: 2, damagePctPerSec: 0.5 },
            { kind: 'projectiles', count: 2, aim: 'radial', damagePct: 0.5 },
          ),
        ],
      });
      ctx.now = ctx.state.tick = 5;
      run(ctx, effectsOf(ctx, 'groundZone')[0] as number, P);
      run(ctx, effectsOf(ctx, 'projectiles')[0] as number, P);
      const ds = ctx.sys.drones;
      const em = ctx.emitters[1] as EmitterRuntime;
      ds.acc[2] = em.interval;
      next(ctx);
      const { lifeTicks, live, ...tables } = specsOf(ctx);
      return {
        until: Array.from(ds.until.subarray(0, 3)),
        dock: [ds.dockTicks[1], ds.coolTicks[1], ds.stepBase[1], ds.impacts[1]],
        zone: [ctx.state.zoneCount, ctx.sys.zones.expiresAt[0]],
        shots: Array.from({ length: ctx.shots.count }, (_, s) => ctx.shots.until[s]),
        tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, Array.from(v)])),
        lifeTicks: effectsOf(ctx, 'spawnDrone').map((f) => lifeTicks[f]),
        live: Array.from(live),
      };
    };
    const plain = build(1);
    const long = build(2.5);
    expect(plain.until).toEqual([NEVER_LEAVES, NEVER_LEAVES, NEVER_LEAVES]);
    expect(plain.zone[0]).toBe(1);
    // The effect's two shots and the turret's one.
    expect(plain.shots).toHaveLength(3);
    expect({ ...long, lifeTicks: [] }).toEqual({ ...plain, lifeTicks: [] });
    expect([plain.lifeTicks, long.lifeTicks]).toEqual([[120], [300]]);
  });
});
