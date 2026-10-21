/**
 * The v3 web's node ids (docs/v3 C6 design D4; implementation-plan-v3 §3 「穩定 ID」). A node is
 * named by its board, its branch or group and its slot, or by a slug for a ◆ or ★; never by an
 * array index. Names live in i18n, so ids stay English.
 *
 *   center      <c>.center.<branch>.<name>   on a branch r1–r6, mastery or a ◆ slug; on main
 *                                            signature, threshold, c1–c6 or a ★ slug
 *   hub         hub.<group>.<name>           hub.might.might; r1–r5 or a ◆ slug in defense,
 *                                            economy and echo; a ★ slug in rules
 *   outer       outer.<o>.<branch>.<name>    on a branch r1–r4, mastery or a ◆ slug; on main
 *                                            entry, threshold or the answer ◆'s or ★'s slug
 *   fusion      fusion.<c>.<o>.<slot>        core, r1, r2, r3, mastery; <o> is not <c>'s own
 *   ascendancy  <c>.asc.<slug>.<slot>        n1, n2, final
 *
 * Every id this grammar accepts has sourceOfNode(id) (src/data/sources.ts) equal to its board's
 * source, so a typo can no longer fall through to 'center'.
 */

import { CHARACTER_IDS, OUTER_IDS } from '../sources';
import type { CharacterId, OuterId } from '../sources';
import type { BoardId } from './types';

/** The pseudo-branch of a center's or an outer's nodes outside its branches. */
export const MAIN_BRANCH = 'main';

/** The hub's groups (gd:262-268): 強化∞ alone in might, the hub's ★ in rules. */
export const HUB_GROUPS = ['might', 'defense', 'economy', 'echo', 'rules'] as const;
export type HubGroupId = (typeof HUB_GROUPS)[number];

/** A fusion board's slots: its core, the three ranked nodes and the mastery. */
export const FUSION_SLOTS = ['core', 'r1', 'r2', 'r3', 'mastery'] as const;
export type FusionSlot = (typeof FUSION_SLOTS)[number];

/** An ascendancy's slots: its two ◆ and its final. */
export const ASC_SLOTS = ['n1', 'n2', 'final'] as const;
export type AscSlot = (typeof ASC_SLOTS)[number];

/** Words no slug may be; the numbered slot names r<n>, c<n> and n<n> are reserved as a pattern. */
export const RESERVED_SLUGS: readonly string[] = [
  'main',
  'signature',
  'threshold',
  'entry',
  'mastery',
  'core',
  'final',
  'might',
];

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const NUMBERED_SLOT = /^[rcn]\d+$/;

const CENTER_BRANCH_SLOTS: readonly string[] = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'mastery'];
const CENTER_MAIN_SLOTS: readonly string[] = [
  'signature',
  'threshold',
  'c1',
  'c2',
  'c3',
  'c4',
  'c5',
  'c6',
];
const OUTER_BRANCH_SLOTS: readonly string[] = ['r1', 'r2', 'r3', 'r4', 'mastery'];
const OUTER_MAIN_SLOTS: readonly string[] = ['entry', 'threshold'];
const HUB_RANKED_SLOTS: readonly string[] = ['r1', 'r2', 'r3', 'r4', 'r5'];

const isCharacterId = (id: string): id is CharacterId =>
  (CHARACTER_IDS as readonly string[]).includes(id);
const isOuterId = (id: string): id is OuterId => (OUTER_IDS as readonly string[]).includes(id);
const isHubGroup = (group: string): group is HubGroupId =>
  (HUB_GROUPS as readonly string[]).includes(group);
const isFusionSlot = (slot: string): slot is FusionSlot =>
  (FUSION_SLOTS as readonly string[]).includes(slot);
const isAscSlot = (slot: string): slot is AscSlot =>
  (ASC_SLOTS as readonly string[]).includes(slot);

/**
 * True when `name` is a slug: kebab-case English, and neither a reserved word nor a numbered slot
 * name. A slug starts with a letter, so it is never all digits.
 */
export function isSlug(name: string): boolean {
  return KEBAB_CASE.test(name) && !RESERVED_SLUGS.includes(name) && !NUMBERED_SLOT.test(name);
}

/** A node id taken apart by parseNodeId; `name` is a slot name or a slug. */
export type ParsedNodeId =
  | {
      readonly block: 'center';
      readonly board: BoardId;
      readonly character: CharacterId;
      readonly branch: string;
      readonly name: string;
    }
  | {
      readonly block: 'hub';
      readonly board: BoardId;
      readonly group: HubGroupId;
      readonly name: string;
    }
  | {
      readonly block: 'outer';
      readonly board: BoardId;
      readonly outer: OuterId;
      readonly branch: string;
      readonly name: string;
    }
  | {
      readonly block: 'fusion';
      readonly board: BoardId;
      readonly character: CharacterId;
      readonly outer: OuterId;
      readonly slot: FusionSlot;
    }
  | {
      readonly block: 'asc';
      readonly board: BoardId;
      readonly character: CharacterId;
      readonly slug: string;
      readonly slot: AscSlot;
    };

/** A node's name on a branch of a center or an outer: one of its slots, or a slug. */
function branchName(
  branch: string,
  name: string,
  mainSlots: readonly string[],
  branchSlots: readonly string[],
): boolean {
  if (branch === MAIN_BRANCH) return mainSlots.includes(name) || isSlug(name);
  return isSlug(branch) && (branchSlots.includes(name) || isSlug(name));
}

function hubName(group: HubGroupId, name: string): boolean {
  if (group === 'might') return name === 'might';
  if (group === 'rules') return isSlug(name);
  return HUB_RANKED_SLOTS.includes(name) || isSlug(name);
}

/** The parts of a node id, or null when the id is not in the grammar. */
export function parseNodeId(id: string): ParsedNodeId | null {
  const parts = id.split('.');
  if (parts.length === 3 && parts[0] === 'hub') {
    const [, group, name] = parts as [string, string, string];
    return isHubGroup(group) && hubName(group, name)
      ? { block: 'hub', board: 'hub', group, name }
      : null;
  }
  if (parts.length !== 4) return null;
  const [head, second, third, last] = parts as [string, string, string, string];
  if (head === 'outer') {
    return isOuterId(second) && branchName(third, last, OUTER_MAIN_SLOTS, OUTER_BRANCH_SLOTS)
      ? { block: 'outer', board: `outer.${second}`, outer: second, branch: third, name: last }
      : null;
  }
  if (head === 'fusion') {
    return isCharacterId(second) && isOuterId(third) && third !== second && isFusionSlot(last)
      ? {
          block: 'fusion',
          board: `fusion.${second}.${third}`,
          character: second,
          outer: third,
          slot: last,
        }
      : null;
  }
  if (!isCharacterId(head)) return null;
  if (second === 'center') {
    return branchName(third, last, CENTER_MAIN_SLOTS, CENTER_BRANCH_SLOTS)
      ? { block: 'center', board: `${head}.center`, character: head, branch: third, name: last }
      : null;
  }
  if (second === 'asc') {
    return isSlug(third) && isAscSlot(last)
      ? { block: 'asc', board: `${head}.asc.${third}`, character: head, slug: third, slot: last }
      : null;
  }
  return null;
}

/** The board a node id belongs to, or null when the id is not in the grammar. */
export function boardIdOf(id: string): BoardId | null {
  return parseNodeId(id)?.board ?? null;
}

/**
 * The source a board's nodes are credited to (src/data/sources.ts): 'center', 'hub', the outer
 * or the fusion itself, or 'asc'.
 */
export function sourceOfBoard(board: BoardId): string {
  if (board === 'hub' || board.startsWith('outer.') || board.startsWith('fusion.')) return board;
  return board.split('.')[1] === 'center' ? 'center' : 'asc';
}

/**
 * The id of a node: its board, then the branch or group and the name on a center, an outer or
 * the hub, or the slot on a fusion or an ascendancy. It only joins and never throws, as the
 * builders never do; parseNodeId tells whether the result is in the grammar.
 */
export function nodeId(
  board: `${CharacterId}.center` | `outer.${OuterId}` | 'hub',
  branch: string,
  name: string,
): string;
export function nodeId(
  board: `fusion.${CharacterId}.${OuterId}` | `${CharacterId}.asc.${string}`,
  slot: string,
): string;
export function nodeId(board: BoardId, ...names: readonly string[]): string {
  return [board, ...names].join('.');
}

/**
 * Optimal string alignment distance: the fewest insertions, deletions, substitutions and swaps of
 * two adjacent letters from a to b, no letter edited twice ('cirt' is 1 from 'crit').
 */
function editDistance(a: string, b: string): number {
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      let distance = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        substitution,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        distance = Math.min(distance, (beforePrevious[j - 2] as number) + 1);
      }
      current.push(distance);
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length] as number;
}

/**
 * The candidate nearest to `name` by edit distance (a swap of two adjacent letters is one edit),
 * when it is within `maxDistance` (the messages' 「did you mean」, docs/v3 C6 design D23); the
 * first in order on a tie; null when none is that near.
 */
export function nearestName(
  name: string,
  candidates: Iterable<string>,
  maxDistance = 2,
): string | null {
  let nearest: string | null = null;
  let bound = maxDistance + 1;
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - name.length) >= bound) continue;
    const distance = editDistance(name, candidate);
    if (distance < bound) {
      nearest = candidate;
      bound = distance;
    }
  }
  return nearest;
}
