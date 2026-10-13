/**
 * Contact system (docs/v3/implementation-plan-v3.md §2.15): an enemy that reaches the player
 * deals its contact damage and leaks, i.e. leaves the field without a kill or drops.
 * Runs after movement; every enemy is still alive here, since compaction ran last tick.
 */

import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';

export function resolveContacts(ctx: RunContext): void {
  const enemies = ctx.enemies;
  const player = ctx.player;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Enemy;
    if (enemy.dist <= enemy.contactDist && player.life > 0) {
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
    }
  }
}
