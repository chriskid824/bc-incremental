/**
 * The calibration table's writer (docs/v3 C6 design B-1, §4.10; the lead's ruling R4): the
 * written file is sorted by key and stable, the same text from any order of its entries and a
 * second write of what it wrote identical, laid out as Prettier leaves it; the repo's
 * src/data/fusion/calibrated.ts is its output for CALIBRATED (C6.4's file while the table is
 * empty). --stale picks the fusions with no entry or a stale digest. npm run calibrate, run
 * in-process as `tsx tools/content/calibrate.ts` runs it on the fixture's fusions, with
 * calibrateFusion and the file's write stubbed, calibrates the fusion --only names and exits 1 on
 * a FAIL without an ACCEPTED_FAILS reason (F21, D10).
 */

import { readFileSync } from 'node:fs';
import type * as FsModule from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it, vi } from 'vitest';
import { CALIBRATED } from '../../src/data/fusion/calibrated';
import type { GameData } from '../../src/data/types';
import { loadContent } from '../../src/data/web';
import type { CalibrationEntry, Content, FusionKey } from '../../src/data/web';
import type * as WebModule from '../../src/data/web';
import { fixtureContent } from '../../src/data/web/testing';
import type { CalibrateOptions, CalibrationResult } from '../../src/meta/web/calibrate';
import type * as CalibrateModule from '../../src/meta/web/calibrate';
import { CALIBRATED_FILE, calibratedSource, fusionDigests, keysToCalibrate } from './calibrate';
import type { CalibrationTable } from './calibrate';

/**
 * The tool's stubs: the content loadContent returns while set, calibrateFusion (its status
 * `status`) and writeFileSync, which never writes in this file.
 */
const tool = vi.hoisted(() => ({
  content: null as Content | null,
  status: 'ok' as CalibrationEntry['status'],
  calibrate: vi.fn(),
  write: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof FsModule>()),
  writeFileSync: tool.write,
}));

vi.mock('../../src/data/web', async (importOriginal) => {
  const actual = await importOriginal<typeof WebModule>();
  return { ...actual, loadContent: () => tool.content ?? actual.loadContent() };
});

vi.mock('../../src/meta/web/calibrate', async (importOriginal) => ({
  ...(await importOriginal<typeof CalibrateModule>()),
  calibrateFusion: tool.calibrate,
}));

const entry = (
  coef: number,
  digest: string,
  status: CalibrationEntry['status'] = 'ok',
): CalibrationEntry => ({
  coef,
  status,
  median: 1.2034,
  min: 1.1102,
  max: 1.2987,
  seeds: 8,
  startWave: 1,
  digest,
});

const ENTRIES: readonly (readonly [FusionKey, CalibrationEntry])[] = [
  ['summon.fire', entry(0.873, 'a'.repeat(64))],
  ['fire.poison', entry(1.98, 'b'.repeat(64), 'weak')],
  ['ice.fire', entry(0.1, 'c'.repeat(64), 'strong')],
  ['fire.ice', { ...entry(1, 'd'.repeat(64), 'insensitive'), median: 1.0012, min: 0.9851 }],
  ['lightning.barrage', entry(2.37, 'e'.repeat(64), 'spread')],
];
const TABLE: CalibrationTable = Object.fromEntries(ENTRIES);

/** The table a written file holds: its object literal, evaluated. */
function parsed(text: string): CalibrationTable {
  const literal = /= (\{[\s\S]*\});\n$/.exec(text)?.[1];
  if (literal === undefined) throw new Error('no CALIBRATED literal');
  return new Function(`return ${literal};`)() as CalibrationTable;
}

describe('calibratedSource (B-1, R4)', () => {
  it('writes the entries sorted by key, the same text from any order', () => {
    const text = calibratedSource(TABLE);
    expect(calibratedSource(Object.fromEntries([...ENTRIES].reverse()))).toBe(text);
    expect([...text.matchAll(/^ {2}'([a-z.]+)': \{$/gm)].map((match) => match[1])).toEqual([
      'fire.ice',
      'fire.poison',
      'ice.fire',
      'lightning.barrage',
      'summon.fire',
    ]);
  });

  it('reads back as what it wrote, and a second write is identical', () => {
    const text = calibratedSource(TABLE);
    expect(parsed(text)).toEqual(TABLE);
    expect(calibratedSource(parsed(text))).toBe(text);
    expect(parsed(calibratedSource({}))).toEqual({});
  });

  it('lays the file out as Prettier leaves it, empty or not', async () => {
    const filepath = fileURLToPath(CALIBRATED_FILE);
    const options = { ...(await resolveConfig(filepath)), filepath };
    for (const table of [{}, TABLE]) {
      const text = calibratedSource(table);
      expect(await format(text, options)).toBe(text);
    }
  });

  it("is src/data/fusion/calibrated.ts for CALIBRATED, C6.4's file while the table is empty (R4)", () => {
    expect(calibratedSource(CALIBRATED)).toBe(readFileSync(CALIBRATED_FILE, 'utf8'));
    // The header says the table is empty only while it is.
    expect(calibratedSource({})).toContain("Empty until B1's\n * fusions are calibrated.\n */");
    expect(calibratedSource(TABLE)).not.toContain('Empty until');
  });
});

describe('keysToCalibrate', () => {
  it('picks every fusion with no entry or a stale digest for --stale, every one for --all', () => {
    const content = fixtureContent();
    const digests = fusionDigests(content);
    const all = [...digests.keys()].sort();
    expect(all).toHaveLength(44);
    const fresh = entry(1.2, digests.get('fire.ice') as string);
    const stale = entry(1.2, 'f'.repeat(64));
    const calibrated = { 'fire.ice': fresh, 'fire.poison': stale };
    const withTable = { ...content, calibrated };
    expect(keysToCalibrate(withTable, 'all')).toEqual(all);
    expect(keysToCalibrate(withTable, 'stale')).toEqual(all.filter((key) => key !== 'fire.ice'));
    expect(keysToCalibrate(content, 'stale')).toEqual(all);
  });
});

/** calibrateFusion's stub: fusion `key` of `content` at coef 10, its status `tool.status`. */
function calibrated(
  content: Content,
  key: FusionKey,
  _data: GameData,
  options: CalibrateOptions = {},
): CalibrationResult {
  return {
    key,
    kind: 'template',
    range: [0.1, 10],
    entry: {
      coef: 10,
      status: tool.status,
      median: 1.1,
      min: 1.05,
      max: 1.15,
      seeds: options.seeds ?? 8,
      startWave: 1,
      digest: fusionDigests(content).get(key) as string,
    },
    readings: [],
    baseFrontiers: [],
    runs: 4,
    ticks: 100,
    timeouts: 0,
  };
}

/** The tool run as `npm run calibrate -- <args>` on `content`, in-process. */
async function npmRunCalibrate(
  content: Content,
  args: readonly string[],
): Promise<{ readonly exitCode: typeof process.exitCode; readonly lines: readonly string[] }> {
  const { argv, exitCode } = process;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  tool.content = content;
  tool.calibrate.mockReset().mockImplementation(calibrated);
  tool.write.mockReset();
  try {
    process.argv = [
      argv[0] as string,
      fileURLToPath(new URL('./calibrate.ts', import.meta.url)),
      ...args,
    ];
    process.exitCode = undefined;
    vi.resetModules();
    // The write is stubbed before the tool runs, or the test stops here.
    expect(vi.isMockFunction((await import('node:fs')).writeFileSync)).toBe(true);
    await import('./calibrate');
    return { exitCode: process.exitCode, lines: log.mock.calls.map(([text]) => String(text)) };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    tool.content = null;
    log.mockRestore();
  }
}

describe('npm run calibrate (D10, F21)', () => {
  it('calibrates the fusion --only names and writes the table with its entry', async () => {
    const content = fixtureContent();
    const run = await npmRunCalibrate(content, ['--only', 'fire.crit', '--seeds', '2']);
    expect(tool.calibrate.mock.calls.map(([, key, , options]) => [key, options])).toEqual([
      ['fire.crit', { seeds: 2 }],
    ]);
    const entry = calibrated(content, 'fire.crit', {} as GameData, { seeds: 2 }).entry;
    expect(tool.write.mock.calls.map(([file, text]) => [String(file), text])).toEqual([
      [CALIBRATED_FILE.href, calibratedSource({ 'fire.crit': entry })],
    ]);
    expect(run.exitCode).toBeUndefined();
    expect(run.lines.at(-1)).toBe(
      'wrote src/data/fusion/calibrated.ts (changed): 1 entry, 1 calibrated now',
    );
  });

  it('exits 1 when a fusion it calibrated is not ok and has no ACCEPTED_FAILS reason', async () => {
    const content = fixtureContent();
    tool.status = 'weak';
    try {
      const failed = await npmRunCalibrate(content, ['--only', 'fire.crit']);
      expect(failed.exitCode).toBe(1);
      expect(failed.lines.at(-1)).toBe(
        'npm run calibrate FAILED: fire.crit not ok, with no ACCEPTED_FAILS reason ' +
          '(src/data/fusion/overrides.ts); rework the fusion or give the reason',
      );
      // The table is written all the same, so the FAIL's entry waits for its reason (D10).
      expect(tool.write).toHaveBeenCalledTimes(1);
      const reasoned = { ...content, acceptedFails: { 'fire.crit': 'accepted for the batch' } };
      expect((await npmRunCalibrate(reasoned, ['--only', 'fire.crit'])).exitCode).toBeUndefined();
      // Another fusion's reason is not this one's, and a blank reason is none.
      for (const acceptedFails of [{ 'fire.poison': 'accepted' }, { 'fire.crit': '  ' }]) {
        const run = await npmRunCalibrate({ ...content, acceptedFails }, ['--only', 'fire.crit']);
        expect(run.exitCode).toBe(1);
      }
    } finally {
      tool.status = 'ok';
    }
  });

  it('leaves the table unwritten when its text is unchanged (R13)', async () => {
    // The registered content: no fusion to calibrate before B1, every entry fresh after it (V9),
    // so the table's text is the file's.
    const run = await npmRunCalibrate(loadContent(), []);
    expect(tool.calibrate).not.toHaveBeenCalled();
    expect(tool.write).not.toHaveBeenCalled();
    expect(run.lines.at(-1)).toMatch(
      /^wrote src\/data\/fusion\/calibrated\.ts \(unchanged\): \d+ entr(y|ies), 0 calibrated now$/,
    );
  });
});
