/**
 * compileBuild: a build's stat block, rules and signature attack compiled into what one run
 * reads (docs/v3/implementation-plan-v3.md §2.7). The rule modules (src/sim/rules/) run once, in
 * the order their ids first appear in the rules, each with all of its instances; they scale and
 * offset stats, add modifiers, set flags and the signature attack's parameters, and add
 * triggers, effects and hooks. The result holds the final stat values, the ModTable of the
 * build's scoped modifiers followed by the rule-added ones, the run's damage sources and ailment
 * attribution, the hook lists, the emitters, the signature's first, and the triggers with their
 * effects: the build's own (StatBlock.triggers) first, then the modules', in compile order
 * (src/sim/effects/types.ts).
 *
 * The source table, the attribution's outer sources and the ModTable rows grow while a run
 * uses them, so createRunContext compiles a fresh build for every run. The talent screen and
 * the balance tools compile their own for estimates (centerStat, centerDamage) and never pass
 * one into a run.
 */

import { M1_SIGNATURE } from '../../data/rules';
import type { RuleId, RuleSpec, SignatureId, SignatureSpec } from '../../data/rules';
import { isScopedStat, SCOPED_STATS, STAT_IDS } from '../../data/stats';
import type { Modifier, StatBlock, StatId } from '../../data/stats';
import type { TagMask } from '../../data/tags';
import { TRIGGER_EVENTS } from '../../data/triggers';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { compileEffect, compileTrigger, moduleTrigger } from '../effects/types';
import type { CompiledEffect, CompiledTrigger } from '../effects/types';
import type { EmitterSpec } from '../emitters/types';
import { RULE_MODULES, SIGNATURES } from '../rules';
import type { BuildCompiler, HookName, Hooks, TestModule } from '../rules';
import { statAt, staticInput } from './eval';
import { compileMods, ModTable } from './modTable';
import type { CompiledMod } from './modTable';
import {
  CENTER,
  createAttribution,
  createSourceTable,
  M1_CENTER_AILMENTS,
  rowKey,
} from './sources';
import type { AttributionPolicy, SourceTable } from './sources';

/** Build-wide switches the rule modules set. */
export interface BuildFlags {
  /** Hits roll for crits; steadyAim turns it off, Static Focus's per-jump chance included. */
  randomCrits: boolean;
  /** Max life override (glassCannon), or null. */
  maxLife: number | null;
  /**
   * Burn stacks are uncapped (eternalFlame). Until burns move to rings, the records keep
   * UNCAPPED_BURN_STACKS as their cap (src/sim/ailments/records.ts).
   */
  burnRings: boolean;
}

/** Parameters of the signature attack. */
export interface SignatureParams {
  /** Every Nth shot, or every shot of every Nth attack (counts), crits (steadyAim); 0 when off. */
  forceCritEvery: number;
  /** What forceCritEvery counts: projectiles fired, or attacks. */
  counts: 'shot' | 'attack';
}

export interface CompiledBuild {
  /** Every stat's final value: StatBlock.values after the rules' scaleStat and offsetStat. */
  readonly values: Readonly<Record<StatId, number>>;
  readonly table: ModTable;
  /** The ModTable's modifiers: StatBlock.scoped in data order, then the rule-added ones. */
  readonly mods: readonly CompiledMod[];
  /** The run's source ids; index 0 is 'center'. */
  readonly sources: SourceTable;
  /** Who ailment damage is credited to; in M1 every ailment is the center's own. */
  readonly attribution: AttributionPolicy;
  readonly flags: Readonly<BuildFlags>;
  readonly signature: Readonly<SignatureParams>;
  /** Each hook's functions, in the order the modules added them. */
  readonly hooks: { readonly [K in HookName]: readonly Hooks[K][] };
  /** The run's emitters; index 0 is the signature attack. */
  readonly emitters: readonly EmitterSpec[];
  /** Every trigger, by trigger index; a module instance's entry listens to no event. */
  readonly triggers: readonly CompiledTrigger[];
  /** Per TRIGGER_EVENTS ordinal, the indices of the triggers listening to it, in order. */
  readonly triggersOn: readonly Int32Array[];
  /** Every effect: the triggers' in trigger order, and the ones modules added (addEffect). */
  readonly effects: readonly CompiledEffect[];
}

function compileRule<K extends RuleId>(
  id: K,
  rules: readonly RuleSpec[],
  b: BuildCompiler,
  source: number,
): void {
  const specs = rules.filter((rule): rule is Extract<RuleSpec, { id: K }> => rule.id === id);
  RULE_MODULES[id].compile(b, specs, source);
}

/**
 * Why a rule module may not add this modifier, or null. A modifier must be scoped; flat damage
 * stays in StatBlock.values.damage, and a static untagged modifier of another stat would change
 * its rows but not its value, so scaleStat and offsetStat do that instead.
 */
function addedModifierIssue(mod: Modifier): string | null {
  if (!isScopedStat(mod.stat)) return 'is not a scoped stat; use scaleStat or offsetStat';
  if (mod.stat === 'damage') return mod.kind === 'flat' ? 'is flat damage' : null;
  const untagged =
    (mod.tags?.length ?? 0) === 0 && (mod.notTags?.length ?? 0) === 0 && mod.scope === undefined;
  return untagged && mod.scaling === undefined
    ? 'applies to every instance; use scaleStat or offsetStat'
    : null;
}

function signatureEmitter<K extends SignatureId>(
  id: K,
  spec: Extract<SignatureSpec, { id: K }>,
): EmitterSpec {
  return SIGNATURES[id].emitter(spec);
}

/**
 * Compiles `stats` with `rules` and the `signature` attack for one run. testModules are for
 * tests only (TestModule); they compile after the rule modules.
 */
export function compileBuild(
  stats: StatBlock,
  rules: readonly RuleSpec[],
  signature: SignatureSpec = M1_SIGNATURE,
  testModules: readonly TestModule[] = [],
): CompiledBuild {
  const sources = createSourceTable();
  const values: Record<StatId, number> = { ...stats.values };
  // The rules' post-operations of each stat, folded into one scale and one offset:
  // value = StatBlock value × postScale + postOffset, and the same on every row of a scoped
  // stat, so the untagged row stays equal to `values` bit for bit.
  const postScale = Object.fromEntries(STAT_IDS.map((id) => [id, 1])) as Record<StatId, number>;
  const postOffset = Object.fromEntries(STAT_IDS.map((id) => [id, 0])) as Record<StatId, number>;
  const refold = (stat: StatId): void => {
    values[stat] = stats.values[stat] * postScale[stat] + postOffset[stat];
  };
  const notDamage = (stat: StatId, operation: string): void => {
    if (stat === 'damage') {
      throw new Error(`${operation}('damage'): damage rows hold no flat value; add a modifier`);
    }
  };
  const added: Modifier[] = [];
  const flags: BuildFlags = { randomCrits: true, maxLife: null, burnRings: false };
  const params: SignatureParams = { forceCritEvery: 0, counts: 'shot' };
  const hooks: { [K in HookName]: Hooks[K][] } = {
    tick: [],
    onKill: [],
    onAttack: [],
    onHit: [],
    modifyDamage: [],
    onCenterEvent: [],
  };
  const triggers: CompiledTrigger[] = [];
  const effects: CompiledEffect[] = [];
  const addTrigger = (source: number, spec: TriggerSpec, coef: number): void => {
    triggers.push(compileTrigger(triggers.length, spec, source, coef, effects.length));
    for (const effect of spec.do) {
      effects.push(compileEffect(effect, source, coef, values.damage));
    }
  };
  // The module instance being compiled, its source and its trigger index (−1 until its first
  // hook).
  let instanceSource = CENTER;
  let instance = -1;
  const compileInstance = (source: number, compile: () => void): void => {
    instanceSource = source;
    instance = -1;
    compile();
  };

  const compiler: BuildCompiler = {
    values,
    scaleStat(stat, factor) {
      notDamage(stat, 'scaleStat');
      postScale[stat] *= factor;
      postOffset[stat] *= factor;
      refold(stat);
    },
    offsetStat(stat, delta) {
      notDamage(stat, 'offsetStat');
      postOffset[stat] += delta;
      refold(stat);
    },
    addModifier(mod) {
      const issue = addedModifierIssue(mod);
      if (issue !== null) throw new Error(`addModifier: ${JSON.stringify(mod)} ${issue}`);
      added.push(mod);
    },
    flags,
    signature: () => params,
    source: (name) => sources.index(name),
    hook(name, fn) {
      hooks[name].push(fn);
      if (instance < 0) {
        instance = triggers.length;
        triggers.push(moduleTrigger(instance, instanceSource));
      }
      return instance;
    },
    addTrigger(source, spec, coef = 1) {
      addTrigger(sources.index(source), spec, coef);
    },
    addEffect(source: string, spec: EffectSpec, coef = 1) {
      effects.push(compileEffect(spec, sources.index(source), coef, values.damage));
      return effects.length - 1;
    },
  };

  for (const { source, spec } of stats.triggers) addTrigger(sources.index(source), spec, 1);
  // Every rule is credited to the center until characters give rules their own sources.
  for (const id of new Set(rules.map((rule) => rule.id))) {
    compileInstance(CENTER, () => compileRule(id, rules, compiler, CENTER));
  }
  for (const module of testModules) compileInstance(CENTER, () => module(compiler, CENTER));
  const triggersOn = TRIGGER_EVENTS.map((_, event) =>
    Int32Array.from(triggers.filter((t) => t.on === event).map((t) => t.index)),
  );

  const mods = compileMods([...stats.scoped, ...added], sources);
  const scopedOf = (perStat: Readonly<Record<StatId, number>>): Float64Array =>
    Float64Array.from(SCOPED_STATS, (stat) => perStat[stat]);
  const table = new ModTable(mods, scopedOf(stats.base), scopedOf(postScale), scopedOf(postOffset));
  return {
    values,
    table,
    mods,
    sources,
    attribution: createAttribution(M1_CENTER_AILMENTS),
    flags,
    signature: params,
    hooks,
    emitters: [signatureEmitter(signature.id, signature)],
    triggers,
    triggersOn,
    effects,
  };
}

/**
 * Scoped stat `stat` (SCOPED_INDEX) of a center instance with tags `mask`, `chainJump` jumps
 * into its chain (0 for a primary hit), for estimates outside a run: without a target, so
 * conditional modifiers are left out.
 */
export function centerStat(
  build: CompiledBuild,
  mask: TagMask,
  stat: number,
  chainJump = 0,
): number {
  // Row first: filling it may grow, and so replace, the table's arrays.
  const row = build.table.row(rowKey(mask, CENTER));
  return statAt(build.table, row, stat, staticInput(chainJump));
}

/**
 * Damage multiplier of a center instance with tags `mask` outside a run: a primary hit with
 * these tags deals values.damage × centerDamage(build, mask) before crits.
 */
export function centerDamage(build: CompiledBuild, mask: TagMask): number {
  return build.table.damage(rowKey(mask, CENTER));
}
