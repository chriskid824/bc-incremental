/**
 * Trigger vocabulary (docs/v3/implementation-plan-v3.md §2.6): the events a talent's triggers
 * listen to, their conditions and their effects; the ailment kinds, which damage attribution
 * reads (src/data/sources.ts); the scaling of modifiers whose value depends on the damage
 * instance (Modifier.scaling); and damage conversions (§2.7). Each member lands together with the
 * simulation code that reads it (src/sim/effects/, src/sim/build/eval.ts,
 * src/sim/combat/convert.ts), so the schemas (src/data/schema.ts) accept only what the
 * simulation can run.
 */

import type { SourceSelector } from './sources';
import type { DamageTag } from './tags';

/** Ailments an enemy can carry. The order is fixed: simulation bitsets index it. */
export const AILMENT_KINDS = ['burn', 'poison', 'bleed', 'shock', 'frost'] as const;
export type AilmentKind = (typeof AILMENT_KINDS)[number];

/**
 * What a scaling modifier counts, read per damage instance. `chainJump`: the instance's chain
 * jump index, 0 for the primary hit. `targetBurnStacks`, `targetPoisonStacks`,
 * `targetShockStacks`: the stacks of that ailment on the instance's target. `targetFrost`: the
 * target's chill meter, 0 to 1 (a frozen enemy reads 1). `targetDistance`: how far the target is
 * from the player, in arena units.
 * `lifeLostPct`: the fraction of the player's max life missing, 0 to 1. A target variable reads
 * 0 without a target (estimates outside a run). The simulation reads each variable through a
 * registry typed over this list (src/sim/build/eval.ts), so a new variable lands with its reader.
 */
export const SCALING_VARS = [
  'chainJump',
  'targetBurnStacks',
  'targetDistance',
  'lifeLostPct',
  'targetPoisonStacks',
  'targetShockStacks',
  'targetFrost',
] as const;
export type ScalingVar = (typeof SCALING_VARS)[number];

export const SCALING_CURVES = ['linear', 'log10', 'pow', 'powFactor'] as const;
export type ScalingCurve = (typeof SCALING_CURVES)[number];

/**
 * How a modifier's value scales with a variable x (Modifier.scaling): its contribution is
 * c = min(cap, value × g(x)). With `every`, x first steps down to floor(x / every); then g is x
 * (linear, the default), log10(1 + x) or x^exponent (pow). A flat or increased modifier adds c,
 * a more modifier multiplies by 1 + c. powFactor is a factor, with no 1 +: on a more modifier of
 * value 1, the only one validation takes it on (exponent > 0, cap absent or ≥ 1), it multiplies
 * by min(cap, max(1, x)^exponent), greed's held-shard factor (docs/v3/game-design-v3.md §4.12).
 */
export interface ScalingSpec {
  readonly per: ScalingVar;
  /** Step size: x counts whole steps of `every`. Continuous without it. */
  readonly every?: number;
  readonly curve?: ScalingCurve;
  /** Exponent of the pow and powFactor curves; required exactly with those two. */
  readonly exponent?: number;
  /** Upper bound on the contribution, or on powFactor's factor. Uncapped without it. */
  readonly cap?: number;
}

/** Events of a character's signature attack (implementation-plan-v3 §2.11). */
export const CENTER_EVENTS = ['explode', 'freeze', 'chainJump', 'droneImpact'] as const;
export type CenterEvent = (typeof CENTER_EVENTS)[number];

/**
 * Every event a trigger can listen to. The order is fixed: the simulation lists the triggers of
 * each event by its position here.
 */
export const TRIGGER_EVENTS = [
  ...CENTER_EVENTS,
  'hit',
  'crit',
  'kill',
  'nthAttack',
  'ailmentApplied',
  'ailmentTick',
  'diedWithAilment',
  'shatter',
  'heroHit',
  'contact',
  'waveStart',
  'periodic',
  'droneExpire',
] as const;
export type TriggerEventId = (typeof TRIGGER_EVENTS)[number];

/**
 * The events the simulation raises so far; validation rejects a trigger on any other.
 * - hit, crit: a hit of the build (a crit hit), at its target, also when the hit kills.
 * - kill: an enemy dies. diedWithAilment: an enemy dies holding an ailment (HeldAilment). Their
 *   triggers run at the next tick, except those whose effects all transfer ailments
 *   (TRANSFER_EFFECTS), which run at the kill while the victim's ailments are still on it.
 * - nthAttack: every Nth attack (`every`) of the build's emitters, at the attack's first target.
 * - waveStart, periodic (every `every` seconds): no target; effects start at the player.
 * - heroHit: an enemy reached the player and hurt it, or a shooter's bullet hit it; no target,
 *   effects start at the player.
 * - contact: an enemy touched the player; the target is that enemy.
 * - ailmentApplied: a hit or an effect applied an ailment (AppliedAilment) to its target; moving
 *   stacks (spreadAilment) applies nothing.
 * - ailmentTick: a damage-over-time step (every 0.25 s) of an enemy holding the ailment, every
 *   `every` seconds, at that enemy.
 * - freeze: an enemy's chill meter filled, at that enemy: a normal enemy froze, or a boss's meter
 *   emptied (a boss never freezes). It needs no signature hit.
 * - shatter: a frozen enemy died and shattered (its triggers run at the next tick, like kill's);
 *   an enemy killed by a shatter does not shatter.
 * - explode: a bomb of the signature attack (magmaBomb) landed and exploded, after its hits and
 *   its chain, at its landing point; the target is the enemy nearest that point among those it
 *   hit, none when it hit nothing. Its list is the first enemies of the blast, by id. Each bomb
 *   raises its own.
 * - chainJump: a chain jump of the signature arc (triphaseArc) hit an enemy, at that enemy:
 *   every jump hit of its discharges, forks, extra jumps and bounces included, never a
 *   discharge's own hit nor a repeat's hits. Its value is the jump's angle from the enemy it
 *   jumped from; it has no list. Its triggers take no chance condition: each fires at 30% × its
 *   coefficient, at most 3 times an attack (CHAIN_JUMP_EVENT_CAP, src/sim/caps.ts).
 * - droneImpact: a drone of the signature attack (swarm) impacted, after its hits and its chain,
 *   at its target, which is the only enemy; it carries no list. Repeats and granted drones raise
 *   none.
 */
export const WIRED_EVENTS: ReadonlySet<TriggerEventId> = new Set<TriggerEventId>([
  'explode',
  'chainJump',
  'droneImpact',
  'hit',
  'crit',
  'kill',
  'diedWithAilment',
  'nthAttack',
  'waveStart',
  'periodic',
  'heroHit',
  'contact',
  'ailmentApplied',
  'ailmentTick',
  'freeze',
  'shatter',
]);

/** Events without an enemy target: their effects start at the player. */
export const TARGETLESS_EVENTS: ReadonlySet<TriggerEventId> = new Set<TriggerEventId>([
  'waveStart',
  'periodic',
  'heroHit',
]);

/**
 * Ailments a condition can ask an enemy about (targetHas, victimHas). frost: its chill meter is
 * above 0; frozen: it is frozen (a frozen enemy holds frost too).
 */
export const HELD_AILMENTS = ['burn', 'poison', 'bleed', 'shock', 'frost', 'frozen'] as const;
export type HeldAilment = (typeof HELD_AILMENTS)[number];

/** Ailments whose stacks a condition can count (stacksAtLeast). */
export const STACK_AILMENTS = ['burn', 'poison', 'shock'] as const;
export type StackAilment = (typeof STACK_AILMENTS)[number];

/** Ailments whose damage left a detonate deals at once: those that deal damage over time. */
export const DETONATE_AILMENTS = ['burn', 'poison', 'bleed'] as const;
export type DetonateAilment = (typeof DETONATE_AILMENTS)[number];

/** What dealt a killing blow (killedBy): a hit, or an ailment's damage over time. */
export const KILL_KINDS = ['hit', 'burn', 'poison', 'bleed'] as const;
export type KillKind = (typeof KILL_KINDS)[number];

/**
 * Ailments a hit or an effect applies (the ailment condition of ailmentApplied); frost is not
 * one of them. Those that deal damage over time (DOT_AILMENTS) can also tick (ailmentTick).
 */
export const APPLIED_AILMENTS = ['burn', 'poison', 'bleed', 'shock'] as const;
export type AppliedAilment = (typeof APPLIED_AILMENTS)[number];
export const DOT_AILMENTS: readonly AppliedAilment[] = ['burn', 'poison', 'bleed'];

/** Bosses; elites (M1's hexagon); every other enemy. */
export const TARGET_KINDS = ['normal', 'elite', 'boss'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/**
 * Which hit an event comes from (hitIs): a crit or not, the primary hit of a signature attack
 * (never an effect's hit) or a chain jump, the signature attack's. On kill events it is the
 * killing hit; a kill by damage over time is none of these.
 */
export const HIT_KINDS = ['crit', 'nonCrit', 'primary', 'chainJump', 'signature'] as const;
export type HitKind = (typeof HIT_KINDS)[number];

/**
 * What a v3 enemy is doing (targetState): dashing, a dasher's dash; stopped, a dasher charging
 * its dash, or a shooter or a summoner at its post (src/sim/systems/enemyAi.ts).
 */
export const TARGET_STATES = ['dashing', 'stopped'] as const;
export type TargetState = (typeof TARGET_STATES)[number];

/**
 * A condition on the enemy an event or a damage instance targets; never met without a target.
 * targetHas: the enemy holds the ailment (burn: one of its burn stacks has not ended yet;
 * poison: it has poison damage left to take; bleed: its bleed has not ended; shock: its shock
 * has not worn off; frost: its chill meter is above 0, or it is frozen; frozen: it is frozen).
 * targetHpBelow: its hp is below this fraction of its max hp. stacksAtLeast: it carries at least
 * this many stacks of the ailment, or with 'max' as many as it can hold (burn: its stack cap, at
 * least 1, and 5 under eternalFlame, whose burns have no cap; shock: shockMaxStacks, at least 1;
 * poison has no cap, so it takes a number). inZone: it stands in a ground zone of this source,
 * one source id and never a class (a zone pulse marks the enemies within it for 16 ticks,
 * groundZone). targetState: it is in that state (TARGET_STATES), never in an M1 run, whose
 * enemies have no behaviours. targetFrostAtLeast: its chill meter is at least this fraction, in
 * (0, 1] (a frozen enemy's meter reads full, frostMeter).
 */
export type TargetCondition =
  | { readonly targetHas: HeldAilment }
  | { readonly targetKind: TargetKind }
  | { readonly targetHpBelow: number }
  | {
      readonly stacksAtLeast: { readonly ailment: StackAilment; readonly stacks: number | 'max' };
    }
  | { readonly inZone: SourceSelector }
  | { readonly targetState: TargetState }
  | { readonly targetFrostAtLeast: number };

/**
 * A condition of a trigger. chance: the trigger fires with this probability, rolled when the
 * event happens. cooldownSec: once it fires, it cannot fire again for this long. hitIs: the
 * kind of hit the event comes from. victimHas, killedBy: what the dying enemy held when it died,
 * and what killed it. ailment: on ailmentApplied, the ailment applied; on ailmentTick, an
 * ailment dealing damage over time that the ticking enemy holds. Each trigger on those two
 * events has exactly one, so none fires for every ailment or every enemy.
 */
export type Condition =
  | TargetCondition
  | { readonly chance: number }
  | { readonly cooldownSec: number }
  | { readonly hitIs: HitKind }
  | { readonly victimHas: HeldAilment }
  | { readonly killedBy: KillKind }
  | { readonly ailment: AppliedAilment };

type KeysOf<T> = T extends unknown ? keyof T : never;
export type ConditionKey = KeysOf<Condition>;

/** The one key of a condition. */
export const conditionKey = (condition: Condition): ConditionKey =>
  Object.keys(condition)[0] as ConditionKey;

/** Events with an enemy target, on which target conditions can be checked. */
const TARGETED: readonly TriggerEventId[] = [
  'explode',
  'chainJump',
  'droneImpact',
  'hit',
  'crit',
  'nthAttack',
  'contact',
  'ailmentApplied',
  'ailmentTick',
  'freeze',
];
const KILLS: readonly TriggerEventId[] = ['kill', 'diedWithAilment', 'shatter'];

/**
 * Where each condition is allowed: the trigger events it can be checked on, and 'modifier' for
 * Modifier.when, which takes target conditions only. A kill event's victim is gone by the time
 * its triggers run, so they read what it held at its death (victimHas) instead.
 */
export const CONDITION_CONTEXTS: Readonly<
  Record<ConditionKey, readonly (TriggerEventId | 'modifier')[]>
> = {
  targetHas: ['modifier', ...TARGETED],
  targetKind: ['modifier', ...TARGETED],
  targetHpBelow: ['modifier', ...TARGETED],
  stacksAtLeast: ['modifier', ...TARGETED],
  inZone: ['modifier', ...TARGETED],
  targetState: ['modifier', ...TARGETED],
  targetFrostAtLeast: ['modifier', ...TARGETED],
  chance: TRIGGER_EVENTS,
  cooldownSec: TRIGGER_EVENTS,
  hitIs: ['hit', 'crit', ...KILLS],
  victimHas: KILLS,
  killedBy: KILLS,
  ailment: ['ailmentApplied', 'ailmentTick'],
};

/**
 * Which enemy a trigger's selector picks (TriggerSpec.target), among the alive ones it accepts
 * (TargetSelector), ties to the lower id:
 * - nearest: the closest to the `from` point;
 * - farthest: the farthest from the `from` point;
 * - highestHp: the one with the most hp left;
 * - densest: the one closest to the center of the most crowded spot (a 3 × 3 block of grid
 *   cells, src/sim/grid.ts densest);
 * - outermost: the farthest from the player;
 * - player: no enemy; area effects center on the player;
 * - mostStacks: the one with the most live stacks of `ailment`, at least one.
 */
export const TARGET_PICKS = [
  'nearest',
  'farthest',
  'highestHp',
  'densest',
  'outermost',
  'player',
  'mostStacks',
] as const;
export type TargetPick = (typeof TARGET_PICKS)[number];

/** Where a selector measures `range`, nearest and farthest from. */
export const SELECTOR_ORIGINS = ['event', 'player'] as const;
export type SelectorOrigin = (typeof SELECTOR_ORIGINS)[number];

/**
 * The enemy a trigger's effects act on in place of the event's (TriggerSpec.target). It accepts
 * the alive enemies within `range` of `from` (unlimited without it), but the event's own enemy
 * with excludeEventTarget and bosses with excludeBoss. `from` is the event's point (its enemy's
 * position, a kill's victim's) by default and on events without one the player's; mostStacks
 * counts the stacks of `ailment`, which only it takes.
 */
export interface TargetSelector {
  readonly pick: TargetPick;
  readonly ailment?: StackAilment;
  readonly from?: SelectorOrigin;
  readonly range?: number;
  readonly excludeEventTarget?: boolean;
  readonly excludeBoss?: boolean;
}

/**
 * Which of the enemies within its radius an effect capped by maxTargets reaches: the first in
 * id order ('id', the default), or the nearest to the effect's center, nearest first, ties to
 * the lower id ('nearest').
 */
export const TARGET_ORDERS = ['id', 'nearest'] as const;
export type TargetOrder = (typeof TARGET_ORDERS)[number];

/**
 * The damage of an explode, a nova or projectiles: their hits are tagged hit and trigger, and
 * area (explode, nova) or projectile (projectiles).
 */
interface DamagePart {
  /** Damage of each hit as a fraction of the damage stat. */
  readonly damagePct: number;
  /** More delivery tags of its hits: owner or geometry tags (src/data/tags.ts). */
  readonly tags?: readonly DamageTag[];
  /** The element its hits carry. */
  readonly element?: 'cold' | 'lightning';
}

interface ExplodeSpec extends DamagePart {
  readonly kind: 'explode';
  readonly radius: number;
  readonly maxTargets?: number;
  readonly order?: TargetOrder;
}

interface NovaSpec extends DamagePart {
  readonly kind: 'nova';
  readonly radius: number;
  readonly at?: 'player' | 'event';
}

/**
 * A ground zone (src/sim/systems/zones.ts): it pulses every 0.25 s for `durationSec`, rounded to
 * whole pulses (one at least). Each pulse hits every enemy within `radius` for damagePctPerSec ×
 * 0.25 of the damage stat (0: no hit), tagged hit and zone plus its tags and element; its hits
 * crit and roll ailments as any hit does. Then each enemy takes the zone's own terms:
 * `ailmentStacks` (default 1) of `ailment`, each as an applyAilment of damagePct
 * `ailmentDamagePct` (default 1) would apply it; addFrostPerSec × 0.25 of frost; and `slow`,
 * which holds 16 ticks past the pulse (the strongest live one counts, with frost the larger
 * slow). A source keeps at most 16 zones, the oldest giving way; inZone conditions read the zones
 * of the source they name.
 */
export interface GroundZoneSpec {
  readonly kind: 'groundZone';
  readonly radius: number;
  readonly durationSec: number;
  /** Required: 0 makes a zone that only applies its terms. */
  readonly damagePctPerSec: number;
  readonly ailment?: AppliedAilment;
  readonly ailmentStacks?: number;
  readonly ailmentDamagePct?: number;
  readonly addFrostPerSec?: number;
  readonly slow?: number;
  /** More delivery tags of its hits: owner or geometry tags (src/data/tags.ts). */
  readonly tags?: readonly DamageTag[];
  /** The element its hits carry. */
  readonly element?: 'cold' | 'lightning';
}

/**
 * Repeats of the signature attack (回聲, 多重施法): `count` of them, each the attack again at
 * a fresh target, dealing damagePct of the attack's damage on the effects stream. With timing
 * 'now' (the default) they fire when the effect runs; with 'nextAttack' they wait and fire right
 * after the attack's next own firing, at most 8 waiting at once (more are dropped). A repeat
 * counts as no attack of its own: it advances no nthAttack count, no steadyAim rhythm and no
 * per-attack form (遠投, 連環爆), its hits are never steady and raise no center event, and it
 * never repeats in turn. Forms that last apply to it (火山's giant bombs).
 */
export interface RepeatAttackSpec {
  readonly kind: 'repeatAttack';
  /** Repeats, 1 to 4. */
  readonly count: number;
  /** Each repeat's share of the signature attack's damage. */
  readonly damagePct: number;
  readonly timing?: 'now' | 'nextAttack';
}

/**
 * Deals at once `fraction` (default 1) of the damage the ailment has yet to deal on the event's
 * enemy, which loses that share of it (every stack keeps going, weaker by that share; all of it
 * removes the ailment), × `damage` (default 1): to that enemy, or to up to `maxTargets` enemies
 * within `radius` of it (in `order`), each taking the whole amount. Its hits are tagged with the
 * ailment's kind and trigger (and area with a radius), never crit and roll no ailment, and the
 * damage modifiers do not scale them again: the ailment's damage already had them. On kill,
 * diedWithAilment and shatter events the enemy is dead: it needs a radius and a victimHas
 * condition of the ailment, and deals what the victim had left at its death.
 */
export interface DetonateSpec {
  readonly kind: 'detonate';
  readonly ailment: DetonateAilment;
  readonly fraction?: number;
  readonly damage?: number;
  readonly radius?: number;
  readonly maxTargets?: number;
  readonly order?: TargetOrder;
}

/**
 * `count` small projectiles, each hitting for damagePct of the damage stat, tagged hit, trigger
 * and projectile plus its tags and element, as no attack. They start at the event's point, or
 * at the player with from 'player', and fly by `aim`:
 * - 'target': each homes in on the event's enemy (or the one the trigger's selector picked);
 * - 'distinct': one homes in on each of the `count` enemies nearest to the start;
 * - 'radial': straight out, evenly spaced around the start, the first one directly away from
 *   the player (along +x from the player itself);
 * - 'fan': straight at the event's enemy, spread over `spreadDeg` (default 30) degrees.
 * A straight one hits the enemies on its line, `pierce` (default 0) more after the first, or
 * every one with -1, and turns back at the arena's edge `bounce` (default 0) times. A homing
 * one hits its enemy and ends; when that enemy dies first it turns to the enemy nearest to it,
 * or fades. Each lasts 120 ticks (2 s).
 */
export interface ProjectilesSpec extends DamagePart {
  readonly kind: 'projectiles';
  /** Projectiles, 1 to 64. */
  readonly count: number;
  readonly aim: 'target' | 'distinct' | 'radial' | 'fan';
  readonly from?: 'event' | 'player';
  readonly pierce?: number;
  readonly bounce?: number;
  readonly spreadDeg?: number;
}

/**
 * A slash: a line `length` long from the event's point, or from the event's enemy with from
 * 'target', that hits once each, in id order, every enemy within width / 2 + its own radius of
 * the line, for damagePct of the damage stat, tagged hit and trigger plus its tags. It runs by
 * `toward`:
 * - 'outward': straight away from the player;
 * - 'nearest': at the enemy nearest to its start but one right on it (the event's enemy, when
 *   the slash starts on it);
 * - 'eventTarget': at the event's enemy (or the one the trigger's selector picked);
 * - 'along' (chainJump only): on along the jump, the way it went from the enemy it jumped from.
 * Without a direction (its start on the player or on the enemy it runs at, or no enemy to run
 * at) it does nothing. Its hits crit and roll ailments as any hit does, and always crit with
 * alwaysCrit; `critScale` k (default 0) scales its damage by 1 + k × the crit chance.
 */
export interface SlashLineSpec {
  readonly kind: 'slashLine';
  readonly length: number;
  readonly width: number;
  readonly damagePct: number;
  readonly toward: 'outward' | 'nearest' | 'eventTarget' | 'along';
  readonly from?: 'event' | 'target';
  readonly alwaysCrit?: boolean;
  readonly critScale?: number;
  /** More delivery tags of its hits: owner or geometry tags (src/data/tags.ts). */
  readonly tags?: readonly DamageTag[];
}

/**
 * One hit on the event's enemy (or the one the trigger's selector picked; on explode, the
 * explosion's primary) for `multiplier` × the damage stat, tagged hit and trigger. With
 * ignoreShield and ignoreArmour it passes through an enemy's shield and armour (Payload.bypass,
 * read by bypassOf in src/sim/combat/defend.ts).
 */
export interface CoinHitSpec {
  readonly kind: 'coinHit';
  readonly multiplier: number;
  readonly ignoreShield?: boolean;
  readonly ignoreArmour?: boolean;
}

/**
 * A bolt of lightning that chains (電弧): one hit on its first enemy, then exactly `jumps`
 * jumps, each from the enemy it last hit to the nearest one within the chain range it has not
 * hit, for damagePct of the damage stat (a jump's × the chain retention once per jump), tagged
 * hit, trigger, chain and lightning. Its first enemy is the event's (or the one the trigger's
 * selector picked) with from 'eventTarget' (the default), or the enemy nearest the event's
 * point within the chain range with from 'nearestToPoint'; without one it does nothing. Each of
 * its hits that leaves its enemy alive then adds `shockStacks` (default 0) of shock to it, with
 * no roll. Its hits crit and roll ailments as any hit does. It is an attack of its own, with its
 * own chain budget (CHAIN_HIT_CAP, its first hit counting 1), but no chain policy, and it
 * raises no chainJump.
 */
export interface ChainBoltSpec {
  readonly kind: 'chainBolt';
  /** Jumps after the first hit, 0 to 31: jumps 2 hits 3 enemies. */
  readonly jumps: number;
  readonly damagePct: number;
  readonly shockStacks?: number;
  readonly from?: 'eventTarget' | 'nearestToPoint';
}

/**
 * What a trigger does. An effect on the event's enemy does nothing once that enemy is dead.
 * With a target selector (TriggerSpec.target), the picked enemy takes the event enemy's place,
 * and the event's point too: effects around the event center on it, or on the player for a
 * 'player' pick, which leaves the effects no enemy.
 * - applyAilment: `stacks` (default 1) of the ailment on the event's enemy, or on up to
 *   `maxTargets` enemies within `radius` of the event (in `order`); each stack deals what a hit
 *   of damagePct (default 1) of the damage stat would apply. An enemy keeps only its strongest
 *   bleed, so more bleed stacks add nothing; shock stacks only change how much damage the enemy
 *   takes.
 * - spreadAilment: copies the event enemy's stacks of the ailment, at `effect` (default 1) of
 *   their damage, to every other enemy within `radius` of it. A transfer: it deals no damage.
 *   Poison only: `stacks` is the fraction of the stacks each enemy gets (default 1, the
 *   longest-lasting first), and `maxTargets` caps how many enemies it reaches (in `order`).
 *   `toSplitChildren`, on a kill trigger that runs at the kill: each enemy the victim splits
 *   into gets that fraction of the victim's poison stacks and of their damage left, wherever
 *   it is and whatever `effect`, `stacks` and `maxTargets` say.
 * - explode: hits up to `maxTargets` enemies within `radius` of the event (in `order`).
 * - nova: hits every enemy within `radius` of the player, or of the event with at 'event'.
 * - push: moves the enemies within `radius` of the event `distance` further from the player.
 * - addFrost: adds `amount` to the chill meter of the event's enemy, or of up to `maxTargets`
 *   enemies within `radius` of the event (in `order`).
 * - heal: the player regains `lifePct` of max life.
 * - shield: the player's shield gains `lifePct` of max life, up to `capPct` of max life in all
 *   (without a limit when it is omitted); a shield already above the cap stays as it is. The
 *   shield takes contact damage before life (src/sim/systems/contact.ts).
 * - gainShards: the dying enemy's shard drop again, × `fraction` (kill events only).
 * - groundZone: a zone of `radius` at the event's point for `durationSec`, pulsing four times a
 *   second (GroundZoneSpec).
 * - repeatAttack: the signature attack again, `count` times, at damagePct of its damage
 *   (RepeatAttackSpec).
 * - detonate: the damage an ailment has left on the event's enemy, dealt at once (DetonateSpec).
 * - projectiles: `count` small projectiles from the event's point or the player, homing or
 *   straight by `aim` (ProjectilesSpec).
 * - slashLine: a line from the event's point or enemy that hits every enemy it crosses
 *   (SlashLineSpec).
 * - coinHit: one hit of `multiplier` × the damage stat on the event's enemy (CoinHitSpec).
 * - chainBolt: a hit on the event's enemy, or the one nearest the event's point, and `jumps`
 *   chain jumps from it, each shocking its enemy (ChainBoltSpec).
 */
export type EffectSpec =
  | {
      readonly kind: 'applyAilment';
      readonly ailment: AppliedAilment;
      readonly stacks?: number;
      readonly damagePct?: number;
      readonly radius?: number;
      readonly maxTargets?: number;
      readonly order?: TargetOrder;
    }
  | {
      readonly kind: 'spreadAilment';
      readonly ailment: 'burn';
      readonly radius: number;
      readonly effect?: number;
    }
  | {
      readonly kind: 'spreadAilment';
      readonly ailment: 'poison';
      readonly radius: number;
      readonly effect?: number;
      readonly stacks?: number;
      readonly maxTargets?: number;
      readonly order?: TargetOrder;
      readonly toSplitChildren?: number;
    }
  | ExplodeSpec
  | NovaSpec
  | { readonly kind: 'push'; readonly distance: number; readonly radius: number }
  | {
      readonly kind: 'addFrost';
      readonly amount: number;
      readonly radius?: number;
      readonly maxTargets?: number;
      readonly order?: TargetOrder;
    }
  | { readonly kind: 'heal'; readonly lifePct: number }
  | { readonly kind: 'shield'; readonly lifePct: number; readonly capPct?: number }
  | { readonly kind: 'gainShards'; readonly fraction: number }
  | GroundZoneSpec
  | RepeatAttackSpec
  | DetonateSpec
  | ProjectilesSpec
  | SlashLineSpec
  | CoinHitSpec
  | ChainBoltSpec;
export type EffectKind = EffectSpec['kind'];

/**
 * Effects that move ailments already dealt instead of dealing damage. A kill trigger made only
 * of them runs at the kill (see WIRED_EVENTS); validation keeps them apart from other effects.
 */
export const TRANSFER_EFFECTS: ReadonlySet<EffectKind> = new Set<EffectKind>(['spreadAilment']);

/**
 * The fields of each effect that a calibration coefficient multiplies: damage only, never an
 * amount, radius, stack count, distance or fraction. A field left out counts as its default, 1.
 */
export const COEF_FIELDS: {
  readonly [K in EffectKind]: readonly (keyof Extract<EffectSpec, { kind: K }> & string)[];
} = {
  applyAilment: ['damagePct'],
  spreadAilment: ['effect'],
  explode: ['damagePct'],
  nova: ['damagePct'],
  push: [],
  addFrost: [],
  heal: [],
  shield: [],
  gainShards: [],
  groundZone: ['damagePctPerSec', 'ailmentDamagePct'],
  // A share of the signature attack, whose damage the calibration does not scale.
  repeatAttack: [],
  detonate: ['damage'],
  projectiles: ['damagePct'],
  slashLine: ['damagePct'],
  coinHit: ['multiplier'],
  chainBolt: ['damagePct'],
};

/**
 * The bounds of a fusion's coefficient (docs/v3 C6 design D10; implementation-plan-v3 §4's
 * 二分法範圍 0.1–10): calibration searches inside them, and a fusion's coefRange
 * (src/data/fusion/sensitivity.ts) never leaves them.
 */
export const COEF_MIN = 0.1;
export const COEF_MAX = 10;

/** When `on` happens and every `when` condition holds, run each effect of `do` in order. */
export interface TriggerSpec {
  readonly on: TriggerEventId;
  /**
   * nthAttack: fire on every Nth attack (a whole number ≥ 1). periodic: the period in seconds.
   * ailmentTick: the interval in seconds, a multiple of 0.25 (default 0.25, every step). No
   * other event takes it.
   */
  readonly every?: number;
  readonly when?: readonly Condition[];
  /**
   * The enemy its effects act on instead of the event's, picked once per firing: after its
   * conditions, which still read the event's enemy, and before its chance roll. When nothing is
   * picked it does not fire, rolls nothing and its cooldown does not restart. Not on waveStart,
   * nor on a kill trigger that runs at the kill (its transfers always act on the victim).
   */
  readonly target?: TargetSelector;
  readonly do: readonly EffectSpec[];
}

/** What a conversion turns part of a hit into: a damage-over-time kind or an element. */
export const CONVERSION_TARGETS = ['burn', 'poison', 'bleed', 'cold', 'lightning'] as const;
export type ConversionTarget = (typeof CONVERSION_TARGETS)[number];

/**
 * A damage conversion (docs/v3/implementation-plan-v3.md §2.7): `fraction` of every hit that
 * carries all of `tags` (every hit without them) becomes `to`, before modifiers. The converted
 * part keeps the hit's delivery tags, crit and source; a damage-over-time kind replaces the hit's
 * kind and element, an element only its element (convertMask, src/data/tags.ts). It is part of
 * the hit, dealt at once: it applies no ailment. Only hits convert. A node's conversions add up
 * to at most 1; when a hit's conversions add up to more, each takes its share of the whole hit.
 */
export interface ConversionSpec {
  readonly tags?: readonly DamageTag[];
  readonly to: ConversionTarget;
  readonly fraction: number;
}
