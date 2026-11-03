/**
 * compileBuild: a build's stat block, rules and signature attack compiled into what one run
 * reads (docs/v3/implementation-plan-v3.md §2.7). The signature's module compiles first, after
 * the build's own triggers, when it has changes of its own (SignatureModule.compile); then the
 * rule modules (src/sim/rules/) run once, in the order their ids first appear in the rules, each
 * with all of its instances: at the center on an M1 run, and on a character run (CharacterRun)
 * at their board's source, from specs scaled by its fusion's coefficient (docs/v3 C6 design D9,
 * D10). Both scale and offset stats, add modifiers, set flags and the signature attack's
 * parameters, and add triggers, effects and hooks. The result holds the final stat values, the
 * ModTable of the build's scoped modifiers followed by the module-added ones, the run's damage
 * sources and who its ailments and the center's chain jumps are credited to (D8), the hook
 * lists, the emitters: the signature's first, then the emitter grants, the build's
 * (StatBlock.emitters) and the modules', one per kind, source and key; the triggers with their
 * effects: the built-in shatter (SHATTER_TRIGGER) first, then the build's own
 * (StatBlock.triggers), then the modules', in compile order (src/sim/effects/types.ts); and the
 * build's damage conversions, which the ModTable lists per hit row (src/sim/combat/convert.ts).
 *
 * The source table, the attribution's outer sources and the ModTable rows grow while a run
 * uses them, so createRunContext compiles a fresh build for every run. The talent screen and
 * the balance tools compile their own for estimates (signatureRows, keyedStat, centerStat,
 * centerDamage) and never pass one into a run.
 */

import { grantKey } from '../../data/emitters';
import type { SourcedEmitter } from '../../data/emitters';
import { M1_SIGNATURE, RULE_COEF_FIELDS, scaleRuleSpec } from '../../data/rules';
import type { RuleId, RuleSpec, SignatureId, SignatureSpec } from '../../data/rules';
import { attackSpeedIssues, isScopedStat, powFactorIssues, STAT_IDS } from '../../data/stats';
import type { Modifier, SourcedRule, StatBlock, StatId } from '../../data/stats';
import { jumpMask, TAG } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import { TRIGGER_EVENTS } from '../../data/triggers';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { BLEED_RING_MAX_STACKS } from '../ailments/rings';
import { spreadSelector } from '../effects/select';
import {
  compileEffect,
  compileTrigger,
  moduleTrigger,
  SHATTER_TRIGGER,
  shatterEffect,
  shatterTrigger,
  sizedEffect,
} from '../effects/types';
import type { CompiledEffect, CompiledTrigger } from '../effects/types';
import { grantEmitter } from '../emitters/types';
import type { EmitterSpec } from '../emitters/types';
import { RULE_MODULES, SIGNATURES } from '../rules';
import type { BuildCompiler, HookName, Hooks, TestModule } from '../rules';
import { NO_POLICY_SPEC } from '../systems/systemState';
import type { ChainPolicySpec } from '../systems/systemState';
import type { CharacterRun } from '../types';
import { readsTargetIs, statAt, staticInput } from './eval';
import { compileConversions, compileMods, ModTable, rowValues } from './modTable';
import type { CompiledConversion, CompiledMod } from './modTable';
import { sizeOf } from './size';
import {
  CENTER,
  createAttribution,
  createSourceTable,
  jumpCredit,
  M1_CENTER_AILMENTS,
  ownAilments,
  rowKey,
  SOURCE_CLASS_ORDINAL,
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
   * Bleed stacks (大出血, gd:401; C3D:1760-1767): bleeds live in DoT rings
   * (src/sim/ailments/rings.ts RING_BLEED) instead of the strongest-only slot, at most
   * bleedMaxStacks live stacks an enemy, read only when bleedRings is set.
   */
  bleedRings: boolean;
  bleedMaxStacks: number;
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
   * Burn stacks an enemy holding frost can carry beyond the records cap (霜焰, frostflame); read
   * by burnCapOf. Under burnRings the cap stays BURN_RINGS_MAX_STACKS.
   */
  frostBurnCap: number;
  /**
   * The only build-wide factor on shatter damage, which takes no untagged more such as 強化∞
   * (docs/v3/game-design-v3.md §2.1): glassCannon multiplies it by 1 + damageMore as it adds
   * its more.
   */
  shatterMult: number;
  /**
   * The run keeps the combo stacks (RunContext.sys.combo, src/sim/systems/combo.ts;
   * docs/v3/game-design-v3.md §4.5): compileBuild sets it once the modules have run when a
   * modifier scales on comboStacks, an effect is a comboStack, the build has 殘影's comboEcho
   * (C6b.4) or bulletDodgeCombo is above 0 (節奏閃避, C7b); a module that reads the stacks
   * otherwise sets it itself. False: the stacks stay 0 and nothing counts them.
   */
  combo: boolean;
  /**
   * The stacks' cap (Infinity: 「層數沒有上限」, ★無盡連擊); the idle ticks, without a target
   * for the signature emitter, after which the stacks keep floor(stacks × comboIdleKeep)
   * (0: all go; ◆慣性's 0.75, which keeps at least 1: 「不會歸零」), again at each further
   * multiple; and what a hit on the player keeps of them, floor(stacks × comboHitKeep)
   * (★無盡連擊's 0: 「被擊中時歸零」).
   */
  comboCap: number;
  comboIdleTicks: number;
  comboIdleKeep: number;
  comboHitKeep: number;
  /**
   * The run computes the shards held, and the alive enemies an aura pulse would reach, once a
   * tick into EvalInput (src/sim/systems/globals.ts): compileBuild sets each once the modules
   * have run when a modifier scales on shardsHeld (enemiesInAura), and a module that reads the
   * variable otherwise sets it itself. False: the variable stays 0 and nothing computes it.
   */
  shardsHeld: boolean;
  enemiesInAura: boolean;
  /**
   * The stacks at which the combo is full (「滿層」: 殘影, ◆爆發): full means stacks ≥ comboFull.
   * A module may set it; left null, compileBuild sets it once the modules have run, to comboCap
   * while that is finite and to DEFAULT_COMBO_CAP when a module lifts the cap (★無盡連擊), so
   * ★ turns neither off. A compiled build's is never null.
   */
  comboFull: number | null;
  /**
   * 殘影 (gd §4.5's threshold, 「滿層時每次攻擊留下殘影，0.3 秒後重複那一擊（50% 傷害）」): each
   * counted attack of the signature emitter at full stacks schedules one repeat of it delaySec
   * later (src/sim/systems/combo.ts), at damagePct of its damage; null (no echo) unless a module
   * sets it, and then compileBuild sets BuildFlags.combo, since the echo reads the stacks.
   * delaySec must be positive and finite, damagePct in (0, 1].
   */
  comboEcho: { readonly delaySec: number; readonly damagePct: number } | null;
  /**
   * 巨大化 (gigantism, src/sim/rules/gigantism.ts): the factor on every area radius and on the
   * straight shots' hit radius (src/sim/systems/shots.ts), 1 without it.
   */
  sizeFactor: number;
  /** 巨大化: whether the four counts are halved (countOf, src/sim/build/size.ts); false without it. */
  halveCounts: boolean;
  /**
   * The factor sizeOf (src/sim/build/size.ts) multiplies every area radius by:
   * max(0, values.areaSize) × sizeFactor, which compileBuild sets once the modules have run and
   * before it sizes the effects' radii; a module sets sizeFactor, never this. 1 for a build
   * without either, whose radii stay as written bit for bit (r × 1 is r).
   */
  areaFactor: number;
  /**
   * The build has a spawnDrone effect, a trigger's or one a module compiled: its run's drone pool
   * holds the summon cap of rows, with the per-spec tables of the timed rows
   * (src/sim/systems/systemState.ts createDronePool). compileBuild sets it once the modules have
   * run; false keeps the pool at the rows its layout placed, as every run without one.
   */
  spawnsDrones: boolean;
  /**
   * The run finds the alive enemy with the most hp once a tick into EvalInput.highestHpId
   * (src/sim/systems/globals.ts), which targetIs 'highestHp' reads: compileBuild sets it once
   * the modules have run when any compiled condition is a targetIs, a modifier's `when` (the
   * build's or a module's, compileMods) or a trigger's (the build's or a module's,
   * compileTrigger). False: the id stays 0 and nothing computes it.
   */
  highestHp: boolean;
  /**
   * 神經毒 (poisonSlow, src/sim/rules/poisonSlow.ts): enemySlow (src/sim/ailments/frost.ts) takes
   * min(poisonSlowMax, poisonSlowPer × floor(live poison stacks / poisonSlowStacks)) as one more
   * source. 0 = off: every other run's enemySlow and movement stay as they were.
   */
  poisonSlowStacks: number;
  poisonSlowPer: number;
  poisonSlowMax: number;
  /**
   * The spread factor (擴散距離, E3): max(0, values.spreadRadius), which compileBuild sets beside
   * areaFactor. A spread's radius is × it as well as × areaFactor: every spreadAilment's and a
   * marked applyAilment's (sizedEffect), and a marked selector's range × it alone
   * (spreadSelector); a rule module's own spread distances read it through spreadOf
   * (src/sim/build/size.ts). 1 for a build without spreadRadius.
   */
  spreadFactor: number;
  /**
   * 鎖定信標 (gd:479 「召喚物優先打菁英與 Boss」): every summon's pick takes the elites and bosses
   * (Enemy.tough) first (src/sim/systems/drones.ts): the drones' and the outer spirits' pickOuter
   * and the nearest spirits' pickNearest run their tiers over the alive tough enemies before
   * every enemy, and a turret's focus targets are the tough enemies at any distance, not only
   * near the player (focused). False: every pick as before. Its +30 % is data.
   */
  summonEliteFirst: boolean;
  /**
   * 蟲海 (gd:193, :480 「無人機數量 ×2」): every drone emitter's drones, a grant's and the swarm's,
   * × this whole number ≥ 1 at the fill, before 巨大化 halves them (src/sim/emitters/drone.ts);
   * never the turrets or the timed rows. The summon cap refuses the rows past it, as ever. 1
   * without it; compileBuild refuses any other value.
   */
  droneCountMult: number;
  /**
   * 蟲海's 「撞完不回巢，直接找下一個目標」: a drone whose sortie's impacts are spent starts a full one
   * at once and picks again as a drone that lost its target does; when that finds nothing it
   * stays on the target it ended on while that is alive in the arena, waiting out its cooldown
   * memory, and flies home only when it is not (src/sim/systems/drones.ts dash, repick). The
   * spirits are not drones: they leave spent. False: it flies home.
   */
  dronesStay: boolean;
  /**
   * 加農砲 (gd:477 「砲台攻擊頻率 ÷3、傷害 ×4、範圍爆炸」): the factor on every drone emitter's turret
   * rate (TURRET_RATE, the swarm's turrets too; src/sim/emitters/types.ts emitterInterval), 1/3
   * for ÷3, and the radius of the explosion around a turret shot's target, sized once through
   * sizeOf at the fill (src/sim/systems/shots.ts turretArrival): 0 is none, and above it the
   * turret payloads are tagged area too. Defaults 1 and 0; compileBuild refuses a rate factor
   * that is not finite and above 0, and a splash below 0 or not finite.
   */
  turretRateMult: number;
  turretSplash: number;
  /**
   * 特斯拉塔 (gd:477 「砲台的攻擊連鎖 2 次」): chain jumps every turret shot's arrival adds, a whole
   * number ≥ 0 read through countOf once at the fill, so 巨大化 halves them: a signature turret's
   * chain takes ctx.chainCount + these, and a granted turret's hit becomes an attack of its own
   * whose chain takes them. 0 without it; compileBuild refuses any other value.
   */
  turretChains: number;
  /**
   * The run counts the live timed rows of its drone pool once a tick into EvalInput.minionCount
   * (src/sim/systems/globals.ts), which a modifier's scaling reads as minionCount: compileBuild
   * sets it once the modules have run when a modifier scales on minionCount, the build's or a
   * module's, and a module that reads the variable otherwise sets it itself. False: the variable
   * stays 0 and nothing counts it.
   */
  minionCount: boolean;
}

/**
 * The combo's cap (gd:419's 「上限 20」): BuildFlags.comboCap's default, and comboFull's when a
 * module lifts the cap.
 */
export const DEFAULT_COMBO_CAP = 20;

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
  /** The arc's (triphaseArc, src/sim/emitters/arc.ts); null for another signature. */
  arc: ArcParams | null;
  /** The swarm's (swarm, src/sim/systems/drones.ts); null for another signature. */
  swarm: SwarmParams | null;
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
  /**
   * The bombs' fire zones (火地): their slow on the enemies in them, 0 to 1, and the factors on
   * their duration, damage a second and radius (煉獄's 熔流, 灼地 and 火海; src/sim/rules/zoneTune.ts),
   * 1 when nothing changes them.
   */
  zone: { slow: number; durationMult: number; damageMult: number; radiusMult: number };
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

/**
 * The arc's parameters, which its signature module sets: its spec's coils, one target, its full
 * damage. Its form, 六線圈, changes them (src/sim/rules/sixCoils.ts).
 */
export interface ArcParams {
  /**
   * Discharges a second at the base attack speed, which take turns from this many coils
   * (EmitterRuntime.coil): ArcSpec.coils as the signature module copies it, or 六線圈's. The run
   * reads the count here only, never from the spec.
   */
  coils: number;
  /** Enemies a discharge strikes, each a primary hit of its one chain. */
  targets: 1 | 2;
  /** The factor on the arc's damage, folded into its payload's base damage. */
  damageMult: number;
}

/**
 * The swarm's parameters, which its signature module sets: its drones' and turrets' counts and
 * numbers, at attack frequency 1. The run reads them here only, never from its emitter's spec
 * (src/sim/emitters/drone.ts), so the rules that change them write them in place; drones +
 * turrets must stay at least 1 (compileBuild throws otherwise).
 */
export interface SwarmParams {
  drones: number;
  turrets: number;
  /** A drone's speed, arena units a second. */
  speed: number;
  /** A drone's dock time between sorties, in seconds. */
  dockSec: number;
  /** A drone's same-enemy cooldown, in seconds: how long it waits to impact one enemy again. */
  cooldownSec: number;
  /** Impacts a sortie. */
  impacts: number;
  /** The radius around its target that an impact hits, before sizeOf (src/sim/build/size.ts). */
  splash: number;
  /** A turret shot's base damage as a fraction of the damage stat. */
  turretDamagePct: number;
}

export interface CompiledBuild {
  /** Every stat's final value: StatBlock.values after the rules' scaleStat and offsetStat. */
  readonly values: Readonly<Record<StatId, number>>;
  readonly table: ModTable;
  /** The ModTable's modifiers: StatBlock.scoped in data order, then the module-added ones. */
  readonly mods: readonly CompiledMod[];
  /** The run's source ids; index 0 is 'center'. */
  readonly sources: SourceTable;
  /**
   * Who ailment damage and the center's chain jumps are credited to; in M1 every ailment is the
   * center's own, and so are its jumps.
   */
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
  if (mod.stat === 'damage') {
    if (mod.kind === 'flat') return 'is flat damage';
  } else {
    const untagged =
      (mod.tags?.length ?? 0) === 0 && (mod.notTags?.length ?? 0) === 0 && mod.scope === undefined;
    if (untagged && mod.scaling === undefined) {
      return 'applies to every instance; use scaleStat or offsetStat';
    }
  }
  // A module's cadence factor and powFactor obey the data's rules (src/data/stats.ts; R15).
  return attackSpeedIssues(mod)[0] ?? powFactorIssues(mod)[0] ?? null;
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
 * Compiles `stats` with `rules` and the `signature` attack for one run, an M1 run; with
 * `character`, a character run, whose rules are character.rules (`rules` is empty; validateConfig,
 * src/sim/simulation.ts). testModules are for tests only (TestModule); they compile after the
 * rule modules.
 */
export function compileBuild(
  stats: StatBlock,
  rules: readonly RuleSpec[],
  signature: SignatureSpec = M1_SIGNATURE,
  testModules: readonly TestModule[] = [],
  character: CharacterRun | null = null,
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
    bleedRings: false,
    bleedMaxStacks: BLEED_RING_MAX_STACKS,
    frostImmuneTicks: 180,
    bossLockTicks: 252,
    bossMinGapTicks: 0,
    globalSlow: 0,
    frostBurnCap: 0,
    shatterMult: 1,
    combo: false,
    comboCap: DEFAULT_COMBO_CAP,
    comboIdleTicks: 60,
    comboIdleKeep: 0,
    comboHitKeep: 0.5,
    shardsHeld: false,
    enemiesInAura: false,
    comboFull: null,
    comboEcho: null,
    sizeFactor: 1,
    halveCounts: false,
    areaFactor: 1,
    spawnsDrones: false,
    highestHp: false,
    poisonSlowStacks: 0,
    poisonSlowPer: 0,
    poisonSlowMax: 0,
    spreadFactor: 1,
    summonEliteFirst: false,
    droneCountMult: 1,
    dronesStay: false,
    turretRateMult: 1,
    turretSplash: 0,
    turretChains: 0,
    minionCount: false,
  };
  const params: SignatureParams = {
    forceCritEvery: 0,
    counts: 'shot',
    id: signature.id,
    lob: null,
    fan: null,
    arc: null,
    swarm: null,
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
  // The StatBlock's barrage count, read once a compile: a projectiles effect with countStat links
  // its count to it (compileEffect; docs/v3 C6 design §7.4 C6b.1), whoever adds the effect.
  const barrageCount = stats.values.barrageCount;
  const addTrigger = (source: number, spec: TriggerSpec, coef: number): void => {
    triggers.push(compileTrigger(triggers.length, spec, source, coef, effects.length, sources));
    for (const effect of spec.do) {
      effects.push(compileEffect(effect, source, coef, values.damage, spec.target, barrageCount));
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
    credit: () => ({ source: instanceSource, name: sources.names[instanceSource] as string }),
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
      const ix = sources.index(source);
      effects.push(compileEffect(spec, ix, coef, values.damage, undefined, barrageCount));
      return effects.length - 1;
    },
    addEmitter(source, grant) {
      grants.push({ source, grant });
    },
    chainPolicy() {
      // The jumps a policy adds are the signature payload's (Payload.extraJumpPayload), credited
      // as the center's: on a character run only an instance at that credit may write it, or,
      // on 雷塔, one at an ascendancy node, whose added jumps are the center's (gd:575; docs/v3
      // C6 design D8, F38). Content that would credit them elsewhere fails here.
      if (
        character !== null &&
        instanceSource !== jumpCreditOfCenter &&
        !(character.id === 'lightning' && sources.cls[instanceSource] === SOURCE_CLASS_ORDINAL.asc)
      ) {
        throw new Error(
          `chainPolicy() from source '${sources.names[instanceSource]}' on a ${character.id} run: ` +
            `the center's chain jumps are credited to '${sources.names[jumpCreditOfCenter]}'`,
        );
      }
      chainPolicy ??= { ...NO_POLICY_SPEC, decay: [] };
      return chainPolicy;
    },
  };

  for (const { source, spec, coef } of stats.triggers) {
    addTrigger(sources.index(source), spec, coef ?? 1);
  }
  // Numbered here, after the data triggers and before anything else, so its index depends only
  // on them (docs/v3 C6 design D8, F37): on 熔核, 霜晶 and 蜂巢 the center's chain jumps are
  // credited to outer.lightning, a zero row while nothing jumps; on 雷塔 and M1, to the center.
  const centerJump =
    character === null || character.id === 'lightning' ? -1 : sources.index('outer.lightning');
  const jumpCreditOfCenter = centerJump >= 0 ? centerJump : CENTER;
  // The signature's changes come before the rules', whose scaleStat calls then scale them too.
  compileInstance(CENTER, () => compileSignature(signature.id, signature, compiler, CENTER));
  if (character === null) {
    // An M1 run: every rule is the center's.
    for (const id of new Set(rules.map((rule) => rule.id))) {
      compileInstance(CENTER, () => compileRule(id, rules, compiler, CENTER));
    }
  } else {
    // A character run: each rule id's group at its board's source, from specs its fusion's
    // coefficient scaled, so a module never sees the coefficient (docs/v3 C6 design D9, D10).
    // validateConfig keeps one source and one coef per rule id.
    for (const id of new Set(character.rules.map((rule) => rule.spec.id))) {
      const group = character.rules.filter((rule) => rule.spec.id === id);
      const { source, coef } = group[0] as SourcedRule;
      const ix = sources.index(source);
      const specs = group.map((rule) => scaleRuleSpec(rule.spec, coef, RULE_COEF_FIELDS));
      compileInstance(ix, () => compileRule(id, specs, compiler, ix));
    }
  }
  for (const module of testModules) {
    const source = module.source === undefined ? CENTER : sources.index(module.source);
    compileInstance(source, () => module(compiler, source));
  }
  // The modules write the swarm's counts in place: a swarm with no drone or turret would attack
  // never, though its repeats would still impact.
  const swarm = params.swarm;
  if (swarm !== null && !(swarm.drones + swarm.turrets >= 1)) {
    throw new Error(`swarm: ${swarm.drones} drones and ${swarm.turrets} turrets; it needs one`);
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
  // The area factor (D29), now that every module has set its part: every effect's radius is
  // sized here once, the shatter's as it is compiled, and the executors read them as they are.
  // An areaSize below 0 is no area at all, never a negative radius whose square is positive.
  // So too the spread factor (E3), which a spread's radius takes beside the area factor in the
  // same pass, and a marked selector's range alone; a spreadRadius below 0 is no spread.
  flags.areaFactor = Math.max(0, values.areaSize) * flags.sizeFactor;
  flags.spreadFactor = Math.max(0, values.spreadRadius);
  if (flags.areaFactor !== 1 || flags.spreadFactor !== 1) {
    for (let i = 0; i < effects.length; i++) {
      effects[i] = sizedEffect(effects[i] as CompiledEffect, flags.areaFactor, flags.spreadFactor);
    }
    if (flags.spreadFactor !== 1) {
      for (let i = 0; i < triggers.length; i++) {
        const t = triggers[i] as CompiledTrigger;
        if (t.selector === null || t.selector.spreadRange < 0) continue;
        triggers[i] = { ...t, selector: spreadSelector(t.selector, flags.spreadFactor) };
      }
    }
  }
  if (canFreeze) {
    triggers[SHATTER_TRIGGER] = shatterTrigger(true, effects.length);
    effects.push(shatterEffect(sizeOf({ flags }, Math.max(0, values.shatterRadius))));
  }
  // The run counts the combo stacks only for a build that reads or adds them (lead ruling K1),
  // 殘影 included, which reads them for 「滿層」, so every other build's run stays the same bit
  // for bit. 節奏閃避 reads them (C7b).
  flags.combo ||=
    scoped.some((mod) => mod.scaling?.per === 'comboStacks') ||
    effects.some((fx) => fx.spec.kind === 'comboStack') ||
    flags.comboEcho !== null ||
    values.bulletDodgeCombo > 0;
  // So too the per-tick variables (lead ruling G2).
  flags.shardsHeld ||= scoped.some((mod) => mod.scaling?.per === 'shardsHeld');
  flags.enemiesInAura ||= scoped.some((mod) => mod.scaling?.per === 'enemiesInAura');
  flags.minionCount ||= scoped.some((mod) => mod.scaling?.per === 'minionCount');
  // Only a build that spawns timed rows sizes its drone pool past its fixed rows (C5.7, lead
  // ruling K3).
  flags.spawnsDrones = effects.some((fx) => fx.spec.kind === 'spawnDrone');
  // 「滿層」 (lead ruling E2): a module's own value stays; otherwise the cap, or gd's 20 when a
  // module lifted the cap, so ★無盡連擊 keeps 殘影 and ◆爆發.
  flags.comboFull ??= Number.isFinite(flags.comboCap) ? flags.comboCap : DEFAULT_COMBO_CAP;
  const echo = flags.comboEcho;
  if (
    echo !== null &&
    !(
      echo.delaySec > 0 &&
      Number.isFinite(echo.delaySec) &&
      echo.damagePct > 0 &&
      echo.damagePct <= 1
    )
  ) {
    throw new Error(
      `comboEcho: delaySec ${echo.delaySec} must be positive and finite, ` +
        `damagePct ${echo.damagePct} in (0, 1]`,
    );
  }
  // The summon policies only modules write (C5.9): the fill reads them as they are.
  if (!(Number.isInteger(flags.droneCountMult) && flags.droneCountMult >= 1)) {
    throw new Error(`droneCountMult: ${flags.droneCountMult} must be a whole number >= 1`);
  }
  if (!(Number.isFinite(flags.turretRateMult) && flags.turretRateMult > 0)) {
    throw new Error(`turretRateMult: ${flags.turretRateMult} must be finite and above 0`);
  }
  if (!(Number.isFinite(flags.turretSplash) && flags.turretSplash >= 0)) {
    throw new Error(`turretSplash: ${flags.turretSplash} must be finite and >= 0`);
  }
  if (!(Number.isInteger(flags.turretChains) && flags.turretChains >= 0)) {
    throw new Error(`turretChains: ${flags.turretChains} must be a whole number >= 0`);
  }
  const triggersOn = TRIGGER_EVENTS.map((_, event) =>
    Int32Array.from(triggers.filter((t) => t.on === event).map((t) => t.index)),
  );

  const mods = compileMods(scoped, sources);
  // So too the highest-hp enemy (lead ruling H2): every condition compiles in compileMods (a
  // modifier's `when`, the build's and the modules') or in compileTrigger (a trigger's, through
  // addTrigger), so a targetIs anywhere in the build is in one of these.
  flags.highestHp ||=
    mods.some((mod) => readsTargetIs(mod.cond)) || triggers.some((t) => readsTargetIs(t.conds));
  const conversions = compileConversions(stats.conversions);
  const table = new ModTable(
    mods,
    rowValues(stats.base, 1),
    rowValues(postScale, 1),
    rowValues(postOffset, 0),
    conversions,
  );
  return {
    values,
    table,
    mods,
    sources,
    attribution: createAttribution(
      character === null ? M1_CENTER_AILMENTS : ownAilments(character.id),
      centerJump,
    ),
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
 * jumpMask of the tags credited to the jump credit of that source (jumpCredit: an emitter
 * payload's jumpSource; outer.lightning for the center's on 熔核, 霜晶 and 蜂巢), without
 * and with crit. They are the rows its payload's SLOT_HIT, SLOT_HIT_CRIT, SLOT_JUMP and
 * SLOT_JUMP_CRIT read in a run (src/sim/emitters/types.ts); the estimates outside a run read
 * them too (the talent screen's summary, typicalHit, the balance tools): M1's hits are hit and
 * projectile, 熔核's explosions hit, area and projectile, 霜晶's cones hit, projectile and cold,
 * 雷塔's discharges hit, chain and lightning, so their jumps share their rows, and 蜂巢's drone
 * impacts hit, minion and area, whose jumps (hit, chain and minion) have rows of their own.
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
  const jumpSource = jumpCredit(build.attribution, source);
  const jump = jumpMask(spec.tags);
  return {
    hit: rowKey(spec.tags, source),
    hitCrit: rowKey(spec.tags | TAG.crit, source),
    jump: rowKey(jump, jumpSource),
    jumpCrit: rowKey(jump | TAG.crit, jumpSource),
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
