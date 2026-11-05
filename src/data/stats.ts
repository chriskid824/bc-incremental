/**
 * Stat vocabulary shared by data files, meta and the simulation; damage tags are in tags.ts.
 * See docs/GDD.md §3 for the meaning of each stat.
 */

import type { SourcedEmitter } from './emitters';
import type { RuleSpec } from './rules';
import type { SourceSelector } from './sources';
import type { DamageTag } from './tags';
import type { ConversionSpec, ScalingSpec, TargetCondition, TriggerSpec } from './triggers';

export const STAT_IDS = [
  /** Flat base damage per attack. Damage modifiers may carry tags; see src/data/tags.ts. */
  'damage',
  /** Attacks per second. */
  'attackSpeed',
  /** Projectiles per attack, each at its own target. Fractional part is a chance for one more. */
  'projectileCount',
  /** Probability in [0, 1]; the simulation clamps it. */
  'critChance',
  /** Damage multiplier on crit, e.g. 1.5 = 150%. */
  'critMultiplier',
  /** Probability in [0, 1] that a hit ignites. */
  'igniteChance',
  /** Burn damage per second, as a fraction of the igniting hit's damage. */
  'burnDamage',
  /** Burn duration in seconds. */
  'burnDuration',
  /** Maximum simultaneous burn stacks on one enemy. */
  'burnMaxStacks',
  /** Number of additional enemies a hit chains to. Fractional part is a chance for one more. */
  'chainCount',
  /** Fraction of the previous jump's damage kept on each chain jump. */
  'chainRetention',
  /** Maximum chain jump distance in arena units. */
  'chainRange',
  /** Player life. */
  'maxLife',
  /** Projectile speed in arena units per second. */
  'projectileSpeed',
  /** Multiplier on shard drops. */
  'shardGain',
  /** Multiplier on core drops. */
  'coreGain',
  /** Above 0, a hit crits whatever its crit roll, which is drawn all the same. */
  'critAlways',
  /** Above 0, a hit ignites whatever its ignite roll, which is drawn all the same. */
  'igniteAlways',
  /** Probability in [0, 1] that a hit poisons. */
  'poisonChance',
  /** Poison damage per second, as a fraction of the poisoning hit's damage. */
  'poisonDamage',
  /** Poison duration in seconds. Poison stacks without a cap. */
  'poisonDuration',
  /** Probability in [0, 1] that a hit makes the enemy bleed. */
  'bleedChance',
  /** Bleed damage per second, as a fraction of the hit's damage; an enemy keeps its strongest bleed. */
  'bleedDamage',
  /** Bleed duration in seconds. */
  'bleedDuration',
  /** Probability in [0, 1] that a hit shocks. */
  'shockChance',
  /** Extra damage an enemy takes per shock stack, e.g. 0.1 = +10%. */
  'shockEffect',
  /** Maximum shock stacks on one enemy. */
  'shockMaxStacks',
  /** Shock duration in seconds; every new stack restarts it for all of them. */
  'shockDuration',
  /** Above 0, a hit poisons whatever its poison roll, which is drawn all the same. */
  'poisonAlways',
  /** Above 0, a hit makes the enemy bleed whatever its bleed roll, which is drawn all the same. */
  'bleedAlways',
  /** Above 0, a hit shocks whatever its shock roll, which is drawn all the same. */
  'shockAlways',
  /**
   * Bleed damage multiplier while the enemy stands still; a moving enemy bleeds ×3
   * (src/sim/build/compile.ts BuildFlags.bleedMoveMult).
   */
  'bleedStationaryMult',
  /**
   * Frost each hit adds to the enemy's chill meter. A full meter (1) freezes a normal enemy; a
   * boss never freezes, its meter empties instead.
   */
  'frostOnHit',
  /** Slow at a full chill meter, e.g. 0.3 = 30%; a boss is slowed 0.15 less. */
  'frostSlowCap',
  /** Freeze duration in seconds. */
  'freezeDuration',
  /** A frozen enemy that dies shatters: this fraction of its max life to the enemies around it. */
  'shatterDamage',
  /** Shatter radius in arena units. */
  'shatterRadius',
  /** Extra damage a frozen enemy takes, e.g. 0.3 = +30%. */
  'frozenDamageTaken',
  /** Radius of the aura grants' pulses around the player, in arena units. */
  'auraRadius',
  /** Orbs every orbit grant adds to its own count; its whole part counts. */
  'orbitCount',
  /**
   * Multiplier on the contact damage the player takes, applied before its shield, e.g. 0.8 =
   * 80% (src/sim/systems/contact.ts damagePlayer).
   */
  'contactDamageTaken',
  /** Life regained per second while alive, as a fraction of max life, e.g. 0.01 = 1%. */
  'lifeRegen',
  /**
   * Revives per run; its whole part counts. A death with one left restores half of max life
   * instead of ending the run (REVIVE_LIFE_FRAC, src/sim/systems/contact.ts).
   */
  'extraLives',
  /**
   * 拒馬: above 0, a dashing enemy that survives its touch's thorns is pushed back this far, in
   * arena units, and charges again instead of hurting the player (src/sim/systems/contact.ts).
   */
  'dashRepel',
  /**
   * 荊棘纏繞: above 0, a boss that reaches the player is held there this many seconds, taking a
   * thorns round every 0.25 s, before it hurts the player and leaks (src/sim/systems/contact.ts).
   */
  'bossHoldSec',
  /**
   * 節奏閃避: with bulletDodgeCombo also above 0, the first bullet to reach the player at that
   * many combo stacks or more is dodged, then none for this many seconds
   * (src/sim/systems/bullets.ts).
   */
  'bulletDodgeSec',
  /** 節奏閃避: the combo stacks a dodge needs; its whole value counts (bulletDodgeSec). */
  'bulletDodgeCombo',
  /** 攔截軌道: above 0, the orbs of every orbit grant stop the bullets they touch. */
  'orbitBlocksBullets',
  /**
   * 反射: above 0, a bullet that reaches the player deals nothing and flies back to its shooter,
   * which takes a hit of the build's first thorns payload when it arrives.
   */
  'reflectBullets',
  /**
   * 集火: above 0, the hits that reach a shielded enemy within this many seconds of the first
   * one are summed against its shield's threshold (src/sim/combat/defend.ts).
   */
  'shieldPoolSec',
  /**
   * Above 0 on a hit's row, the hit passes an enemy's shield (src/sim/combat/defend.ts
   * bypassOf), as a coinHit with ignoreShield does.
   */
  'ignoreShield',
  /** Above 0 on a hit's row, the hit passes an enemy's armour (bypassOf). */
  'ignoreArmour',
  /**
   * Above 0 on an ailment's row (poison's or bleed's), a hit that an enemy's defences block in
   * full still applies that ailment if it rolled it (src/sim/combat/defend.ts blockedHit).
   */
  'ailmentOnBlock',
  /**
   * Multiplier on an enemy's regeneration, read on the untagged center row against the
   * regenerating enemy, so its conditions read that enemy (src/sim/systems/enemyAi.ts). Its
   * modifiers carry no tags, notTags or scope.
   */
  'enemyRegen',
  /** Multiplier on the drops of tough and boss kills, e.g. 2 = double. */
  'toughDropMult',
  /** Multiplier on the treasure schedule's rate (src/sim/systems/enemyAi.ts treasuresDue). */
  'treasureRate',
  /**
   * The barrage outer's extra small projectiles an attack (docs/v3/game-design-v3.md §4.11: 2
   * from its entry); its whole part counts. A projectiles effect with countStat 'barrageCount'
   * reads it once a compile and fires one more for each past BARRAGE_ENTRY_SHOTS
   * (src/data/triggers.ts; src/sim/effects/types.ts compileEffect). A barrage grant's rider
   * fires that many small shots after each signature attack, × BuildFlags.barrage.countMult
   * (src/sim/build/compile.ts compileBarrage).
   */
  'barrageCount',
  /**
   * 範圍: the multiplier on every area radius the build's attacks, effects and zones create, e.g.
   * 1.2 = 120% (docs/v3/game-design-v3.md §2.1's 回響). Read once a compile into
   * BuildFlags.areaFactor, which sizeOf multiplies by (src/sim/build/size.ts).
   */
  'areaSize',
  /**
   * 爆炸半徑 (擴散): the multiplier on the magma bomb's radius and its fire zone's alone, on top of
   * areaSize (src/sim/emitters/lob.ts lobRadius).
   */
  'bombRadius',
  /**
   * 擴散距離 (熔核's 擴散 and the fire outer's 野火, docs/v3/game-design-v3.md §1.2, §4.1): the
   * multiplier on how far a spread reaches, e.g. 1.5 = 150%: every spreadAilment's radius, the
   * radius of an applyAilment and the range of a target selector that node data marks `spread`,
   * and a rule module's own spread distances. Read once a compile into BuildFlags.spreadFactor,
   * which spreadOf multiplies by (src/sim/build/size.ts).
   */
  'spreadRadius',
  /**
   * 無人機速度 (機隊's 「無人機傷害、速度」, docs/v3/game-design-v3.md:478): the multiplier on every
   * drone's and timed row's speed, e.g. 1.2 = 120%, the drone emitters' (grants and the swarm)
   * and every spawnDrone's. Read once a run, at the drone pool's fill, as max(0, droneSpeed)
   * (src/sim/emitters/drone.ts); it reaches no dock time, cooldown, turret or shot.
   */
  'droneSpeed',
  /**
   * 召喚物存在時間 (女王's ◆蜂王漿 「臨時無人機存在時間 +50%」, docs/v3/game-design-v3.md:199): the
   * multiplier on every timed row's life, e.g. 1.5 = 150%: each row a spawnDrone effect appends
   * lives max(1, round(lifeSec × 60 × summonDuration)) ticks. Read once a run, at the drone pool's
   * fill, as max(0, summonDuration) (src/sim/emitters/drone.ts); it reaches no fixed row, zone,
   * shot or dock time.
   */
  'summonDuration',
  /**
   * 小彈穿透 (the barrage outer's 分裂 ranks, docs/v3/game-design-v3.md §4.11): the barrage
   * rider's small shots' extra pierce; its whole part counts, so a small shot hits
   * floor(barragePierce) + 1 enemies at most. Read once a compile (src/sim/build/compile.ts
   * compileBarrage); it reaches no other shot.
   */
  'barragePierce',
] as const;

export type StatId = (typeof STAT_IDS)[number];

/** Base values before any modifier (docs/GDD.md §3.1–3.4). */
export const BASE_STATS: Readonly<Record<StatId, number>> = {
  damage: 10,
  attackSpeed: 4,
  projectileCount: 2,
  critChance: 0.05,
  critMultiplier: 1.5,
  igniteChance: 0.1,
  // 1.5/s for 1.2 s: 180% of the hit, as before, but dealt before the swarm walks in.
  burnDamage: 1.5,
  burnDuration: 1.2,
  burnMaxStacks: 5,
  chainCount: 0,
  chainRetention: 0.7,
  chainRange: 260,
  maxLife: 100,
  projectileSpeed: 1400,
  shardGain: 1,
  coreGain: 1,
  critAlways: 0,
  igniteAlways: 0,
  poisonChance: 0,
  poisonDamage: 0.2,
  poisonDuration: 4,
  bleedChance: 0,
  bleedDamage: 0.4,
  bleedDuration: 4,
  shockChance: 0,
  shockEffect: 0.1,
  shockMaxStacks: 3,
  shockDuration: 2,
  poisonAlways: 0,
  bleedAlways: 0,
  shockAlways: 0,
  bleedStationaryMult: 1,
  frostOnHit: 0,
  frostSlowCap: 0.3,
  freezeDuration: 1.2,
  shatterDamage: 0.15,
  shatterRadius: 90,
  frozenDamageTaken: 0.3,
  auraRadius: 160,
  orbitCount: 0,
  contactDamageTaken: 1,
  lifeRegen: 0,
  extraLives: 0,
  dashRepel: 0,
  bossHoldSec: 0,
  bulletDodgeSec: 0,
  bulletDodgeCombo: 0,
  orbitBlocksBullets: 0,
  reflectBullets: 0,
  shieldPoolSec: 0,
  ignoreShield: 0,
  ignoreArmour: 0,
  ailmentOnBlock: 0,
  enemyRegen: 1,
  toughDropMult: 1,
  treasureRate: 1,
  barrageCount: 0,
  areaSize: 1,
  bombRadius: 1,
  spreadRadius: 1,
  droneSpeed: 1,
  summonDuration: 1,
  barragePierce: 0,
};

/**
 * Stats whose modifiers may carry tags, notTags, a scope, conditions and a scaling: their value
 * depends on the damage instance, so the simulation reads them from ModTable rows keyed by the
 * instance's tags and source (src/sim/build/modTable.ts). A row holds them in this order.
 * enemyRegen's modifiers carry conditions and scalings only: it is read on the untagged center
 * row (src/data/validate.ts). attackSpeed's per-instance modifiers (attackSpeedIssues) multiply
 * the cadence of the emitters whose payload rows they match (src/sim/systems/combo.ts); its
 * other modifiers stay in StatBlock.values, its attack interval, and its column in a row starts
 * from 1 rather than its base (src/sim/build/modTable.ts).
 */
export const SCOPED_STATS = [
  'damage',
  'critChance',
  'critMultiplier',
  'igniteChance',
  'critAlways',
  'igniteAlways',
  'poisonChance',
  'bleedChance',
  'shockChance',
  'poisonAlways',
  'bleedAlways',
  'shockAlways',
  'frostOnHit',
  'ignoreShield',
  'ignoreArmour',
  'ailmentOnBlock',
  'enemyRegen',
  'attackSpeed',
] as const satisfies readonly StatId[];
export type ScopedStat = (typeof SCOPED_STATS)[number];

export const isScopedStat = (stat: StatId): stat is ScopedStat =>
  (SCOPED_STATS as readonly StatId[]).includes(stat);

/** Stats that force a roll's outcome rather than change its chance. */
export const ALWAYS_STATS = [
  'critAlways',
  'igniteAlways',
  'poisonAlways',
  'bleedAlways',
  'shockAlways',
] as const satisfies readonly ScopedStat[];

export type ModifierKind = 'flat' | 'increased' | 'more';

/**
 * `flat` adds to the base, `increased` values add together, `more` values multiply:
 * final = (base + Σflat) × (1 + Σincreased) × Π(1 + more).
 * `value` is a fraction for increased/more (0.2 = 20%).
 * Only modifiers of SCOPED_STATS may carry tags, notTags, a scope, conditions or a scaling, and
 * flat damage never does: it stays in StatBlock.values.damage; attackSpeed's only as
 * attackSpeedIssues allows. An empty list counts as no list.
 */
export interface Modifier {
  readonly stat: StatId;
  readonly kind: ModifierKind;
  readonly value: number;
  /** Tags the damage instance must all carry. */
  readonly tags?: readonly DamageTag[];
  /** Tags the damage instance must not carry. */
  readonly notTags?: readonly DamageTag[];
  /** Sources the damage instance must be credited to (src/data/sources.ts). */
  readonly scope?: SourceSelector;
  /** Conditions on the instance's target, all of which must hold (src/data/triggers.ts). */
  readonly when?: readonly TargetCondition[];
  /** The value counts per damage instance, scaled by one of its variables (src/data/triggers.ts). */
  readonly scaling?: ScalingSpec;
}

/** Tags, notTags, a scope, conditions or a scaling: the value depends on the damage instance. */
export const isPerInstance = (mod: Modifier): boolean =>
  (mod.tags?.length ?? 0) > 0 ||
  (mod.notTags?.length ?? 0) > 0 ||
  mod.scope !== undefined ||
  (mod.when?.length ?? 0) > 0 ||
  mod.scaling !== undefined;

/**
 * Why an attackSpeed modifier is not legal, if it is not. A per-instance one (isPerInstance)
 * multiplies the cadence of its emitters (src/sim/systems/combo.ts), which has no target and is
 * recomputed only when the combo stacks change: a `more`, without conditions, scaled on
 * comboStacks if it scales. The others stay in StatBlock.values, as any kind.
 */
export function attackSpeedIssues(mod: Modifier): string[] {
  if (mod.stat !== 'attackSpeed' || !isPerInstance(mod)) return [];
  const issues: string[] = [];
  if (mod.kind !== 'more') {
    issues.push(
      `attackSpeed with tags, notTags, a scope or a scaling must be kind 'more' (got '${mod.kind}'): it multiplies its emitters' cadence`,
    );
  }
  if ((mod.when?.length ?? 0) > 0) {
    issues.push("attackSpeed takes no conditions: an emitter's cadence has no target");
  }
  const per = mod.scaling?.per;
  if (per !== undefined && per !== 'comboStacks') {
    issues.push(
      `attackSpeed scales only on 'comboStacks' (got '${per}'): its emitters' cadence is recomputed only when the stacks change`,
    );
  }
  return issues;
}

/**
 * Why a modifier on scaling.curve 'powFactor' is not legal, if it is not (docs/v3 C6 design
 * D30): its contribution is its factor − 1 (src/sim/build/eval.ts), so only a more of value 1
 * multiplies by the factor itself; a positive exponent makes the factor grow with x, and a cap
 * below 1 would make it a penalty at every x. Data validation and a rule module's addModifier
 * both read it.
 */
export function powFactorIssues(mod: Modifier): string[] {
  const scaling = mod.scaling;
  if (scaling?.curve !== 'powFactor') return [];
  const issues: string[] = [];
  const exponent = scaling.exponent;
  if (!(exponent !== undefined && exponent > 0)) {
    issues.push(`scaling.exponent must be > 0 (got ${exponent})`);
  }
  if (mod.kind !== 'more') {
    issues.push(`kind must be 'more' with scaling.curve 'powFactor' (got '${mod.kind}')`);
  }
  if (mod.value !== 1) {
    issues.push(`value must be 1 with scaling.curve 'powFactor' (got ${mod.value})`);
  }
  if (scaling.cap !== undefined && !(scaling.cap >= 1)) {
    issues.push(`scaling.cap must be >= 1 with curve 'powFactor' (got ${scaling.cap})`);
  }
  return issues;
}

/**
 * A modifier that changes how hits play out rather than a number the player reads off the
 * stat list: tags on a stat other than damage, notTags, conditions, a scaling, or an
 * ALWAYS_STATS stat. The talent screen leaves it to its node's descKey text, which data
 * validation requires.
 */
export function isBehaviourModifier(mod: Modifier): boolean {
  return (
    ((mod.tags?.length ?? 0) > 0 && mod.stat !== 'damage') ||
    (mod.notTags?.length ?? 0) > 0 ||
    (mod.when?.length ?? 0) > 0 ||
    mod.scaling !== undefined ||
    (ALWAYS_STATS as readonly StatId[]).includes(mod.stat)
  );
}

/** A trigger of an allocated node, with the source its damage is credited to. */
export interface SourcedTrigger {
  /** Source id (src/data/sources.ts), from the node's id. */
  readonly source: string;
  readonly spec: TriggerSpec;
  /** The fusion coefficient (docs/v3 C6 design D10); 1 when absent. Only fusion boards set it. */
  readonly coef?: number;
}

/**
 * A rule of an owned node of a v3 web, with its board's source and its fusion's coefficient (1
 * on every other board; docs/v3 C6 design D9, D10): a character run's rules (CharacterRun,
 * src/sim/types.ts).
 */
export interface SourcedRule {
  /** Source id (src/data/sources.ts), from the node's id. */
  readonly source: string;
  readonly spec: RuleSpec;
  readonly coef: number;
}

/**
 * A damage conversion of an allocated node, with the source of its node. A conversion converts
 * every hit with its tags whatever the hit's source, and the converted part keeps the hit's
 * source (docs/v3/implementation-plan-v3.md §2.7), so the simulation does not read this one.
 */
export interface SourcedConversion {
  /** Source id (src/data/sources.ts), from the node's id. */
  readonly source: string;
  readonly spec: ConversionSpec;
}

/**
 * Triggers, conversions and emitter grants (src/data/emitters.ts) of the allocated nodes, with
 * their sources, in data order.
 */
export interface StatExtras {
  readonly triggers: readonly SourcedTrigger[];
  readonly conversions: readonly SourcedConversion[];
  readonly emitters: readonly SourcedEmitter[];
}

export const NO_EXTRAS: StatExtras = { triggers: [], conversions: [], emitters: [] };

/** Final stats handed to the simulation for one run. */
export interface StatBlock {
  /** Every stat before modifiers: BASE_STATS, or a test's overridden values. */
  readonly base: Readonly<Record<StatId, number>>;
  /**
   * Final value of every stat from its untagged, unscoped modifiers without conditions or a
   * scaling. For `damage` this is the untagged base (base + Σflat); damage increased/more
   * modifiers count per damage instance.
   */
  readonly values: Readonly<Record<StatId, number>>;
  /**
   * Every modifier of a scoped stat, untagged ones included, in data order, but attackSpeed's
   * per-instance ones only (isPerInstance), since its others are its attack interval. The
   * simulation folds them per tag mask and source into ModTable rows: damage of an instance =
   * values.damage × its damage row; another scoped stat of an instance is its row's value, and
   * attackSpeed's is a factor on its emitter's cadence.
   */
  readonly scoped: readonly Modifier[];
  readonly triggers: StatExtras['triggers'];
  readonly conversions: StatExtras['conversions'];
  readonly emitters: StatExtras['emitters'];
}
