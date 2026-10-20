/**
 * compileBuild: a build's stat block, rules and signature attack compiled into what one run
 * reads (docs/v3/implementation-plan-v3.md §2.7). The signature's module compiles first, after
 * the build's own triggers, when it has changes of its own (SignatureModule.compile); then the
 * rule modules (src/sim/rules/) run once, in the order their ids first appear in the rules, each
 * with all of its instances. Both scale and offset stats, add modifiers, set flags and the
 * signature attack's parameters, and add triggers, effects and hooks. The result holds the final
 * stat values, the ModTable of the build's scoped modifiers followed by the module-added ones,
 * the run's damage sources and ailment attribution, the hook lists, the emitters: the
 * signature's first, then the emitter grants, the build's (StatBlock.emitters) and the modules',
 * one per kind, source and key; the triggers with their effects: the built-in shatter
 * (SHATTER_TRIGGER) first, then the build's own (StatBlock.triggers), then the modules', in
 * compile order (src/sim/effects/types.ts); and the build's damage conversions, which the
 * ModTable lists per hit row (src/sim/combat/convert.ts).
 *
 * The source table, the attribution's outer sources and the ModTable rows grow while a run
 * uses them, so createRunContext compiles a fresh build for every run. The talent screen and
 * the balance tools compile their own for estimates (signatureRows, keyedStat, centerStat,
 * centerDamage) and never pass one into a run.
 */

import { grantKey } from '../../data/emitters';
import type { SourcedEmitter } from '../../data/emitters';
import { M1_SIGNATURE } from '../../data/rules';
import type { RuleId, RuleSpec, SignatureId, SignatureSpec } from '../../data/rules';
import { isScopedStat, SCOPED_STATS, STAT_IDS } from '../../data/stats';
import type { Modifier, StatBlock, StatId } from '../../data/stats';
import { jumpMask, TAG } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import { TRIGGER_EVENTS } from '../../data/triggers';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import {
  compileEffect,
  compileTrigger,
  moduleTrigger,
  SHATTER_TRIGGER,
  shatterEffect,
  shatterTrigger,
} from '../effects/types';
import type { CompiledEffect, CompiledTrigger } from '../effects/types';
import { grantEmitter } from '../emitters/types';
import type { EmitterSpec } from '../emitters/types';
import { RULE_MODULES, SIGNATURES } from '../rules';
import type { BuildCompiler, HookName, Hooks, TestModule } from '../rules';
import { NO_POLICY_SPEC } from '../systems/systemState';
import type { ChainPolicySpec } from '../systems/systemState';
import { statAt, staticInput } from './eval';
import { compileConversions, compileMods, ModTable } from './modTable';
import type { CompiledConversion, CompiledMod } from './modTable';
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
   * Burn stacks are uncapped (eternalFlame): burns live in DoT rings (src/sim/ailments/rings.ts)
   * instead of capped records.
   */
  burnRings: boolean;
  /** Bleed damage multiplier while the bleeding enemy moves (docs/v3/game-design-v3.md §4.3). */
  bleedMoveMult: number;
  /**
   * Frost (src/sim/ailments/frost.ts, docs/v3/game-design-v3.md §1.3): ticks after a freeze
   * during which frost adds nothing; ticks a boss's meter stays locked once it fills, at least
   * bossMinGapTicks; and a slow every enemy always has, 0 to 1. Absolute Zero sets them.
   */
  frostImmuneTicks: number;
  bossLockTicks: number;
  bossMinGapTicks: number;
  globalSlow: number;
  /**
   * The only build-wide factor on shatter damage, which takes no untagged more such as 強化∞
   * (docs/v3/game-design-v3.md §2.1): glassCannon multiplies it by 1 + damageMore as it adds
   * its more.
   */
  shatterMult: number;
}

/** Parameters of the signature attack. */
export interface SignatureParams {
  /** Every Nth shot, or every shot of every Nth attack (counts), crits (steadyAim); 0 when off. */
  forceCritEvery: number;
  /** What forceCritEvery counts: shots fired (projectiles, bombs, cones), or attacks. */
  counts: 'shot' | 'attack';
  /** The run's signature attack, which the forms' compile errors name. */
  id: SignatureSpec['id'];
  /** The lob's (magmaBomb, src/sim/emitters/lob.ts); null for another signature. */
  lob: LobParams | null;
  /** The fan's (iceFan, src/sim/emitters/fan.ts); null for another signature. */
  fan: FanParams | null;
}

/**
 * The lob's parameters, which its signature module sets to these neutral values: no far throws,
 * no volcano, no chain blasts, fire zones that do not slow. The lob's forms change them
 * (src/sim/rules/lobForms.ts).
 */
export interface LobParams {
  /** Every Nth bomb is thrown at the farthest enemy instead; 0 for none. */
  farThrowEvery: number;
  /** Giant bombs on a period of their own in place of the others, with their factors; or null. */
  volcano: { periodSec: number; radiusMult: number; damageMult: number } | null;
  /**
   * Explosions of the enemies a bomb's explosion kills, perBomb at most, of `radius` and
   * damagePct, run as `effect` (an effect index) from trigger `trigger`; or null.
   */
  chainBlast: {
    radius: number;
    damagePct: number;
    perBomb: number;
    trigger: number;
    effect: number;
  } | null;
  /** The bombs' fire zones (火地): their slow on the enemies in them, 0 to 1. */
  zone: { slow: number };
}

/**
 * The fan's parameters, which its signature module sets to these neutral values: no icicle
 * rounds, no prism. The fan's forms change them (src/sim/rules/fanForms.ts).
 */
export interface FanParams {
  /** Every Nth round counted fires one icicle cone instead (EmitterRuntime.alt); 0 for none. */
  icicleEvery: number;
  /** The icicle cone's share of the damage stat. */
  icicleDamagePct: number;
  /**
   * Every round fires one cone at its target that passes through every enemy on its line, its
   * hits scaled by min(1 + maxBonus, 1 + perPierce × the enemies it passed before); or null.
   */
  prism: { perPierce: number; maxBonus: number } | null;
}

export interface CompiledBuild {
  /** Every stat's final value: StatBlock.values after the rules' scaleStat and offsetStat. */
  readonly values: Readonly<Record<StatId, number>>;
  readonly table: ModTable;
  /** The ModTable's modifiers: StatBlock.scoped in data order, then the module-added ones. */
  readonly mods: readonly CompiledMod[];
  /** The run's source ids; index 0 is 'center'. */
  readonly sources: SourceTable;
  /** Who ailment damage is credited to; in M1 every ailment is the center's own. */
  readonly attribution: AttributionPolicy;
  readonly flags: Readonly<BuildFlags>;
  readonly signature: Readonly<SignatureParams>;
  /** Each hook's functions, in the order the modules added them. */
  readonly hooks: { readonly [K in HookName]: readonly Hooks[K][] };
  /** The trigger index of the module instance that added each hook, in the same order. */
  readonly hookOwners: { readonly [K in HookName]: readonly number[] };
  /**
   * The run's emitters; index 0 is the signature attack, then the granted ones (grantEmitters).
   */
  readonly emitters: readonly EmitterSpec[];
  /**
   * Every trigger, by trigger index: SHATTER_TRIGGER first, which listens to kill only when the
   * build can freeze; a module instance's entry listens to no event.
   */
  readonly triggers: readonly CompiledTrigger[];
  /** Per TRIGGER_EVENTS ordinal, the indices of the triggers listening to it, in order. */
  readonly triggersOn: readonly Int32Array[];
  /** Every effect: the triggers' in trigger order, and the ones modules added (addEffect). */
  readonly effects: readonly CompiledEffect[];
  /** The damage conversions (StatBlock.conversions), in data order; the table's. */
  readonly conversions: readonly CompiledConversion[];
  /**
   * What the modules wrote through BuildCompiler.chainPolicy(); null when none called it.
   * createRunContext compiles it once per run for the signature payload and its repeats.
   */
  readonly chainPolicy: ChainPolicySpec | null;
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

/** The signature module's own changes to the build, if it has any (SignatureModule.compile). */
function compileSignature<K extends SignatureId>(
  id: K,
  spec: Extract<SignatureSpec, { id: K }>,
  b: BuildCompiler,
  source: number,
): void {
  SIGNATURES[id].compile?.(b, spec, source);
}

/**
 * The emitters of the grants, in grant order, the first of each kind, source and key
 * (grantKey): a node grants each emitter once, and nodes of one source that grant the same one
 * agree on its fields (data validation), so dropping the others loses nothing.
 */
function grantEmitters(grants: readonly SourcedEmitter[]): EmitterSpec[] {
  const seen = new Set<string>();
  const emitters: EmitterSpec[] = [];
  for (const { source, grant } of grants) {
    const id = `${grant.kind}|${source}|${grantKey(grant)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    emitters.push(grantEmitter(source, grant));
  }
  return emitters;
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
  const flags: BuildFlags = {
    randomCrits: true,
    maxLife: null,
    burnRings: false,
    bleedMoveMult: 3,
    frostImmuneTicks: 180,
    bossLockTicks: 252,
    bossMinGapTicks: 0,
    globalSlow: 0,
    shatterMult: 1,
  };
  const params: SignatureParams = {
    forceCritEvery: 0,
    counts: 'shot',
    id: signature.id,
    lob: null,
    fan: null,
  };
  const hooks: { [K in HookName]: Hooks[K][] } = {
    tick: [],
    onKill: [],
    onAttack: [],
    onHit: [],
    modifyDamage: [],
    onCenterEvent: [],
  };
  const hookOwners: { [K in HookName]: number[] } = {
    tick: [],
    onKill: [],
    onAttack: [],
    onHit: [],
    modifyDamage: [],
    onCenterEvent: [],
  };
  // The talent nodes' emitter grants, then the ones modules add.
  const grants: SourcedEmitter[] = [...stats.emitters];
  // SHATTER_TRIGGER's index; its entry is decided once every module has compiled.
  const triggers: CompiledTrigger[] = [shatterTrigger(false, 0)];
  const effects: CompiledEffect[] = [];
  const addTrigger = (source: number, spec: TriggerSpec, coef: number): void => {
    triggers.push(compileTrigger(triggers.length, spec, source, coef, effects.length, sources));
    for (const effect of spec.do) {
      effects.push(compileEffect(effect, source, coef, values.damage, spec.target));
    }
  };
  // The module instance being compiled, its source and its trigger index (−1 until its first
  // hook or instanceTrigger call).
  let instanceSource = CENTER;
  let instance = -1;
  const compileInstance = (source: number, compile: () => void): void => {
    instanceSource = source;
    instance = -1;
    compile();
  };
  const instanceTrigger = (): number => {
    if (instance < 0) {
      instance = triggers.length;
      triggers.push(moduleTrigger(instance, instanceSource));
    }
    return instance;
  };
  let chainPolicy: ChainPolicySpec | null = null;

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
      const owner = instanceTrigger();
      hookOwners[name].push(owner);
      return owner;
    },
    instanceTrigger,
    addTrigger(source, spec, coef = 1) {
      addTrigger(sources.index(source), spec, coef);
    },
    addEffect(source: string, spec: EffectSpec, coef = 1) {
      effects.push(compileEffect(spec, sources.index(source), coef, values.damage));
      return effects.length - 1;
    },
    addEmitter(source, grant) {
      grants.push({ source, grant });
    },
    chainPolicy() {
      chainPolicy ??= { ...NO_POLICY_SPEC, decay: [] };
      return chainPolicy;
    },
  };

  for (const { source, spec } of stats.triggers) addTrigger(sources.index(source), spec, 1);
  // The signature's changes come before the rules', whose scaleStat calls then scale them too.
  compileInstance(CENTER, () => compileSignature(signature.id, signature, compiler, CENTER));
  // Every rule is credited to the center until characters give rules their own sources.
  for (const id of new Set(rules.map((rule) => rule.id))) {
    compileInstance(CENTER, () => compileRule(id, rules, compiler, CENTER));
  }
  for (const module of testModules) {
    const source = module.source === undefined ? CENTER : sources.index(module.source);
    compileInstance(source, () => module(compiler, source));
  }
  // Shatter listens to kills only when something can fill a chill meter: frost on hit, or an
  // addFrost effect or a groundZone with frost, a trigger's or one a module compiled.
  const scoped = [...stats.scoped, ...added];
  const canFreeze =
    values.frostOnHit > 0 ||
    scoped.some((mod) => mod.stat === 'frostOnHit' && mod.value > 0) ||
    effects.some(
      (fx) =>
        fx.spec.kind === 'addFrost' ||
        (fx.spec.kind === 'groundZone' && (fx.spec.addFrostPerSec ?? 0) > 0),
    );
  if (canFreeze) {
    triggers[SHATTER_TRIGGER] = shatterTrigger(true, effects.length);
    effects.push(shatterEffect(Math.max(0, values.shatterRadius)));
  }
  const triggersOn = TRIGGER_EVENTS.map((_, event) =>
    Int32Array.from(triggers.filter((t) => t.on === event).map((t) => t.index)),
  );

  const mods = compileMods(scoped, sources);
  const conversions = compileConversions(stats.conversions);
  const scopedOf = (perStat: Readonly<Record<StatId, number>>): Float64Array =>
    Float64Array.from(SCOPED_STATS, (stat) => perStat[stat]);
  const table = new ModTable(
    mods,
    scopedOf(stats.base),
    scopedOf(postScale),
    scopedOf(postOffset),
    conversions,
  );
  return {
    values,
    table,
    mods,
    sources,
    attribution: createAttribution(M1_CENTER_AILMENTS),
    flags,
    signature: params,
    hooks,
    hookOwners,
    emitters: [signatureEmitter(signature.id, signature), ...grantEmitters(grants)],
    triggers,
    triggersOn,
    effects,
    conversions,
    chainPolicy,
  };
}

/**
 * ModTable keys (rowKey) of the signature attack's hits, from its emitter's tags and source
 * (CompiledBuild.emitters[0]): its primary hit's without and with crit, and its chain jumps',
 * jumpMask of the tags credited to the same source (an emitter payload's jumpSource), without
 * and with crit. They are the rows its payload's SLOT_HIT, SLOT_HIT_CRIT, SLOT_JUMP and
 * SLOT_JUMP_CRIT read in a run (src/sim/emitters/types.ts); the estimates outside a run read
 * them too (the talent screen's summary, typicalHit, the balance tools): M1's hits are hit and
 * projectile, 熔核's explosions hit, area and projectile, 霜晶's cones hit, projectile and cold.
 */
export interface SignatureRows {
  readonly hit: number;
  readonly hitCrit: number;
  readonly jump: number;
  readonly jumpCrit: number;
}

/**
 * The signature attack's row keys (SignatureRows), with no payload or RNG; its source numbered
 * in `build.sources` on first use, as its payload numbers it in a run.
 */
export function signatureRows(build: CompiledBuild): SignatureRows {
  const spec = build.emitters[0] as EmitterSpec;
  const source = build.sources.index(spec.source);
  const jump = jumpMask(spec.tags);
  return {
    hit: rowKey(spec.tags, source),
    hitCrit: rowKey(spec.tags | TAG.crit, source),
    jump: rowKey(jump, source),
    jumpCrit: rowKey(jump | TAG.crit, source),
  };
}

/**
 * Scoped stat `stat` (SCOPED_INDEX) of the instances of ModTable key `key` (rowKey, e.g. a
 * signatureRows key), `chainJump` jumps into their chain (0 for a primary hit), for estimates
 * outside a run: without a target, so conditional modifiers are left out.
 */
export function keyedStat(build: CompiledBuild, key: number, stat: number, chainJump = 0): number {
  // Row first: filling it may grow, and so replace, the table's arrays.
  const row = build.table.row(key);
  return statAt(build.table, row, stat, staticInput(chainJump));
}

/**
 * Scoped stat `stat` (SCOPED_INDEX) of a center instance with tags `mask`, `chainJump` jumps
 * into its chain (0 for a primary hit), for estimates outside a run (keyedStat).
 */
export function centerStat(
  build: CompiledBuild,
  mask: TagMask,
  stat: number,
  chainJump = 0,
): number {
  return keyedStat(build, rowKey(mask, CENTER), stat, chainJump);
}

/**
 * Damage multiplier of a center instance with tags `mask` outside a run: a primary hit with
 * these tags deals values.damage × centerDamage(build, mask) before crits and conversions.
 */
export function centerDamage(build: CompiledBuild, mask: TagMask): number {
  return build.table.damage(rowKey(mask, CENTER));
}
