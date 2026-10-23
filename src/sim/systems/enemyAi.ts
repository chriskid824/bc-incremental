/**
 * The enemy AI step (docs/v3 C7 design §2.5): what v3 enemies do each tick beyond walking in. It
 * runs in a v3 run only (ctx.sys.enemyAi.enabled), after the spawn stage and before movement,
 * so before any hit of the tick. It walks EnemyAiState.list, the enemies with work, in id order,
 * and drops the dead ones from it in place, so a dead enemy never acts. A frozen enemy's timers
 * pause (EnemyV3.stateUntil moves on a tick) and it does not act, but it still regenerates; any
 * other enemy regenerates, then acts:
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
 *   kill, drops or a leak (treasureEscaped), gone for its wave's clear.
 * The step sets the movement fields the movement stage reads: stepDist (0 while an enemy stands,
 * below 0 while it flees) and an orbit's (ux, uy). treasuresDue schedules the treasures
 * (startWave, src/sim/systems/waves.ts). The step draws nothing.
 */

import { add, min, mul } from '../../core/num';
import type { EnemyBehaviour, V3WaveRules } from '../../data/types';
import { releaseAilments } from '../ailments/apply';
import { countBleedMove } from '../ailments/bleed';
import { enemySlow } from '../ailments/frost';
import { holdsBurn } from '../ailments/records';
import { statAt } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, TICK_RATE } from '../types';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';
import { AI_DASH, AI_TREASURE, CHARGING, DASHING, FLEEING, ORBITING, STOPPED } from './enemyRecord';
import type { EnemyV3 } from './enemyRecord';
import type { EnemyAiState } from './systemState';

export { CHARGING, DASHING, FLEEING, ORBITING, STOPPED } from './enemyRecord';

/**
 * How far past its post a standing enemy may be pushed before it walks back: an orbiting
 * treasure beyond orbitDist + STOP_SLACK walks in that tick instead of turning. About two ticks
 * of a walk (初始值, docs/v3 C7 design §1.8).
 */
export const STOP_SLACK = 4;

const HALF_WIDTH = ARENA_WIDTH / 2;
const HALF_HEIGHT = ARENA_HEIGHT / 2;
const ENEMY_REGEN = SCOPED_INDEX.enemyRegen;

type DashBehaviour = Extract<EnemyBehaviour, { readonly kind: 'dash' }>;
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
      // Its timers pause; regeneration goes on (gd:109's 凍結生機 reduces it).
      v.stateUntil++;
      if (v.regen > 0) regenerate(ctx, ai, enemy, v, now);
      continue;
    }
    if (v.regen > 0) regenerate(ctx, ai, enemy, v, now);
    switch (v.ai) {
      case AI_DASH:
        stepDasher(ctx, ai, enemy, v, now);
        break;
      case AI_TREASURE:
        stepTreasure(ctx, enemy, v, now);
        break;
    }
  }
  // Enemies that joined during the walk follow the kept ones, still in id order.
  for (let i = n; i < list.length; i++) list[kept++] = list[i] as Enemy;
  list.length = kept;
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
 * otherwise it stands (stepDist 0) and turns its bearing by its slowed walk step over orbitDist,
 * counting the tick for its bleed as movement would (its dist does not change).
 */
function orbit(ctx: RunContext, enemy: Enemy, v: EnemyV3, orbitDist: number, now: number): void {
  if (enemy.dist > orbitDist + STOP_SLACK) {
    enemy.stepDist = v.baseStep;
    return;
  }
  enemy.stepDist = 0;
  const angle = (v.baseStep * (1 - enemySlow(ctx, enemy, now))) / orbitDist;
  if (angle === 0) return;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const ux = enemy.ux;
  const uy = enemy.uy;
  enemy.ux = ux * cos - uy * sin;
  enemy.uy = ux * sin + uy * cos;
  if (enemy.bleedUntil !== 0) countBleedMove(enemy, now);
}
