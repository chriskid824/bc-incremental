/**
 * 雷塔 Tesla Tower (docs/v3/game-design-v3.md §11.3): no body, only three upright coils with
 * white tips on a radius-40 triangle, linked by violet arcs with white cores. Idle: the arcs
 * flicker faintly and flash at irregular times. Attack: the coil nearest the target discharges
 * toward it, every arc flares, and the formation turns 120° so the next coil comes round.
 */

import { Container, Graphics } from 'pixi.js';
import { CONSTRUCT_COLORS } from '../palette';
import {
  HitFlash,
  angleDistance,
  clamp01,
  degrees,
  drawHalo,
  easeInOutCubic,
  hash01,
  zigzag,
} from './shared';
import type { ConstructView, Vec } from './shared';

const C = CONSTRUCT_COLORS.teslaTower;

export const COIL_COUNT = 3;
/** Coil tips sit on a triangle of this radius around the center (§11.3). */
export const FORMATION_RADIUS = 40;
const STEP = (2 * Math.PI) / COIL_COUNT;

/** The discharge spark reaches this far from the firing tip toward the target. */
export const SPARK_LENGTH = 36;
/** Attack timeline: tip flare and spark, then the 120° turn. */
const DISCHARGE_MS = 180;
const SURGE_MS = 150;
const TURN_DELAY_MS = 50;
const TURN_MS = 300;
export const ATTACK_MS = TURN_DELAY_MS + TURN_MS;

/** Idle arcs: a faint standing link, plus a flash in some of these slots. */
const ARC_BASE = 0.26;
const FLASH_SLOT_MS = 520;
const FLASH_MS = 140;
const FLASH_CHANCE = 0.6;
/** Bolts re-roll their zigzag this often. */
const REJITTER_MS = 45;

/** Coil body, measured down from the tip (the discharge point) in arena units. */
const TIP_HALF_WIDTH = 4.9;
const TIP_HALF_HEIGHT = 6.5;
const POST_TOP = 3;
const POST_BOTTOM = 32;
const POST_HALF_WIDTH = 4.3;
const RING_YS = [5.6, 11.2, 16.8, 22.5, 28.1];
const RING_RX = 8.1;
const RING_RY = 2.3;
const RING_TILT = degrees(-10);
const BASE_Y = 32.4;
const BASE_HALF_WIDTH = 8.4;
const BASE_HALF_HEIGHT = 4.4;

/** Angle of coil `i` around the center when the formation has turned by `turn`. */
export function coilAngle(i: number, turn: number): number {
  return degrees(-90) + STEP * i + turn;
}

/** Tip positions of the three coils. */
export function coilTips(turn: number): Vec[] {
  return Array.from({ length: COIL_COUNT }, (_, i) => {
    const a = coilAngle(i, turn);
    return { x: Math.cos(a) * FORMATION_RADIUS, y: Math.sin(a) * FORMATION_RADIUS };
  });
}

/** The coil facing `target`: the one whose turn it is to discharge. */
export function nearestCoil(turn: number, target: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < COIL_COUNT; i++) {
    const d = angleDistance(coilAngle(i, turn), target);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

/** Share of the 120° turn done `ageMs` into an attack, 0 to 1. */
export function turnProgress(ageMs: number): number {
  return easeInOutCubic((ageMs - TURN_DELAY_MS) / TURN_MS);
}

/** Brightness of idle arc `pair` at `timeMs`: ARC_BASE, or up to 1 while it flashes. */
export function arcBrightness(pair: number, timeMs: number): number {
  const shifted = timeMs + pair * 173;
  const slot = Math.floor(shifted / FLASH_SLOT_MS);
  if (hash01(slot, pair) >= FLASH_CHANCE) return ARC_BASE;
  const start = hash01(slot, pair + 11) * (FLASH_SLOT_MS - FLASH_MS);
  const at = shifted - slot * FLASH_SLOT_MS - start;
  if (at < 0 || at >= FLASH_MS) return ARC_BASE;
  return Math.max(ARC_BASE, 1 - 0.5 * (at / FLASH_MS));
}

/** Tilted ring around a coil post, as a closed polygon. */
function ring(y: number): number[] {
  const points: number[] = [];
  const cos = Math.cos(RING_TILT);
  const sin = Math.sin(RING_TILT);
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * 2 * Math.PI;
    const x = Math.cos(a) * RING_RX;
    const ry = Math.sin(a) * RING_RY;
    points.push(x * cos - ry * sin, y + x * sin + ry * cos);
  }
  return points;
}

/** Layered bolt: wide violet glow, violet body, white core (the M1 arc look, in violet). */
function drawBolt(g: Graphics, points: number[], width: number, alpha: number): void {
  g.poly(points, false).stroke({ width: 9 * width, color: C.main, alpha: 0.16 * alpha });
  g.poly(points, false).stroke({ width: 4.2 * width, color: C.main, alpha: 0.6 * alpha });
  g.poly(points, false).stroke({ width: 1.6 * width, color: C.core, alpha });
}

interface Coil {
  readonly root: Container;
  readonly flare: Graphics;
  readonly hotRings: Graphics;
}

export class TeslaTowerView implements ConstructView {
  readonly view = new Container({ label: 'construct-teslaTower' });
  /** Animated part of the construct: the hit flash tints and swells this, not `view`. */
  private readonly body = new Container();
  private readonly arcs = new Graphics();
  private readonly coils: Coil[] = [];
  private readonly hitFlash = new HitFlash();
  private timeMs = 0;
  /** Settled formation turn; an attack turns it by another STEP. */
  private turn = 0;
  /** Age of the running attack, or -1. */
  private attackMs = -1;
  private firing = 0;
  private target = 0;

  constructor() {
    this.view.addChild(this.body);
    this.arcs.blendMode = 'add';
    // Coils lower on screen draw over higher ones; the arcs run behind them, tip to tip.
    this.body.sortableChildren = true;
    this.arcs.zIndex = -FORMATION_RADIUS * 2;
    for (let i = 0; i < COIL_COUNT; i++) this.coils.push(this.createCoil(i));
    this.body.addChild(...this.coils.map((coil) => coil.root), this.arcs);
    this.update(0);
  }

  attack(angle: number): void {
    // A new attack mid-turn finishes the old turn first.
    if (this.attackMs >= 0) this.turn = (this.turn + STEP) % (2 * Math.PI);
    this.firing = nearestCoil(this.turn, angle);
    this.target = angle;
    this.attackMs = 0;
  }

  hit(): void {
    this.hitFlash.trigger();
  }

  reset(): void {
    this.turn = 0;
    this.attackMs = -1;
    this.hitFlash.reset();
    this.update(0);
  }

  update(dtMs: number): void {
    this.timeMs += dtMs;
    let turn = this.turn;
    let discharge = 0;
    let surge = 0;
    if (this.attackMs >= 0) {
      this.attackMs += dtMs;
      if (this.attackMs >= ATTACK_MS) {
        this.turn = (this.turn + STEP) % (2 * Math.PI);
        this.attackMs = -1;
        turn = this.turn;
      } else {
        turn += STEP * turnProgress(this.attackMs);
        discharge = 1 - clamp01(this.attackMs / DISCHARGE_MS);
        surge = 1 - clamp01(this.attackMs / SURGE_MS);
      }
    }

    const tips = coilTips(turn);
    for (let i = 0; i < COIL_COUNT; i++) {
      const coil = this.coils[i] as Coil;
      const tip = tips[i] as Vec;
      coil.root.position.set(tip.x, tip.y);
      coil.root.zIndex = tip.y;
      const hot = i === this.firing ? discharge : 0;
      coil.flare.alpha = 0.45 + 0.1 * Math.sin(this.timeMs * 0.006 + i * 2) + hot;
      coil.flare.scale.set(1 + 0.8 * hot);
      coil.hotRings.alpha = Math.max(hot, 0.4 * surge);
    }

    const g = this.arcs;
    g.clear();
    const roll = Math.floor(this.timeMs / REJITTER_MS);
    for (let pair = 0; pair < COIL_COUNT; pair++) {
      const a = tips[pair] as Vec;
      const b = tips[(pair + 1) % COIL_COUNT] as Vec;
      const bright = Math.max(arcBrightness(pair, this.timeMs), surge);
      const points = zigzag(a.x, a.y, b.x, b.y, 9, 7, roll * 7 + pair);
      drawBolt(g, points, bright > ARC_BASE ? 1 : 0.7, bright);
    }
    if (discharge > 0) {
      const from = tips[this.firing] as Vec;
      const to = {
        x: from.x + Math.cos(this.target) * SPARK_LENGTH,
        y: from.y + Math.sin(this.target) * SPARK_LENGTH,
      };
      drawBolt(g, zigzag(from.x, from.y, to.x, to.y, 5, 6, roll * 7 + 5), 1.2, discharge);
    }

    this.hitFlash.apply(this.body, dtMs);
  }

  /** One coil, drawn upright below its tip at (0, 0). */
  private createCoil(i: number): Coil {
    const root = new Container({ label: `coil-${i}` });
    const flare = drawHalo(new Graphics(), 15, C.main, 0.7);
    const base = new Graphics()
      .poly([
        BASE_HALF_WIDTH,
        BASE_Y - BASE_HALF_HEIGHT / 2,
        0,
        BASE_Y - BASE_HALF_HEIGHT,
        -BASE_HALF_WIDTH,
        BASE_Y - BASE_HALF_HEIGHT / 2,
        -BASE_HALF_WIDTH,
        BASE_Y + BASE_HALF_HEIGHT / 2,
        0,
        BASE_Y + BASE_HALF_HEIGHT,
        BASE_HALF_WIDTH,
        BASE_Y + BASE_HALF_HEIGHT / 2,
      ])
      .fill({ color: C.base, alpha: 0.75 })
      .stroke({ width: 1.3, color: C.baseEdge, alpha: 1 });
    const post = new Graphics()
      .roundRect(-POST_HALF_WIDTH, POST_TOP, POST_HALF_WIDTH * 2, POST_BOTTOM - POST_TOP, 2)
      .fill({ color: C.post, alpha: 0.75 })
      .stroke({ width: 1.1, color: C.postEdge, alpha: 1 });
    const rings = new Graphics();
    const hotRings = new Graphics();
    for (const y of RING_YS) {
      rings.poly(ring(y)).stroke({ width: 1.9, color: C.main, alpha: 1 });
      hotRings.poly(ring(y)).stroke({ width: 2.2, color: C.core, alpha: 0.9 });
    }
    hotRings.blendMode = 'add';
    hotRings.alpha = 0;
    const tip = new Graphics()
      .poly([0, -TIP_HALF_HEIGHT, TIP_HALF_WIDTH, 0, 0, TIP_HALF_HEIGHT, -TIP_HALF_WIDTH, 0])
      .fill({ color: C.core, alpha: 1 })
      .stroke({ width: 1.1, color: C.main, alpha: 1, join: 'miter' });
    root.addChild(base, post, rings, hotRings, flare, tip);
    return { root, flare, hotRings };
  }
}
