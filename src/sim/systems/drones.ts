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
 * (src/sim/systems/shots.ts), snapping to the center, where it impacts (impact(), its splash and
 * scale worked out in dash). It stays on a living target and impacts it again when its cooldown
 * ends, until its sortie's impacts are spent; then it flies home and docks again. A target that
 * dies or is pushed out of the arena is lost: the drone picks again when its clock allows, hovering
 * where it is until then, and flies home when a pick finds nothing. Each dash tick that starts
 * outside the target's body writes the drone's heading (DronePool.hx, hy: the target's center minus
 * the drone), so it holds the way the drone last flew in, through the ticks it rides its target,
 * until it docks (FL).
 *
 * Its attack frequency m = attackSpeed / BASE_ATTACK_SPEED × its emitter's cadence, read every
 * tick, multiplies its speed and divides its dock time and cooldown; at m ≤ 0, or NaN, the drone
 * does nothing that tick. Movement, picks and the splash query draw nothing; the hits roll on
 * their payload's stream: combat for impacts, effects for repeats. An impact of the signature's
 * drones (the swarm's, emitter 0) is one attack and one shot of the signature: counted
 * (steadyAim, nthAttack), its target its primary hit, whose chain follows, and the droneImpact
 * center event, whose value is the drone's heading as an angle (slashLine toward 'flight'), then
 * the repeats waiting for it. A granted drone's impact is an attack of its own, not the
 * signature's: no PRIMARY, no counted attack, no center event, no repeat. A repeat of the swarm
 * is an impact of no drone at the enemy farthest from the player (swarmRepeat), on the repeat's
 * payload.
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
 * FOCUS_RANGE + its seat's radius from the turret can be one (90, or the swarm's
 * SwarmParams.turretRadius). A turret's pick has no range: the nearest alive enemy anywhere is
 * its last resort, one outside the arena too.
 *
 * A timed row (C5.7: a spirit, DRONE_KIND_SPIRIT) is one a spawnDrone effect appended at its
 * event's point (spawnRows). It has no emitter, dock or seat: its numbers are its effect's
 * (DronePool.specs), its payload its effect's, on the effects stream, and its hits, its ailment
 * term and its droneExpire take the depth and origin of the effect that spawned it. Its m is
 * attackSpeed / BASE_ATTACK_SPEED. It picks on its first stage and again only when it has lost
 * its target, at most once every PICK_TICKS: the enemy nearest to it (pickNearest) or the drones'
 * pick (pickOuter), by its aim. It dashes at once at what it found (from the next tick when the
 * pick follows a lost target) and hovers where it is while it finds nothing. It steps, arrives and
 * keeps its cooldown memory as a drone does, with no heading, and its impact is a granted drone's
 * at its own splash and damagePct, followed by its ailment term on each enemy the impact listed
 * that is still alive. Every row first checks its time (DronePool.until, which a fixed row's never
 * reaches): a timed row leaves when its time is up, mid-dash too, or at once when its impacts are
 * spent, and raises droneExpire, with no target, at its position. The rows that left are dropped
 * at the stage's end, the others keeping their order. A spawn past the summon cap, fixed and timed
 * rows together, or past its effect's maxLive is refused and counted (summonCapped).
 *
 * The summon policies (C5.9) are BuildFlags that B1's rule modules set: 鎖定信標
 * (summonEliteFirst) runs pickOuter's and pickNearest's tiers over the elites and bosses first
 * and makes them a turret's focus targets at any distance; 蟲海 multiplies the drones at the fill
 * (droneCountMult, src/sim/emitters/drone.ts) and sends a drone whose sortie is spent at the next
 * target rather than home, or on at the one it ended on while that lives in the arena and no
 * other is found (dronesStay); 加農砲 and 特斯拉塔 change the turrets' rate (their
 * emitter's interval), the splash around their shots' targets and their shots' chain jumps
 * (src/sim/systems/shots.ts turretArrival). The droneSpeed stat is in every row's step.
 *
 * E4's are B2's (蜂巢's center board and 女王): 蜂后 and 重錘 are roles of single swarm drones
 * (SwarmParams.roles, placed by dock index at the fill): a role's damage factor scales its
 * impacts' hits and its speed factor its every step (DronePool.roleDamage, roleSpeed), and the
 * leader's (蜂后's followBonus) scales another swarm drone's impact on the enemy the leader dashes
 * at (followScale). 集火指令 (BuildFlags.summonHighestHp) gives every summon's pick, a turret's
 * whole firing included, to the highest-hp enemy in the arena (pickHighestHp), before 鎖定信標.
 * 前哨's seat radius, 巨像's and 蜂后's drawn size (DroneViewState.size, which nothing here reads)
 * and 蜂王漿's summonDuration (the timed rows' lives, SpawnSpecs.lifeTicks) are the fill's.
 *
 * 蜂巢's center board (E5, gd:181-197) sets three SwarmParams, which the fill reads once
 * (src/sim/emitters/drone.ts). 自爆協議 (lastImpact): the impact that spends a swarm drone's
 * sortie (impactsLeft 1 → 0) explodes, an impact at the explosion's sized radius and hit scale in
 * place of the splash and 1, everything else as an impact; never under 蟲海, and never a granted
 * drone's, a spirit's or a repeat's. 攔截守衛 (guards): the swarm's last drones are guards, docked
 * on an orbit (DRONE_GUARD) instead of at a dock. Each guard keeps its own orbit angle
 * (DronePool.guardAngle), which the stage's start advances a step, whatever the attack frequency,
 * and writes into its dock while the guard is on its orbit, and leaves as it is while the guard
 * is away (stepGuards, lead ruling K2-R1); on its orbit a guard rides its point around the player,
 * runs down its dock time and picks as a docked drone does, but with guardPick: the charging
 * dashers first, at any distance, else pickOuter within the guards' ring (under 集火指令 the
 * highest-hp enemy within it). On a tick a dasher began charging, every guard not dashing at a
 * charging dasher picks one at once (the charge start); a guard flies home to the fixed point where
 * it left its orbit, docks there as a drone does at its dock and goes on from that angle. 蜂潮
 * (surge): once due, every swarm drone dashes at the densest enemy at once with a full sortie, its
 * next impact on it × damageMult (stepSurge). Both run at the stage's start, the guards first. A
 * run without them pays one test an impact and two a stage.
 *
 * Kills inside the stage only mark their enemy dead, and enemy objects are never reused, so a
 * target a slot keeps from an earlier tick is alive or reads dead.
 */

import { gt, mul, num, ZERO } from '../../core/num';
import { APPLIED_AILMENTS } from '../../data/triggers';
import type { AppliedAilment } from '../../data/triggers';
import {
  DRONE_COOLDOWN_MAX,
  DRONE_MEMORY,
  GUARD_REV_PER_SEC,
  PICK_TICKS,
  SMALL_PROJECTILE_TICKS,
} from '../caps';
import { beginAttack, chainFrom, endAttack } from '../combat/chain';
import { hitWithPayload } from '../combat/hit';
import { emitCenterEvent } from '../effects/centerEvents';
import { fire } from '../effects/dispatch';
import { applyStacks, drainRepeatCharges, durationOf } from '../effects/execute';
import { PRIMARY, REPEAT } from '../effects/flags';
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
  DRONE_GUARD,
  DRONE_HOVER,
  DRONE_KIND_DRONE,
  DRONE_KIND_SPIRIT,
  DRONE_KIND_TURRET,
  DRONE_RETURN,
  TICK_RATE,
} from '../types';
import { focused, toughFocus } from './context';
import type { Enemy, RunContext } from './context';
import { CHARGING } from './enemyRecord';
import { MOTION_HOMING, spawnShot } from './shots';
import { AIM_OUTER, NEVER_LEAVES } from './systemState';
import type { DronePool, DroneSurge, SpawnSpecs } from './systemState';

const DRONE_IMPACT = EVENT.droneImpact;
const DRONE_EXPIRE = EVENT.droneExpire;
const TWO_PI = 2 * Math.PI;
/** A guard's orbit angle a tick on its orbit: GUARD_REV_PER_SEC turns a second (K2-R1). */
const GUARD_STEP = (TWO_PI * GUARD_REV_PER_SEC) / TICK_RATE;

/**
 * Steps every slot of the drone pool once, in id order (step 6b), after 攔截守衛's orbit and
 * charge start (stepGuards) and 蜂潮 (stepSurge), then drops the timed rows that left
 * (dropLeft).
 */
export function stepDrones(ctx: RunContext): void {
  const ds = ctx.sys.drones;
  const emitters = ctx.emitters;
  const now = ctx.now;
  const asMult = ctx.build.values.attackSpeed / BASE_ATTACK_SPEED;
  // E5's two stage tests: guards, then a surge.
  if (ds.guardEnd !== 0) stepGuards(ctx, ds, now);
  if (ds.surge !== null) stepSurge(ctx, ds, ds.surge, now);
  const { x, y, prevX, prevY, kind, mode, owner, until } = ds;
  for (let s = 0; s < ds.count; s++) {
    // A timed row whose time is up leaves, mid-dash too, and at m ≤ 0; a fixed row never does.
    if (now >= (until[s] as number)) {
      leave(ctx, ds, s, 'time', now);
      continue;
    }
    prevX[s] = x[s] as number;
    prevY[s] = y[s] as number;
    const k = kind[s];
    // A spirit has no emitter: nothing reads emitters[owner] for one.
    if (k === DRONE_KIND_SPIRIT) {
      spiritStep(ctx, ds, s, asMult, now);
      continue;
    }
    const em = emitters[owner[s] as number] as EmitterRuntime;
    if (k === DRONE_KIND_TURRET) {
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
      case DRONE_GUARD:
        guarding(ctx, ds, s, em, m, now);
        break;
    }
  }
  if (ds.left !== 0) dropLeft(ds, now);
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
 * A guard on its orbit (DRONE_GUARD, 攔截守衛; E5), a guard's docked state: it rides onto its
 * orbit point (its dockX, dockY, which stepGuards advanced at the stage's start), then runs as a
 * docked slot does, picking with guardPick, and stays on the orbit when the pick finds nothing.
 * At m ≤ 0, or NaN, the stage skips it, as every drone, while its point still advances: it falls
 * behind its point and snaps back onto it on its next tick with m > 0.
 */
function guarding(
  ctx: RunContext,
  ds: DronePool,
  s: number,
  em: EmitterRuntime,
  m: number,
  now: number,
): void {
  ds.x[s] = ds.dockX[s] as number;
  ds.y[s] = ds.dockY[s] as number;
  const left = ds.dockLeft[s] as number;
  if (left > 0) {
    ds.dockLeft[s] = left - m;
    return;
  }
  if (now < (ds.nextPick[s] as number)) return;
  const t = guardPick(ctx, ds, s);
  ds.nextPick[s] = now + PICK_TICKS;
  if (t === null) return;
  engage(ds, s, t);
  dash(ctx, ds, s, em, m, now);
}

/**
 * A dashing slot: a target that died or was pushed out of the arena is lost (lose). Otherwise
 * the slot steps towards the target's center and arrives when the step reaches its edge: it
 * snaps to the center and impacts, unless the target is in its cooldown memory, where it waits
 * on it until the entry expires. Its sortie's last impact sends it home, or under 蟲海
 * (BuildFlags.dronesStay) refills its impacts, and the slot picks the next target as one that
 * lost its target does, at once when its clock allows and hovering until then, but keeps this
 * one for a pick that finds nothing (repick). A tick that starts outside the target's body
 * writes the heading (hx, hy), the target's center minus the slot, before the step or the snap;
 * one that starts within it, riding the target or ramming it again, leaves it as it was (FL).
 * A swarm drone's impact is 自爆協議's explosion when it spends the sortie, and × 蜂潮's
 * damageMult when the row surges (E5), on top of its role's damage factor and 蜂后's follow
 * factor (E4, followScale): its splash and scale are worked out here, at the impact's call.
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
  // Flying in from outside its body, the arrival's snap included: the way it last flew in.
  if (dist > t.radius) {
    ds.hx[s] = dx;
    ds.hy[s] = dy;
  }
  // × its role's speed factor (重錘, E4), 1 without one.
  const step = (ds.stepBase[em.index] as number) * m * (ds.roleSpeed[s] as number);
  if (dist - step <= t.radius) {
    ds.x[s] = t.x;
    ds.y[s] = t.y;
    if (inMemory(ds, s, t.id, now)) return;
    const p = em.payload;
    let r2 = ds.splashSq[em.index] as number;
    // Its role's damage factor (E4), × 蜂后's follow factor; a run without a leader pays the one
    // load and the one test.
    const role = ds.roleDamage[s] as number;
    let scale = ds.leader < 0 ? role : followScale(ds, s, t, role);
    // 自爆協議 and 蜂潮 (E5), on the swarm's own drones, on top: one test without them.
    if (ds.impactRules && em.index === 0) {
      // The impact that spends the sortie explodes; lastImpactScale is 0 without it, and under
      // 蟲海, whose sorties never end.
      if (ds.lastImpactScale > 0 && ds.impactsLeft[s] === 1) {
        r2 = ds.lastImpactSq;
        scale *= ds.lastImpactScale;
      }
      // Its target is the surge's: stepSurge clears the mark of a row that dashes at another.
      if (ds.surging[s] !== 0) {
        ds.surging[s] = 0;
        scale *= (ds.surge as DroneSurge).damageMult;
      }
    }
    impact(ctx, s, t, p, (p.flags & SIGNATURE) !== 0 ? em : null, r2, scale, 0, -1);
    remember(ds, s, t.id, now + cooldownTicks(ds.coolTicks[em.index] as number, m));
    const left = (ds.impactsLeft[s] as number) - 1;
    ds.impactsLeft[s] = left;
    if (left === 0) {
      // 蟲海 (BuildFlags.dronesStay): a full sortie at once, at the next target, as a drone that
      // lost its target picks, but keeping this one: on at it when that finds nothing, home
      // only when it is dead or out of the arena too (repick).
      if (ctx.build.flags.dronesStay) {
        ds.impactsLeft[s] = ds.impacts[em.index] as number;
        if (now >= (ds.nextPick[s] as number)) repick(ctx, ds, s, now);
        else ds.mode[s] = DRONE_HOVER;
      } else ds.mode[s] = DRONE_RETURN;
    } else if (!t.alive) lose(ctx, ds, s, now);
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

/**
 * Slot s picks, a guard with guardPick (E5): it dashes at what it found from the next tick on,
 * or flies home. Under 蟲海 (BuildFlags.dronesStay) a pick that finds nothing falls back on the
 * target the slot's spent sortie ended on (kept), so the slot dashes on at it and waits out its
 * cooldown memory, as between a sortie's impacts; it flies home only when there is none.
 */
function repick(ctx: RunContext, ds: DronePool, s: number, now: number): void {
  const found = isGuard(ds, s) ? guardPick(ctx, ds, s) : pickOuter(ctx, s);
  const t = found ?? (ctx.build.flags.dronesStay ? kept(ds, s) : null);
  ds.nextPick[s] = now + PICK_TICKS;
  if (t !== null) engage(ds, s, t);
  else ds.mode[s] = DRONE_RETURN;
}

/**
 * 蟲海 (BuildFlags.dronesStay): the target slot s's spent sortie ended on, which it keeps while it
 * picks again (dash), hovering too, when that target is still alive in the arena; null when it is
 * not, and for a slot that lost its target (lose), which keeps none.
 */
function kept(ds: DronePool, s: number): Enemy | null {
  const e = ds.target[s] as Enemy | null;
  return e !== null && e.alive && !outOfArena(e) ? e : null;
}

/** Slot s dashes at `t`: the only way into DASH, which writes the target, its id and the mode. */
function engage(ds: DronePool, s: number, t: Enemy): void {
  ds.target[s] = t;
  ds.targetId[s] = t.id;
  ds.mode[s] = DRONE_DASH;
}

/**
 * A slot flying home steps towards its dock, as fast as it dashes (its role's speed factor
 * included); arriving, it docks there with its dock time to run down and a full sortie, and no
 * target or heading, so its next sortie's impacts never carry this one's.
 * A guard's dock is the point of its orbit where it left, fixed while it is away (lead ruling
 * K2-R1), where it docks on its orbit (DRONE_GUARD).
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
  const step = (ds.stepBase[i] as number) * m * (ds.roleSpeed[s] as number);
  if (dist <= step) {
    ds.x[s] = homeX;
    ds.y[s] = homeY;
    ds.mode[s] = isGuard(ds, s) ? DRONE_GUARD : DRONE_DOCKED;
    ds.dockLeft[s] = ds.dockTicks[i] as number;
    ds.impactsLeft[s] = ds.impacts[i] as number;
    ds.target[s] = null;
    ds.targetId[s] = -1;
    ds.hx[s] = 0;
    ds.hy[s] = 0;
  } else {
    const k = step / dist;
    ds.x[s] = x + dx * k;
    ds.y[s] = y + dy * k;
  }
}

/** Slot s is a guard (攔截守衛, E5): DronePool.guardFirst .. guardEnd − 1, none without one. */
function isGuard(ds: DronePool, s: number): boolean {
  return s < ds.guardEnd && s >= ds.guardFirst;
}

/**
 * 攔截守衛 at the start of the drone stage (SwarmParams.guards, lead rulings K2 and K2-R1; E5).
 * Each guard on its orbit (DRONE_GUARD) at this moment advances its own angle
 * (DronePool.guardAngle, the fill's 2πg/G) by 2π × GUARD_REV_PER_SEC / TICK_RATE, whatever the
 * attack frequency, and writes the point at that angle on the guards' ring around the player into
 * its dock, which it rides. A guard in any other mode keeps its angle and its dock, the point where
 * it left, which it flies home to; docking there, it advances again from the next stage's start.
 * Then the charge start, on a tick a dasher began charging (EnemyAiState.chargeStarts):
 * every guard that is not dashing at a charging dasher picks one at once (chargingPick), whatever
 * its dock time and pick clock, and dashes at it from where it is with a full sortie, its next pick
 * PICK_TICKS on; one that finds none keeps what it was doing.
 */
function stepGuards(ctx: RunContext, ds: DronePool, now: number): void {
  const first = ds.guardFirst;
  const end = ds.guardEnd;
  const ring = ds.guardRadius;
  const angle = ds.guardAngle;
  const px = ctx.player.x;
  const py = ctx.player.y;
  for (let s = first; s < end; s++) {
    if (ds.mode[s] !== DRONE_GUARD) continue;
    const a = (angle[s - first] as number) + GUARD_STEP;
    angle[s - first] = a;
    ds.dockX[s] = px + ring * Math.cos(a);
    ds.dockY[s] = py + ring * Math.sin(a);
  }
  if (ctx.sys.enemyAi.chargeStartCount === 0) return;
  const impacts = ds.impacts[0] as number;
  for (let s = first; s < end; s++) {
    if (ds.mode[s] === DRONE_DASH && charging(ds.target[s] as Enemy)) continue;
    const t = chargingPick(ctx, ds, s);
    if (t === null) continue;
    engage(ds, s, t);
    ds.impactsLeft[s] = impacts;
    ds.nextPick[s] = now + PICK_TICKS;
  }
}

/** `e` is alive and charging its dash: its v3 state holds the CHARGING bit (a dasher's). */
function charging(e: Enemy): boolean {
  const v = e.v3;
  return e.alive && v !== null && (v.state & CHARGING) !== 0;
}

/**
 * The charging dasher guard s picks (guardPick's first tier, the charge start's pick): of the
 * alive enemies in the arena whose v3 state holds the CHARGING bit, at any distance, the nearest
 * to the row (squared distance from its position) that no other row dashes at, else the nearest
 * one another row dashes at, the lowest id on ties, whatever the row's cooldown memory; null for
 * none. One forward scan of EnemyAiState.list, where every dasher is, in id order. Draws
 * nothing.
 */
function chargingPick(ctx: RunContext, ds: DronePool, s: number): Enemy | null {
  const list = ctx.sys.enemyAi.list;
  const x = ds.x[s] as number;
  const y = ds.y[s] as number;
  let best = Infinity;
  let bestE: Enemy | null = null;
  let bestC = Infinity;
  let bestCE: Enemy | null = null;
  // Forwards with <, so ties keep the lower id.
  for (let i = 0; i < list.length; i++) {
    const e = list[i] as Enemy;
    if (!charging(e) || outOfArena(e)) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (chased(ds, e, s)) {
      if (d < bestC) {
        bestC = d;
        bestCE = e;
      }
    } else if (d < best) {
      best = d;
      bestE = e;
    }
  }
  return bestE ?? bestCE;
}

/**
 * The enemy guard s picks (攔截守衛, E5): the charging dasher chargingPick finds, else the
 * drones' own pick (pickOuter, its flags and tiers included) over the enemies at most the guards'
 * ring from the player (Enemy.dist ≤ DronePool.guardRadius); null for none. Every pick of a guard
 * is this one: on its orbit, after a lost target and after a spent sortie under 蟲海. Draws
 * nothing.
 */
export function guardPick(ctx: RunContext, ds: DronePool, s: number): Enemy | null {
  return chargingPick(ctx, ds, s) ?? pickOuter(ctx, s, ds.guardRadius);
}

/**
 * 蜂潮 at the start of the drone stage, after the charge start (SwarmParams.surge, lead ruling
 * K3; E5). First the mark of every row no longer dashing at the last surge's target clears: a
 * lost target (dead, or out of the arena), a docking or a charge start leaves it behind, and the
 * row impacts nothing before this. Then, on a tick at or after the due tick, the surge fires when
 * there is a densest enemy (densest) and stays due when there is none, banking nothing: every
 * swarm drone row (kind DRONE of emitter 0, the guards too), whatever its mode, dashes at it at
 * once from where it is (engage) with a full sortie, its next pick PICK_TICKS on, marked surging
 * (DronePool.surging); the next surge is due a period on; and droneSurge carries the target and
 * the rows sent. Turrets, granted drones and spirits never surge.
 */
function stepSurge(ctx: RunContext, ds: DronePool, surge: DroneSurge, now: number): void {
  const { kind, owner, mode, target, surging } = ds;
  const count = ds.count;
  for (let s = 0; s < count; s++) {
    if (surging[s] !== 0 && (mode[s] !== DRONE_DASH || target[s] !== surge.target)) surging[s] = 0;
  }
  if (now < surge.due) return;
  const t = densest(ctx, ds);
  if (t === null) return;
  surge.due = now + surge.period;
  surge.target = t;
  const impacts = ds.impacts[0] as number;
  let sent = 0;
  for (let s = 0; s < count; s++) {
    if (kind[s] !== DRONE_KIND_DRONE || owner[s] !== 0) continue;
    engage(ds, s, t);
    ds.impactsLeft[s] = impacts;
    ds.nextPick[s] = now + PICK_TICKS;
    surging[s] = 1;
    sent++;
  }
  ctx.events.push({ type: 'droneSurge', x: t.x, y: t.y, targetId: t.id, count: sent });
}

/**
 * 蜂潮's target (E5): the alive enemy in the arena with the most alive enemies in the arena whose
 * center is within the swarm's sized splash of its center, itself included (ctx.grid.within with
 * emitter 0's splashSq, into DronePool.splash), the lowest id on ties; null for none. One scan of
 * the enemies, in id order, only on a tick a surge fires. Draws nothing.
 */
export function densest(ctx: RunContext, ds: DronePool): Enemy | null {
  const enemies = ctx.enemies;
  const r2 = ds.splashSq[0] as number;
  const splash = ds.splash;
  let best = 0;
  let bestE: Enemy | null = null;
  // Forwards with >, so ties keep the lower id.
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i] as Enemy;
    if (!e.alive || outOfArena(e)) continue;
    const n = ctx.grid.within(e.x, e.y, r2, splash);
    let c = 0;
    for (let k = 0; k < n; k++) if (!outOfArena(splash[k] as Enemy)) c++;
    if (c > best) {
      best = c;
      bestE = e;
    }
  }
  return bestE;
}

/**
 * A spirit (K5): at m ≤ 0, or NaN, it does nothing; dashing, it steps (spiritDash); hovering, it
 * picks once its clock allows and dashes at what it found on the same tick, as a docked drone
 * launches, or stays where it is.
 */
function spiritStep(ctx: RunContext, ds: DronePool, s: number, m: number, now: number): void {
  if (!(m > 0)) return;
  if (ds.mode[s] === DRONE_DASH) spiritDash(ctx, ds, s, m, now);
  else if (now >= (ds.nextPick[s] as number) && spiritPick(ctx, ds, s, now)) {
    spiritDash(ctx, ds, s, m, now);
  }
}

/** Spirit s picks by its aim, its clock then held PICK_TICKS: true when it now dashes. */
function spiritPick(ctx: RunContext, ds: DronePool, s: number, now: number): boolean {
  const specs = ds.specs as SpawnSpecs;
  const aim = specs.aim[ds.spec[s] as number];
  const t = aim === AIM_OUTER ? pickOuter(ctx, s) : pickNearest(ctx, s);
  ds.nextPick[s] = now + PICK_TICKS;
  if (t === null) return false;
  engage(ds, s, t);
  return true;
}

/**
 * A dashing spirit, as a drone's dash with its effect's step, splash and cooldown: a target that
 * died or was pushed out of the arena is lost (spiritLose); arriving, it snaps to the target's
 * center and impacts (spiritImpact) unless the target is in its cooldown memory. Its last impact
 * makes it leave at once ('spent'); a target its impact killed is lost. It writes no heading:
 * its impacts raise no center event.
 */
function spiritDash(ctx: RunContext, ds: DronePool, s: number, m: number, now: number): void {
  const t = ds.target[s] as Enemy;
  if (!t.alive || outOfArena(t)) {
    spiritLose(ctx, ds, s, now);
    return;
  }
  const specs = ds.specs as SpawnSpecs;
  const f = ds.spec[s] as number;
  const x = ds.x[s] as number;
  const y = ds.y[s] as number;
  const dx = t.x - x;
  const dy = t.y - y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = (specs.stepBase[f] as number) * m;
  if (dist - step <= t.radius) {
    ds.x[s] = t.x;
    ds.y[s] = t.y;
    if (inMemory(ds, s, t.id, now)) return;
    spiritImpact(ctx, ds, specs, s, t, f);
    remember(ds, s, t.id, now + cooldownTicks(specs.coolTicks[f] as number, m));
    const left = (ds.impactsLeft[s] as number) - 1;
    ds.impactsLeft[s] = left;
    if (left === 0) leave(ctx, ds, s, 'spent', now);
    else if (!t.alive) spiritLose(ctx, ds, s, now);
  } else {
    const k = step / dist;
    ds.x[s] = x + dx * k;
    ds.y[s] = y + dy * k;
  }
}

/**
 * Spirit s drops its target and hovers where it is: it picks again at once when its clock
 * allows, dashing from the next tick on at what it found, and never flies home.
 */
function spiritLose(ctx: RunContext, ds: DronePool, s: number, now: number): void {
  ds.target[s] = null;
  ds.targetId[s] = -1;
  ds.mode[s] = DRONE_HOVER;
  if (now >= (ds.nextPick[s] as number)) spiritPick(ctx, ds, s, now);
}

/**
 * Spirit s of spawnDrone effect `f` impacts `target` (K7): impact as a granted drone's impact,
 * on its effect's payload, splash and damagePct, at the row's depth and origin; then, with an
 * ailment term, each enemy the impact listed that is still alive takes its stacks, in id order,
 * each as a hit of the damage stat × ailmentDamagePct would apply it (applyStacks), at the same
 * depth and origin. A build without the ailment's duration skips the term, as a zone's does.
 */
function spiritImpact(
  ctx: RunContext,
  ds: DronePool,
  specs: SpawnSpecs,
  s: number,
  target: Enemy,
  f: number,
): void {
  const p = ctx.effectPayloads[f] as Payload;
  const depth = ds.depth[s] as number;
  const origin = ds.origin[s] as number;
  const r2 = specs.splashSq[f] as number;
  const n = impact(ctx, s, target, p, null, r2, specs.scale[f] as number, depth, origin);
  const a = specs.ailment[f] as number;
  if (a < 0) return;
  const ailment = APPLIED_AILMENTS[a] as AppliedAilment;
  if (!(durationOf(ctx, ailment) > 0)) return;
  const base = mul(p.baseDamage, specs.ailmentPct[f] as number);
  const stacks = specs.stacks[f] as number;
  const splash = ds.splash;
  for (let i = 0; i < n; i++) {
    const e = splash[i] as Enemy;
    if (e.alive) applyStacks(ctx, ailment, e, p, base, stacks, depth, origin);
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
 * only on an enemy that would rank first. Under 鎖定信標 (BuildFlags.summonEliteFirst) the same
 * two tiers run over the alive tough enemies first (pickOuterTough), and over every enemy only
 * when they find none; a run without it pays the one flag test. Under 集火指令
 * (BuildFlags.summonHighestHp), checked first, it is the highest-hp enemy (pickHighestHp) alone.
 * Every tier, 集火指令's included, passes over the enemies farther than `range` from the player:
 * a guard's ring (guardPick, E5), Infinity for every other pick. Draws nothing.
 */
export function pickOuter(ctx: RunContext, s: number, range = Infinity): Enemy | null {
  const flags = ctx.build.flags;
  if (flags.summonHighestHp) return pickHighestHp(ctx, range);
  if (flags.summonEliteFirst) {
    const t = pickOuterTough(ctx, s, range);
    if (t !== null) return t;
  }
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
    if (d < best || d > range) continue;
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
    if (!e.alive || e.dist > range || outOfArena(e) || inMemory(ds, s, e.id, now)) continue;
    if (bestC === null || e.dist > bestC.dist || (e.dist === bestC.dist && e.id < bestC.id)) {
      bestC = e;
    }
  }
  return bestC;
}

/**
 * pickOuter's tiers over the alive tough enemies (Enemy.tough: elites and bosses) alone, at any
 * distance up to `range`: the farthest unchased one, then the farthest one another slot dashes
 * at, each the lowest id on ties, with pickOuter's rejects; null for none (鎖定信標, C5.9).
 */
function pickOuterTough(ctx: RunContext, s: number, range: number): Enemy | null {
  const ds = ctx.sys.drones;
  const now = ctx.now;
  const enemies = ctx.enemies;
  let best = -1;
  let bestE: Enemy | null = null;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i] as Enemy;
    if (!e.alive || !e.tough) continue;
    const d = e.dist;
    if (d < best || d > range) continue;
    if (outOfArena(e) || inMemory(ds, s, e.id, now) || chased(ds, e, s)) continue;
    best = d;
    bestE = e;
  }
  if (bestE !== null) return bestE;
  const mode = ds.mode;
  const target = ds.target;
  let bestC: Enemy | null = null;
  for (let o = 0; o < ds.count; o++) {
    if (o === s || mode[o] !== DRONE_DASH) continue;
    const e = target[o] as Enemy;
    if (!e.tough || !e.alive || e.dist > range || outOfArena(e)) continue;
    if (inMemory(ds, s, e.id, now)) continue;
    if (bestC === null || e.dist > bestC.dist || (e.dist === bestC.dist && e.id < bestC.id)) {
      bestC = e;
    }
  }
  return bestC;
}

/**
 * The enemy spirit s picks with aim 'nearest' (K6): the alive enemy nearest to the row (squared
 * distance from its position) whose center is in the arena, not in the row's cooldown memory,
 * and that no other row dashes at, the lowest id on ties; failing that, the nearest such one
 * another row dashes at, the lowest id on ties; null for none. One forward scan of the enemies,
 * in id order, which tests the arena, the memory and the chase only on an enemy that would rank
 * first; then the other rows' targets. Under 鎖定信標 (BuildFlags.summonEliteFirst) the same
 * two tiers run over the alive tough enemies first (pickNearestTough). Under 集火指令
 * (BuildFlags.summonHighestHp), checked first, it is the highest-hp enemy (pickHighestHp) alone.
 * Draws nothing.
 */
export function pickNearest(ctx: RunContext, s: number): Enemy | null {
  const flags = ctx.build.flags;
  if (flags.summonHighestHp) return pickHighestHp(ctx);
  if (flags.summonEliteFirst) {
    const t = pickNearestTough(ctx, s);
    if (t !== null) return t;
  }
  const ds = ctx.sys.drones;
  const now = ctx.now;
  const enemies = ctx.enemies;
  const x = ds.x[s] as number;
  const y = ds.y[s] as number;
  let best = Infinity;
  let bestE: Enemy | null = null;
  // Forwards with <, so ties keep the lower id.
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i] as Enemy;
    if (!e.alive) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (!(d < best)) continue;
    if (outOfArena(e) || inMemory(ds, s, e.id, now) || chased(ds, e, s)) continue;
    best = d;
    bestE = e;
  }
  if (bestE !== null) return bestE;
  // Every candidate is chased: the other rows' targets.
  const mode = ds.mode;
  const target = ds.target;
  let bestC: Enemy | null = null;
  let bestD = Infinity;
  for (let o = 0; o < ds.count; o++) {
    if (o === s || mode[o] !== DRONE_DASH) continue;
    const e = target[o] as Enemy;
    if (!e.alive || outOfArena(e) || inMemory(ds, s, e.id, now)) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (bestC === null || d < bestD || (d === bestD && e.id < bestC.id)) {
      bestC = e;
      bestD = d;
    }
  }
  return bestC;
}

/**
 * pickNearest's tiers over the alive tough enemies alone: the nearest unchased one to the row,
 * then the nearest one another row dashes at, each the lowest id on ties, with pickNearest's
 * rejects; null for none (鎖定信標, C5.9).
 */
function pickNearestTough(ctx: RunContext, s: number): Enemy | null {
  const ds = ctx.sys.drones;
  const now = ctx.now;
  const enemies = ctx.enemies;
  const x = ds.x[s] as number;
  const y = ds.y[s] as number;
  let best = Infinity;
  let bestE: Enemy | null = null;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i] as Enemy;
    if (!e.alive || !e.tough) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (!(d < best)) continue;
    if (outOfArena(e) || inMemory(ds, s, e.id, now) || chased(ds, e, s)) continue;
    best = d;
    bestE = e;
  }
  if (bestE !== null) return bestE;
  const mode = ds.mode;
  const target = ds.target;
  let bestC: Enemy | null = null;
  let bestD = Infinity;
  for (let o = 0; o < ds.count; o++) {
    if (o === s || mode[o] !== DRONE_DASH) continue;
    const e = target[o] as Enemy;
    if (!e.tough || !e.alive || outOfArena(e) || inMemory(ds, s, e.id, now)) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (bestC === null || d < bestD || (d === bestD && e.id < bestC.id)) {
      bestC = e;
      bestD = d;
    }
  }
  return bestC;
}

/**
 * 集火指令's pick (BuildFlags.summonHighestHp, E4), every summon's: the alive enemy with the most
 * hp whose center is in the arena, the lowest id on ties (one forward scan of ctx.enemies with
 * core/num's strict gt, as highestHpId's, src/sim/systems/globals.ts), at this point of the tick,
 * whatever a slot's cooldown memory and the chase; null for none. It passes over the enemies
 * farther than `range` from the player (Enemy.dist): a guard's ring (guardPick through
 * pickOuter, E5), Infinity for every other pick. EvalInput.highestHpId is not read: written
 * before the contact step, it can name an enemy dead since or overtaken. Draws nothing.
 */
export function pickHighestHp(ctx: RunContext, range = Infinity): Enemy | null {
  const enemies = ctx.enemies;
  let best: Enemy | null = null;
  // Forwards with a strict >, so ties keep the lower id.
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i] as Enemy;
    if (!e.alive || (best !== null && !gt(e.hp, best.hp)) || e.dist > range || outOfArena(e)) {
      continue;
    }
    best = e;
  }
  return best;
}

/**
 * Impact of drone slot `s` on `target` with payload `p` of emitter `em`, an attack of its own
 * (D8). A `counted` impact, a signature drone's, is first counted as an attack and a shot of `em`
 * (countAttack, nextShotSteady), which makes its hits steady when that shot is. Every enemy alive
 * within the emitter's splash of the target's center is listed before any hit, so that the
 * children its kills split into are not among them, and each one still alive at its turn takes
 * one hit of `p` in id order, the target the only one counted in the attack's budget and, when
 * `p` is the signature's, the primary hit. Its hits' scale is the slot's role's damage factor
 * (DronePool.roleDamage: 1 without a role; E4), × 蜂后's follow factor when another of the
 * swarm's drones impacts the leader's live target (followScale); a chain jump's is the chain's
 * own. Then come the chain from the target when `p` chains, which passes over the enemies the
 * impact hit; the impact event; and the droneImpact center event at the target, without a list,
 * which rule 8 raises for the signature's own impacts alone, its value the flight's angle
 * (flightAngle). The repeats waiting for a counted impact follow it. `depth` and `origin` are the
 * hits' trigger depth and origin (0 and −1 for a drone). A drone's own impact (dash) works out
 * the same splash and scale itself, 自爆協議's and 蜂潮's on top (E5), and calls impact.
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
  const ds = ctx.sys.drones;
  const r2 = ds.splashSq[em.index] as number;
  // A run without a leader pays the one load and the one test.
  const role = ds.roleDamage[s] as number;
  const scale = ds.leader < 0 ? role : followScale(ds, s, target, role);
  impact(ctx, s, target, p, counted ? em : null, r2, scale, depth, origin);
}

/**
 * 蜂后's 「其他無人機打蜂后的目標時傷害 +20%」 (E4): `scale` × DronePool.followMult when drone
 * slot s is another of the swarm's (emitter 0's) than the leader and `target` is the leader's
 * live target, the alive enemy it dashes at (riding it through its cooldown memory too, still
 * DASH); `scale` itself otherwise, a leader docked, hovering or flying home having none.
 */
function followScale(ds: DronePool, s: number, target: Enemy, scale: number): number {
  const leader = ds.leader;
  const follows =
    s !== leader &&
    ds.owner[s] === 0 &&
    ds.mode[leader] === DRONE_DASH &&
    ds.target[leader] === target &&
    target.alive;
  return follows ? scale * ds.followMult : scale;
}

/**
 * A drone's impact (dash's, and impactAt's), its splash radius squared `r2` and its hits' `scale`
 * given (none at 0); a `counted` impact names its emitter, and null counts nothing; `s` is −1 for a
 * repeat's (swarmRepeat), at scale 1, its target the primary hit too, its payload being the
 * signature's. A timed row's (spiritImpact) is a granted drone's at its effect's splash and
 * damagePct. Returns how many enemies it listed (DronePool.splash).
 */
function impact(
  ctx: RunContext,
  s: number,
  target: Enemy,
  p: Payload,
  counted: EmitterRuntime | null,
  r2: number,
  scale: number,
  depth: number,
  origin: number,
): number {
  let steady = false;
  if (counted !== null) {
    countAttack(ctx, counted, target);
    steady = nextShotSteady(ctx, counted);
  }
  const ds = ctx.sys.drones;
  beginAttack(ctx);
  const splash = ds.splash;
  const n = ctx.grid.within(target.x, target.y, r2, splash);
  const budget = ctx.chainBudget;
  const primary = (p.flags & SIGNATURE) !== 0 ? PRIMARY : 0;
  // A row of damagePct 0 lists its splash and hits none of it.
  const hits = scale > 0 ? n : 0;
  for (let i = 0; i < hits; i++) {
    const e = splash[i] as Enemy;
    if (!e.alive) continue;
    const isTarget = e === target;
    if (isTarget) budget.hits++;
    // Its hits add no shock, so a blocked one changes nothing after it (R1).
    hitWithPayload(ctx, e, p, 0, scale, null, null, steady, depth, origin, isTarget ? primary : 0);
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
  // emitCenterEvent's first tests, rule 8 and a listener, made here as raiseChainJump makes them,
  // so an impact whose event is not raised computes no angle.
  const flags = p.flags;
  const center = ctx.centerEvents;
  if (
    (flags & (SIGNATURE | REPEAT)) === SIGNATURE &&
    (center.listeners[DRONE_IMPACT] !== 0 || center.hooks !== 0)
  ) {
    const angle = num(flightAngle(ctx, s, target));
    emitCenterEvent(ctx, DRONE_IMPACT, depth, origin, target, target.x, target.y, flags, angle);
  }
  endAttack(ctx);
  if (counted !== null) drainRepeatCharges(ctx, counted);
  return n;
}

/**
 * The droneImpact event's value at `target` (FL): drone slot s's heading as an angle,
 * atan2(hy, hx), the way it last flew in; for a slot without one, or no slot (s = −1, a repeat's
 * impact), the angle away from the player, as slashLine's 'outward' runs, 0 on the player.
 * Only the swarm's own drones raise the event today, so the outward angle is a drone's that has
 * not flown in from outside its target since it docked.
 */
function flightAngle(ctx: RunContext, s: number, target: Enemy): number {
  if (s >= 0) {
    const ds = ctx.sys.drones;
    const hx = ds.hx[s] as number;
    const hy = ds.hy[s] as number;
    if (hx !== 0 || hy !== 0) return Math.atan2(hy, hx);
  }
  const player = ctx.player;
  return Math.atan2(target.y - player.y, target.x - player.x);
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
 * and the repeats waiting for a counted firing follow it. Under 鎖定信標
 * (BuildFlags.summonEliteFirst) its focus targets, for the first shot and the later ones alike,
 * are the elites and bosses at any distance (toughFocus) rather than those near the player
 * (focused). Under 集火指令 (BuildFlags.summonHighestHp), checked first, the firing's first shot
 * and every later one go at the highest-hp enemy in the arena (pickHighestHp), focus targets
 * playing no part, and it fires at none while there is none. Allocates nothing but the event once
 * DronePool.picked has grown to the largest count a firing has rolled.
 */
function turretStep(ctx: RunContext, ds: DronePool, s: number, em: EmitterRuntime): void {
  const acc = ds.acc;
  const interval = em.interval;
  acc[s] = (acc[s] as number) + em.cadence;
  while ((acc[s] as number) >= interval) {
    const x = ds.x[s] as number;
    const y = ds.y[s] as number;
    const flags = ctx.build.flags;
    // 集火指令: the whole firing at the highest-hp enemy (E4).
    const top = flags.summonHighestHp;
    // 鎖定信標: the elites and bosses at any distance are its focus targets, in place of those
    // near the player.
    const focus = flags.summonEliteFirst ? toughFocus : focused;
    const first = top ? pickHighestHp(ctx) : pickTargetInGrid(ctx.grid, x, y, ctx.shootable, focus);
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
      if (k + 1 < n && !top) t = pickTargetInGrid(ctx.grid, x, y, ds.turretAccept, focus);
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
 * own (impactAt's impact, not counted, at the emitter's splash), its hits at scale 1, which no
 * drone's role or follow bonus reaches (E4), at `depth` from trigger `origin`; nothing without
 * one.
 */
export function swarmRepeat(
  ctx: RunContext,
  em: EmitterRuntime,
  p: Payload,
  depth: number,
  origin: number,
): void {
  const target = pickOuterFromCenter(ctx);
  if (target === null) return;
  const r2 = ctx.sys.drones.splashSq[em.index] as number;
  impact(ctx, -1, target, p, null, r2, 1, depth, origin);
}

/**
 * Appends `count` timed rows (spirits) of spawnDrone effect `f` at (x, y) (K2, K4): each at slot
 * `count` with the next id, in id order, hovering with no target or heading and a pick due at
 * once, its memory empty, its impacts its effect's, leaving `lifeTicks` ticks from now
 * (SpawnSpecs.lifeTicks from its executor), keeping `f`, `depth` and `origin`, with no role and
 * size 1 (E4). A row is refused while the pool holds its summon cap of live rows, fixed and
 * timed together, or `f` its maxLive, and each refused row adds 1 to summonCapped. Only a build
 * with a spawnDrone effect runs it (DronePool.specs). The rows first step in the next tick's
 * drone stage.
 */
export function spawnRows(
  ctx: RunContext,
  f: number,
  count: number,
  lifeTicks: number,
  x: number,
  y: number,
  depth: number,
  origin: number,
): void {
  const ds = ctx.sys.drones;
  const specs = ds.specs as SpawnSpecs;
  const live = specs.live;
  const room = Math.min(ds.rows - ds.count, (specs.maxLive[f] as number) - (live[f] as number));
  const placed = Math.max(0, Math.min(count, room));
  ctx.counters.summonCapped += count - placed;
  if (placed === 0) return;
  const now = ctx.now;
  const until = Math.min(NEVER_LEAVES, now + lifeTicks);
  const impacts = specs.impacts[f] as number;
  for (let k = 0; k < placed; k++) {
    const s = ds.count++;
    ds.id[s] = ds.nextId++;
    ds.kind[s] = DRONE_KIND_SPIRIT;
    ds.mode[s] = DRONE_HOVER;
    ds.x[s] = x;
    ds.y[s] = y;
    ds.prevX[s] = x;
    ds.prevY[s] = y;
    ds.targetId[s] = -1;
    ds.owner[s] = -1;
    ds.seat[s] = -1;
    ds.dockX[s] = x;
    ds.dockY[s] = y;
    ds.target[s] = null;
    ds.nextPick[s] = now;
    ds.impactsLeft[s] = impacts;
    ds.dockLeft[s] = 0;
    ds.acc[s] = 0;
    const end = (s + 1) * DRONE_MEMORY;
    for (let j = s * DRONE_MEMORY; j < end; j++) {
      ds.memId[j] = -1;
      ds.memUntil[j] = 0;
    }
    ds.until[s] = until;
    ds.spec[s] = f;
    ds.depth[s] = depth;
    ds.origin[s] = origin;
    ds.hx[s] = 0;
    ds.hy[s] = 0;
    // No role reaches a timed row (E4): its factors and size are 1.
    ds.roleDamage[s] = 1;
    ds.roleSpeed[s] = 1;
    ds.size[s] = 1;
    ds.surging[s] = 0;
  }
  live[f] = (live[f] as number) + placed;
  ctx.state.droneCount = ds.count;
}

/**
 * Timed row s leaves (K7), its time up ('time') or its impacts spent ('spent'): it is marked to
 * be dropped at the stage's end (its until set to now), dashes at nothing from now on, so no
 * picker counts it as chasing, and frees its place in its effect's maxLive. Its droneExpire
 * SimEvent, then the droneExpire trigger event at its position, with no target, at its depth and
 * origin, as the other events without a target are raised.
 */
function leave(
  ctx: RunContext,
  ds: DronePool,
  s: number,
  cause: 'time' | 'spent',
  now: number,
): void {
  const x = ds.x[s] as number;
  const y = ds.y[s] as number;
  ds.until[s] = now;
  ds.mode[s] = DRONE_HOVER;
  ds.target[s] = null;
  ds.targetId[s] = -1;
  const live = (ds.specs as SpawnSpecs).live;
  const f = ds.spec[s] as number;
  live[f] = (live[f] as number) - 1;
  ds.left++;
  ctx.events.push({ type: 'droneExpire', droneId: ds.id[s] as number, x, y, cause });
  fire(ctx, DRONE_EXPIRE, ds.depth[s] as number, ds.origin[s] as number, null, x, y, 0, ZERO);
}

/**
 * Drops the rows that left in this stage (until ≤ now) by one stable compaction (K7): every
 * other row moves down, in id order, with all of its per-slot state (moveRow).
 */
function dropLeft(ds: DronePool, now: number): void {
  const until = ds.until;
  const count = ds.count;
  let kept = 0;
  for (let s = 0; s < count; s++) {
    if ((until[s] as number) <= now) continue;
    if (kept !== s) moveRow(ds, s, kept);
    kept++;
  }
  // The slots past the rows keep no enemy alive.
  for (let s = kept; s < count; s++) ds.target[s] = null;
  ds.count = kept;
  ds.left = 0;
}

/** Moves the row in slot `from` to slot `to` (to < from): every per-slot array of the pool. */
function moveRow(ds: DronePool, from: number, to: number): void {
  ds.id[to] = ds.id[from] as number;
  ds.kind[to] = ds.kind[from] as number;
  ds.mode[to] = ds.mode[from] as number;
  ds.x[to] = ds.x[from] as number;
  ds.y[to] = ds.y[from] as number;
  ds.prevX[to] = ds.prevX[from] as number;
  ds.prevY[to] = ds.prevY[from] as number;
  ds.targetId[to] = ds.targetId[from] as number;
  ds.owner[to] = ds.owner[from] as number;
  ds.seat[to] = ds.seat[from] as number;
  ds.dockX[to] = ds.dockX[from] as number;
  ds.dockY[to] = ds.dockY[from] as number;
  ds.target[to] = ds.target[from] as Enemy | null;
  ds.nextPick[to] = ds.nextPick[from] as number;
  ds.impactsLeft[to] = ds.impactsLeft[from] as number;
  ds.dockLeft[to] = ds.dockLeft[from] as number;
  ds.acc[to] = ds.acc[from] as number;
  ds.memId.copyWithin(to * DRONE_MEMORY, from * DRONE_MEMORY, (from + 1) * DRONE_MEMORY);
  ds.memUntil.copyWithin(to * DRONE_MEMORY, from * DRONE_MEMORY, (from + 1) * DRONE_MEMORY);
  ds.until[to] = ds.until[from] as number;
  ds.spec[to] = ds.spec[from] as number;
  ds.depth[to] = ds.depth[from] as number;
  ds.origin[to] = ds.origin[from] as number;
  ds.hx[to] = ds.hx[from] as number;
  ds.hy[to] = ds.hy[from] as number;
  ds.roleDamage[to] = ds.roleDamage[from] as number;
  ds.roleSpeed[to] = ds.roleSpeed[from] as number;
  ds.size[to] = ds.size[from] as number;
  ds.surging[to] = ds.surging[from] as number;
}
