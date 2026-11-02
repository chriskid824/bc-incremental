/**
 * The combo (docs/v3/game-design-v3.md §4.5 連擊; docs/v3 C6 design §7.4 C6b.2) and the timed
 * buffs, on RunContext.sys.combo (ComboState, src/sim/systems/systemState.ts). Only a build whose
 * BuildFlags.combo is set keeps the stacks; the others pay one boolean test per counted attack,
 * per tick and per hit on the player, and their runs stay the same bit for bit.
 *
 * The stacks, an integer from 0 to BuildFlags.comboCap:
 * - +1 for each counted attack of the signature emitter (gainComboOnAttack, from countAttack in
 *   src/sim/emitters/volley.ts): a repeat counts no attack, and a granted emitter's attacks are
 *   its own; a comboStack effect adds its stacks (addComboStacks); both stop at the cap;
 * - idle: the combo step, at the start of the emitter stage (step 6, src/sim/simulation.ts),
 *   counts the ticks in a row on which the signature emitter has no target to pick
 *   (signatureHasTarget), and resets the count on a tick that has one; each time the count
 *   reaches a multiple of comboIdleTicks the stacks keep floor(stacks × comboIdleKeep), and at
 *   least 1 of them when comboIdleKeep is above 0 (◆慣性's 「不會歸零」, gd:421);
 * - a hit on the player (loseComboOnHit, where heroHit is raised: a leak, src/sim/systems/
 *   contact.ts, and a bullet, src/sim/systems/bullets.ts) keeps floor(stacks × comboHitKeep),
 *   before heroHit's triggers are queued, a hit the shield absorbs whole included, since it
 *   raises heroHit too.
 * Every change writes the stacks into the run's EvalInput (comboStacks, src/sim/build/eval.ts),
 * so a hit reads them as they are at that hit, and recomputes the combo factor of each emitter
 * whose hit row has an attackSpeed entry scaled on them.
 *
 * A buff effect (src/data/triggers.ts BuffSpec) is active from its firing, in the effect phase,
 * until its window of round(durationSec × TICK_RATE) ticks is over: it multiplies the cadence of
 * the emitters it takes by 1 + more from the next emitter stage, for that many emitter stages.
 * Firing it again while it is active moves the end of its window and changes no factor; distinct
 * buff effects multiply. The combo step ends the windows that are over; with no buff active it
 * looks at none.
 *
 * An emitter's cadence is 冰霜's factor × its combo factor × its buffs' factor, in that order,
 * written by refreshCadence (src/sim/systems/affixes.ts) whenever one of them changes. Nothing
 * here draws from a stream, and every step reads only the run's state, so it is deterministic.
 */

import { SCOPED_STATS } from '../../data/stats';
import { statAt } from '../build/eval';
import { isFar } from '../emitters/lob';
import { SLOT_HIT, slotRow } from '../emitters/types';
import type { EmitterRuntime } from '../emitters/types';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import { refreshCadence } from './affixes';
import type { Enemy, RunContext } from './context';
import { aliveCount } from './spawn';

/** Position of attackSpeed in a ModTable row (SCOPED_INDEX in src/sim/build/modTable.ts). */
const ATTACK_SPEED = SCOPED_STATS.indexOf('attackSpeed');

/**
 * A counted attack of `em` (countAttack): +1 stack when it is the signature emitter's, up to the
 * cap. Called only when BuildFlags.combo is set.
 */
export function gainComboOnAttack(ctx: RunContext, em: EmitterRuntime): void {
  if (em.index !== 0) return;
  setStacks(ctx, Math.min(ctx.build.flags.comboCap, ctx.sys.combo.stacks + 1));
}

/** A comboStack effect: `stacks` more, up to the cap. */
export function addComboStacks(ctx: RunContext, stacks: number): void {
  setStacks(ctx, Math.min(ctx.build.flags.comboCap, ctx.sys.combo.stacks + stacks));
}

/**
 * A hit on the player, right before its heroHit is raised: the stacks keep floor(stacks ×
 * comboHitKeep). Called only when BuildFlags.combo is set.
 */
export function loseComboOnHit(ctx: RunContext): void {
  setStacks(ctx, Math.floor(ctx.sys.combo.stacks * ctx.build.flags.comboHitKeep));
}

/**
 * The combo step, once a tick before the emitters (ComboState.ticks): the idle count and its
 * decay when the build keeps the stacks, then the end of each buff window that is over.
 */
export function stepCombo(ctx: RunContext): void {
  const cs = ctx.sys.combo;
  const flags = ctx.build.flags;
  if (flags.combo) {
    if (signatureHasTarget(ctx)) {
      cs.idle = 0;
    } else if (++cs.idle % flags.comboIdleTicks === 0) {
      const kept = Math.floor(cs.stacks * flags.comboIdleKeep);
      // ◆慣性 (gd:421): a keep above 0 never clears the stacks, 「不會歸零」.
      setStacks(ctx, kept === 0 && cs.stacks > 0 && flags.comboIdleKeep > 0 ? 1 : kept);
    }
  }
  if (cs.active !== 0) endBuffs(ctx);
}

/**
 * Fires the buff of effect `effect` (an index into CompiledBuild.effects): its window ends
 * round(durationSec × TICK_RATE) ticks from now; if it was not active, its factor joins the
 * cadence of every emitter it takes.
 */
export function fireBuff(ctx: RunContext, effect: number): void {
  const cs = ctx.sys.combo;
  const b = cs.buffSlot[effect] as number;
  const wasActive = (cs.buffEnd[b] as number) >= 0;
  cs.buffEnd[b] = ctx.now + (cs.buffTicks[b] as number);
  if (wasActive) return;
  cs.active++;
  refreshBuffs(ctx);
}

/**
 * Whether the signature emitter has a target to pick this tick, by the test its own pick makes:
 * the volley's, the fan's, the arc's, a dense bomb's and a turret's picks find an enemy while
 * any is alive (pickTargetInGrid falls back to the nearest alive one; aimDense to the densest
 * block, which holds one), so alive enemies are enough; a far bomb (遠投, isFar of the lob's next
 * shot) and the drones of a swarm without a turret (ComboState.inArenaOnly) pick only an alive
 * enemy whose center is inside the arena.
 */
function signatureHasTarget(ctx: RunContext): boolean {
  const lob = ctx.build.signature.lob;
  const far =
    ctx.sys.combo.inArenaOnly ||
    (lob !== null && isFar(lob, (ctx.emitters[0] as EmitterRuntime).shots + 1));
  if (!far) return aliveCount(ctx) > 0;
  const enemies = ctx.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Enemy;
    const { x, y } = enemy;
    if (enemy.alive && x >= 0 && x <= ARENA_WIDTH && y >= 0 && y <= ARENA_HEIGHT) return true;
  }
  return false;
}

/**
 * Sets the stacks to `stacks` and, when they change, the run's EvalInput, and the combo factor
 * and cadence of every emitter whose factor scales on them (ComboState.scaled): its hit row's
 * attackSpeed, read as a hit of it reads its row, the row SLOT_HIT that createRunContext filled.
 */
function setStacks(ctx: RunContext, stacks: number): void {
  const cs = ctx.sys.combo;
  if (stacks === cs.stacks) return;
  cs.stacks = stacks;
  const ev = ctx.evalInput;
  ev.comboStacks = stacks;
  const scaled = cs.scaled;
  if (scaled.length === 0) return;
  const build = ctx.build;
  const table = build.table;
  const factor = cs.comboFactor;
  for (let k = 0; k < scaled.length; k++) {
    const i = scaled[k] as number;
    const row = slotRow(build, (ctx.emitters[i] as EmitterRuntime).payload, SLOT_HIT);
    factor[i] = statAt(table, row, ATTACK_SPEED, ev);
  }
  refreshCadence(ctx);
}

/** Ends every buff window that is over, and refreshes the factors if one ended. */
function endBuffs(ctx: RunContext): void {
  const cs = ctx.sys.combo;
  const end = cs.buffEnd;
  const now = ctx.now;
  let ended = false;
  for (let b = 0; b < end.length; b++) {
    const last = end[b] as number;
    if (last >= 0 && now > last) {
      end[b] = -1;
      cs.active--;
      ended = true;
    }
  }
  if (ended) refreshBuffs(ctx);
}

/** Each emitter's buff factor from the active buffs, in buff order, then every cadence. */
function refreshBuffs(ctx: RunContext): void {
  const cs = ctx.sys.combo;
  const { buffEnd, buffMult, buffMatch, buffFactor } = cs;
  const count = buffFactor.length;
  for (let i = 0; i < count; i++) {
    let f = 1;
    for (let b = 0; b < buffEnd.length; b++) {
      if ((buffEnd[b] as number) >= 0 && buffMatch[b * count + i] === 1) {
        f *= buffMult[b] as number;
      }
    }
    buffFactor[i] = f;
  }
  refreshCadence(ctx);
}
