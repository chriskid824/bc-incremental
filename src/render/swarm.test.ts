import { Graphics, Texture } from 'pixi.js';
import type { ParticleContainer, Renderer } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import type { Skin } from '../data/web/types';
import { CRIT as CRIT_OUTER } from '../data/outer/crit';
import { ICE as ICE_OUTER } from '../data/outer/ice';
import { POISON as POISON_OUTER } from '../data/outer/poison';
import {
  DRONE_DASH,
  DRONE_DOCKED,
  DRONE_KIND_DRONE,
  DRONE_KIND_SPIRIT,
  DRONE_KIND_TURRET,
} from '../sim';
import type { DroneViewState, SimState } from '../sim';
import { combCells, COMB_CELL } from './combLattice';
import { slotSkins } from './characterLook';
import type { CharacterLook } from './characterLook';
import { DroneLayer, droneSize, drawKite, HIVE_DRONE_SKIN } from './drones';
import type { KiteMotif } from './drones';
import { FX_BUBBLE, FX_DEBRIS, FX_FLAME, FX_FLASH, FX_SPARK, FxParticles } from './fx';
import { CONSTRUCT_COLORS, mixColor } from './palette';
import { RingLayer } from './rings';
import {
  IMPACT_BUDGET,
  MUZZLE_BUDGET,
  PLAIN_LOOK,
  PLAIN_SWARM,
  shapeLook,
  SwarmLayer,
  swarmDroneSkin,
  swarmLooks,
  WAKE_CAP,
  WAKE_EVERY,
  WAKE_MS,
} from './swarm';
import type { SwarmLooks, SwarmTextures } from './swarm';

const C = CONSTRUCT_COLORS.hive;
const tex = Texture.WHITE;
const TEXTURES: SwarmTextures = { glow: tex, streak: tex, flame: tex, bubble: tex, shard: tex };

/** The four B2 fusions' skins: the fire outer is not written yet, so its skin is assumed. */
const FIRE: Skin = { accent: 0xff7a2f, shape: 'flame' };
const ICE = ICE_OUTER.skin;
const POISON = POISON_OUTER.skin;
const CRIT = CRIT_OUTER.skin;

const CENTER = { x: 960, y: 540 };

interface Slot {
  readonly kind?: number;
  readonly mode?: number;
  readonly x?: number;
  readonly y?: number;
  readonly prevX?: number;
  readonly prevY?: number;
  readonly size?: number;
}

/** A drone pool of `slots`, ids 1 up (or `ids`), with a `size` row when any slot sets one. */
function pool(slots: readonly Slot[], ids?: readonly number[]): DroneViewState {
  const n = Math.max(1, slots.length);
  const sized = slots.some((slot) => slot.size !== undefined);
  const ds = {
    id: new Int32Array(n),
    kind: new Uint8Array(n),
    mode: new Uint8Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    prevX: new Float64Array(n),
    prevY: new Float64Array(n),
    targetId: new Int32Array(n).fill(-1),
    owner: new Int16Array(n),
    seat: new Int16Array(n),
    ...(sized ? { size: new Float64Array(n).fill(1) } : {}),
  };
  slots.forEach((slot, s) => {
    ds.id[s] = ids?.[s] ?? s + 1;
    ds.kind[s] = slot.kind ?? DRONE_KIND_DRONE;
    ds.mode[s] = slot.mode ?? DRONE_DOCKED;
    ds.x[s] = slot.x ?? CENTER.x + 43;
    ds.y[s] = slot.y ?? CENTER.y;
    ds.prevX[s] = slot.prevX ?? slot.x ?? CENTER.x + 43;
    ds.prevY[s] = slot.prevY ?? slot.y ?? CENTER.y;
    if (slot.size !== undefined && 'size' in ds) ds.size[s] = slot.size;
  });
  return ds;
}

function setup(looks: SwarmLooks = PLAIN_SWARM) {
  const fx = new FxParticles({ glow: tex });
  const rings = new RingLayer();
  const impact = vi.spyOn(rings, 'impact');
  const shock = vi.spyOn(rings, 'shock');
  let n = 0;
  const random = (): number => (((n++ * 0.37) % 1) + 1) % 1;
  const swarm = new SwarmLayer(TEXTURES, fx, rings, looks, random);
  const step = (ds: DroneViewState, count: number, tick: number, dtMs = 16): void =>
    swarm.update(ds, count, CENTER.x, CENTER.y, tick, 1, dtMs);
  return { fx, rings, impact, shock, swarm, step };
}

const wakes = (swarm: SwarmLayer): ParticleContainer => swarm.groundViews[0] as ParticleContainer;

/** A drone out of its dock, dashing +12 px a tick along x. */
const dashing = (x = 1200): Slot => ({
  mode: DRONE_DASH,
  x,
  y: 300,
  prevX: x - 12,
  prevY: 300,
});

describe('drone fusion skins by slot (gd §5.3)', () => {
  it('reads the B2 outers’ skins as written: ice a crystal, poison a bubble, crit a slash', () => {
    expect([ICE.shape, POISON.shape, CRIT.shape]).toEqual(['crystal', 'bubble', 'slash']);
  });

  it('takes the fill from slot 1, the trail from slot 2 and the impact from slot 3', () => {
    expect(swarmLooks([])).toEqual(PLAIN_SWARM);
    expect(swarmLooks([POISON])).toEqual({ fill: POISON, trail: POISON, impact: POISON });
    expect(swarmLooks([FIRE, ICE])).toEqual({ fill: FIRE, trail: ICE, impact: FIRE });
    expect(swarmLooks([FIRE, ICE, CRIT])).toEqual({ fill: FIRE, trail: ICE, impact: CRIT });
  });

  it('orders the skins by the look’s fusion slots, not by its fusions list', () => {
    const unordered: CharacterLook = {
      construct: 'hive',
      arena: 'summon',
      color: C.main,
      fusions: [
        { outer: 'crit', skin: CRIT },
        { outer: 'fire', skin: FIRE },
      ],
      summons: false,
    };
    const look: CharacterLook = { ...unordered, slots: ['fire', 'crit'] };
    expect(slotSkins(look)).toEqual([FIRE, CRIT]);
    expect(slotSkins(unordered)).toEqual([CRIT, FIRE]);
    // A slot whose fusion is not owned is skipped.
    expect(slotSkins({ ...look, slots: ['ice', 'fire'] })).toEqual([FIRE]);
  });

  it('keeps the hive’s own drone without a fusion', () => {
    expect(swarmDroneSkin(PLAIN_SWARM)).toBe(HIVE_DRONE_SKIN);
  });

  it('dresses 毒泡 as a see-through green bubble inside the yellow-green kite outline', () => {
    const skin = swarmDroneSkin(swarmLooks([POISON]));
    expect(skin).toMatchObject({
      fill: POISON.accent,
      edge: C.main,
      halo: C.main,
      motif: 'bubble',
      trail: POISON.accent,
    });
    expect(skin.fillAlpha).toBeLessThan(0.8);
  });

  it('gives 焰蜂 a flame fill with an orange trail, 霜蜂 a crystal with a white frost trail, 刃翼 a blade', () => {
    const fire = swarmDroneSkin(swarmLooks([FIRE]));
    expect([fire.fill, fire.motif, fire.trail]).toEqual([FIRE.accent, 'flame', FIRE.accent]);
    const ice = swarmDroneSkin(swarmLooks([ICE]));
    expect([ice.fill, ice.motif]).toEqual([ICE.accent, 'crystal']);
    expect(ice.trail).toBe(mixColor(ICE.accent, 0xffffff, 0.75));
    const crit = swarmDroneSkin(swarmLooks([CRIT]));
    expect(crit.motif).toBe('blade');
    expect(crit.trailWidth).toBeLessThan(PLAIN_LOOK.trailWidth);
    // Two slots: the fill is fire's, the trail ice's.
    const both = swarmDroneSkin(swarmLooks([FIRE, ICE]));
    expect([both.fill, both.motif, both.trail]).toEqual([FIRE.accent, 'flame', ice.trail]);
  });

  it('draws a shape it does not know in its accent with the plain looks', () => {
    expect(shapeLook('coin')).toBe(PLAIN_LOOK);
    expect(shapeLook('no-such-shape')).toBe(PLAIN_LOOK);
    const skin = swarmDroneSkin(swarmLooks([{ accent: 0x123456, shape: 'coin' }]));
    expect([skin.fill, skin.motif, skin.trail, skin.edge]).toEqual([
      0x123456,
      'line',
      0x123456,
      C.main,
    ]);
    // Even one outside ShapeId, as a later outer's data might carry.
    const odd = { accent: 0xabcdef, shape: 'mystery' } as unknown as Skin;
    expect(
      () =>
        new SwarmLayer(
          TEXTURES,
          new FxParticles({ glow: tex }),
          new RingLayer(),
          swarmLooks([odd]),
        ),
    ).not.toThrow();
  });

  it('draws every motif’s kite', () => {
    const motifs: KiteMotif[] = ['line', 'flame', 'crystal', 'bubble', 'blade'];
    for (const motif of motifs) {
      const g = drawKite(new Graphics(), { ...HIVE_DRONE_SKIN, motif });
      expect(g.context.instructions.length).toBeGreaterThan(2);
    }
  });
});

describe('the impact (gd §1.5: 200% with a splash of 40)', () => {
  it('rings the splash radius in the impact skin’s colour, and flashes', () => {
    const { swarm, impact, fx } = setup(swarmLooks([FIRE, ICE, CRIT]));
    swarm.impact(1300, 500, 40, CENTER.x, CENTER.y);
    expect(impact).toHaveBeenCalledWith(1300, 500, 40, CRIT.accent);
    expect(fx.count(FX_FLASH)).toBe(1);
    // 刃翼's cut: two strokes.
    expect(fx.count(FX_SPARK)).toBe(2);
  });

  it('rings hive green and throws sparks without a fusion', () => {
    const { swarm, impact, fx } = setup();
    swarm.impact(1300, 500, 40, CENTER.x, CENTER.y);
    expect(impact).toHaveBeenCalledWith(1300, 500, 40, C.main);
    expect(fx.count(FX_SPARK)).toBe(5);
  });

  it.each([
    ['flame', FIRE, FX_FLAME],
    ['crystal', ICE, FX_DEBRIS],
    ['bubble', POISON, FX_BUBBLE],
  ] as const)('throws the %s skin’s particles', (_, skin, group) => {
    const { swarm, fx, shock } = setup(swarmLooks([skin]));
    swarm.impact(1300, 500, 40, CENTER.x, CENTER.y);
    expect(fx.count(group)).toBeGreaterThan(0);
    // 霜蜂's shatter adds a frost ring outside the splash.
    expect(shock).toHaveBeenCalledTimes(skin === ICE ? 1 : 0);
  });

  it('draws only rings past the frame’s budget, and opens a new budget each frame', () => {
    const { swarm, impact, fx, step } = setup();
    for (let i = 0; i < 30; i++) swarm.impact(1300, 500, 40, CENTER.x, CENTER.y);
    expect(impact).toHaveBeenCalledTimes(30);
    expect(fx.count(FX_FLASH)).toBe(IMPACT_BUDGET);
    step(pool([]), 0, 1);
    swarm.impact(1300, 500, 40, CENTER.x, CENTER.y);
    expect(fx.count(FX_FLASH)).toBe(IMPACT_BUDGET + 1);
  });
});

describe('the turret’s muzzle flash', () => {
  it('flashes at the barrel’s tip toward its target, within a budget', () => {
    const { swarm, fx } = setup();
    swarm.muzzle(1050, 540, 0);
    expect(fx.count(FX_FLASH)).toBe(1);
    const flash = fx.view.particleChildren[0];
    expect([flash?.x, flash?.y]).toEqual([1068, 540]);
    for (let i = 0; i < 20; i++) swarm.muzzle(1050, 540, 0);
    expect(fx.count(FX_FLASH)).toBe(MUZZLE_BUDGET);
  });
});

describe('the dock ring and turret seats', () => {
  it('draws a cradle per docked drone and a seat per turret, and redraws only on a change', () => {
    const { swarm, step, fx } = setup();
    const docks = swarm.docks;
    const ds = pool([
      {},
      { x: CENTER.x - 43 },
      { kind: DRONE_KIND_TURRET, x: CENTER.x + 90, y: CENTER.y },
    ]);
    step(ds, 3, 1);
    const drawn = docks.context.instructions.length;
    expect(drawn).toBeGreaterThan(0);
    const clear = vi.spyOn(docks, 'clear');
    step(ds, 3, 2);
    expect(clear).not.toHaveBeenCalled();
    // Drone 1 leaves: its dock puffs and the ring redraws with an empty cradle.
    const out = pool([
      { mode: DRONE_DASH, x: CENTER.x + 60, prevX: CENTER.x + 43 },
      { x: CENTER.x - 43 },
      { kind: DRONE_KIND_TURRET, x: CENTER.x + 90, y: CENTER.y },
    ]);
    step(out, 3, 3);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(fx.count(FX_FLASH)).toBe(1);
  });

  it('forgets the docks of drones gone from the pool, and every dock at reset', () => {
    const { swarm, step } = setup();
    step(pool([{}, { x: CENTER.x - 43 }]), 2, 1);
    step(pool([{ x: CENTER.x - 43 }], [2]), 1, 2);
    swarm.reset();
    expect(swarm.docks.context.instructions).toHaveLength(0);
  });
});

describe('the drones’ wakes on the floor (gd §11.5)', () => {
  it('lays a wake every WAKE_EVERY ticks for each drone out, none for a docked one', () => {
    const { swarm, step } = setup();
    const ds = pool([dashing(), {}, { ...dashing(900), kind: DRONE_KIND_SPIRIT }]);
    for (let tick = 1; tick <= WAKE_EVERY * 4; tick++) step(ds, 3, tick);
    expect(swarm.wakeMarks).toBe(8);
    expect(wakes(swarm).particleChildren).toHaveLength(8);
    // The same tick drawn again lays nothing.
    step(ds, 3, WAKE_EVERY * 4);
    expect(swarm.wakeMarks).toBe(8);
  });

  it('keeps at most WAKE_CAP and fades each out over WAKE_MS', () => {
    const { swarm, step } = setup();
    const many = Array.from({ length: 24 }, (_, i) => dashing(600 + i * 20));
    const ds = pool(many);
    for (let tick = 1; tick <= WAKE_EVERY * 20; tick++) step(ds, 24, tick, 1);
    expect(swarm.wakeMarks).toBe(WAKE_CAP);
    step(pool([]), 0, WAKE_EVERY * 20 + 1, WAKE_MS);
    expect(swarm.wakeMarks).toBe(0);
    expect(wakes(swarm).particleChildren).toHaveLength(0);
  });

  it('sizes a wake by the drone’s size row when the view has one', () => {
    const { swarm, step } = setup();
    step(pool([dashing(), { ...dashing(800), size: 1.5 }]), 2, WAKE_EVERY);
    const [small, big] = wakes(swarm).particleChildren;
    expect((big?.scaleX ?? 0) / (small?.scaleX ?? 1)).toBeCloseTo(1.5, 9);
  });
});

describe('the trail skin’s shedding', () => {
  it('sheds embers behind 焰蜂’s drones that are out, and nothing for a plain trail', () => {
    const fire = setup(swarmLooks([ICE, FIRE]));
    const ds = pool([dashing(), {}]);
    for (let tick = 1; tick <= 10; tick++) fire.step(ds, 2, tick, 20);
    expect(fire.fx.count(FX_FLAME)).toBeGreaterThan(0);
    const plain = setup();
    for (let tick = 1; tick <= 10; tick++) plain.step(ds, 2, tick, 20);
    expect(plain.fx.count(FX_FLAME) + plain.fx.count(FX_DEBRIS) + plain.fx.count(FX_BUBBLE)).toBe(
      0,
    );
  });
});

describe('a drone’s size (蜂后, 巨像: the engine may add a size row later)', () => {
  const renderer = { generateTexture: () => Texture.WHITE } as unknown as Renderer;
  const sim = (ds: DroneViewState, count: number): SimState =>
    ({
      tick: 1,
      player: { x: CENTER.x, y: CENTER.y, life: 1, maxLife: 1, shield: 0 },
      drones: ds,
      droneCount: count,
    }) as unknown as SimState;
  const noEnemies = { positionOf: () => null };

  it('is 1 without a size row, and the row’s value with one', () => {
    const plain = pool([{}]);
    expect(droneSize(plain, 0)).toBe(1);
    const sized = pool([{}, { size: 1.5 }]);
    expect([droneSize(sized, 0), droneSize(sized, 1)]).toEqual([1, 1.5]);
  });

  it('scales the kite by it', () => {
    const layer = new DroneLayer(renderer, Texture.WHITE);
    const kites = layer.view.getChildByLabel('drone-kites') as ParticleContainer;
    layer.update(sim(pool([{}, { x: CENTER.x - 43, size: 1.5 }]), 2), 1, noEnemies);
    expect(kites.particleChildren.map((p) => p.scaleX)).toEqual([1, 1.5]);
  });
});

describe('蜂巢’s arena (gd §11.5: deep teal with a hex lattice)', () => {
  it('centers a cell on the player and rings the rest by hex distance', () => {
    const cells = combCells(1920, 1080, 960, 540, COMB_CELL);
    const center = cells.filter((c) => c.ring === 0);
    expect(center).toEqual([{ x: 960, y: 540, ring: 0 }]);
    const ring1 = cells.filter((c) => c.ring === 1);
    expect(ring1).toHaveLength(6);
    for (const c of ring1) {
      expect(Math.hypot(c.x - 960, c.y - 540)).toBeCloseTo(Math.sqrt(3) * COMB_CELL, 9);
    }
  });

  it('covers the whole arena, corners included', () => {
    const cells = combCells(1920, 1080, 960, 540, COMB_CELL);
    for (const [x, y] of [
      [0, 0],
      [1920, 0],
      [0, 1080],
      [1920, 1080],
      [500, 700],
    ] as const) {
      const nearest = Math.min(...cells.map((c) => Math.hypot(c.x - x, c.y - y)));
      expect(nearest).toBeLessThanOrEqual(COMB_CELL);
    }
  });
});
