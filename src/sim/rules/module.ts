/**
 * Rule modules (docs/v3/implementation-plan-v3.md §2.7): the keystone rules that change how a
 * run plays rather than a number data can carry. Each RuleSpec id has one module, registered in
 * RULE_MODULES (index.ts). compileBuild (src/sim/build/compile.ts) compiles each module once per
 * run with every instance of its rule, through a BuildCompiler: the module scales or offsets
 * stats, adds modifiers, sets build flags and the signature attack's parameters, adds triggers
 * and effects, and registers hooks the simulation calls at fixed points of the tick.
 *
 * Each module instance (one compile call, or one TestModule) is one trigger of the build: its
 * first hook() takes it a trigger index, which every hook of the instance shares. Hooks deal
 * damage or apply ailments only by queueing their effects (enqueueModuleEffect in api.ts) with
 * that index as the origin, so the instance never fires on its own damage (rule 3).
 */

import type { Num } from '../../core/num';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { Modifier, StatId } from '../../data/stats';
import type { TagMask } from '../../data/tags';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import type { BuildFlags, SignatureParams } from '../build/compile';
import type { EmitterRuntime, EmitterSpec } from '../emitters/types';
import type { Enemy, RunContext } from '../systems/context';

export interface RuleModule<P extends RuleSpec> {
  readonly id: P['id'];
  /**
   * Called once per run with every instance of this id, in node order, and the source the
   * rules are credited to. Instances merge as M1 did: min, product or sum per parameter.
   */
  compile(b: BuildCompiler, specs: readonly P[], source: number): void;
}

/** What a rule module may change while it compiles. */
export interface BuildCompiler {
  /** Every stat's value after the scaleStat and offsetStat calls so far. */
  readonly values: Readonly<Record<StatId, number>>;
  /**
   * Multiplies the stat's value, and for a scoped stat every ModTable row's value of it, after
   * all modifiers, including the offsetStat calls made before it. Throws on 'damage': a damage
   * row holds no flat value; use addModifier.
   */
  scaleStat(stat: StatId, factor: number): void;
  /**
   * Adds to the stat's value, and to every row's value of it, after all modifiers; later
   * scaleStat calls scale it too. Throws on 'damage'.
   */
  offsetStat(stat: StatId, delta: number): void;
  /**
   * A scoped modifier after the build's own modifiers, in rule order (CompiledBuild.mods).
   * Throws on a stat that is not scoped, on flat damage, and on a static untagged modifier of a
   * stat other than damage, which would change its rows but not its value (use scaleStat or
   * offsetStat).
   */
  addModifier(mod: Modifier): void;
  readonly flags: BuildFlags;
  /** The signature attack's parameters (CompiledBuild.signature), to change in place. */
  signature(): SignatureParams;
  /** Index of a damage source, numbering it on first use (SourceTable.index). */
  source(name: string): number;
  /**
   * Adds a hook; hooks of one name run in the order they were added. Returns the instance's
   * trigger index, taken at its first hook() call: the origin of what its hooks queue.
   */
  hook<K extends HookName>(name: K, fn: Hooks[K]): number;
  /**
   * Adds a trigger credited to source `source`, with its chance and COEF_FIELDS × coef
   * (default 1). It takes the next trigger index, like a data trigger.
   */
  addTrigger(source: string, spec: TriggerSpec, coef?: number): void;
  /**
   * Compiles an effect for the instance's hooks to queue (enqueueModuleEffect), credited to
   * `source`, with its COEF_FIELDS × coef (default 1). Returns its effect index.
   */
  addEffect(source: string, spec: EffectSpec, coef?: number): number;
  /**
   * Multiplier on hit damage on top of the damage row (CompiledBuild.legacyHitMult). Only
   * pandemicLegacy sets it, until pandemic becomes data (C3.7).
   */
  legacyHitMult: number;
}

/**
 * A signature attack (src/data/rules.ts SignatureSpec): the emitter compileBuild puts at index 0
 * of CompiledBuild.emitters.
 */
export interface SignatureModule<P extends SignatureSpec> {
  readonly id: P['id'];
  emitter(spec: P): EmitterSpec;
}

/** The kill an onKill hook sees; one reused object per run (RunContext.killScratch). */
export interface KillScratch {
  /** The trigger whose damage killed; −1 for emitter hits and DoT kills. */
  origin: number;
  /** Depth of the killing damage (Enemy.killDepth). */
  depth: number;
  /** The victim's position. */
  x: number;
  y: number;
  /**
   * The kill's flags (src/sim/effects/flags.ts): the killing hit's SIGNATURE, CRIT, HIT and
   * CHAIN_JUMP, the ailments the victim held, and the kill kind.
   */
  flags: number;
}

/** The attack an onAttack hook sees; one reused object per run (RunContext.shotScratch). */
export interface ShotScratch {
  /**
   * False before the onAttack hooks run; a hook that sets it makes every projectile of this
   * attack steady, on top of the signature's own rhythm (SignatureParams).
   */
  forceCrit: boolean;
}

/**
 * The hit modifyDamage and onHit hooks see; one reused object per run (RunContext.hitScratch),
 * filled before modifyDamage and completed before onHit.
 */
export interface HitScratch {
  target: Enemy;
  /** The target's position. */
  x: number;
  y: number;
  /** The instance's tags, crit included, and the source it is credited to. */
  mask: TagMask;
  source: number;
  crit: boolean;
  /** 0 for a primary hit, k for the kth chain jump. */
  chainIndex: number;
  depth: number;
  /** The trigger whose effect dealt the hit; −1 for emitter hits. */
  origin: number;
  /** The hit's flags (src/sim/effects/flags.ts); KILLED on a lethal hit. */
  flags: number;
  /** The damage dealt: set for onHit, after the modifyDamage hooks. */
  amount: Num;
}

/** The center event an onCenterEvent hook sees (RunContext.centerScratch). */
export interface CenterEventScratch {
  /** Its CENTER_EVENTS ordinal. */
  event: number;
  depth: number;
  origin: number;
  flags: number;
  /** The event's enemy; null for none. */
  target: Enemy | null;
  x: number;
  y: number;
}

/** Points in the tick where the simulation calls rule modules. Hooks allocate nothing. */
export interface Hooks {
  /** Every tick after the emitters' attacks, while the player is alive. May queue effects. */
  readonly tick: (ctx: RunContext) => void;
  /**
   * At each kill, while the victim is still alive: after the kill's transfer triggers, before
   * removeEnemy, drops and split. May queue effects.
   */
  readonly onKill: (ctx: RunContext, victim: Enemy, kill: Readonly<KillScratch>) => void;
  /**
   * At each attack of an emitter, once it is counted (em.attacks includes it) and before its
   * projectiles fire. A hook may only set shot.forceCrit.
   */
  readonly onAttack: (ctx: RunContext, em: Readonly<EmitterRuntime>, shot: ShotScratch) => void;
  /**
   * After each hit: a surviving hit once its ailments are applied, a lethal one before the kill
   * (with KILLED in its flags). May queue effects.
   */
  readonly onHit: (ctx: RunContext, hit: Readonly<HitScratch>) => void;
  /**
   * A hit's damage once its multipliers are applied, before it is dealt: returns the new
   * amount, which the next hook receives. A pure change of the number; ailments the hit
   * applies keep its damage before the hooks.
   */
  readonly modifyDamage: (ctx: RunContext, hit: Readonly<HitScratch>, amount: Num) => Num;
  /** At each center event that passes rule 8 (src/sim/effects/centerEvents.ts). May queue. */
  readonly onCenterEvent: (ctx: RunContext, ev: Readonly<CenterEventScratch>) => void;
}

export type HookName = keyof Hooks;

/**
 * A rule module without a RuleSpec, for tests only: compiled after the rule modules, with the
 * center as its source, as one module instance. createSimulation(config, data, testModules)
 * passes them on; RunConfig has no such field, so content cannot reach it.
 */
export type TestModule = (b: BuildCompiler, source: number) => void;
