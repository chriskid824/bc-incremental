/**
 * Per-instance stat reads (docs/v3/implementation-plan-v3.md §2.1): the value of a scoped stat
 * in a ModTable row, with the row's dynamic entries (modifiers with a scaling) evaluated for one
 * damage instance. The simulation and the build estimators (tools/balance/session.ts) share it.
 */

import { SCOPED_STATS } from '../../data/stats';
import type { ScalingCurve, ScalingSpec, ScalingVar } from '../../data/triggers';
import type { CompiledMod, ModTable } from './modTable';

/** Values per row, and the position of damage in a row (as in modTable.ts). */
const S = SCOPED_STATS.length;
const DAMAGE = SCOPED_STATS.indexOf('damage');

/** CompiledMod.kind codes. */
const FLAT = 0;
const INCREASED = 1;

const LINEAR = 0;
const LOG10 = 1;
const POW = 2;
const CURVE_CODE: Readonly<Record<ScalingCurve, CompiledScaling['curve']>> = {
  linear: LINEAR,
  log10: LOG10,
  pow: POW,
};

/**
 * Reads each scaling variable of a damage instance. Typed over ScalingVar, so a variable added
 * to the vocabulary does not compile until it has its reader here.
 */
const SCALING_READERS: { readonly [K in ScalingVar]: (chainJump: number) => number } = {
  chainJump: (chainJump) => chainJump,
};

/** A ScalingSpec compiled for per-instance evaluation. */
export interface CompiledScaling {
  readonly read: (chainJump: number) => number;
  /** Step size; 0 for a continuous variable. */
  readonly every: number;
  /** 0 linear, 1 log10, 2 pow. */
  readonly curve: 0 | 1 | 2;
  readonly exponent: number;
  /** Upper bound on the contribution; Infinity when uncapped. */
  readonly cap: number;
}

export function compileScaling(spec: ScalingSpec): CompiledScaling {
  return {
    read: SCALING_READERS[spec.per],
    every: spec.every ?? 0,
    curve: CURVE_CODE[spec.curve ?? 'linear'],
    exponent: spec.exponent ?? 1,
    cap: spec.cap ?? Infinity,
  };
}

/** The contribution c = min(cap, value × g(x)) of a scaling modifier (src/data/triggers.ts). */
export function scaledValue(value: number, scaling: CompiledScaling, x: number): number {
  const steps = scaling.every > 0 ? Math.floor(x / scaling.every) : x;
  const g =
    scaling.curve === LINEAR
      ? steps
      : scaling.curve === LOG10
        ? Math.log10(1 + steps)
        : steps ** scaling.exponent;
  return Math.min(scaling.cap, value * g);
}

/**
 * Scoped stat `stat` (its SCOPED_STATS index) of row `row` for a damage instance `chainJump`
 * jumps into its chain (0 for a primary hit). A row without dynamic entries for the stat is its
 * folded value; otherwise each dynamic entry adds its contribution after the row's static parts,
 * in data order: flat and increased add, more multiplies by 1 + c. The rules' post-operations
 * (ModTable.postScale, postOffset) then apply as they do to the folded value.
 */
export function statAt(table: ModTable, row: number, stat: number, chainJump: number): number {
  const at = row * S + stat;
  return table.dynCount[at] === 0
    ? (table.final[at] as number)
    : evalDynamic(table, at, stat, chainJump);
}

function evalDynamic(table: ModTable, at: number, stat: number, chainJump: number): number {
  const { mods, dyn } = table;
  let flat = table.flatV[at] as number;
  let inc = table.inc[at] as number;
  let more = table.more[at] as number;
  const start = table.dynStart[at] as number;
  const end = start + (table.dynCount[at] as number);
  for (let i = start; i < end; i++) {
    const mod = mods[dyn[i] as number] as CompiledMod;
    const scaling = mod.scale as CompiledScaling;
    const c = scaledValue(mod.value, scaling, scaling.read(chainJump));
    if (mod.kind === FLAT) flat += c;
    else if (mod.kind === INCREASED) inc += c;
    else more *= 1 + c;
  }
  const increased = 1 + inc;
  return stat === DAMAGE
    ? increased * more
    : flat * increased * more * (table.postScale[stat] as number) +
        (table.postOffset[stat] as number);
}
