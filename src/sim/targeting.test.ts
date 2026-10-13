import { describe, expect, it } from 'vitest';
import { num } from '../core/num';
import { isCovered, pickTarget } from './targeting';
import type { Targetable } from './targeting';

interface Dummy extends Targetable {
  readonly id: number;
}

const ESTIMATE = num(10);

function dummy(id: number, x: number, y: number, hp = 10, inbound = 0, alive = true): Dummy {
  return { id, x, y, hp: num(hp), inbound, alive };
}

const idOf = (target: Dummy | null): number | null => target?.id ?? null;

describe('isCovered', () => {
  it('is true once the inbound estimates reach the hp', () => {
    expect(isCovered(dummy(1, 0, 0, 10, 0), ESTIMATE)).toBe(false);
    expect(isCovered(dummy(1, 0, 0, 10, 1), ESTIMATE)).toBe(true);
    expect(isCovered(dummy(1, 0, 0, 25, 2), ESTIMATE)).toBe(false);
    expect(isCovered(dummy(1, 0, 0, 25, 3), ESTIMATE)).toBe(true);
  });

  it('never covers anything with a zero estimate', () => {
    expect(isCovered(dummy(1, 0, 0, 1e-9, 5), num(0))).toBe(false);
  });
});

describe('pickTarget', () => {
  it('picks the closest alive target that is not covered', () => {
    const targets = [
      dummy(1, 50, 0, 10, 0, false), // closest, dead
      dummy(2, 100, 0, 10, 1), // covered
      dummy(3, 0, 300, 25, 2), // partly covered: 20 inbound < 25 hp
      dummy(4, 200, 0), // uncovered but farther
    ];
    expect(idOf(pickTarget(targets, 0, 0, ESTIMATE))).toBe(4);
    expect(idOf(pickTarget(targets, 0, 250, ESTIMATE))).toBe(3);
  });

  it('falls back to the closest alive target when every one is covered', () => {
    const targets = [
      dummy(1, 300, 0, 10, 1),
      dummy(2, 100, 0, 10, 2),
      dummy(3, 50, 0, 10, 0, false),
    ];
    expect(idOf(pickTarget(targets, 0, 0, ESTIMATE))).toBe(2);
    expect(idOf(pickTarget(targets, 290, 0, ESTIMATE))).toBe(1);
  });

  it('measures distance from the given point', () => {
    const targets = [dummy(1, -100, 0), dummy(2, 100, 0), dummy(3, 0, 120)];
    expect(idOf(pickTarget(targets, -90, 0, ESTIMATE))).toBe(1);
    expect(idOf(pickTarget(targets, 90, 0, ESTIMATE))).toBe(2);
    expect(idOf(pickTarget(targets, 0, 100, ESTIMATE))).toBe(3);
  });

  it('prefers the earlier entry on equal distance', () => {
    const uncovered = [dummy(1, 100, 0), dummy(2, 0, 100), dummy(3, -100, 0)];
    expect(idOf(pickTarget(uncovered, 0, 0, ESTIMATE))).toBe(1);
    const covered = [dummy(1, 100, 0, 10, 1), dummy(2, 0, 100, 10, 1)];
    expect(idOf(pickTarget(covered, 0, 0, ESTIMATE))).toBe(1);
    const mixed = [dummy(1, 100, 0, 10, 1), dummy(2, 0, 100), dummy(3, 0, -100)];
    expect(idOf(pickTarget(mixed, 0, 0, ESTIMATE))).toBe(2);
  });

  it('returns null when nothing is alive', () => {
    expect(pickTarget([], 0, 0, ESTIMATE)).toBeNull();
    expect(pickTarget([dummy(1, 10, 0, 10, 0, false)], 0, 0, ESTIMATE)).toBeNull();
  });

  describe('with focus targets', () => {
    /** Ids from 10 up stand for elites and bosses near the player. */
    const isFocus = (target: Dummy): boolean => target.id >= 10;
    const pick = (targets: readonly Dummy[], avoid?: (target: Dummy) => boolean): number | null =>
      idOf(pickTarget(targets, 0, 0, ESTIMATE, avoid, isFocus));

    it('prefers the closest uncovered focus target over closer ordinary ones', () => {
      const targets = [dummy(1, 50, 0), dummy(10, 400, 0), dummy(11, 300, 0), dummy(2, 100, 0)];
      expect(pick(targets)).toBe(11);
      // Without the predicate nothing is a focus target.
      expect(idOf(pickTarget(targets, 0, 0, ESTIMATE))).toBe(1);
    });

    it('skips focus targets that are covered, avoided or dead', () => {
      const targets = [
        dummy(1, 50, 0),
        dummy(10, 100, 0, 10, 1), // covered
        dummy(11, 200, 0),
        dummy(12, 150, 0, 10, 0, false), // dead
        dummy(2, 80, 0),
      ];
      expect(pick(targets)).toBe(11);
      expect(pick(targets, (target) => target.id === 11)).toBe(1);
    });

    it('falls back to the closest alive target when everything is covered', () => {
      const targets = [dummy(10, 100, 0, 10, 1), dummy(1, 50, 0, 10, 1)];
      expect(pick(targets)).toBe(1);
    });

    it('prefers the earlier focus entry on equal distance', () => {
      const targets = [dummy(1, 10, 0), dummy(10, 100, 0), dummy(11, 0, 100)];
      expect(pick(targets)).toBe(10);
    });
  });
});
