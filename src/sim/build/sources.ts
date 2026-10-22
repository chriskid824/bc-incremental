/**
 * Damage sources of one run (docs/v3/implementation-plan-v3.md §2.1): the source table that
 * numbers the run's source ids, and the attribution policy that credits ailment damage and the
 * center's chain jumps.
 *
 * Every damage instance carries a source index next to its tags. ModTable keys put it above the
 * 17 tag bits (rowKey), so a modifier scoped to a source (Modifier.scope) reaches only the rows
 * of the sources it selects. Index 0 is always 'center'.
 */

import { AILMENT_OUTER, isSourceSelector, SOURCE_CLASSES, sourceClass } from '../../data/sources';
import type { CharacterId, SourceClass, SourceSelector } from '../../data/sources';
import { DAMAGE_TAGS } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import { AILMENT_KINDS } from '../../data/triggers';
import type { AilmentKind } from '../../data/triggers';

/** Sources one run can number: 6 bits above the tags in a ModTable key. */
export const MAX_SOURCES = 64;
/** A ModTable key holds the tags below this bit and the source index from it up. */
export const SOURCE_SHIFT = DAMAGE_TAGS.length;
/** Source index of the center, the character's own board (every M1 node). */
export const CENTER = 0;

/** ModTable key of an instance with these tags credited to `source`. */
export const rowKey = (tags: TagMask, source: number): number => tags | (source << SOURCE_SHIFT);

/** Ordinal of each source class, as SourceTable.cls stores it. */
export const SOURCE_CLASS_ORDINAL: Readonly<Record<SourceClass, number>> = Object.fromEntries(
  SOURCE_CLASSES.map((cls, i) => [cls, i]),
) as Record<SourceClass, number>;

const FUSION = SOURCE_CLASS_ORDINAL.fusion;

export interface SourceTable {
  /** Source ids by index, in the order they were first used. */
  readonly names: readonly string[];
  /** SOURCE_CLASS_ORDINAL of each source, by index. */
  readonly cls: Uint8Array;
  /** Index of `name`, numbering it on first use. Throws past MAX_SOURCES or on a bad id. */
  index(name: string): number;
  /** The selector picks source `ix`: its class, or its exact id. */
  matches(sel: SourceSelector, ix: number): boolean;
  /**
   * matches(sel, ix) for every index, as one byte per index. The table keeps the array up to
   * date when it numbers a source later, and returns the same array for the same selector.
   */
  scopeMask(sel: SourceSelector): Uint8Array;
}

/** A table with only 'center', at index 0. */
export function createSourceTable(): SourceTable {
  const names: string[] = [];
  const cls = new Uint8Array(MAX_SOURCES);
  const masks = new Map<SourceSelector, Uint8Array>();

  const matches = (sel: SourceSelector, ix: number): boolean => {
    const name = names[ix];
    if (name === undefined) return false;
    const selected = (SOURCE_CLASSES as readonly string[]).indexOf(sel);
    return selected < 0 ? name === sel : cls[ix] === selected;
  };

  const index = (name: string): number => {
    const at = names.indexOf(name);
    if (at >= 0) return at;
    const sourceCls = sourceClass(name);
    if (sourceCls === null) throw new Error(`Not a source id: '${name}'`);
    if (names.length === MAX_SOURCES) {
      throw new RangeError(`More than ${MAX_SOURCES} damage sources in one run`);
    }
    const ix = names.length;
    names.push(name);
    cls[ix] = SOURCE_CLASS_ORDINAL[sourceCls];
    for (const [sel, mask] of masks) mask[ix] = matches(sel, ix) ? 1 : 0;
    return ix;
  };

  const scopeMask = (sel: SourceSelector): Uint8Array => {
    let mask = masks.get(sel);
    if (mask === undefined) {
      if (!isSourceSelector(sel)) throw new Error(`Not a source selector: '${sel}'`);
      mask = new Uint8Array(MAX_SOURCES);
      for (let ix = 0; ix < names.length; ix++) mask[ix] = matches(sel, ix) ? 1 : 0;
      masks.set(sel, mask);
    }
    return mask;
  };

  index('center');
  return { names, cls, index, matches, scopeMask };
}

/** Position of each ailment kind in AILMENT_KINDS: its bit in centerAilments. */
export const AILMENT_ORDINAL: Readonly<Record<AilmentKind, number>> = Object.fromEntries(
  AILMENT_KINDS.map((kind, i) => [kind, i]),
) as Record<AilmentKind, number>;

/**
 * Who ailment damage and the center's chain jumps are credited to (implementation-plan-v3 §2.1;
 * docs/v3 C6 design D8).
 */
export interface AttributionPolicy {
  /** Bit AILMENT_ORDINAL[kind] is set for the kinds of the character's own archetype. */
  readonly centerAilments: number;
  /** Per AILMENT_ORDINAL: index of the kind's outer board, or -1 until first credited. */
  readonly outerSource: Int32Array;
  /**
   * Source index of the center payloads' chain jumps: 'outer.lightning' on a fire, ice or summon
   * run; −1 keeps them at the center (M1, lightning).
   */
  readonly jumpSource: number;
}

/** M1 has no characters: every ailment is the center's own. */
export const M1_CENTER_AILMENTS: readonly AilmentKind[] = AILMENT_KINDS;

/**
 * A policy crediting `centerAilments`, the character's own kinds, to the center, and the
 * center's chain jumps to source `jumpSource` (−1, the default: to the center).
 */
export function createAttribution(
  centerAilments: readonly AilmentKind[],
  jumpSource = -1,
): AttributionPolicy {
  let bits = 0;
  for (const kind of centerAilments) bits |= 1 << AILMENT_ORDINAL[kind];
  return {
    centerAilments: bits,
    outerSource: new Int32Array(AILMENT_KINDS.length).fill(-1),
    jumpSource,
  };
}

/**
 * Source credited with the chain jumps of a payload of source `source` (Payload.jumpSource): the
 * policy's jumpSource for a center payload when it has one, else `source` itself.
 */
export const jumpCredit = (policy: AttributionPolicy, source: number): number =>
  source === CENTER && policy.jumpSource >= 0 ? policy.jumpSource : source;

/**
 * The ailment kinds of the character's own archetype, which a character run credits to the
 * center: fire [burn], ice [frost], lightning [shock], summon [].
 */
export const ownAilments = (character: CharacterId): AilmentKind[] =>
  AILMENT_KINDS.filter((kind) => AILMENT_OUTER[kind] === character);

/**
 * Source credited with the damage of a `kind` ailment applied by an instance of source
 * `applier`: (1) a fusion applier keeps it; (2) a kind of the character's own archetype goes to
 * the center; (3) any other kind goes to its outer board (AILMENT_OUTER), numbered on first use.
 */
export function ailmentCredit(
  sources: SourceTable,
  policy: AttributionPolicy,
  kind: AilmentKind,
  applier: number,
): number {
  if (sources.cls[applier] === FUSION) return applier;
  const k = AILMENT_ORDINAL[kind];
  if ((policy.centerAilments & (1 << k)) !== 0) return CENTER;
  let ix = policy.outerSource[k] as number;
  if (ix < 0) {
    ix = sources.index(`outer.${AILMENT_OUTER[kind]}`);
    policy.outerSource[k] = ix;
  }
  return ix;
}
