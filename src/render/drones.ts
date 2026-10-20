/**
 * The run's drones (docs/v3 C5 design D25, §13.2): kite sprites from one texture baked from the
 * hive's kite (src/render/constructs/hive.ts), drawn between the last two ticks' positions, nose
 * along the move and outward while docked; a short trail behind each, from the positions of its
 * last TRAIL_TICKS sim ticks, as fading streak particles in one ParticleContainer; and a small
 * hive-green corner bracket on every enemy a drone dashes at. Turret slots (C5.4) are not drawn
 * here. Reads the simulation state and never writes it.
 */

import { Container, Graphics, Particle, ParticleContainer } from 'pixi.js';
import type { Renderer, Texture } from 'pixi.js';
import { DRONE_DASH, DRONE_DOCKED, DRONE_KIND_DRONE } from '../sim';
import type { DroneViewState, SimState } from '../sim';
import { KITE } from './constructs/hive';
import { packColor } from './fx';
import { CONSTRUCT_COLORS } from './palette';

const C = CONSTRUCT_COLORS.hive;

/** Sim ticks of positions each drone's trail keeps (§13.2: K = 5). */
export const TRAIL_TICKS = 5;
/** A move shorter than this a tick keeps the last heading, so a drone that sits still keeps it. */
export const HEADING_HOLD_PX = 0.01;

/** Streak texture size in pixels (src/render/fxTextures.ts). */
const STREAK_LENGTH = 64;
const STREAK_HEIGHT = 16;
const TRAIL_WIDTH = 7;
/** Each streak reaches a little past the older point, so the trail reads as one stroke. */
const TRAIL_OVERLAP = 1.3;
const TRAIL_ALPHA = 0.55;
/** Shorter trail pieces (a drone at rest) are not drawn. */
const MIN_STREAK_PX = 0.5;
/** The kite texture's pixels per arena unit, enough for a crisp kite on a large screen. */
const KITE_RESOLUTION = 4;
/** The chase bracket's corners sit this far outside the enemy's radius. */
const BRACKET_GAP = 5;
const BRACKET_WIDTH = 2;
/** Arm length of a bracket corner, as a share of its half size, never under BRACKET_MIN_ARM. */
const BRACKET_ARM = 0.4;
const BRACKET_MIN_ARM = 4;
/** The bracket's four corners, as (x, y) signs. */
const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

/** An enemy as drawn this frame (EnemyLayer.positionOf). */
export interface EnemySpot {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface EnemyLocator {
  positionOf(id: number): EnemySpot | null;
}

/**
 * Heading of a drone at (x, y) that was at (prevX, prevY) a tick before: along that move, which
 * is also the direction its drawn position moves between the two ticks, or `held` when the move
 * is under HEADING_HOLD_PX (a drone held in place, at m ≤ 0, has prev equal to its position).
 */
export function moveHeading(
  prevX: number,
  prevY: number,
  x: number,
  y: number,
  held: number,
): number {
  const dx = x - prevX;
  const dy = y - prevY;
  return dx * dx + dy * dy < HEADING_HOLD_PX * HEADING_HOLD_PX ? held : Math.atan2(dy, dx);
}

/** A docked drone at (x, y) points its nose away from the core at (cx, cy) (F20). */
export function dockedHeading(x: number, y: number, cx: number, cy: number): number {
  return Math.atan2(y - cy, x - cx);
}

/** Share of the drones (kind DRONE) of the first `count` slots docked; 1 when there are none. */
export function dockedFraction(drones: DroneViewState, count: number): number {
  let total = 0;
  let docked = 0;
  for (let s = 0; s < count; s++) {
    if (drones.kind[s] !== DRONE_KIND_DRONE) continue;
    total++;
    if (drones.mode[s] === DRONE_DOCKED) docked++;
  }
  return total === 0 ? 1 : docked / total;
}

/**
 * Writes the ids of the enemies the drones of the first `count` slots dash at into `out`, each
 * once, and returns how many. The mode decides, not the target id: a drone flying home keeps its
 * target id until it docks (DroneViewState.targetId).
 */
export function chasedTargets(drones: DroneViewState, count: number, out: Int32Array): number {
  let n = 0;
  for (let s = 0; s < count && n < out.length; s++) {
    if (drones.kind[s] !== DRONE_KIND_DRONE || drones.mode[s] !== DRONE_DASH) continue;
    const id = drones.targetId[s] as number;
    let seen = id < 0;
    for (let k = 0; k < n && !seen; k++) seen = out[k] === id;
    if (!seen) out[n++] = id;
  }
  return n;
}

/**
 * The positions of one drone at its last TRAIL_TICKS sim ticks, newest first. It fills when the
 * sim tick advances, not per frame: a frame that shows the same tick again adds nothing, and the
 * ticks a frame skipped (2× and 4× run several a frame) are filled in along the line from the
 * last position, so a trail spans the same sim time at every speed.
 */
export class TrailRing {
  private readonly xs = new Float64Array(TRAIL_TICKS);
  private readonly ys = new Float64Array(TRAIL_TICKS);
  /** Index of the newest position. */
  private head = TRAIL_TICKS - 1;
  private held = 0;
  /** Sim tick of the newest position; −1 while empty. */
  private tick = -1;

  /** Positions held, up to TRAIL_TICKS. */
  get size(): number {
    return this.held;
  }

  /** The position `age` ticks back from the newest (0), for age < size. */
  x(age: number): number {
    return this.xs[(this.head - age + TRAIL_TICKS) % TRAIL_TICKS] as number;
  }

  y(age: number): number {
    return this.ys[(this.head - age + TRAIL_TICKS) % TRAIL_TICKS] as number;
  }

  /** Records the drone at (x, y) as of sim tick `tick`; a tick back in time starts over. */
  sample(tick: number, x: number, y: number): void {
    if (tick === this.tick) return;
    if (this.held === 0 || tick < this.tick) {
      this.clear();
      this.push(x, y);
    } else {
      const steps = tick - this.tick;
      const fromX = this.x(0);
      const fromY = this.y(0);
      // Of the ticks skipped, only the newest TRAIL_TICKS can stay.
      for (let j = Math.max(1, steps - TRAIL_TICKS + 1); j <= steps; j++) {
        const k = j / steps;
        this.push(fromX + (x - fromX) * k, fromY + (y - fromY) * k);
      }
    }
    this.tick = tick;
  }

  clear(): void {
    this.head = TRAIL_TICKS - 1;
    this.held = 0;
    this.tick = -1;
  }

  private push(x: number, y: number): void {
    this.head = (this.head + 1) % TRAIL_TICKS;
    this.xs[this.head] = x;
    this.ys[this.head] = y;
    if (this.held < TRAIL_TICKS) this.held++;
  }
}

/** What the drone tracks read from the simulation state. */
export type DroneFrame = Pick<SimState, 'tick' | 'player' | 'drones' | 'droneCount'>;

/** One drone's render state, kept across frames. */
export interface DroneTrack {
  readonly trail: TrailRing;
  /** The kite's rotation: along its last move, outward while docked. */
  heading: number;
  /** The follow() call that last saw it; a track left behind is dropped. */
  seen: number;
}

/**
 * The drones' render state by id: each one's heading and trail. No Pixi, so the tests reach it.
 */
export class DroneTracks {
  private readonly byId = new Map<number, DroneTrack>();
  private calls = 0;
  /** Map visitor for follow(): drops the tracks of drones gone from the state. */
  private readonly dropUnseen = (track: DroneTrack, id: number): void => {
    if (track.seen !== this.calls) this.byId.delete(id);
  };

  /** Tracks held, one per drone the last follow() saw. */
  get size(): number {
    return this.byId.size;
  }

  /** The track of drone `id` (DroneViewState.id), if the last follow() saw it. */
  get(id: number): DroneTrack | undefined {
    return this.byId.get(id);
  }

  /**
   * Brings the track of every drone (kind DRONE) in `state` up to date: its heading from its
   * last tick's move, held below HEADING_HOLD_PX, or outward while docked; its trail sampled at
   * the sim tick, so a frame that shows the same tick again adds nothing.
   */
  follow(state: Readonly<DroneFrame>): void {
    const calls = ++this.calls;
    const ds = state.drones;
    const cx = state.player.x;
    const cy = state.player.y;
    let seen = 0;
    for (let s = 0; s < state.droneCount; s++) {
      if (ds.kind[s] !== DRONE_KIND_DRONE) continue;
      const id = ds.id[s] as number;
      const x = ds.x[s] as number;
      const y = ds.y[s] as number;
      const px = ds.prevX[s] as number;
      const py = ds.prevY[s] as number;
      let track = this.byId.get(id);
      if (track === undefined) {
        track = { trail: new TrailRing(), heading: dockedHeading(x, y, cx, cy), seen: calls };
        this.byId.set(id, track);
      }
      track.seen = calls;
      seen++;
      track.heading =
        ds.mode[s] === DRONE_DOCKED
          ? dockedHeading(x, y, cx, cy)
          : moveHeading(px, py, x, y, track.heading);
      // The newest trail point is the last tick's position: the drawn one is past it.
      track.trail.sample(state.tick, px, py);
    }
    if (this.byId.size > seen) this.byId.forEach(this.dropUnseen);
  }

  /** Forgets every drone, as at the start of a run. */
  clear(): void {
    this.byId.clear();
  }
}

export class DroneLayer {
  readonly view = new Container({ label: 'drones' });
  /** Share of the run's drones docked at the last update (HiveCoreView's setDocked). */
  dockedShare = 1;
  private readonly trails: ParticleContainer;
  private readonly brackets = new Graphics({ label: 'drone-brackets' });
  private readonly kites: ParticleContainer;
  private readonly kiteTexture: Texture;
  private readonly kiteAnchorX: number;
  private readonly kiteAnchorY: number;
  private readonly streakSprites: Particle[] = [];
  private readonly kiteSprites: Particle[] = [];
  private readonly tracks = new DroneTracks();
  private chased = new Int32Array(8);

  /** `streak` is the effect sheet's spark streak (src/render/fxTextures.ts). */
  constructor(
    renderer: Renderer,
    private readonly streak: Texture,
  ) {
    this.trails = new ParticleContainer({
      label: 'drone-trails',
      texture: streak,
      dynamicProperties: { position: true, rotation: true, color: true, vertex: true },
    });
    this.trails.blendMode = 'add';
    const kite = new Graphics()
      .poly(KITE)
      .stroke({ width: 3.6, color: C.main, alpha: 0.35, join: 'round' })
      .poly(KITE)
      .fill({ color: C.main, alpha: 0.95 })
      .stroke({ width: 1.3, color: C.droneEdge, alpha: 1, join: 'round' })
      .moveTo(-10, 0)
      .lineTo(6, 0)
      .stroke({ width: 1.5, color: C.droneMark, alpha: 1, cap: 'round' });
    const bounds = kite.getLocalBounds();
    this.kiteAnchorX = -bounds.minX / bounds.width;
    this.kiteAnchorY = -bounds.minY / bounds.height;
    this.kiteTexture = renderer.generateTexture({
      target: kite,
      resolution: KITE_RESOLUTION,
      antialias: true,
    });
    kite.destroy();
    this.kites = new ParticleContainer({
      label: 'drone-kites',
      texture: this.kiteTexture,
      dynamicProperties: { position: true, rotation: true, color: false, vertex: false },
    });
    this.view.addChild(this.trails, this.brackets, this.kites);
  }

  /** Forgets every drone, as at the start of a run. */
  reset(): void {
    this.tracks.clear();
    this.dockedShare = 1;
    this.trails.particleChildren.length = 0;
    this.trails.update();
    this.kites.particleChildren.length = 0;
    this.kites.update();
    this.brackets.clear();
  }

  /**
   * Draws the drones of `state`, interpolated by `alpha` between the last two ticks. Call after
   * EnemyLayer.update: the brackets go where `enemies` drew their targets this frame.
   */
  update(state: Readonly<SimState>, alpha: number, enemies: EnemyLocator): void {
    const ds = state.drones;
    const count = state.droneCount;
    this.tracks.follow(state);
    this.dockedShare = dockedFraction(ds, count);
    const streaks = this.trails.particleChildren;
    const kites = this.kites.particleChildren;
    const previousStreaks = streaks.length;
    const previousKites = kites.length;
    let streakCount = 0;
    let kiteCount = 0;
    for (let s = 0; s < count; s++) {
      if (ds.kind[s] !== DRONE_KIND_DRONE) continue;
      const track = this.tracks.get(ds.id[s] as number) as DroneTrack;
      const px = ds.prevX[s] as number;
      const py = ds.prevY[s] as number;
      const hx = px + ((ds.x[s] as number) - px) * alpha;
      const hy = py + ((ds.y[s] as number) - py) * alpha;
      streakCount = this.drawTrail(track.trail, hx, hy, streakCount);
      const kite = this.kite(kiteCount++);
      kite.x = hx;
      kite.y = hy;
      kite.rotation = track.heading;
    }
    streaks.length = streakCount;
    if (streakCount !== previousStreaks) this.trails.update();
    kites.length = kiteCount;
    if (kiteCount !== previousKites) this.kites.update();
    this.drawBrackets(ds, count, enemies);
  }

  /** Streaks from the drawn position back through the trail, fading with age. */
  private drawTrail(trail: TrailRing, hx: number, hy: number, n: number): number {
    let fromX = hx;
    let fromY = hy;
    for (let age = 0; age < trail.size; age++) {
      const toX = trail.x(age);
      const toY = trail.y(age);
      const dx = fromX - toX;
      const dy = fromY - toY;
      const length = Math.sqrt(dx * dx + dy * dy);
      if (length >= MIN_STREAK_PX) {
        const streak = this.streakSprite(n++);
        streak.x = fromX;
        streak.y = fromY;
        streak.rotation = Math.atan2(dy, dx);
        streak.scaleX = (length * TRAIL_OVERLAP) / STREAK_LENGTH;
        streak.scaleY = TRAIL_WIDTH / STREAK_HEIGHT;
        streak.color = packColor(C.main, TRAIL_ALPHA * (1 - age / TRAIL_TICKS));
      }
      fromX = toX;
      fromY = toY;
    }
    return n;
  }

  /** A corner bracket around every enemy a drone dashes at, where the enemy is drawn. */
  private drawBrackets(ds: DroneViewState, count: number, enemies: EnemyLocator): void {
    const g = this.brackets;
    g.clear();
    if (this.chased.length < count) this.chased = new Int32Array(count);
    const n = chasedTargets(ds, count, this.chased);
    let drawn = 0;
    for (let k = 0; k < n; k++) {
      const spot = enemies.positionOf(this.chased[k] as number);
      if (spot === null) continue;
      const half = spot.radius + BRACKET_GAP;
      const arm = Math.max(BRACKET_MIN_ARM, half * BRACKET_ARM);
      for (let c = 0; c < CORNERS.length; c += 2) {
        const sx = CORNERS[c] as number;
        const sy = CORNERS[c + 1] as number;
        const x = spot.x + sx * half;
        const y = spot.y + sy * half;
        g.moveTo(x - sx * arm, y)
          .lineTo(x, y)
          .lineTo(x, y - sy * arm);
      }
      drawn++;
    }
    if (drawn > 0) {
      g.stroke({ width: BRACKET_WIDTH, color: C.main, alpha: 0.9, cap: 'round', join: 'round' });
    }
  }

  private streakSprite(n: number): Particle {
    let sprite = this.streakSprites[n];
    if (sprite === undefined) {
      sprite = new Particle({ texture: this.streak, anchorX: 1, anchorY: 0.5 });
      this.streakSprites.push(sprite);
    }
    this.trails.particleChildren[n] = sprite;
    return sprite;
  }

  private kite(n: number): Particle {
    let sprite = this.kiteSprites[n];
    if (sprite === undefined) {
      sprite = new Particle({
        texture: this.kiteTexture,
        anchorX: this.kiteAnchorX,
        anchorY: this.kiteAnchorY,
      });
      this.kiteSprites.push(sprite);
    }
    this.kites.particleChildren[n] = sprite;
    return sprite;
  }
}
