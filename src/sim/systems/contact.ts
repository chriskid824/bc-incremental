/**
 * Contact system (docs/v3/implementation-plan-v3.md §2.15): an enemy that reaches the player
 * first takes a hit from each of the build's thorns emitters (src/data/emitters.ts), in emitter
 * order, until one kills it. A survivor deals its contact damage and leaks, i.e. leaves the field
 * without a kill or drops; the touch then raises heroHit (no target, at the player) and contact
 * (on the touching enemy), and the leaked enemy gives its DoT rings back
 * (src/sim/ailments/apply.ts). An enemy the thorns kill dies as any hit's victim does, with its
 * drops and split, and never reaches the player: no life loss, leak or heroHit, only its contact
 * triggers, which find its ailments already released. Runs after movement; every enemy is still
 * alive here, since compaction ran last tick, but a treasure that escaped this tick, far outside
 * the arena (src/sim/systems/enemyAi.ts). The enemies that exist when it starts are the ones
 * it resolves: one added during it, such as a thorns kill's split children, touches from the
 * next tick. A survivor's contact damage, × its v3 record's contactMult in a v3 run (Enemy.v3,
 * src/sim/systems/enemyRecord.ts), goes through damagePlayer, the player's defences
 * (ctx.sys.defence, docs/v3 C7 design §2.2): contactDamageTaken scales it, the shield
 * (PlayerState.shield) takes it before life, and an extra life revives the player at
 * REVIVE_LIFE_FRAC of max life where the hit would end the run. Once every contact is resolved,
 * the player, if alive, regains a tick's share of lifeRegen (lifeRegen × max life × DT, up to
 * max life), and its life fraction is set for this tick's reads (lifeLostPct). A build with none
 * of these defences has a null ctx.sys.defence, and damagePlayer then runs M1's life loss alone.
 * A shooter's bullet (src/sim/systems/bullets.ts) goes through damagePlayer too, earlier in the
 * tick, as a BULLET: not a leak, and outside contactDamageTaken.
 */

import { ZERO } from '../../core/num';
import type { EnemyId } from '../../data/types';
import { releaseAilments } from '../ailments/apply';
import { hitWithPayload } from '../combat/hit';
import { fire } from '../effects/dispatch';
import { EVENT } from '../effects/types';
import type { EmitterRuntime } from '../emitters/types';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';

/** The share of max life an extra life restores (gd:265 「死時回 50% 生命」; 初始值). */
export const REVIVE_LIFE_FRAC = 0.5;

/** damagePlayer's `cause`: an enemy's contact (resolveContacts). */
export const CONTACT = 0;
/** damagePlayer's `cause`: a shooter's bullet (stepBullets, src/sim/systems/bullets.ts). */
export const BULLET = 1;

/**
 * The enemy `enemyId` of type `type` deals `amount` of damage to the player, who is alive: by
 * its contact (`cause` CONTACT, `bulletId` −1), or by its bullet `bulletId` (BULLET). With no
 * defence (ctx.sys.defence null, an M1 build) this is M1's life loss: life drops by `amount`,
 * the tally takes it, a hit that brings life to 0 sets killedBy, and playerHit is pushed. With
 * defences, in order: × contactTaken, for a contact only; the shield absorbs what it can, pushing
 * shieldAbsorbed; life loses the rest, which the tally and playerHit carry; a hit that brings
 * life to 0 with an extra life left revives the player at REVIVE_LIFE_FRAC of max life instead
 * of setting killedBy, so checkRunEnd sees it alive, and pushes revive after its playerHit, whose
 * lifeLeft stays 0. A fully absorbed contact still pushes playerHit, with damage 0: it leaks. A
 * bullet takes the same steps, its tally ctx.sys.bullets.takenBy instead of ctx.taken and its
 * event bulletHit in playerHit's place; it is no leak (docs/v3 C7 design §2.6).
 */
export function damagePlayer(
  ctx: RunContext,
  enemyId: number,
  type: EnemyId,
  amount: number,
  cause: typeof CONTACT | typeof BULLET,
  bulletId: number,
): void {
  const player = ctx.player;
  const tally = cause === CONTACT ? ctx.taken[type] : ctx.sys.bullets.takenBy[type];
  const defence = ctx.sys.defence;
  // Both paths: a contact tallies in ctx.taken and pushes playerHit; a bullet tallies in
  // sys.bullets.takenBy and pushes bulletHit in playerHit's place. The full path scales a contact
  // alone by contactTaken; the shield, the life loss, killedBy and the revive take either alike.
  if (defence === null) {
    player.life = Math.max(0, player.life - amount);
    tally.hits++;
    tally.damage += amount;
    if (player.life <= 0) ctx.killedBy = type;
    if (cause === CONTACT) {
      ctx.events.push({ type: 'playerHit', enemyId, damage: amount, lifeLeft: player.life });
    } else {
      ctx.events.push({
        type: 'bulletHit',
        bulletId,
        enemyId,
        enemy: type,
        damage: amount,
        lifeLeft: player.life,
      });
    }
    return;
  }
  let rest = cause === CONTACT ? amount * defence.contactTaken : amount;
  const absorbed = Math.min(player.shield, rest);
  if (absorbed > 0) {
    player.shield -= absorbed;
    rest -= absorbed;
    ctx.events.push({ type: 'shieldAbsorbed', amount: absorbed, shieldLeft: player.shield });
  }
  player.life = Math.max(0, player.life - rest);
  tally.hits++;
  tally.damage += rest;
  const lifeLeft = player.life;
  const revives = lifeLeft <= 0 && defence.livesLeft > 0;
  if (revives) {
    defence.livesLeft--;
    player.life = REVIVE_LIFE_FRAC * player.maxLife;
  } else if (lifeLeft <= 0) {
    ctx.killedBy = type;
  }
  if (cause === CONTACT) {
    ctx.events.push({ type: 'playerHit', enemyId, damage: rest, lifeLeft });
  } else {
    ctx.events.push({ type: 'bulletHit', bulletId, enemyId, enemy: type, damage: rest, lifeLeft });
  }
  if (revives) {
    ctx.events.push({ type: 'revive', lifeLeft: player.life, livesLeft: defence.livesLeft });
  }
}

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
      // Its contact damage, × its v3 record's contactMult (1 until C7.6's 狂暴; an M1 run's
      // enemies have no record), then the leak: removeEnemy pushes no event, so playerHit keeps
      // its place in M1's event order.
      const damage = enemy.def.contactDamage;
      const v3 = enemy.v3;
      damagePlayer(
        ctx,
        enemy.id,
        enemy.type,
        v3 === null ? damage : damage * v3.contactMult,
        CONTACT,
        -1,
      );
      enemy.rec.leaked = true;
      removeEnemy(ctx, enemy);
      fire(ctx, EVENT.heroHit, 0, -1, null, player.x, player.y, 0, ZERO);
      fire(ctx, EVENT.contact, 0, -1, enemy, enemy.x, enemy.y, 0, ZERO);
      // After its contact triggers, whose conditions see what it held as it touched.
      releaseAilments(ctx, enemy);
    }
  }
  // Regeneration, after every contact and only while alive: a death without an extra life
  // stays at 0 for checkRunEnd.
  const defence = ctx.sys.defence;
  if (defence !== null && player.life > 0) {
    player.life = Math.min(player.maxLife, player.life + defence.regenPerTick);
  }
  ctx.evalInput.playerLifeFrac = player.life / player.maxLife;
}
