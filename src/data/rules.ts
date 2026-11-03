/**
 * Keystone and notable rule changes. Rules are enumerated in code with typed parameters;
 * data files can only reference rules defined here (docs/ARCHITECTURE.md §4.4).
 * Each rule is a module of the simulation (src/sim/rules/). A change that modifiers can
 * express (a tagged chance, an *Always stat, a scaling, notTags) is data instead, like the
 * bridge notables and Searing Crits, and so is one that triggers can express, like Pandemic's
 * spread on death (src/data/talents.ts).
 *
 * The v3 web's tables over rules and signatures live here too (docs/v3 C6 design §3.7, §4.2):
 * each character's signature, its center event and its forms; the rule fields a fusion's
 * coefficient scales; and the chain-policy rules a notable may hold. This module imports types
 * only, so the registries stay outside every value-import cycle.
 */

import type { CharacterId } from './sources';
import type { CenterEvent } from './triggers';

export type RuleSpec =
  /**
   * Every Nth shot crits, or every shot of every Nth attack (counts); no random crits; crit
   * multiplier gets an extra more multiplier.
   */
  | {
      readonly id: 'steadyAim';
      readonly everyNth: number;
      readonly critMultiplierMore: number;
      readonly counts: 'shot' | 'attack';
    }
  /** No burn stack cap; burn duration gets (1 + durationMore). */
  | { readonly id: 'eternalFlame'; readonly durationMore: number }
  /**
   * Chain count × chainCountMultiplier; chain retention reduced by retentionPenalty (absolute);
   * with chainMore, hits delivered by a chain ([chain, hit]) deal (1 + chainMore) more.
   */
  | {
      readonly id: 'overload';
      readonly chainCountMultiplier: number;
      readonly retentionPenalty: number;
      readonly chainMore?: number;
    }
  /** All damage gets (1 + damageMore); max life becomes 1. */
  | { readonly id: 'glassCannon'; readonly damageMore: number }
  /**
   * 遠投 (magmaBomb): every `every`th bomb is thrown at the farthest enemy in the arena instead
   * of a crowded spot. Of several instances, the smallest `every`.
   */
  | { readonly id: 'farThrow'; readonly every: number }
  /**
   * 火山 (magmaBomb): the bombs are thrown every periodSec at the base attack speed instead, each
   * of radiusMult × the radius (its fire zone too) and damageMult × the damage of its explosion
   * hits. The first instance's.
   */
  | {
      readonly id: 'volcano';
      readonly periodSec: number;
      readonly radiusMult: number;
      readonly damageMult: number;
    }
  /**
   * 連環爆 (magmaBomb): an enemy a bomb's explosion kills explodes too, at most perBomb of them a
   * bomb: radius and damagePct of the damage stat. The first instance's.
   */
  | {
      readonly id: 'chainBlast';
      readonly radius: number;
      readonly damagePct: number;
      readonly perBomb: number;
    }
  /**
   * 冰柱 (iceFan): every `every`th round fires one cone of damagePct of the damage stat at its
   * target instead of the fan. Of several instances, the smallest `every`; the first instance's
   * damagePct.
   */
  | { readonly id: 'icicle'; readonly every: number; readonly damagePct: number }
  /**
   * 稜鏡 (iceFan): every round fires one cone at its target that passes through every enemy on
   * its line; each enemy it passed adds perPierce to the factor of its later hits, at most
   * maxBonus. The first instance's.
   */
  | { readonly id: 'prism'; readonly perPierce: number; readonly maxBonus: number }
  /**
   * 六線圈 (triphaseArc): `coils` discharges a second at the base attack speed instead of three,
   * each at `targets` enemies (1 or 2; two distinct ones, picked before either is hit, share one
   * chain) for damageMult × its damage. The first instance's.
   */
  | {
      readonly id: 'sixCoils';
      readonly coils: number;
      readonly targets: number;
      readonly damageMult: number;
    }
  /**
   * 霜焰 (magmaBomb, 火冰's hand core): each bomb explosion adds frostPct chill to the enemies it
   * hits; an enemy holding frost carries burnCapBonus more burn stacks; the fire zones slow the
   * enemies in them by zoneSlow. Frost and the cap bonus add up over instances, the slow takes
   * the largest.
   */
  | {
      readonly id: 'frostflame';
      readonly frostPct: number;
      readonly burnCapBonus: number;
      readonly zoneSlow: number;
    }
  /**
   * 絕對零度 (the ice outer's ★ and 霜晶's): every enemy always carries globalSlow, a freeze leaves
   * no immunity, a boss's freeze events stay at least bossGapSec apart, and attack speed gets
   * (1 + attackSpeedMore). The largest slow and gap; the attack speed factors multiply.
   */
  | {
      readonly id: 'absoluteZero';
      readonly globalSlow: number;
      readonly bossGapSec: number;
      readonly attackSpeedMore: number;
    }
  /**
   * 巨大化 (gd:268): every area radius the build creates, the bomb's included, and the projectiles'
   * hit radius × sizeMult; the four counts (projectiles, ice cones, chain jumps, drones) halved,
   * rounded down, at least 1 (src/sim/rules/gigantism.ts, src/sim/build/size.ts). The first
   * instance's.
   */
  | { readonly id: 'gigantism'; readonly sizeMult: number }
  /**
   * 爆靈 (magmaBomb, 火靈's hand core; gd:525): every `every`-th bomb explosion spawns a timed
   * spirit (spawnDrone) at the explosion that lives lifeSec, dashes at the nearest enemy and
   * impacts it once for damagePct of the damage stat, igniting burnStacks burn stacks on the
   * enemies in its splash, each as a hit of burnDamagePct of the damage stat would ignite it; at
   * most maxLive of one instance's spirits at once. Each instance counts its own bombs.
   */
  | {
      readonly id: 'blastSpirit';
      readonly every: number;
      readonly lifeSec: number;
      readonly damagePct: number;
      readonly burnStacks: number;
      readonly burnDamagePct: number;
      readonly maxLive: number;
    }
  /**
   * 神經毒 (gd:389 「每 5 層毒減速 2%，最多 40%」): an enemy is slowed by slowPer for every
   * stacksPer of its live poison stacks, at most max, as one more source of enemySlow
   * (src/sim/ailments/frost.ts), whose largest slow wins. The first instance's.
   */
  | {
      readonly id: 'poisonSlow';
      readonly stacksPer: number;
      readonly slowPer: number;
      readonly max: number;
    }
  /**
   * 鎖定信標 (the summon outer's answer, gd §4.10): drones and spirits take elites and bosses
   * first once they are in the arena, turrets at any distance (BuildFlags.summonEliteFirst).
   */
  | { readonly id: 'lockBeacon' }
  /**
   * 加農砲 (gd §4.10): turrets fire rateMult as often (BuildFlags.turretRateMult) and their shots
   * hit every enemy within splash of the target (turretSplash). Rates multiply, the largest splash.
   */
  | { readonly id: 'cannon'; readonly rateMult: number; readonly splash: number }
  /** 特斯拉塔 (gd §4.10): a turret's shot chains `chains` times (turretChains); they add up. */
  | { readonly id: 'teslaTower'; readonly chains: number }
  /**
   * 蟲海 (the summon outer's ★, shared with 蜂巢; gd:193): grant and swarm drones × countMult
   * (droneCountMult) and drones that ran out of impacts pick again instead of flying home
   * (dronesStay). The largest countMult.
   */
  | { readonly id: 'bugSea'; readonly countMult: number }
  /**
   * 分巢 (蜂巢's ◆, gd §1.5): every `every`-th kill spawns a timed drone (spawnDrone) at the
   * victim that lives lifeSec, dashes at the enemies farthest from the player and impacts them
   * for damagePct of the damage stat; at most maxLive of the instance's at once. Each instance
   * counts its own kills.
   */
  | {
      readonly id: 'hiveSplit';
      readonly every: number;
      readonly lifeSec: number;
      readonly damagePct: number;
      readonly maxLive: number;
    }
  /**
   * 量產 and 回收 (蜂巢's ◆, gd §1.5): the swarm gets `turrets` more turrets and its dock time ×
   * dockSecMult. Turrets add up, the factors multiply.
   */
  | { readonly id: 'swarmTune'; readonly turrets: number; readonly dockSecMult: number }
  /**
   * 巨像 (蜂巢's ★, gd:192): the swarm keeps one drone, and its impacts deal damagePerMissing more
   * (a more multiplier) for each drone it gave up, ascendancy drones included.
   */
  | { readonly id: 'colossus'; readonly damagePerMissing: number }
  /** 擴巢 (女王, gd §1.5): `drones` more in the swarm. */
  | { readonly id: 'hiveExpand'; readonly drones: number }
  /** 增建 (機械師, gd §1.5): `turrets` more in the swarm. */
  | { readonly id: 'hiveBuild'; readonly turrets: number }
  | {
      readonly id: 'queenRole';
      readonly damageMult: number;
      readonly sizeMult: number;
      readonly followBonus: number;
    }
  | { readonly id: 'hammerRole'; readonly damageMult: number; readonly speedMult: number }
  | { readonly id: 'focusFire' }
  | { readonly id: 'outpost'; readonly turretRadius: number }
  /** 蜂王漿 (女王, gd §1.5): the ascendancy's timed drones live lifeMult as long. */
  | { readonly id: 'royalJelly'; readonly lifeMult: number }
  /**
   * 繁衍 (女王's final, gd §1.5): a kill spawns, with this chance, a timed drone at the victim
   * that lives lifeSec and impacts for damagePct of the damage stat; at most maxLive at once.
   */
  | {
      readonly id: 'breed';
      readonly chance: number;
      readonly lifeSec: number;
      readonly damagePct: number;
      readonly maxLive: number;
    }
  /**
   * 母艦工廠 (機械師's final, gd §1.5): every periodSec each of the swarm's turrets spawns a timed
   * drone at its seat that lives lifeSec and impacts for damagePct of the damage stat.
   */
  | {
      readonly id: 'motherFactory';
      readonly periodSec: number;
      readonly lifeSec: number;
      readonly damagePct: number;
    }
  /**
   * 連環焚燒 (焚化者's final, gd §1.2): an enemy a 焚屍 detonation kills while it burns detonates
   * too, at most `depth` links of a chain.
   */
  | { readonly id: 'pyreChain'; readonly depth: number }
  /**
   * 熔流, 灼地 and 火海 (煉獄, gd §1.2): the bombs' fire zones last durationMult as long, deal
   * damageMult as much a second and are radiusMult as wide. The factors multiply.
   */
  | {
      readonly id: 'zoneTune';
      readonly durationMult: number;
      readonly damageMult: number;
      readonly radiusMult: number;
    }
  /**
   * 焰蜂 (蜂巢's 火召喚 hand core, gd §5.2): every drone impact ignites burnStacks burn stacks on
   * its target, and a burning enemy a signature hit kills explodes, blastRadius around it, for
   * blastDamagePct of the damage stat.
   */
  | {
      readonly id: 'flameBee';
      readonly burnStacks: number;
      readonly blastRadius: number;
      readonly blastDamagePct: number;
    }
  /**
   * 霜蜂 (蜂巢's 冰召喚 hand core, gd §5.2): every drone impact adds frostPct chill to its target,
   * and an impact on a frozen enemy that is no boss shatters it (an execute: the kill while
   * frozen is the shatter).
   */
  | { readonly id: 'frostBee'; readonly frostPct: number };

export type RuleId = RuleSpec['id'];

export const RULE_IDS: readonly RuleId[] = [
  'steadyAim',
  'eternalFlame',
  'overload',
  'glassCannon',
  'farThrow',
  'volcano',
  'chainBlast',
  'icicle',
  'prism',
  'sixCoils',
  'frostflame',
  'absoluteZero',
  'gigantism',
  'blastSpirit',
  'poisonSlow',
  'lockBeacon',
  'cannon',
  'teslaTower',
  'bugSea',
  'hiveSplit',
  'swarmTune',
  'colossus',
  'hiveExpand',
  'hiveBuild',
  'queenRole',
  'hammerRole',
  'focusFire',
  'outpost',
  'royalJelly',
  'breed',
  'motherFactory',
  'pyreChain',
  'zoneTune',
  'flameBee',
  'frostBee',
];

/**
 * A character's signature attack: the emitter at index 0 of the run (src/sim/rules/, SIGNATURES),
 * one member per signature, with its parameters.
 */
export type SignatureSpec =
  /** M1's volley of homing projectiles. */
  | { readonly id: 'm1Volley' }
  /**
   * 熔核's magma bombs: lobbed at the most crowded spots, they explode where they land and each
   * leaves a fire zone (src/sim/emitters/lob.ts).
   */
  | { readonly id: 'magmaBomb' }
  /**
   * 霜晶's ice-cone fan: rounds of straight cones spread over 30° about the target, each through
   * two enemies, that chill what they hit (src/sim/emitters/fan.ts).
   */
  | { readonly id: 'iceFan' }
  /**
   * 雷塔's three-phase arc: discharges that strike the volley's pick of target at any range and
   * chain on from it at once, every hit a lightning chain hit that shocks, its three coils taking
   * turns (src/sim/emitters/arc.ts).
   */
  | { readonly id: 'triphaseArc' }
  /**
   * 蜂巢's swarm: drones that fly out from their docks around the player at the enemies farthest
   * from it and impact them, each impact hitting every enemy within its splash
   * (src/sim/systems/drones.ts).
   */
  | { readonly id: 'swarm' };

export type SignatureId = SignatureSpec['id'];

/** The signature attack of runs that name none (RunConfig.signature). */
export const M1_SIGNATURE: SignatureSpec = { id: 'm1Volley' };

/** Each character's signature attack (CharacterDef.signature; implementation-plan-v3 §2.13). */
export const CHARACTER_SIGNATURE: Readonly<Record<CharacterId, Exclude<SignatureId, 'm1Volley'>>> =
  {
    fire: 'magmaBomb',
    ice: 'iceFan',
    lightning: 'triphaseArc',
    summon: 'swarm',
  };

/** The center event each character signature raises: the event of every template fusion core. */
export const SIGNATURE_EVENT: Readonly<Record<Exclude<SignatureId, 'm1Volley'>, CenterEvent>> = {
  magmaBomb: 'explode',
  iceFan: 'freeze',
  triphaseArc: 'chainJump',
  swarm: 'droneImpact',
};

/**
 * The form rules each signature takes (src/sim/rules/lobForms.ts, fanForms.ts, sixCoils.ts); web
 * validation rejects a form on another character's nodes.
 */
export const SIGNATURE_FORMS: Readonly<Record<SignatureId, readonly RuleId[]>> = {
  m1Volley: [],
  magmaBomb: ['farThrow', 'volcano', 'chainBlast'],
  iceFan: ['icicle', 'prism'],
  triphaseArc: ['sixCoils'],
  swarm: ['swarmTune', 'colossus'],
};

/** How a fusion's coef scales a rule field: pct and mult × coef, chance min(1, p × coef). */
export type CoefFieldKind = 'pct' | 'mult' | 'chance';

/**
 * The fields of each rule's spec that a fusion's coefficient scales, when the rule sits on a
 * fusion board (a hand fusion's core, or 冰光's and 雷光's added rules). A rule with no entry is
 * not scaled. Each hand module's entry lands with the module.
 */
export const RULE_COEF_FIELDS: {
  readonly [K in RuleId]?: Readonly<
    Partial<Record<keyof Extract<RuleSpec, { id: K }> & string, CoefFieldKind>>
  >;
} = {
  // 霜焰: the chill and the zone's slow scale; the burn cap bonus is a whole stack count.
  frostflame: { frostPct: 'chance', zoneSlow: 'chance' },
  // 焰蜂: the explosion's hit scales; the burn stacks and the radius are not shares.
  flameBee: { blastDamagePct: 'pct' },
  // 霜蜂: the chill scales; the shatter on a frozen enemy is all or nothing.
  frostBee: { frostPct: 'chance' },
};

/**
 * `spec` with the fields its `fields` entry lists scaled by `coef`: pct and mult × coef, chance
 * min(1, p × coef); a listed field the spec leaves out stays out. `spec` itself at coef 1 or for
 * an id with no entry. A fusion board's rules compile from the scaled spec, so a rule module never
 * sees the coefficient and can neither forget it nor apply it twice.
 */
export function scaleRuleSpec<S extends RuleSpec>(
  spec: S,
  coef: number,
  fields = RULE_COEF_FIELDS,
): S {
  const entry = fields[spec.id] as Readonly<Record<string, CoefFieldKind>> | undefined;
  if (coef === 1 || entry === undefined) return spec;
  const scaled: Record<string, unknown> = { ...spec };
  for (const [field, kind] of Object.entries(entry)) {
    const value = scaled[field];
    if (typeof value !== 'number') continue; // an optional field left out stays out
    scaled[field] = kind === 'chance' ? Math.min(1, value * coef) : value * coef;
  }
  return scaled as S;
}

/**
 * The rule ids web validation admits on a ◆ (kind notable or asc) beyond a center's forms: the
 * chain policies, which no data member can write, only a rule module through
 * BuildCompiler.chainPolicy. Each chain-policy module adds its id when it lands.
 */
export const POLICY_RULES: readonly RuleId[] = [];

/**
 * The other rule ids web validation admits on a ◆ (kind notable or asc): a ◆ whose effect no data
 * member can write, only its rule module, as 神經毒's poison-stack slow (gd:389). Each such module
 * adds its id when it lands.
 */
export const NOTABLE_RULES: readonly RuleId[] = [
  'poisonSlow',
  'lockBeacon',
  'cannon',
  'teslaTower',
  'hiveSplit',
  'hiveExpand',
  'hiveBuild',
  'queenRole',
  'hammerRole',
  'focusFire',
  'outpost',
  'royalJelly',
  'zoneTune',
];
