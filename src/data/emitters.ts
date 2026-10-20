/**
 * Emitter grants (docs/v3/implementation-plan-v3.md §2.15): emitters a talent node adds to the
 * run beside the signature attack. A node grants each of its emitters once, whatever its rank
 * (src/meta/stats.ts collectExtras), credited to the node's source; compileBuild
 * (src/sim/build/compile.ts) puts them after the signature, in data order, and keeps the first
 * grant of each kind, source and key (grantKey). Their schemas are in src/data/schema.ts
 * (GRANT_SCHEMAS), their checks in src/data/validate.ts.
 */

import type { TargetSelector } from './triggers';

/**
 * Thorns: each enemy that touches the player takes a thorns hit first, and one it kills does not
 * reach the player (src/sim/systems/contact.ts). The hit is tagged hit and thorns, can crit and
 * rolls ailments.
 */
export interface ThornsGrant {
  readonly kind: 'thorns';
  /** Base damage of its hit as a fraction of the damage stat; THORNS_DAMAGE_PCT when omitted. */
  readonly damagePct?: number;
}

/**
 * A segment (雷網): every periodSec, each endpoint links to its `links` nearest other endpoints
 * within `range`, and every enemy on a link takes one hit and shockStacks shock stacks
 * (src/sim/systems/segments.ts). The hit is tagged hit, lightning and area, can crit and rolls
 * no ailments.
 */
export interface SegmentGrant {
  readonly kind: 'segment';
  /**
   * What the links join: the alive shocked enemies. Drones and summons come with them in C5,
   * and validation rejects them until then.
   */
  readonly endpoints: 'shocked';
  /** Links each endpoint makes: 1 or 2; SEGMENT_DEFAULTS.links when omitted. */
  readonly links?: number;
  /** Longest link; SEGMENT_DEFAULTS.range when omitted. */
  readonly range?: number;
  /** Base damage of its hit as a fraction of the damage stat; SEGMENT_DEFAULTS.damagePct. */
  readonly damagePct?: number;
  /** Shock stacks each enemy it hits takes after the hit; SEGMENT_DEFAULTS.shockStacks. */
  readonly shockStacks?: number;
  /** Seconds between its judgements; SEGMENT_DEFAULTS.periodSec when omitted. */
  readonly periodSec?: number;
}

/**
 * A strike (落雷, 雷鳴): every periodSec, whatever the attack speed, it picks an enemy by its
 * target selector, measured from the player as a periodic trigger's is, and hits it; enemies
 * within `radius` of it take the same hit, and with chainJumps the strike chains on from it that
 * many jumps (src/sim/emitters/strike.ts). The target and each jump take shockStacks shock
 * stacks after their hit. The hits are tagged hit, strike and area plus the element, can crit
 * and roll ailments.
 */
export interface StrikeGrant {
  readonly kind: 'strike';
  /** What tells two strikes of one source apart (grantKey). */
  readonly name: string;
  /** Seconds between its strikes, at least one tick. */
  readonly periodSec: number;
  /** The enemy it strikes; never 'player', which has no enemy to strike. */
  readonly target: TargetSelector;
  /** Base damage of its hits as a fraction of the damage stat. */
  readonly damagePct: number;
  /** Radius of its area around the target; STRIKE_DEFAULTS.radius (0, the target only). */
  readonly radius?: number;
  /** The element its hits carry. */
  readonly element?: 'cold' | 'lightning';
  /** Jumps of its chain from the target, an integer in [0, 8]; STRIKE_DEFAULTS.chainJumps. */
  readonly chainJumps?: number;
  /** Shock stacks the target and each jump take after their hit; STRIKE_DEFAULTS.shockStacks. */
  readonly shockStacks?: number;
}

/**
 * Drones (無人機) and turrets (砲台): `drones` drones that dock around the player and fly out at
 * the alive enemy farthest from the player inside the arena that no other drone chases, each
 * picking at most once every 0.5 s, and impact it: a hit on every enemy within
 * DRONE_DEFAULTS.splash of it, the target among them. A drone stays on a living target, impacting
 * it again once its same-enemy cooldown ends, and flies home to dock after DRONE_DEFAULTS.impacts
 * impacts (src/sim/systems/drones.ts). Its `turrets` turrets sit in seats around the player
 * between the drones and fire DRONE_DEFAULTS.turretRate times a second at the base attack speed:
 * the character's projectileCount of homing shots, at the enemy nearest to the turret (elites and
 * bosses near the player first) and the next nearest ones, each hitting its enemy on arrival. The
 * impacts' hits are tagged hit, minion and area, the shots' hit, minion and projectile; both can
 * crit and roll ailments. Each drone and turret is a summon: a run places at most SUMMON_CAP of
 * them (src/sim/caps.ts).
 */
export interface DroneGrant {
  readonly kind: 'drone';
  /**
   * Drones it places, a whole number; 0 when omitted. Validation holds drones + turrets to
   * [1, 24].
   */
  readonly drones?: number;
  /** Turrets it places, a whole number; 0 when omitted. */
  readonly turrets?: number;
  /**
   * Base damage of its impacts' hits as a fraction of the damage stat;
   * DRONE_DEFAULTS.damagePct when omitted.
   */
  readonly damagePct?: number;
  /**
   * Base damage of its turrets' shots as a fraction of the damage stat;
   * DRONE_DEFAULTS.turretDamagePct when omitted.
   */
  readonly turretDamagePct?: number;
  /** What tells two drone grants of one source apart (grantKey); '' when omitted. */
  readonly name?: string;
}

export type EmitterGrant = ThornsGrant | SegmentGrant | StrikeGrant | DroneGrant;
export type GrantKind = EmitterGrant['kind'];

/** A thorns hit's base damage when its grant names none: 300% of the damage stat. */
export const THORNS_DAMAGE_PCT = 3;

/** A segment grant's fields when it omits them. */
export const SEGMENT_DEFAULTS = {
  links: 2,
  range: 200,
  damagePct: 0.1,
  shockStacks: 1,
  periodSec: 0.25,
} as const;

/** A strike grant's fields when it omits them: no area, no chain, no shock. */
export const STRIKE_DEFAULTS = {
  radius: 0,
  chainJumps: 0,
  shockStacks: 0,
} as const;

/**
 * A drone grant's numbers (初始值): its impacts' share of the damage stat when it names none, and
 * its turrets' shots' share when it names none; a drone's speed (units a second), dock time and
 * same-enemy cooldown (seconds) at the base attack frequency, its impacts a sortie, its impacts'
 * splash radius and its dock's radius around the player; a turret's seat's radius around the
 * player and its firings a second at the base attack speed.
 */
export const DRONE_DEFAULTS = {
  damagePct: 0.8,
  turretDamagePct: 0.4,
  speed: 600,
  dockSec: 0.5,
  cooldownSec: 0.5,
  impacts: 3,
  splash: 40,
  dockRadius: 43,
  turretRadius: 90,
  turretRate: 2,
} as const;

/** An emitter grant of an allocated node, with the source of its node (sourceOfNode). */
export interface SourcedEmitter {
  /** Source id (src/data/sources.ts) its damage is credited to. */
  readonly source: string;
  readonly grant: EmitterGrant;
}

/**
 * What tells two grants of one kind and source apart: grants that share it are one emitter, and
 * the build keeps the first. A source has one thorns emitter, so thorns has no key; it has one
 * segment emitter per kind of endpoint, one strike per name, and one drone emitter per name (''
 * for a grant without one).
 */
export function grantKey(grant: EmitterGrant): string {
  switch (grant.kind) {
    case 'thorns':
      return '';
    case 'segment':
      return grant.endpoints;
    case 'strike':
      return grant.name;
    case 'drone':
      return grant.name ?? '';
  }
}
