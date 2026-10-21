/**
 * Orbits (docs/v3 C4 design D21, §4.13): the orbit grants (環繞球). An orbit emitter's orbs, as
 * many as its memory holds (OrbMemory.n, fixed when the run starts), sit evenly spaced on its
 * ring (OrbitSpec.radius) around the player and turn revPerSec times a second: on tick `now`,
 * orb o of n is at the angle 2π × (revPerSec × now / TICK_RATE + o / n). Each tick, orb by orb,
 * every alive enemy an orb touches (their radii overlap) takes a hit of the emitter's payload, in
 * id order, unless that orb hit it less than em.interval ticks ago (cooldownSec, whole ticks):
 * each orb keeps its own cooldown (Hoshi's Q13 (B)), so the ring's other orbs can hit the enemy
 * meanwhile, and an enemy touched for longer than its cooldown is hit again.
 *
 * Each orb remembers the enemies it hit in its block of em.orbs, a ring buffer in hit order,
 * which is the order their cooldowns end in, as all take the emitter's one cooldown: ended
 * entries leave from the block's head, and an orb that hits one more while its block is full
 * forgets its oldest entry, counted in orbMemoryFull (Q13/F1). No entry is cleared at a kill: a
 * dead enemy's ends on its own, and no enemy id comes back. An orb's candidates are the grid's
 * enemies within its radius plus ctx.shotPad of it, which holds every enemy it can touch but the
 * tough ones, larger than the pad, then the tough ones farther out (grid.marked).
 *
 * The hits crit, roll and apply their ailments as hitWithPayload does for any hit, on the combat
 * stream, with depth 0 and no origin, and raise hit events; the orbs' places draw nothing. An
 * orbit is not an attack: its hits carry no PRIMARY, count in no chain budget, raise no center
 * events and repeat nothing. What a hit sets off (a kill, a freeze, an ailment's triggers) only
 * queues, so nothing reaches the memory while the orbs run.
 */

import { ORB_MEMORY } from '../caps';
import { hitWithPayload } from '../combat/hit';
import type { Enemy, RunContext } from '../systems/context';
import { TICK_RATE } from '../types';
import type { EmitterRuntime, OrbitSpec, OrbMemory } from './types';

const TWO_PI = 2 * Math.PI;
/** An orb's offset in its block, wrapped (ORB_MEMORY is a power of two). */
const MASK = ORB_MEMORY - 1;

/** Turns orbit emitter `em`'s orbs to this tick's places and hits what each touches. */
export function runOrbit(ctx: RunContext, em: EmitterRuntime): void {
  const m = em.orbs as OrbMemory;
  const n = m.n;
  if (n <= 0) return;
  const spec = em.spec as OrbitSpec;
  const now = ctx.now;
  const base = (TWO_PI * spec.revPerSec * now) / TICK_RATE;
  const ring = spec.radius;
  const orbRadius = spec.orbRadius;
  const reach = orbRadius + ctx.shotPad;
  const reachSq = reach * reach;
  const cd = em.interval;
  const p = em.payload;
  const targets = em.targets as Enemy[];
  const player = ctx.player;
  const ids = m.ids;
  const until = m.until;
  for (let o = 0; o < n; o++) {
    const a = base + (TWO_PI * o) / n;
    const ox = player.x + ring * Math.cos(a);
    const oy = player.y + ring * Math.sin(a);
    const b = o * ORB_MEMORY;
    let h = m.head[o] as number;
    let c = m.count[o] as number;
    // Cooldowns end oldest first.
    while (c > 0 && (until[b + h] as number) <= now) {
      h = (h + 1) & MASK;
      c--;
    }
    const k = candidates(ctx, ox, oy, reachSq, targets);
    for (let j = 0; j < k; j++) {
      const enemy = targets[j] as Enemy;
      if (!enemy.alive) continue;
      const r = orbRadius + enemy.radius;
      const dx = enemy.x - ox;
      const dy = enemy.y - oy;
      if (dx * dx + dy * dy > r * r) continue;
      const id = enemy.id;
      let seen = false;
      for (let q = 0; q < c; q++) {
        if (ids[b + ((h + q) & MASK)] === id) {
          seen = true;
          break;
        }
      }
      // This orb hit it less than its cooldown ago.
      if (seen) continue;
      if (c === ORB_MEMORY) {
        // Full: forget the oldest (Q13/F1).
        h = (h + 1) & MASK;
        c--;
        ctx.counters.orbMemoryFull++;
      }
      const t = b + ((h + c) & MASK);
      ids[t] = id;
      until[t] = now + cd;
      c++;
      hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, 0, -1);
    }
    m.head[o] = h;
    m.count[o] = c;
  }
}

/**
 * The alive enemies an orb at (ox, oy) may touch, into `out` in id order; returns how many: the
 * grid's within reach (reachSq, the orb's radius plus ctx.shotPad, squared), which holds every
 * enemy but the tough ones, larger than the pad, then the tough ones farther out (grid.marked),
 * so none is listed twice.
 */
function candidates(
  ctx: RunContext,
  ox: number,
  oy: number,
  reachSq: number,
  out: Enemy[],
): number {
  const grid = ctx.grid;
  const near = grid.within(ox, oy, reachSq, out);
  let count = near;
  const marked = grid.markedCount();
  for (let k = 0; k < marked; k++) {
    const enemy = grid.marked(k);
    if (!enemy.tough || !enemy.alive) continue;
    // within()'s own test, so an enemy it listed is left out.
    const dx = enemy.x - ox;
    const dy = enemy.y - oy;
    if (dx * dx + dy * dy <= reachSq) continue;
    out[count++] = enemy;
  }
  if (count === near) return count;
  // Two runs, each in id order: an insertion sort merges them.
  for (let i = near; i < count; i++) {
    const enemy = out[i] as Enemy;
    let j = i - 1;
    while (j >= 0 && (out[j] as Enemy).id > enemy.id) {
      out[j + 1] = out[j] as Enemy;
      j--;
    }
    out[j + 1] = enemy;
  }
  return count;
}
