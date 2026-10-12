/**
 * Big-number type for damage, HP and currencies.
 *
 * The design ceiling is 1e300 (docs/ARCHITECTURE.md §5), so `Num` is a branded double.
 * All creation, arithmetic, comparison and serialization of big numbers goes through this
 * module, so the backing representation can be swapped later without touching call sites
 * that only use these functions.
 */

declare const numBrand: unique symbol;
export type Num = number & { readonly [numBrand]: true };

export const num = (value: number): Num => value as Num;

export const ZERO: Num = num(0);
export const ONE: Num = num(1);

export const add = (a: Num, b: Num): Num => (a + b) as Num;
export const sub = (a: Num, b: Num): Num => (a - b) as Num;
export const mul = (a: Num, b: Num | number): Num => (a * b) as Num;
export const div = (a: Num, b: Num | number): Num => (a / b) as Num;
export const pow = (a: Num, exponent: number): Num => Math.pow(a, exponent) as Num;
export const neg = (a: Num): Num => -a as Num;
export const abs = (a: Num): Num => Math.abs(a) as Num;
export const floor = (a: Num): Num => Math.floor(a) as Num;
export const min = (a: Num, b: Num): Num => (a < b ? a : b);
export const max = (a: Num, b: Num): Num => (a > b ? a : b);

export const gt = (a: Num, b: Num): boolean => a > b;
export const gte = (a: Num, b: Num): boolean => a >= b;
export const lt = (a: Num, b: Num): boolean => a < b;
export const lte = (a: Num, b: Num): boolean => a <= b;
export const eq = (a: Num, b: Num): boolean => a === b;
export const isZero = (a: Num): boolean => a === 0;

/** log10 of the value; -Infinity for zero. Used for formatting and visual scaling. */
export const log10 = (a: Num): number => Math.log10(a);

/** Lossy conversion for places that need a plain number (ratios, UI scaling). */
export const toNumber = (a: Num): number => a;

export const isFiniteNum = (a: Num): boolean => Number.isFinite(a);

/** Throws when a value overflowed or became NaN. Cheap enough to call in hot paths. */
export function assertFinite(a: Num, context: string): Num {
  if (!Number.isFinite(a)) {
    throw new RangeError(`Non-finite Num (${a}) in ${context}`);
  }
  return a;
}

/** Serialized form inside save files and CSV output. */
export const toJSON = (a: Num): number => a;

export function fromJSON(value: unknown): Num {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid serialized Num: ${String(value)}`);
  }
  return value as Num;
}
