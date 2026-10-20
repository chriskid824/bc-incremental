import { Texture } from 'pixi.js';
import type { ParticleContainer, Renderer } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { DRONE_DOCKED, DRONE_FIXED, DRONE_KIND_DRONE, DRONE_KIND_TURRET } from '../sim';
import type { DroneViewState, SimState } from '../sim';
import {
  BARREL_TURN,
  DroneLayer,
  RECOIL_MS,
  RECOIL_PX,
  TurretTracks,
  recoilOffset,
  turnToward,
} from './drones';
import type { DroneFrame, EnemyLocator, EnemySpot } from './drones';

interface Slot {
  readonly kind?: number;
  readonly mode?: number;
  readonly x?: number;
  readonly y?: number;
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
    ds.x[s] = ds.prevX[s] = slot.x ?? 0;
    ds.y[s] = ds.prevY[s] = slot.y ?? 0;
    ds.targetId[s] = -1;
    ds.seat[s] = s;
  });
  return ds;
}

const CENTER = { x: 960, y: 540 };

function frame(tick: number, slots: readonly Slot[]): DroneFrame {
  return {
    tick,
    player: { x: CENTER.x, y: CENTER.y, life: 100, maxLife: 100 },
    drones: pool(slots),
    droneCount: slots.length,
  };
}

function expectAngle(actual: number, expected: number): void {
  expect(Math.cos(actual)).toBeCloseTo(Math.cos(expected), 12);
  expect(Math.sin(actual)).toBeCloseTo(Math.sin(expected), 12);
}

/** An enemy layer that draws the enemies `spots` holds, by id, and records what it was asked. */
function locator(spots: Map<number, EnemySpot>): EnemyLocator & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    positionOf: (id) => {
      asked.push(id);
      return spots.get(id) ?? null;
    },
  };
}

describe('turret barrels', () => {
  it('recoils RECOIL_PX on a firing and is home RECOIL_MS later, easing out; not at all before one', () => {
    expect(recoilOffset(0)).toBe(RECOIL_PX);
    expect(recoilOffset(RECOIL_MS / 2)).toBeCloseTo(RECOIL_PX / 4, 12);
    expect(recoilOffset(RECOIL_MS)).toBe(0);
    expect(recoilOffset(Infinity)).toBe(0);
    expect(recoilOffset(Number.NaN)).toBe(0);
    let last = Infinity;
    for (let ms = 0; ms < RECOIL_MS; ms += 7) {
      const back = recoilOffset(ms);
      expect(back).toBeLessThan(last);
      last = back;
    }
  });

  it('turns by at most a step the short way round, and lands on the goal within one', () => {
    expect(turnToward(0, 1, 0.25)).toBe(0.25);
    expect(turnToward(0, -1, 0.25)).toBe(-0.25);
    expect(turnToward(0, 0.2, 0.25)).toBe(0.2);
    // From just below π to just past −π: across the back, not the long way.
    expectAngle(turnToward(3, -3, 0.1), 3.1);
    expect(turnToward(1, 1, 0)).toBe(1);
  });

  it('points a barrel out from the core until its turret fires, then snaps to the target and follows it at BARREL_TURN', () => {
    const tracks = new TurretTracks();
    const seat = { kind: DRONE_KIND_TURRET, mode: DRONE_FIXED, x: CENTER.x, y: CENTER.y + 90 };
    const spots = new Map<number, EnemySpot>([[7, { x: CENTER.x + 300, y: seat.y, radius: 20 }]]);
    const enemies = locator(spots);
    tracks.follow(frame(1, [seat]), 16, enemies);
    expectAngle(tracks.get(1)?.angle ?? NaN, Math.PI / 2);
    expect(enemies.asked).toEqual([]);
    tracks.fired(1, 7);
    tracks.follow(frame(2, [seat]), 16, enemies);
    expectAngle(tracks.get(1)?.angle ?? NaN, 0);
    expect(tracks.get(1)?.sinceFireMs).toBe(16);
    // The target walks to straight below the seat: the barrel turns 16 rad/s toward it.
    spots.set(7, { x: seat.x, y: seat.y + 300, radius: 20 });
    tracks.follow(frame(3, [seat]), 50, enemies);
    expectAngle(tracks.get(1)?.angle ?? NaN, (BARREL_TURN * 50) / 1000);
    tracks.follow(frame(4, [seat]), 100, enemies);
    expectAngle(tracks.get(1)?.angle ?? NaN, Math.PI / 2);
    expect(tracks.get(1)?.sinceFireMs).toBe(166);
    // Gone from the enemy layer: the barrel holds still.
    spots.delete(7);
    tracks.follow(frame(5, [seat]), 100, enemies);
    expectAngle(tracks.get(1)?.angle ?? NaN, Math.PI / 2);
    // A firing at another enemy snaps to it, though it is far round.
    spots.set(9, { x: seat.x - 50, y: seat.y, radius: 20 });
    tracks.fired(1, 9);
    tracks.follow(frame(6, [seat]), 16, enemies);
    expectAngle(tracks.get(1)?.angle ?? NaN, Math.PI);
    expect(enemies.asked).toEqual([7, 7, 7, 7, 9]);
  });

  it('keeps one track per turret, leaves drones out and drops turrets gone from the state', () => {
    const tracks = new TurretTracks();
    const turret = (x: number) => ({ kind: DRONE_KIND_TURRET, mode: DRONE_FIXED, x, y: CENTER.y });
    const none = locator(new Map());
    // A firing seen before the turret's first frame keeps its target and recoil clock.
    tracks.fired(2, 5);
    tracks.follow(frame(1, [{ mode: DRONE_DOCKED }, turret(1050), turret(870)]), 16, none);
    expect(tracks.size).toBe(2);
    expect(tracks.get(1)).toBeUndefined();
    expectAngle(tracks.get(2)?.angle ?? NaN, 0);
    expectAngle(tracks.get(3)?.angle ?? NaN, Math.PI);
    expect([tracks.get(2)?.targetId, tracks.get(3)?.targetId]).toEqual([5, -1]);
    expect([tracks.get(2)?.sinceFireMs, tracks.get(3)?.sinceFireMs]).toEqual([16, Infinity]);
    tracks.follow(frame(2, [{ mode: DRONE_DOCKED }, turret(1050)]), 16, none);
    expect(tracks.size).toBe(1);
    expect(tracks.get(3)).toBeUndefined();
    tracks.clear();
    expect(tracks.size).toBe(0);
  });
});

describe('turrets in the drone layer', () => {
  /** The layer bakes its textures through generateTexture only; any texture stands in for them. */
  const renderer = { generateTexture: () => Texture.WHITE } as unknown as Renderer;
  /** DroneLayer.update reads only the DroneFrame part of the run's state. */
  const sim = (tick: number, slots: readonly Slot[]): SimState =>
    frame(tick, slots) as unknown as SimState;
  const part = (layer: DroneLayer, label: string): ParticleContainer =>
    layer.view.getChildByLabel(label) as ParticleContainer;

  it('draws each turret as a base in its seat facing out, its barrel aimed at its last target and recoiling', () => {
    const layer = new DroneLayer(renderer, Texture.WHITE);
    const [kites, bases, barrels] = ['drone-kites', 'turret-bases', 'turret-barrels'].map((label) =>
      part(layer, label),
    ) as [ParticleContainer, ParticleContainer, ParticleContainer];
    // The kites keep their place under the turrets.
    expect(layer.view.children.map((child) => child.label)).toEqual([
      'drone-trails',
      'drone-brackets',
      'drone-kites',
      'turret-bases',
      'turret-barrels',
    ]);
    // A docked drone (id 1) and the turret above the core (id 2); enemy 7 level with the seat.
    const seat = { kind: DRONE_KIND_TURRET, mode: DRONE_FIXED, x: CENTER.x, y: CENTER.y - 90 };
    const slots = [{ mode: DRONE_DOCKED, x: CENTER.x + 43, y: CENTER.y }, seat];
    const enemies = locator(new Map([[7, { x: CENTER.x + 200, y: seat.y, radius: 20 }]]));
    layer.update(sim(1, slots), 0.5, enemies, 16);
    expect([kites, bases, barrels].map((c) => c.particleChildren.length)).toEqual([1, 1, 1]);
    const base = bases.particleChildren[0];
    const barrel = barrels.particleChildren[0];
    expect([base?.x, base?.y]).toEqual([seat.x, seat.y]);
    expectAngle(base?.rotation ?? NaN, -Math.PI / 2);
    // Out from the core, and home, before the turret's first firing.
    expect([barrel?.x, barrel?.y]).toEqual([seat.x, seat.y]);
    expectAngle(barrel?.rotation ?? NaN, -Math.PI / 2);
    // It fires at 7: the barrel turns to it and slides back RECOIL_PX along itself; a redraw
    // with no dtMs moves no clock.
    layer.turretFired(2, 7);
    layer.update(sim(2, slots), 0.5, enemies);
    expectAngle(barrel?.rotation ?? NaN, 0);
    expect([barrel?.x, barrel?.y]).toEqual([seat.x - RECOIL_PX, seat.y]);
    layer.update(sim(2, slots), 0.9, enemies);
    expect(barrel?.x).toBe(seat.x - RECOIL_PX);
    layer.update(sim(3, slots), 0.5, enemies, RECOIL_MS / 2);
    expect(barrel?.x).toBeCloseTo(seat.x - RECOIL_PX / 4, 12);
    layer.update(sim(4, slots), 0.5, enemies, RECOIL_MS / 2);
    expect([barrel?.x, barrel?.y]).toEqual([seat.x, seat.y]);
    // The base never turns with the barrel.
    expectAngle(base?.rotation ?? NaN, -Math.PI / 2);
    expect(enemies.asked).toEqual([7, 7, 7, 7]);
  });

  it('draws a base and a barrel per turret, drops a turret gone, and forgets them at reset', () => {
    const layer = new DroneLayer(renderer, Texture.WHITE);
    const bases = part(layer, 'turret-bases');
    const barrels = part(layer, 'turret-barrels');
    const turret = (x: number): Slot => ({ kind: DRONE_KIND_TURRET, mode: DRONE_FIXED, x, y: 540 });
    const none = locator(new Map());
    layer.update(sim(1, [turret(1050), { mode: DRONE_DOCKED }, turret(870)]), 0.5, none, 16);
    expect(bases.particleChildren.map((b) => b.x)).toEqual([1050, 870]);
    expect(barrels.particleChildren.map((b) => b.x)).toEqual([1050, 870]);
    // Turret slots leave the docked share alone: one drone, docked.
    expect(layer.dockedShare).toBe(1);
    layer.update(sim(2, [turret(1050), { mode: DRONE_DOCKED }]), 0.5, none, 16);
    expect([bases.particleChildren.length, barrels.particleChildren.length]).toEqual([1, 1]);
    layer.reset();
    expect([bases.particleChildren.length, barrels.particleChildren.length]).toEqual([0, 0]);
  });

  it('starts the next run’s turrets afresh at reset: out from the core and home, whatever the last run’s aimed at', () => {
    const layer = new DroneLayer(renderer, Texture.WHITE);
    const barrels = part(layer, 'turret-barrels');
    const seat = { kind: DRONE_KIND_TURRET, mode: DRONE_FIXED, x: CENTER.x, y: CENTER.y - 90 };
    const enemies = locator(new Map([[7, { x: CENTER.x + 200, y: seat.y, radius: 20 }]]));
    layer.update(sim(1, [seat]), 0.5, enemies, 16);
    layer.turretFired(1, 7);
    layer.update(sim(2, [seat]), 0.5, enemies, 16);
    expectAngle(barrels.particleChildren[0]?.rotation ?? NaN, 0);
    expect(barrels.particleChildren[0]?.x).toBeLessThan(seat.x);
    // The next run's turret has the same id, and its enemy 7 is another enemy.
    layer.reset();
    enemies.asked.length = 0;
    layer.update(sim(1, [seat]), 0.5, enemies, 16);
    const barrel = barrels.particleChildren[0];
    expectAngle(barrel?.rotation ?? NaN, -Math.PI / 2);
    expect([barrel?.x, barrel?.y]).toEqual([seat.x, seat.y]);
    expect(enemies.asked).toEqual([]);
  });
});
