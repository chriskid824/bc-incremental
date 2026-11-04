/**
 * 稜鏡's reflection (docs/v3/game-design-v3.md §6.3: 「每 5 秒切換 2 秒『反射』：擊中傷害反彈給角色，
 * 異常狀態不反彈」). The enemy AI step opens and closes its windows (stepReflect,
 * src/sim/systems/enemyAi.ts, which sets REFLECTING); here a hit it takes during one is turned on
 * the player.
 *
 * A hit's raw damage is on a 1e9+ scale while the player has about 100 life, so the raw number is
 * never reflected. Each hit that lands damage above 0 on a REFLECTING prism (applyHitDamage,
 * src/sim/combat/hit.ts: an emitter hit, a chain jump, an effect hit or a pulse's hit) deals the
 * player lifePctPerHit of the player's max life, while the second of the window it falls in has
 * reflected less than maxLifePctPerSec of max life; the last hit of a second deals what is left of
 * that. Both are its behaviour's numbers (src/data/enemiesV3.ts, 初始值: 1 % a hit, 10 % a
 * second). Seconds count from the window's start, in ticks, frozen or not. Ailment ticks (burn,
 * poison, bleed) are no hit and never reach this, nor does a hit its defences block in full.
 *
 * The damage goes through damagePlayer as a REFLECT (src/sim/systems/contact.ts): the shield takes
 * it first, an extra life revives, a death sets killedBy to the prism's type, and it is tallied in
 * ctx.sys.enemyAi.reflectTakenBy (RunResult.reflectTakenBy) with a reflectHit event. It is not a
 * contact: no contactDamageTaken, no leak, no heroHit and no combo loss. Nothing here draws.
 */

import type { EnemyBehaviour } from '../../data/types';
import { TICK_RATE } from '../types';
import { damagePlayer, REFLECT } from './contact';
import type { Enemy, RunContext } from './context';
import type { EnemyV3 } from './enemyRecord';

type ReflectBehaviour = Extract<EnemyBehaviour, { readonly kind: 'reflect' }>;

/**
 * A hit that landed damage above 0 on `prism`, REFLECTING: its bounded reflection on the player,
 * if the player is alive and the second's budget has room. Returns the damage before the shield,
 * 0 for none.
 */
export function reflectHit(ctx: RunContext, prism: Enemy, v: EnemyV3): number {
  const player = ctx.player;
  if (player.life <= 0) return 0;
  const behaviour = prism.def.behaviour as ReflectBehaviour;
  const now = ctx.now;
  if (now - v.reflectSecStart >= TICK_RATE) {
    v.reflectSecStart += Math.floor((now - v.reflectSecStart) / TICK_RATE) * TICK_RATE;
    v.reflectSecSum = 0;
  }
  const share = Math.min(behaviour.lifePctPerHit, behaviour.maxLifePctPerSec - v.reflectSecSum);
  // A hair above 0, so that float noise in the sum never deals a sliver past the budget.
  if (!(share > 1e-9)) return 0;
  v.reflectSecSum += share;
  const amount = share * player.maxLife;
  damagePlayer(ctx, prism.id, prism.type, amount, REFLECT, -1);
  return amount;
}
