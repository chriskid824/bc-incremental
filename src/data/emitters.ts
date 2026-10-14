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

export type EmitterGrant = ThornsGrant;
export type GrantKind = EmitterGrant['kind'];

/** A thorns hit's base damage when its grant names none: 300% of the damage stat. */
export const THORNS_DAMAGE_PCT = 3;

/** An emitter grant of an allocated node, with the source of its node (sourceOfNode). */
export interface SourcedEmitter {
  /** Source id (src/data/sources.ts) its damage is credited to. */
  readonly source: string;
  readonly grant: EmitterGrant;
}

/**
 * What tells two grants of one kind and source apart: grants that share it are one emitter, and
 * the build keeps the first. A source has one thorns emitter, so thorns has no key.
 */
export function grantKey(grant: EmitterGrant): string {
  switch (grant.kind) {
    case 'thorns':
      return '';
  }
}
