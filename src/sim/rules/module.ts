/**
 * Rule modules (docs/v3/implementation-plan-v3.md §2.7): the keystone rules that change how a
 * run plays rather than a number data can carry. Each RuleSpec id has one module, registered in
 * RULE_MODULES (index.ts). compileBuild (src/sim/build/compile.ts) compiles each module once per
 * run with every instance of its rule, through a BuildCompiler: the module scales or offsets
 * stats, adds modifiers, sets build flags and the signature attack's parameters, and registers
 * hooks the simulation calls at fixed points of the tick.
 */

import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { Modifier, StatId } from '../../data/stats';
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
  /** Adds a hook; hooks of one name run in the order they were added. */
  hook<K extends HookName>(name: K, fn: Hooks[K]): void;
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
}

/** The attack an onAttack hook sees; one reused object per run (RunContext.shotScratch). */
export interface ShotScratch {
  /**
   * False before the onAttack hooks run; a hook that sets it makes every projectile of this
   * attack steady, on top of the signature's own rhythm (SignatureParams).
   */
  forceCrit: boolean;
}

/** Points in the tick where the simulation calls rule modules. Hooks allocate nothing. */
export interface Hooks {
  /** Every tick after the emitters' attacks, while the player is alive. */
  readonly tick: (ctx: RunContext) => void;
  /** At each kill, while the victim is still alive: before removeEnemy, drops and split. */
  readonly onKill: (ctx: RunContext, victim: Enemy, kill: Readonly<KillScratch>) => void;
  /**
   * At each attack of an emitter, once it is counted (em.attacks includes it) and before its
   * projectiles fire. A hook may only set shot.forceCrit.
   */
  readonly onAttack: (ctx: RunContext, em: Readonly<EmitterRuntime>, shot: ShotScratch) => void;
}

export type HookName = keyof Hooks;

/**
 * A rule module without a RuleSpec, for tests only: compiled after the rule modules, with the
 * center as its source, as one module instance. createSimulation(config, data, testModules)
 * passes them on; RunConfig has no such field, so content cannot reach it.
 */
export type TestModule = (b: BuildCompiler, source: number) => void;
