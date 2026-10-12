import { describe, expect, it } from 'vitest';
import {
  ONE,
  ZERO,
  abs,
  add,
  assertFinite,
  div,
  eq,
  floor,
  fromJSON,
  gt,
  gte,
  isFiniteNum,
  isZero,
  log10,
  lt,
  lte,
  max,
  min,
  mul,
  neg,
  num,
  pow,
  sub,
  toJSON,
  toNumber,
} from './num';

describe('Num arithmetic', () => {
  it('has zero and one constants', () => {
    expect(toNumber(ZERO)).toBe(0);
    expect(toNumber(ONE)).toBe(1);
  });

  it('adds, subtracts, multiplies and divides', () => {
    expect(add(num(2), num(3))).toBe(5);
    expect(sub(num(2), num(3))).toBe(-1);
    expect(mul(num(2), num(3))).toBe(6);
    expect(mul(num(2), 1.5)).toBe(3);
    expect(div(num(3), num(2))).toBe(1.5);
    expect(div(num(10), 4)).toBe(2.5);
  });

  it('handles values near the design ceiling', () => {
    // Powers of two keep these exact; 2^996 is about 6.7e299.
    expect(mul(num(2 ** 500), num(2 ** 496))).toBe(2 ** 996);
    expect(div(num(2 ** 996), num(2 ** 500))).toBe(2 ** 496);
    expect(add(num(1e300), num(1e300))).toBe(2e300);
    expect(toNumber(pow(num(10), 300)) / 1e300).toBeCloseTo(1, 12);
  });

  it('raises to powers', () => {
    expect(pow(num(2), 10)).toBe(1024);
    expect(pow(num(1.3), 0)).toBe(1);
    expect(pow(num(4), 0.5)).toBe(2);
  });

  it('negates, takes absolute values and floors', () => {
    expect(neg(num(5))).toBe(-5);
    expect(neg(num(-5))).toBe(5);
    expect(abs(num(-7.5))).toBe(7.5);
    expect(abs(num(7.5))).toBe(7.5);
    expect(floor(num(7.9))).toBe(7);
    expect(floor(num(-7.1))).toBe(-8);
  });

  it('picks min and max', () => {
    expect(min(num(1), num(2))).toBe(1);
    expect(min(num(2), num(1))).toBe(1);
    expect(max(num(1), num(2))).toBe(2);
    expect(max(num(2), num(1))).toBe(2);
    expect(min(num(-1e300), num(1e300))).toBe(-1e300);
    expect(max(num(-1e300), num(1e300))).toBe(1e300);
    expect(min(num(4), num(4))).toBe(4);
    expect(max(num(4), num(4))).toBe(4);
  });

  it('takes log10, with -Infinity for zero', () => {
    expect(log10(num(1000))).toBeCloseTo(3, 12);
    expect(log10(num(1e300))).toBeCloseTo(300, 12);
    expect(log10(ONE)).toBe(0);
    expect(log10(ZERO)).toBe(-Infinity);
  });
});

describe('Num comparisons', () => {
  const a = num(1);
  const b = num(2);

  it('compares ordered values', () => {
    expect(gt(b, a)).toBe(true);
    expect(gt(a, b)).toBe(false);
    expect(gt(a, a)).toBe(false);
    expect(gte(a, a)).toBe(true);
    expect(gte(a, b)).toBe(false);
    expect(lt(a, b)).toBe(true);
    expect(lt(b, a)).toBe(false);
    expect(lt(a, a)).toBe(false);
    expect(lte(a, a)).toBe(true);
    expect(lte(b, a)).toBe(false);
  });

  it('checks equality and zero', () => {
    expect(eq(a, num(1))).toBe(true);
    expect(eq(a, b)).toBe(false);
    expect(isZero(ZERO)).toBe(true);
    expect(isZero(num(-0))).toBe(true);
    expect(isZero(num(1e-300))).toBe(false);
  });

  it('compares across magnitudes and signs', () => {
    expect(gt(num(1e300), num(9.99e299))).toBe(true);
    expect(lt(num(-1e300), num(-1e299))).toBe(true);
  });
});

describe('Num finiteness', () => {
  it('reports finiteness', () => {
    expect(isFiniteNum(num(1e300))).toBe(true);
    expect(isFiniteNum(num(Infinity))).toBe(false);
    expect(isFiniteNum(num(-Infinity))).toBe(false);
    expect(isFiniteNum(num(NaN))).toBe(false);
  });

  it('detects overflow past the double range', () => {
    expect(isFiniteNum(mul(num(1e300), num(1e10)))).toBe(false);
  });

  it('assertFinite returns finite values unchanged', () => {
    expect(assertFinite(num(42), 'test')).toBe(42);
    expect(assertFinite(num(-1e300), 'test')).toBe(-1e300);
    expect(assertFinite(ZERO, 'test')).toBe(0);
  });

  it.each([Infinity, -Infinity, NaN])('assertFinite throws on %s with the context', (value) => {
    expect(() => assertFinite(num(value), 'damage roll')).toThrow(RangeError);
    expect(() => assertFinite(num(value), 'damage roll')).toThrow(/damage roll/);
  });
});

describe('Num serialization', () => {
  it.each([0, 1, -1, 0.5, 123.456, 1e15, 1.2345678901234567e300, -9.87e-10, Number.MAX_VALUE])(
    'round-trips %s through JSON',
    (value) => {
      const n = num(value);
      expect(toJSON(n)).toBe(value);
      expect(fromJSON(toJSON(n))).toBe(value);
      const restored = fromJSON(JSON.parse(JSON.stringify({ n: toJSON(n) })).n);
      expect(restored).toBe(value);
    },
  );

  it.each([
    ['a string', '123'],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['an object', { value: 1 }],
    ['an array', [1]],
    ['a bigint', 1n],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ])('fromJSON rejects %s', (_label, value) => {
    expect(() => fromJSON(value)).toThrow(TypeError);
  });
});
