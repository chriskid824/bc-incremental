/**
 * npm run fuzz:web's exit code (docs/v3 C6 design §4.9, §4.11; G12): run in-process as
 * `tsx tools/content/fuzzWeb.ts` runs it, the tool exits 1 when a build fails and when a set
 * cannot run, and 0 when every build passes. bench.ts' normal scenario, which the tool times
 * first, is cut to one short run here.
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { num } from '../../src/core/num';
import { loadGameData } from '../../src/data';
import { fixtureContent } from '../../src/data/web/testing';
import { runWebFuzz } from '../../src/meta/web/fuzz';
import type * as FuzzModule from '../../src/meta/web/fuzz';
import type { TestModule } from '../../src/sim/rules';
import type * as BenchModule from '../balance/bench';
import { webFuzzLines } from './fuzzWeb';

/** While `on`, build 1 of every runWebFuzz call sets an enemy's hp to NaN at tick 10. */
const plant = vi.hoisted(() => ({ on: false }));

vi.mock('../../src/meta/web/fuzz', async (importOriginal) => {
  const actual = await importOriginal<typeof FuzzModule>();
  const nan: TestModule = (b) => {
    let done = false;
    b.hook('tick', (ctx) => {
      const enemy = ctx.enemies[0];
      if (done || ctx.now < 10 || enemy === undefined) return;
      enemy.hp = num(NaN);
      done = true;
    });
  };
  return {
    ...actual,
    runWebFuzz: (options: FuzzModule.WebFuzzOptions) =>
      actual.runWebFuzz(
        plant.on ? { ...options, modules: (draw) => (draw.index === 1 ? [nan] : []) } : options,
      ),
  };
});

vi.mock('../balance/bench', async (importOriginal) => {
  const actual = await importOriginal<typeof BenchModule>();
  const { normal } = actual.SCENARIOS;
  return {
    ...actual,
    SCENARIOS: {
      ...actual.SCENARIOS,
      normal: {
        ...normal,
        warmup: 0,
        runs: 1,
        config: (...args: Parameters<typeof normal.config>) => ({
          ...normal.config(...args),
          maxTicks: 10,
        }),
      },
    },
  };
});

/** The tool run as `npm run fuzz:web -- <args>`, in-process: its exit code and what it printed. */
async function fuzzWeb(
  args: readonly string[],
): Promise<{ readonly exitCode: typeof process.exitCode; readonly lines: readonly string[] }> {
  const { argv, exitCode } = process;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    process.argv = [
      argv[0] as string,
      fileURLToPath(new URL('./fuzzWeb.ts', import.meta.url)),
      ...args,
    ];
    process.exitCode = undefined;
    vi.resetModules();
    await import('./fuzzWeb');
    return {
      exitCode: process.exitCode,
      lines: log.mock.calls.flatMap(([text]) => String(text).split('\n')),
    };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    log.mockRestore();
  }
}

describe('npm run fuzz:web (§4.9, G12)', () => {
  it('exits 1 on a failing build, and 0 when every build passes', async () => {
    const args = ['--fixture', '--builds', '3', '--ticks', '30'];
    plant.on = true;
    const failed = await fuzzWeb(args).finally(() => {
      plant.on = false;
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.lines).toContainEqual(
      expect.stringMatching(
        /^FAIL nonFinite: fuzz build 1 \(character 'fire', scope 'demoA'\): tick 10: enemy \d+ hp NaN$/,
      ),
    );
    expect(failed.lines.at(-1)).toMatch(/^web fuzz: FAILED; /);
    const passed = await fuzzWeb(args);
    expect(passed.exitCode).toBeUndefined();
    expect(passed.lines).toContain('web fuzz, fixture (src/data/web/testing.ts): passed');
    expect(passed.lines.at(-1)).toMatch(/^web fuzz: passed; /);
  });

  it('exits 1 when a set cannot run: --only naming a build dealt to another web', async () => {
    const refused = await fuzzWeb(['--fixture', '--ticks', '30', '--only', 'fire.full.10']);
    expect(refused.exitCode).toBe(1);
    expect(refused.lines).toContain(
      "web fuzz, fixture (src/data/web/testing.ts): runWebFuzz: --only 'fire.full.10': build 10 " +
        "is dealt to 'fire.demoB'",
    );
    expect(refused.lines.at(-1)).toMatch(/^web fuzz: FAILED; /);
  });
});

describe("the report's failures and peaks lines (R11)", () => {
  it('counts the failures by the kinds the web fuzz makes, and gives each peak against its limit', () => {
    const report = runWebFuzz({
      content: fixtureContent(),
      data: loadGameData(),
      builds: 2,
      ticks: 10,
      fixture: true,
    });
    const kinds = ['nonFinite', 'cap', 'threw', 'hash', 'dropped', 'budget', 'enemies'] as const;
    const failures = kinds.flatMap((kind, i) =>
      Array.from({ length: i + 1 }, () => ({ kind, text: kind, repro: 'repro', ids: [] })),
    );
    const { lines } = webFuzzLines('fixture', { ...report, failures }, 1, 1);
    expect(lines).toContain(
      'failures: NaN/Infinity 1, caps 2, threw 3, hash mismatches 4, dropped 5, budget 6, ' +
        'enemies 7 (a warning until C7, D31)',
    );
    expect(lines.find((line) => line.startsWith('peaks: '))).toMatch(
      /^peaks: alive \d+ of ALIVE_WARNING 400 \(fire\.(full|demoA)\.[01]\); summons \d+ of SUMMON_CAP 24 \(\S+\); in flight \d+ of PROJECTILE_CAP 512 \(\S+\); chain hits \d+ of CHAIN_HIT_CAP 32 \(\S+\); effect queue \d+ \(\S+\); budget streak \d+, below 30 \(\S+\)$/,
    );
  });
});
