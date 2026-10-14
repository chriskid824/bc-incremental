/**
 * Per-instance stat reads (docs/v3/implementation-plan-v3.md §2.1): the value of a scoped stat
 * in a ModTable row, with the row's dynamic entries (modifiers with a scaling or conditions)
 * evaluated for one damage instance, and the conditions themselves, which triggers check too
 * (src/sim/effects/dispatch.ts). The simulation and the build estimators
 * (tools/balance/session.ts) share it; estimates read with a static input that has no target.
 */

import { lt, mul } from '../../core/num';
import { SCOPED_STATS } from '../../data/stats';
import { HELD_AILMENTS, STACK_AILMENTS, TARGET_KINDS } from '../../data/triggers';
import type {
  Condition,
  HeldAilment,
  ScalingCurve,
  ScalingSpec,
  ScalingVar,
  StackAilment,
  TriggerEventId,
} from '../../data/triggers';
import { holdsBleed } from '../ailments/bleed';
import { holdsBurn, liveBurnStacks } from '../ailments/records';
import { holdsPoison, livePoisonStacks } from '../ailments/rings';
import { activeShockStacks, holdsShock } from '../ailments/shock';
import {
  AILMENT_FLAG_MASK,
  appliedFlag,
  CHAIN_JUMP,
  CRIT_HIT,
  heldFlag,
  HELD_SHIFT,
  HIT_EVENT,
  killKindFlag,
} from '../effects/flags';
import type { Enemy } from '../systems/context';
import type { CompiledMod, ModTable } from './modTable';

/** Values per row, and the position of damage in a row (as in modTable.ts). */
const S = SCOPED_STATS.length;
const DAMAGE = SCOPED_STATS.indexOf('damage');

/** CompiledMod.kind codes. */
const FLAT = 0;
const INCREASED = 1;

const LINEAR = 0;
const LOG10 = 1;
const POW = 2;
const CURVE_CODE: Readonly<Record<ScalingCurve, CompiledScaling['curve']>> = {
  linear: LINEAR,
  log10: LOG10,
  pow: POW,
};

/**
 * What a read of a dynamic entry or a condition looks at; one reused object per run
 * (RunContext.evalInput). `now`, `target` and `chainJump` are set before each damage instance
 * reads its stats; `playerLifeFrac`, life / max life, once per tick after the contact step.
 */
export interface EvalInput {
  now: number;
  /** The instance's target; null outside a run, where target conditions are not met. */
  target: Enemy | null;
  /** The instance's chain jump index, 0 for a primary hit and for ailments. */
  chainJump: number;
  playerLifeFrac: number;
}

/**
 * An input for estimates outside a run: no target (target conditions are not met, target
 * variables read 0) and full life.
 */
export const staticInput = (chainJump = 0): EvalInput => ({
  now: 0,
  target: null,
  chainJump,
  playerLifeFrac: 1,
});

/** Whether the enemy holds each ailment a condition can name, at tick `now`. */
const HELD_READERS: {
  readonly [K in HeldAilment]: (enemy: Enemy, now: number) => boolean;
} = {
  burn: holdsBurn,
  poison: holdsPoison,
  bleed: holdsBleed,
  shock: holdsShock,
};

/** The stacks the enemy carries of each ailment a condition can count, at tick `now`. */
const STACK_READERS: {
  readonly [K in StackAilment]: (enemy: Enemy, now: number) => number;
} = {
  burn: liveBurnStacks,
  poison: livePoisonStacks,
  shock: activeShockStacks,
};

const heldReader = HELD_AILMENTS.map((ailment) => HELD_READERS[ailment]);
const stackReader = STACK_AILMENTS.map((ailment) => STACK_READERS[ailment]);

/** The flags of the ailments `enemy` holds at tick `now` (src/sim/effects/flags.ts). */
export function heldFlags(enemy: Enemy, now: number): number {
  let flags = 0;
  for (let a = 0; a < heldReader.length; a++) {
    if ((heldReader[a] as (enemy: Enemy, now: number) => boolean)(enemy, now)) {
      flags |= 1 << (HELD_SHIFT + a);
    }
  }
  return flags;
}

/**
 * Reads each scaling variable of a damage instance. Typed over ScalingVar, so a variable added
 * to the vocabulary does not compile until it has its reader here.
 */
const SCALING_READERS: { readonly [K in ScalingVar]: (ev: Readonly<EvalInput>) => number } = {
  chainJump: (ev) => ev.chainJump,
  targetBurnStacks: (ev) => (ev.target === null ? 0 : liveBurnStacks(ev.target, ev.now)),
  targetDistance: (ev) => (ev.target === null ? 0 : ev.target.dist),
  lifeLostPct: (ev) => 1 - ev.playerLifeFrac,
  targetPoisonStacks: (ev) => (ev.target === null ? 0 : livePoisonStacks(ev.target, ev.now)),
  targetShockStacks: (ev) => (ev.target === null ? 0 : activeShockStacks(ev.target, ev.now)),
};

/** A ScalingSpec compiled for per-instance evaluation. */
export interface CompiledScaling {
  readonly read: (ev: Readonly<EvalInput>) => number;
  /** Step size; 0 for a continuous variable. */
  readonly every: number;
  /** 0 linear, 1 log10, 2 pow. */
  readonly curve: 0 | 1 | 2;
  readonly exponent: number;
  /** Upper bound on the contribution; Infinity when uncapped. */
  readonly cap: number;
}

export function compileScaling(spec: ScalingSpec): CompiledScaling {
  return {
    read: SCALING_READERS[spec.per],
    every: spec.every ?? 0,
    curve: CURVE_CODE[spec.curve ?? 'linear'],
    exponent: spec.exponent ?? 1,
    cap: spec.cap ?? Infinity,
  };
}

/** The contribution c = min(cap, value × g(x)) of a scaling modifier (src/data/triggers.ts). */
export function scaledValue(value: number, scaling: CompiledScaling, x: number): number {
  const steps = scaling.every > 0 ? Math.floor(x / scaling.every) : x;
  const g =
    scaling.curve === LINEAR
      ? steps
      : scaling.curve === LOG10
        ? Math.log10(1 + steps)
        : steps ** scaling.exponent;
  return Math.min(scaling.cap, value * g);
}

/** CompiledCondition.code values. */
const TARGET_HAS = 0;
const TARGET_KIND = 1;
const TARGET_HP_BELOW = 2;
const STACKS_AT_LEAST = 3;
/** On the event's flags (src/sim/effects/flags.ts): every bit of `a` set, none of `b`. */
const FLAGS = 4;

/**
 * A condition compiled for checking: a code and two operands. Target conditions read the
 * target (held ailment ordinal; TARGET_KINDS ordinal; hp fraction; stack ailment ordinal and
 * stacks); hitIs, victimHas and killedBy read the event's flags.
 */
export interface CompiledCondition {
  readonly code: 0 | 1 | 2 | 3 | 4;
  readonly a: number;
  readonly b: number;
}

const flagsCondition = (all: number, none = 0): CompiledCondition => ({
  code: FLAGS,
  a: all,
  b: none,
});

/**
 * Compiles a condition that is checked per event or instance; `on` is the event of a trigger's
 * condition. chance, cooldownSec and hitIs 'signature' are properties of the trigger itself
 * (src/sim/effects/types.ts), not conditions here; they throw. The ailment condition reads the
 * applied ailment from the flags of ailmentApplied events, and whether the target holds it on
 * ailmentTick events.
 */
export function compileCondition(condition: Condition, on?: TriggerEventId): CompiledCondition {
  if ('targetHas' in condition) {
    return { code: TARGET_HAS, a: HELD_AILMENTS.indexOf(condition.targetHas), b: 0 };
  }
  if ('targetKind' in condition) {
    return { code: TARGET_KIND, a: TARGET_KINDS.indexOf(condition.targetKind), b: 0 };
  }
  if ('targetHpBelow' in condition) {
    return { code: TARGET_HP_BELOW, a: condition.targetHpBelow, b: 0 };
  }
  if ('stacksAtLeast' in condition) {
    const { ailment, stacks } = condition.stacksAtLeast;
    return { code: STACKS_AT_LEAST, a: STACK_AILMENTS.indexOf(ailment), b: stacks };
  }
  if ('ailment' in condition) {
    if (on === 'ailmentApplied') {
      const flag = appliedFlag(condition.ailment);
      return flagsCondition(flag, AILMENT_FLAG_MASK & ~flag);
    }
    if (on === 'ailmentTick') {
      return { code: TARGET_HAS, a: HELD_AILMENTS.indexOf(condition.ailment), b: 0 };
    }
  }
  if ('victimHas' in condition) return flagsCondition(heldFlag(condition.victimHas));
  if ('killedBy' in condition) return flagsCondition(killKindFlag(condition.killedBy));
  if ('hitIs' in condition) {
    switch (condition.hitIs) {
      case 'crit':
        return flagsCondition(HIT_EVENT | CRIT_HIT);
      case 'nonCrit':
        return flagsCondition(HIT_EVENT, CRIT_HIT);
      case 'primary':
        return flagsCondition(HIT_EVENT, CHAIN_JUMP);
      case 'chainJump':
        return flagsCondition(HIT_EVENT | CHAIN_JUMP);
      case 'signature':
        break;
    }
  }
  throw new Error(`Not a per-event condition: ${JSON.stringify(condition)}`);
}

/** TARGET_KINDS ordinal of an enemy: a boss, an elite (M1's hexagon), or a normal enemy. */
const BOSS = TARGET_KINDS.indexOf('boss');
const ELITE = TARGET_KINDS.indexOf('elite');
const NORMAL = TARGET_KINDS.indexOf('normal');
const kindOf = (enemy: Enemy): number => (enemy.boss ? BOSS : enemy.tough ? ELITE : NORMAL);

/**
 * Every condition holds for an event or instance on `target` (null: none, and then no target
 * condition holds) at tick `now`, carrying `flags`.
 */
export function conditionsMet(
  conditions: readonly CompiledCondition[],
  target: Enemy | null,
  now: number,
  flags: number,
): boolean {
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i] as CompiledCondition;
    if (c.code === FLAGS) {
      if ((flags & c.a) !== c.a || (flags & c.b) !== 0) return false;
      continue;
    }
    if (target === null) return false;
    switch (c.code) {
      case TARGET_HAS:
        if (!(heldReader[c.a] as (enemy: Enemy, now: number) => boolean)(target, now)) {
          return false;
        }
        break;
      case TARGET_KIND:
        if (kindOf(target) !== c.a) return false;
        break;
      case TARGET_HP_BELOW:
        if (!lt(target.hp, mul(target.maxHp, c.a))) return false;
        break;
      case STACKS_AT_LEAST:
        if ((stackReader[c.a] as (enemy: Enemy, now: number) => number)(target, now) < c.b) {
          return false;
        }
        break;
    }
  }
  return true;
}

/**
 * Scoped stat `stat` (its SCOPED_STATS index) of row `row` for the damage instance `ev`. A row
 * without dynamic entries for the stat is its folded value; otherwise each dynamic entry whose
 * conditions hold adds its contribution after the row's static parts, in data order: flat and
 * increased add, more multiplies by 1 + c, where c is the entry's value or, with a scaling, its
 * scaled value. The rules' post-operations (ModTable.postScale, postOffset) then apply as they
 * do to the folded value.
 */
export function statAt(
  table: ModTable,
  row: number,
  stat: number,
  ev: Readonly<EvalInput>,
): number {
  const at = row * S + stat;
  return table.dynCount[at] === 0 ? (table.final[at] as number) : evalDynamic(table, at, stat, ev);
}

function evalDynamic(table: ModTable, at: number, stat: number, ev: Readonly<EvalInput>): number {
  const { mods, dyn } = table;
  let flat = table.flatV[at] as number;
  let inc = table.inc[at] as number;
  let more = table.more[at] as number;
  const start = table.dynStart[at] as number;
  const end = start + (table.dynCount[at] as number);
  for (let i = start; i < end; i++) {
    const mod = mods[dyn[i] as number] as CompiledMod;
    if (mod.cond !== null && !conditionsMet(mod.cond, ev.target, ev.now, 0)) continue;
    const scaling = mod.scale;
    const c = scaling === null ? mod.value : scaledValue(mod.value, scaling, scaling.read(ev));
    if (mod.kind === FLAT) flat += c;
    else if (mod.kind === INCREASED) inc += c;
    else more *= 1 + c;
  }
  const increased = 1 + inc;
  return stat === DAMAGE
    ? increased * more
    : flat * increased * more * (table.postScale[stat] as number) +
        (table.postOffset[stat] as number);
}
