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

import { BARRAGE_DAMAGE_PCT, grantKey } from '../../data/emitters';
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
  compileFire,
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
import { TICK_RATE } from '../types';
import type { CharacterRun } from '../types';
import { readsCombo, readsTargetIs, statAt, staticInput } from './eval';
import { compileConversions, compileMods, ModTable, rowValues } from './modTable';
import type { CompiledConversion, CompiledMod } from './modTable';
import { countOf, sizeOf } from './size';
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
   * (C6b.4), bulletDodgeCombo is above 0 (節奏閃避, C7b) or a trigger's condition is a
   * comboAtLeast (E14); a module that reads the stacks otherwise sets it itself. False: the
   * stacks stay 0 and nothing counts them.
   */
  combo: boolean;
  /**
   * The stacks' cap (Infinity: 「層數沒有上限」, ★無盡連擊), which compileBuild folds from the
   * comboCap stat before the modules run, max(1, floor(comboCap)), so a module's write wins
   * (E14); the idle ticks, without a target for the signature emitter, after which the stacks
   * keep floor(stacks × comboIdleKeep) (0: all go; ◆慣性's 0.75, which keeps at least 1:
   * 「不會歸零」), again at each further multiple; and what a hit on the player keeps of them,
   * floor(stacks × comboHitKeep) (★無盡連擊's 0: 「被擊中時歸零」).
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
  /**
   * 集火指令 (gd:187 「所有召喚物打生命最高的敵人」, E4): every summon's pick takes the alive enemy
   * with the most hp whose center is in the arena, the lowest id on ties, whatever the slot's
   * cooldown memory and the chase (src/sim/systems/drones.ts pickHighestHp): the drones' and the
   * outer spirits' pickOuter, the nearest spirits' pickNearest, and a turret's firing, its first
   * shot and every later one at it. Checked before summonEliteFirst, so it wins over 鎖定信標;
   * the swarm repeat's pick is no summon's and stays. False: every pick as before. Its +25 % is
   * data.
   */
  summonHighestHp: boolean;
  /**
   * ◆連鎖碎裂 (gd:105 「被碎裂打死的敵人也會碎裂」, E6): an enemy a shatter's damage kills shatters
   * too, frozen or not, credited to the killing shatter's source, its damage one depth deeper, so
   * MAX_DEPTH ends the cascade (recordPendingKills, src/sim/effects/dispatch.ts). False: a kill
   * by a shatter shatters nothing.
   */
  shatterChain: boolean;
  /**
   * ◆粉碎 (gd:106 「凍結中死亡的五角不分裂」, E6): an enemy frozen at its death leaves no split
   * children and draws nothing for them (split, src/sim/systems/spawn.ts); 增殖's children still
   * appear. False: every split-capable death splits.
   */
  frozenNoSplit: boolean;
  /**
   * The frost gain (超導's gd:527 「感電的敵人冰冷累積 ×1.5」, B5's 霜蝕 gd:119, E6): addFrost
   * (src/sim/ailments/frost.ts) multiplies every frost amount, a hit's, a zone's or an effect's,
   * by 1 + frostGainShocked on a shocked enemy + frostGainBoss on a boss, before the ward. 0 is
   * none; compileBuild refuses a value that is not finite and >= 0.
   */
  frostGainShocked: number;
  frostGainBoss: number;
  /**
   * The barrage rider's params (BarrageParams; BarrageGrant, E10a and E10b), which the barrage
   * outer's ★ and ◆ modules write in place (`b.flags.barrage.countMult = 2`,
   * `b.flags.barrage.ring = { every: 6, directions: 12 }`) and compileBuild checks after the
   * modules, with or without a grant. DEFAULT_BARRAGE_PARAMS' values, a fresh object each
   * compile; without a barrage grant they do nothing.
   */
  barrage: BarrageParams;
}

/**
 * The barrage rider's params (gd §4.11; compileBarrage, src/sim/systems/barrage.ts). compileBuild
 * refuses any value outside the ranges below, naming the field and its value.
 */
export interface BarrageParams {
  /**
   * ★子彈地獄's 「小彈數量 ×2」 (E10a): the factor on its shots an attack, its rings' and its
   * splits' children, a whole number in [1, 4]. ★'s −40% is a `more` damage scoped
   * 'outer.barrage', not a param.
   */
  countMult: number;
  /** ★子彈地獄's 「小彈會在場地邊緣反彈（最多 2 次）」 (E10a): a whole number in [0, 4]. */
  bounce: number;
  /**
   * ◆扇形 (gd:489 「小彈改成扇形射向同一個目標」, E10b): 'fan' fires an attack's shots at its
   * first pick alone, spread over spreadDeg; 'distinct' at the nearest distinct enemies.
   */
  aim: 'distinct' | 'fan';
  /** The fan's spread in degrees, finite and in (0, 360); read with aim 'fan' alone. */
  spreadDeg: number;
  /**
   * ◆環射 (gd:489 「每第 6 次攻擊朝 12 個方向射出小彈」, E10b): on every `every`-th counted
   * attack, `directions` × countMult more shots evenly round the attack's origin; `every` a
   * whole number in [1, 60], `directions` one in [1, 64]. Null: no ring.
   */
  ring: { every: number; directions: number } | null;
  /**
   * ◆子母彈 (gd:490 「小彈擊殺時分裂成 3 發（分裂出來的不再分裂）」) and the 分裂 rank (A19, E10b): a
   * small shot whose hit kills its enemy splits, with chance min(1, chance + max(0,
   * barrageSplit)), into `count` × countMult children that never split; `count` a whole number in
   * [1, 8], `chance` finite in [0, 1]. Null: the rank alone splits, with chance min(1, max(0,
   * barrageSplit)) into DEFAULT_SPLIT_COUNT × countMult children; nothing splits unless the
   * chance is above 0.
   */
  split: { count: number; chance: number } | null;
  /**
   * ◆聚焦 (gd:490 「場上只剩 1 個目標時，所有小彈都打它，傷害 +20%」, A20, E10b): while `when` holds
   * at a firing, every shot of it goes at one enemy and its hits deal × (1 + bonus), `bonus`
   * finite in [0, 4]: 'lastAlive' while one enemy is alive (A20 (a)), 'boss' while a boss is,
   * at the nearest boss (A20 (b)). Null: no focus.
   */
  focus: { bonus: number; when: 'lastAlive' | 'boss' } | null;
  /**
   * 彈雨 (gd:493 「每 10 秒有 2 秒，小彈數量 ×3」, E10b): the shots, rings and children × countMult
   * while the run's tick % round(periodSec × 60) < round(activeSec × 60), a stateless window;
   * `countMult` a whole number in [2, 4], both seconds finite and the active ticks at least 1
   * and below the period's. Null: no rain.
   */
  rain: { periodSec: number; activeSec: number; countMult: number } | null;
}

/** BuildFlags.barrage's values before the modules: E10a's rider as it is, no ◆ param. */
export const DEFAULT_BARRAGE_PARAMS: Readonly<BarrageParams> = {
  countMult: 1,
  bounce: 0,
  aim: 'distinct',
  spreadDeg: 30,
  ring: null,
  split: null,
  focus: null,
  rain: null,
};

/**
 * The children of a split when no module wrote the split param (gd:490's 「分裂成 3 發」): the
 * count the 分裂 rank's chance splits into on its own (compileBarrage).
 */
export const DEFAULT_SPLIT_COUNT = 3;

/**
 * The combo's cap (gd:419's 「上限 20」): the comboCap stat's base (BASE_STATS, src/data/stats.ts),
 * BuildFlags.comboCap's literal before the fold, and comboFull's when a module lifts the cap.
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
  /**
   * The roles of its drones (E4: 蜂后, 重錘), none as its module compiles: each the drone of one
   * dock index among the drones the fill counts (src/sim/emitters/drone.ts); compileBuild throws
   * unless the slots are whole numbers ≥ 0, no two alike, and at most one role leads.
   */
  roles: DroneRole[];
  /**
   * Its turrets' seats' radius around the player, at the same angles whatever it is: 90, as
   * DRONE_DEFAULTS.turretRadius, which the granted turrets keep (gd:186 ◆前哨's 220, E4); finite
   * and ≥ 0.
   */
  turretRadius: number;
  /**
   * Its drones' size as drawn (DroneViewState.size), × each one's role's sizeMult (gd:192
   * ★巨像's 「變大」, E4), finite and above 0: render reads it, the sim never.
   */
  sizeMult: number;
  /**
   * 自爆協議 (C5b, E5): the impact that spends a swarm drone's sortie explodes, at `radius`
   * (before sizeOf) and `damagePct` of the damage stat in place of the splash and the payload's
   * share; null for none (src/sim/systems/drones.ts).
   */
  lastImpact: { radius: number; damagePct: number } | null;
  /**
   * 攔截守衛: the swarm's last `count` drones (its last dock indices) orbit the player at
   * `radius` (DRONE_GUARD), charging dashers first; null for none.
   */
  guards: { count: number; radius: number } | null;
  /**
   * 蜂潮: every `periodSec` every swarm drone dashes at the densest enemy, its next impact on it
   * × `damageMult`; null for none.
   */
  surge: { periodSec: number; damageMult: number } | null;
}

/**
 * The role of the swarm's drone of dock index `slot` (E4; gd:184 ◆蜂后 「1 架無人機變成蜂后：體型
 * ×1.5、傷害 ×2；其他無人機打蜂后的目標時傷害 +20%」, gd:189 ◆重錘 「1 架無人機傷害 ×5、速度
 * ×0.4」), which its module pushes onto SwarmParams.roles. A slot not below the drones the fill
 * counts (× droneCountMult, then countOf) gives no row a role; no role reaches a turret, a
 * granted drone or a timed row.
 */
export interface DroneRole {
  /** The drone's dock index k (DroneViewState.seat), a whole number ≥ 0. */
  slot: number;
  /**
   * Its impacts' hit scale (src/sim/systems/drones.ts impactAt), finite and above 0: × every hit
   * of the impact, on every enemy it lists; never a chain jump's.
   */
  damageMult: number;
  /** × its every step, dashing and flying home, finite and above 0; not its dock or cooldown. */
  speedMult: number;
  /** Its body's size as drawn, × SwarmParams.sizeMult (DroneViewState.size), finite and above 0. */
  sizeMult: number;
  /**
   * 蜂后's 「其他無人機打蜂后的目標時傷害 +20%」, finite and ≥ 0: above 0 the drone leads, and an
   * impact of another of the swarm's drones on the leader's live target, the enemy it dashes at,
   * takes × (1 + followBonus) on top of its own damageMult. At most one role leads.
   */
  followBonus: number;
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
  /** The barrage rider (compileBarrage); null for a build without a barrage grant. */
  readonly barrage: CompiledBarrage | null;
}

/**
 * The barrage rider of a build with a barrage grant (BarrageGrant, src/data/emitters.ts): its
 * small shots after each counted attack of the signature emitter (src/sim/systems/barrage.ts).
 */
export interface CompiledBarrage {
  /** Source id its hits are credited to: the first barrage grant's. */
  readonly source: string;
  /** Base damage of a hit as a fraction of the damage stat (BARRAGE_DAMAGE_PCT when omitted). */
  readonly damagePct: number;
  /**
   * Shots an attack: countOf(floor(values.barrageCount)) × BuildFlags.barrage.countMult, at least
   * 0; 0 fires none.
   */
  readonly count: number;
  /** Enemies a shot hits at most: floor(values.barragePierce) + 1, at least 1. */
  readonly hits: number;
  /** Arena-edge bounces of a shot: BuildFlags.barrage.bounce. */
  readonly bounce: number;
  /** ◆扇形 (BarrageParams.aim): 'fan' fires every shot at the first pick, over `spread`. */
  readonly aim: 'distinct' | 'fan';
  /** The fan's spread in radians: spreadDeg × π / 180. */
  readonly spread: number;
  /**
   * ◆環射: every `every`-th counted attack, `count` more shots round its origin,
   * countOf(directions) × countMult; null without the ring param.
   */
  readonly ring: { readonly every: number; readonly count: number } | null;
  /**
   * ◆子母彈 and the 分裂 rank: a killing small shot splits with `chance`, min(1, split.chance +
   * max(0, barrageSplit)), into `count`, split.count × countMult, children; without the split
   * param, with min(1, max(0, barrageSplit)) into DEFAULT_SPLIT_COUNT × countMult; null unless
   * the chance is above 0 (0, or NaN from a module), which splits nothing.
   */
  readonly split: { readonly count: number; readonly chance: number } | null;
  /** ◆聚焦: its bonus and condition; null without the focus param. */
  readonly focus: { readonly bonus: number; readonly when: 'lastAlive' | 'boss' } | null;
  /**
   * 彈雨: × `mult` while the tick % `period` < `active`, round(periodSec × 60) and
   * round(activeSec × 60) ticks; null without the rain param.
   */
  readonly rain: { readonly period: number; readonly active: number; readonly mult: number } | null;
}

/**
 * The barrage rider of `grants` (lead rulings W1, W4, X1-X8): the first barrage grant in grant
 * order, credited to its source, whatever other sources grant one; null for none. Its count
 * reads the compiled barrageCount, halved by 巨大化 as the other counts are (countOf), then ×
 * countMult; the C6b.1 count link of a projectiles effect reads the StatBlock's value and never
 * this. The ◆ params compile once here: the ring's directions as the count (countOf, ×
 * countMult), the split's chance with barrageSplit's compiled value (the rank alone splitting into
 * DEFAULT_SPLIT_COUNT), the rain's seconds as ticks.
 */
function compileBarrage(
  grants: readonly SourcedEmitter[],
  values: Readonly<Record<StatId, number>>,
  flags: BuildFlags,
): CompiledBarrage | null {
  for (const { source, grant } of grants) {
    if (grant.kind !== 'barrage') continue;
    const { countMult, bounce, aim, spreadDeg, ring, split, focus, rain } = flags.barrage;
    const chance = Math.min(
      1,
      (split === null ? 0 : split.chance) + Math.max(0, values.barrageSplit),
    );
    const children = split === null ? DEFAULT_SPLIT_COUNT : split.count;
    return {
      source,
      damagePct: grant.damagePct ?? BARRAGE_DAMAGE_PCT,
      count: Math.max(0, countOf({ flags }, Math.floor(values.barrageCount))) * countMult,
      hits: Math.max(0, Math.floor(values.barragePierce)) + 1,
      bounce,
      aim,
      spread: (spreadDeg * Math.PI) / 180,
      ring:
        ring === null
          ? null
          : { every: ring.every, count: countOf({ flags }, ring.directions) * countMult },
      split: chance > 0 ? { count: children * countMult, chance } : null,
      focus: focus === null ? null : { bonus: focus.bonus, when: focus.when },
      rain:
        rain === null
          ? null
          : {
              period: Math.round(rain.periodSec * TICK_RATE),
              active: Math.round(rain.activeSec * TICK_RATE),
              mult: rain.countMult,
            },
    };
  }
  return null;
}

/** `v` is a whole number in [min, max]. */
const wholeIn = (v: number, min: number, max: number): boolean =>
  Number.isInteger(v) && v >= min && v <= max;

/**
 * Throws on a ◆ param of BuildFlags.barrage (E10b, lead ruling X1) outside its range, naming the
 * field and its value; compileBuild calls it after the modules and E10a's countMult and bounce
 * checks, with or without a grant, so a module's slip shows on every build. aim and focus.when
 * are held to their unions by their types alone.
 */
function checkBarrageParams(params: BarrageParams): void {
  const { spreadDeg, ring, split, focus, rain } = params;
  if (!(Number.isFinite(spreadDeg) && spreadDeg > 0 && spreadDeg < 360)) {
    throw new Error(`barrage.spreadDeg: ${spreadDeg} must be finite and in (0, 360)`);
  }
  if (ring !== null) {
    if (!wholeIn(ring.every, 1, 60)) {
      throw new Error(`barrage.ring.every: ${ring.every} must be a whole number in [1, 60]`);
    }
    if (!wholeIn(ring.directions, 1, 64)) {
      throw new Error(
        `barrage.ring.directions: ${ring.directions} must be a whole number in [1, 64]`,
      );
    }
  }
  if (split !== null) {
    if (!wholeIn(split.count, 1, 8)) {
      throw new Error(`barrage.split.count: ${split.count} must be a whole number in [1, 8]`);
    }
    if (!(Number.isFinite(split.chance) && split.chance >= 0 && split.chance <= 1)) {
      throw new Error(`barrage.split.chance: ${split.chance} must be finite and in [0, 1]`);
    }
  }
  if (focus !== null && !(Number.isFinite(focus.bonus) && focus.bonus >= 0 && focus.bonus <= 4)) {
    throw new Error(`barrage.focus.bonus: ${focus.bonus} must be finite and in [0, 4]`);
  }
  if (rain !== null) {
    if (!wholeIn(rain.countMult, 2, 4)) {
      throw new Error(`barrage.rain.countMult: ${rain.countMult} must be a whole number in [2, 4]`);
    }
    const { periodSec, activeSec } = rain;
    const finite = Number.isFinite(periodSec) && Number.isFinite(activeSec);
    const active = Math.round(activeSec * TICK_RATE);
    if (!(finite && active >= 1 && active < Math.round(periodSec * TICK_RATE))) {
      throw new Error(
        `barrage.rain: periodSec ${periodSec} and activeSec ${activeSec} must be finite, ` +
          'round(activeSec × 60) at least 1 and below round(periodSec × 60)',
      );
    }
  }
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
 * agree on its fields (data validation), so dropping the others loses nothing. A barrage grant
 * is no emitter: it rides the signature (compileBarrage).
 */
function grantEmitters(grants: readonly SourcedEmitter[]): EmitterSpec[] {
  const seen = new Set<string>();
  const emitters: EmitterSpec[] = [];
  for (const { source, grant } of grants) {
    if (grant.kind === 'barrage') continue;
    const id = `${grant.kind}|${source}|${grantKey(grant)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    emitters.push(grantEmitter(source, grant));
  }
  return emitters;
}

/**
 * Throws, naming the field and its value, on the SwarmParams members only E4's modules write: a
 * role whose slot is not a whole number ≥ 0 or is an earlier role's, whose damageMult, speedMult
 * or sizeMult is not finite and above 0, or whose followBonus is not finite and ≥ 0; a second
 * role that leads (followBonus above 0); a turretRadius that is not finite and ≥ 0; a sizeMult
 * that is not finite and above 0.
 */
function checkSwarmParams(swarm: Readonly<SwarmParams>): void {
  const roles = swarm.roles;
  let leader = -1;
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i] as DroneRole;
    const at = `swarm.roles[${i}]`;
    if (!(Number.isInteger(role.slot) && role.slot >= 0)) {
      throw new Error(`${at}.slot: ${role.slot} must be a whole number >= 0`);
    }
    const first = roles.findIndex((other) => other.slot === role.slot);
    if (first < i) throw new Error(`${at}.slot: ${role.slot} is swarm.roles[${first}]'s too`);
    for (const field of ['damageMult', 'speedMult', 'sizeMult'] as const) {
      const v = role[field];
      if (!(Number.isFinite(v) && v > 0)) {
        throw new Error(`${at}.${field}: ${v} must be finite and above 0`);
      }
    }
    if (!(Number.isFinite(role.followBonus) && role.followBonus >= 0)) {
      throw new Error(`${at}.followBonus: ${role.followBonus} must be finite and >= 0`);
    }
    if (role.followBonus > 0) {
      if (leader >= 0) {
        throw new Error(
          `${at}.followBonus: ${role.followBonus}, but swarm.roles[${leader}] leads; ` +
            'at most one role may',
        );
      }
      leader = i;
    }
  }
  if (!(Number.isFinite(swarm.turretRadius) && swarm.turretRadius >= 0)) {
    throw new Error(`swarm.turretRadius: ${swarm.turretRadius} must be finite and >= 0`);
  }
  if (!(Number.isFinite(swarm.sizeMult) && swarm.sizeMult > 0)) {
    throw new Error(`swarm.sizeMult: ${swarm.sizeMult} must be finite and above 0`);
  }
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
    summonHighestHp: false,
    shatterChain: false,
    frozenNoSplit: false,
    frostGainShocked: 0,
    frostGainBoss: 0,
    barrage: { ...DEFAULT_BARRAGE_PARAMS },
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
    onChainEnd: [],
  };
  const hookOwners: { [K in HookName]: number[] } = {
    tick: [],
    onKill: [],
    onAttack: [],
    onHit: [],
    modifyDamage: [],
    onCenterEvent: [],
    onChainEnd: [],
  };
  // The talent nodes' emitter grants, then the ones modules add.
  const grants: SourcedEmitter[] = [...stats.emitters];
  // SHATTER_TRIGGER's index; its entry is decided once every module has compiled.
  const triggers: CompiledTrigger[] = [shatterTrigger(false, 0)];
  const effects: CompiledEffect[] = [];
  // The StatBlock's barrage count, read once a compile: a projectiles effect with countStat links
  // its count to it (compileEffect; docs/v3 C6 design §7.4 C6b.1), whoever adds the effect.
  const barrageCount = stats.values.barrageCount;
  // A seated spawnDrone's fire (E8): its fires.do compiled once, with the row's source and coef,
  // into an entry of its own after its trigger's effects, which stay one run of indices; the
  // row's entry keeps its index (CompiledEffect.fire).
  const addFire = (at: number, spec: EffectSpec, source: number, coef: number): void => {
    if (spec.kind !== 'spawnDrone' || spec.fires === undefined) return;
    effects[at] = { ...(effects[at] as CompiledEffect), fire: effects.length };
    effects.push(compileFire(spec, source, coef, values.damage, barrageCount));
  };
  const addTrigger = (source: number, spec: TriggerSpec, coef: number): void => {
    const start = effects.length;
    triggers.push(compileTrigger(triggers.length, spec, source, coef, start, sources));
    for (const effect of spec.do) {
      effects.push(compileEffect(effect, source, coef, values.damage, spec.target, barrageCount));
    }
    spec.do.forEach((effect, k) => addFire(start + k, effect, source, coef));
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
      const at = effects.length;
      effects.push(compileEffect(spec, ix, coef, values.damage, undefined, barrageCount));
      addFire(at, spec, ix, coef);
      return at;
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
  // 動能's 層數上限 (lead ruling Z2): the comboCap stat, folded once before any module runs, so
  // a module's own cap (★無盡連擊's Infinity) wins; whole stacks, at least 1. At its base, 20,
  // the flag is the literal's DEFAULT_COMBO_CAP.
  flags.comboCap = Math.max(1, Math.floor(values.comboCap));
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
  // So too its roles, turret seat and size (E4): the fill reads them as they are.
  if (swarm !== null) checkSwarmParams(swarm);
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
  // for bit. 節奏閃避 reads them (C7b), and so does a trigger's comboAtLeast (E14, lead ruling
  // Z3), a module's addTrigger included.
  flags.combo ||=
    scoped.some((mod) => mod.scaling?.per === 'comboStacks') ||
    effects.some((fx) => fx.spec.kind === 'comboStack') ||
    flags.comboEcho !== null ||
    values.bulletDodgeCombo > 0 ||
    triggers.some((t) => readsCombo(t.conds));
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
  // 蜂巢's self-destruct, guards and surge (C5b, E5), which only modules write: the fill reads
  // them as they are.
  const blast = swarm?.lastImpact ?? null;
  if (
    blast !== null &&
    !(
      Number.isFinite(blast.radius) &&
      blast.radius > 0 &&
      Number.isFinite(blast.damagePct) &&
      blast.damagePct > 0
    )
  ) {
    throw new Error(
      `lastImpact: radius ${blast.radius} and damagePct ${blast.damagePct} must be finite and above 0`,
    );
  }
  const guards = swarm?.guards ?? null;
  if (
    guards !== null &&
    !(
      Number.isInteger(guards.count) &&
      guards.count >= 1 &&
      Number.isFinite(guards.radius) &&
      guards.radius > 0
    )
  ) {
    throw new Error(
      `guards: count ${guards.count} must be a whole number >= 1, ` +
        `radius ${guards.radius} finite and above 0`,
    );
  }
  const surge = swarm?.surge ?? null;
  if (
    surge !== null &&
    !(
      Number.isFinite(surge.periodSec) &&
      surge.periodSec > 0 &&
      Number.isFinite(surge.damageMult) &&
      surge.damageMult > 0
    )
  ) {
    throw new Error(
      `surge: periodSec ${surge.periodSec} and damageMult ${surge.damageMult} must be finite and above 0`,
    );
  }
  // 霜晶's frost gain (E6), which only modules write: addFrost reads it as it is.
  if (!(Number.isFinite(flags.frostGainShocked) && flags.frostGainShocked >= 0)) {
    throw new Error(`frostGainShocked: ${flags.frostGainShocked} must be finite and >= 0`);
  }
  if (!(Number.isFinite(flags.frostGainBoss) && flags.frostGainBoss >= 0)) {
    throw new Error(`frostGainBoss: ${flags.frostGainBoss} must be finite and >= 0`);
  }
  // The barrage rider's params (E10a), which only modules write, checked with or without a
  // grant so a module's slip shows on every build.
  const { countMult, bounce } = flags.barrage;
  if (!(Number.isInteger(countMult) && countMult >= 1 && countMult <= 4)) {
    throw new Error(`barrage.countMult: ${countMult} must be a whole number in [1, 4]`);
  }
  if (!(Number.isInteger(bounce) && bounce >= 0 && bounce <= 4)) {
    throw new Error(`barrage.bounce: ${bounce} must be a whole number in [0, 4]`);
  }
  checkBarrageParams(flags.barrage);
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
    barrage: compileBarrage(grants, values, flags),
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
