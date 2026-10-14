/**
 * Contact system (docs/v3/implementation-plan-v3.md §2.15): an enemy that reaches the player
 * first takes a hit from each of the build's thorns emitters (src/data/emitters.ts), in emitter
 * order, until one kills it. A survivor deals its contact damage and leaks, i.e. leaves the field
 * without a kill or drops; the touch then raises heroHit (no target, at the player) and contact
 * (on the touching enemy), and the leaked enemy gives its DoT rings back
 * (src/sim/ailments/apply.ts). An enemy the thorns kill dies as any hit's victim does, with its
 * drops and split, and never reaches the player: no life loss, leak or heroHit, only its contact
 * triggers, which find its ailments already released. Runs after movement; every enemy is still
 * alive here, since compaction ran last tick. The enemies that exist when it starts are the ones
 * it resolves: one added during it, such as a thorns kill's split children, touches from the
 * next tick. Once every contact is resolved, the player's life fraction is set for this tick's
 * reads (lifeLostPct).
 */

import { ZERO } from '../../core/num';
import { releaseAilments } from '../ailments/apply';
import { hitWithPayload } from '../combat/hit';
import { fire } from '../effects/dispatch';
import { EVENT } from '../effects/types';
import type { EmitterRuntime } from '../emitters/types';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';

export function resolveContacts(ctx: RunContext): void {
  const enemies = ctx.enemies;
  const player = ctx.player;
  const thorns = ctx.thornsEmitters;
  const count = enemies.length;
  for (let i = 0; i < count; i++) {
    const enemy = enemies[i] as Enemy;
    if (enemy.dist <= enemy.contactDist && player.life > 0) {
      // The thorns hits come first: emitter hits on the combat stream, none of them an attack.
      for (let t = 0; t < thorns.length && enemy.alive; t++) {
        const p = (thorns[t] as EmitterRuntime).payload;
        hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, 0, -1);
      }
      if (!enemy.alive) {
        // Killed at the touch: its kill already released its ailments.
        fire(ctx, EVENT.contact, 0, -1, enemy, enemy.x, enemy.y, 0, ZERO);
        continue;
      }
      // The life loss, until the player can block or reduce it (C7).
      const damageTaken = enemy.def.contactDamage;
      player.life = Math.max(0, player.life - damageTaken);
      const tally = ctx.taken[enemy.type];
      tally.hits++;
      tally.damage += damageTaken;
      if (player.life <= 0) ctx.killedBy = enemy.type;
      enemy.rec.leaked = true;
      removeEnemy(ctx, enemy);
      ctx.events.push({
        type: 'playerHit',
        enemyId: enemy.id,
        damage: damageTaken,
        lifeLeft: player.life,
      });
      fire(ctx, EVENT.heroHit, 0, -1, null, player.x, player.y, 0, ZERO);
      fire(ctx, EVENT.contact, 0, -1, enemy, enemy.x, enemy.y, 0, ZERO);
      // After its contact triggers, whose conditions see what it held as it touched.
      releaseAilments(ctx, enemy);
    }
  }
  ctx.evalInput.playerLifeFrac = player.life / player.maxLife;
}
