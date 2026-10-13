import { describe, expect, it } from 'vitest';
import { SCOPED_STATS } from '../../data/stats';
import type { Modifier } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { ScalingSpec } from '../../data/triggers';
import { makeStats } from '../testing';
import { compileScaling, scaledValue, statAt } from './eval';
import { modTableFor, SCOPED_INDEX } from './modTable';
import { createSourceTable, rowKey } from './sources';

const S = SCOPED_STATS.length;
const { damage: DAMAGE, critChance: CRIT_CHANCE, igniteChance: IGNITE_CHANCE } = SCOPED_INDEX;

const g = (spec: Omit<ScalingSpec, 'per'>, value: number, x: number): number =>
  scaledValue(value, compileScaling({ per: 'chainJump', ...spec }), x);

const perJump = (
  stat: Modifier['stat'],
  kind: Modifier['kind'],
  value: number,
  scaling: Omit<ScalingSpec, 'per'> = {},
  extra: Partial<Modifier> = {},
): Modifier => ({ stat, kind, value, scaling: { per: 'chainJump', ...scaling }, ...extra });

describe('scaledValue', () => {
  it('scales linearly by default, in whole steps with every', () => {
    expect(g({}, 0.1, 0)).toBe(0);
    expect(g({}, 0.1, 3)).toBe(0.1 * 3);
    expect(g({ every: 2 }, 0.5, 0)).toBe(0);
    expect(g({ every: 2 }, 0.5, 1)).toBe(0);
    expect(g({ every: 2 }, 0.5, 2)).toBe(0.5);
    expect(g({ every: 2 }, 0.5, 5)).toBe(1);
  });

  it('follows the log10 and pow curves, after the steps', () => {
    expect(g({ curve: 'log10' }, 2, 9)).toBe(2);
    expect(g({ curve: 'log10' }, 2, 0)).toBe(0);
    expect(g({ curve: 'pow', exponent: 2 }, 0.5, 3)).toBe(4.5);
    expect(g({ curve: 'pow', exponent: 0.5 }, 1, 0)).toBe(0);
    expect(g({ curve: 'pow', exponent: 2, every: 2 }, 1, 5)).toBe(4);
    expect(g({ curve: 'log10', every: 3 }, 1, 29)).toBe(1);
  });

  it('caps the contribution, not the variable', () => {
    expect(g({ cap: 0.25 }, 0.1, 2)).toBe(0.2);
    expect(g({ cap: 0.25 }, 0.1, 3)).toBe(0.25);
    expect(g({ cap: 0.25 }, 0.1, 30)).toBe(0.25);
  });
});

describe('statAt', () => {
  it('reads the folded value of a row without dynamic entries', () => {
    const table = modTableFor(
      makeStats({ critChance: 0.2 }, [
        { stat: 'critChance', kind: 'flat', value: 0.1, tags: ['chain'] },
        { stat: 'damage', kind: 'more', value: 1 },
      ]),
    );
    const row = table.row(TAG.hit | TAG.chain);
    expect(table.dynCount[row * S + CRIT_CHANCE]).toBe(0);
    for (const jump of [0, 1, 5]) {
      expect(statAt(table, row, CRIT_CHANCE, jump)).toBe(0.2 + 0.1);
      expect(statAt(table, row, DAMAGE, jump)).toBe(2);
    }
  });

  it('adds Static Focus per jump after the static parts: G + 0.1 × jump, bit for bit', () => {
    const table = modTableFor(
      makeStats({ critChance: 0.35 }, [perJump('critChance', 'flat', 0.1)]),
    );
    for (const mask of [TAG.hit, TAG.hit | TAG.chain, TAG.hit | TAG.crit | TAG.chain]) {
      const row = table.row(mask);
      for (let jump = 0; jump < 8; jump++) {
        expect(statAt(table, row, CRIT_CHANCE, jump)).toBe(0.35 + 0.1 * jump);
      }
    }
    // The scaling stays out of the static parts.
    expect(table.final[table.row(TAG.hit) * S + CRIT_CHANCE]).toBe(0.35);
  });

  it('folds flat, increased and more entries into the formula in data order', () => {
    const modifiers: Modifier[] = [
      { stat: 'igniteChance', kind: 'flat', value: 0.1 },
      perJump('igniteChance', 'flat', 0.05),
      perJump('igniteChance', 'increased', 0.5, { every: 2 }),
      { stat: 'igniteChance', kind: 'increased', value: 0.2, tags: ['chain'] },
      perJump('igniteChance', 'more', 0.1, { cap: 0.25 }),
      { stat: 'igniteChance', kind: 'more', value: 1 },
    ];
    const table = modTableFor(makeStats({ igniteChance: 0.2 }, modifiers));
    const row = table.row(TAG.hit | TAG.chain);
    for (let jump = 0; jump < 6; jump++) {
      const flat = 0.2 + 0.1 + 0.05 * jump;
      const inc = 0.2 + 0.5 * Math.floor(jump / 2);
      const more = 2 * (1 + Math.min(0.25, 0.1 * jump));
      expect(statAt(table, row, IGNITE_CHANCE, jump), `jump ${jump}`).toBe(flat * (1 + inc) * more);
    }
  });

  it('keeps a damage row to (1 + Σincreased) × Π(1 + more) with dynamic entries', () => {
    const table = modTableFor(
      makeStats({ damage: 40 }, [
        { stat: 'damage', kind: 'increased', value: 0.5 },
        perJump('damage', 'more', 0.25, {}, { tags: ['chain'] }),
        perJump('damage', 'increased', 0.1, { curve: 'pow', exponent: 2 }),
      ]),
    );
    const chain = table.row(TAG.hit | TAG.chain);
    expect(statAt(table, chain, DAMAGE, 0)).toBe(1.5);
    expect(statAt(table, chain, DAMAGE, 2)).toBe((1 + (0.5 + 0.1 * 4)) * (1 + 0.25 * 2));
    // The more entry needs the chain tag: the primary hit row lists only the increased one.
    const hit = table.row(TAG.hit);
    expect(table.dynCount[hit * S + DAMAGE]).toBe(1);
    expect(table.dynCount[chain * S + DAMAGE]).toBe(2);
    expect(statAt(table, hit, DAMAGE, 2)).toBe(1 + (0.5 + 0.1 * 4));
    // damage(key) reads a primary hit: chain jump 0.
    expect(table.damage(TAG.hit | TAG.chain)).toBe(1.5);
  });

  it('lists the dynamic entries a row matches by tags, notTags and scope', () => {
    const sources = createSourceTable();
    const outer = sources.index('outer.lightning');
    const modifiers: Modifier[] = [
      perJump('critChance', 'flat', 0.01, {}, { tags: ['chain'] }),
      perJump('critChance', 'flat', 0.02, {}, { notTags: ['crit'] }),
      perJump('critChance', 'flat', 0.04, {}, { scope: 'outer' }),
    ];
    const table = modTableFor(makeStats({ critChance: 0 }, modifiers), sources);
    const at = (mask: number, source: number): number =>
      statAt(table, table.row(rowKey(mask, source)), CRIT_CHANCE, 1);
    expect(at(TAG.hit, 0)).toBe(0.02);
    expect(at(TAG.hit | TAG.chain, 0)).toBe(0.01 + 0.02);
    expect(at(TAG.hit | TAG.chain | TAG.crit, 0)).toBe(0.01);
    expect(at(TAG.hit | TAG.chain, outer)).toBe(0.01 + 0.02 + 0.04);
  });

  it("keeps every row's dynamic entries as the table grows", () => {
    const modifiers: Modifier[] = [
      perJump('critChance', 'flat', 0.1, {}, { tags: ['chain'] }),
      perJump('critChance', 'flat', 0.2, {}, { notTags: ['burn'] }),
      perJump('damage', 'more', 1, {}, { tags: ['hit'] }),
    ];
    const table = modTableFor(makeStats({ critChance: 0 }, modifiers));
    const keys = Array.from({ length: 600 }, (_, i) => (i * 37) & ((1 << 17) - 1));
    const rows = keys.map((key) => table.row(key));
    keys.forEach((key, i) => {
      const row = rows[i] as number;
      const chain = (key & TAG.chain) !== 0 ? 0.1 * 3 : 0;
      const notBurn = (key & TAG.burn) === 0 ? 0.2 * 3 : 0;
      expect(statAt(table, row, CRIT_CHANCE, 3), `key ${key}`).toBe(0 + chain + notBurn);
      expect(statAt(table, row, DAMAGE, 3), `key ${key}`).toBe((key & TAG.hit) !== 0 ? 4 : 1);
    });
  });
});
