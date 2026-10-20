/**
 * The drone stage (docs/v3 C5 design D3–D13, §4.2–§4.5; step 6b in src/sim/simulation.ts): the
 * drone pool's slots (RunContext.sys.drones, placed once by src/sim/emitters/drone.ts) step in
 * id order once a tick, after the emitters' attacks and the tick hooks, before the projectiles.
 *
 * A drone stays docked until its dock time is over, then picks an enemy (pickOuter): the alive
 * one farthest from the player whose center is in the arena, of those it has not impacted within
 * its same-enemy cooldown and that no other drone dashes at; failing that, the farthest such one
 * another drone dashes at. It picks at most once every PICK_TICKS, whatever its speed, and
 * dashes at once. It moves by one straight step a tick towards its target's center and arrives
 * when the step reaches the target's edge, by the homing shots' arrival rule
 * (src/sim/systems/shots.ts), snapping to the center, where it impacts (impactAt). It stays on a
 * living target and impacts it again when its cooldown ends, until its sortie's impacts are
 * spent; then it flies home and docks again. A target that dies or is pushed out of the arena
 * is lost: the drone picks again when its clock allows, hovering where it is until then, and
 * flies home when a pick finds nothing.
 *
 * Its attack frequency m = attackSpeed / BASE_ATTACK_SPEED × its emitter's cadence, read every
 * tick, multiplies its speed and divides its dock time and cooldown; at m ≤ 0, or NaN, the drone
 * does nothing that tick. Movement, picks and the splash query draw nothing; the hits roll on
 * their payload's stream: combat for impacts, effects for repeats. An impact of the signature's
 * drones (the swarm's, emitter 0) is one attack and one shot of the signature: counted
 * (steadyAim, nthAttack), its target its primary hit, whose chain follows, and the droneImpact
 * center event, then the repeats waiting for it. A granted drone's impact is an attack of its
 * own, not the signature's: no PRIMARY, no counted attack, no center event, no repeat. A repeat
 * of the swarm is an impact of no drone at the enemy farthest from the player (swarmRepeat), on
 * the repeat's payload.
 *
 * A turret stays in its seat and fires as the volley does, from the seat instead of the player
 * (turretStep): on its emitter's accumulator and interval, projectileCount homing shots of the
 * pool (src/sim/systems/shots.ts) at the nearest enemies worth a shot, focus targets first, each
 * at an enemy of its own while there are enough. The shots move in the projectile stage and hit
 * on arrival: a signature turret's through the attack's primary hit and chain, a granted one's
 * as a plain hit. A signature turret's firing is one attack of the signature and each shot one
 * of its shots; the repeats waiting for it follow it as impacts of no drone (swarmRepeat), never
 * as a second firing. A granted turret's firing counts nothing. Unlike the volley's later
 * projectiles, a firing's later shots never go to an enemy it already picked, focus target or
 * not, while another one is worth a shot: they mark no enemy (Enemy.volleyMark, inbound). Focus
 * targets are the elites and bosses near the player (focused), not near the turret: one up to
 * FOCUS_RANGE + the turret radius from the turret can be one.
 *
 * Kills inside the stage only mark their enemy dead, and enemy objects are never reused, so a
 * target a slot keeps from an earlier tick is alive or reads dead.
 */

import { DRONE_COOLDOWN_MAX, DRONE_MEMORY, PICK_TICKS, SMALL_PROJECTILE_TICKS } from '../caps';
import { beginAttack, chainFrom, endAttack } from '../combat/chain';
import { hitWithPayload } from '../combat/hit';
import { emitCenterEvent } from '../effects/centerEvents';
import { drainRepeatCharges } from '../effects/execute';
import { PRIMARY } from '../effects/flags';
import { EVENT } from '../effects/types';
import { BASE_ATTACK_SPEED, nextShotSteady, SIGNATURE } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import { countAttack } from '../emitters/volley';
import { pickTargetInGrid } from '../targeting';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_DASH,
  DRONE_DOCKED,
  DRONE_HOVER,
  DRONE_KIND_TURRET,
  DRONE_RETURN,
} from '../types';
import { focused } from './context';
import type { Enemy, RunContext } from './context';
import { MOTION_HOMING, spawnShot } from './shots';
import type { DronePool } from './systemState';

const DRONE_IMPACT = EVENT.droneImpact;

/** Steps every slot of the drone pool once, in id order (step 6b). */
export function stepDrones(ctx: RunContext): void {
  const ds = ctx.sys.drones;
  const emitters = ctx.emitters;
  const now = ctx.now;
  const asMult = ctx.build.values.attackSpeed / BASE_ATTACK_SPEED;
  const { x, y, prevX, prevY, kind, mode, owner } = ds;
  for (let s = 0; s < ds.count; s++) {
    prevX[s] = x[s] as number;
    prevY[s] = y[s] as number;
    const em = emitters[owner[s] as number] as EmitterRuntime;
    if (kind[s] === DRONE_KIND_TURRET) {
      turretStep(ctx, ds, s, em);
      continue;
    }
    const m = asMult * em.cadence;
    // Nothing at all at m ≤ 0; a NaN m fails the test too.
    if (!(m > 0)) continue;
    switch (mode[s]) {
      case DRONE_DOCKED:
        docked(ctx, ds, s, em, m, now);
        break;
      case DRONE_DASH:
        dash(ctx, ds, s, em, m, now);
        break;
      case DRONE_HOVER:
        if (now >= (ds.nextPick[s] as number)) repick(ctx, ds, s, now);
        break;
      case DRONE_RETURN:
        flyHome(ds, s, em, m);
        break;
    }
  }
  ctx.state.droneCount = ds.count;
}

/**
 * A docked slot: its dock time runs down by m a tick; once it is over, the slot picks when its
 * clock allows and dashes at what it found on the same tick.
 */
function docked(
  ctx: RunContext,
  ds: DronePool,
  s: number,
  em: EmitterRuntime,
  m: number,
  now: number,
): void {
  const left = ds.dockLeft[s] as number;
  if (left > 0) {
    ds.dockLeft[s] = left - m;
    return;
  }
  if (now < (ds.nextPick[s] as number)) return;
  const t = pickOuter(ctx, s);
  ds.nextPick[s] = now + PICK_TICKS;
  if (t === null) return;
  engage(ds, s, t);
  dash(ctx, ds, s, em, m, now);
}

/**
 * A dashing slot: a target that died or was pushed out of the arena is lost (lose). Otherwise
 * the slot steps towards the target's center and arrives when the step reaches its edge: it
 * snaps to the center and impacts, unless the target is in its cooldown memory, where it waits
 * on it until the entry expires.
 */
function dash(
  ctx: RunContext,
  ds: DronePool,
  s: number,
  em: EmitterRuntime,
  m: number,
  now: number,
): void {
  const t = ds.target[s] as Enemy;
  if (!t.alive || outOfArena(t)) {
    lose(ctx, ds, s, now);
    return;
  }
  const x = ds.x[s] as number;
  const y = ds.y[s] as number;
  const dx = t.x - x;
  const dy = t.y - y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = (ds.stepBase[em.index] as number) * m;
  if (dist - step <= t.radius) {
    ds.x[s] = t.x;
    ds.y[s] = t.y;
    if (inMemory(ds, s, t.id, now)) return;
    const p = em.payload;
    impactAt(ctx, s, t, p, em, (p.flags & SIGNATURE) !== 0, 0, -1);
    remember(ds, s, t.id, now + cooldownTicks(ds.coolTicks[em.index] as number, m));
    const left = (ds.impactsLeft[s] as number) - 1;
    ds.impactsLeft[s] = left;
    if (left === 0) ds.mode[s] = DRONE_RETURN;
    else if (!t.alive) lose(ctx, ds, s, now);
  } else {
    const k = step / dist;
    ds.x[s] = x + dx * k;
    ds.y[s] = y + dy * k;
  }
}

/**
 * Slot s drops its target: it picks again at once when its clock allows, and otherwise hovers
 * where it is until it does.
 */
function lose(ctx: RunContext, ds: DronePool, s: number, now: number): void {
  ds.target[s] = null;
  ds.targetId[s] = -1;
  if (now >= (ds.nextPick[s] as number)) repick(ctx, ds, s, now);
  else ds.mode[s] = DRONE_HOVER;
}

/** Slot s picks: it dashes at what it found from the next tick on, or flies home. */
function repick(ctx: RunContext, ds: DronePool, s: number, now: number): void {
  const t = pickOuter(ctx, s);
  ds.nextPick[s] = now + PICK_TICKS;
  if (t !== null) engage(ds, s, t);
  else ds.mode[s] = DRONE_RETURN;
}

/** Slot s dashes at `t`: the only way into DASH, which writes the target, its id and the mode. */
function engage(ds: DronePool, s: number, t: Enemy): void {
  ds.target[s] = t;
  ds.targetId[s] = t.id;
  ds.mode[s] = DRONE_DASH;
}

/**
 * A slot flying home steps towards its dock; arriving, it docks there with its dock time to run
 * down and a full sortie, and no target.
 */
function flyHome(ds: DronePool, s: number, em: EmitterRuntime, m: number): void {
  const x = ds.x[s] as number;
  const y = ds.y[s] as number;
  const homeX = ds.dockX[s] as number;
  const homeY = ds.dockY[s] as number;
  const dx = homeX - x;
  const dy = homeY - y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const i = em.index;
  const step = (ds.stepBase[i] as number) * m;
  if (dist <= step) {
    ds.x[s] = homeX;
    ds.y[s] = homeY;
    ds.mode[s] = DRONE_DOCKED;
    ds.dockLeft[s] = ds.dockTicks[i] as number;
    ds.impactsLeft[s] = ds.impacts[i] as number;
    ds.target[s] = null;
    ds.targetId[s] = -1;
  } else {
    const k = step / dist;
    ds.x[s] = x + dx * k;
    ds.y[s] = y + dy * k;
  }
}

/** An impact's same-enemy cooldown at frequency m: coolTicks / m, rounded up, in [1, 90]. */
function cooldownTicks(coolTicks: number, m: number): number {
  return Math.min(DRONE_COOLDOWN_MAX, Math.max(1, Math.ceil(coolTicks / m)));
}

/** Slot s has impacted enemy `id` within its cooldown: a live entry of its memory holds it. */
function inMemory(ds: DronePool, s: number, id: number, now: number): boolean {
  const memId = ds.memId;
  const memUntil = ds.memUntil;
  const end = (s + 1) * DRONE_MEMORY;
  for (let k = s * DRONE_MEMORY; k < end; k++) {
    if (memId[k] === id && (memUntil[k] as number) > now) return true;
  }
  return false;
}

/**
 * Slot s remembers enemy `id` until tick `until`, in the entry that holds the id, else in the
 * one that ends first (the lowest on ties), which has expired: at most three others are live
 * (DRONE_MEMORY).
 */
function remember(ds: DronePool, s: number, id: number, until: number): void {
  const memId = ds.memId;
  const memUntil = ds.memUntil;
  const start = s * DRONE_MEMORY;
  const end = start + DRONE_MEMORY;
  let at = -1;
  for (let k = start; k < end; k++) {
    if (memId[k] === id) {
      at = k;
      break;
    }
  }
  if (at < 0) {
    at = start;
    for (let k = start + 1; k < end; k++) {
      if ((memUntil[k] as number) < (memUntil[at] as number)) at = k;
    }
  }
  memId[at] = id;
  memUntil[at] = until;
}

/** The enemy's center is outside the arena, as the lob's far aim reads it (lob.ts). */
function outOfArena(e: Enemy): boolean {
  const x = e.x;
  const y = e.y;
  return x < 0 || x > ARENA_WIDTH || y < 0 || y > ARENA_HEIGHT;
}

/** A slot other than s dashes at `e`. */
function chased(ds: DronePool, e: Enemy, s: number): boolean {
  const mode = ds.mode;
  const target = ds.target;
  for (let o = 0; o < ds.count; o++) {
    if (o !== s && mode[o] === DRONE_DASH && target[o] === e) return true;
  }
  return false;
}

/**
 * The enemy slot s picks (D6): the alive enemy farthest from the player (Enemy.dist) whose
 * center is in the arena, not in the slot's cooldown memory, and that no other slot dashes at,
 * the lowest id on ties; failing that, the farthest such one another slot dashes at, the lowest
 * id on ties; null for none. One reverse scan, which tests the arena, the memory and the chase
 * only on an enemy that would rank first. Draws nothing.
 */
export function pickOuter(ctx: RunContext, s: number): Enemy | null {
  const ds = ctx.sys.drones;
  const now = ctx.now;
  const enemies = ctx.enemies;
  let best = -1;
  let bestE: Enemy | null = null;
  // Backwards with >=, so ties keep the lower id.
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i] as Enemy;
    if (!e.alive) continue;
    const d = e.dist;
    if (d < best) continue;
    if (outOfArena(e) || inMemory(ds, s, e.id, now) || chased(ds, e, s)) continue;
    best = d;
    bestE = e;
  }
  if (bestE !== null) return bestE;
  // Every candidate is chased: the other slots' targets.
  const mode = ds.mode;
  const target = ds.target;
  let bestC: Enemy | null = null;
  for (let o = 0; o < ds.count; o++) {
    if (o === s || mode[o] !== DRONE_DASH) continue;
    const e = target[o] as Enemy;
    if (!e.alive || outOfArena(e) || inMemory(ds, s, e.id, now)) continue;
    if (bestC === null || e.dist > bestC.dist || (e.dist === bestC.dist && e.id < bestC.id)) {
      bestC = e;
    }
  }
  return bestC;
}

/**
 * Impact of drone slot `s` (−1 for a repeat's) on `target` with payload `p` of emitter `em`, an
 * attack of its own (D8). A `counted` impact, a signature drone's, is first counted as an attack
 * and a shot of `em` (countAttack, nextShotSteady), which makes its hits steady when that shot
 * is. Every enemy alive within the emitter's splash of the target's center is listed before any
 * hit, so that the children its kills split into are not among them, and each one still alive at
 * its turn takes one hit of `p` at scale 1 in id order, the target the only one counted in the
 * attack's budget and, when `p` is the signature's (a repeat's too), the primary hit. Then come
 * the chain from the target when `p` chains, which passes over the enemies the impact hit; the
 * impact event; and the droneImpact center event at the target, without a list, which rule 8
 * raises for the signature's own impacts alone. The repeats waiting for a counted impact follow
 * it. `depth` and `origin` are the hits' trigger depth and origin (0 and −1 for a drone).
 */
export function impactAt(
  ctx: RunContext,
  s: number,
  target: Enemy,
  p: Payload,
  em: EmitterRuntime,
  counted: boolean,
  depth: number,
  origin: number,
): void {
  let steady = false;
  if (counted) {
    countAttack(ctx, em, target);
    steady = nextShotSteady(ctx, em);
  }
  const ds = ctx.sys.drones;
  const r2 = ds.splashSq[em.index] as number;
  beginAttack(ctx);
  const splash = ds.splash;
  const n = ctx.grid.within(target.x, target.y, r2, splash);
  const budget = ctx.chainBudget;
  const primary = (p.flags & SIGNATURE) !== 0 ? PRIMARY : 0;
  for (let i = 0; i < n; i++) {
    const e = splash[i] as Enemy;
    if (!e.alive) continue;
    const isTarget = e === target;
    if (isTarget) budget.hits++;
    hitWithPayload(ctx, e, p, 0, 1, null, null, steady, depth, origin, isTarget ? primary : 0);
  }
  // Its victims carry the attack's serial, so the chain passes over them.
  if (p.chains) chainFrom(ctx, p, target, ctx.chainCount, steady, depth, origin);
  ctx.events.push({
    type: 'impact',
    droneId: s >= 0 ? (ds.id[s] as number) : -1,
    x: target.x,
    y: target.y,
    radius: Math.sqrt(r2),
    targetId: target.id,
    count: n,
  });
  // No list, so a hook never reads an earlier event's; the radius goes only with a list.
  ctx.centerScratch.listCount = 0;
  emitCenterEvent(ctx, DRONE_IMPACT, depth, origin, target, target.x, target.y, p.flags);
  endAttack(ctx);
  if (counted) drainRepeatCharges(ctx, em);
}

/**
 * Turret slot s of emitter `em` (D11, §4.5): its accumulator gains the emitter's cadence, and a
 * firing is due each time it reaches the emitter's interval (the turret period). A firing's first
 * target is the one pickTargetInGrid picks from the turret's seat with the volley's predicates:
 * the nearest enemy worth a shot, a focus target first, else the nearest alive one. With none
 * the turret stays ready without banking firings, so it fires on the tick an enemy appears. A
 * signature turret's firing is counted as an attack at that target first (countAttack); then it
 * rolls projectileCount as rollCount does (its fraction the chance of one more, on the payload's
 * stream; nothing drawn for a whole count), and fires that many homing shots of the emitter's
 * turret payload, the later ones each at the nearest enemy worth a shot that the firing has not
 * picked yet, focus targets first (DronePool.turretAccept), else at the nearest alive one. Each
 * shot of a signature turret counts as a shot of the attack (nextShotSteady), a refused one too.
 * The turretFire event carries the shots the firing tried, PROJECTILE_CAP's refusals included,
 * and the repeats waiting for a counted firing follow it. Allocates nothing but the event once
 * DronePool.picked has grown to the largest count a firing has rolled.
 */
function turretStep(ctx: RunContext, ds: DronePool, s: number, em: EmitterRuntime): void {
  const acc = ds.acc;
  const interval = em.interval;
  acc[s] = (acc[s] as number) + em.cadence;
  while ((acc[s] as number) >= interval) {
    const x = ds.x[s] as number;
    const y = ds.y[s] as number;
    const first = pickTargetInGrid(ctx.grid, x, y, ctx.shootable, focused);
    if (first === null) {
      acc[s] = interval - em.cadence;
      return;
    }
    acc[s] = (acc[s] as number) - interval;
    const p = ds.turretPayload[em.index] as Payload;
    const counted = (p.flags & SIGNATURE) !== 0;
    if (counted) countAttack(ctx, em, first);
    // rollCount's roll, inline: no closure a firing, no draw for a whole count.
    const pc = ctx.projectileCount;
    let n = Math.floor(pc);
    if (pc > n && p.rng.chance(pc - n)) n++;
    const picked = ds.picked;
    const until = ctx.now + SMALL_PROJECTILE_TICKS;
    ds.pickedCount = 0;
    let t: Enemy | null = first;
    let fired = 0;
    for (let k = 0; k < n && t !== null; k++) {
      picked[ds.pickedCount++] = t;
      const steady = counted ? nextShotSteady(ctx, em) : false;
      spawnShot(ctx, MOTION_HOMING, x, y, 0, 0, until, p, 1, 1, 0, 0, -1, steady, -1, em.index, t);
      fired++;
      if (k + 1 < n) t = pickTargetInGrid(ctx.grid, x, y, ds.turretAccept, focused);
    }
    ds.targetId[s] = first.id;
    ctx.events.push({
      type: 'turretFire',
      droneId: ds.id[s] as number,
      x,
      y,
      targetId: first.id,
      count: fired,
    });
    if (counted) drainRepeatCharges(ctx, em);
  }
}

/**
 * The enemy a repeat of the swarm impacts (swarmRepeat): the alive enemy farthest from the player
 * (Enemy.dist) whose center is in the arena, the lowest id on ties; null for none. pickOuter's
 * first scan without a slot's memory or chase. Draws and writes nothing.
 */
export function pickOuterFromCenter(ctx: RunContext): Enemy | null {
  const enemies = ctx.enemies;
  let best = -1;
  let bestE: Enemy | null = null;
  // Backwards with >=, so ties keep the lower id.
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i] as Enemy;
    if (!e.alive) continue;
    const d = e.dist;
    if (d < best || outOfArena(e)) continue;
    best = d;
    bestE = e;
  }
  return bestE;
}

/**
 * A repeat of the swarm (REPEAT_STEPS, src/sim/effects/execute.ts): an impact of no drone with
 * payload `p` at the enemy farthest from the player (pickOuterFromCenter), as no attack of its
 * own (impactAt, not counted), its hits at `depth` from trigger `origin`; nothing without one.
 */
export function swarmRepeat(
  ctx: RunContext,
  em: EmitterRuntime,
  p: Payload,
  depth: number,
  origin: number,
): void {
  const target = pickOuterFromCenter(ctx);
  if (target !== null) impactAt(ctx, -1, target, p, em, false, depth, origin);
}
