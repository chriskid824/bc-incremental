/**
 * The fan emitter (iceFan, src/sim/rules/iceFan.ts; docs/v3 C4 design §4.7). Each due round is
 * counted once (countAttack), at the target the volley's picker finds, and fires projectileCount
 * cones (its fraction the chance of one more, rolled on the payload's stream after the round is
 * counted), spread evenly over spreadDeg about the target: straight shots of the shot pool
 * (src/sim/systems/shots.ts) from the player at projectileSpeed, each hitting the first
 * pierce + 1 enemies on its line, for lifeTicks at most. Each cone of a counted round counts as a
 * shot for steadyAim (nextShotSteady); one that PROJECTILE_CAP refuses counts too, and ends the
 * round.
 *
 * A round is one attack, whose cones carry its serial (ShotPool.round): the first hit of its
 * cones in the projectile stage's order (tick, shot id, path parameter, enemy id) is its primary
 * hit, which begins the attack and runs the round's one chain (ShotPool.roundTaken); its other
 * cone hits count nothing in that chain's budget.
 *
 * Its forms (FanParams, src/sim/rules/fanForms.ts) change that: under 冰柱 every Nth round
 * counted fires one cone at the target instead, of the icicle payload (EmitterRuntime.alt, a
 * share of the damage stat of its own); under 稜鏡 every round fires one cone at the target
 * that passes through every enemy on its line, each hit scaled up by the enemies the cone passed
 * before it. Neither draws the count roll.
 *
 * A repeat of the attack (fireFanRepeat; repeatAttack, src/sim/effects/execute.ts) is a round
 * that counts as no attack: at a fresh target, of the repeat's payload, its count rolled on that
 * payload's stream, its cones never steady and counted as no shot; 稜鏡 applies, 冰柱 never
 * does. The repeats waiting for a round fire right after it (drainRepeatCharges).
 */

import type { FanParams } from '../build/compile';
import { drainRepeatCharges } from '../effects/execute';
import { pickTargetInGrid } from '../targeting';
import { focused, rollCount } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { MOTION_STRAIGHT, spawnShot } from '../systems/shots';
import { nextShotSteady } from './types';
import type { EmitterRuntime, FanSpec, Payload } from './types';
import { countAttack } from './volley';

/**
 * Fires every due round of `em`, a fan, each followed by the repeats waiting for it. The
 * accumulator gains the emitter's cadence per tick; a round is due each time it reaches the
 * emitter's interval. Without a target the emitter stays ready without banking rounds, as the
 * volley does (runVolley): it fires on the tick a target appears. Under 冰柱 the round counted
 * as every icicleEvery-th attack fires the icicle cone.
 */
export function runFan(ctx: RunContext, em: EmitterRuntime): void {
  const grid = ctx.grid;
  const player = ctx.player;
  const every = (ctx.build.signature.fan as FanParams).icicleEvery;
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
    // 冰柱 counts the round countAttack just counted.
    const icicle = every > 0 && em.attacks % every === 0;
    fireRound(ctx, em, target, icicle ? (em.alt as Payload) : em.payload, true, 0, -1);
    drainRepeatCharges(ctx, em);
  }
}

/**
 * A repeat of the fan (REPEAT_STEPS, src/sim/effects/execute.ts): a round of `em` with payload
 * `p` at a fresh target, as no attack of its own (fireRound, not counted), its hits at `depth`
 * from trigger `origin`; nothing without a target. 稜鏡 applies; 冰柱, per attack, never does.
 */
export function fireFanRepeat(
  ctx: RunContext,
  em: EmitterRuntime,
  p: Payload,
  depth: number,
  origin: number,
): void {
  const player = ctx.player;
  const target = pickTargetInGrid(ctx.grid, player.x, player.y, ctx.shootable, focused);
  if (target !== null) fireRound(ctx, em, target, p, false, depth, origin);
}

/**
 * Fires a round of `em`, a fan, at `target` with payload `p` (the fan's, its icicle payload or a
 * repeat's), as the fan round of the next serial (ShotPool.roundSerial): one cone straight at the
 * target for the icicle payload or under 稜鏡, else projectileCount cones (the fraction the
 * chance of one more, rolled on p's stream) spread evenly over spreadDeg about it. A cone hits
 * pierce + 1 enemies, under 稜鏡 every enemy on its line. Of a counted round each cone counts as
 * a shot and is steady by nextShotSteady; a repeat's (`counted` false) count as no shot and are
 * never steady. A cone PROJECTILE_CAP refuses ends the round. `depth` and `origin` travel with
 * the cones to their hits: 0 and −1 for the emitter's own rounds.
 */
export function fireRound(
  ctx: RunContext,
  em: EmitterRuntime,
  target: Enemy,
  p: Payload,
  counted: boolean,
  depth: number,
  origin: number,
): void {
  const spec = em.spec as FanSpec;
  const prism = (ctx.build.signature.fan as FanParams).prism !== null;
  const round = ++ctx.shots.roundSerial;
  // 冰柱's cone and 稜鏡's draw nothing for their count.
  let cones = 1;
  if (p !== em.alt && !prism) {
    const rng = p.rng;
    cones = rollCount(ctx.projectileCount, (c) => rng.chance(c));
  }
  const player = ctx.player;
  const x = player.x;
  const y = player.y;
  const theta = Math.atan2(target.y - y, target.x - x);
  const half = (spec.spreadDeg * Math.PI) / 360;
  const step = ctx.projectileStep;
  const until = ctx.now + spec.lifeTicks;
  const hits = prism ? -1 : spec.pierce + 1;
  for (let i = 0; i < cones; i++) {
    const steady = counted && nextShotSteady(ctx, em);
    const angle = cones === 1 ? theta : theta - half + (2 * half * i) / (cones - 1);
    const s = spawnShot(
      ctx,
      MOTION_STRAIGHT,
      x,
      y,
      Math.cos(angle) * step,
      Math.sin(angle) * step,
      until,
      p,
      1,
      hits,
      0,
      depth,
      origin,
      steady,
      round,
      em.index,
      null,
    );
    if (s < 0) break;
  }
}
