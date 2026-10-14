/**
 * ModTable: the value of every scoped stat (SCOPED_STATS) for one damage-instance key, built
 * from the build's scoped modifiers on first use of the key and cached for the run
 * (docs/v3/implementation-plan-v3.md §2.1). A key is the instance's tag mask with its source
 * index above the tags (rowKey in src/sim/build/sources.ts); 17 tags make 131,072 masks per
 * source, too many to fold up front as M1's damageMult did. Rows are structure of arrays:
 * scoped stat s of row r sits at index r × S + s (s = SCOPED_INDEX[stat]).
 *
 * Every scoped stat folds (base + Σflat) × (1 + Σincreased) × Π(1 + more) over the modifiers
 * that match the key (all of their tags present, none of their notTags, the source in their
 * scope), in a fixed order:
 * - flat: base + (Σ untagged flats in data order), then += each matching tagged flat in data
 *   order;
 * - increased: Σ of every matching modifier in data order, tagged and untagged interleaved;
 * - more: Π(1 + value) in the same order.
 * A damage row holds only (1 + Σincreased) × Π(1 + more): flat damage stays in
 * StatBlock.values.damage, so damage of an instance = values.damage × its damage row, which is
 * M1's damageMult[mask] bit for bit. Any other scoped stat folds to its final value, then takes
 * the rules' post-operations, × postScale + postOffset (scaleStat and offsetStat, src/sim/rules/);
 * with no tagged, scoped or scaling modifier that is CompiledBuild.values[stat] bit for bit.
 *
 * Modifiers with a scaling or conditions (Modifier.when) are dynamic entries: a row lists the
 * matching ones per stat in data order, and statAt (src/sim/build/eval.ts) adds those whose
 * conditions hold per damage instance, after the static parts.
 */

import { SCOPED_STATS } from '../../data/stats';
import type { Modifier, ModifierKind, ScopedStat, StatBlock } from '../../data/stats';
import { tagMask } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import { compileCondition, compileScaling, statAt, staticInput } from './eval';
import type { CompiledCondition, CompiledScaling } from './eval';
import { createSourceTable, SOURCE_SHIFT } from './sources';
import type { SourceTable } from './sources';

/** Values per row: one per scoped stat. */
const S = SCOPED_STATS.length;

/** Position of each scoped stat in a row: its SCOPED_STATS index. */
export const SCOPED_INDEX = Object.fromEntries(
  SCOPED_STATS.map((stat, index) => [stat, index]),
) as Readonly<Record<ScopedStat, number>>;

/** Position of damage in a row. */
const DAMAGE = SCOPED_INDEX.damage;

const FLAT = 0;
const INCREASED = 1;
const MORE = 2;
const KIND_CODE: Readonly<Record<ModifierKind, CompiledMod['kind']>> = {
  flat: FLAT,
  increased: INCREASED,
  more: MORE,
};

/** A scoped modifier compiled for row building. */
export interface CompiledMod {
  /** Position of the stat in a row (its SCOPED_STATS index). */
  readonly stat: number;
  /** 0 flat, 1 increased, 2 more. */
  readonly kind: 0 | 1 | 2;
  readonly value: number;
  /** Tags a key must all carry. */
  readonly all: TagMask;
  /** Tags a key must not carry. */
  readonly none: TagMask;
  /** Per source index, 1 when the modifier's scope selects it; null without a scope. */
  readonly scopeOk: Uint8Array | null;
  /** No tags, notTags or scope: an untagged flat is summed before the tagged ones. */
  readonly untagged: boolean;
  /** The modifier's scaling: a dynamic entry, evaluated per damage instance. */
  readonly scale: CompiledScaling | null;
  /** The modifier's conditions (Modifier.when): a dynamic entry, applied where they all hold. */
  readonly cond: readonly CompiledCondition[] | null;
}

/** Evaluated per damage instance rather than folded into the rows. */
const isDynamic = (mod: CompiledMod): boolean => mod.scale !== null || mod.cond !== null;

/** A read of a row outside any damage instance: a primary hit without a target. */
const ESTIMATE = staticInput();

/**
 * Compiles StatBlock.scoped, keeping data order; scopes resolve against `sources`, which keeps
 * them current as it numbers more sources. Throws on a stat that is not scoped.
 */
export function compileMods(scoped: readonly Modifier[], sources: SourceTable): CompiledMod[] {
  return scoped.map((mod) => {
    const stat = (SCOPED_STATS as readonly string[]).indexOf(mod.stat);
    if (stat < 0) throw new Error(`Not a scoped stat: ${JSON.stringify(mod)}`);
    const all = tagMask(mod.tags ?? []);
    const none = tagMask(mod.notTags ?? []);
    const scopeOk = mod.scope === undefined ? null : sources.scopeMask(mod.scope);
    return {
      stat,
      kind: KIND_CODE[mod.kind],
      value: mod.value,
      all,
      none,
      scopeOk,
      untagged: all === 0 && none === 0 && scopeOk === null,
      scale: mod.scaling === undefined ? null : compileScaling(mod.scaling),
      cond: mod.when === undefined ? null : mod.when.map(compileCondition),
    };
  });
}

/** The tag bits of a key. */
const TAG_BITS = (1 << SOURCE_SHIFT) - 1;

/** Hash slots of a new table. The table keeps at most half its slots in use (load ≤ 0.5). */
const INITIAL_SLOTS = 16;
/** Fibonacci hashing: the top bits of key × 2^32/φ pick the slot. */
const HASH_MULTIPLIER = 0x9e3779b1;
/** Dynamic entries a new table has room for; `dyn` doubles when full. */
const INITIAL_DYNAMIC = 16;

function grown(values: Float64Array, length: number): Float64Array {
  const copy = new Float64Array(length);
  copy.set(values);
  return copy;
}

function grownInts(values: Int32Array, length: number): Int32Array {
  const copy = new Int32Array(length);
  copy.set(values);
  return copy;
}

export class ModTable {
  /** Rows filled so far, numbered in first-use order. */
  rows = 0;
  /**
   * Per row × S: the final value of the static entries; for damage (1 + Σincreased) × Π(1 +
   * more). statAt adds the dynamic entries.
   */
  final: Float64Array;
  /** Per row × S: base + Σflat. */
  flatV: Float64Array;
  /** Per row × S: Σincreased. */
  inc: Float64Array;
  /** Per row × S: Π(1 + more). */
  more: Float64Array;
  /** Per row × S: where the stat's dynamic entries start in `dyn`, and how many there are. */
  dynStart: Int32Array;
  dynCount: Int32Array;
  /** Dynamic entries of every row and stat: indices into `mods`. */
  dyn: Int32Array;

  readonly mods: readonly CompiledMod[];
  /**
   * Per scoped stat, the rules' factor and addend on every row's final value; damage rows
   * ignore both, since rules change damage through modifiers.
   */
  readonly postScale: Float64Array;
  readonly postOffset: Float64Array;
  private readonly base: Float64Array;
  /** Entries used in `dyn`. */
  private dynLength = 0;
  /** Per scoped stat, the indices of its dynamic modifiers, in data order. */
  private readonly dynamicMods: readonly (readonly number[])[];
  /** Open addressing with linear probing: key + 1 per slot (0 = empty), and that key's row. */
  private keys: Int32Array;
  private slotRows: Int32Array;
  /** 32 − log2(slots). */
  private shift: number;
  /** Scratch: Σ untagged flats per scoped stat of the row being filled. */
  private readonly untaggedFlat = new Float64Array(S);

  /**
   * `base` holds each scoped stat's StatBlock.base value, and `postScale` and `postOffset` the
   * rules' post-operations (1 and 0 without rules), in SCOPED_STATS order.
   */
  constructor(
    mods: readonly CompiledMod[],
    base: Float64Array,
    postScale: Float64Array = new Float64Array(S).fill(1),
    postOffset: Float64Array = new Float64Array(S),
  ) {
    if (base.length !== S) throw new RangeError(`base must hold ${S} values`);
    if (postScale.length !== S || postOffset.length !== S) {
      throw new RangeError(`postScale and postOffset must hold ${S} values`);
    }
    this.mods = mods;
    this.base = base;
    this.postScale = postScale;
    this.postOffset = postOffset;
    this.keys = new Int32Array(INITIAL_SLOTS);
    this.slotRows = new Int32Array(INITIAL_SLOTS);
    this.shift = 32 - Math.log2(INITIAL_SLOTS);
    const rowValues = (INITIAL_SLOTS / 2) * S;
    this.final = new Float64Array(rowValues);
    this.flatV = new Float64Array(rowValues);
    this.inc = new Float64Array(rowValues);
    this.more = new Float64Array(rowValues);
    this.dynStart = new Int32Array(rowValues);
    this.dynCount = new Int32Array(rowValues);
    this.dynamicMods = SCOPED_STATS.map((_, s) =>
      mods.flatMap((mod, i) => (mod.stat === s && isDynamic(mod) ? [i] : [])),
    );
    this.dyn = new Int32Array(INITIAL_DYNAMIC);
  }

  /** The row of `key`, filled on its first use. */
  row(key: number): number {
    const keys = this.keys;
    const last = keys.length - 1;
    const stored = key + 1;
    for (let slot = Math.imul(key, HASH_MULTIPLIER) >>> this.shift; ; slot = (slot + 1) & last) {
      const at = keys[slot] as number;
      if (at === stored) return this.slotRows[slot] as number;
      if (at === 0) return this.add(key, slot);
    }
  }

  /**
   * Damage multiplier of `key` for a primary hit (chain jump 0) without a target: (1 +
   * Σincreased) × Π(1 + more) of its damage modifiers, conditional ones left out.
   */
  damage(key: number): number {
    // Row first: filling it may grow, and so replace, the arrays.
    const row = this.row(key);
    return statAt(this, row, DAMAGE, ESTIMATE);
  }

  /** The first empty slot on `key`'s probe path. */
  private emptySlot(key: number): number {
    const keys = this.keys;
    const last = keys.length - 1;
    let slot = Math.imul(key, HASH_MULTIPLIER) >>> this.shift;
    while (keys[slot] !== 0) slot = (slot + 1) & last;
    return slot;
  }

  private add(key: number, slot: number): number {
    if (2 * (this.rows + 1) > this.keys.length) {
      this.grow();
      slot = this.emptySlot(key);
    }
    const row = this.rows++;
    this.keys[slot] = key + 1;
    this.slotRows[slot] = row;
    this.fill(row, key);
    return row;
  }

  /** Doubles the slots and the row capacity; rows keep their numbers. */
  private grow(): void {
    const oldKeys = this.keys;
    const oldRows = this.slotRows;
    const slots = oldKeys.length * 2;
    this.keys = new Int32Array(slots);
    this.slotRows = new Int32Array(slots);
    this.shift--;
    for (let i = 0; i < oldKeys.length; i++) {
      const stored = oldKeys[i] as number;
      if (stored === 0) continue;
      const slot = this.emptySlot(stored - 1);
      this.keys[slot] = stored;
      this.slotRows[slot] = oldRows[i] as number;
    }
    const rowValues = (slots / 2) * S;
    this.final = grown(this.final, rowValues);
    this.flatV = grown(this.flatV, rowValues);
    this.inc = grown(this.inc, rowValues);
    this.more = grown(this.more, rowValues);
    this.dynStart = grownInts(this.dynStart, rowValues);
    this.dynCount = grownInts(this.dynCount, rowValues);
  }

  private fill(row: number, key: number): void {
    const { mods, base, postScale, postOffset, untaggedFlat, flatV, inc, more, final } = this;
    const at = row * S;
    const tags = key & TAG_BITS;
    const source = key >>> SOURCE_SHIFT;
    const matches = (mod: CompiledMod): boolean =>
      (mod.all & ~tags) === 0 &&
      (mod.none & tags) === 0 &&
      (mod.scopeOk === null || mod.scopeOk[source] === 1);
    for (let s = 0; s < S; s++) {
      untaggedFlat[s] = 0;
      inc[at + s] = 0;
      more[at + s] = 1;
    }
    for (const mod of mods) {
      if (isDynamic(mod) || !matches(mod)) continue;
      if (mod.kind === FLAT) {
        if (mod.untagged) untaggedFlat[mod.stat] = (untaggedFlat[mod.stat] as number) + mod.value;
      } else if (mod.kind === INCREASED) {
        inc[at + mod.stat] = (inc[at + mod.stat] as number) + mod.value;
      } else {
        more[at + mod.stat] = (more[at + mod.stat] as number) * (1 + mod.value);
      }
    }
    for (let s = 0; s < S; s++) flatV[at + s] = (base[s] as number) + (untaggedFlat[s] as number);
    for (const mod of mods) {
      if (mod.kind !== FLAT || mod.untagged || isDynamic(mod) || !matches(mod)) continue;
      flatV[at + mod.stat] = (flatV[at + mod.stat] as number) + mod.value;
    }
    for (let s = 0; s < S; s++) {
      const increased = 1 + (inc[at + s] as number);
      const product = more[at + s] as number;
      final[at + s] =
        s === DAMAGE
          ? increased * product
          : (flatV[at + s] as number) * increased * product * (postScale[s] as number) +
            (postOffset[s] as number);
    }
    for (let s = 0; s < S; s++) {
      const start = this.dynLength;
      for (const i of this.dynamicMods[s] as readonly number[]) {
        if (matches(mods[i] as CompiledMod)) this.pushDynamic(i);
      }
      this.dynStart[at + s] = start;
      this.dynCount[at + s] = this.dynLength - start;
    }
  }

  private pushDynamic(mod: number): void {
    if (this.dynLength === this.dyn.length) this.dyn = grownInts(this.dyn, this.dyn.length * 2);
    this.dyn[this.dynLength++] = mod;
  }
}

/**
 * A table of `stats`' scoped modifiers alone, whose scopes resolve against `sources`: no rules,
 * so no rule-added modifiers and no post-operations (compileBuild in compile.ts has both). For
 * tests of the table itself.
 */
export function modTableFor(
  stats: StatBlock,
  sources: SourceTable = createSourceTable(),
): ModTable {
  const base = Float64Array.from(SCOPED_STATS, (stat) => stats.base[stat]);
  return new ModTable(compileMods(stats.scoped, sources), base);
}
