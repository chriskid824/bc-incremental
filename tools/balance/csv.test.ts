import { describe, expect, it } from 'vitest';
import { csvField, csvLine, csvNumber, toCsv } from './csv';

describe('csvField', () => {
  it('leaves plain text alone', () => {
    expect(csvField('crit-greedy')).toBe('crit-greedy');
    expect(csvField('might×3 precision')).toBe('might×3 precision');
    expect(csvField('')).toBe('');
  });

  it('quotes commas, quotes and line breaks, doubling inner quotes', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('cr\r')).toBe('"cr\r"');
  });

  it('prints null as an empty field and booleans as words', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(true)).toBe('true');
    expect(csvField(false)).toBe('false');
  });
});

describe('csvNumber', () => {
  it('prints integers as-is', () => {
    expect(csvNumber(0)).toBe('0');
    expect(csvNumber(-42)).toBe('-42');
    expect(csvNumber(123456789)).toBe('123456789');
    expect(csvNumber(1e21)).toBe('1e+21');
  });

  it('keeps 6 significant digits for other numbers, without trailing zeros', () => {
    expect(csvNumber(0.5)).toBe('0.5');
    expect(csvNumber(1 / 3)).toBe('0.333333');
    expect(csvNumber(12.345678)).toBe('12.3457');
    expect(csvNumber(1234567.89)).toBe('1234570');
    expect(csvNumber(1.5e-7)).toBe('1.5e-7');
    expect(csvNumber(-2.25)).toBe('-2.25');
  });

  it('prints non-finite values verbatim', () => {
    expect(csvNumber(NaN)).toBe('NaN');
    expect(csvNumber(Infinity)).toBe('Infinity');
  });
});

describe('toCsv', () => {
  it('writes a header and rows with a trailing newline', () => {
    expect(
      toCsv(
        ['name', 'value', 'note'],
        [
          ['a', 1.25, null],
          ['b', 2, 'x,y'],
        ],
      ),
    ).toBe('name,value,note\na,1.25,\nb,2,"x,y"\n');
    expect(csvLine(['q"', 3])).toBe('"q""",3');
  });

  it('rejects rows with the wrong number of values', () => {
    expect(() => toCsv(['a', 'b'], [['only one']])).toThrow(/1 values, header has 2/);
  });
});
