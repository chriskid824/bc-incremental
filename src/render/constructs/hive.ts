/**
 * 蜂巢 Hive (docs/v3/game-design-v3.md §11.3, §11.7): a solid seven-cell honeycomb core inside
 * a docking ring of kite-shaped drones, nose out. Idle: the drones circle slowly on the ring.
 * Attack: the docked drone nearest the target leaves the nest toward it, its dock shows a dashed
 * outline and its comb cell empties, so the middle hollows out as drones go; it docks again
 * after a sortie. With `simDrones` the run's drones (src/render/drones.ts) replace these: the
 * view draws the comb only, and its cells follow the share of them docked (setDocked).
 */

import { Container, Graphics } from 'pixi.js';
import { CONSTRUCT_COLORS } from '../palette';
import {
  HitFlash,
  angleDistance,
  clamp01,
  clampOffset,
  dashes,
  degrees,
  drawHalo,
  easeInOutCubic,
  easeOutCubic,
  wrapAngle,
} from './shared';
import type { ConstructView, Vec } from './shared';

const C = CONSTRUCT_COLORS.hive;

export const DOCK_SLOTS = 6;
/** Radius of the dock cradles, and of the docked drones' centers. */
export const DOCK_RADIUS = 31;
export const DRONE_RADIUS = 43;
/** Comb cells are pointy-top hexagons of this circumradius, packed edge to edge. */
export const CELL_RADIUS = 9;
const CELL_GAP = 0.6;

/**
 * Kite pointing +x around its center: nose, wing, tail, wing (§11.7: never a triangle). The drone
 * layer bakes its kites from it (src/render/drones.ts).
 */
export const KITE = [10, 0, -2.6, -5.8, -10, 0, -2.6, 5.8];
/** Dark chevron near the tail, pointing at the nose so the drone reads head-out (§11.7). */
const KITE_MARK = [-7.6, -3.2, -3.4, 0, -7.6, 3.2];
/** Half the angle each dock cradle spans. */
const CRADLE_HALF = degrees(13);

/** Idle orbit of the docking ring: one revolution in about 35 s. */
const ORBIT_PER_MS = (2 * Math.PI) / 35_000;
const BOB_MS = 1600;
const BOB = 0.9;

/** Sortie timeline: fly out and fade (handed over to the drone layer), away, fly back in. */
const OUT_MS = 240;
const FADE_FROM_MS = 120;
const FADE_MS = 140;
export const RETURN_AT_MS = 1600;
const RETURN_MS = 250;
export const SORTIE_MS = RETURN_AT_MS + RETURN_MS;
/** A launched drone's cell and dock empty over this long. */
export const EMPTY_MS = 300;
/** Under simDrones the cells empty in opposite pairs, by slot: a pair for each third gone. */
const EMPTY_ORDER = [0, 3, 1, 4, 2, 5];

/** Direction of dock slot `i` when the ring has turned by `orbit`. */
export function slotAngle(i: number, orbit: number): number {
  return degrees(60 * i) + orbit;
}

/** Comb cell centers: the middle cell first, then six around it at 30° + 60°·k. */
export function cellCenters(): Vec[] {
  const ring = CELL_RADIUS * Math.sqrt(3);
  const centers: Vec[] = [{ x: 0, y: 0 }];
  for (let k = 0; k < 6; k++) {
    const a = degrees(30 + 60 * k);
    centers.push({ x: Math.cos(a) * ring, y: Math.sin(a) * ring });
  }
  return centers;
}

/** The docked slot nearest `target`, or -1 when every drone is out. */
export function nearestDockedSlot(
  docked: readonly boolean[],
  orbit: number,
  target: number,
): number {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < docked.length; i++) {
    if (!docked[i]) continue;
    const d = angleDistance(slotAngle(i, orbit), target);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

export interface DronePose extends Vec {
  /** Direction the nose points. */
  readonly heading: number;
}

/**
 * A launched drone's offset from its dock at flight progress `s` (0 to 1): it leaves nose-out
 * along its slot direction and curves toward `target` (never more than 90° off its slot, so it
 * does not cut across the comb), at most MAX_PART_OFFSET from the dock.
 */
export function sortieOffset(slot: number, target: number, s: number): DronePose {
  const turn = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, wrapAngle(target - slot)));
  const rx = Math.cos(slot);
  const ry = Math.sin(slot);
  const dx = Math.cos(slot + turn);
  const dy = Math.sin(slot + turn);
  // Quadratic Bézier from the dock, pulled out along the slot, ending off toward the target.
  const cx = rx * 22;
  const cy = ry * 22;
  const ex = rx * 8 + dx * 36;
  const ey = ry * 8 + dy * 36;
  const t = clamp01(s);
  const k = 2 * (1 - t) * t;
  const offset = clampOffset(k * cx + t * t * ex, k * cy + t * t * ey);
  const vx = 2 * (1 - t) * cx + 2 * t * (ex - cx);
  const vy = 2 * (1 - t) * cy + 2 * t * (ey - cy);
  return { x: offset.x, y: offset.y, heading: Math.atan2(vy, vx) };
}

/** How empty a drone's dock and cell are `ageMs` into its sortie, 0 (docked) to 1. */
export function dockEmptiness(ageMs: number): number {
  if (ageMs < 0 || ageMs >= SORTIE_MS) return 0;
  if (ageMs < RETURN_AT_MS) return clamp01(ageMs / EMPTY_MS);
  return 1 - easeOutCubic((ageMs - RETURN_AT_MS) / RETURN_MS);
}

function hexagon(cx: number, cy: number, r: number): number[] {
  const points: number[] = [];
  for (let k = 0; k < 6; k++) {
    const a = degrees(-90 + 60 * k);
    points.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return points;
}

function drawKite(g: Graphics): Graphics {
  return g
    .poly(KITE)
    .stroke({ width: 3.6, color: C.main, alpha: 0.35, join: 'round' })
    .poly(KITE)
    .fill({ color: C.main, alpha: 0.95 })
    .stroke({ width: 1.3, color: C.droneEdge, alpha: 1, join: 'round' })
    .moveTo(-10, 0)
    .lineTo(6, 0)
    .stroke({ width: 1.5, color: C.droneMark, alpha: 1, cap: 'round' })
    .poly(KITE_MARK)
    .fill({ color: C.droneMark, alpha: 1 });
}

export interface HiveViewOptions {
  /**
   * The run's drones are drawn by the drone layer: the view draws the comb only (no docking
   * ring, no drones of its own, attack() does nothing), and its cells follow setDocked instead
   * of its own sorties (docs/v3 C5 design §13.2). Off for the construct sheet.
   */
  readonly simDrones?: boolean;
}

interface Drone {
  readonly root: Graphics;
  /** Dashed outline left in the dock while the drone is out. */
  readonly ghost: Graphics;
  /** The comb cell that empties while this drone is out. */
  readonly cell: Graphics;
  /** Age of the running sortie, or -1 when docked. */
  sortieMs: number;
  target: number;
}

export class HiveView implements ConstructView {
  readonly view = new Container({ label: 'construct-hive' });
  /** Animated part of the construct: the hit flash tints and swells this, not `view`. */
  private readonly body = new Container();
  private readonly halo = new Graphics();
  /** Docking ring: cradles and ghosts, turning with the orbit. */
  private readonly ring = new Container();
  private readonly centerCell = new Graphics();
  private readonly drones: Drone[] = [];
  private readonly docked: boolean[] = [];
  private readonly hitFlash = new HitFlash();
  private readonly simDrones: boolean;
  /** setDocked's share of the run's drones docked, 0 to 1. */
  private dockedShare = 1;
  /** How empty the nest is drawn, easing toward 1 − dockedShare. */
  private emptied = 0;
  private timeMs = 0;

  constructor(options: HiveViewOptions = {}) {
    this.simDrones = options.simDrones ?? false;
    this.view.addChild(this.body);
    drawHalo(this.halo, 40, C.main, 0.18);
    const track = new Graphics()
      .circle(0, 0, DOCK_RADIUS)
      .stroke({ width: 1, color: C.dock, alpha: 0.35 });
    this.ring.addChild(track);
    for (let i = 0; i < DOCK_SLOTS; i++) {
      const a = slotAngle(i, 0);
      track
        .moveTo(Math.cos(a - CRADLE_HALF) * DOCK_RADIUS, Math.sin(a - CRADLE_HALF) * DOCK_RADIUS)
        .arc(0, 0, DOCK_RADIUS, a - CRADLE_HALF, a + CRADLE_HALF)
        .stroke({ width: 2.6, color: C.dock, alpha: 1, cap: 'round' });
    }

    const comb = new Container({ label: 'comb' });
    const centers = cellCenters();
    const r = CELL_RADIUS - CELL_GAP;
    const outline = new Graphics();
    for (let k = 0; k < centers.length; k++) {
      const { x, y } = centers[k] as Vec;
      outline.poly(hexagon(x, y, r)).stroke({ width: 1.2, color: C.cellEdge, alpha: 1 });
    }
    this.centerCell.poly(hexagon(0, 0, r)).fill({ color: C.cellCenter, alpha: 1 });
    comb.addChild(this.centerCell);

    for (let i = 0; i < DOCK_SLOTS; i++) {
      const { x, y } = centers[i + 1] as Vec;
      const cell = new Graphics()
        .poly(hexagon(x, y, r))
        .fill({ color: C.cell, alpha: 1 })
        .poly(hexagon(x, y, r * 0.48))
        .fill({ color: C.cellHollow, alpha: 1 });
      comb.addChild(cell);
      const ghost = new Graphics();
      for (const dash of dashes(KITE, true, 2.6, 2)) {
        ghost.poly(dash, false);
      }
      ghost.stroke({ width: 1.2, color: C.main, alpha: 0.9 });
      const a = slotAngle(i, 0);
      ghost.position.set(Math.cos(a) * DRONE_RADIUS, Math.sin(a) * DRONE_RADIUS);
      ghost.rotation = a;
      ghost.alpha = 0;
      this.ring.addChild(ghost);
      const root = drawKite(new Graphics({ label: `drone-${i}` }));
      this.drones.push({ root, ghost, cell, sortieMs: -1, target: 0 });
      this.docked.push(true);
    }
    comb.addChild(outline);
    if (this.simDrones) this.body.addChild(this.halo, comb);
    else this.body.addChild(this.halo, this.ring, comb, ...this.drones.map((d) => d.root));
    this.update(0);
  }

  /**
   * Under simDrones: the share of the run's drones docked, 0 (all out) to 1, which the comb's
   * cells ease toward over EMPTY_MS.
   */
  setDocked(share: number): void {
    this.dockedShare = clamp01(share);
  }

  attack(angle: number): void {
    if (this.simDrones) return;
    const slot = nearestDockedSlot(this.docked, this.orbit(), angle);
    if (slot < 0) return;
    const drone = this.drones[slot] as Drone;
    drone.sortieMs = 0;
    drone.target = angle;
    this.docked[slot] = false;
  }

  hit(): void {
    this.hitFlash.trigger();
  }

  reset(): void {
    for (const drone of this.drones) drone.sortieMs = -1;
    this.docked.fill(true);
    this.dockedShare = 1;
    this.emptied = 0;
    this.hitFlash.reset();
    this.update(0);
  }

  /** The orbit, bob and pulse clock back at zero, as a new view has it (Renderer.restart). */
  rewind(): void {
    this.timeMs = 0;
  }

  update(dtMs: number): void {
    this.timeMs += dtMs;
    const orbit = this.orbit();
    this.ring.rotation = orbit;
    let emptiness = 0;
    for (let i = 0; i < DOCK_SLOTS; i++) {
      const drone = this.drones[i] as Drone;
      const a = slotAngle(i, orbit);
      const bob = BOB * Math.sin((this.timeMs / BOB_MS) * 2 * Math.PI + i * 1.3);
      const dockX = Math.cos(a) * (DRONE_RADIUS + bob);
      const dockY = Math.sin(a) * (DRONE_RADIUS + bob);
      let x = dockX;
      let y = dockY;
      let heading = a;
      let alpha = 1;
      if (drone.sortieMs >= 0) {
        drone.sortieMs += dtMs;
        const age = drone.sortieMs;
        if (age >= SORTIE_MS) {
          drone.sortieMs = -1;
          this.docked[i] = true;
        } else if (age < RETURN_AT_MS) {
          const pose = sortieOffset(a, drone.target, easeInOutCubic(age / OUT_MS));
          x += pose.x;
          y += pose.y;
          heading = pose.heading;
          alpha = 1 - clamp01((age - FADE_FROM_MS) / FADE_MS);
        } else {
          // Back in along the slot direction, nose out, settling into the dock.
          const p = easeOutCubic((age - RETURN_AT_MS) / RETURN_MS);
          const back = clampOffset(Math.cos(a) * 40 * (1 - p), Math.sin(a) * 40 * (1 - p));
          x += back.x;
          y += back.y;
          alpha = p;
        }
      }
      const empty = dockEmptiness(drone.sortieMs);
      emptiness += empty;
      drone.root.position.set(x, y);
      drone.root.rotation = heading;
      drone.root.alpha = alpha;
      drone.root.visible = alpha > 0.01;
      drone.ghost.alpha = empty;
      drone.cell.alpha = 1 - 0.88 * empty;
    }
    if (this.simDrones) emptiness = this.followDocked(dtMs);
    // The middle dims as the nest empties (§11.4: with every drone out, the center is empty).
    const pulse = 0.06 * Math.sin(this.timeMs * 0.0025);
    this.centerCell.alpha = 1 - 0.65 * (emptiness / DOCK_SLOTS) + pulse;
    this.halo.alpha = 1 - 0.5 * (emptiness / DOCK_SLOTS);
    this.hitFlash.apply(this.body, dtMs);
  }

  private orbit(): number {
    return wrapAngle(this.timeMs * ORBIT_PER_MS);
  }

  /** Eases the drawn emptiness toward setDocked's and empties the cells; returns it in cells. */
  private followDocked(dtMs: number): number {
    const step = dtMs / EMPTY_MS;
    this.emptied += Math.max(-step, Math.min(step, 1 - this.dockedShare - this.emptied));
    const cells = this.emptied * DOCK_SLOTS;
    for (let k = 0; k < DOCK_SLOTS; k++) {
      const drone = this.drones[EMPTY_ORDER[k] as number] as Drone;
      drone.cell.alpha = 1 - 0.88 * clamp01(cells - k);
    }
    return cells;
  }
}
