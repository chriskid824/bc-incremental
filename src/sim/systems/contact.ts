/**
 * Contact system (docs/v3/implementation-plan-v3.md §2.15): an enemy that reaches the player
 * deals its contact damage and leaks, i.e. leaves the field without a kill or drops. Each touch
 * then raises heroHit (no target, at the player) and contact (on the touching enemy). Runs after
 * movement; every enemy is still alive here, since compaction ran last tick. Once every contact
 * is resolved, the player's life fraction is set for this tick's reads (lifeLostPct).
 */

import { ZERO } from '../../core/num';
import { fire } from '../effects/dispatch';
import { EVENT } from '../effects/types';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';

export function resolveContacts(ctx: RunContext): void {
  const enemies = ctx.enemies;
  const player = ctx.player;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Enemy;
    if (enemy.dist <= enemy.contactDist && player.life > 0) {
      // The touching enemy's thorns hits come first (C4); a kill there ends its contact.
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
    }
  }
  ctx.evalInput.playerLifeFrac = player.life / player.maxLife;
}
