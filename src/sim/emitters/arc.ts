/**
 * The arc emitter (triphaseArc, src/sim/rules/triphaseArc.ts; docs/v3 C4 design §4.8). Each due
 * discharge is counted once (countAttack) at the target the volley's picker finds, at any range,
 * and strikes it at once: its primary hit, then its chain, on the general chain path
 * (chainGeneral, src/sim/combat/policy.ts), whose jumps raise the chainJump center event. A
 * discharge is one attack and one shot for steadyAim (nextShotSteady); its coils take turns
 * (EmitterRuntime.coil), and it raises a discharge event at each target before its hit.
 *
 * Under 六線圈 (ArcParams.targets 2) a discharge strikes two distinct targets, both picked before
 * either is hit, the second by the picker that spreads a volley's projectiles, among the other
 * enemies: two primary hits, each counting 1 in the attack's budget, then one chain from both,
 * its jumps rolled once, so the two share CHAIN_HIT_CAP. Without another enemy alive it strikes
 * the first alone.
 *
 * A repeat of the attack (fireArcRepeat; repeatAttack, src/sim/effects/execute.ts) is a
 * discharge that counts as no attack: at a fresh target, of the repeat's payload, never steady,
 * its chain rolled on that payload's stream; 六線圈 applies, and its jumps raise no chainJump
 * (the repeat's payload does not raise it). The repeats waiting for a discharge fire right after
 * it (drainRepeatCharges).
 */

import type { ArcParams } from '../build/compile';
import { beginAttack, endAttack, primaryHit } from '../combat/chain';
import { chainGeneral } from '../combat/policy';
import { drainRepeatCharges } from '../effects/execute';
import { pickTargetInGrid } from '../targeting';
import { focused, rollCount } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { nextShotSteady } from './types';
import type { EmitterRuntime, Payload } from './types';
import { countAttack } from './volley';

/**
 * Fires every due discharge of `em`, an arc, each followed by the repeats waiting for it. The
 * accumulator gains the emitter's cadence per tick; a discharge is due each time it reaches the
 * emitter's interval. Without a target the emitter stays ready without banking discharges, as the
 * volley does (runVolley): it fires on the tick a target appears.
 */
export function runArc(ctx: RunContext, em: EmitterRuntime): void {
  const grid = ctx.grid;
  const player = ctx.player;
  const interval = em.interval;
  em.acc += em.cadence;
  while (em.acc >= interval) {
    const target = pickTargetInGrid(grid, player.x, player.y, ctx.shootable, focused);
    if (target === null) {
      em.acc = interval - em.cadence;
      return;
    }
    em.acc -= interval;
    countAttack(ctx, em, target);
    fireDischarge(ctx, em, target, em.payload, nextShotSteady(ctx, em), 0, -1);
    drainRepeatCharges(ctx, em);
  }
}

/**
 * A repeat of the arc (REPEAT_STEPS, src/sim/effects/execute.ts): a discharge of `em` with
 * payload `p` at a fresh target, as no attack of its own (fireDischarge, never steady), its hits
 * at `depth` from trigger `origin`; nothing without a target. 六線圈 applies.
 */
export function fireArcRepeat(
  ctx: RunContext,
  em: EmitterRuntime,
  p: Payload,
  depth: number,
  origin: number,
): void {
  const player = ctx.player;
  const target = pickTargetInGrid(ctx.grid, player.x, player.y, ctx.shootable, focused);
  if (target !== null) fireDischarge(ctx, em, target, p, false, depth, origin);
}

/**
 * A discharge of `em`, an arc, at `first` with payload `p` (the arc's or a repeat's), as one
 * attack: under 六線圈 a second target too, picked before either is hit, as a volley picks its
 * next projectile's (shootableInVolley) but among the enemies other than `first`, at which that
 * pick would aim again when `first` is a focus target or the only enemy. Each target, in pick
 * order, raises a discharge event from the next coil and takes a primary hit; then one chain of
 * p from both, its jumps rolled once on p's stream. `steady` makes every hit crit (steadyAim);
 * `depth` and `origin` are the hits' trigger depth and the trigger they come from: 0 and −1 for
 * the emitter's own.
 */
export function fireDischarge(
  ctx: RunContext,
  em: EmitterRuntime,
  first: Enemy,
  p: Payload,
  steady: boolean,
  depth: number,
  origin: number,
): void {
  const arc = ctx.build.signature.arc as ArcParams;
  beginAttack(ctx);
  const roots = ctx.sys.chain.frontier;
  roots[0] = first;
  let nRoots = 1;
  if (arc.targets === 2) {
    // Both targets are picked before either is hit, and are two (C13): first sits the second
    // pick out, which would pick it again were it a focus target or the only enemy. Only the
    // pure picker runs while first is not alive.
    first.volleyMark = em.volley;
    first.alive = false;
    const player = ctx.player;
    const second = pickTargetInGrid(ctx.grid, player.x, player.y, ctx.shootableInVolley, focused);
    first.alive = true;
    if (second !== null) roots[nRoots++] = second;
  }
  const events = ctx.events;
  for (let r = 0; r < nRoots; r++) {
    const target = roots[r] as Enemy;
    events.push({ type: 'discharge', coil: em.coil, targetId: target.id });
    em.coil = (em.coil + 1) % arc.coils;
    primaryHit(ctx, p, target, 1, steady, depth, origin);
  }
  const rng = p.rng;
  const jumps = rollCount(ctx.chainCount, (c) => rng.chance(c));
  chainGeneral(ctx, p, roots, nRoots, jumps, steady, depth, origin);
  endAttack(ctx);
}
