/**
 * Hits (docs/v3/implementation-plan-v3.md §2.15, docs/GDD.md §2–3): a shared function, not a
 * phase. A projectile that arrives resolves its attack at once: the primary hit, then
 * instant chain jumps; each hit rolls crit and ignite, deals damage, and kills or ignites.
 */

import { add, assertFinite, gt, lte, mul, sub, ZERO } from '../../core/num';
import { DAMAGE_TAG_BIT } from '../../data/stats';
import { addBurn } from './burn';
import { clamp01, rollCount } from './context';
import type { Enemy, RunContext } from './context';
import { killEnemy } from './death';

const HIT = DAMAGE_TAG_BIT.hit;
const CRIT = DAMAGE_TAG_BIT.crit;
const CHAIN = DAMAGE_TAG_BIT.chain;

/** Alive enemy closest to (x, y) within chain range not hit by the current attack. */
function nearestChainTarget(ctx: RunContext, x: number, y: number): Enemy | null {
  const enemies = ctx.enemies;
  const attackSerial = ctx.attackSerial;
  let best: Enemy | null = null;
  let bestDistSq = ctx.chainRangeSq;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Enemy;
    if (!enemy.alive || enemy.hitMark === attackSerial) continue;
    const dx = enemy.x - x;
    const dy = enemy.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq || (distSq === bestDistSq && best === null)) {
      best = enemy;
      bestDistSq = distSq;
    }
  }
  return best;
}

/**
 * Primary hit, then instant chain jumps from the last hit position. A steady shot
 * (steadyAim) crits on every hit, chain jumps included.
 */
export function resolveAttack(ctx: RunContext, primary: Enemy, steady: boolean): void {
  ctx.attackSerial++;
  hitEnemy(ctx, primary, 0, 1, null, null, steady);
  const jumps = rollCount(ctx.chainCount, (p) => ctx.combatRng.chance(p));
  let fromX = primary.x;
  let fromY = primary.y;
  let retention = 1;
  for (let k = 1; k <= jumps; k++) {
    const next = nearestChainTarget(ctx, fromX, fromY);
    if (next === null) break;
    retention *= ctx.chainRetention;
    hitEnemy(ctx, next, k, retention, fromX, fromY, steady);
    fromX = next.x;
    fromY = next.y;
  }
}

function hitEnemy(
  ctx: RunContext,
  enemy: Enemy,
  chainIndex: number,
  retention: number,
  fromX: number | null,
  fromY: number | null,
  steady: boolean,
): void {
  const fx = ctx.fx;
  // steadyAim sets critChance to 0 and also turns off chainCritChance's random crits.
  const chance =
    fx.steadyAimEvery > 0 ? 0 : clamp01(ctx.critChance + fx.chainCritPerJump * chainIndex);
  const crit = ctx.combatRng.chance(chance) || steady;
  let ignite = ctx.igniteChance;
  if (crit) ignite += fx.critIgniteChance;
  if (chainIndex > 0) ignite += fx.chainIgniteChance;
  const ignites = ctx.combatRng.chance(clamp01(ignite)) || (crit && fx.critsAlwaysIgnite);
  const baseHit = mul(ctx.damage, (crit ? ctx.critMultiplier : 1) * retention);
  const mask = HIT | (crit ? CRIT : 0) | (chainIndex > 0 ? CHAIN : 0);
  const amount = assertFinite(
    mul(baseHit, (ctx.damageMult[mask] as number) * (crit ? ctx.critHitMult : ctx.plainHitMult)),
    'hit damage',
  );
  enemy.hp = sub(enemy.hp, amount);
  enemy.hitMark = ctx.attackSerial;
  if (crit) ctx.damageCrit = add(ctx.damageCrit, amount);
  else if (chainIndex > 0) ctx.damageChain = add(ctx.damageChain, amount);
  else ctx.damageHit = add(ctx.damageHit, amount);
  if (gt(amount, ctx.maxHit)) ctx.maxHit = amount;
  ctx.events.push({
    type: 'hit',
    targetId: enemy.id,
    x: enemy.x,
    y: enemy.y,
    amount,
    crit,
    chainIndex,
    fromX,
    fromY,
  });
  if (lte(enemy.hp, ZERO)) {
    killEnemy(ctx, enemy);
  } else if (ignites && ctx.burnTicks > 0) {
    addBurn(
      ctx,
      enemy,
      mul(baseHit, ctx.burnDamage * (crit ? ctx.burnCritMult : ctx.burnMult)),
      ctx.now + ctx.burnTicks,
    );
  }
}
