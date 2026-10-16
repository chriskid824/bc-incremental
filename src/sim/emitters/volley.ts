/**
 * The volley emitter (M1's attack): due attacks fire homing projectiles at targets picked by
 * src/sim/targeting.ts; the projectiles system moves them and resolves their hits. An attack is
 * counted (countAttack) and then fired (fireAttack), so a repeated attack can fire without
 * counting as an attack of its own (fireVolleyRepeat); the repeats waiting for an attack fire
 * right after it (drainRepeatCharges, src/sim/effects/execute.ts).
 */

import { ZERO } from '../../core/num';
import { PROJECTILE_CAP } from '../caps';
import { fire as fireTriggers } from '../effects/dispatch';
import { drainRepeatCharges } from '../effects/execute';
import { EVENT } from '../effects/types';
import { pickTargetInGrid } from '../targeting';
import { focused, rollCount } from '../systems/context';
import type { Enemy, Projectile, RunContext } from '../systems/context';
import { liveProjectiles } from '../systems/shots';
import type { EmitterRuntime, Payload } from './types';

/**
 * Fires every due attack of `em`, each followed by the repeats waiting for it. The accumulator
 * gains the emitter's cadence per tick; an attack is due each time it reaches the emitter's
 * interval. Without a target the emitter stays ready without banking attacks: it fires on the
 * tick a target appears.
 */
export function runVolley(ctx: RunContext, em: EmitterRuntime): void {
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
    fireAttack(ctx, em, target, 0, -1);
    drainRepeatCharges(ctx, em);
  }
}

/**
 * Counts an attack of `em` at `target`, its first target: its attack and volley serials,
 * steadyAim's every-Nth-attack rhythm, the onAttack hooks, which may make the whole attack
 * steady (ctx.shotScratch), then the nthAttack triggers at the target.
 */
export function countAttack(ctx: RunContext, em: EmitterRuntime, target: Enemy): void {
  em.attacks++;
  em.volley++;
  const { forceCritEvery, counts } = ctx.build.signature;
  em.steadyAttack = counts === 'attack' && forceCritEvery > 0 && em.attacks % forceCritEvery === 0;
  const shot = ctx.shotScratch;
  shot.forceCrit = false;
  for (const hook of ctx.build.hooks.onAttack) hook(ctx, em, shot);
  fireTriggers(ctx, EVENT.nthAttack, 0, -1, target, target.x, target.y, em.payload.flags, ZERO);
}

/**
 * Fires an attack of `em` at `first` with `payload`: projectileCount projectiles (its fraction
 * is the chance of one more, rolled on the payload's stream), each at its own target so they
 * spread over enemies; extra projectiles without a target are lost, and so are those
 * PROJECTILE_CAP refuses. Of a counted attack, each projectile fired counts as a shot and is
 * steady on steadyAim's every-Nth shot, or when the whole attack is; a repeat's (`counted`
 * false) count as no shot and are never steady. `depth` and `origin` travel with the
 * projectiles to their hits: 0 and −1 for an emitter's own attacks.
 */
export function fireAttack(
  ctx: RunContext,
  em: EmitterRuntime,
  first: Enemy,
  depth: number,
  origin: number,
  payload: Payload = em.payload,
  counted = true,
): void {
  const grid = ctx.grid;
  const player = ctx.player;
  const rng = payload.rng;
  const count = rollCount(ctx.projectileCount, (c) => rng.chance(c));
  const { forceCritEvery, counts } = ctx.build.signature;
  const every = counted && counts === 'shot' ? forceCritEvery : 0;
  const steadyAttack = counted && (em.steadyAttack || ctx.shotScratch.forceCrit);
  let target: Enemy | null = first;
  for (let n = 0; n < count && target !== null; n++) {
    target.volleyMark = em.volley;
    if (counted) em.shots++;
    const steady = (every > 0 && em.shots % every === 0) || steadyAttack;
    fire(ctx, payload, target, steady, depth, origin);
    if (n + 1 < count) {
      target = pickTargetInGrid(grid, player.x, player.y, ctx.shootableInVolley, focused);
    }
  }
}

/**
 * A repeat of the volley (REPEAT_STEPS, src/sim/effects/execute.ts): an attack of `em` with
 * payload `p` at a fresh target, as no attack of its own (fireAttack, not counted), its hits at
 * `depth` from trigger `origin`; nothing without a target.
 */
export function fireVolleyRepeat(
  ctx: RunContext,
  em: EmitterRuntime,
  p: Payload,
  depth: number,
  origin: number,
): void {
  const player = ctx.player;
  const target = pickTargetInGrid(ctx.grid, player.x, player.y, ctx.shootable, focused);
  if (target !== null) fireAttack(ctx, em, target, depth, origin, p, false);
}

function fire(
  ctx: RunContext,
  p: Payload,
  target: Enemy,
  steady: boolean,
  depth: number,
  origin: number,
): void {
  if (liveProjectiles(ctx) >= PROJECTILE_CAP) {
    ctx.counters.projectilesCapped++;
    return;
  }
  const player = ctx.player;
  target.inbound++;
  const projectile: Projectile = {
    id: ctx.nextProjectileId++,
    x: player.x,
    y: player.y,
    prevX: player.x,
    prevY: player.y,
    targetId: target.id,
    steady,
    alive: true,
    target,
    payload: p,
    depth,
    origin,
  };
  ctx.projectiles.push(projectile);
  ctx.events.push({ type: 'attack', projectileId: projectile.id, targetId: target.id });
}
