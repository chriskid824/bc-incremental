import { describe, expect, it } from 'vitest';
import { canonicalJson, digest } from './digest';

/** FNV-1a over `bytes` from `offset` in BigInt: the reference each lane follows. */
function fnv1a(bytes: Uint8Array, offset: bigint): string {
  let hash = offset;
  for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x01000193n) % 0x100000000n;
  return hash.toString(16).padStart(8, '0');
}
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
/** FNV-1a's 32-bit offset basis, lane A's; lane B starts from its complement. */
const BASIS = 0x811c9dc5n;
const reference = (value: unknown): string => {
  const bytes = utf8(canonicalJson(value));
  return fnv1a(bytes, BASIS) + fnv1a(bytes, BASIS ^ 0xffffffffn);
};

describe('canonicalJson', () => {
  it("sorts every object's keys, at every depth", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ y: null, x: [{ b: 2, a: 1 }] })).toBe('{"x":[{"a":1,"b":2}],"y":null}');
    expect(canonicalJson({ b: { d: 1, c: [] }, a: 'z', B: 0 })).toBe(
      '{"B":0,"a":"z","b":{"c":[],"d":1}}',
    );
  });

  it('keeps every array in its order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([{ b: 1 }, { a: 1 }])).toBe('[{"b":1},{"a":1}]');
  });

  it("writes JSON.stringify's text for keys already in order", () => {
    const value = {
      a: 1.5,
      b: [true, false, null, 'x"\\\n', -0, 1e21, 1e-7, '霜焰', '𝄞'],
      c: { d: 'z', e: {} },
    };
    expect(canonicalJson(value)).toBe(JSON.stringify(value));
    expect(canonicalJson('\ud800')).toBe(JSON.stringify('\ud800'));
  });

  it('leaves out what JSON leaves out and writes null where JSON does', () => {
    expect(canonicalJson({ a: undefined, b: 1, c: () => 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, NaN, Infinity])).toBe('[null,null,null]');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('digest', () => {
  it('matches known vectors: 16 hex digits, lane A then lane B', () => {
    const vectors: readonly (readonly [unknown, string])[] = [
      [null, '77074ba4457c1acb'],
      ['a', '61a1cfea9f77e18b'],
      ['foobar', 'ac5268def0028625'],
      [1, '340ca71ccaf35751'],
      [true, '4db211e5b4fcd6a6'],
      [[1, 2], '7d8e86769993fc3b'],
      [{ b: 1, a: 2 }, 'af62f0e3b485ff06'],
      ['霜焰', '327fb26db624fa1e'],
      [{ x: [{ b: 2, a: 1 }], y: null }, '6e075581a8a85eaa'],
    ];
    for (const [value, expected] of vectors) expect(digest(value)).toBe(expected);
  });

  it("runs FNV-1a's two 32-bit lanes over the UTF-8 bytes of the canonical JSON", () => {
    // The reference gives FNV-1a's published 32-bit values.
    expect(fnv1a(utf8(''), BASIS)).toBe('811c9dc5');
    expect(fnv1a(utf8('a'), BASIS)).toBe('e40c292c');
    expect(fnv1a(utf8('foobar'), BASIS)).toBe('bf9cf968');
    const values: readonly unknown[] = [
      '',
      'ç',
      '冰光',
      '𝄞 and 😀',
      { on: 'explode', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }] },
      [0.1, 1.98, -3, 1e300, 'fusion.fire.poison'],
      { 霜: { 焰: [true, null] } },
    ];
    for (const value of values) expect(digest(value)).toBe(reference(value));
  });

  it('is the same whatever order the keys were written in', () => {
    expect(digest({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe(
      digest({ a: { c: null, d: [1, { e: 3, f: 2 }] }, b: 1 }),
    );
  });

  it('tells apart arrays in another order and values a byte apart', () => {
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
    expect(digest([{ a: 1 }, { b: 1 }])).not.toBe(digest([{ b: 1 }, { a: 1 }]));
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
    expect(digest('ab')).not.toBe(digest('ba'));
  });

  it('has two lanes from different offsets', () => {
    for (const value of [null, 'a', { a: [1] }]) {
      const text = digest(value);
      expect(text).toMatch(/^[0-9a-f]{16}$/);
      expect(text.slice(0, 8)).not.toBe(text.slice(8));
    }
  });
});
