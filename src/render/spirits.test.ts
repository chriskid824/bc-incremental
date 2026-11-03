import { Texture } from 'pixi.js';
import type { Graphics, ParticleContainer, Renderer } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { DRONE_DASH, DRONE_DOCKED, DRONE_HOVER, DRONE_KIND_DRONE, DRONE_KIND_SPIRIT } from '../sim';
import type { DroneViewState, SimState } from '../sim';
import {
  chasedTargets,
  dockedFraction,
  dockedHeading,
  DroneLayer,
  DroneTracks,
  SPIRIT_SCALE,
  TRAIL_TICKS,
} from './drones';
import type { DroneFrame, EnemyLocator } from './drones';

/**
 * A slot of a fake pool: its id (the pool's rows come and go, so ids skip), kind and motion.
 * Unset fields as a docked drone at 0, 0.
 */
interface Slot {
  readonly id: number;
  readonly kind?: number;
  readonly mode?: number;
  readonly x?: number;
  readonly y?: number;
  readonly prevX?: number;
  readonly prevY?: number;
  readonly targetId?: number;
}

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
    size: new Float64Array(n).fill(1),
  };
  slots.forEach((slot, s) => {
    const spirit = slot.kind === DRONE_KIND_SPIRIT;
    ds.id[s] = slot.id;
    ds.kind[s] = slot.kind ?? DRONE_KIND_DRONE;
    ds.mode[s] = slot.mode ?? DRONE_DOCKED;
    ds.x[s] = slot.x ?? 0;
    ds.y[s] = slot.y ?? 0;
    ds.prevX[s] = slot.prevX ?? slot.x ?? 0;
    ds.prevY[s] = slot.prevY ?? slot.y ?? 0;
    ds.targetId[s] = slot.targetId ?? -1;
    ds.owner[s] = spirit ? -1 : 1;
    ds.seat[s] = spirit ? -1 : s;
  });
  return ds;
}

const CENTER = { x: 960, y: 540 };

function frame(tick: number, slots: readonly Slot[]): DroneFrame {
  return {
    tick,
    player: { x: CENTER.x, y: CENTER.y, life: 100, maxLife: 100, shield: 0 },
    drones: pool(slots),
    droneCount: slots.length,
  };
}

function expectAngle(actual: number, expected: number): void {
  expect(Math.cos(actual)).toBeCloseTo(Math.cos(expected), 12);
  expect(Math.sin(actual)).toBeCloseTo(Math.sin(expected), 12);
}

/** A docked drone, id 1, at its dock right of the core. */
const DOCKED: Slot = { id: 1, mode: DRONE_DOCKED, x: CENTER.x + 43, y: CENTER.y };
/** Spirit `id` at sim tick `tick`, dashing +10 px a tick along x from x0 at its first tick. */
const spirit = (id: number, tick: number, x0 = 1200, targetId = 7): Slot => ({
  id,
  kind: DRONE_KIND_SPIRIT,
  mode: DRONE_DASH,
  prevX: x0 + 10 * (tick - 1),
  x: x0 + 10 * tick,
  y: 300,
  prevY: 300,
  targetId,
});

describe('spirits in the drone tracks', () => {
  it('starts a spirit’s track pointing out from the core, then along its move, and drops it once it has left the pool', () => {
    const tracks = new DroneTracks();
    // A new spirit, where it was spawned, before its first step.
    const born: Slot = { id: 9, kind: DRONE_KIND_SPIRIT, mode: DRONE_HOVER, x: 1200, y: 300 };
    tracks.follow(frame(10, [DOCKED, born]));
    expect(tracks.size).toBe(2);
    expectAngle(tracks.get(9)?.heading ?? NaN, dockedHeading(1200, 300, CENTER.x, CENTER.y));
    tracks.follow(frame(11, [DOCKED, spirit(9, 1)]));
    expectAngle(tracks.get(9)?.heading ?? NaN, 0);
    expect(tracks.get(9)?.trail.size).toBe(2);
    // It left: its track goes, the drone's stays; a later spirit gets a track of its own.
    tracks.follow(frame(12, [DOCKED]));
    expect([tracks.size, tracks.get(9), tracks.get(1) === undefined]).toEqual([
      1,
      undefined,
      false,
    ]);
    tracks.follow(frame(13, [DOCKED, spirit(10, 1, 400)]));
    expect([tracks.size, tracks.get(10)?.trail.size]).toEqual([2, 1]);
  });

  it('leaves spirits out of the docked share and the chased enemies, which read drones only', () => {
    const ds = pool([
      DOCKED,
      { id: 4, kind: DRONE_KIND_SPIRIT, mode: DRONE_HOVER, x: 500, y: 500 },
      spirit(5, 1, 1200, 7),
    ]);
    expect(dockedFraction(ds, 3)).toBe(1);
    const out = new Int32Array(4);
    expect(chasedTargets(ds, 3, out)).toBe(0);
  });
});

describe('spirits in the drone layer', () => {
  /** The layer bakes its textures through generateTexture only; any texture stands in for them. */
  const renderer = { generateTexture: () => Texture.WHITE } as unknown as Renderer;
  const sim = (tick: number, slots: readonly Slot[]): SimState =>
    frame(tick, slots) as unknown as SimState;
  const part = <T>(layer: DroneLayer, label: string): T => layer.view.getChildByLabel(label) as T;
  const enemies: EnemyLocator = { positionOf: () => ({ x: 1500, y: 300, radius: 10 }) };

  it('draws a spirit as a drone’s kite at SPIRIT_SCALE, over the turrets, and its trail at that width; draws no bracket for its target', () => {
    expect(SPIRIT_SCALE).toBe(0.6);
    const layer = new DroneLayer(renderer, Texture.WHITE);
    const kites = part<ParticleContainer>(layer, 'drone-kites');
    const spirits = part<ParticleContainer>(layer, 'spirit-kites');
    const trails = part<ParticleContainer>(layer, 'drone-trails');
    const brackets = part<Graphics>(layer, 'drone-brackets');
    expect(layer.view.children.at(-1)).toBe(spirits);
    // A drone dashing along x beside the spirit, both +10 px a tick.
    const dash = (tick: number): Slot => ({ ...spirit(2, tick, 600), kind: DRONE_KIND_DRONE });
    for (let tick = 1; tick <= 7; tick++) {
      layer.update(sim(tick, [dash(tick), spirit(9, tick)]), 0.5, enemies);
    }
    expect([kites.particleChildren.length, spirits.particleChildren.length]).toEqual([1, 1]);
    const kite = kites.particleChildren[0];
    const s = spirits.particleChildren[0];
    expect([kite?.scaleX, kite?.scaleY]).toEqual([1, 1]);
    expect([s?.scaleX, s?.scaleY]).toEqual([SPIRIT_SCALE, SPIRIT_SCALE]);
    expect([s?.x, s?.y]).toEqual([1200 + 65, 300]);
    expectAngle(s?.rotation ?? NaN, 0);
    expect([s?.anchorX, s?.anchorY]).toEqual([kite?.anchorX, kite?.anchorY]);
    expect(s?.texture).toBe(kite?.texture);
    // Its trail: as many streaks as a drone's, SPIRIT_SCALE as wide.
    const streaks = trails.particleChildren;
    expect(streaks).toHaveLength(2 * TRAIL_TICKS);
    const drone = streaks.slice(0, TRAIL_TICKS).map((p) => p.scaleY);
    const mine = streaks.slice(TRAIL_TICKS).map((p) => p.scaleY);
    mine.forEach((w, i) => expect(w).toBeCloseTo((drone[i] as number) * SPIRIT_SCALE, 12));
    // Only the drone's target is bracketed.
    expect(brackets.context.instructions).toHaveLength(1);
    layer.update(sim(8, [{ ...dash(8), mode: DRONE_DOCKED }, spirit(9, 8)]), 0.5, enemies);
    expect(brackets.context.instructions).toHaveLength(0);
  });

  it('drops a spirit’s kite and trail once it has left the pool, and forgets every spirit at reset', () => {
    const layer = new DroneLayer(renderer, Texture.WHITE);
    const spirits = part<ParticleContainer>(layer, 'spirit-kites');
    const trails = part<ParticleContainer>(layer, 'drone-trails');
    layer.update(sim(1, [DOCKED, spirit(4, 1), spirit(6, 1, 300)]), 0.5, enemies);
    layer.update(sim(2, [DOCKED, spirit(4, 2), spirit(6, 2, 300)]), 0.5, enemies);
    expect(spirits.particleChildren.map((p) => p.x)).toEqual([1215, 315]);
    // 4 left in tick 3's stage: 6 moved down a slot, and keeps its own trail.
    layer.update(sim(3, [DOCKED, spirit(6, 3, 300)]), 0.5, enemies);
    expect(spirits.particleChildren.map((p) => p.x)).toEqual([325]);
    expect(trails.particleChildren.every((p) => p.x < 1000)).toBe(true);
    layer.update(sim(4, [DOCKED]), 0.5, enemies);
    expect([spirits.particleChildren.length, trails.particleChildren.length]).toEqual([0, 0]);
    layer.update(sim(5, [DOCKED, spirit(8, 1)]), 0.5, enemies);
    expect(spirits.particleChildren).toHaveLength(1);
    layer.reset();
    expect(spirits.particleChildren).toHaveLength(0);
  });
});
