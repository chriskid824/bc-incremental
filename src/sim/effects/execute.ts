/**
 * The effect phase (docs/v3/implementation-plan-v3.md §2.6, §2.15): due periodic triggers fire,
 * then up to EFFECTS_PER_TICK queued effects run in queue order; effects queued meanwhile join
 * the tail. Each effect kind has its executor in EFFECTS, typed over EffectKind, so a kind added
 * to the vocabulary does not compile without one. An effect on its event's enemy does nothing
 * once that enemy is dead; area effects start at the event's position.
 *
 * Effect hits go through hitWithPayload like any hit, with the effect's payload (its tags and
 * source, the effects stream, no flags) at the entry's depth and origin, so their kills and
 * triggers follow the same rules. Area queries write to ctx.effectTargets; effects never nest,
 * and transfers at a kill use ctx.spreadTargets.
 */

import { add, mul, num, ZERO } from '../../core/num';
import type { EffectKind, EffectSpec } from '../../data/triggers';
import { addBurn, spreadBurns } from '../ailments/records';
import { statAt } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { hitWithPayload } from '../combat/hit';
import { SLOT_BURN, slotRow } from '../emitters/types';
import type { Payload } from '../emitters/types';
import type { Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
import { fireOne } from './dispatch';
import { dequeue } from './queue';
import type { EffectEntry } from './queue';
import { EFFECTS_PER_TICK, EVENT } from './types';
import type { CompiledEffect, CompiledTrigger } from './types';

const DAMAGE = SCOPED_INDEX.damage;

type Executor<K extends EffectKind> = (
  ctx: RunContext,
  spec: Extract<EffectSpec, { kind: K }>,
  fx: CompiledEffect,
  entry: Readonly<EffectEntry>,
) => void;

/** The event's enemy, if it is still alive. */
const liveTarget = (entry: Readonly<EffectEntry>): Enemy | null =>
  entry.target !== null && entry.target.alive ? entry.target : null;

/** Writes the alive enemies within the effect's radius of (x, y) to ctx.effectTargets. */
const within = (ctx: RunContext, fx: CompiledEffect, x: number, y: number): number =>
  ctx.grid.within(x, y, fx.radiusSq, ctx.effectTargets);

/** `stacks` burn stacks of the effect's payload on `enemy`, each as its hit would ignite. */
function applyBurn(ctx: RunContext, enemy: Enemy, p: Payload, stacks: number, depth: number): void {
  const ev = ctx.evalInput;
  ev.now = ctx.now;
  ev.target = enemy;
  ev.chainJump = 0;
  const row = slotRow(ctx.build, p, SLOT_BURN);
  const dps = mul(p.baseDamage, ctx.burnDamage * statAt(ctx.table, row, DAMAGE, ev));
  const end = ctx.now + ctx.burnTicks;
  for (let s = 0; s < stacks; s++) addBurn(ctx, enemy, dps, end, depth);
}

/** Every alive enemy within the effect's radius of (x, y), first `max` in id order, is hit. */
function hitArea(
  ctx: RunContext,
  fx: CompiledEffect,
  entry: Readonly<EffectEntry>,
  x: number,
  y: number,
  max: number,
): void {
  const p = ctx.effectPayloads[entry.effect] as Payload;
  const targets = ctx.effectTargets;
  const count = Math.min(within(ctx, fx, x, y), max);
  for (let i = 0; i < count; i++) {
    const enemy = targets[i] as Enemy;
    if (enemy.alive) {
      hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, entry.depth, entry.origin);
    }
  }
}

const EFFECTS: { readonly [K in EffectKind]: Executor<K> } = {
  applyAilment(ctx, spec, fx, entry) {
    if (ctx.burnTicks <= 0) return;
    const p = ctx.effectPayloads[entry.effect] as Payload;
    const stacks = spec.stacks ?? 1;
    if (spec.radius === undefined) {
      const target = liveTarget(entry);
      if (target !== null) applyBurn(ctx, target, p, stacks, entry.depth);
      return;
    }
    const targets = ctx.effectTargets;
    const count = Math.min(within(ctx, fx, entry.x, entry.y), spec.maxTargets ?? Infinity);
    for (let i = 0; i < count; i++) applyBurn(ctx, targets[i] as Enemy, p, stacks, entry.depth);
  },
  spreadAilment(ctx, _spec, fx, entry) {
    const target = liveTarget(entry);
    if (target !== null && fx.spread !== null) spreadBurns(ctx, target, fx.spread, entry.depth);
  },
  explode(ctx, spec, fx, entry) {
    hitArea(ctx, fx, entry, entry.x, entry.y, spec.maxTargets ?? Infinity);
  },
  nova(ctx, spec, fx, entry) {
    const atEvent = spec.at === 'event';
    const player = ctx.player;
    hitArea(ctx, fx, entry, atEvent ? entry.x : player.x, atEvent ? entry.y : player.y, Infinity);
  },
  push(ctx, spec, fx, entry) {
    const player = ctx.player;
    const targets = ctx.effectTargets;
    const count = within(ctx, fx, entry.x, entry.y);
    if (count === 0) return;
    for (let i = 0; i < count; i++) {
      const enemy = targets[i] as Enemy;
      enemy.dist += spec.distance;
      enemy.x = player.x + enemy.ux * enemy.dist;
      enemy.y = player.y + enemy.uy * enemy.dist;
    }
    // The grid's cells hold the old positions. Rebuilt here, mid-phase, so the effects after
    // this one this tick query the pushed positions.
    rebuildGrid(ctx);
  },
  heal(ctx, spec) {
    const player = ctx.player;
    player.life = Math.min(player.maxLife, player.life + spec.lifePct * player.maxLife);
  },
  gainShards(ctx, spec, _fx, entry) {
    const state = ctx.state;
    state.shards = add(state.shards, mul(num(entry.value), spec.fraction));
  },
};

type AnyExecutor = (
  ctx: RunContext,
  spec: EffectSpec,
  fx: CompiledEffect,
  entry: Readonly<EffectEntry>,
) => void;

/** Runs the effect of `entry`. */
export function runEffect(ctx: RunContext, entry: Readonly<EffectEntry>): void {
  const fx = ctx.build.effects[entry.effect] as CompiledEffect;
  (EFFECTS[fx.kind] as AnyExecutor)(ctx, fx.spec, fx, entry);
}

/**
 * Due periodic triggers, each at the player without a target, staggered by trigger index
 * (RunContext.triggerState.nextPeriodic).
 */
function firePeriodic(ctx: RunContext, list: Int32Array): void {
  const state = ctx.triggerState;
  const player = ctx.player;
  for (let n = 0; n < list.length; n++) {
    const i = list[n] as number;
    if (ctx.now < (state.nextPeriodic[i] as number)) continue;
    const t = ctx.build.triggers[i] as CompiledTrigger;
    state.nextPeriodic[i] = (state.nextPeriodic[i] as number) + t.periodTicks;
    fireOne(ctx, i, 0, -1, null, player.x, player.y, 0, ZERO, -1);
  }
}

/**
 * The tick's effect phase: due periodic triggers, then up to EFFECTS_PER_TICK queued effects.
 * Entries left past the budget wait for the next tick and are counted.
 */
export function runEffectQueue(ctx: RunContext): void {
  const periodic = ctx.build.triggersOn[EVENT.periodic] as Int32Array;
  if (periodic.length !== 0) firePeriodic(ctx, periodic);
  const queue = ctx.effectQueue;
  if (queue.size === 0) {
    ctx.budgetStreak = 0;
    return;
  }
  const entry = ctx.effectEntry;
  let run = 0;
  while (queue.size > 0 && run < EFFECTS_PER_TICK) {
    dequeue(queue, entry);
    runEffect(ctx, entry);
    run++;
  }
  entry.target = null;
  const counters = ctx.counters;
  counters.effectsRun += run;
  if (queue.size > 0) {
    counters.effectBudgetTicks++;
    counters.effectsDeferred += queue.size;
    ctx.budgetStreak++;
    if (ctx.budgetStreak > counters.effectBudgetStreakMax) {
      counters.effectBudgetStreakMax = ctx.budgetStreak;
    }
  } else {
    ctx.budgetStreak = 0;
  }
}
