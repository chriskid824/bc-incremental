/**
 * Burn records (docs/GDD.md §2–3): applying, expiring and spreading capped burn stacks, one
 * record per stack, and the damage a stack accrues between burn ticks. Shared by ailment
 * application (src/sim/ailments/apply.ts: ignite, applyAilment, spreadAilment, which is
 * Pandemic's spread), ailments (the burn tick), targeting (doomed) and the trigger conditions
 * (holdsBurn, liveBurnStacks). Uncapped burns (eternalFlame) live in DoT rings instead
 * (rings.ts); the conditions read both. The per-tick burn update is the ailments system
 * (src/sim/systems/ailments.ts).
 *
 * Each record keeps the source its damage is credited to and that source's class. When the
 * build's burns can have more than one credit (RunContext.burnMixed), the damage of ended and
 * replaced stacks is also kept per class (Enemy.burnPendC/O/F), so the burn tick can credit
 * each class its share.
 *
 * Each stack keeps the trigger depth of what applied it, and the enemy keeps the lowest depth of
 * any ailment ever applied to it (Enemy.ailDepth): a kill by damage over time carries that depth,
 * so chains of triggers through ailments stay bounded (MAX_DEPTH in src/sim/effects/types.ts).
 * Spreads are the exception: they fire at any depth (spreadBurns).
 */

import type { Num } from '../../core/num';
import { add, lt, mul, ZERO } from '../../core/num';
import { SOURCE_CLASS_ORDINAL } from '../build/sources';
import type { BurnStack, Enemy, RunContext } from '../systems/context';
import { DT } from '../types';
import { DOT_STEP_TICKS } from './rings';

/** Burn damage is dealt on a global cadence of this many ticks (0.25 s). */
export const BURN_TICK_INTERVAL = DOT_STEP_TICKS;

const OUTER = SOURCE_CLASS_ORDINAL.outer;
const FUSION = SOURCE_CLASS_ORDINAL.fusion;

/** Damage of a stack between the last burn tick (or its start) and `until`. */
export function accrued(ctx: RunContext, stack: BurnStack, until: number): Num {
  const ticks = Math.min(stack.end, until) - Math.max(stack.start, ctx.lastBurnTick);
  return ticks > 0 ? mul(stack.dps, ticks * DT) : ZERO;
}

/** The burn of all records' stacks still to come: what is pending plus what they accrue. */
export function recordsLeft(ctx: RunContext, enemy: Enemy): Num {
  let left = enemy.burnPending;
  for (let s = 0; s < enemy.burns.length; s++) {
    left = add(left, accrued(ctx, enemy.burns[s] as BurnStack, Infinity));
  }
  return left;
}

/**
 * The enemy holds burn at tick `now`: one of its records, or one of the stacks in its burn
 * rings (Enemy.burnRingEnd), has not ended yet. A stack that ended leaves only damage pending
 * until the next step (burnPending, or its ring's buckets), which does not count.
 * This is what spreadBurns tests after expireBurns, read without expiring anything, so a
 * condition has no side effect.
 */
export function holdsBurn(enemy: Enemy, now: number): boolean {
  const burns = enemy.burns;
  for (let s = 0; s < burns.length; s++) if ((burns[s] as BurnStack).end > now) return true;
  return enemy.burnRingEnd > now;
}

/**
 * The enemy's burn stacks at tick `now`: its records that have not ended, or the stacks of its
 * burn rings (Enemy.burnStacks, counted until their last step; none once every stack has ended).
 * A build has records or rings, not both.
 */
export function liveBurnStacks(enemy: Enemy, now: number): number {
  const burns = enemy.burns;
  if (burns.length === 0) return enemy.burnRingEnd > now ? enemy.burnStacks : 0;
  let live = 0;
  for (let s = 0; s < burns.length; s++) if ((burns[s] as BurnStack).end > now) live++;
  return live;
}

/** Adds `amount`, the damage of an ended or replaced stack, to burnPending. */
function bank(ctx: RunContext, enemy: Enemy, stack: BurnStack, amount: Num): void {
  enemy.burnPending = add(enemy.burnPending, amount);
  if (!ctx.burnMixed) return;
  if (stack.cls === FUSION) enemy.burnPendF = add(enemy.burnPendF, amount);
  else if (stack.cls === OUTER) enemy.burnPendO = add(enemy.burnPendO, amount);
  else enemy.burnPendC = add(enemy.burnPendC, amount);
}

/** Moves ended stacks into burnPending and recomputes burnNextEnd. */
export function expireBurns(ctx: RunContext, enemy: Enemy): void {
  const now = ctx.now;
  const burns = enemy.burns;
  let kept = 0;
  let nextEnd = Infinity;
  for (let r = 0; r < burns.length; r++) {
    const stack = burns[r] as BurnStack;
    if (stack.end <= now) {
      bank(ctx, enemy, stack, accrued(ctx, stack, stack.end));
    } else {
      burns[kept++] = stack;
      if (stack.end < nextEnd) nextEnd = stack.end;
    }
  }
  burns.length = kept;
  enemy.burnNextEnd = nextEnd;
  enemy.burnStacks = kept;
}

/**
 * Adds a stack ending at tick `end` (spread stacks keep their source's end), applied at trigger
 * depth `depth`, its damage credited to `source`.
 */
export function addBurn(
  ctx: RunContext,
  enemy: Enemy,
  dps: Num,
  end: number,
  depth: number,
  source: number,
): void {
  const now = ctx.now;
  if (now >= enemy.burnNextEnd) expireBurns(ctx, enemy);
  if (depth < enemy.ailDepth) enemy.ailDepth = depth;
  const cls = ctx.sources.cls[source] as number;
  if (cls === FUSION && enemy.burnFusionCredit < 0) enemy.burnFusionCredit = source;
  const burns = enemy.burns;
  if (burns.length < ctx.burnCap) {
    burns.push({ dps, start: now, end, depth, source, cls });
    if (end < enemy.burnNextEnd) enemy.burnNextEnd = end;
  } else {
    // At the cap, replace the stack with the least remaining damage (first on ties).
    let weakest = burns[0] as BurnStack;
    let weakestLeft = mul(weakest.dps, weakest.end - now);
    for (let i = 1; i < burns.length; i++) {
      const stack = burns[i] as BurnStack;
      const left = mul(stack.dps, stack.end - now);
      if (lt(left, weakestLeft)) {
        weakest = stack;
        weakestLeft = left;
      }
    }
    // The replaced stack's damage up to now goes to burnPending, unless this tick's burn step
    // has already dealt it: a spread from a burn kill can land on an enemy the ailments loop
    // stepped earlier in the tick, before ctx.lastBurnTick moves to now. Its accrual then runs
    // from max(start, lastBurnTick, now), which is nothing.
    if (enemy.burnSteppedAt !== now) bank(ctx, enemy, weakest, accrued(ctx, weakest, now));
    weakest.dps = dps;
    weakest.start = now;
    weakest.end = end;
    weakest.depth = depth;
    weakest.source = source;
    weakest.cls = cls;
    let nextEnd = Infinity;
    for (let i = 0; i < burns.length; i++) {
      const stackEnd = (burns[i] as BurnStack).end;
      if (stackEnd < nextEnd) nextEnd = stackEnd;
    }
    enemy.burnNextEnd = nextEnd;
  }
  enemy.burnStacks = burns.length;
  ctx.events.push({ type: 'ignite', targetId: enemy.id, stacks: burns.length });
}

/** How far a dying enemy's burns spread, and how strong a spread stack is. */
export interface BurnSpread {
  readonly radius: number;
  readonly radiusSq: number;
  /** Damage of a spread stack relative to its source stack. */
  readonly effect: number;
}

/**
 * Copies `source`'s active stacks (same end and credit, effect × damage) onto every alive enemy
 * within the spread radius, in id order, at trigger depth `depth`: the spreadAilment effect
 * (src/sim/ailments/apply.ts), Pandemic's (src/data/talents.ts) among them. Spread stacks
 * spread again, weaker each time, at any kill depth: the depth limit does not apply to transfers
 * (src/sim/effects/dispatch.ts), and the copies keep their source's end, so no chain outlasts the
 * stacks it started from. `depth` is at most MAX_DEPTH (src/sim/effects/types.ts).
 */
export function spreadBurns(
  ctx: RunContext,
  source: Enemy,
  spread: BurnSpread,
  depth: number,
): void {
  if (ctx.now >= source.burnNextEnd) expireBurns(ctx, source);
  const burns = source.burns;
  if (burns.length === 0) return;
  // In id order; addBurn kills nothing, so collecting the targets first changes nothing.
  const targets = ctx.spreadTargets;
  const count = ctx.grid.within(source.x, source.y, spread.radiusSq, targets);
  let spreadTo = 0;
  for (let i = 0; i < count; i++) {
    const enemy = targets[i] as Enemy;
    if (enemy === source) continue;
    for (let s = 0; s < burns.length; s++) {
      const stack = burns[s] as BurnStack;
      addBurn(ctx, enemy, mul(stack.dps, spread.effect), stack.end, depth, stack.source);
    }
    spreadTo++;
  }
  ctx.events.push({
    type: 'burnSpread',
    enemyId: source.id,
    x: source.x,
    y: source.y,
    radius: spread.radius,
    targets: spreadTo,
  });
}
