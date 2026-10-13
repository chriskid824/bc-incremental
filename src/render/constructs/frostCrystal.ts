/**
 * 霜晶 Frost Crystal (docs/v3/game-design-v3.md §11.3): a solid white pentagon core with seven
 * asymmetric, semi-transparent triangular ice spikes of different lengths. Idle: the crystal
 * turns slowly and the spikes take turns stretching out. Attack: the spikes facing the target
 * shoot off toward it and their stubs grow back within 0.3 s.
 */

import { Container, Graphics } from 'pixi.js';
import { CONSTRUCT_COLORS } from '../palette';
import {
  HitFlash,
  MAX_PART_OFFSET,
  angleDistance,
  clamp01,
  clampOffset,
  degrees,
  drawHalo,
  easeOutCubic,
  wrapAngle,
} from './shared';
import type { ConstructView, Vec } from './shared';

const C = CONSTRUCT_COLORS.frostCrystal;

export interface Spike {
  /** Direction at rest, before the crystal's spin. */
  readonly angle: number;
  readonly length: number;
  readonly halfWidth: number;
}

/** Laid out after docs/v3/characters-v3.svg: uneven gaps and lengths, no symmetry. */
export const SPIKES: readonly Spike[] = [
  { angle: degrees(-96), length: 48, halfWidth: 8 },
  { angle: degrees(-32), length: 30, halfWidth: 7 },
  { angle: degrees(18), length: 42, halfWidth: 8 },
  { angle: degrees(84), length: 27, halfWidth: 7 },
  { angle: degrees(136), length: 46, halfWidth: 8 },
  { angle: degrees(-164), length: 33, halfWidth: 7 },
  { angle: degrees(-116), length: 21, halfWidth: 6 },
];

/** Spikes start a little behind the center so their roots meet under the core. */
const SPIKE_ROOT = -3;
/** Irregular pentagon core, after the drawing (x, y pairs). */
const CORE = [-6, -9, 7.5, -7.5, 10, 4, 1, 10, -9, 5];

/** Slow idle turn: one revolution in about 22 s. */
const SPIN_PER_MS = (2 * Math.PI) / 22_000;
/** Each spike stretches by up to STRETCH in turn, one after another around the crystal. */
const STRETCH_MS = 2800;
const STRETCH = 0.15;
const STRETCH_SHARE = 0.3;

/** Spikes within FIRE_ARC of the target fire; if none, the nearest one does. */
export const FIRE_ARC = degrees(50);
/** A fired spike flies MAX_PART_OFFSET out and fades; its stub regrows by REGROW_MS (§11.3). */
const FLIGHT_MS = 160;
const TRAIL = 30;
const FADE_FROM_MS = 70;
const REGROW_DELAY_MS = 30;
export const REGROW_MS = 300;
/** Core and halo brighten on a volley, fading over this long. */
const GLINT_MS = 180;

/** Indices of the spikes that fire toward `target` while the crystal has turned by `spin`. */
export function firingSpikes(spin: number, target: number): number[] {
  const fired: number[] = [];
  let nearest = 0;
  let nearestDistance = Infinity;
  for (let i = 0; i < SPIKES.length; i++) {
    const d = angleDistance((SPIKES[i] as Spike).angle + spin, target);
    if (d <= FIRE_ARC) fired.push(i);
    if (d < nearestDistance) {
      nearestDistance = d;
      nearest = i;
    }
  }
  return fired.length > 0 ? fired : [nearest];
}

/** Length factor of spike `i` while idle: each spike in turn stretches out and back. */
export function idleStretch(i: number, timeMs: number): number {
  const p = timeMs / STRETCH_MS - i / SPIKES.length;
  const phase = p - Math.floor(p);
  return phase < STRETCH_SHARE ? 1 + STRETCH * Math.sin((Math.PI * phase) / STRETCH_SHARE) : 1;
}

/** Length factor of a fired spike's stub `ageMs` after it fired: gone, then grown back. */
export function regrowth(ageMs: number): number {
  if (ageMs < REGROW_DELAY_MS) return 0;
  return easeOutCubic((ageMs - REGROW_DELAY_MS) / (REGROW_MS - REGROW_DELAY_MS));
}

export interface ShardPose extends Vec {
  readonly rotation: number;
  readonly alpha: number;
}

/**
 * A fired spike `ageMs` into its flight: it leaves from its own direction `from`, turns toward
 * `target` and slides out along it by up to MAX_PART_OFFSET, fading as the projectile takes over.
 */
export function shardFlight(ageMs: number, from: number, target: number): ShardPose {
  const t = easeOutCubic(ageMs / FLIGHT_MS);
  const offset = clampOffset(
    Math.cos(target) * MAX_PART_OFFSET * t,
    Math.sin(target) * MAX_PART_OFFSET * t,
  );
  return {
    x: offset.x,
    y: offset.y,
    rotation: from + wrapAngle(target - from) * clamp01(ageMs / (FLIGHT_MS * 0.6)),
    alpha: 1 - clamp01((ageMs - FADE_FROM_MS) / (FLIGHT_MS - FADE_FROM_MS)),
  };
}

/** Draws a spike pointing +x from its root: a shaded triangle with a lit facet and white edges. */
function drawSpike(g: Graphics, spike: Spike): Graphics {
  const { length, halfWidth: w } = spike;
  const outline = [SPIKE_ROOT, -w, length, 0, SPIKE_ROOT, w];
  // The crease runs from the tip to a point near the root, just past the axis, so the lit
  // facet is a little more than half the spike.
  const crease = [length * 0.3, w * 0.12];
  return g
    .poly(outline)
    .fill({ color: C.facetDark, alpha: 0.72 })
    .poly([SPIKE_ROOT, -w, length, 0, ...crease])
    .fill({ color: C.facetLight, alpha: 0.88 })
    .poly(outline)
    .stroke({ width: 1.3, color: C.edge, alpha: 0.95, join: 'miter' });
}

interface Shot {
  ageMs: number;
  from: number;
  target: number;
}

export class FrostCrystalView implements ConstructView {
  readonly view = new Container({ label: 'construct-frostCrystal' });
  /** Animated part of the construct: the hit flash tints and swells this, not `view`. */
  private readonly body = new Container();
  private readonly halo = new Graphics();
  /** Turns with the idle spin; holds the spikes. */
  private readonly crystal = new Container();
  private readonly spikes: Graphics[] = [];
  /** Fired copies of the spikes, in body space so they can fly toward the target. */
  private readonly shards: Container[] = [];
  private readonly shots: (Shot | null)[] = SPIKES.map(() => null);
  private readonly glint = new Graphics();
  private readonly hitFlash = new HitFlash();
  private timeMs = 0;
  private glintMs = GLINT_MS;

  constructor() {
    this.view.addChild(this.body);
    drawHalo(this.halo, 46, C.main, 0.2);
    this.body.addChild(this.halo, this.crystal);
    for (const spike of SPIKES) {
      const g = drawSpike(new Graphics(), spike);
      g.rotation = spike.angle;
      this.spikes.push(g);
      this.crystal.addChild(g);
      // A fired spike trails a streak back toward the crystal.
      const trail = new Graphics()
        .poly([
          SPIKE_ROOT - TRAIL,
          0,
          SPIKE_ROOT,
          -spike.halfWidth * 0.5,
          SPIKE_ROOT,
          spike.halfWidth * 0.5,
        ])
        .fill({ color: C.main, alpha: 0.45 });
      trail.blendMode = 'add';
      const shard = new Container({ label: 'shard' });
      shard.addChild(trail, drawSpike(new Graphics(), spike));
      shard.visible = false;
      this.shards.push(shard);
      this.body.addChild(shard);
    }
    const core = new Graphics().poly(CORE).fill({ color: C.core, alpha: 1 });
    // Faint facet lines from the middle to each corner.
    for (let i = 0; i < CORE.length; i += 2) {
      core.moveTo(0.5, 0).lineTo(CORE[i] as number, CORE[i + 1] as number);
    }
    core
      .stroke({ width: 1, color: C.main, alpha: 0.55 })
      .poly(CORE)
      .stroke({ width: 1.6, color: C.main, alpha: 1, join: 'miter' });
    this.crystal.addChild(core);
    drawHalo(this.glint, 20, C.facetLight, 0.6);
    this.glint.alpha = 0;
    this.body.addChild(this.glint);
    this.update(0);
  }

  attack(angle: number): void {
    const spin = this.crystal.rotation;
    for (const i of firingSpikes(spin, angle)) {
      this.shots[i] = { ageMs: 0, from: (SPIKES[i] as Spike).angle + spin, target: angle };
    }
    this.glintMs = 0;
  }

  hit(): void {
    this.hitFlash.trigger();
  }

  reset(): void {
    this.shots.fill(null);
    this.glintMs = GLINT_MS;
    this.hitFlash.reset();
    this.update(0);
  }

  update(dtMs: number): void {
    this.timeMs += dtMs;
    this.glintMs = Math.min(GLINT_MS, this.glintMs + dtMs);
    this.crystal.rotation = wrapAngle(this.timeMs * SPIN_PER_MS);
    for (let i = 0; i < SPIKES.length; i++) {
      const spike = this.spikes[i] as Graphics;
      const shard = this.shards[i] as Container;
      let length = idleStretch(i, this.timeMs);
      const shot = this.shots[i];
      if (shot !== null && shot !== undefined) {
        shot.ageMs += dtMs;
        length *= regrowth(shot.ageMs);
        const pose = shardFlight(shot.ageMs, shot.from, shot.target);
        shard.visible = pose.alpha > 0;
        shard.position.set(pose.x, pose.y);
        shard.rotation = pose.rotation;
        shard.alpha = pose.alpha;
        if (shot.ageMs >= Math.max(REGROW_MS, FLIGHT_MS)) {
          this.shots[i] = null;
          shard.visible = false;
        }
      }
      spike.visible = length > 0.02;
      spike.scale.set(length, 1);
    }
    const glint = 1 - this.glintMs / GLINT_MS;
    this.glint.alpha = glint;
    this.halo.alpha = 0.9 + 0.1 * Math.sin(this.timeMs * 0.0021) + 0.6 * glint;
    this.hitFlash.apply(this.body, dtMs);
  }
}
