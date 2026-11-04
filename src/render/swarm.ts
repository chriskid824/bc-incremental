/**
 * 蜂巢's attack language (docs/v3/game-design-v3.md §1.5, §11.4, §11.5) and the fusion skins on
 * its drones (§5.3): many, small, outward.
 *
 * - The dock ring: a faint ring of cradles round the comb, one under each drone's dock, lit while
 *   its drone sits in it and dim while it is out; a drone leaving puffs at its dock, one coming
 *   home blinks it. Turret seats: a hex plate on the floor under each turret.
 * - Sortie wakes: the drones out of their docks leave a faint wake on the floor (gd §11.5
 *   「無人機留下淡淡的航跡」), sampled every WAKE_EVERY sim ticks and fading over WAKE_MS; the
 *   trail skin may shed embers, frost or bubbles behind them too.
 * - The impact ('impact'): a flash and a ring out to its splash radius (40 for the signature),
 *   and sparks thrown outward, or the impact skin's effect.
 * - A turret's muzzle flash ('turretFire') at the barrel's tip, toward its target.
 *
 * Fusion skins are parameters (gd §5.3, §11.7): the owned fusions' skins in slot order give the
 * kite's fill (slot 1), the trail (slot 2) and the impact (slot 3), each from the skin's accent and
 * shape (SHAPE_LOOKS); a slot left empty takes slot 1's. The kite's outline and its yellow-green
 * edge stay the hive's. A shape without an entry draws in its accent with the plain looks.
 *
 * Every effect goes through the renderer's capped FX and ring pools, and the impacts and muzzle
 * flashes past a frame's budget draw only their ring, so a crowded swarm sheds detail first.
 */

import { Graphics } from 'pixi.js';
import type { ParticleContainer, Texture } from 'pixi.js';
import { DRONE_DOCKED, DRONE_KIND_DRONE, DRONE_KIND_SPIRIT, DRONE_KIND_TURRET } from '../sim';
import type { DroneViewState } from '../sim';
import type { ShapeId, Skin } from '../data/web/types';
import { DOCK_RADIUS } from './constructs/hive';
import { droneSize, HIVE_DRONE_SKIN, SPIRIT_SCALE } from './drones';
import type { DroneSkin, KiteMotif } from './drones';
import { FX_BUBBLE, FX_DEBRIS, FX_FLAME, FX_FLASH, FX_SPARK, packColor } from './fx';
import type { FxGroup, FxParticles } from './fx';
import { CONSTRUCT_COLORS, HIVE_COLORS, mixColor } from './palette';
import { defaultRandom } from './random';
import type { RenderRandom } from './random';
import type { RingLayer } from './rings';
import { SpriteBatch } from './spriteBatch';

const C = CONSTRUCT_COLORS.hive;
const TAU = Math.PI * 2;

/** What a trail sheds behind a moving drone. */
export type TrailShed = 'none' | 'ember' | 'frost' | 'bubble';
/** What an impact throws besides its flash and ring. */
export type ImpactKind = 'spark' | 'flame' | 'shatter' | 'pop' | 'cut';

/** How one skin shape reads on a drone: its kite motif, its trail and its impact. */
export interface ShapeLook {
  readonly motif: KiteMotif;
  /** The motif's colour: the accent this far toward white. */
  readonly markWhiten: number;
  /** The fill's opacity; the kite's default when left out. */
  readonly fillAlpha?: number;
  /** The trail's colour: the accent this far toward white. */
  readonly trailWhiten: number;
  readonly trailWidth: number;
  readonly shed: TrailShed;
  readonly impact: ImpactKind;
}

/** A shape with no entry here: the accent, the nose line, a plain trail and sparks. */
export const PLAIN_LOOK: ShapeLook = {
  motif: 'line',
  markWhiten: -0.55,
  trailWhiten: 0,
  trailWidth: 7,
  shed: 'none',
  impact: 'spark',
};

/**
 * The skin shapes 蜂巢's drones know (gd §5.3, §11.6, §11.7): 焰蜂 a flame with an orange trail
 * shedding embers; 霜蜂 a diamond ice crystal with a white frost trail that shatters on impact;
 * 毒泡 a see-through green bubble that pops; 刃翼 a white blade with a thin bright trail that
 * cuts. The other outers' shapes read as PLAIN_LOOK in their accent until their batches.
 */
export const SHAPE_LOOKS: Readonly<Partial<Record<ShapeId, ShapeLook>>> = {
  flame: {
    motif: 'flame',
    markWhiten: 0.55,
    trailWhiten: 0,
    trailWidth: 8,
    shed: 'ember',
    impact: 'flame',
  },
  crystal: {
    motif: 'crystal',
    markWhiten: 1,
    trailWhiten: 0.75,
    trailWidth: 6,
    shed: 'frost',
    impact: 'shatter',
  },
  bubble: {
    motif: 'bubble',
    markWhiten: 0.6,
    fillAlpha: 0.55,
    trailWhiten: 0,
    trailWidth: 7,
    shed: 'bubble',
    impact: 'pop',
  },
  slash: {
    motif: 'blade',
    markWhiten: 1,
    trailWhiten: 0.6,
    trailWidth: 4,
    shed: 'none',
    impact: 'cut',
  },
};

/** The looks of `shape`; PLAIN_LOOK for a shape it does not know, a later outer's included. */
export function shapeLook(shape: string): ShapeLook {
  return SHAPE_LOOKS[shape as ShapeId] ?? PLAIN_LOOK;
}

/** `color` toward white by `t`, or toward black by −t. */
function whiten(color: number, t: number): number {
  return t >= 0 ? mixColor(color, 0xffffff, t) : mixColor(color, 0x000000, -t);
}

/** Which skins dress 蜂巢's drones: null for each part the hive's own colours draw. */
export interface SwarmLooks {
  /** The kite's fill and motif: slot 1. */
  readonly fill: Skin | null;
  /** The trail, the wake and what they shed: slot 2, else slot 1. */
  readonly trail: Skin | null;
  /** The impact's colour and effect: slot 3, else slot 1. */
  readonly impact: Skin | null;
}

export const PLAIN_SWARM: SwarmLooks = { fill: null, trail: null, impact: null };

/**
 * The swarm's looks from the owned fusions' skins in slot order (slotSkins, characterLook.ts):
 * slot 1 the fill, slot 2 the trail and slot 3 the impact (gd §5.3); with one fusion it dresses
 * all three (毒泡 is a green bubble drone), and a part whose slot is empty takes slot 1's.
 */
export function swarmLooks(skins: readonly Skin[]): SwarmLooks {
  const first = skins[0] ?? null;
  return { fill: first, trail: skins[1] ?? first, impact: skins[2] ?? first };
}

/**
 * The drone layer's skin for `looks`: the hive's own without a fusion; else the fill skin's
 * accent and motif inside the hive's outline, glow and yellow-green edge, and the trail skin's
 * colour and width.
 */
export function swarmDroneSkin(looks: SwarmLooks): DroneSkin {
  if (looks.fill === null && looks.trail === null) return HIVE_DRONE_SKIN;
  const fill = looks.fill;
  const fillLook = fill === null ? null : shapeLook(fill.shape);
  const trail = looks.trail;
  const trailLook = trail === null ? null : shapeLook(trail.shape);
  return {
    fill: fill?.accent ?? C.main,
    edge: fill === null ? C.droneEdge : C.main,
    mark:
      fill === null || fillLook === null ? C.droneMark : whiten(fill.accent, fillLook.markWhiten),
    trail:
      trail === null || trailLook === null ? C.main : whiten(trail.accent, trailLook.trailWhiten),
    halo: C.main,
    ...(fillLook?.fillAlpha === undefined ? {} : { fillAlpha: fillLook.fillAlpha }),
    ...(fillLook === null ? {} : { motif: fillLook.motif }),
    ...(trailLook === null ? {} : { trailWidth: trailLook.trailWidth }),
  };
}

/** The effect sheet's frames the layer draws with (FxTextures, src/render/fxTextures.ts). */
export interface SwarmTextures {
  readonly glow: Texture;
  readonly streak: Texture;
  readonly flame: Texture;
  readonly bubble: Texture;
  readonly shard: Texture;
}

/** Texture sizes in pixels (src/render/fxTextures.ts). */
const GLOW_SIZE = 64;
const STREAK_LENGTH = 64;
const STREAK_HEIGHT = 16;
const BUBBLE_SIZE = 32;

/** Floor wakes: one point every WAKE_EVERY ticks a drone is out, kept WAKE_MS, WAKE_CAP at once. */
export const WAKE_EVERY = 2;
export const WAKE_MS = 1400;
export const WAKE_CAP = 240;
/** Floats a wake keeps: x, y, heading, size, age in ms. */
const WAKE_STRIDE = 5;
const WAKE_LENGTH = 30;
const WAKE_WIDTH = 9;
const WAKE_ALPHA = 0.16;

/** Dock cradles: arcs this wide at DOCK_RADIUS, under each drone's dock (as HiveView's). */
const CRADLE_HALF = (13 * Math.PI) / 180;
/** A dock blinks this long as its drone comes home. */
const DOCK_BLINK_MS = 220;
/** A turret's seat plate: a hexagon of this circumradius. */
const SEAT_PLATE = 17;
/** The barrel's tip, from the turret's center (drones.ts BARREL_LENGTH). */
const MUZZLE_REACH = 18;

/** Impacts and muzzle flashes drawn in full per frame; past these they draw their ring only. */
export const IMPACT_BUDGET = 8;
export const MUZZLE_BUDGET = 8;
/** A trail sheds one particle per moving drone this often, at most SHED_MAX a round. */
const SHED_MS = 60;
const SHED_MAX = 8;
/** 刃翼's cut strokes: their height, and the crawl that stretches them. */
const CUT_WIDTH = 5;
const CUT_SPEED = 10;

/** One drone's dock as the ring draws it. */
interface Dock {
  x: number;
  y: number;
  docked: boolean;
  blinkMs: number;
  seen: number;
}

export class SwarmLayer {
  /** The floor wakes, additive, over the backdrop. */
  private readonly wakes: SpriteBatch;
  /** Dock ring and turret seats, redrawn when a drone docks or leaves. */
  readonly docks = new Graphics({ label: 'swarm-docks' });
  private readonly wakeData = new Float64Array(WAKE_CAP * WAKE_STRIDE);
  private wakeCount = 0;
  private wakeNext = 0;
  private lastTick = -1;
  private readonly byId = new Map<number, Dock>();
  private calls = 0;
  private dockDirty = true;
  private turretCount = -1;
  private impactsLeft = IMPACT_BUDGET;
  private muzzlesLeft = MUZZLE_BUDGET;
  private shedMs = 0;
  private shedFrom = 0;
  private readonly fillColor: number;
  private readonly trailColor: number;
  private readonly impactColor: number;
  private readonly shed: TrailShed;
  private readonly impactKind: ImpactKind;
  private readonly dropUnseen = (dock: Dock, id: number): void => {
    if (dock.seen !== this.calls) {
      this.byId.delete(id);
      this.dockDirty = true;
    }
  };

  constructor(
    private readonly tex: SwarmTextures,
    private readonly fx: FxParticles,
    private readonly rings: RingLayer,
    looks: SwarmLooks = PLAIN_SWARM,
    private readonly random: RenderRandom = defaultRandom,
  ) {
    this.wakes = new SpriteBatch('swarm-wakes', tex.streak, 'add', WAKE_CAP);
    this.fillColor = looks.fill?.accent ?? C.main;
    const trailSkin = swarmDroneSkin(looks);
    this.trailColor = trailSkin.trail;
    this.shed = looks.trail === null ? 'none' : shapeLook(looks.trail.shape).shed;
    this.impactColor = looks.impact?.accent ?? C.main;
    this.impactKind = looks.impact === null ? 'spark' : shapeLook(looks.impact.shape).impact;
    this.docks.blendMode = 'add';
  }

  /** The layers over the backdrop and under the crowd, bottom first: wakes, docks. */
  get groundViews(): readonly (ParticleContainer | Graphics)[] {
    return [this.wakes.view, this.docks];
  }

  /** Wakes on the floor now. */
  get wakeMarks(): number {
    return this.wakeCount;
  }

  /** Forgets every effect, as at the start of a run. */
  reset(): void {
    this.wakeCount = 0;
    this.wakeNext = 0;
    this.lastTick = -1;
    this.byId.clear();
    this.dockDirty = true;
    this.turretCount = -1;
    this.impactsLeft = IMPACT_BUDGET;
    this.muzzlesLeft = MUZZLE_BUDGET;
    this.shedMs = 0;
    this.shedFrom = 0;
    this.wakes.clear();
    this.docks.clear();
  }

  /**
   * Drone `droneId` (−1: a repeat's or a turret shot's splash) impacted at (x, y) over its splash
   * `radius`: a ring in the impact colour out to it, and within the frame's budget a flash and
   * the impact skin's effect, thrown away from the core at (cx, cy).
   */
  impact(x: number, y: number, radius: number, cx: number, cy: number): void {
    this.rings.impact(x, y, radius, this.impactColor);
    if (this.impactsLeft <= 0) return;
    this.impactsLeft--;
    const out = Math.atan2(y - cy, x - cx);
    const color = this.impactColor;
    this.glow(FX_FLASH, x, y, Math.max(28, radius * 1.3), HIVE_COLORS.flash, color, 0.75, 150);
    switch (this.impactKind) {
      case 'flame':
        this.flames(x, y, radius * 0.4, 3, color);
        this.sparks(x, y, out, 1.1, 4, mixColor(color, 0xffffff, 0.5), color, 0.8);
        break;
      case 'shatter':
        this.rings.shock(x, y, radius * 1.25, mixColor(color, 0xffffff, 0.7), 3, 300);
        this.shards(x, y, out, 6, color);
        break;
      case 'pop':
        this.bubbles(x, y, radius * 0.5, 5, color);
        break;
      case 'cut':
        this.cut(x, y, out, radius, color);
        break;
      default:
        this.sparks(x, y, out, 1.1, 5, HIVE_COLORS.flash, color, 1);
        break;
    }
  }

  /** A turret at (x, y) fired toward `angle` (turretFire): a flash at its barrel's tip. */
  muzzle(x: number, y: number, angle: number): void {
    if (this.muzzlesLeft <= 0) return;
    this.muzzlesLeft--;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const tx = x + c * MUZZLE_REACH;
    const ty = y + s * MUZZLE_REACH;
    this.glow(FX_FLASH, tx, ty, 30, HIVE_COLORS.flash, C.main, 0.85, 90);
    this.sparks(tx, ty, angle, 0.35, 2, HIVE_COLORS.flash, C.main, 0.7);
  }

  /**
   * Draws the dock ring and seats of the first `count` slots of `drones` around the core at
   * (cx, cy), the wakes and the trail's shedding, at `alpha` between the sim's last two ticks
   * (`tick` the newer), `dtMs` after the last frame; and opens the frame's effect budgets.
   */
  update(
    drones: Readonly<DroneViewState>,
    count: number,
    cx: number,
    cy: number,
    tick: number,
    alpha: number,
    dtMs: number,
  ): void {
    this.impactsLeft = IMPACT_BUDGET;
    this.muzzlesLeft = MUZZLE_BUDGET;
    this.followDocks(drones, count, dtMs);
    if (tick !== this.lastTick) {
      if (tick < this.lastTick) this.wakeCount = 0;
      if (tick % WAKE_EVERY === 0) this.sampleWakes(drones, count);
      this.lastTick = tick;
    }
    this.drawWakes(dtMs);
    if (this.dockDirty) this.drawDocks(drones, count, cx, cy);
    this.shedTrails(drones, count, alpha, dtMs);
  }

  /** Each drone's dock and whether it sits in it; launches puff and homecomings blink. */
  private followDocks(drones: Readonly<DroneViewState>, count: number, dtMs: number): void {
    const calls = ++this.calls;
    let turrets = 0;
    for (let s = 0; s < count; s++) {
      const kind = drones.kind[s];
      if (kind === DRONE_KIND_TURRET) turrets++;
      if (kind !== DRONE_KIND_DRONE) continue;
      const id = drones.id[s] as number;
      const docked = drones.mode[s] === DRONE_DOCKED;
      let dock = this.byId.get(id);
      if (dock === undefined) {
        if (!docked) continue;
        dock = { x: 0, y: 0, docked: true, blinkMs: 0, seen: calls };
        this.byId.set(id, dock);
        this.dockDirty = true;
      }
      dock.seen = calls;
      if (docked) {
        dock.x = drones.x[s] as number;
        dock.y = drones.y[s] as number;
      }
      if (dock.blinkMs > 0) {
        dock.blinkMs = Math.max(0, dock.blinkMs - dtMs);
        this.dockDirty = true;
      }
      if (docked === dock.docked) continue;
      dock.docked = docked;
      this.dockDirty = true;
      if (docked) dock.blinkMs = DOCK_BLINK_MS;
      else this.glow(FX_FLASH, dock.x, dock.y, 26, HIVE_COLORS.flash, this.fillColor, 0.5, 160);
    }
    if (turrets !== this.turretCount) {
      this.turretCount = turrets;
      this.dockDirty = true;
    }
    this.byId.forEach(this.dropUnseen);
  }

  private drawDocks(drones: Readonly<DroneViewState>, count: number, cx: number, cy: number) {
    this.dockDirty = false;
    const g = this.docks;
    g.clear();
    if (this.byId.size > 0) {
      g.circle(cx, cy, DOCK_RADIUS).stroke({ width: 1, color: C.dock, alpha: 0.35 });
    }
    let lit = 0;
    let empty = 0;
    this.byId.forEach((dock) => {
      if (!dock.docked) {
        this.cradle(g, cx, cy, dock);
        empty++;
      }
    });
    if (empty > 0) g.stroke({ width: 2, color: HIVE_COLORS.cradleEmpty, alpha: 0.9, cap: 'round' });
    this.byId.forEach((dock) => {
      if (dock.docked) {
        this.cradle(g, cx, cy, dock);
        lit++;
      }
    });
    if (lit > 0) g.stroke({ width: 2.6, color: C.dock, alpha: 1, cap: 'round' });
    this.byId.forEach((dock) => {
      if (dock.blinkMs > 0) {
        g.circle(dock.x, dock.y, 12).stroke({
          width: 2,
          color: this.fillColor,
          alpha: 0.7 * (dock.blinkMs / DOCK_BLINK_MS),
        });
      }
    });
    let seats = 0;
    for (let s = 0; s < count; s++) {
      if (drones.kind[s] !== DRONE_KIND_TURRET) continue;
      const x = drones.x[s] as number;
      const y = drones.y[s] as number;
      const turn = Math.atan2(y - cy, x - cx);
      for (let k = 0; k <= 6; k++) {
        const a = turn + (k * Math.PI) / 3;
        const px = x + Math.cos(a) * SEAT_PLATE;
        const py = y + Math.sin(a) * SEAT_PLATE;
        if (k === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      seats++;
    }
    if (seats > 0) {
      g.fill({ color: HIVE_COLORS.seat, alpha: 0.18 }).stroke({
        width: 1.5,
        color: HIVE_COLORS.seat,
        alpha: 0.8,
      });
    }
  }

  /** The cradle arc behind `dock`, on the ring of DOCK_RADIUS round (cx, cy). */
  private cradle(g: Graphics, cx: number, cy: number, dock: Dock): void {
    const a = Math.atan2(dock.y - cy, dock.x - cx);
    g.moveTo(
      cx + Math.cos(a - CRADLE_HALF) * DOCK_RADIUS,
      cy + Math.sin(a - CRADLE_HALF) * DOCK_RADIUS,
    ).arc(cx, cy, DOCK_RADIUS, a - CRADLE_HALF, a + CRADLE_HALF);
  }

  /** A wake point for each drone and spirit out of its dock, along its last tick's move. */
  private sampleWakes(drones: Readonly<DroneViewState>, count: number): void {
    for (let s = 0; s < count; s++) {
      const kind = drones.kind[s];
      if (kind !== DRONE_KIND_DRONE && kind !== DRONE_KIND_SPIRIT) continue;
      if (drones.mode[s] === DRONE_DOCKED) continue;
      const x = drones.x[s] as number;
      const y = drones.y[s] as number;
      const dx = x - (drones.prevX[s] as number);
      const dy = y - (drones.prevY[s] as number);
      if (dx * dx + dy * dy < 1) continue;
      const at = this.wakeNext * WAKE_STRIDE;
      this.wakeData[at] = x;
      this.wakeData[at + 1] = y;
      this.wakeData[at + 2] = Math.atan2(dy, dx);
      this.wakeData[at + 3] =
        droneSize(drones, s) * (kind === DRONE_KIND_SPIRIT ? SPIRIT_SCALE : 1);
      this.wakeData[at + 4] = 0;
      this.wakeNext = (this.wakeNext + 1) % WAKE_CAP;
      this.wakeCount = Math.min(WAKE_CAP, this.wakeCount + 1);
    }
  }

  private drawWakes(dtMs: number): void {
    const batch = this.wakes;
    const data = this.wakeData;
    batch.begin();
    // Oldest first, so the newest draw on top; they age alike, so the expired lead the rest.
    const start = (this.wakeNext - this.wakeCount + WAKE_CAP) % WAKE_CAP;
    let expired = 0;
    for (let i = 0; i < this.wakeCount; i++) {
      const at = ((start + i) % WAKE_CAP) * WAKE_STRIDE;
      const age = (data[at + 4] as number) + dtMs;
      data[at + 4] = age;
      if (age >= WAKE_MS) {
        expired++;
        continue;
      }
      const size = data[at + 3] as number;
      const fade = 1 - age / WAKE_MS;
      batch.add(
        this.tex.streak,
        1,
        data[at] as number,
        data[at + 1] as number,
        data[at + 2] as number,
        (WAKE_LENGTH * size) / STREAK_LENGTH,
        (WAKE_WIDTH * size * (0.6 + 0.4 * fade)) / STREAK_HEIGHT,
        packColor(this.trailColor, WAKE_ALPHA * fade),
      );
    }
    this.wakeCount -= expired;
    batch.end();
  }

  /** The trail skin's embers, frost or bubbles behind the drones that are out. */
  private shedTrails(drones: Readonly<DroneViewState>, count: number, alpha: number, dtMs: number) {
    if (this.shed === 'none' || count === 0) return;
    this.shedMs += dtMs;
    if (this.shedMs < SHED_MS) return;
    this.shedMs %= SHED_MS;
    let made = 0;
    for (let i = 0; i < count && made < SHED_MAX; i++) {
      const s = (this.shedFrom + i) % count;
      const kind = drones.kind[s];
      if (kind !== DRONE_KIND_DRONE && kind !== DRONE_KIND_SPIRIT) continue;
      if (drones.mode[s] === DRONE_DOCKED) continue;
      const px = drones.prevX[s] as number;
      const py = drones.prevY[s] as number;
      const x = px + ((drones.x[s] as number) - px) * alpha;
      const y = py + ((drones.y[s] as number) - py) * alpha;
      this.shedOne(x, y);
      made++;
    }
    this.shedFrom = (this.shedFrom + made) % Math.max(1, count);
  }

  private shedOne(x: number, y: number): void {
    const color = this.trailColor;
    if (this.shed === 'ember') {
      const p = this.fx.spawn(FX_FLAME, this.tex.flame, x, y, this.rand(220, 340));
      if (p === null) return;
      p.vy = -this.rand(30, 70);
      const s = this.rand(0.16, 0.24);
      p.scale0 = s;
      p.scale1 = s * 0.3;
      p.color0 = mixColor(color, 0xffffff, 0.45);
      p.color1 = color;
      p.alpha0 = 0.7;
      p.fadeFrom = 0.3;
    } else if (this.shed === 'frost') {
      const p = this.fx.spawn(FX_DEBRIS, this.tex.shard, x, y, this.rand(300, 460));
      if (p === null) return;
      p.vx = this.rand(-20, 20);
      p.vy = this.rand(-20, 20);
      p.spin = this.rand(-4, 4);
      p.sprite.rotation = this.random() * TAU;
      p.scale0 = 0.32;
      p.scale1 = 0.1;
      p.color0 = 0xffffff;
      p.color1 = color;
      p.alpha0 = 0.8;
    } else {
      const p = this.fx.spawn(FX_BUBBLE, this.tex.bubble, x, y, this.rand(320, 480));
      if (p === null) return;
      p.vy = -this.rand(20, 45);
      const s = this.rand(7, 11) / BUBBLE_SIZE;
      p.scale0 = s * 0.6;
      p.scale1 = s * 1.2;
      p.color0 = mixColor(color, 0xffffff, 0.35);
      p.color1 = color;
      p.alpha0 = 0.75;
      p.fadeFrom = 0.5;
    }
  }

  /** `count` sparks within `spread` radians of `angle`, at `power` of full speed. */
  private sparks(
    x: number,
    y: number,
    angle: number,
    spread: number,
    count: number,
    color0: number,
    color1: number,
    power: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const p = this.fx.spawn(FX_SPARK, this.tex.streak, x, y, this.rand(140, 240));
      if (p === null) return;
      const a = angle + this.rand(-spread, spread);
      const speed = this.rand(280, 560) * power;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.drag = 5;
      p.orient = true;
      p.scale0 = 0.26;
      p.scale1 = 0.08;
      p.stretch = 0.0012;
      p.color0 = color0;
      p.color1 = color1;
    }
  }

  private flames(x: number, y: number, spread: number, count: number, color: number): void {
    for (let i = 0; i < count; i++) {
      const p = this.fx.spawn(FX_FLAME, this.tex.flame, x, y, this.rand(240, 360));
      if (p === null) return;
      p.sprite.x += this.rand(-1, 1) * spread;
      p.sprite.y += this.rand(-0.6, 0.4) * spread;
      p.vy = -this.rand(50, 100);
      p.gravity = -100;
      const s = this.rand(0.35, 0.5);
      p.scale0 = s;
      p.scale1 = s * 0.35;
      p.color0 = mixColor(color, 0xffffff, 0.45);
      p.color1 = color;
      p.alpha0 = 0.6;
      p.fadeFrom = 0.3;
    }
  }

  private shards(x: number, y: number, angle: number, count: number, color: number): void {
    for (let i = 0; i < count; i++) {
      const p = this.fx.spawn(FX_DEBRIS, this.tex.shard, x, y, this.rand(260, 400));
      if (p === null) return;
      const a = angle + this.rand(-1.4, 1.4);
      const speed = this.rand(160, 320);
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.drag = 4;
      p.orient = true;
      p.scale0 = 0.45;
      p.scale1 = 0.15;
      p.color0 = 0xffffff;
      p.color1 = color;
    }
  }

  private bubbles(x: number, y: number, spread: number, count: number, color: number): void {
    for (let i = 0; i < count; i++) {
      const p = this.fx.spawn(FX_BUBBLE, this.tex.bubble, x, y, this.rand(360, 560));
      if (p === null) return;
      const a = this.random() * TAU;
      const d = Math.sqrt(this.random()) * spread;
      p.sprite.x += Math.cos(a) * d;
      p.sprite.y += Math.sin(a) * d;
      p.vx = this.rand(-20, 20);
      p.vy = -this.rand(30, 70);
      p.drag = 0.8;
      const s = this.rand(12, 20) / BUBBLE_SIZE;
      p.scale0 = s * 0.6;
      p.scale1 = s * 1.3;
      p.color0 = mixColor(color, 0xffffff, 0.35);
      p.color1 = color;
      p.alpha0 = 0.9;
      p.fadeFrom = 0.6;
    }
  }

  /** 刃翼's cut: two thin bright strokes crossing on the target, one near the drone's line. */
  private cut(x: number, y: number, angle: number, radius: number, color: number): void {
    // A streak's length is its scale × (1 + speed × stretch): crawling at CUT_SPEED along
    // itself, it is CUT_WIDTH tall and radius × 2.4 long.
    const scale = CUT_WIDTH / STREAK_HEIGHT;
    const stretch = ((radius * 2.4) / (STREAK_LENGTH * scale) - 1) / CUT_SPEED;
    for (let k = 0; k < 2; k++) {
      const p = this.fx.spawn(FX_SPARK, this.tex.streak, x, y, 160);
      if (p === null) return;
      const a = angle + (k === 0 ? 0.35 : -0.95);
      p.sprite.rotation = a;
      p.vx = Math.cos(a) * CUT_SPEED;
      p.vy = Math.sin(a) * CUT_SPEED;
      p.orient = true;
      p.scale0 = scale;
      p.scale1 = scale * 0.5;
      p.stretch = Math.max(0, stretch);
      p.color0 = 0xffffff;
      p.color1 = color;
      p.alpha0 = 0.95;
      p.fadeFrom = 0.25;
    }
  }

  private glow(
    group: FxGroup,
    x: number,
    y: number,
    diameter: number,
    color0: number,
    color1: number,
    alpha: number,
    lifeMs: number,
  ): void {
    const p = this.fx.spawn(group, this.tex.glow, x, y, lifeMs);
    if (p === null) return;
    const s = diameter / GLOW_SIZE;
    p.scale0 = s * 0.7;
    p.scale1 = s * 1.2;
    p.color0 = color0;
    p.color1 = color1;
    p.alpha0 = alpha;
  }

  private rand(min: number, max: number): number {
    return min + this.random() * (max - min);
  }
}
