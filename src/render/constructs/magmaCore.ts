/**
 * 熔核 Magma Core (docs/v3/game-design-v3.md §11.3): a solid diamond hearth core inside six
 * semi-transparent trapezoid hearth plates. Idle: the plates breathe and embers drift up.
 * Attack: the plates facing the target swing open like furnace doors, a flare escapes through
 * the gap, and the core flashes white.
 */

import { Container, Graphics } from 'pixi.js';
import { CONSTRUCT_COLORS } from '../palette';
import {
  HitFlash,
  angleDistance,
  clampOffset,
  degrees,
  drawHalo,
  easeInOutCubic,
  easeOutCubic,
  falloff,
  hash01,
  wrapAngle,
} from './shared';
import type { ConstructView, Vec } from './shared';

const C = CONSTRUCT_COLORS.magmaCore;

export const PLATE_COUNT = 6;
/** Plate i points along PLATE_ANGLES[i]; a gap between two plates faces straight right. */
export const PLATE_ANGLES: readonly number[] = Array.from({ length: PLATE_COUNT }, (_, i) =>
  degrees(30 + 60 * i),
);
/** Plate edges as distances from the center, and the half-widths of their inner/outer sides. */
export const PLATE_INNER = 19;
export const PLATE_OUTER = 39;
const PLATE_INNER_HALF = 8;
const PLATE_OUTER_HALF = 17;
const PLATE_MID = (PLATE_INNER + PLATE_OUTER) / 2;
const CORE_HALF_WIDTH = 12;
const CORE_HALF_HEIGHT = 18;

/** Plates within OPEN_FULL of the target open all the way; none past OPEN_NONE. */
const OPEN_FULL = degrees(40);
const OPEN_NONE = degrees(90);
/** A fully open plate slides out, parts sideways off the firing line, and turns on its hinge. */
const OPEN_SLIDE = 10;
const OPEN_PART = 5;
const OPEN_HINGE = 0.45;
/** Flare plumes through the open plates: length, half-width, color, alpha. */
const FLARE_PLUMES: readonly (readonly [number, number, number, number])[] = [
  [58, 17, C.main, 0.12],
  [50, 12, C.main, 0.18],
  [42, 8, C.coreMid, 0.3],
  [32, 4, C.coreHot, 0.45],
];

const BREATH_MS = 2600;
const BREATH_SLIDE = 1.6;

/** Attack timeline: snap open, hold, ease shut; the core flash is over sooner. */
export const ATTACK_MS = 460;
const OPEN_MS = 70;
const HOLD_MS = 220;
const FLASH_MS = 200;
/** The body leans back from the throw by this much at full opening. */
const RECOIL = 3;

const EMBERS = 9;
const EMBER_MS = 1700;
const EMBER_RISE = 46;

/** How far the plate along `plateAngle` opens for an attack toward `target`, 0 to 1. */
export function plateOpening(plateAngle: number, target: number): number {
  return falloff(angleDistance(plateAngle, target), OPEN_FULL, OPEN_NONE);
}

export interface PlatePose extends Vec {
  /** Hinge turn on top of the plate's own angle. */
  readonly rotation: number;
}

/**
 * A plate's offset from its rest place and its hinge turn. It slides out by `breath` plus its
 * opening `open`; an opening plate also parts sideways away from the firing line and swings its
 * near edge outward, so two plates either side of the target open like a pair of doors.
 */
export function platePose(
  plateAngle: number,
  target: number,
  open: number,
  breath: number,
): PlatePose {
  const side = Math.sign(wrapAngle(plateAngle - target));
  const radial = breath + OPEN_SLIDE * open;
  const sideways = side * OPEN_PART * open;
  const cos = Math.cos(plateAngle);
  const sin = Math.sin(plateAngle);
  const offset = clampOffset(cos * radial - sin * sideways, sin * radial + cos * sideways);
  return { x: offset.x, y: offset.y, rotation: side * OPEN_HINGE * open };
}

/** Opening over an attack's age: snaps open, holds, then eases shut; 0 outside the attack. */
export function attackOpening(ageMs: number): number {
  if (ageMs < 0 || ageMs >= ATTACK_MS) return 0;
  if (ageMs < OPEN_MS) return easeOutCubic(ageMs / OPEN_MS);
  if (ageMs < HOLD_MS) return 1;
  return 1 - easeInOutCubic((ageMs - HOLD_MS) / (ATTACK_MS - HOLD_MS));
}

export interface Ember extends Vec {
  readonly alpha: number;
  readonly size: number;
}

/** Ember `k` at `timeMs`: rises from the core with a little sway, fading in and out. */
export function ember(k: number, timeMs: number): Ember {
  const t = timeMs + (k * EMBER_MS) / EMBERS;
  const life = Math.floor(t / EMBER_MS);
  const p = t / EMBER_MS - life;
  const seed = k * 977 + life;
  const sway = Math.sin(p * Math.PI * 2 * (0.6 + hash01(seed, 2))) * 4;
  return {
    x: (hash01(seed, 1) * 2 - 1) * 14 + sway,
    y: -6 - p * EMBER_RISE * (0.7 + 0.3 * hash01(seed, 3)),
    alpha: Math.sin(Math.PI * p) * (0.5 + 0.5 * hash01(seed, 4)),
    size: 1.2 + 1.4 * hash01(seed, 5) * (1 - p),
  };
}

export class MagmaCoreView implements ConstructView {
  readonly view = new Container({ label: 'construct-magmaCore' });
  /** Animated part of the construct: recoil and hit flash move and tint this, not `view`. */
  private readonly body = new Container();
  private readonly halo = new Graphics();
  private readonly hearth = new Graphics();
  private readonly flare = new Graphics();
  private readonly plates: Container[] = [];
  private readonly vents: Graphics[] = [];
  private readonly coreFlash = new Graphics();
  private readonly embers = new Graphics();
  private readonly hitFlash = new HitFlash();
  private timeMs = 0;
  /** Age of the running attack, or -1. */
  private attackMs = -1;
  private target = 0;

  constructor() {
    this.view.addChild(this.body);
    drawHalo(this.halo, 50, C.main, 0.2);

    // Hearth glow behind the plates; its edges line up with them.
    this.hearth
      .regularPoly(0, 0, 30, 6, Math.PI / 6)
      .fill({ color: C.main, alpha: 0.22 })
      .regularPoly(0, 0, 22, 6, Math.PI / 6)
      .fill({ color: C.coreMid, alpha: 0.18 });
    this.hearth.blendMode = 'add';

    // Heat escaping through the open plates, pointing +x; turned toward the target. Nested
    // plumes, hottest and shortest innermost.
    for (const [length, width, color, alpha] of FLARE_PLUMES) {
      this.flare
        .poly([
          10,
          -width * 0.35,
          length * 0.62,
          -width,
          length,
          0,
          length * 0.62,
          width,
          10,
          width * 0.35,
        ])
        .fill({ color, alpha });
    }
    this.flare.blendMode = 'add';
    this.flare.alpha = 0;

    this.body.addChild(this.halo, this.hearth, this.flare);
    const hi = PLATE_OUTER - PLATE_MID;
    const lo = PLATE_INNER - PLATE_MID;
    for (let i = 0; i < PLATE_COUNT; i++) {
      // Drawn pointing +x around the plate's middle, so it turns on its own center.
      const plate = new Container({ label: `plate-${i}` });
      const shape = new Graphics()
        .poly([
          lo,
          -PLATE_INNER_HALF,
          hi,
          -PLATE_OUTER_HALF,
          hi,
          PLATE_OUTER_HALF,
          lo,
          PLATE_INNER_HALF,
        ])
        .fill({ color: C.plate, alpha: 0.72 })
        .stroke({ width: 1.6, color: C.plateEdge, alpha: 1, join: 'round' });
      const vent = new Graphics()
        .moveTo(1, -6.5)
        .lineTo(1, 6.5)
        .stroke({ width: 4, color: C.main, alpha: 0.35, cap: 'round' })
        .moveTo(1, -6.5)
        .lineTo(1, 6.5)
        .stroke({ width: 1.6, color: C.vent, alpha: 1, cap: 'round' });
      vent.blendMode = 'add';
      plate.addChild(shape, vent);
      this.plates.push(plate);
      this.vents.push(vent);
      this.body.addChild(plate);
    }

    const core = new Graphics();
    const diamond = (k: number): number[] => [
      0,
      -CORE_HALF_HEIGHT * k,
      CORE_HALF_WIDTH * k,
      0,
      0,
      CORE_HALF_HEIGHT * k,
      -CORE_HALF_WIDTH * k,
      0,
    ];
    core
      .poly(diamond(1))
      .fill({ color: C.main, alpha: 1 })
      .stroke({ width: 1.4, color: C.coreEdge, alpha: 1, join: 'miter' })
      .poly(diamond(0.68))
      .fill({ color: C.coreMid, alpha: 1 })
      .poly(diamond(0.36))
      .fill({ color: C.coreHot, alpha: 1 });
    this.coreFlash.poly(diamond(1.08)).fill({ color: 0xffffff, alpha: 1 });
    this.coreFlash.alpha = 0;
    this.embers.blendMode = 'add';
    this.body.addChild(core, this.coreFlash, this.embers);
    this.update(0);
  }

  attack(angle: number): void {
    this.target = angle;
    this.attackMs = 0;
  }

  hit(): void {
    this.hitFlash.trigger();
  }

  reset(): void {
    this.attackMs = -1;
    this.hitFlash.reset();
    this.update(0);
  }

  update(dtMs: number): void {
    this.timeMs += dtMs;
    if (this.attackMs >= 0) {
      this.attackMs += dtMs;
      if (this.attackMs >= ATTACK_MS) this.attackMs = -1;
    }
    const open = this.attackMs >= 0 ? attackOpening(this.attackMs) : 0;
    const flash = this.attackMs >= 0 ? Math.max(0, 1 - this.attackMs / FLASH_MS) : 0;
    const wave = Math.sin((this.timeMs / BREATH_MS) * 2 * Math.PI);
    const breath = BREATH_SLIDE * wave;

    for (let i = 0; i < PLATE_COUNT; i++) {
      const angle = PLATE_ANGLES[i] as number;
      const o = open * plateOpening(angle, this.target);
      const pose = platePose(angle, this.target, o, breath);
      const plate = this.plates[i] as Container;
      plate.position.set(
        Math.cos(angle) * PLATE_MID + pose.x,
        Math.sin(angle) * PLATE_MID + pose.y,
      );
      plate.rotation = angle + pose.rotation;
      (this.vents[i] as Graphics).alpha = Math.min(1, 0.55 + 0.2 * wave + 0.6 * o);
    }

    this.halo.alpha = 0.85 + 0.15 * wave + 0.5 * flash;
    this.halo.scale.set(1 + 0.03 * wave + 0.08 * flash);
    this.hearth.alpha = 0.8 + 0.2 * wave + 0.4 * open;
    this.flare.rotation = this.target;
    this.flare.alpha = open;
    this.flare.visible = open > 0;
    this.coreFlash.alpha = flash;
    const recoil = clampOffset(
      -Math.cos(this.target) * RECOIL * open,
      -Math.sin(this.target) * RECOIL * open,
    );
    this.body.position.set(recoil.x, recoil.y);

    const g = this.embers;
    g.clear();
    for (let k = 0; k < EMBERS; k++) {
      const e = ember(k, this.timeMs);
      if (e.alpha <= 0.01) continue;
      g.circle(e.x, e.y, e.size * 1.8).fill({ color: C.ember, alpha: e.alpha * 0.35 });
      g.circle(e.x, e.y, e.size).fill({ color: C.ember, alpha: e.alpha });
    }

    this.hitFlash.apply(this.body, dtMs);
  }
}
