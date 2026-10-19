/**
 * Emitter grants (docs/v3/implementation-plan-v3.md §2.15): emitters a talent node adds to the
 * run beside the signature attack. A node grants each of its emitters once, whatever its rank
 * (src/meta/stats.ts collectExtras), credited to the node's source; compileBuild
 * (src/sim/build/compile.ts) puts them after the signature, in data order, and keeps the first
 * grant of each kind, source and key (grantKey). Their schemas are in src/data/schema.ts
 * (GRANT_SCHEMAS), their checks in src/data/validate.ts.
 */

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

export type EmitterGrant = ThornsGrant | SegmentGrant;
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

/** An emitter grant of an allocated node, with the source of its node (sourceOfNode). */
export interface SourcedEmitter {
  /** Source id (src/data/sources.ts) its damage is credited to. */
  readonly source: string;
  readonly grant: EmitterGrant;
}

/**
 * What tells two grants of one kind and source apart: grants that share it are one emitter, and
 * the build keeps the first. A source has one thorns emitter, so thorns has no key; it has one
 * segment emitter per kind of endpoint.
 */
export function grantKey(grant: EmitterGrant): string {
  switch (grant.kind) {
    case 'thorns':
      return '';
    case 'segment':
      return grant.endpoints;
  }
}
