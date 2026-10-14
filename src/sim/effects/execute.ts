/**
 * The effect phase (docs/v3/implementation-plan-v3.md §2.6, §2.15): due periodic triggers fire,
 * then up to EFFECTS_PER_TICK queued effects run in queue order; effects queued meanwhile join
 * the tail. Each effect kind has its executor in EFFECTS, typed over EffectKind, so a kind added
 * to the vocabulary does not compile without one. An effect on its event's enemy does nothing
 * once that enemy is dead; area effects start at the event's position. A trigger's selector
 * (select.ts) puts the enemy it picked in the entry's target, and area effects center on that
 * enemy instead, or on the player for a 'player' pick (CompiledEffect.atTarget, atPlayer). An
 * area capped by maxTargets reaches the first enemies in id order, or the nearest with order
 * 'nearest' (orderNearest).
 *
 * Effect hits go through hitWithPayload like any hit, with the effect's payload (its tags and
 * source, the effects stream, no flags) at the entry's depth and origin, so their kills and
 * triggers follow the same rules. A shatter's hits (SHATTER_TRIGGER) take the payload of the
 * source its entry is credited to, and deal their share of the victim's max life. Area queries
 * write to ctx.effectTargets; effects never nest, and transfers at a kill use ctx.spreadTargets.
 */

import { add, mul, num, toNumber, ZERO } from '../../core/num';
import type { AppliedAilment } from '../../data/triggers';
import {
  ailmentDps,
  applyBurn,
  applyPoison,
  creditOf,
  spreadBurn,
  spreadPoison,
} from '../ailments/apply';
import { addBleed } from '../ailments/bleed';
import { addFrost } from '../ailments/frost';
import { addShock } from '../ailments/shock';
import { hitWithPayload } from '../combat/hit';
import { createPayload, PCT_MAX_HP, SLOT_BLEED, SLOT_BURN, SLOT_POISON } from '../emitters/types';
import type { Payload } from '../emitters/types';
import type { Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
import { raiseFreeze } from './centerEvents';
import { fireApplied, fireOne } from './dispatch';
import { dequeue } from './queue';
import type { EffectEntry } from './queue';
import { orderNearest } from './select';
import { EFFECTS_PER_TICK, EVENT } from './types';
import type {
  CompiledEffect,
  CompiledEffectKind,
  CompiledEffectSpec,
  CompiledTrigger,
} from './types';

type Executor<K extends CompiledEffectKind> = (
  ctx: RunContext,
  spec: Extract<CompiledEffectSpec, { kind: K }>,
  fx: CompiledEffect,
  entry: Readonly<EffectEntry>,
) => void;

/** The event's enemy, if it is still alive. */
const liveTarget = (entry: Readonly<EffectEntry>): Enemy | null =>
  entry.target !== null && entry.target.alive ? entry.target : null;

/** Writes the alive enemies within the effect's radius of (x, y) to ctx.effectTargets. */
const within = (ctx: RunContext, fx: CompiledEffect, x: number, y: number): number =>
  ctx.grid.within(x, y, fx.radiusSq, ctx.effectTargets);

/**
 * within, then at most `max` of them: the first in id order, or with `nearest` the nearest to
 * (x, y), nearest first. Returns how many ctx.effectTargets holds.
 */
function inArea(
  ctx: RunContext,
  fx: CompiledEffect,
  x: number,
  y: number,
  max: number,
  nearest: boolean,
): number {
  const count = within(ctx, fx, x, y);
  if (count <= max) return count;
  return nearest ? orderNearest(ctx.effectTargets, count, max, x, y) : max;
}

/**
 * Where an area effect centers: on the enemy its trigger's selector picked (atTarget), where it
 * is now or was when it died; on the player for a 'player' pick; else at the event's point.
 */
const centerX = (ctx: RunContext, fx: CompiledEffect, entry: Readonly<EffectEntry>): number =>
  fx.atTarget && entry.target !== null ? entry.target.x : fx.atPlayer ? ctx.player.x : entry.x;
const centerY = (ctx: RunContext, fx: CompiledEffect, entry: Readonly<EffectEntry>): number =>
  fx.atTarget && entry.target !== null ? entry.target.y : fx.atPlayer ? ctx.player.y : entry.y;

/**
 * `stacks` stacks of `ailment` from the effect's payload on `enemy`, each as its hit would apply
 * it (bleed keeps the strongest, so more stacks add nothing), then its ailmentApplied event.
 */
function applyStacks(
  ctx: RunContext,
  ailment: AppliedAilment,
  enemy: Enemy,
  p: Payload,
  stacks: number,
  entry: Readonly<EffectEntry>,
): void {
  const depth = entry.depth;
  const now = ctx.now;
  let applied = true;
  switch (ailment) {
    case 'burn': {
      const dps = ailmentDps(ctx, enemy, p, SLOT_BURN, p.baseDamage, ctx.burnDamage);
      applyBurn(ctx, enemy, dps, now + ctx.burnTicks, depth, creditOf(ctx, 'burn', p), stacks);
      break;
    }
    case 'poison': {
      const dps = ailmentDps(ctx, enemy, p, SLOT_POISON, p.baseDamage, ctx.poisonDamage);
      applyPoison(
        ctx,
        enemy,
        dps,
        now + ctx.poisonTicks,
        depth,
        creditOf(ctx, 'poison', p),
        stacks,
      );
      break;
    }
    case 'bleed': {
      const dps = ailmentDps(ctx, enemy, p, SLOT_BLEED, p.baseDamage, ctx.bleedDamage);
      const source = creditOf(ctx, 'bleed', p);
      applied = addBleed(ctx, enemy, dps, now + ctx.bleedTicks, depth, source);
      if (applied) {
        ctx.events.push({ type: 'ailmentApplied', targetId: enemy.id, ailment, stacks: 1 });
      }
      break;
    }
    case 'shock':
      applied = addShock(ctx, enemy, stacks, depth);
      if (applied) {
        const shock = enemy.shockStacks;
        ctx.events.push({ type: 'ailmentApplied', targetId: enemy.id, ailment, stacks: shock });
      }
      break;
  }
  if (applied && ctx.appliedListeners) fireApplied(ctx, enemy, ailment, depth, entry.origin, 0);
}

/** Ticks the ailment lasts once applied; nothing is applied without any. */
const durationOf = (ctx: RunContext, ailment: AppliedAilment): number =>
  ailment === 'burn'
    ? ctx.burnTicks
    : ailment === 'poison'
      ? ctx.poisonTicks
      : ailment === 'bleed'
        ? ctx.bleedTicks
        : ctx.shockTicks;

/**
 * Every alive enemy within the effect's radius of (x, y), at most `max` (inArea), is hit, in id
 * order or with `nearest` nearest first.
 */
function hitArea(
  ctx: RunContext,
  fx: CompiledEffect,
  entry: Readonly<EffectEntry>,
  x: number,
  y: number,
  max: number,
  nearest: boolean,
): void {
  const p = ctx.effectPayloads[entry.effect] as Payload;
  const targets = ctx.effectTargets;
  const count = inArea(ctx, fx, x, y, max, nearest);
  for (let i = 0; i < count; i++) {
    const enemy = targets[i] as Enemy;
    if (enemy.alive) {
      hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, entry.depth, entry.origin);
    }
  }
}

/** `amount` of frost from the effect's credit on `enemy`, which may freeze it. */
function frostOne(
  ctx: RunContext,
  enemy: Enemy,
  amount: number,
  entry: Readonly<EffectEntry>,
): void {
  if (addFrost(ctx, enemy, amount, entry.source)) {
    raiseFreeze(ctx, enemy, entry.depth, entry.origin, 0);
  }
}

/**
 * The payload of shatter hits credited to `source`, from the shatter effect `fx`: no crit, no
 * ailments, no flags; filled on first use (RunContext.shatterPayloads).
 */
function shatterPayload(ctx: RunContext, fx: CompiledEffect, source: number): Payload {
  const cached = ctx.shatterPayloads[source];
  if (cached !== undefined && cached !== null) return cached;
  const payload = createPayload({
    baseDamage: fx.baseDamage,
    tags: fx.tags,
    source,
    flags: 0,
    rng: ctx.effectsRng,
    chains: false,
    rollsAilments: false,
    canCrit: false,
    damageMode: PCT_MAX_HP,
  });
  ctx.shatterPayloads[source] = payload;
  return payload;
}

const EFFECTS: { readonly [K in CompiledEffectKind]: Executor<K> } = {
  applyAilment(ctx, spec, fx, entry) {
    const ailment = spec.ailment;
    if (durationOf(ctx, ailment) <= 0) return;
    const p = ctx.effectPayloads[entry.effect] as Payload;
    const stacks = spec.stacks ?? 1;
    if (spec.radius === undefined) {
      const target = liveTarget(entry);
      if (target !== null) applyStacks(ctx, ailment, target, p, stacks, entry);
      return;
    }
    const targets = ctx.effectTargets;
    const max = spec.maxTargets ?? Infinity;
    const nearest = spec.order === 'nearest';
    const count = inArea(ctx, fx, centerX(ctx, fx, entry), centerY(ctx, fx, entry), max, nearest);
    for (let i = 0; i < count; i++) {
      applyStacks(ctx, ailment, targets[i] as Enemy, p, stacks, entry);
    }
  },
  spreadAilment(ctx, spec, fx, entry) {
    const target = liveTarget(entry);
    if (target === null || fx.spread === null) return;
    if (spec.ailment === 'burn') spreadBurn(ctx, target, fx.spread, entry.depth);
    else {
      const sf = spec.stacks ?? 1;
      const max = spec.maxTargets ?? Infinity;
      spreadPoison(ctx, target, fx.spread, sf, max, entry.depth, spec.order === 'nearest');
    }
  },
  explode(ctx, spec, fx, entry) {
    const max = spec.maxTargets ?? Infinity;
    const nearest = spec.order === 'nearest';
    hitArea(ctx, fx, entry, centerX(ctx, fx, entry), centerY(ctx, fx, entry), max, nearest);
  },
  nova(ctx, spec, fx, entry) {
    const atEvent = spec.at === 'event';
    const player = ctx.player;
    const x = atEvent ? centerX(ctx, fx, entry) : player.x;
    const y = atEvent ? centerY(ctx, fx, entry) : player.y;
    hitArea(ctx, fx, entry, x, y, Infinity, false);
  },
  push(ctx, spec, fx, entry) {
    const player = ctx.player;
    const targets = ctx.effectTargets;
    const count = within(ctx, fx, centerX(ctx, fx, entry), centerY(ctx, fx, entry));
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
  addFrost(ctx, spec, fx, entry) {
    if (spec.radius === undefined) {
      const target = liveTarget(entry);
      if (target !== null) frostOne(ctx, target, spec.amount, entry);
      return;
    }
    const targets = ctx.effectTargets;
    const max = spec.maxTargets ?? Infinity;
    const nearest = spec.order === 'nearest';
    const count = inArea(ctx, fx, centerX(ctx, fx, entry), centerY(ctx, fx, entry), max, nearest);
    for (let i = 0; i < count; i++) frostOne(ctx, targets[i] as Enemy, spec.amount, entry);
  },
  heal(ctx, spec) {
    const player = ctx.player;
    player.life = Math.min(player.maxLife, player.life + spec.lifePct * player.maxLife);
  },
  gainShards(ctx, spec, _fx, entry) {
    const state = ctx.state;
    state.shards = add(state.shards, mul(num(entry.value), spec.fraction));
  },
  // The victim (dead and gone) at the entry's position: shatterDamage of its max life (the
  // entry's value) to every alive enemy within shatterRadius, credited to the entry's source.
  shatter(ctx, _spec, fx, entry) {
    const radius = ctx.shatterRadius;
    ctx.events.push({ type: 'shatter', x: entry.x, y: entry.y, radius });
    const p = shatterPayload(ctx, fx, entry.source);
    const scale = toNumber(mul(num(entry.value), ctx.shatterDamage));
    const targets = ctx.effectTargets;
    const count = within(ctx, fx, entry.x, entry.y);
    for (let i = 0; i < count; i++) {
      const enemy = targets[i] as Enemy;
      if (enemy.alive) {
        hitWithPayload(ctx, enemy, p, 0, scale, null, null, false, entry.depth, entry.origin);
      }
    }
  },
};

type AnyExecutor = (
  ctx: RunContext,
  spec: CompiledEffectSpec,
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
