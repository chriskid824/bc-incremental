import { Texture } from 'pixi.js';
import type { ParticleContainer } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import type { ShotPoolState, ZonePoolState } from '../sim';
import { LOB_VOLCANO } from '../sim/emitters/lob';
import type { LobSpec } from '../sim/emitters/types';
import { magmaBomb } from '../sim/rules/magmaBomb';
import { MOTION_HOMING, MOTION_LOB } from '../sim/systems/shots';
import { FX_BUBBLE, FX_FLASH, FxParticles } from './fx';
import {
  arcHeight,
  BOMB_FLIGHT_TICKS,
  bombPose,
  bombProgress,
  LOBBED,
  MagmaLayer,
  SCORCH_CAP,
  VOLCANO_FORM,
  zoneFade,
} from './magma';
import type { MagmaTextures } from './magma';
import { MAGMA_COLORS } from './palette';
import { RingLayer } from './rings';

const tex = Texture.WHITE;
const TEXTURES: MagmaTextures = { glow: tex, streak: tex, flame: tex, bubble: tex };

interface Bomb {
  readonly fromX: number;
  readonly fromY: number;
  readonly x: number;
  readonly y: number;
  readonly until: number;
  readonly form?: number;
  readonly motion?: number;
}

function shotPool(bombs: readonly Bomb[]): ShotPoolState {
  const n = Math.max(1, bombs.length);
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
  bombs.forEach((bomb, s) => {
    state.id[s] = s + 1;
    state.motion[s] = bomb.motion ?? MOTION_LOB;
    state.x[s] = bomb.x;
    state.y[s] = bomb.y;
    state.vx[s] = bomb.fromX;
    state.vy[s] = bomb.fromY;
    state.until[s] = bomb.until;
    state.form[s] = bomb.form ?? 0;
  });
  return state;
}

interface Zone {
  readonly id: number;
  readonly radius: number;
  readonly created: number;
  readonly expiresAt: number;
  readonly signature?: boolean;
}

function zonePool(zones: readonly Zone[]): ZonePoolState {
  const n = Math.max(1, zones.length);
  const state: ZonePoolState = {
    id: new Int32Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    radiusSq: new Float64Array(n),
    created: new Int32Array(n),
    expiresAt: new Int32Array(n),
    signature: new Uint8Array(n),
  };
  zones.forEach((zone, i) => {
    state.id[i] = zone.id;
    state.x[i] = 500;
    state.y[i] = 400;
    state.radiusSq[i] = zone.radius * zone.radius;
    state.created[i] = zone.created;
    state.expiresAt[i] = zone.expiresAt;
    state.signature[i] = zone.signature === false ? 0 : 1;
  });
  return state;
}

const NO_SHOTS = shotPool([]);
const NO_ZONES = zonePool([]);

function setup(frost = false) {
  const fx = new FxParticles({ glow: tex });
  const rings = new RingLayer();
  const shock = vi.spyOn(rings, 'shock');
  let n = 0;
  // A fixed stream: the layer's draws are the test's to know.
  const random = (): number => (((n++ * 0.37) % 1) + 1) % 1;
  const magma = new MagmaLayer(TEXTURES, fx, rings, { frost, poison: 0x3fd08a }, random);
  return { fx, rings, shock, magma };
}

const sprites = (view: ParticleContainer): number => view.particleChildren.length;

describe('the bomb’s flight (gd §1.2, §11.4: a parabola with a shadow)', () => {
  it('reads the sim’s lobbed shots and magmaBomb’s flight time', () => {
    const spec = magmaBomb.emitter({} as never) as LobSpec;
    expect([LOBBED, VOLCANO_FORM, BOMB_FLIGHT_TICKS]).toEqual([
      MOTION_LOB,
      LOB_VOLCANO,
      spec.flightTicks,
    ]);
  });

  it('leaves the launch point, peaks halfway at its arc height and lands on its point', () => {
    const start = bombPose(960, 540, 1260, 540, 0);
    expect(start).toEqual({ groundX: 960, groundY: 540, height: 0 });
    const mid = bombPose(960, 540, 1260, 540, 0.5);
    expect([mid.groundX, mid.groundY]).toEqual([1110, 540]);
    expect(mid.height).toBeCloseTo(arcHeight(300), 9);
    const end = bombPose(960, 540, 1260, 540, 1);
    expect(end).toEqual({ groundX: 1260, groundY: 540, height: 0 });
    // Short throws still arc; long ones do not leave the screen.
    expect(arcHeight(10)).toBeGreaterThanOrEqual(60);
    expect(arcHeight(5000)).toBeLessThanOrEqual(210);
  });

  it('flies from the launch tick to the landing tick, interpolated by alpha', () => {
    // Launched on tick 100: until = 124, drawn after tick 100 at alpha 1.
    expect(bombProgress(124, 100, 1)).toBe(0);
    expect(bombProgress(124, 112, 1)).toBeCloseTo(0.5, 9);
    expect(bombProgress(124, 113, 0)).toBeCloseTo(0.5, 9);
    expect(bombProgress(124, 113, 0.5)).toBeCloseTo(12.5 / 24, 9);
    expect(bombProgress(124, 124, 1)).toBe(1);
    expect(bombProgress(124, 140, 1)).toBe(1);
  });

  it('draws a shadow and four sprites a lobbed shot, none for the other shots', () => {
    const { magma } = setup();
    const [, , , , shadows] = magma.groundViews as ParticleContainer[];
    const shots = shotPool([
      { fromX: 960, fromY: 540, x: 1200, y: 400, until: 124 },
      { fromX: 0, fromY: 0, x: 300, y: 300, until: 999, motion: MOTION_HOMING },
      { fromX: 960, fromY: 540, x: 700, y: 700, until: 130, form: VOLCANO_FORM },
    ]);
    magma.update(shots, 3, NO_ZONES, 0, 112, 1, 16);
    expect(sprites(shadows as ParticleContainer)).toBe(2);
    expect(sprites(magma.airView)).toBe(8);
    const halo = (k: number): number => magma.airView.particleChildren[k]?.scaleX ?? 0;
    // The giant bomb's halo (sprite 5 of the second bomb's four) is bigger than the first's.
    expect(halo(5)).toBeGreaterThan(halo(1) * 2);
    // Gone once they leave the pool.
    magma.update(NO_SHOTS, 0, NO_ZONES, 0, 131, 1, 16);
    expect(sprites(magma.airView)).toBe(0);
  });
});

describe('the fire zone (火地)', () => {
  it('fades in, holds and fades out by its expiry', () => {
    expect(zoneFade(100, 190, 99)).toBe(0);
    expect(zoneFade(100, 190, 101)).toBeGreaterThan(0);
    expect(zoneFade(100, 190, 101)).toBeLessThan(1);
    expect(zoneFade(100, 190, 140)).toBe(1);
    expect(zoneFade(100, 190, 185)).toBeLessThan(0.3);
    expect(zoneFade(100, 190, 190)).toBe(0);
  });

  it('draws three glows a signature zone and one an effect zone, none once it has ended', () => {
    const { magma } = setup();
    const [, , glows] = magma.groundViews as ParticleContainer[];
    const zones = zonePool([
      { id: 1, radius: 60, created: 100, expiresAt: 190 },
      { id: 2, radius: 80, created: 100, expiresAt: 220, signature: false },
    ]);
    magma.update(NO_SHOTS, 0, zones, 2, 140, 1, 16);
    expect(sprites(glows as ParticleContainer)).toBe(4);
    magma.update(NO_SHOTS, 0, zones, 2, 200, 1, 16);
    expect(sprites(glows as ParticleContainer)).toBe(1);
  });

  it('flares on a pulse that hit something', () => {
    const { magma } = setup();
    const [, , glows] = magma.groundViews as ParticleContainer[];
    const zones = zonePool([{ id: 7, radius: 60, created: 100, expiresAt: 190 }]);
    const alphaOf = (): number =>
      ((glows as ParticleContainer).particleChildren[1]?.color ?? 0) >>> 24;
    magma.update(NO_SHOTS, 0, zones, 1, 140, 1, 0);
    const calm = alphaOf();
    magma.zonePulse(7);
    magma.update(NO_SHOTS, 0, zones, 1, 140, 1, 0);
    expect(alphaOf()).toBeGreaterThan(calm);
  });
});

describe('the explosion', () => {
  it('flashes, rings out to its radius in the character orange and leaves a scorch mark', () => {
    const { fx, shock, magma } = setup();
    magma.explosion(800, 400, 60);
    magma.flushTick();
    expect(fx.count(FX_FLASH)).toBeGreaterThanOrEqual(2);
    expect(shock).toHaveBeenCalledTimes(1);
    expect(shock.mock.calls[0]?.slice(0, 4)).toEqual([800, 400, 66, 0xff7a2f]);
    expect(magma.scorchMarks).toBe(1);
  });

  it('keeps at most SCORCH_CAP scorch marks, until the wave is cleared', () => {
    const { magma } = setup();
    for (let i = 0; i < SCORCH_CAP + 5; i++) magma.explosion(100 + i, 400, 60);
    expect(magma.scorchMarks).toBe(SCORCH_CAP);
    magma.waveCleared();
    magma.update(NO_SHOTS, 0, NO_ZONES, 0, 10, 1, 500);
    expect(magma.scorchMarks).toBe(SCORCH_CAP);
    magma.update(NO_SHOTS, 0, NO_ZONES, 0, 10, 1, 500);
    expect(magma.scorchMarks).toBe(0);
  });

  it('draws 連環爆’s small blasts without a scorch mark', () => {
    const { shock, magma } = setup();
    magma.smallBlast(800, 400, 40);
    expect(shock).toHaveBeenCalledTimes(1);
    expect(magma.scorchMarks).toBe(0);
  });

  it('adds 霜焰’s white-blue frost ring outside the orange one', () => {
    const { shock, magma } = setup(true);
    magma.explosion(800, 400, 60);
    expect(shock).toHaveBeenCalledTimes(2);
    const [orange, frost] = shock.mock.calls;
    expect(frost?.[3]).toBe(MAGMA_COLORS.frostRim);
    expect(frost?.[2]).toBeGreaterThan(orange?.[2] ?? Infinity);
  });
});

describe('瘟爆 (火毒): an explosion that poisons bubbles', () => {
  it('bubbles over an explosion that poisoned an enemy inside it in the same tick', () => {
    const { fx, magma } = setup();
    magma.explosion(800, 400, 60);
    magma.poisoned(830, 410);
    magma.flushTick();
    expect(fx.count(FX_BUBBLE)).toBeGreaterThanOrEqual(5);
  });

  it('gives a poisoned enemy outside every explosion one bubble, and an unpoisoned one none', () => {
    const { fx, magma } = setup();
    magma.explosion(800, 400, 60);
    magma.flushTick();
    expect(fx.count(FX_BUBBLE)).toBe(0);
    magma.poisoned(100, 100);
    magma.flushTick();
    expect(fx.count(FX_BUBBLE)).toBe(1);
  });

  it('pops a green ring for a poison spread that reached someone', () => {
    const { shock, magma } = setup();
    magma.poisonSpread(500, 500, 90, 0);
    expect(shock).not.toHaveBeenCalled();
    magma.poisonSpread(500, 500, 90, 2);
    expect(shock.mock.calls[0]?.slice(0, 4)).toEqual([500, 500, 90, 0x3fd08a]);
  });
});

describe('火環', () => {
  it('rings out from the player to the nova’s radius, forced past the shock cap', () => {
    const { shock, magma } = setup();
    magma.thresholdNova(960, 540, 300);
    expect(shock.mock.calls[0]).toEqual([960, 540, 300, 0xff7a2f, 16, 640, true]);
  });
});

describe('reset', () => {
  it('forgets the scorch marks and every sprite', () => {
    const { magma } = setup();
    magma.explosion(800, 400, 60);
    const shots = shotPool([{ fromX: 960, fromY: 540, x: 1200, y: 400, until: 124 }]);
    magma.update(shots, 1, NO_ZONES, 0, 112, 1, 16);
    magma.reset();
    expect(magma.scorchMarks).toBe(0);
    expect(sprites(magma.airView)).toBe(0);
  });
});
