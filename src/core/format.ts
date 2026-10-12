/**
 * Display formatting for big numbers (docs/ARCHITECTURE.md §5).
 *
 * Runs every frame for floating damage numbers, so it avoids regexes and temporary objects.
 * Rounding works on the exact value of the double (toFixed / toExponential), and a value that
 * rounds up to the next unit carries into it: 999_999 is "1.00M", never "1000K".
 */

import { type Num, toNumber } from './num';

export type NumberFormat = 'short' | 'scientific' | 'engineering' | 'cjk';

export interface FormatOptions {
  readonly format: NumberFormat;
  /** Significant digits, 1..MAX_PRECISION. Defaults to DEFAULT_PRECISION. */
  readonly precision?: number;
}

export const DEFAULT_PRECISION = 3;
/** Higher values would print binary noise and break the carry logic below. */
export const MAX_PRECISION = 15;

/** Short suffixes per power of 1e3, starting at 1e3. 1e15 and above use scientific. */
const SHORT_SUFFIXES = 'KMBT';
const SHORT_SCIENTIFIC_EXP = 15;
/** CJK suffixes per power of 1e4, starting at 1e4: 萬 億 兆 京 垓. 1e24 and above use scientific. */
const CJK_SUFFIXES = '萬億兆京垓';
const CJK_SCIENTIFIC_EXP = 24;

/** POW10[i] is the double closest to 10^i; POW10[309] is Infinity and acts as a sentinel. */
const POW10: readonly number[] = Array.from({ length: 310 }, (_, i) => Number(`1e${i}`));

const pow10 = (exp: number): number => POW10[exp] as number;

/**
 * Formats a Num for display.
 *
 * Below 1000 (10_000 for cjk) integers print as-is and other values keep `precision`
 * significant digits but at most 2 decimals, with trailing zeros trimmed: 12.5, 0.33, 999.
 * Above that the mantissa keeps `precision` significant digits and its trailing zeros, so
 * widths stay stable ("1.00K", "12.3M", "123B"); integer digits of the mantissa are never
 * rounded away, so precision 2 prints "123K" rather than "120K".
 */
export function formatNum(value: Num, options: FormatOptions): string {
  const x = toNumber(value);
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return '∞';
  if (x === -Infinity) return '-∞';

  const precision = options.precision ?? DEFAULT_PRECISION;
  if (!Number.isInteger(precision) || precision < 1 || precision > MAX_PRECISION) {
    throw new RangeError(`Format precision must be an integer in 1..${MAX_PRECISION}`);
  }

  const body = formatAbs(Math.abs(x), options.format, precision);
  return x < 0 && body !== '0' ? '-' + body : body;
}

function formatAbs(x: number, format: NumberFormat, precision: number): string {
  const plainExp = format === 'cjk' ? 4 : 3;
  if (x < pow10(plainExp)) {
    const plain = formatPlain(x, precision, pow10(plainExp));
    if (plain !== null) return plain;
    // Rounded up to the plain limit: carry into the first suffix.
    return formatScaled(pow10(plainExp), plainExp, format, precision);
  }
  return formatScaled(x, decimalExponent(x), format, precision);
}

/** Small values without a suffix, or null when rounding reaches `limit`. */
function formatPlain(x: number, precision: number, limit: number): string | null {
  if (Number.isInteger(x)) return String(x);
  let decimals = precision - 1 - Math.floor(Math.log10(x));
  if (decimals < 0) decimals = 0;
  else if (decimals > 2) decimals = 2;
  const text = x.toFixed(decimals);
  if (Number(text) >= limit) return null;
  return decimals === 0 ? text : trimZeros(text);
}

/**
 * x >= 1 with decimal exponent `exp` (10^exp <= x < 10^(exp+1)), written as a mantissa times
 * a unit whose exponent is a multiple of the format's step.
 */
function formatScaled(x: number, exp: number, format: NumberFormat, precision: number): string {
  const scientific =
    format === 'scientific' ||
    (format === 'short' && exp >= SHORT_SCIENTIFIC_EXP) ||
    (format === 'cjk' && exp >= CJK_SCIENTIFIC_EXP);
  const step = scientific ? 1 : format === 'cjk' ? 4 : 3;
  const unitExp = exp - (exp % step);
  const intDigits = exp - unitExp + 1;
  const digits = intDigits > precision ? intDigits : precision;

  // For x >= 1 this is "d.ddde+N" (or "de+N" for a single digit).
  const text = x.toExponential(digits - 1);
  const ePos = text.indexOf('e');
  const roundedExp = Number(text.slice(ePos + 2));
  if (roundedExp !== exp) {
    // Rounded up to the next power of ten, possibly into the next unit or into scientific.
    return formatScaled(pow10(roundedExp), roundedExp, format, precision);
  }

  let mantissa: string;
  if (intDigits === 1) {
    mantissa = text.slice(0, ePos);
  } else {
    const all = text.charAt(0) + text.slice(2, ePos);
    mantissa = intDigits === digits ? all : all.slice(0, intDigits) + '.' + all.slice(intDigits);
  }

  if (scientific || format === 'engineering') return mantissa + 'e' + unitExp;
  if (format === 'cjk') return mantissa + CJK_SUFFIXES.charAt(unitExp / 4 - 1);
  return mantissa + SHORT_SUFFIXES.charAt(unitExp / 3 - 1);
}

/** floor(log10(x)) for finite x >= 1, exact at powers of ten. */
function decimalExponent(x: number): number {
  let exp = Math.floor(Math.log10(x));
  if (x < pow10(exp)) exp--;
  else if (x >= pow10(exp + 1)) exp++;
  return exp;
}

/** Drops trailing zeros and a dangling decimal point from a toFixed result with decimals. */
function trimZeros(text: string): string {
  let end = text.length;
  while (text.charCodeAt(end - 1) === 48) end--; // '0'
  if (text.charCodeAt(end - 1) === 46) end--; // '.'
  return end === text.length ? text : text.slice(0, end);
}
