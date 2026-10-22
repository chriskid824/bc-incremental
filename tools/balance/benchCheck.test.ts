import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASELINE_FILE, CHECK_ENTRIES } from './bench';
import {
  ALIVE_MAX,
  ALIVE_MIN,
  checkBench,
  entryRatio,
  formatBaseline,
  median,
  NORMAL_BUDGET_MS,
  parseBaseline,
  RATIO_LIMIT,
} from './benchCheck';
import type { BenchBaseline, BenchTimings, EntryTimings } from './benchCheck';

const KNOWN = ['hits', 'ailments', 'poisonBoss (500 stacks)'];

/** Runs of `ms` each with reference runs of `referenceMs`, plus one slow outlier of each. */
const entry = (id: string, ms: number, referenceMs: number): EntryTimings => ({
  id,
  ms: [ms, ms * 0.98, ms * 3, ms * 1.02, ms],
  referenceMs: [referenceMs * 1.01, referenceMs, referenceMs * 0.99, referenceMs * 4, referenceMs],
});

const timings = (entries: readonly EntryTimings[]): BenchTimings => ({
  reference: entries.flatMap((e) => e.referenceMs),
  entries,
});

/** Every known entry: hits as slow as the reference, ailments a quarter, poisonBoss a tenth. */
const synthetic = (normalMs = 14, scale: Readonly<Record<string, number>> = {}): BenchTimings =>
  timings([
    entry('hits', 14 * (scale['hits'] ?? 1), normalMs),
    entry('ailments', 3.5 * (scale['ailments'] ?? 1), normalMs),
    entry('poisonBoss (500 stacks)', 1.4 * (scale['poisonBoss (500 stacks)'] ?? 1), normalMs),
  ]);

const RECORDED: BenchBaseline = {
  ratios: { hits: 1, ailments: 0.25, 'poisonBoss (500 stacks)': 0.1 },
};

describe('median', () => {
  it('takes the middle value, or the mean of the middle two', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe('checkBench', () => {
  it('passes timings equal to the recorded ones', () => {
    const result = checkBench(synthetic(), RECORDED, KNOWN, false);
    expect(result.ok).toBe(true);
    expect(result.lines).toHaveLength(4);
    for (const line of result.lines) expect(line).toMatch(/: ok$/);
  });

  it('reads each ratio against the reference runs timed with it, on medians', () => {
    const hits = entry('hits', 30, 20);
    expect(entryRatio(hits)).toBe(1.5);
    // A slower reference elsewhere in the check does not move hits' ratio.
    const result = checkBench(
      timings([hits, entry('ailments', 10, 40)]),
      { ratios: { hits: 1.5, ailments: 0.25 } },
      KNOWN,
      false,
    );
    expect(result.ok).toBe(true);
    expect(result.baseline.ratios).toEqual({
      hits: 1.5,
      ailments: 0.25,
    });
  });

  it(`fails a scenario above ${RATIO_LIMIT} × its recorded ratio`, () => {
    const slower = checkBench(synthetic(14, { ailments: 1.51 }), RECORDED, KNOWN, false);
    expect(slower.ok).toBe(false);
    expect(slower.lines.filter((line) => line.endsWith('FAILED'))).toEqual([
      expect.stringMatching(/^ailments: .*ratio 0\.378 \(recorded 0\.25, limit 0\.375\): FAILED$/),
    ]);
    expect(checkBench(synthetic(14, { ailments: 1.5 }), RECORDED, KNOWN, false).ok).toBe(true);
    // Faster is never a failure.
    expect(checkBench(synthetic(14, { hits: 0.2 }), RECORDED, KNOWN, false).ok).toBe(true);
  });

  it(`fails when normal's median run exceeds ${NORMAL_BUDGET_MS} ms, ratios unchanged`, () => {
    const over = checkBench(synthetic(51), RECORDED, KNOWN, false);
    expect(over.ok).toBe(false);
    expect(over.lines.at(-1)).toMatch(/^normal \(reference\): median 51\.0 ms .*: FAILED$/);
    expect(over.lines.slice(0, -1).every((line) => line.endsWith(': ok'))).toBe(true);
    expect(checkBench(synthetic(NORMAL_BUDGET_MS), RECORDED, KNOWN, false).ok).toBe(true);
  });

  it('checks the budget alone when only normal ran', () => {
    const alone = { reference: [14, 15, 13], entries: [] };
    const result = checkBench(alone, RECORDED, KNOWN, false);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      'normal (reference): median 14.0 ms over 3 runs (budget 50 ms): ok',
    ]);
    expect(checkBench({ reference: [60], entries: [] }, RECORDED, KNOWN, false).ok).toBe(false);
  });

  it('fails a timed scenario the baseline has no ratio for, and a recorded unknown one', () => {
    const missing = checkBench(synthetic(), { ratios: { hits: 1, ailments: 0.25 } }, KNOWN, false);
    expect(missing.ok).toBe(false);
    expect(missing.lines.filter((line) => line.endsWith('FAILED'))).toEqual([
      expect.stringMatching(/^poisonBoss \(500 stacks\): .*no recorded ratio .*--write\): FAILED$/),
    ]);

    const extra = checkBench(
      synthetic(),
      { ratios: { ...RECORDED.ratios, chainStorm: 2 } },
      KNOWN,
      false,
    );
    expect(extra.ok).toBe(false);
    expect(extra.lines.filter((line) => line.endsWith('FAILED'))).toEqual([
      'chainStorm: recorded, but no such scenario (npm run bench -- --check --write): FAILED',
    ]);

    // Checking one scenario needs only its own ratio.
    const one = timings([entry('hits', 14, 14)]);
    expect(checkBench(one, { ratios: { hits: 1 } }, KNOWN, false).ok).toBe(true);
  });

  it('fails without a baseline file', () => {
    const none = checkBench(synthetic(), null, KNOWN, false);
    expect(none.ok).toBe(false);
    expect(none.lines[0]).toBe(
      'no recorded ratios; record them with npm run bench -- --check --write: FAILED',
    );
  });

  it('with write, records the measured ratios and keeps or drops the others', () => {
    // Ratios that would fail a check are recorded; known entries not timed keep their ratio;
    // unknown ones go; check order, three decimals.
    const timed = timings([entry('poisonBoss (500 stacks)', 2, 14), entry('hits', 21, 14)]);
    const recorded = { ratios: { chainStorm: 2, ailments: 0.25, hits: 1 } };
    const result = checkBench(timed, recorded, KNOWN, true);
    expect(result.ok).toBe(true);
    expect(result.baseline).toEqual({
      ratios: { hits: 1.5, ailments: 0.25, 'poisonBoss (500 stacks)': 0.143 },
    });
    expect(Object.keys(result.baseline.ratios)).toEqual(KNOWN);
    expect(result.lines).toContain('chainStorm: no such scenario, dropped');
    expect(checkBench(synthetic(), null, KNOWN, true).baseline).toEqual(RECORDED);

    // What it writes then passes a check of the same timings.
    const written = parseBaseline(formatBaseline(result.baseline));
    expect(checkBench(timed, written, KNOWN, false).ok).toBe(true);

    // The budget still fails a write.
    expect(checkBench(synthetic(60), RECORDED, KNOWN, true).ok).toBe(false);
  });

  it(`fails a stress-family entry whose average alive leaves ${ALIVE_MIN}–${ALIVE_MAX}`, () => {
    const stress = (alive: number): BenchTimings =>
      timings([{ ...entry('hits', 14, 14), alive }, entry('ailments', 3.5, 14)]);
    for (const alive of [ALIVE_MIN, 300, ALIVE_MAX]) {
      const inside = checkBench(stress(alive), RECORDED, KNOWN, false);
      expect(inside.ok, String(alive)).toBe(true);
      expect(inside.lines[0]).toMatch(
        new RegExp(`^hits: .*ratio 1\\.000, average alive ${alive}\\.0 \\(recorded 1, .*: ok$`),
      );
    }
    for (const alive of [ALIVE_MIN - 0.1, ALIVE_MAX + 0.1, 0, NaN]) {
      const outside = checkBench(stress(alive), RECORDED, KNOWN, false);
      expect(outside.ok, String(alive)).toBe(false);
      expect(outside.lines.filter((line) => line.endsWith('FAILED'))).toEqual([
        expect.stringMatching(/^hits: .*, outside 280–320 alive: FAILED$/),
      ]);
    }
    // With write it fails too and keeps the recorded ratio; the entry in the band is recorded.
    const slower = timings([{ ...entry('hits', 28, 14), alive: 250 }, entry('ailments', 7, 14)]);
    const written = checkBench(slower, RECORDED, KNOWN, true);
    expect(written.ok).toBe(false);
    expect(written.lines[0]).toMatch(/^hits: .*, outside 280–320 alive, not recorded: FAILED$/);
    expect(written.baseline.ratios).toEqual({ ...RECORDED.ratios, ailments: 0.5 });
  });

  it('throws on an entry bench.ts does not know', () => {
    expect(() => checkBench(timings([entry('chainStorm', 1, 1)]), RECORDED, KNOWN, false)).toThrow(
      /chainStorm/,
    );
  });
});

describe('parseBaseline', () => {
  it('reads what formatBaseline writes', () => {
    expect(parseBaseline(formatBaseline(RECORDED))).toEqual(RECORDED);
  });

  it('rejects a file without positive ratios', () => {
    expect(() => parseBaseline('[]')).toThrow(/expected/);
    expect(() => parseBaseline('{"hits": 1}')).toThrow(/expected/);
    expect(() => parseBaseline('{"ratios": {"hits": 0}}')).toThrow(/'hits'/);
    expect(() => parseBaseline('{"ratios": {"hits": "1"}}')).toThrow(/'hits'/);
  });
});

describe('bench.baseline.json', () => {
  it('records a ratio for exactly the entries bench --check times', () => {
    const recorded = parseBaseline(readFileSync(BASELINE_FILE, 'utf8'));
    expect(Object.keys(recorded.ratios)).toEqual(CHECK_ENTRIES);
    expect(CHECK_ENTRIES).toEqual([
      'hits',
      'ailments',
      'effects',
      'poisonBoss (500 stacks)',
      'poisonBoss (5 stacks)',
      'stressM1',
      'stress',
      'shots',
      'fan',
      'arc',
      'hive',
      'stressBase',
      'grants',
      'v3fire',
    ]);
  });
});
