/**
 * The enemy AI step (docs/v3 C7 design §2.5, §2.6): what v3 enemies do each tick beyond walking
 * in. It runs in a v3 run only (ctx.sys.enemyAi.enabled), after the spawn stage and before
 * movement, so before any hit of the tick. It walks EnemyAiState.list, the enemies with work, in
 * id order, and drops the dead ones from it in place, so a dead enemy never acts. A frozen
 * enemy's timers pause (EnemyV3.stateUntil and nextAct move on a tick) and it does not act, but
 * it still regenerates; any other enemy regenerates, then acts:
 * - regeneration (gd:692): v3.regen of its max life a second × enemyRegen, read on the untagged
 *   center row against the regenerating enemy, so B1's conditional modifiers (凍結生機, 凍瘡,
 *   抗凝) multiply it; none while it holds burn (gd:53), records or rings;
 * - the dasher (衝刺者, gd:693): it walks in to chargeDist, stands charging for chargeSec
 *   (CHARGING | STOPPED: dasherCharge, and chargeStarts for the drones' stage of the same tick),
 *   then dashes at dashMult × its step (DASHING: dasherDash) until contact or death; slows scale
 *   the dash in movement, and a push keeps its state;
 * - the treasure (寶藏怪, gd:691): it walks in to orbitDist and circles the player there for
 *   orbitSec of unfrozen time (ORBITING), walking back in when pushed out past STOP_SLACK, then
 *   flees at fleeMult × its step (FLEEING) and escapes past the arena's edge: removed without a
 *   kill, drops or a leak (treasureEscaped), gone for its wave's clear;
 * - the shooter (射手, gd:694) and the summoner (召喚者, gd:695): each walks in to its stopDist
 *   and stands there (STOPPED), and every periodSec of unfrozen time from one period after it
 *   first got there, the shooter fires a bullet at the player (src/sim/systems/bullets.ts) and
 *   the summoner summons its children around itself (summon); pushed out past STOP_SLACK, it
 *   walks back in, its timer counting on, and acts on arrival if due.
 * Then the bullets in flight move and hit (stepBullets), after the walk. The step sets the
 * movement fields the movement stage reads: stepDist (0 while an enemy stands, below 0 while it
 * flees) and an orbit's (ux, uy). treasuresDue schedules the treasures (startWave,
 * src/sim/systems/waves.ts). The step draws only the summons' angles, on the split stream.
 */

import { add, min, mul } from '../../core/num';
import type { EnemyBehaviour, V3WaveRules } from '../../data/types';
import { releaseAilments } from '../ailments/apply';
import { countBleedMove } from '../ailments/bleed';
import { enemySlow } from '../ailments/frost';
import { holdsBurn } from '../ailments/records';
import { statAt } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { periodTicks } from '../emitters/types';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, TICK_RATE } from '../types';
import { fireBullet, stepBullets } from './bullets';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';
import {
  AI_DASH,
  AI_SHOOT,
  AI_SUMMON,
  AI_TREASURE,
  CHARGING,
  DASHING,
  EXTRA_ORIGIN,
  FLEEING,
  ORBITING,
  orbitTurn,
  STOPPED,
} from './enemyRecord';
import type { EnemyV3 } from './enemyRecord';
import { spawnOrSkip } from './spawn';
import type { EnemyAiState } from './systemState';

export { CHARGING, DASHING, FLEEING, ORBITING, STOPPED } from './enemyRecord';

/**
 * How far past its post a standing enemy may be pushed before it walks back: an orbiting
 * treasure beyond orbitDist + STOP_SLACK walks in that tick instead of turning, and a shooter or
 * summoner beyond stopDist + STOP_SLACK leaves its post and walks back to it. About two ticks of
 * a walk (初始值, docs/v3 C7 design §1.8).
 */
export const STOP_SLACK = 4;

const HALF_WIDTH = ARENA_WIDTH / 2;
const HALF_HEIGHT = ARENA_HEIGHT / 2;
const ENEMY_REGEN = SCOPED_INDEX.enemyRegen;
const TAU = Math.PI * 2;

type DashBehaviour = Extract<EnemyBehaviour, { readonly kind: 'dash' }>;
type ShootBehaviour = Extract<EnemyBehaviour, { readonly kind: 'shoot' }>;
type SummonBehaviour = Extract<EnemyBehaviour, { readonly kind: 'summon' }>;
type TreasureBehaviour = Extract<EnemyBehaviour, { readonly kind: 'treasure' }>;

/**
 * The treasures due at the start of wave `wave` at `rate` × the schedule's (values.treasureRate):
 * N(wave) − N(wave − 1), where N(w) = 0 before fromWave and floor((w − fromWave) × rate / every
 * + 1e-9) + 1 from it, the treasures of waves 1 to w. The 1e-9 keeps a product that is a whole
 * number in decimal from flooring one short.
 */
export function treasuresDue(wave: number, rules: V3WaveRules, rate: number): number {
  const { fromWave, every } = rules.treasure;
  const upTo = (w: number): number =>
    w < fromWave ? 0 : Math.floor(((w - fromWave) * rate) / every + 1e-9) + 1;
  return upTo(wave) - upTo(wave - 1);
}

/** Runs the enemy AI step of tick ctx.now (ctx.sys.enemyAi.enabled). */
export function stepEnemyAi(ctx: RunContext): void {
  const ai = ctx.sys.enemyAi;
  ai.chargeStartCount = 0;
  const list = ai.list;
  const now = ctx.now;
  const n = list.length;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const enemy = list[i] as Enemy;
    if (!enemy.alive) continue;
    list[kept++] = enemy;
    const v = enemy.v3 as EnemyV3;
    if (enemy.frozenUntil > now) {
      // Its timers pause; regeneration goes on (gd:109's 凍結生機 reduces it). An unarmed
      // nextAct stays Infinity.
      v.stateUntil++;
      v.nextAct++;
      if (v.regen > 0) regenerate(ctx, ai, enemy, v, now);
      continue;
    }
    if (v.regen > 0) regenerate(ctx, ai, enemy, v, now);
    switch (v.ai) {
      case AI_DASH:
        stepDasher(ctx, ai, enemy, v, now);
        break;
      case AI_SHOOT:
      case AI_SUMMON:
        stepPost(ctx, enemy, v, now);
        break;
      case AI_TREASURE:
        stepTreasure(ctx, enemy, v, now);
        break;
    }
  }
  // Enemies that joined during the walk (summons with work) follow the kept ones, still in id
  // order.
  for (let i = n; i < list.length; i++) list[kept++] = list[i] as Enemy;
  list.length = kept;
  if (ctx.sys.bullets.count !== 0) stepBullets(ctx);
}

/**
 * A tick of the enemy's regeneration: max(0, v.regen × enemyRegen) of its max life a second,
 * up to its max life, unless it holds burn.
 */
function regenerate(
  ctx: RunContext,
  ai: EnemyAiState,
  enemy: Enemy,
  v: EnemyV3,
  now: number,
): void {
  if (holdsBurn(enemy, now)) return;
  const ev = ctx.evalInput;
  ev.now = now;
  ev.target = enemy;
  ev.chainJump = 0;
  const r = Math.max(0, v.regen * statAt(ctx.table, ai.regenRow, ENEMY_REGEN, ev));
  enemy.hp = min(enemy.maxHp, add(enemy.hp, mul(enemy.maxHp, r * DT)));
}

/**
 * The dasher: at chargeDist or closer it stands charging (CHARGING | STOPPED) for chargeSec of
 * unfrozen time, then dashes (DASHING, the bits replaced) at dashMult × its walk step until
 * contact or death.
 */
function stepDasher(
  ctx: RunContext,
  ai: EnemyAiState,
  enemy: Enemy,
  v: EnemyV3,
  now: number,
): void {
  const behaviour = enemy.def.behaviour as DashBehaviour;
  if (v.state === 0) {
    if (enemy.dist > behaviour.chargeDist) return;
    v.state = CHARGING | STOPPED;
    v.stateUntil = now + Math.round(behaviour.chargeSec * TICK_RATE);
    enemy.stepDist = 0;
    ctx.events.push({ type: 'dasherCharge', enemyId: enemy.id });
    ai.chargeStarts[ai.chargeStartCount++] = enemy;
  }
  if ((v.state & CHARGING) !== 0 && now >= v.stateUntil) {
    v.state = DASHING;
    enemy.stepDist = v.baseStep * behaviour.dashMult;
    ctx.events.push({ type: 'dasherDash', enemyId: enemy.id });
  }
}

/**
 * The shooter and the summoner at their post: at stopDist or closer it stands (STOPPED, its step
 * 0), its timer armed on its first arrival only, a period ahead (periodTicks(1 / periodSec)); a
 * later arrival keeps the timer, which counted on while it walked. Pushed out past
 * stopDist + STOP_SLACK, it leaves STOPPED and walks back at its walk step, acting on none of
 * those ticks. Standing, once the timer is due, it acts once: the shooter fires a bullet, the
 * summoner summons. The timer then moves a period on, or a period past this tick if it was more
 * than a period behind (a walk back), so it never acts twice in a tick or catches up.
 */
function stepPost(ctx: RunContext, enemy: Enemy, v: EnemyV3, now: number): void {
  const behaviour = enemy.def.behaviour as ShootBehaviour | SummonBehaviour;
  if (v.state === 0) {
    if (enemy.dist > behaviour.stopDist) return;
    v.state = STOPPED;
    enemy.stepDist = 0;
    if (v.nextAct === Infinity) v.nextAct = now + periodTicks(1 / behaviour.periodSec);
  } else if (enemy.dist > behaviour.stopDist + STOP_SLACK) {
    v.state = 0;
    enemy.stepDist = v.baseStep;
    return;
  }
  if (now < v.nextAct) return;
  if (v.ai === AI_SHOOT) fireBullet(ctx, enemy);
  else summon(ctx, enemy);
  const period = periodTicks(1 / behaviour.periodSec);
  v.nextAct += period;
  if (v.nextAct <= now) v.nextAct = now + period;
}

/**
 * The summoner's summons: `count` of its behaviour's enemy around it, each of which first draws
 * its angle on the split stream, so the stream never depends on how full the field is, is placed
 * on the summoner's rim as split's children are (src/sim/systems/spawn.ts), then goes through
 * spawnOrSkip in the summoner's wave with EXTRA_ORIGIN: past the enemy cap it is skipped and
 * counted (enemySpawnsSkipped). Pushes summoned with the number that spawned.
 */
export function summon(ctx: RunContext, summoner: Enemy): void {
  const behaviour = summoner.def.behaviour as SummonBehaviour;
  const def = ctx.data.enemies[behaviour.enemy];
  const player = ctx.player;
  let spawned = 0;
  for (let i = 0; i < behaviour.count; i++) {
    const angle = ctx.splitRng.range(0, TAU);
    const dx = summoner.x + Math.cos(angle) * summoner.radius - player.x;
    const dy = summoner.y + Math.sin(angle) * summoner.radius - player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const added =
      dist > 0
        ? spawnOrSkip(ctx, def, summoner.rec, dx / dist, dy / dist, dist, EXTRA_ORIGIN)
        : spawnOrSkip(ctx, def, summoner.rec, 1, 0, 0, EXTRA_ORIGIN);
    if (added) spawned++;
  }
  ctx.events.push({ type: 'summoned', enemyId: summoner.id, count: spawned });
}

/**
 * The treasure: at orbitDist or closer it circles the player (ORBITING) for orbitSec of unfrozen
 * time, then flees (FLEEING) at fleeMult × its walk step and escapes at its escape distance.
 */
function stepTreasure(ctx: RunContext, enemy: Enemy, v: EnemyV3, now: number): void {
  const behaviour = enemy.def.behaviour as TreasureBehaviour;
  if (v.state === 0) {
    if (enemy.dist > behaviour.orbitDist) return;
    v.state = ORBITING;
    v.stateUntil = now + Math.round(behaviour.orbitSec * TICK_RATE);
  }
  if (v.state === ORBITING) {
    if (now < v.stateUntil) {
      orbit(ctx, enemy, v, behaviour.orbitDist, now);
      return;
    }
    // Out along its bearing, past the arena's edge as far as it spawns (spawn.ts).
    v.state = FLEEING;
    v.escapeDist = Math.min(
      (HALF_WIDTH + enemy.radius) / Math.abs(enemy.ux),
      (HALF_HEIGHT + enemy.radius) / Math.abs(enemy.uy),
    );
    enemy.stepDist = -v.baseStep * behaviour.fleeMult;
    return;
  }
  if (enemy.dist >= v.escapeDist) {
    removeEnemy(ctx, enemy);
    releaseAilments(ctx, enemy);
    ctx.events.push({ type: 'treasureEscaped', enemyId: enemy.id, x: enemy.x, y: enemy.y });
  }
}

/**
 * A tick of the orbit: pushed out past orbitDist + STOP_SLACK, the treasure walks in this tick;
 * otherwise it stands (stepDist 0) and turns its bearing by orbitTurn, its slowed walk step over
 * orbitDist, counting the tick for its bleed as movement would (its dist does not change) when it
 * turns.
 */
function orbit(ctx: RunContext, enemy: Enemy, v: EnemyV3, orbitDist: number, now: number): void {
  if (enemy.dist > orbitDist + STOP_SLACK) {
    enemy.stepDist = v.baseStep;
    return;
  }
  enemy.stepDist = 0;
  const angle = orbitTurn(enemy, enemySlow(ctx, enemy, now));
  if (angle === 0) return;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const ux = enemy.ux;
  const uy = enemy.uy;
  enemy.ux = ux * cos - uy * sin;
  enemy.uy = ux * sin + uy * cos;
  if (enemy.bleedUntil !== 0) countBleedMove(enemy, now);
}
