import { describe, expect, it } from 'vitest';
import { C7_PARTS, c7PartsOf, formatC7Parts, probeC7Parts } from './c7';
import { NO_C7 } from './testing';

/** An enemy view and a result holding every C7 field, each with a falsy value. */
const view = { defence: 0, state: null, affixes: 0, layersLeft: 0 };
const result = { bulletTakenBy: null, counters: { enemyCapDelayed: 0, enemySpawnsSkipped: 0 } };

describe('C7 parts live (§2.3)', () => {
  it('reads every field with `in`: present with a falsy value is live, absent is pending', () => {
    expect(c7PartsOf(view, result)).toEqual({
      'C7.3': true,
      'C7.4a': true,
      'C7.4b': true,
      'C7.5': true,
      'C7.6': true,
      'C7.7': true,
    });
    for (const { part, on, fields } of C7_PARTS) {
      for (const field of fields) {
        const without = <T extends object>(value: T): T =>
          Object.fromEntries(Object.entries(value).filter(([key]) => key !== field)) as T;
        const parts =
          on === 'enemy'
            ? c7PartsOf(without(view), result)
            : on === 'result'
              ? c7PartsOf(view, without(result))
              : c7PartsOf(view, { ...result, counters: without(result.counters) });
        expect(parts, `${part} without ${field}`).toEqual({
          ...c7PartsOf(view, result),
          [part]: false,
        });
      }
    }
  });

  it('reads no part from a missing view or result', () => {
    expect(c7PartsOf(null, null)).toEqual(NO_C7);
    expect(c7PartsOf(undefined, { counters: null })).toEqual(NO_C7);
    expect(c7PartsOf(view, {})).toMatchObject({ 'C7.4b': false, 'C7.5': false, 'C7.3': true });
  });

  it('prints the live parts, then the pending ones, with their fields', () => {
    expect(formatC7Parts({ ...NO_C7, 'C7.5': true })).toBe(
      'live: C7.5 (enemyCapDelayed, enemySpawnsSkipped); pending: C7.3 (defence), ' +
        'C7.4a (state), C7.4b (bulletTakenBy), C7.6 (affixes), C7.7 (layersLeft)',
    );
    expect(formatC7Parts(NO_C7)).toMatch(/^live: none; pending: C7\.3/);
    expect(formatC7Parts(c7PartsOf(view, result))).toMatch(/; pending: none$/);
  });

  it("probes the engine once: C7.3's defence, C7.4a's state, C7.4b's bulletTakenBy and C7.5's counters are live", () => {
    const parts = probeC7Parts();
    expect(parts['C7.3']).toBe(true);
    expect(parts['C7.4a']).toBe(true);
    expect(parts['C7.4b']).toBe(true);
    expect(parts['C7.5']).toBe(true);
    expect(Object.keys(parts)).toEqual(C7_PARTS.map(({ part }) => part));
    expect(probeC7Parts()).toBe(parts);
  });
});
