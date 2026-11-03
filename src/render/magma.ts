/**
 * 熔核's attack language (docs/v3/game-design-v3.md §1.2, §11.4) and the fusion looks that ride on
 * it (§5.2, §5.4): slow, big and round.
 *
 * - The magma bomb in flight, read from the shot pool's lobbed shots (ShotPoolState: the launch
 *   point in vx/vy, the landing point in x/y, the landing tick in until): a glowing ball on a
 *   parabola over its BOMB_FLIGHT_TICKS, its shadow on the floor growing and darkening as it
 *   falls, and a faint ring where it will land. A 火山 giant bomb (form LOB_VOLCANO) is bigger.
 * - The explosion ('explosion'): a white-hot flash, an orange ring out to its radius, embers
 *   thrown up and falling, and a scorch mark on the floor that stays until the wave is cleared.
 *   霜焰 (火冰, the 'ice' fusion) adds a white-blue frost ring outside the orange one.
 * - The fire zone (火地), read from the zone pool: a glowing patch of ground that fades in, burns
 *   with a flicker, flares on each pulse that hit something ('pulse' of kind 'zone') and fades
 *   out by its expiry; under 霜焰 its edge is frosted.
 * - 火毒 瘟爆: an explosion that poisoned an enemy (an 'ailmentApplied' poison in the same tick on
 *   an enemy inside it) bubbles green in the poison skin's accent (shape 'bubble'); a poison
 *   spread ('ailmentSpread') pops a green ring.
 *
 * The sprites come from pools allocated up to their caps (MAX_BOMBS, MAX_ZONES, SCORCH_CAP) and
 * reused every frame; the bursts go through the renderer's capped FX and ring pools.
 */

import { Graphics } from 'pixi.js';
import type { ParticleContainer, Texture } from 'pixi.js';
import type { ShotPoolState, ZonePoolState } from '../sim';
import { hash01 } from './constructs/shared';
import { FX_BUBBLE, FX_FLAME, FX_FLASH, FX_SPARK, packColor } from './fx';
import type { FxGroup, FxParticles } from './fx';
import { COLORS, CONSTRUCT_COLORS, MAGMA_COLORS, mixColor } from './palette';
import { defaultRandom } from './random';
import type { RenderRandom } from './random';
import type { RingLayer } from './rings';
import { SpriteBatch } from './spriteBatch';

const C = CONSTRUCT_COLORS.magmaCore;
const M = MAGMA_COLORS;
const TAU = Math.PI * 2;

/** ShotPoolState.motion of a lobbed shot (MOTION_LOB, src/sim/systems/shots.ts). */
export const LOBBED = 2;
/** ShotPoolState.form of 火山's giant bomb (LOB_VOLCANO, src/sim/emitters/lob.ts). */
export const VOLCANO_FORM = 1;
/** magmaBomb's flightTicks (src/sim/rules/magmaBomb.ts): 0.4 s at 60 ticks a second. */
export const BOMB_FLIGHT_TICKS = 24;

/** The bomb's arc: its peak is this share of the throw's length, within [ARC_MIN, ARC_MAX]. */
const ARC_SHARE = 0.32;
const ARC_MIN = 60;
const ARC_MAX = 210;
/** Bomb sizes in arena units (diameters of the glow sprites), and a giant bomb's scale. */
const BOMB_HALO = 84;
const BOMB_CORE = 38;
const BOMB_HOT = 17;
const BOMB_TRAIL = 46;
const VOLCANO_SCALE = 2.2;
const SHADOW_SIZE = 46;
/** The landing marker: a ring of the bomb's blast radius (magmaBomb's 60). */
const LANDING_RADIUS = 60;

/** Texture sizes in pixels (src/render/fxTextures.ts). */
const GLOW_SIZE = 64;
const BUBBLE_SIZE = 32;
const STREAK_LENGTH = 64;
const STREAK_HEIGHT = 16;

/** Sprites per pool: the bombs and their shadows (4 a bomb), and the fire zones (3 a zone). */
const MAX_BOMBS = 48;
const MAX_ZONES = 80;
/** Scorch marks kept at once; a new one past this takes the oldest one's place. */
export const SCORCH_CAP = 40;
const SCORCH_SCALE = 1.5;
const SCORCH_ALPHA = 0.8;
/** A fresh scorch mark smoulders: a warm glow from SMOULDER_ALPHA down to EMBER_ALPHA. */
const SMOULDER_ALPHA = 0.3;
const EMBER_ALPHA = 0.07;
const SMOULDER_MS = 1600;
/** Floats a scorch mark keeps: x, y, size, rotation, age in ms. */
const SCORCH_STRIDE = 5;
/** Scorch marks fade over this once the wave is cleared. */
const SCORCH_FADE_MS = 900;

/** A zone fades in over this share of its life and out over the last ZONE_FADE_OUT of it. */
const ZONE_FADE_IN = 0.08;
const ZONE_FADE_OUT = 0.3;
/** A pulse that hit something flares its zone, decaying over this. */
const PULSE_FLARE_MS = 180;
const MAX_FLARES = 32;
/** 霜焰's frost crystals on a zone's edge. */
const FROST_TICKS = 10;

/** Embers an explosion throws, at blast radius 60; bigger blasts throw more, up to EMBER_MAX. */
const EMBERS = 8;
const EMBER_MAX = 18;
/** Bubbles a poisoned explosion raises. */
const BUBBLES = 10;
/** Explosions of a tick held for the poison check, and poisoned spots. */
const MAX_PENDING = 16;

/**
 * The effect sheet's frames the layer draws with (FxTextures, src/render/fxTextures.ts, which
 * needs the DOM, so it is not imported here).
 */
export interface MagmaTextures {
  readonly glow: Texture;
  readonly streak: Texture;
  readonly flame: Texture;
  readonly bubble: Texture;
}

export interface BombPose {
  /** Where its shadow is: along the line from the launch point to the landing point. */
  readonly groundX: number;
  readonly groundY: number;
  /** Its height above the shadow, in arena units (up is −y on screen). */
  readonly height: number;
}

/** Peak height of a throw `distance` long. */
export function arcHeight(distance: number): number {
  return Math.min(ARC_MAX, Math.max(ARC_MIN, distance * ARC_SHARE));
}

interface MutablePose {
  groundX: number;
  groundY: number;
  height: number;
}

/**
 * A bomb from (fromX, fromY) to (toX, toY) at flight progress `p` in [0, 1], a parabola, written
 * into `out` (the layer's scratch poses, so a frame allocates none).
 */
export function bombPoseInto(
  out: MutablePose,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  p: number,
): BombPose {
  const t = p <= 0 ? 0 : p >= 1 ? 1 : p;
  const dx = toX - fromX;
  const dy = toY - fromY;
  const peak = arcHeight(Math.sqrt(dx * dx + dy * dy));
  out.groundX = fromX + dx * t;
  out.groundY = fromY + dy * t;
  out.height = 4 * peak * t * (1 - t);
  return out;
}

/** bombPoseInto on a new pose. */
export function bombPose(fromX: number, fromY: number, toX: number, toY: number, p: number) {
  return bombPoseInto({ groundX: 0, groundY: 0, height: 0 }, fromX, fromY, toX, toY, p);
}

/**
 * Flight progress of a bomb landing at tick `until`, drawn at `alpha` between the sim's last
 * two ticks (`tick` the newer): 0 as it leaves, 1 as it lands.
 */
export function bombProgress(until: number, tick: number, alpha: number): number {
  const shown = tick - 1 + alpha;
  const p = 1 - (until - shown) / BOMB_FLIGHT_TICKS;
  return p <= 0 ? 0 : p >= 1 ? 1 : p;
}

/**
 * A zone's brightness over its life, `created` to `expiresAt`, at the shown tick: up over its
 * first ZONE_FADE_IN, full, down to 0 over its last ZONE_FADE_OUT.
 */
export function zoneFade(created: number, expiresAt: number, shown: number): number {
  const life = Math.max(1, expiresAt - created);
  const t = (shown - created) / life;
  if (t <= 0 || t >= 1) return 0;
  if (t < ZONE_FADE_IN) return t / ZONE_FADE_IN;
  if (t > 1 - ZONE_FADE_OUT) return (1 - t) / ZONE_FADE_OUT;
  return 1;
}

/** What the fusions add to 熔核's looks (RendererOptions.character's fusions). */
export interface MagmaLooks {
  /** 霜焰 (火冰): the frost ring on explosions and the frosted fire-zone edges. */
  readonly frost: boolean;
  /** The bubbles' colour: the poison skin's accent. */
  readonly poison: number;
}

export const DEFAULT_MAGMA_LOOKS: MagmaLooks = { frost: false, poison: 0x3fd08a };

/**
 * 熔核's bombs, explosions, fire zones and scorch marks. `ground` goes over the backdrop and
 * under the crowd (scorch marks, zones, shadows, landing rings); `air` over the crowd (bombs).
 */
export class MagmaLayer {
  private readonly scorch: SpriteBatch;
  /** The scorch marks' smoulder, additive over them. */
  private readonly smoulder: SpriteBatch;
  private readonly zoneGlow: SpriteBatch;
  private readonly shadows: SpriteBatch;
  private readonly bombs: SpriteBatch;
  /** Zone rims, 霜焰's frost and the landing rings: thin lines redrawn each frame. */
  readonly rims = new Graphics({ label: 'magma-rims' });
  private timeMs = 0;
  /** Scorch marks as a ring buffer of SCORCH_STRIDE floats each; `scorchNext` the next slot. */
  private readonly scorchData = new Float64Array(SCORCH_CAP * SCORCH_STRIDE);
  private scorchCount = 0;
  private scorchNext = 0;
  /** Ms the scorch marks have been fading for, or −1 while they hold. */
  private scorchFadeMs = -1;
  /** Zone flares: the zone ids and their remaining ms, a ring buffer. */
  private readonly flareIds = new Int32Array(MAX_FLARES).fill(-1);
  private readonly flareMs = new Float64Array(MAX_FLARES);
  private flareNext = 0;
  /** This tick's explosions (x, y, radius, poisoned) and poisoned spots (x, y). */
  private readonly pendingBlasts = new Float64Array(MAX_PENDING * 4);
  private pendingBlastCount = 0;
  private readonly poisonSpots = new Float64Array(MAX_PENDING * 2);
  private poisonSpotCount = 0;
  private readonly pose: MutablePose = { groundX: 0, groundY: 0, height: 0 };
  private readonly backPose: MutablePose = { groundX: 0, groundY: 0, height: 0 };

  constructor(
    private readonly tex: MagmaTextures,
    private readonly fx: FxParticles,
    private readonly rings: RingLayer,
    private readonly looks: MagmaLooks = DEFAULT_MAGMA_LOOKS,
    private readonly random: RenderRandom = defaultRandom,
  ) {
    this.scorch = new SpriteBatch('magma-scorch', tex.glow, 'normal', SCORCH_CAP);
    this.smoulder = new SpriteBatch('magma-smoulder', tex.glow, 'add', SCORCH_CAP);
    this.zoneGlow = new SpriteBatch('magma-zones', tex.glow, 'add', MAX_ZONES * 3);
    this.shadows = new SpriteBatch('magma-shadows', tex.glow, 'normal', MAX_BOMBS);
    this.bombs = new SpriteBatch('magma-bombs', tex.glow, 'add', MAX_BOMBS * 4);
    this.rims.blendMode = 'add';
  }

  /** The layers under the crowd, bottom first: scorch, smoulder, zones, rims, shadows. */
  get groundViews(): readonly (ParticleContainer | Graphics)[] {
    return [this.scorch.view, this.smoulder.view, this.zoneGlow.view, this.rims, this.shadows.view];
  }

  /** The bombs, over the crowd. */
  get airView(): ParticleContainer {
    return this.bombs.view;
  }

  /** Scorch marks on the floor now. */
  get scorchMarks(): number {
    return this.scorchCount;
  }

  /** Forgets every effect, as at the start of a run. */
  reset(): void {
    this.scorchCount = 0;
    this.scorchNext = 0;
    this.scorchFadeMs = -1;
    this.flareIds.fill(-1);
    this.flareMs.fill(0);
    this.flareNext = 0;
    this.pendingBlastCount = 0;
    this.poisonSpotCount = 0;
    this.scorch.clear();
    this.smoulder.clear();
    this.zoneGlow.clear();
    this.shadows.clear();
    this.bombs.clear();
    this.rims.clear();
  }

  /** The flicker clock back at zero, as a new layer has it (Renderer.restart). */
  rewind(): void {
    this.timeMs = 0;
  }

  /**
   * A bomb exploded at (x, y) over `radius`: flash, ring, embers and a scorch mark, and 霜焰's
   * frost ring. Held until flushTick for the poison check.
   */
  explosion(x: number, y: number, radius: number): void {
    this.blast(x, y, radius, true);
    if (this.pendingBlastCount < MAX_PENDING) {
      const at = this.pendingBlastCount++ * 4;
      this.pendingBlasts[at] = x;
      this.pendingBlasts[at + 1] = y;
      this.pendingBlasts[at + 2] = radius;
      this.pendingBlasts[at + 3] = 0;
    }
  }

  /**
   * An explode effect at (x, y) over `radius` ('burst' of kind 'explode': 連環爆's second blast,
   * a trigger's): an explosion without a scorch mark or the poison check.
   */
  smallBlast(x: number, y: number, radius: number): void {
    this.blast(x, y, radius, false);
  }

  /** An enemy drawn at (x, y) was poisoned this tick. */
  poisoned(x: number, y: number): void {
    if (this.poisonSpotCount >= MAX_PENDING) return;
    const at = this.poisonSpotCount++ * 2;
    this.poisonSpots[at] = x;
    this.poisonSpots[at + 1] = y;
  }

  /**
   * A poison spread from (x, y) over `radius` to `targets` enemies (瘟爆's 瘟疫爆彈): a green ring
   * and bubbles; none for a spread that reached no one, as a burn spread's nova.
   */
  poisonSpread(x: number, y: number, radius: number, targets: number): void {
    if (targets <= 0) return;
    this.rings.shock(x, y, radius, this.looks.poison, 4, 380);
    this.bubbles(x, y, radius * 0.5, 4);
  }

  /**
   * The tick's events are in: each explosion of it that poisoned an enemy inside it bubbles,
   * and each poisoned spot outside every explosion gets a bubble of its own.
   */
  flushTick(): void {
    for (let s = 0; s < this.poisonSpotCount; s++) {
      const px = this.poisonSpots[s * 2] as number;
      const py = this.poisonSpots[s * 2 + 1] as number;
      let inside = false;
      for (let b = 0; b < this.pendingBlastCount; b++) {
        const at = b * 4;
        const dx = px - (this.pendingBlasts[at] as number);
        const dy = py - (this.pendingBlasts[at + 1] as number);
        const r = (this.pendingBlasts[at + 2] as number) * 1.2;
        if (dx * dx + dy * dy <= r * r) {
          this.pendingBlasts[at + 3] = 1;
          inside = true;
        }
      }
      if (!inside) this.bubbles(px, py, 10, 1);
    }
    for (let b = 0; b < this.pendingBlastCount; b++) {
      const at = b * 4;
      if (this.pendingBlasts[at + 3] !== 1) continue;
      const x = this.pendingBlasts[at] as number;
      const y = this.pendingBlasts[at + 1] as number;
      const r = this.pendingBlasts[at + 2] as number;
      this.glow(FX_FLASH, x, y, r * 2.2, this.looks.poison, this.looks.poison, 0.35, 320);
      this.bubbles(x, y, r * 0.8, BUBBLES);
    }
    this.pendingBlastCount = 0;
    this.poisonSpotCount = 0;
  }

  /** The 火環 nova (the threshold's 'burst' at the player): a ring of fire out to `radius`. */
  thresholdNova(x: number, y: number, radius: number): void {
    this.rings.shock(x, y, radius, C.main, 16, 640, true);
    this.rings.shock(x, y, radius * 0.94, M.bombHot, 5, 520, true);
    this.glow(FX_FLASH, x, y, 220, M.bombHot, C.main, 0.8, 260);
  }

  /** A pulse of zone `id` hit something: the zone flares. */
  zonePulse(id: number): void {
    for (let i = 0; i < MAX_FLARES; i++) {
      if (this.flareIds[i] === id) {
        this.flareMs[i] = PULSE_FLARE_MS;
        return;
      }
    }
    this.flareIds[this.flareNext] = id;
    this.flareMs[this.flareNext] = PULSE_FLARE_MS;
    this.flareNext = (this.flareNext + 1) % MAX_FLARES;
  }

  /** The wave was cleared: its scorch marks fade out. */
  waveCleared(): void {
    if (this.scorchCount > 0 && this.scorchFadeMs < 0) this.scorchFadeMs = 0;
  }

  /**
   * Draws the bombs of the first `shotCount` shots and the zones of the first `zoneCount` zones
   * at `alpha` between the sim's last two ticks (`tick` the newer), `dtMs` after the last frame.
   */
  update(
    shots: Readonly<ShotPoolState>,
    shotCount: number,
    zones: Readonly<ZonePoolState>,
    zoneCount: number,
    tick: number,
    alpha: number,
    dtMs: number,
  ): void {
    this.timeMs += dtMs;
    for (let i = 0; i < MAX_FLARES; i++) {
      if ((this.flareMs[i] as number) > 0) {
        this.flareMs[i] = Math.max(0, (this.flareMs[i] as number) - dtMs);
      }
    }
    this.rims.clear();
    this.drawScorch(dtMs);
    this.drawZones(zones, zoneCount, tick - 1 + alpha);
    this.drawBombs(shots, shotCount, tick, alpha);
  }

  private drawScorch(dtMs: number): void {
    let fade = 1;
    if (this.scorchFadeMs >= 0) {
      this.scorchFadeMs += dtMs;
      fade = 1 - this.scorchFadeMs / SCORCH_FADE_MS;
      if (fade <= 0) {
        this.scorchCount = 0;
        this.scorchNext = 0;
        this.scorchFadeMs = -1;
      }
    }
    const batch = this.scorch;
    const warm = this.smoulder;
    batch.begin();
    warm.begin();
    const keep = Math.max(0, fade);
    const color = packColor(M.shadow, SCORCH_ALPHA * keep);
    const data = this.scorchData;
    for (let i = 0; i < this.scorchCount; i++) {
      const at = i * SCORCH_STRIDE;
      const x = data[at] as number;
      const y = data[at + 1] as number;
      const size = (data[at + 2] as number) / GLOW_SIZE;
      const rotation = data[at + 3] as number;
      const age = (data[at + 4] as number) + dtMs;
      data[at + 4] = age;
      batch.add(this.tex.glow, 0.5, x, y, rotation, size * 1.25, size, color);
      const cool = Math.min(1, age / SMOULDER_MS);
      const glow = (SMOULDER_ALPHA + (EMBER_ALPHA - SMOULDER_ALPHA) * cool) * keep;
      warm.add(
        this.tex.glow,
        0.5,
        x,
        y,
        rotation,
        size * 0.8,
        size * 0.6,
        packColor(M.zoneDeep, glow),
      );
    }
    batch.end();
    warm.end();
  }

  private drawZones(zones: Readonly<ZonePoolState>, count: number, shown: number): void {
    const batch = this.zoneGlow;
    const g = this.rims;
    batch.begin();
    for (let i = 0; i < count && batch.size + 3 <= MAX_ZONES * 3; i++) {
      const fade = zoneFade(zones.created[i] as number, zones.expiresAt[i] as number, shown);
      if (fade <= 0) continue;
      const id = zones.id[i] as number;
      const x = zones.x[i] as number;
      const y = zones.y[i] as number;
      const r = Math.sqrt(zones.radiusSq[i] as number);
      const signature = zones.signature[i] === 1;
      const flare = this.flareOf(id);
      const flicker =
        0.85 + 0.15 * Math.sin(this.timeMs * 0.011 + hash01(id, 7) * TAU) + 0.35 * flare;
      const k = fade * flicker;
      const outer = (r * 2.5) / GLOW_SIZE;
      if (signature) {
        batch.add(this.tex.glow, 0.5, x, y, 0, outer, outer, packColor(M.zoneDeep, 0.55 * k));
        const mid = (r * 1.7) / GLOW_SIZE;
        batch.add(this.tex.glow, 0.5, x, y, 0, mid, mid, packColor(C.main, 0.42 * k));
        const hot = (r * 0.9) / GLOW_SIZE;
        const drift = hash01(id, 3) * TAU + this.timeMs * 0.0013;
        batch.add(
          this.tex.glow,
          0.5,
          x + Math.cos(drift) * r * 0.2,
          y + Math.sin(drift) * r * 0.2,
          0,
          hot,
          hot,
          packColor(C.vent, 0.35 * k),
        );
        g.circle(x, y, r).stroke({ width: 2, color: C.main, alpha: 0.28 * k });
        if (this.looks.frost) this.frostEdge(g, x, y, r, id, fade);
      } else {
        // An effect zone (a fusion's or an outer's): a quieter patch in white light.
        batch.add(this.tex.glow, 0.5, x, y, 0, outer, outer, packColor(COLORS.spark, 0.18 * k));
        g.circle(x, y, r).stroke({ width: 1.5, color: COLORS.spark, alpha: 0.3 * k });
      }
    }
    batch.end();
  }

  /** 霜焰's 霜火地: a white-blue rim with frost crystals sticking out of it. */
  private frostEdge(g: Graphics, x: number, y: number, r: number, id: number, fade: number): void {
    g.circle(x, y, r + 2).stroke({ width: 3, color: M.frostRim, alpha: 0.6 * fade });
    const turn = hash01(id, 11) * TAU;
    for (let j = 0; j < FROST_TICKS; j++) {
      const a = turn + (j / FROST_TICKS) * TAU;
      const len = 6 + 7 * hash01(id * 31 + j, 5);
      const c = Math.cos(a);
      const s = Math.sin(a);
      g.moveTo(x + c * (r - 3), y + s * (r - 3)).lineTo(x + c * (r + len), y + s * (r + len));
    }
    g.stroke({ width: 2, color: M.frost, alpha: 0.7 * fade, cap: 'round' });
  }

  private drawBombs(shots: Readonly<ShotPoolState>, count: number, tick: number, alpha: number) {
    const air = this.bombs;
    const shadows = this.shadows;
    const g = this.rims;
    air.begin();
    shadows.begin();
    for (let s = 0; s < count && shadows.size < MAX_BOMBS; s++) {
      if (shots.motion[s] !== LOBBED) continue;
      const toX = shots.x[s] as number;
      const toY = shots.y[s] as number;
      const fromX = shots.vx[s] as number;
      const fromY = shots.vy[s] as number;
      const p = bombProgress(shots.until[s] as number, tick, alpha);
      const scale = shots.form[s] === VOLCANO_FORM ? VOLCANO_SCALE : 1;
      const pose = bombPoseInto(this.pose, fromX, fromY, toX, toY, p);
      const bx = pose.groundX;
      const by = pose.groundY - pose.height;

      const shadow = (SHADOW_SIZE * scale * (0.55 + 0.45 * p)) / GLOW_SIZE;
      shadows.add(
        this.tex.glow,
        0.5,
        pose.groundX,
        pose.groundY,
        0,
        shadow * 1.4,
        shadow,
        packColor(M.shadow, 0.45 + 0.4 * p),
      );
      g.circle(toX, toY, LANDING_RADIUS * scale * (0.35 + 0.65 * p)).stroke({
        width: 1.5,
        color: C.main,
        alpha: 0.12 + 0.25 * p,
      });

      // The trail points back along the arc: toward where the ball was a little earlier.
      const back = bombPoseInto(this.backPose, fromX, fromY, toX, toY, p - 0.12);
      const tdx = bx - back.groundX;
      const tdy = by - (back.groundY - back.height);
      const trailLength = Math.min(BOMB_TRAIL * scale, Math.sqrt(tdx * tdx + tdy * tdy) * 1.4);
      if (trailLength > 1) {
        air.add(
          this.tex.streak,
          1,
          bx,
          by,
          Math.atan2(tdy, tdx),
          trailLength / STREAK_LENGTH,
          (BOMB_CORE * 0.8 * scale) / STREAK_HEIGHT,
          packColor(C.main, 0.6),
        );
      }
      const halo = (BOMB_HALO * scale) / GLOW_SIZE;
      air.add(this.tex.glow, 0.5, bx, by, 0, halo, halo, packColor(C.main, 0.55));
      const core = (BOMB_CORE * scale) / GLOW_SIZE;
      air.add(this.tex.glow, 0.5, bx, by, 0, core, core, packColor(C.coreMid, 1));
      const hot = (BOMB_HOT * scale) / GLOW_SIZE;
      air.add(this.tex.glow, 0.5, bx, by, 0, hot, hot, packColor(M.bombHot, 1));
    }
    air.end();
    shadows.end();
  }

  private flareOf(id: number): number {
    for (let i = 0; i < MAX_FLARES; i++) {
      if (this.flareIds[i] === id) return (this.flareMs[i] as number) / PULSE_FLARE_MS;
    }
    return 0;
  }

  /** The explosion's flash, ring and embers, and (`scorch`) its mark on the floor. */
  private blast(x: number, y: number, radius: number, scorch: boolean): void {
    const big = Math.sqrt(radius / LANDING_RADIUS);
    this.glow(FX_FLASH, x, y, radius * 1.5, 0xffffff, M.bombHot, 0.9, 130);
    this.glow(FX_FLASH, x, y, radius * 3, C.main, M.zoneDeep, 0.6, 320);
    this.rings.shock(x, y, radius * 1.1, C.main, 10 * big, 320);
    if (this.looks.frost) {
      this.rings.shock(x, y, radius * 1.45, M.frostRim, 5 * big, 440);
      this.sparks(x, y, 5, M.frostRim, M.frost, 0.9 * big);
    }
    const embers = Math.min(EMBER_MAX, Math.round(EMBERS * big));
    for (let i = 0; i < embers; i++) {
      const p = this.fx.spawn(FX_SPARK, this.tex.streak, x, y, this.rand(420, 680));
      if (p === null) break;
      const angle = -Math.PI / 2 + this.rand(-1.3, 1.3);
      const speed = this.rand(260, 560) * big;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.gravity = 900;
      p.drag = 1.6;
      p.orient = true;
      p.scale0 = 0.3;
      p.scale1 = 0.12;
      p.stretch = 0.0012;
      p.color0 = M.bombHot;
      p.color1 = C.main;
      p.fadeFrom = 0.5;
    }
    for (let i = 0; i < 3; i++) {
      const p = this.fx.spawn(FX_FLAME, this.tex.flame, x, y, this.rand(320, 460));
      if (p === null) break;
      p.sprite.x += this.rand(-0.5, 0.5) * radius;
      p.sprite.y += this.rand(-0.3, 0.2) * radius;
      p.vy = -this.rand(60, 120);
      p.gravity = -120;
      const s = (radius * this.rand(0.7, 1)) / 60;
      p.scale0 = s;
      p.scale1 = s * 0.35;
      p.color0 = mixColor(C.main, M.bombHot, 0.4);
      p.color1 = M.zoneDeep;
      p.alpha0 = 0.5;
      p.fadeFrom = 0.3;
    }
    if (scorch) this.addScorch(x, y, radius);
  }

  private addScorch(x: number, y: number, radius: number): void {
    if (this.scorchFadeMs >= 0) {
      // A new wave's first mark: the old ones are gone at once.
      this.scorchCount = 0;
      this.scorchNext = 0;
      this.scorchFadeMs = -1;
    }
    const at = this.scorchNext * SCORCH_STRIDE;
    this.scorchData[at] = x;
    this.scorchData[at + 1] = y;
    this.scorchData[at + 2] = radius * 2 * SCORCH_SCALE;
    this.scorchData[at + 3] = this.random() * Math.PI;
    this.scorchData[at + 4] = 0;
    this.scorchNext = (this.scorchNext + 1) % SCORCH_CAP;
    this.scorchCount = Math.min(SCORCH_CAP, this.scorchCount + 1);
  }

  /** `count` bubbles rising from within `spread` of (x, y) in the poison accent. */
  private bubbles(x: number, y: number, spread: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const p = this.fx.spawn(FX_BUBBLE, this.tex.bubble, x, y, this.rand(520, 820));
      if (p === null) return;
      const a = this.random() * TAU;
      const d = Math.sqrt(this.random()) * spread;
      p.sprite.x += Math.cos(a) * d;
      p.sprite.y += Math.sin(a) * d;
      p.vx = this.rand(-18, 18);
      p.vy = -this.rand(40, 90);
      p.drag = 0.8;
      const s = this.rand(16, 26) / BUBBLE_SIZE;
      p.scale0 = s * 0.6;
      p.scale1 = s * 1.3;
      p.color0 = mixColor(this.looks.poison, 0xffffff, 0.35);
      p.color1 = this.looks.poison;
      p.alpha0 = 0.9;
      p.fadeFrom = 0.6;
    }
  }

  private sparks(
    x: number,
    y: number,
    count: number,
    color0: number,
    color1: number,
    power: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const p = this.fx.spawn(FX_SPARK, this.tex.streak, x, y, this.rand(160, 260));
      if (p === null) return;
      const angle = this.random() * TAU;
      const speed = this.rand(320, 620) * power;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.drag = 5;
      p.orient = true;
      p.scale0 = 0.28;
      p.scale1 = 0.1;
      p.stretch = 0.0012;
      p.color0 = color0;
      p.color1 = color1;
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
