/**
 * Damage sources (docs/v3/implementation-plan-v3.md §2.1): the board of the talent web a damage
 * instance is credited to, stored apart from its tags. Crit, damage modifiers and the like never
 * change an instance's source.
 *
 * Source ids sit at board granularity: 'center', 'hub', 'asc', 'outer.<OuterId>' and
 * 'fusion.<CharacterId>.<OuterId>'. Every M1 node belongs to the center.
 */

import type { DamageTag } from './tags';
import type { AilmentKind } from './triggers';

/** The 12 archetypes; each has an outer board that every character shares. */
export const OUTER_IDS = [
  'fire',
  'poison',
  'bleed',
  'lightning',
  'combo',
  'crit',
  'ice',
  'aura',
  'thorns',
  'summon',
  'barrage',
  'greed',
] as const;
export type OuterId = (typeof OUTER_IDS)[number];

/** A character's id is its own archetype's outer id (implementation-plan-v3 §2.13). */
export const CHARACTER_IDS = [
  'fire',
  'ice',
  'lightning',
  'summon',
] as const satisfies readonly OuterId[];
export type CharacterId = (typeof CHARACTER_IDS)[number];

/** Source classes; a class's position here is its ordinal in the simulation's source table. */
export const SOURCE_CLASSES = ['center', 'outer', 'fusion', 'hub', 'asc'] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

/**
 * Which sources a scoped modifier applies to (Modifier.scope): a class name, which matches
 * every source of that class, or an exact source id.
 */
export type SourceSelector = SourceClass | `outer.${OuterId}` | `fusion.${string}`;

const isOuterId = (id: string | undefined): id is OuterId =>
  (OUTER_IDS as readonly (string | undefined)[]).includes(id);

const isCharacterId = (id: string | undefined): id is CharacterId =>
  (CHARACTER_IDS as readonly (string | undefined)[]).includes(id);

/** Class of a source id, or null when `id` is not a source id. */
export function sourceClass(id: string): SourceClass | null {
  if (id === 'center' || id === 'hub' || id === 'asc') return id;
  const [head, first, second, ...rest] = id.split('.');
  if (head === 'outer' && isOuterId(first) && second === undefined) return 'outer';
  if (head === 'fusion' && isCharacterId(first) && isOuterId(second) && rest.length === 0) {
    return 'fusion';
  }
  return null;
}

export const isSourceSelector = (value: string): value is SourceSelector =>
  (SOURCE_CLASSES as readonly string[]).includes(value) || sourceClass(value) !== null;

/**
 * Source of a talent node, from its id (implementation-plan-v3 §3):
 * 'fusion.<c>.<o>.*' → 'fusion.<c>.<o>', 'outer.<o>.*' → 'outer.<o>', 'hub.*' → 'hub',
 * '<c>.asc.*' → 'asc', anything else ('<c>.center.*' and every M1 id) → 'center'.
 */
export function sourceOfNode(nodeId: string): string {
  const [head, first, second, ...rest] = nodeId.split('.');
  if (head === 'fusion' && isCharacterId(first) && isOuterId(second) && rest.length > 0) {
    return `fusion.${first}.${second}`;
  }
  if (head === 'outer' && isOuterId(first) && second !== undefined) return `outer.${first}`;
  if (head === 'hub' && first !== undefined) return 'hub';
  if (isCharacterId(head) && first === 'asc' && second !== undefined) return 'asc';
  return 'center';
}

/**
 * Outer board credited with an ailment kind that is not the character's own archetype's
 * (implementation-plan-v3 §2.1): poison on the fire character counts as 'outer.poison'.
 */
export const AILMENT_OUTER: Readonly<Record<AilmentKind, OuterId>> = {
  burn: 'fire',
  poison: 'poison',
  bleed: 'bleed',
  shock: 'lightning',
  frost: 'ice',
};

/**
 * The tag each archetype's damage carries. A board's ★ damage modifier must carry it (or scope
 * itself to 'outer.<board>'); combo, barrage and greed have no tag of their own and must scope.
 */
export const ARCHETYPE_TAGS: Readonly<Partial<Record<OuterId, readonly DamageTag[]>>> = {
  fire: ['burn'],
  poison: ['poison'],
  bleed: ['bleed'],
  lightning: ['chain'],
  crit: ['crit'],
  ice: ['cold'],
  aura: ['aura'],
  thorns: ['thorns'],
  summon: ['minion'],
};
