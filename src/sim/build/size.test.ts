import { describe, expect, it } from 'vitest';
import { makeStats } from '../testing';
import { compileBuild } from './compile';
import { countOf, sizeOf } from './size';

describe('sizeOf and countOf', () => {
  it('return their input until a build-wide factor exists', () => {
    const build = compileBuild(makeStats(), []);
    for (const r of [0, 4, 22.5, 70, 300]) expect(sizeOf(build, r)).toBe(r);
    for (const n of [0, 1, 3, 16]) expect(countOf(build, n)).toBe(n);
  });
});
