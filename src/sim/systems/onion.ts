/**
 * The onion boss (洋蔥, docs/v3 C7 design §2.8, gd:722 「三層外殼，每打碎一層噴出一波三角」): a
 * def with a `layers` behaviour spawns in a v3 run with one shell's share of its hpMult
 * (addEnemy, src/sim/systems/spawn.ts) and its record's layersLeft at its layer count. Every
 * enemy hp write that can kill is one of two (B content must never write enemy.hp elsewhere), so
 * the shells break at their two lethal tests, which call onionBreak first while layersLeft > 0:
 * - a hit's, in applyHitDamage (src/sim/combat/hit.ts), which every hit path reaches: emitter
 *   hits, chains, thorns, effect hits, shatters, coin hits, drone impacts and pulses (hitPulse,
 *   src/sim/systems/zones.ts);
 * - a damage-over-time step's, in dealDot (src/sim/systems/ailments.ts): burn, poison and bleed.
 * A break that leaves a shell is no kill: the onion lives on at full life, the damage past its
 * shell discarded (lead ruling L6), so one lethal event breaks one shell; it keeps its ailments,
 * frost and shock, and pays its drops once, at the kill the last break falls through to
 * (killEnemy, src/sim/systems/death.ts).
 */

import type { EnemyBehaviour } from '../../data/types';
import type { Enemy, RunContext } from './context';
import { EXTRA_ORIGIN } from './enemyRecord';
import type { EnemyV3 } from './enemyRecord';
import { spawnOrSkip } from './spawn';

const TAU = Math.PI * 2;

type LayersBehaviour = Extract<EnemyBehaviour, { readonly kind: 'layers' }>;

/**
 * Breaks a shell of `onion`, whose hp a hit or a damage-over-time step has just taken to 0 or
 * below and whose record holds layersLeft > 0: layersLeft goes down one, then its burst's
 * `count` of its burst's enemy spray around it, each drawing its angle on the split stream
 * first, so the stream never depends on how full the field is, placed on the onion's rim as
 * split's children are (src/sim/systems/spawn.ts), then going through spawnOrSkip in the
 * onion's wave with EXTRA_ORIGIN (outside composeWave's count, no affix): past the enemy cap a
 * child is skipped and counted (enemySpawnsSkipped), and the shell breaks all the same. Then
 * onionLayer. True when a shell remains: its hp is back at maxHp and the caller treats the
 * damage as a surviving one. False for the last shell, which bursts too: the caller kills it.
 */
export function onionBreak(ctx: RunContext, onion: Enemy): boolean {
  const v = onion.v3 as EnemyV3;
  const layersLeft = --v.layersLeft;
  const burst = (onion.def.behaviour as LayersBehaviour).burst;
  const def = ctx.data.enemies[burst.enemy];
  const player = ctx.player;
  for (let i = 0; i < burst.count; i++) {
    const angle = ctx.splitRng.range(0, TAU);
    const dx = onion.x + Math.cos(angle) * onion.radius - player.x;
    const dy = onion.y + Math.sin(angle) * onion.radius - player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0) spawnOrSkip(ctx, def, onion.rec, dx / dist, dy / dist, dist, EXTRA_ORIGIN);
    else spawnOrSkip(ctx, def, onion.rec, 1, 0, 0, EXTRA_ORIGIN);
  }
  ctx.events.push({
    type: 'onionLayer',
    enemyId: onion.id,
    layersLeft,
    x: onion.x,
    y: onion.y,
  });
  if (layersLeft > 0) {
    onion.hp = onion.maxHp;
    return true;
  }
  return false;
}
