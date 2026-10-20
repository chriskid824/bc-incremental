import { Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import type { ShotPoolState } from '../sim';
import { PROJECTILE_CAP } from '../sim/caps';
import { MOTION_HOMING, MOTION_LOB, MOTION_STRAIGHT } from '../sim/systems/shots';
import { HOMING, PoolShotLayer, SHOT_SLOTS, ShotTrails } from './poolShots';

interface Shot {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly motion?: number;
}

/** A shot pool holding `shots` in its first slots, in order; homing unless they say otherwise. */
function pool(shots: readonly Shot[]): ShotPoolState {
  const n = Math.max(1, shots.length);
  const state: ShotPoolState = {
    id: new Int32Array(n),
    motion: new Uint8Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    until: new Int32Array(n),
    form: new Uint8Array(n),
  };
  shots.forEach((shot, s) => {
    state.id[s] = shot.id;
    state.motion[s] = shot.motion ?? MOTION_HOMING;
    state.x[s] = shot.x;
    state.y[s] = shot.y;
  });
  return state;
}

/** The sample's shots as [id, prevX, prevY, x, y]. */
function rows(trails: ShotTrails): number[][] {
  return Array.from({ length: trails.size }, (_, k) => [
    trails.id(k),
    trails.prevX(k),
    trails.prevY(k),
    trails.x(k),
    trails.y(k),
  ]);
}

function sample(trails: ShotTrails, tick: number, shots: readonly Shot[]): void {
  trails.sample(pool(shots), shots.length, tick);
}

describe('ShotTrails', () => {
  it('reads the pool’s homing shots as the sim numbers them', () => {
    expect([HOMING, SHOT_SLOTS]).toEqual([MOTION_HOMING, PROJECTILE_CAP]);
  });

  it('keeps each homing shot’s last-tick position by id; a new shot is drawn where it is', () => {
    const trails = new ShotTrails();
    sample(trails, 10, [
      { id: 3, x: 100, y: 100 },
      { id: 5, x: 200, y: 200 },
      { id: 8, x: 300, y: 300 },
    ]);
    expect(rows(trails)).toEqual([
      [3, 100, 100, 100, 100],
      [5, 200, 200, 200, 200],
      [8, 300, 300, 300, 300],
    ]);
    // 3 ended and 9 is new; the others moved.
    sample(trails, 11, [
      { id: 5, x: 210, y: 195 },
      { id: 8, x: 290, y: 310 },
      { id: 9, x: 50, y: 60 },
    ]);
    expect(rows(trails)).toEqual([
      [5, 200, 200, 210, 195],
      [8, 300, 300, 290, 310],
      [9, 50, 60, 50, 60],
    ]);
  });

  it('samples once a sim tick: frames that show the same tick change nothing', () => {
    const trails = new ShotTrails();
    sample(trails, 1, [{ id: 1, x: 0, y: 0 }]);
    sample(trails, 2, [{ id: 1, x: 10, y: 0 }]);
    sample(trails, 2, [{ id: 1, x: 99, y: 99 }]);
    expect(rows(trails)).toEqual([[1, 0, 0, 10, 0]]);
  });

  it('puts a shot a tick back along the line from its last position when a frame skipped ticks', () => {
    const trails = new ShotTrails();
    sample(trails, 20, [{ id: 4, x: 0, y: 0 }]);
    // Four ticks later (4×): 40 right, so a tick back is 30 right.
    sample(trails, 24, [{ id: 4, x: 40, y: 8 }]);
    expect(rows(trails)).toEqual([[4, 30, 6, 40, 8]]);
  });

  it('draws only the homing shots, and starts over on a tick back in time and when cleared', () => {
    const trails = new ShotTrails();
    sample(trails, 5, [
      { id: 1, x: 1, y: 1, motion: MOTION_STRAIGHT },
      { id: 2, x: 2, y: 2 },
      { id: 3, x: 3, y: 3, motion: MOTION_LOB },
    ]);
    expect(rows(trails)).toEqual([[2, 2, 2, 2, 2]]);
    // A new run: its ids start again, its clock too.
    sample(trails, 1, [{ id: 2, x: 7, y: 7 }]);
    expect(rows(trails)).toEqual([[2, 7, 7, 7, 7]]);
    trails.clear();
    expect(trails.size).toBe(0);
    sample(trails, 9, [{ id: 2, x: 8, y: 8 }]);
    expect(rows(trails)).toEqual([[2, 8, 8, 8, 8]]);
  });

  it('never writes the pool, and holds a full pool of homing shots', () => {
    const trails = new ShotTrails();
    const shots = Array.from({ length: PROJECTILE_CAP }, (_, s) => ({ id: s + 1, x: s, y: -s }));
    const state = pool(shots);
    const snapshot = (): string =>
      JSON.stringify(Object.values(state).map((array: ArrayLike<number>) => Array.from(array)));
    const before = snapshot();
    trails.sample(state, PROJECTILE_CAP, 1);
    expect(snapshot()).toBe(before);
    for (let s = 0; s < PROJECTILE_CAP; s++) state.x[s] = (state.x[s] as number) + 1;
    const moved = snapshot();
    trails.sample(state, PROJECTILE_CAP, 2);
    expect(snapshot()).toBe(moved);
    expect(trails.size).toBe(PROJECTILE_CAP);
    expect(rows(trails)[PROJECTILE_CAP - 1]).toEqual([
      PROJECTILE_CAP,
      PROJECTILE_CAP - 1,
      1 - PROJECTILE_CAP,
      PROJECTILE_CAP,
      1 - PROJECTILE_CAP,
    ]);
  });
});

describe('PoolShotLayer', () => {
  /** The layer draws with the effect sheet's glow and streak; any texture stands in for them. */
  const textures = { glow: Texture.WHITE, streak: Texture.WHITE };
  /** Its particles as [x, y, anchorX]: a streak is anchored at its front end, a glow centered. */
  const drawn = (layer: PoolShotLayer): number[][] =>
    layer.view.particleChildren.map((particle) => [particle.x, particle.y, particle.anchorX]);

  it('draws each homing shot between its last two ticks by alpha: a streak along its move, a halo and a head', () => {
    const layer = new PoolShotLayer(textures);
    // New this tick: a halo and a head where it is, and no streak.
    layer.update(pool([{ id: 1, x: 100, y: 100 }]), 1, 10, 0.25);
    expect(drawn(layer)).toEqual([
      [100, 100, 0.5],
      [100, 100, 0.5],
    ]);
    // A tick later it is 10 right; the straight shot beside it is the projectile layer's.
    const moved = pool([
      { id: 1, x: 110, y: 100 },
      { id: 2, x: 5, y: 5, motion: MOTION_STRAIGHT },
    ]);
    layer.update(moved, 2, 11, 0.25);
    expect(drawn(layer)).toEqual([
      [102.5, 100, 1],
      [102.5, 100, 0.5],
      [102.5, 100, 0.5],
    ]);
    expect(layer.view.particleChildren[0]?.rotation).toBe(0);
    // Up and left the next tick: the streak turns with the move.
    layer.update(pool([{ id: 1, x: 100, y: 90 }]), 1, 12, 1);
    expect(drawn(layer)).toEqual([
      [100, 90, 1],
      [100, 90, 0.5],
      [100, 90, 0.5],
    ]);
    expect(layer.view.particleChildren[0]?.rotation).toBeCloseTo(-0.75 * Math.PI, 12);
    // Gone from the pool: nothing drawn.
    layer.update(pool([]), 0, 13, 0.5);
    expect(drawn(layer)).toEqual([]);
  });

  it('forgets every shot at reset: the next frame draws a shot where it is', () => {
    const layer = new PoolShotLayer(textures);
    layer.update(pool([{ id: 4, x: 0, y: 0 }]), 1, 30, 0.5);
    layer.update(pool([{ id: 4, x: 20, y: 0 }]), 1, 31, 0.5);
    expect(layer.view.particleChildren).toHaveLength(3);
    layer.reset();
    expect(layer.view.particleChildren).toHaveLength(0);
    layer.update(pool([{ id: 4, x: 40, y: 0 }]), 1, 32, 0.5);
    expect(drawn(layer)).toEqual([
      [40, 0, 0.5],
      [40, 0, 0.5],
    ]);
  });
});
