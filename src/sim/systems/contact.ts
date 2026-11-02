/**
 * Contact system (docs/v3/implementation-plan-v3.md §2.15): an enemy that reaches the player
 * first takes a hit from each of the build's thorns emitters (src/data/emitters.ts), in emitter
 * order, until one kills it. A survivor deals its contact damage and leaks, i.e. leaves the field
 * without a kill or drops; the touch then halves the combo stacks when the build keeps them
 * (src/sim/systems/combo.ts), raises heroHit (no target, at the player) and contact (on the
 * touching enemy), and the leaked enemy gives its DoT rings back
 * (src/sim/ailments/apply.ts). An enemy the thorns kill dies as any hit's victim does, with its
 * drops and split, and never reaches the player: no life loss, leak or heroHit, only its contact
 * triggers, which find its ailments already released. Runs after movement; every enemy is still
 * alive here, since compaction ran last tick, but a treasure that escaped this tick, far outside
 * the arena (src/sim/systems/enemyAi.ts), and an enemy the AI stage's C7b hooks killed (a held
 * boss stays ENTANGLED, which this step skips). The enemies that exist when it starts are the ones
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
 *
 * C7b's two contact hooks (docs/v3 C7 design §2.10) act on a v3 enemy that survives its thorns,
 * behind the per-contact `enemy.v3` test, so an M1 enemy pays none of them. 拒馬 (dashRepel above
 * 0): a DASHING enemy deals nothing and does not leak; it raises its contact triggers, then is
 * pushed dashRepel further out and walks in again, to charge anew at its chargeDist. 荊棘纏繞
 * (EnemyAiState.holdTicks 0 or more, from bossHoldSec): a boss raises its contact triggers and is
 * held instead (ENTANGLED, its step 0) for holdTicks, skipped here meanwhile; the enemy AI step
 * (stepHold) gives it a round of the thorns hits every HOLD_ROUND_TICKS of unfrozen time after
 * the touch's, and at the hold's end, if both live, its contact damage and its leak, without a
 * second contact trigger. A boss the thorns kill while held costs no life and does not leak.
 */

import { ZERO } from '../../core/num';
import type { EnemyId } from '../../data/types';
import { releaseAilments } from '../ailments/apply';
import { hitWithPayload } from '../combat/hit';
import { fire } from '../effects/dispatch';
import { EVENT } from '../effects/types';
import type { EmitterRuntime } from '../emitters/types';
import { loseComboOnHit } from './combo';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';
import { DASHING, ENTANGLED } from './enemyRecord';
import type { EnemyV3 } from './enemyRecord';
import { rebuildGrid } from './grid';

/** The share of max life an extra life restores (gd:265 「死時回 50% 生命」; 初始值). */
export const REVIVE_LIFE_FRAC = 0.5;

/** 荊棘纏繞's rounds of thorns hits: one every this many ticks of a hold (gd:467 「每 0.25 秒」). */
export const HOLD_ROUND_TICKS = 15;

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

/**
 * The thorns hits of an enemy at the player: a hit from each of the build's thorns emitters, in
 * emitter order, until one kills it; emitter hits on the combat stream, none of them an attack.
 */
function thornsHits(ctx: RunContext, enemy: Enemy): void {
  const thorns = ctx.thornsEmitters;
  for (let t = 0; t < thorns.length && enemy.alive; t++) {
    const p = (thorns[t] as EmitterRuntime).payload;
    hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, 0, -1);
  }
}

/**
 * The leak of `enemy`, alive at the player once its contact damage is dealt: it leaves the field
 * without a kill or drops (removeEnemy pushes no event, so playerHit keeps its place in M1's
 * event order), then the touch halves the combo stacks when the build keeps them, and heroHit is
 * raised at the player. Its caller then gives its ailments back (releaseAilments), after the
 * contact triggers of a touch.
 */
function leak(ctx: RunContext, enemy: Enemy): void {
  const player = ctx.player;
  enemy.rec.leaked = true;
  removeEnemy(ctx, enemy);
  if (ctx.build.flags.combo) loseComboOnHit(ctx);
  fire(ctx, EVENT.heroHit, 0, -1, null, player.x, player.y, 0, ZERO);
}

export function resolveContacts(ctx: RunContext): void {
  const enemies = ctx.enemies;
  const player = ctx.player;
  const count = enemies.length;
  for (let i = 0; i < count; i++) {
    const enemy = enemies[i] as Enemy;
    if (enemy.dist <= enemy.contactDist && player.life > 0) {
      // A v3 run's enemy, with its record's contactMult and C7b's hooks; an M1 run's has none.
      const v3 = enemy.v3;
      if (v3 !== null) {
        touchV3(ctx, enemy, v3);
        continue;
      }
      // The thorns hits come first.
      thornsHits(ctx, enemy);
      if (!enemy.alive) {
        // Killed at the touch: its kill already released its ailments.
        fire(ctx, EVENT.contact, 0, -1, enemy, enemy.x, enemy.y, 0, ZERO);
        continue;
      }
      damagePlayer(ctx, enemy.id, enemy.type, enemy.def.contactDamage, CONTACT, -1);
      leak(ctx, enemy);
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

/**
 * The touch of a v3 enemy `enemy`, whose record is `v`: resolveContacts' statements, with its
 * contact damage × v.contactMult (1 until C7.6's 狂暴), and C7b's hooks on a survivor of the
 * thorns. A boss that 荊棘纏繞 holds (ENTANGLED) is the AI step's until its hold ends. 拒馬 takes a
 * DASHING survivor, else 荊棘纏繞 a boss; either raises its contact triggers at the touch, so
 * their conditions see it as it touched, and deals nothing.
 */
function touchV3(ctx: RunContext, enemy: Enemy, v: EnemyV3): void {
  if ((v.state & ENTANGLED) !== 0) return;
  thornsHits(ctx, enemy);
  if (!enemy.alive) {
    fire(ctx, EVENT.contact, 0, -1, enemy, enemy.x, enemy.y, 0, ZERO);
    return;
  }
  const ai = ctx.sys.enemyAi;
  if ((v.state & DASHING) !== 0 && ai.dashRepel > 0) {
    fire(ctx, EVENT.contact, 0, -1, enemy, enemy.x, enemy.y, 0, ZERO);
    repel(ctx, enemy, v, ai.dashRepel);
    return;
  }
  if (enemy.boss && ai.holdTicks >= 0) {
    fire(ctx, EVENT.contact, 0, -1, enemy, enemy.x, enemy.y, 0, ZERO);
    entangle(ctx, enemy, v, ai.holdTicks);
    return;
  }
  damagePlayer(ctx, enemy.id, enemy.type, enemy.def.contactDamage * v.contactMult, CONTACT, -1);
  leak(ctx, enemy);
  fire(ctx, EVENT.contact, 0, -1, enemy, enemy.x, enemy.y, 0, ZERO);
  releaseAilments(ctx, enemy);
}

/**
 * 拒馬 (gd:468 「被彈回 80」): the dashing `enemy` is pushed `distance` further out along its
 * bearing and goes back to walking in (state 0, its walk step), so the AI step charges it again
 * once it is within its chargeDist; its stateUntil is the next charge's to set. The grid is
 * rebuilt, as a push effect does, so this tick's later queries see where it went.
 */
function repel(ctx: RunContext, enemy: Enemy, v: EnemyV3, distance: number): void {
  const player = ctx.player;
  enemy.dist += distance;
  enemy.x = player.x + enemy.ux * enemy.dist;
  enemy.y = player.y + enemy.uy * enemy.dist;
  v.state = 0;
  enemy.stepDist = v.baseStep;
  rebuildGrid(ctx);
}

/**
 * 荊棘纏繞 (gd:467 「Boss 碰到你時被定住 1 秒」): the boss stands ENTANGLED at the player (its
 * step 0) until `holdTicks` from now, and joins the AI step's list in its id order if it is not
 * on it, so that the step runs its hold (stepHold) and its frozen ticks push the hold's end back
 * as they push every AI timer. The list's walk drops it once it is dead or gone.
 */
function entangle(ctx: RunContext, enemy: Enemy, v: EnemyV3, holdTicks: number): void {
  v.state = ENTANGLED;
  v.stateUntil = ctx.now + holdTicks;
  enemy.stepDist = 0;
  const list = ctx.sys.enemyAi.list;
  const id = enemy.id;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((list[mid] as Enemy).id < id) lo = mid + 1;
    else hi = mid;
  }
  if (list[lo] !== enemy) list.splice(lo, 0, enemy);
}

/**
 * A tick of 荊棘纏繞's hold on the boss `enemy` (ENTANGLED), whose record is `v`, from the enemy
 * AI step on its unfrozen ticks; `holdTicks` is the hold's length (EnemyAiState.holdTicks). At
 * the hold's end (stateUntil), while the player lives: its contact damage × v.contactMult through
 * damagePlayer, then its leak (leak, releaseAilments) without a second contact trigger. Before
 * it, after each HOLD_ROUND_TICKS of the hold, a round of the touch's thorns hits: with a hold of
 * 60 ticks from a touch at tick t, rounds at t + 15, t + 30 and t + 45 beside the touch's own,
 * and the life loss at t + 60. A frozen tick pushes stateUntil back one (the AI step's frozen
 * branch) and so the rounds and the end. The grid is rebuilt first, since last tick's compaction
 * left it stale and the hits' and heroHit's triggers query it.
 */
export function stepHold(
  ctx: RunContext,
  enemy: Enemy,
  v: EnemyV3,
  now: number,
  holdTicks: number,
): void {
  if (now >= v.stateUntil) {
    if (ctx.player.life <= 0) return;
    rebuildGrid(ctx);
    damagePlayer(ctx, enemy.id, enemy.type, enemy.def.contactDamage * v.contactMult, CONTACT, -1);
    leak(ctx, enemy);
    releaseAilments(ctx, enemy);
    return;
  }
  const held = holdTicks - (v.stateUntil - now);
  if (held > 0 && held % HOLD_ROUND_TICKS === 0) {
    rebuildGrid(ctx);
    thornsHits(ctx, enemy);
  }
}
