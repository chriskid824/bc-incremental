import { describe, expect, it } from 'vitest';
import { DEFAULT_PRECISION, MAX_PRECISION, type NumberFormat, formatNum } from './format';
import { num } from './num';

const FORMATS: readonly NumberFormat[] = ['short', 'scientific', 'engineering', 'cjk'];

const fmt = (x: number, format: NumberFormat, precision?: number): string =>
  formatNum(num(x), precision === undefined ? { format } : { format, precision });

type Case = readonly [input: number, expected: string];

describe('formatNum below 1000 (every format)', () => {
  const cases: readonly Case[] = [
    [0, '0'],
    [1, '1'],
    [7, '7'],
    [42, '42'],
    [999, '999'],
    [12.5, '12.5'],
    [0.333, '0.33'],
    [999.4, '999'],
    [1.5, '1.5'],
    [2.25, '2.25'],
    [3.14159, '3.14'],
    [12.345, '12.3'],
    [123.456, '123'],
    [1.1, '1.1'],
    [1.999, '2'],
    [9.9999, '10'],
    [0.05, '0.05'],
    [0.5, '0.5'],
    [0.001, '0'],
    [5e-324, '0'],
  ];

  for (const format of FORMATS) {
    it.each(cases)(`${format}: %s -> %s`, (input, expected) => {
      expect(fmt(input, format)).toBe(expected);
    });
  }

  it('prints integers without decimals regardless of precision', () => {
    for (const format of FORMATS) {
      for (const precision of [1, 2, 3, 4]) {
        expect(fmt(999, format, precision)).toBe('999');
        expect(fmt(100, format, precision)).toBe('100');
        expect(fmt(5, format, precision)).toBe('5');
      }
    }
  });

  const precisionCases: readonly (readonly [number, number, string])[] = [
    [1, 3.7, '4'],
    [1, 12.4, '12'],
    [1, 0.333, '0.3'],
    [2, 3.14159, '3.1'],
    [2, 12.4, '12'],
    [2, 0.333, '0.33'],
    [2, 0.0333, '0.03'],
    [2, 123.4, '123'],
    [4, 3.14159, '3.14'],
    [4, 12.3456, '12.35'],
    [4, 123.456, '123.5'],
    [4, 999.4, '999.4'],
    [4, 999.9, '999.9'],
    [4, 1.5, '1.5'],
  ];
  it.each(precisionCases)('precision %s: %s -> %s', (precision, input, expected) => {
    for (const format of FORMATS) {
      expect(fmt(input, format, precision)).toBe(expected);
    }
  });
});

describe('formatNum short', () => {
  const cases: readonly Case[] = [
    [1000, '1.00K'],
    [1234, '1.23K'],
    [12_345, '12.3K'],
    [123_456, '123K'],
    [1e6, '1.00M'],
    [4_560_000, '4.56M'],
    [12_300_000, '12.3M'],
    [7.89e9, '7.89B'],
    [123e9, '123B'],
    [4.56e12, '4.56T'],
    [999e12, '999T'],
    [1e15, '1.00e15'],
    [1.234e15, '1.23e15'],
    [5.67e100, '5.67e100'],
    [1e300, '1.00e300'],
    [Number.MAX_VALUE, '1.80e308'],
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(fmt(input, 'short')).toBe(expected);
  });

  const carries: readonly Case[] = [
    [999.5, '1.00K'],
    [999.9, '1.00K'],
    [9999, '10.0K'],
    [99_949, '99.9K'],
    [99_960, '100K'],
    [999_499, '999K'],
    [999_500, '1.00M'],
    [999_999, '1.00M'],
    [999_999_999, '1.00B'],
    [999.4e12, '999T'],
    [999.96e12, '1.00e15'],
    [9.9996e15, '1.00e16'],
  ];
  it.each(carries)('carries %s -> %s', (input, expected) => {
    expect(fmt(input, 'short')).toBe(expected);
  });

  const precisionCases: readonly (readonly [number, number, string])[] = [
    [1, 1234, '1K'],
    [1, 1600, '2K'],
    [1, 12_345, '12K'],
    [1, 999_999, '1M'],
    [1, 4.4e16, '4e16'],
    [2, 1234, '1.2K'],
    [2, 12_345, '12K'],
    [2, 123_456, '123K'],
    [2, 999_999, '1.0M'],
    [2, 9960, '10K'],
    [2, 1.56e15, '1.6e15'],
    [4, 1234, '1.234K'],
    [4, 12_346, '12.35K'],
    [4, 123_456, '123.5K'],
    [4, 123e12, '123.0T'],
    [4, 999_949, '999.9K'],
    [4, 999_950, '1.000M'],
    [4, 1.23456e15, '1.235e15'],
  ];
  it.each(precisionCases)('precision %s: %s -> %s', (precision, input, expected) => {
    expect(fmt(input, 'short', precision)).toBe(expected);
  });
});

describe('formatNum scientific', () => {
  const cases: readonly Case[] = [
    [1000, '1.00e3'],
    [1234, '1.23e3'],
    [123_456, '1.23e5'],
    [1.23e15, '1.23e15'],
    [4.56e42, '4.56e42'],
    [1e300, '1.00e300'],
    [Number.MAX_VALUE, '1.80e308'],
    [999.5, '1.00e3'],
    [999.9, '1.00e3'],
    [9.994e5, '9.99e5'],
    [9.999e5, '1.00e6'],
    [9.9999e99, '1.00e100'],
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(fmt(input, 'scientific')).toBe(expected);
  });

  const precisionCases: readonly (readonly [number, number, string])[] = [
    [1, 4.4e10, '4e10'],
    [1, 9.6e10, '1e11'],
    [1, 1000, '1e3'],
    [2, 1.26e7, '1.3e7'],
    [2, 9.96e7, '1.0e8'],
    [4, 1.23456e20, '1.235e20'],
    [4, 9.9996e20, '1.000e21'],
    [4, 999.9, '999.9'],
  ];
  it.each(precisionCases)('precision %s: %s -> %s', (precision, input, expected) => {
    expect(fmt(input, 'scientific', precision)).toBe(expected);
  });

  it('never writes a plus sign in the exponent', () => {
    for (let exp = 3; exp <= 307; exp++) {
      expect(fmt(Number(`2e${exp}`), 'scientific')).toBe(`2.00e${exp}`);
    }
  });
});

describe('formatNum engineering', () => {
  const cases: readonly Case[] = [
    [1000, '1.00e3'],
    [12_300, '12.3e3'],
    [123_400, '123e3'],
    [1e6, '1.00e6'],
    [123e12, '123e12'],
    [12.3e15, '12.3e15'],
    [1.23e18, '1.23e18'],
    [1e300, '1.00e300'],
    [Number.MAX_VALUE, '180e306'],
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(fmt(input, 'engineering')).toBe(expected);
  });

  const carries: readonly Case[] = [
    [999.9, '1.00e3'],
    [9999.6, '10.0e3'],
    [99_960, '100e3'],
    [999_600, '1.00e6'],
    [999.96e12, '1.00e15'],
  ];
  it.each(carries)('carries %s -> %s', (input, expected) => {
    expect(fmt(input, 'engineering')).toBe(expected);
  });

  const precisionCases: readonly (readonly [number, number, string])[] = [
    [2, 123.4e12, '123e12'],
    [2, 12.34e15, '12e15'],
    [2, 1.234e18, '1.2e18'],
    [4, 123.4e12, '123.4e12'],
    [4, 1.23456e18, '1.235e18'],
    [4, 999.96e12, '1.000e15'],
    [4, 999.94e12, '999.9e12'],
  ];
  it.each(precisionCases)('precision %s: %s -> %s', (precision, input, expected) => {
    expect(fmt(input, 'engineering', precision)).toBe(expected);
  });
});

describe('formatNum cjk', () => {
  const cases: readonly Case[] = [
    [1000, '1000'],
    [1234, '1234'],
    [1234.4, '1234'],
    [9999, '9999'],
    [9999.4, '9999'],
    [1e4, '1.00萬'],
    [12_345, '1.23萬'],
    [123_456, '12.3萬'],
    [1_234_567, '123萬'],
    [12_345_678, '1235萬'],
    [1e8, '1.00億'],
    [3.4e8, '3.40億'],
    [5.6e12, '5.60兆'],
    [7.8e16, '7.80京'],
    [9.1e20, '9.10垓'],
    [9999e20, '9999垓'],
    [1e24, '1.00e24'],
    [4.56e30, '4.56e30'],
    [Number.MAX_VALUE, '1.80e308'],
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(fmt(input, 'cjk')).toBe(expected);
  });

  const carries: readonly Case[] = [
    [9999.5, '1.00萬'],
    [99_960, '10.0萬'],
    [99_994_000, '9999萬'],
    [99_995_000, '1.00億'],
    [999.96e12, '1000兆'],
    [9999.6e12, '1.00京'],
    [9999.6e20, '1.00e24'],
  ];
  it.each(carries)('carries %s -> %s', (input, expected) => {
    expect(fmt(input, 'cjk')).toBe(expected);
  });

  const precisionCases: readonly (readonly [number, number, string])[] = [
    [1, 12_345, '1萬'],
    [1, 99_999, '10萬'],
    [2, 12_345, '1.2萬'],
    [2, 3.4e8, '3.4億'],
    [2, 5.6e12, '5.6兆'],
    [2, 99_960, '10萬'],
    [4, 12_346, '1.235萬'],
    [4, 99_994_000, '9999萬'],
    [4, 1.23456e20, '1.235垓'],
    [4, 9999.4, '9999'],
    [4, 9999.96, '1.000萬'],
  ];
  it.each(precisionCases)('precision %s: %s -> %s', (precision, input, expected) => {
    expect(fmt(input, 'cjk', precision)).toBe(expected);
  });
});

describe('formatNum signs and non-finite values', () => {
  const negatives: readonly (readonly [NumberFormat, number, string])[] = [
    ['short', -1234, '-1.23K'],
    ['short', -999_999, '-1.00M'],
    ['short', -12.5, '-12.5'],
    ['short', -999, '-999'],
    ['short', -2e20, '-2.00e20'],
    ['scientific', -9.999e5, '-1.00e6'],
    ['engineering', -12.3e15, '-12.3e15'],
    ['cjk', -9999, '-9999'],
    ['cjk', -5e20, '-5.00垓'],
  ];
  it.each(negatives)('%s: %s -> %s', (format, input, expected) => {
    expect(fmt(input, format)).toBe(expected);
  });

  it('never prints a negative zero', () => {
    for (const format of FORMATS) {
      expect(fmt(-0, format)).toBe('0');
      expect(fmt(-0.001, format)).toBe('0');
      expect(fmt(-5e-324, format)).toBe('0');
    }
  });

  it('formats NaN and infinities', () => {
    for (const format of FORMATS) {
      expect(fmt(NaN, format)).toBe('NaN');
      expect(fmt(Infinity, format)).toBe('∞');
      expect(fmt(-Infinity, format)).toBe('-∞');
    }
  });

  it('mirrors positive values for negatives', () => {
    for (const format of FORMATS) {
      for (let k = 0; k <= 300; k++) {
        const x = 1.2345 * Math.pow(10, k);
        expect(fmt(-x, format)).toBe('-' + fmt(x, format));
      }
    }
  });
});

describe('formatNum precision option', () => {
  it(`defaults to ${DEFAULT_PRECISION} significant digits`, () => {
    expect(DEFAULT_PRECISION).toBe(3);
    expect(formatNum(num(1234), { format: 'short' })).toBe('1.23K');
    expect(formatNum(num(1234), { format: 'short', precision: 3 })).toBe('1.23K');
  });

  it('accepts 1..MAX_PRECISION', () => {
    expect(fmt(1234, 'short', 1)).toBe('1K');
    expect(fmt(1234, 'short', MAX_PRECISION)).toBe('1.23400000000000K');
    expect(fmt(1e23, 'scientific', MAX_PRECISION)).toBe('1.00000000000000e23');
  });

  it.each([0, -1, 2.5, MAX_PRECISION + 1, NaN, Infinity])('rejects precision %s', (precision) => {
    expect(() => fmt(1234, 'short', precision)).toThrow(RangeError);
  });
});

const SHORT_UNITS: Readonly<Record<string, number>> = { K: 3, M: 6, B: 9, T: 12 };
const CJK_UNITS: Readonly<Record<string, number>> = { 萬: 4, 億: 8, 兆: 12, 京: 16, 垓: 20 };
const SHAPE = /^(\d+)(?:\.(\d+))?(?:e(\d+)|([KMBT萬億兆京垓]))$/;

/** Splits a scaled result into its mantissa and the power of ten of its unit. */
function parseScaled(text: string): { mantissa: number; digits: number; unitExp: number } {
  const match = SHAPE.exec(text);
  if (match === null) throw new Error(`Unexpected shape: ${text}`);
  const [, int = '', frac = '', exp, suffix] = match;
  const unitExp =
    exp !== undefined ? Number(exp) : (SHORT_UNITS[suffix ?? ''] ?? CJK_UNITS[suffix ?? ''] ?? NaN);
  return { mantissa: Number(`${int}.${frac || '0'}`), digits: int.length + frac.length, unitExp };
}

describe('formatNum invariants over the whole range', () => {
  // Values from 1e3 up to the design ceiling, deliberately off round numbers.
  const values: number[] = [];
  for (let k = 3 * 16; k <= 300 * 16; k++) values.push(Math.pow(10, k / 16) * 1.0007);

  const mantissaLimit: Readonly<Record<NumberFormat, number>> = {
    short: 1000,
    scientific: 10,
    engineering: 1000,
    cjk: 10_000,
  };

  for (const format of FORMATS) {
    for (const precision of [2, 3, 4]) {
      it(`${format} precision ${precision}: shape, accuracy, width and monotonicity`, () => {
        let previous = 0;
        for (const x of values) {
          const text = fmt(x, format, precision);
          if (format === 'cjk' && x < 1e4) {
            previous = Number(text);
            continue;
          }
          const { mantissa, digits, unitExp } = parseScaled(text);
          const shown = mantissa * Math.pow(10, unitExp);

          expect(mantissa).toBeGreaterThanOrEqual(1);
          expect(mantissa).toBeLessThan(mantissaLimit[format]);
          const scientific = text.includes('e') && format !== 'engineering';
          if (scientific) {
            expect(mantissa).toBeLessThan(10);
            if (format === 'short') expect(shown).toBeGreaterThanOrEqual(1e15);
            if (format === 'cjk') expect(shown).toBeGreaterThanOrEqual(1e24);
          } else {
            const step = format === 'cjk' ? 4 : 3;
            expect(unitExp % step).toBe(0);
          }

          const intDigits = String(Math.floor(mantissa)).length;
          expect(digits).toBe(Math.max(precision, intDigits));
          expect(Math.abs(shown - x) / x).toBeLessThanOrEqual(0.5 * Math.pow(10, 1 - precision));
          expect(shown).toBeGreaterThanOrEqual(previous);
          previous = shown;
        }
      });
    }
  }
});
