import { Texture } from 'pixi.js';
import type { Graphics, ParticleContainer, Renderer } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  DRONE_DASH,
  DRONE_DOCKED,
  DRONE_FIXED,
  DRONE_HOVER,
  DRONE_KIND_DRONE,
  DRONE_KIND_TURRET,
  DRONE_RETURN,
} from '../sim';
import type { DroneViewState, SimState } from '../sim';
import {
  DroneLayer,
  DroneTracks,
  HEADING_HOLD_PX,
  TRAIL_TICKS,
  TrailRing,
  chasedTargets,
  dockedFraction,
  dockedHeading,
  moveHeading,
} from './drones';
import type { DroneFrame, EnemyLocator, EnemySpot } from './drones';

interface Slot {
  readonly kind?: number;
  readonly mode?: number;
  readonly x?: number;
  readonly y?: number;
  readonly prevX?: number;
  readonly prevY?: number;
  readonly targetId?: number;
}

/** A drone pool holding `slots` in order, ids 1 up; unset fields as a docked drone at 0, 0. */
function pool(slots: readonly Slot[]): DroneViewState {
  const n = slots.length;
  const ds: DroneViewState = {
    id: new Int32Array(n),
    kind: new Uint8Array(n),
    mode: new Uint8Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    prevX: new Float64Array(n),
    prevY: new Float64Array(n),
    targetId: new Int32Array(n),
    owner: new Int16Array(n),
    seat: new Int16Array(n),
  };
  slots.forEach((slot, s) => {
    ds.id[s] = s + 1;
    ds.kind[s] = slot.kind ?? DRONE_KIND_DRONE;
    ds.mode[s] = slot.mode ?? DRONE_DOCKED;
    ds.x[s] = slot.x ?? 0;
    ds.y[s] = slot.y ?? 0;
    ds.prevX[s] = slot.prevX ?? slot.x ?? 0;
    ds.prevY[s] = slot.prevY ?? slot.y ?? 0;
    ds.targetId[s] = slot.targetId ?? -1;
    ds.seat[s] = s;
  });
  return ds;
}

const CENTER = { x: 960, y: 540 };
const DOCK = 43;

function frame(tick: number, slots: readonly Slot[]): DroneFrame {
  return {
    tick,
    player: { x: CENTER.x, y: CENTER.y, life: 100, maxLife: 100 },
    drones: pool(slots),
    droneCount: slots.length,
  };
}

/** The ring's x or y positions, newest first. */
function points(ring: TrailRing, axis: 'x' | 'y'): number[] {
  return Array.from({ length: ring.size }, (_, age) => ring[axis](age));
}

function expectNear(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i] as number, 9));
}

/** The same direction: equal up to a whole turn. */
function expectAngle(actual: number, expected: number): void {
  expect(Math.cos(actual)).toBeCloseTo(Math.cos(expected), 12);
  expect(Math.sin(actual)).toBeCloseTo(Math.sin(expected), 12);
}

describe('drone heading', () => {
  it('points along the move between the last two ticks, which the drawn kite moves along', () => {
    expectAngle(moveHeading(0, 0, 3, 0, 1), 0);
    expectAngle(moveHeading(5, 5, 5, 9, 1), Math.PI / 2);
    expectAngle(moveHeading(5, 5, 4, 4, 1), (-3 * Math.PI) / 4);
    // The drawn position, prev + (cur − prev) × alpha, moves the same way at every alpha.
    expectAngle(moveHeading(100, 100, 100.5, 99.5, 0), -Math.PI / 4);
  });

  it('holds the last heading below 0.01 px, as for a drone held in place (prev = current)', () => {
    expect(HEADING_HOLD_PX).toBe(0.01);
    expect(moveHeading(7, 7, 7, 7, 1.25)).toBe(1.25);
    expect(moveHeading(0, 0, 0.0099, 0, 1.25)).toBe(1.25);
    expect(moveHeading(0, 0, 0.007, -0.007, 1.25)).toBe(1.25);
    expectAngle(moveHeading(0, 0, 0.0101, 0, 1.25), 0);
    expectAngle(moveHeading(0, 0, 0, -0.0101, 1.25), -Math.PI / 2);
  });

  it('points a docked drone nose outward from the core (F20)', () => {
    for (const degrees of [0, 120, 240]) {
      const a = (degrees * Math.PI) / 180;
      const x = CENTER.x + DOCK * Math.cos(a);
      const y = CENTER.y + DOCK * Math.sin(a);
      expectAngle(dockedHeading(x, y, CENTER.x, CENTER.y), a);
    }
  });
});

describe('dockedFraction', () => {
  it('is the share of the drones docked, turrets left out, and 1 with no drone', () => {
    const docked = { mode: DRONE_DOCKED };
    const turret = { kind: DRONE_KIND_TURRET, mode: DRONE_FIXED };
    const three = [docked, { mode: DRONE_DASH }, { mode: DRONE_RETURN }];
    expect(dockedFraction(pool(three), 3)).toBeCloseTo(1 / 3, 12);
    expect(dockedFraction(pool([...three, turret, turret]), 5)).toBeCloseTo(1 / 3, 12);
    expect(dockedFraction(pool([docked, { mode: DRONE_HOVER }, docked]), 3)).toBeCloseTo(2 / 3, 12);
    expect(dockedFraction(pool([docked, docked, docked]), 3)).toBe(1);
    expect(dockedFraction(pool([{ mode: DRONE_DASH }, { mode: DRONE_DASH }]), 2)).toBe(0);
    // Only the first `count` slots.
    expect(dockedFraction(pool([docked, { mode: DRONE_DASH }, docked]), 2)).toBe(0.5);
    expect(dockedFraction(pool([]), 0)).toBe(1);
    expect(dockedFraction(pool([turret]), 1)).toBe(1);
  });
});

describe('chasedTargets', () => {
  it('lists each enemy a dashing drone chases once, never one a drone flies home from', () => {
    const ds = pool([
      { mode: DRONE_DASH, targetId: 7 },
      { mode: DRONE_RETURN, targetId: 9 },
      { mode: DRONE_DASH, targetId: 7 },
      { mode: DRONE_HOVER },
      { mode: DRONE_DOCKED },
      { kind: DRONE_KIND_TURRET, mode: DRONE_FIXED, targetId: 12 },
      { mode: DRONE_DASH, targetId: 3 },
    ]);
    const out = new Int32Array(8);
    expect(chasedTargets(ds, 7, out)).toBe(2);
    expect([...out.subarray(0, 2)]).toEqual([7, 3]);
    // Only the first `count` slots.
    expect(chasedTargets(ds, 2, out)).toBe(1);
    expect(out[0]).toBe(7);
  });
});

describe('TrailRing', () => {
  it('fills once per sim tick, not once per frame', () => {
    const ring = new TrailRing();
    ring.sample(10, 1, 2);
    ring.sample(10, 50, 50);
    expect(ring.size).toBe(1);
    expect([ring.x(0), ring.y(0)]).toEqual([1, 2]);
    ring.sample(11, 3, 4);
    ring.sample(11, 60, 60);
    expect(ring.size).toBe(2);
    expect([ring.x(0), ring.y(0), ring.x(1), ring.y(1)]).toEqual([3, 4, 1, 2]);
  });

  it('keeps the newest K = 5 positions, newest first, as it wraps', () => {
    expect(TRAIL_TICKS).toBe(5);
    const ring = new TrailRing();
    for (let tick = 1; tick <= 13; tick++) {
      ring.sample(tick, tick, -tick);
      const held = Math.min(tick, TRAIL_TICKS);
      expect(ring.size).toBe(held);
      for (let age = 0; age < held; age++) {
        expect(ring.x(age)).toBe(tick - age);
        expect(ring.y(age)).toBe(age - tick);
      }
    }
  });

  it('fills the ticks a frame skipped along the line, keeping the newest K', () => {
    const ring = new TrailRing();
    ring.sample(0, 0, 0);
    ring.sample(3, 30, -30);
    expect(ring.size).toBe(4);
    expectNear(points(ring, 'x'), [30, 20, 10, 0]);
    expectNear(points(ring, 'y'), [-30, -20, -10, 0]);
    ring.sample(20, 200, 0);
    expect(ring.size).toBe(TRAIL_TICKS);
    expectNear(points(ring, 'x'), [200, 190, 180, 170, 160]);
  });

  it('starts over on a tick back in time, as in a new run, and when cleared', () => {
    const ring = new TrailRing();
    for (let tick = 40; tick < 50; tick++) ring.sample(tick, tick, 0);
    ring.sample(3, 7, 8);
    expect(ring.size).toBe(1);
    expect([ring.x(0), ring.y(0)]).toEqual([7, 8]);
    ring.clear();
    expect(ring.size).toBe(0);
    ring.sample(3, 1, 1);
    expect(ring.size).toBe(1);
  });
});

describe('DroneTracks', () => {
  const dockA = { x: CENTER.x + DOCK, y: CENTER.y };

  it("samples each drone's trail at the sim tick: frames that show one tick add one point", () => {
    const tracks = new DroneTracks();
    const out = { mode: DRONE_DASH, x: 1010, y: 540, prevX: 1006, prevY: 540, targetId: 4 };
    tracks.follow(frame(100, [out]));
    tracks.follow(frame(100, [out]));
    tracks.follow(frame(100, [out]));
    expect(tracks.get(1)?.trail.size).toBe(1);
    expect(tracks.get(1)?.trail.x(0)).toBe(1006);
    tracks.follow(frame(101, [{ ...out, x: 1014, prevX: 1010 }]));
    expect(tracks.get(1)?.trail.size).toBe(2);
    expect(tracks.get(1)?.trail.x(0)).toBe(1010);
  });

  it('heads along the move, holds it while the drone stands still, and points out when docked', () => {
    const tracks = new DroneTracks();
    tracks.follow(frame(1, [{ mode: DRONE_DOCKED, ...dockA }]));
    expectAngle(tracks.get(1)?.heading ?? NaN, 0);
    // Launched straight down.
    tracks.follow(frame(2, [{ mode: DRONE_DASH, ...dockA, prevY: dockA.y - 10 }]));
    expectAngle(tracks.get(1)?.heading ?? NaN, Math.PI / 2);
    // Held in place (m ≤ 0, prev = current) or sitting on a target that stands still.
    tracks.follow(frame(3, [{ mode: DRONE_DASH, ...dockA }]));
    expectAngle(tracks.get(1)?.heading ?? NaN, Math.PI / 2);
    tracks.follow(frame(4, [{ mode: DRONE_DASH, ...dockA, prevX: dockA.x + 0.005 }]));
    expectAngle(tracks.get(1)?.heading ?? NaN, Math.PI / 2);
    // Flying home toward the core, then docked: nose out again.
    tracks.follow(frame(5, [{ mode: DRONE_RETURN, ...dockA, prevX: dockA.x + 20 }]));
    expectAngle(tracks.get(1)?.heading ?? NaN, Math.PI);
    tracks.follow(frame(6, [{ mode: DRONE_DOCKED, ...dockA, prevX: dockA.x + 5 }]));
    expectAngle(tracks.get(1)?.heading ?? NaN, 0);
  });

  it('keeps one track per drone, leaves turrets out and drops drones gone from the state', () => {
    const tracks = new DroneTracks();
    const turret = { kind: DRONE_KIND_TURRET, mode: DRONE_FIXED, x: 1050, y: 540 };
    tracks.follow(frame(1, [{ mode: DRONE_DOCKED, ...dockA }, turret, { mode: DRONE_DASH }]));
    expect(tracks.size).toBe(2);
    expect(tracks.get(2)).toBeUndefined();
    tracks.follow(frame(2, [{ mode: DRONE_DOCKED, ...dockA }]));
    expect(tracks.size).toBe(1);
    expect(tracks.get(3)).toBeUndefined();
    tracks.clear();
    expect(tracks.size).toBe(0);
  });
});

describe('DroneLayer', () => {
  /** The layer bakes its kite through generateTexture only; any texture stands in for it. */
  const renderer = { generateTexture: () => Texture.WHITE } as unknown as Renderer;
  const noEnemies: EnemyLocator = { positionOf: () => null };

  /** The layer's children in draw order: trails, brackets, kites. */
  function parts(layer: DroneLayer): {
    trails: ParticleContainer;
    brackets: Graphics;
    kites: ParticleContainer;
  } {
    const [trails, brackets, kites] = layer.view.children as [
      ParticleContainer,
      Graphics,
      ParticleContainer,
    ];
    return { trails, brackets, kites };
  }

  /** DroneLayer.update reads only the DroneFrame part of the run's state. */
  const sim = (tick: number, slots: readonly Slot[]): SimState =>
    frame(tick, slots) as unknown as SimState;

  it('draws each kite between its last two ticks by alpha, nose along that move', () => {
    const layer = new DroneLayer(renderer, Texture.WHITE);
    const { kites } = parts(layer);
    const dash = { mode: DRONE_DASH, prevX: 1000, prevY: 540, x: 1010, y: 530, targetId: 7 };
    for (const alpha of [0, 0.25, 1]) {
      layer.update(sim(10, [dash]), alpha, noEnemies);
      expect(kites.particleChildren).toHaveLength(1);
      const kite = kites.particleChildren[0];
      expect(kite?.x).toBeCloseTo(1000 + 10 * alpha, 9);
      expect(kite?.y).toBeCloseTo(540 - 10 * alpha, 9);
      expectAngle(kite?.rotation ?? NaN, -Math.PI / 4);
    }
  });

  it('points docked kites outward, draws no turret, and drops the kite of a drone gone', () => {
    const layer = new DroneLayer(renderer, Texture.WHITE);
    const { kites } = parts(layer);
    const docked = [0, 120, 240].map((degrees) => {
      const a = (degrees * Math.PI) / 180;
      const x = CENTER.x + DOCK * Math.cos(a);
      const y = CENTER.y + DOCK * Math.sin(a);
      return { mode: DRONE_DOCKED, x, y };
    });
    const [a, b, c] = docked as [Slot, Slot, Slot];
    const turret = { kind: DRONE_KIND_TURRET, mode: DRONE_FIXED, x: CENTER.x + 90, y: CENTER.y };
    layer.update(sim(1, [a, b, c, turret]), 0.5, noEnemies);
    expect(kites.particleChildren).toHaveLength(3);
    [0, 120, 240].forEach((degrees, i) =>
      expectAngle(kites.particleChildren[i]?.rotation ?? NaN, (degrees * Math.PI) / 180),
    );
    expect(layer.dockedShare).toBe(1);
    // One of the three out: the share HiveCoreView's comb follows.
    layer.update(sim(2, [a, { ...b, mode: DRONE_DASH }, c, turret]), 0.5, noEnemies);
    expect(layer.dockedShare).toBeCloseTo(2 / 3, 12);
    layer.update(sim(3, [a, c]), 0.5, noEnemies);
    expect(kites.particleChildren).toHaveLength(2);
  });

  it('brackets each enemy a drone dashes at, where the enemy layer drew it, and no other', () => {
    const layer = new DroneLayer(renderer, Texture.WHITE);
    const { brackets } = parts(layer);
    const spots = new Map<number, EnemySpot>([
      [7, { x: 1200, y: 600, radius: 10 }],
      [9, { x: 300, y: 300, radius: 20 }],
    ]);
    const enemies: EnemyLocator = { positionOf: (id) => spots.get(id) ?? null };
    // Dashing at 7; flying home from 9; dashing at 8, which has no view (gone, or not drawn yet).
    const toSeven = { mode: DRONE_DASH, targetId: 7, x: 1000, y: 540 };
    const home = { mode: DRONE_RETURN, targetId: 9, x: 980, y: 540 };
    const toGone = { mode: DRONE_DASH, targetId: 8, x: 990, y: 540 };
    layer.update(sim(5, [toSeven, home, toGone]), 1, enemies);
    expect(brackets.context.instructions).toHaveLength(1);
    const box = brackets.getLocalBounds();
    expect((box.minX + box.maxX) / 2).toBeCloseTo(1200, 6);
    expect((box.minY + box.maxY) / 2).toBeCloseTo(600, 6);
    // Corners 5 px outside the radius, the stroke's width around them.
    expect(box.width).toBeGreaterThanOrEqual(2 * (10 + 5));
    expect(box.width).toBeLessThanOrEqual(2 * (10 + 5) + 4);
    // None once no drone dashes at an enemy that has a view.
    layer.update(sim(6, [{ ...toSeven, mode: DRONE_RETURN }, home, toGone]), 1, enemies);
    expect(brackets.context.instructions).toHaveLength(0);
  });

  it('adds one trail point per sim tick at any speed, and starts over after reset (a new run)', () => {
    const layer = new DroneLayer(renderer, Texture.WHITE);
    const { trails, brackets, kites } = parts(layer);
    /** A drone dashing +10 px a tick along x, as of sim tick `tick`. */
    const at = (tick: number): Slot => ({
      mode: DRONE_DASH,
      prevX: 1000 + 10 * (tick - 1),
      x: 1000 + 10 * tick,
      y: 540,
      targetId: 7,
    });
    const enemies: EnemyLocator = { positionOf: () => ({ x: 1300, y: 540, radius: 10 }) };
    layer.update(sim(1, [at(1)]), 0.5, enemies);
    expect(trails.particleChildren).toHaveLength(1);
    // Another frame of the same tick (1×) adds nothing.
    layer.update(sim(1, [at(1)]), 0.9, enemies);
    expect(trails.particleChildren).toHaveLength(1);
    // A frame four ticks on (4×): the ticks it skipped fill in, K points at most.
    layer.update(sim(5, [at(5)]), 0.5, enemies);
    expect(trails.particleChildren).toHaveLength(TRAIL_TICKS);
    expect(brackets.context.instructions).toHaveLength(1);
    layer.reset();
    expect(trails.particleChildren).toHaveLength(0);
    expect(kites.particleChildren).toHaveLength(0);
    expect(brackets.context.instructions).toHaveLength(0);
    expect(layer.dockedShare).toBe(1);
    // The next run's drone 1, from tick 1 again: one point.
    layer.update(sim(1, [at(1)]), 0.5, enemies);
    expect(trails.particleChildren).toHaveLength(1);
  });

  it('draws the trail from the kite back through the last 5 ticks, fading with age', () => {
    const layer = new DroneLayer(renderer, Texture.WHITE);
    const { trails } = parts(layer);
    for (let tick = 1; tick <= 7; tick++) {
      const x = 1000 + 10 * tick;
      const slot = { mode: DRONE_DASH, x, y: 540, prevX: x - 10, prevY: 540 };
      layer.update(sim(tick, [slot]), 0.5, noEnemies);
    }
    const streaks = trails.particleChildren;
    expect(streaks).toHaveLength(TRAIL_TICKS);
    // The newest piece starts at the drawn kite, halfway past the last tick's position.
    expect(streaks[0]?.x).toBeCloseTo(1065, 9);
    const alphas = streaks.map((streak) => streak.color >>> 24);
    expect(alphas).toEqual([...alphas].sort((a, b) => b - a));
    expect(new Set(alphas).size).toBe(TRAIL_TICKS);
  });
});
