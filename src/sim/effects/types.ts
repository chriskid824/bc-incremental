/**
 * Triggers and effects compiled for a run (docs/v3/implementation-plan-v3.md §2.6). A trigger
 * listens to one event (TRIGGER_EVENTS); when the event happens and the trigger's conditions
 * hold, each of its effects is queued (queue.ts) and runs in the tick's effect phase
 * (execute.ts), at one depth more than the event. The rules that bound chains of triggers:
 * - depth: an event at depth MAX_DEPTH or more raises nothing (counted in triggerDepthCapped);
 *   a depth-3 effect still runs. Emitter hits are depth 0. A kill's transfer triggers (inline)
 *   are the exception: they fire at any depth (dispatch.ts);
 * - a trigger never fires on its own direct damage: each queued effect carries the index of the
 *   trigger that queued it as its origin, and damage it deals carries that origin;
 * - at most EFFECTS_PER_TICK effects run per tick; the rest wait for the next tick, and past
 *   EFFECT_QUEUE_HARD_CAP queued entries the newest are dropped.
 *
 * Triggers number in compile order (compileBuild): SHATTER_TRIGGER at index 0, the build's data
 * triggers, then the rule modules', where a module instance takes one index of its own at its
 * first hook or instanceTrigger call (an entry that listens to no event), then the test
 * modules'.
 */

import type { Num } from '../../core/num';
import { mul, num, ONE, ZERO } from '../../core/num';
import { TAG, tagMask } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import {
  COEF_FIELDS,
  DETONATE_AILMENTS,
  TRANSFER_EFFECTS,
  TRIGGER_EVENTS,
  WIRED_EVENTS,
} from '../../data/triggers';
import type {
  DetonateSpec,
  EffectSpec,
  TargetSelector,
  TriggerEventId,
  TriggerSpec,
} from '../../data/triggers';
import type { BurnSpread } from '../ailments/records';
import { DOT_STEP_TICKS } from '../ailments/rings';
import { compileCondition } from '../build/eval';
import type { CompiledCondition } from '../build/eval';
import type { SourceTable } from '../build/sources';
import { TICK_RATE } from '../types';
import { compileSelector } from './select';
import type { CompiledSelector } from './select';

/**
 * The built-in shatter (docs/v3/game-design-v3.md §1.3): a frozen enemy that dies hits the
 * enemies around it for shatterDamage of its max life. It is the trigger at this index, a kill
 * trigger listed only when the build can freeze. Only a frozen victim's kill records it, with
 * the victim's max life as its value and the credit of the frost that froze it as its source
 * (recordPendingKills in dispatch.ts). Its damage carries this index as its origin, so a kill by
 * a shatter does not shatter.
 */
export const SHATTER_TRIGGER = 0;

/** Damage-over-time steps per second (ailmentTick's `every` counts them). */
const STEPS_PER_SECOND = TICK_RATE / DOT_STEP_TICKS;

/** Events at this depth or deeper raise no triggers but a kill's transfers. */
export const MAX_DEPTH = 3;
/** Effects run per tick at most; the rest carry over. */
export const EFFECTS_PER_TICK = 2000;
/**
 * Queued effects at most. The newest past it are dropped and counted (effectsDropped), against
 * plan §2.6 rule 4 (nothing is dropped), so a runaway build cannot exhaust memory; the balance
 * tools treat any drop as a failure.
 */
export const EFFECT_QUEUE_HARD_CAP = 65536;

/** TRIGGER_EVENTS ordinal of each event: CompiledBuild.triggersOn's index. */
export const EVENT = Object.fromEntries(TRIGGER_EVENTS.map((event, index) => [event, index])) as {
  readonly [K in TriggerEventId]: number;
};

export interface CompiledTrigger {
  readonly index: number;
  /** TRIGGER_EVENTS ordinal; −1 for a rule module instance's entry, which listens to nothing. */
  readonly on: number;
  /** nthAttack: fires on every Nth event; 1 for every other event. */
  readonly every: number;
  /** Source index its effects are credited to. */
  readonly source: number;
  /** Its `when` conditions but chance, cooldownSec and hitIs 'signature'. */
  readonly conds: readonly CompiledCondition[];
  /** Chance to fire, × coef and at most 1; rolled on the trigger stream below 1. */
  readonly chance: number;
  /** Ticks after firing before it can fire again. */
  readonly cooldownTicks: number;
  /** Its effects: CompiledBuild.effects[effectStart .. effectEnd). */
  readonly effectStart: number;
  readonly effectEnd: number;
  /** hitIs 'signature': fires only on events carrying SIGNATURE (rule 8). */
  readonly signatureOnly: boolean;
  /**
   * A kill or diedWithAilment trigger whose effects all transfer ailments (TRANSFER_EFFECTS): it
   * runs at the kill, while the victim still holds them, rather than from the queue.
   */
  readonly inline: boolean;
  /** Calibration coefficient, applied at compile to the chance and COEF_FIELDS; 1 for data. */
  readonly coef: number;
  /** periodic: its period in ticks; 0 for every other event. */
  readonly periodTicks: number;
  /**
   * ailmentTick: it fires on the DoT steps k with k % stepEvery === 0, for each enemy holding
   * its ailment (src/sim/systems/ailments.ts); 0 for every other event.
   */
  readonly stepEvery: number;
  /** One of its effects reads the dying enemy's drop (gainShards): kill entries carry it. */
  readonly takesDrop: boolean;
  /**
   * Its target selector (TriggerSpec.target, select.ts): its effects act on the enemy it picks
   * instead of the event's; null without one.
   */
  readonly selector: CompiledSelector | null;
  /**
   * A kill, diedWithAilment or shatter trigger with a detonate: the DETONATE_AILMENTS ordinal of
   * its ailment, whose damage the victim had left its pending kills carry; −1 for every other.
   */
  readonly detonateAilment: number;
}

/** The built-in shatter's effect (SHATTER_TRIGGER), which no data can name. */
export interface ShatterSpec {
  readonly kind: 'shatter';
}
export type CompiledEffectSpec = EffectSpec | ShatterSpec;
export type CompiledEffectKind = CompiledEffectSpec['kind'];

export interface CompiledEffect {
  readonly kind: CompiledEffectKind;
  /** The effect's spec, its COEF_FIELDS × the trigger's coefficient (a missing field as 1). */
  readonly spec: CompiledEffectSpec;
  /** Source index of its damage, the source of the trigger or module that compiled it. */
  readonly source: number;
  /** Its radius squared; 0 without a radius. */
  readonly radiusSq: number;
  /**
   * Tags of its hits (explode, nova: hit, trigger and area, plus its tags and element; shatter:
   * hit, area and cold; groundZone: hit and zone, plus its tags and element; detonate: its
   * ailment's kind and trigger, plus area with a radius; projectiles: hit, trigger and
   * projectile, plus its tags and element; slashLine: hit and trigger, plus its tags; coinHit:
   * hit and trigger) or of the hit an ailment it applies counts as (applyAilment: hit and
   * trigger); 0 for the others.
   */
  readonly tags: TagMask;
  /**
   * Damage of a hit or of the hit an applied ailment counts as: damage stat × damagePct (coinHit:
   * × multiplier; a slashLine's payload scales it by its critScale, RunContext.effectPayloads);
   * 1 for shatter, whose hits scale it by the victim's max life, and for detonate, whose hits
   * deal the damage it takes from the ailment; the damage stat for groundZone, whose pulses
   * scale it by damagePctPerSec × 0.25 and its ailment by ailmentDamagePct.
   */
  readonly baseDamage: Num;
  /** spreadAilment's radius and effect (src/sim/ailments/apply.ts); null for the other kinds. */
  readonly spread: BurnSpread | null;
  /**
   * Its trigger's selector picks an enemy: the entry's target is that enemy, and the effect
   * centers on it rather than on the event's point.
   */
  readonly atTarget: boolean;
  /** Its trigger's selector picks 'player': the effect centers on the player, with no target. */
  readonly atPlayer: boolean;
  /**
   * It acts on its target alone (applyAilment, addFrost and detonate without a radius): on a
   * center event with a list, a trigger without a selector queues it once per alive enemy of
   * the list (fireOne in dispatch.ts).
   */
  readonly fanout: boolean;
}

/**
 * Compiles a trigger at `index` whose effects start at `effectStart` in CompiledBuild.effects;
 * an inZone condition numbers its source in `sources`. Throws on an event the simulation does
 * not raise yet.
 */
export function compileTrigger(
  index: number,
  spec: TriggerSpec,
  source: number,
  coef: number,
  effectStart: number,
  sources?: SourceTable,
): CompiledTrigger {
  if (!WIRED_EVENTS.has(spec.on)) {
    throw new Error(`A trigger on '${spec.on}': the simulation does not raise this event yet`);
  }
  if (spec.on === 'periodic' && !((spec.every ?? 0) > 0)) {
    throw new Error('A periodic trigger needs its period in seconds (every > 0)');
  }
  const ailmentEvent = spec.on === 'ailmentApplied' || spec.on === 'ailmentTick';
  const named = (spec.when ?? []).filter((condition) => 'ailment' in condition).length;
  if (ailmentEvent && named !== 1) {
    throw new Error(`A trigger on '${spec.on}' needs exactly one ailment condition`);
  }
  let chance = 1;
  let cooldownSec = 0;
  let signatureOnly = false;
  const conds: CompiledCondition[] = [];
  for (const condition of spec.when ?? []) {
    if ('chance' in condition) chance = condition.chance;
    else if ('cooldownSec' in condition) cooldownSec = condition.cooldownSec;
    else if ('hitIs' in condition && condition.hitIs === 'signature') signatureOnly = true;
    else conds.push(compileCondition(condition, spec.on, sources));
  }
  const kill = spec.on === 'kill' || spec.on === 'diedWithAilment';
  // Validation keeps a dead enemy's detonates to one ailment.
  const detonate = spec.do.find((effect): effect is DetonateSpec => effect.kind === 'detonate');
  const dead = kill || spec.on === 'shatter';
  return {
    index,
    on: EVENT[spec.on],
    every: spec.on === 'nthAttack' ? (spec.every ?? 1) : 1,
    source,
    conds,
    chance: Math.min(1, chance * coef),
    cooldownTicks: Math.round(cooldownSec * TICK_RATE),
    effectStart,
    effectEnd: effectStart + spec.do.length,
    signatureOnly,
    inline: kill && spec.do.every((effect) => TRANSFER_EFFECTS.has(effect.kind)),
    coef,
    periodTicks:
      spec.on === 'periodic' ? Math.max(1, Math.round((spec.every as number) * TICK_RATE)) : 0,
    stepEvery:
      spec.on === 'ailmentTick'
        ? Math.max(1, Math.round((spec.every ?? DOT_STEP_TICKS / TICK_RATE) * STEPS_PER_SECOND))
        : 0,
    takesDrop: spec.do.some((effect) => effect.kind === 'gainShards'),
    selector: spec.target === undefined ? null : compileSelector(spec.target, spec.on),
    detonateAilment:
      dead && detonate !== undefined ? DETONATE_AILMENTS.indexOf(detonate.ailment) : -1,
  };
}

/** The entry of a rule module instance at `index`: it listens to no event and has no effects. */
export function moduleTrigger(index: number, source: number): CompiledTrigger {
  return {
    index,
    on: -1,
    every: 1,
    source,
    conds: [],
    chance: 1,
    cooldownTicks: 0,
    effectStart: 0,
    effectEnd: 0,
    signatureOnly: false,
    inline: false,
    coef: 1,
    periodTicks: 0,
    stepEvery: 0,
    takesDrop: false,
    selector: null,
    detonateAilment: -1,
  };
}

/**
 * SHATTER_TRIGGER's entry: on kill with its effect at `effectStart` when the build can freeze,
 * otherwise an entry that listens to no event and has no effect.
 */
export function shatterTrigger(canFreeze: boolean, effectStart: number): CompiledTrigger {
  return {
    ...moduleTrigger(SHATTER_TRIGGER, 0),
    on: canFreeze ? EVENT.kill : -1,
    effectStart: canFreeze ? effectStart : 0,
    effectEnd: canFreeze ? effectStart + 1 : 0,
  };
}

/**
 * The shatter's effect: hits of tags hit, area and cold within `radius` of the victim. Its
 * source is the center; each shatter is credited to its PendingKill's source instead.
 */
export function shatterEffect(radius: number): CompiledEffect {
  return {
    kind: 'shatter',
    spec: { kind: 'shatter' },
    source: 0,
    radiusSq: radius ** 2,
    tags: TAG.hit | TAG.area | TAG.cold,
    baseDamage: ONE,
    spread: null,
    atTarget: false,
    atPlayer: false,
    fanout: false,
  };
}

/** `spec` with its COEF_FIELDS × coef; a field left out counts as 1. */
function withCoef(spec: EffectSpec, coef: number): EffectSpec {
  const fields = COEF_FIELDS[spec.kind] as readonly string[];
  if (fields.length === 0) return spec;
  const scaled: Record<string, unknown> = { ...spec };
  for (const field of fields) scaled[field] = ((scaled[field] as number | undefined) ?? 1) * coef;
  return scaled as unknown as EffectSpec;
}

/**
 * Compiles an effect credited to `source`, with its COEF_FIELDS × coef; `damage` is the build's
 * damage stat, and `target` the selector of its trigger, if any.
 */
export function compileEffect(
  spec: EffectSpec,
  source: number,
  coef: number,
  damage: number,
  target?: TargetSelector,
): CompiledEffect {
  // An effect's damage is damage × (damagePct × coef): the coefficient goes into the field
  // first. Keep that association, or a calibrated effect's damage moves by ulps.
  const scaled = withCoef(spec, coef);
  const radius = 'radius' in scaled ? (scaled.radius ?? 0) : 0;
  let tags = 0;
  let baseDamage = ZERO;
  let spread: BurnSpread | null = null;
  let fanout = false;
  switch (scaled.kind) {
    case 'explode':
    case 'nova':
      tags =
        TAG.hit |
        TAG.trigger |
        TAG.area |
        tagMask(scaled.tags ?? []) |
        (scaled.element === undefined ? 0 : TAG[scaled.element]);
      baseDamage = mul(num(damage), scaled.damagePct);
      break;
    case 'projectiles':
      tags =
        TAG.hit |
        TAG.trigger |
        TAG.projectile |
        tagMask(scaled.tags ?? []) |
        (scaled.element === undefined ? 0 : TAG[scaled.element]);
      baseDamage = mul(num(damage), scaled.damagePct);
      break;
    case 'slashLine':
      tags = TAG.hit | TAG.trigger | tagMask(scaled.tags ?? []);
      baseDamage = mul(num(damage), scaled.damagePct);
      break;
    case 'coinHit':
      tags = TAG.hit | TAG.trigger;
      baseDamage = mul(num(damage), scaled.multiplier);
      break;
    case 'applyAilment':
      tags = TAG.hit | TAG.trigger;
      baseDamage = mul(num(damage), scaled.damagePct ?? 1);
      fanout = scaled.radius === undefined;
      break;
    case 'spreadAilment':
      spread = { radius, radiusSq: radius ** 2, effect: scaled.effect ?? 1 };
      break;
    case 'addFrost':
      fanout = scaled.radius === undefined;
      break;
    case 'groundZone':
      tags =
        TAG.hit |
        TAG.zone |
        tagMask(scaled.tags ?? []) |
        (scaled.element === undefined ? 0 : TAG[scaled.element]);
      baseDamage = num(damage);
      break;
    case 'detonate':
      tags = TAG[scaled.ailment] | TAG.trigger | (scaled.radius === undefined ? 0 : TAG.area);
      baseDamage = ONE;
      fanout = scaled.radius === undefined;
      break;
    default:
      break;
  }
  return {
    kind: scaled.kind,
    spec: scaled,
    source,
    radiusSq: radius ** 2,
    tags,
    baseDamage,
    spread,
    atTarget: target !== undefined && target.pick !== 'player',
    atPlayer: target !== undefined && target.pick === 'player',
    fanout,
  };
}
