import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../core/num';
import type { Num } from '../core/num';
import { BURN_TALLY_MS, BurnTally } from './burnTally';

function collector(): {
  shown: { amount: number; x: number; y: number }[];
  emit: (amount: Num, x: number, y: number) => void;
} {
  const shown: { amount: number; x: number; y: number }[] = [];
  return { shown, emit: (amount, x, y) => shown.push({ amount: toNumber(amount), x, y }) };
}

describe('BurnTally', () => {
  it('sums ticks on one enemy into one number per window, at its latest position', () => {
    const tally = new BurnTally();
    const { shown, emit } = collector();
    tally.add(7, num(10), 100, 100);
    tally.update(BURN_TALLY_MS / 2, emit);
    tally.add(7, num(15), 110, 105);
    expect(shown).toHaveLength(0);
    tally.update(BURN_TALLY_MS / 2, emit);
    expect(shown).toEqual([{ amount: 25, x: 110, y: 105 }]);
    expect(tally.size).toBe(0);
  });

  it('keeps enemies apart and starts a fresh window after showing', () => {
    const tally = new BurnTally();
    const { shown, emit } = collector();
    tally.add(1, num(5), 0, 0);
    tally.add(2, num(8), 50, 0);
    tally.update(BURN_TALLY_MS, emit);
    expect(shown.map((s) => s.amount).sort()).toEqual([5, 8]);
    tally.add(1, num(3), 0, 0);
    tally.update(BURN_TALLY_MS - 1, emit);
    expect(shown).toHaveLength(2);
    tally.update(1, emit);
    expect(shown[2]?.amount).toBe(3);
  });

  it('shows a dying enemy at once and ignores enemies without a tally', () => {
    const tally = new BurnTally();
    const { shown, emit } = collector();
    tally.add(4, num(12), 30, 40);
    tally.flush(4, emit);
    tally.flush(9, emit);
    expect(shown).toEqual([{ amount: 12, x: 30, y: 40 }]);
    tally.update(BURN_TALLY_MS * 2, emit);
    expect(shown).toHaveLength(1);
  });

  it('turns many frequent ticks into far fewer numbers', () => {
    const tally = new BurnTally();
    const { shown, emit } = collector();
    // 200 burning enemies ticking every 62.5 ms (4x speed) for 2 s of wall-clock time.
    let ticks = 0;
    for (let frame = 0; frame < 32; frame++) {
      for (let id = 0; id < 200; id++) {
        tally.add(id, num(1), id, 0);
        ticks++;
      }
      tally.update(62.5, emit);
    }
    expect(ticks).toBe(6400);
    expect(shown.length).toBeLessThanOrEqual(200 * Math.ceil(2000 / BURN_TALLY_MS));
    expect(shown.reduce((sum, s) => sum + s.amount, 0)).toBeLessThanOrEqual(ticks);
  });

  it('names the enemy each total belongs to, so its number can merge with others for it', () => {
    const tally = new BurnTally();
    const ids: number[] = [];
    const emit = (_amount: Num, _x: number, _y: number, enemyId: number): void => {
      ids.push(enemyId);
    };
    tally.add(3, num(1), 0, 0);
    tally.add(8, num(1), 0, 0);
    tally.flush(8, emit);
    tally.update(BURN_TALLY_MS, emit);
    expect(ids).toEqual([8, 3]);
  });

  it('clears without showing anything', () => {
    const tally = new BurnTally();
    const { shown, emit } = collector();
    tally.add(1, num(5), 0, 0);
    tally.clear();
    tally.update(BURN_TALLY_MS, emit);
    expect(shown).toHaveLength(0);
    expect(tally.size).toBe(0);
  });
});
