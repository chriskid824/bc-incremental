/**
 * The content check's --stubs (docs/v3 C6 design §4.11, V17): the keys V17 says are missing are
 * read off its messages, by the web JSON file each is missing in, and a stub is a TODO for each
 * key a file lacks, which V17 then fails as a TODO, not as missing. V17's messages are read only
 * through missingKeys, so the tests hold whatever its text says around the key and the file.
 * checkContent counts every issue but the fixture's missing V9 entries (the lead's ruling R8),
 * V25's included, and npm run content, run in-process as `tsx tools/content/check.ts` runs it,
 * exits 1 on an issue.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { assembleWeb, FULL_SCOPE } from '../../src/data/web';
import type { Content } from '../../src/data/web';
import { fixtureContent } from '../../src/data/web/testing';
import type * as TestingModule from '../../src/data/web/testing';
import { LOCALES } from '../../src/i18n';
import { textIssues } from '../../src/ui/web/check';
import { fixtureLookups, fixtureMessages } from '../../src/ui/web/testing';
import { checkContent, missingKeys, stubbedText } from './check';
import type { CheckSource } from './check';

/** While `content` is set, fixtureContent() returns it: the fixture npm run content -- --fixture checks. */
const planted = vi.hoisted(() => ({ content: null as Content | null }));
vi.mock('../../src/data/web/testing', async (importOriginal) => {
  const actual = await importOriginal<typeof TestingModule>();
  return {
    ...actual,
    fixtureContent: (...args: Parameters<typeof actual.fixtureContent>) =>
      planted.content ?? actual.fixtureContent(...args),
  };
});

const REPO = new URL('../../', import.meta.url);

describe('--stubs (V17)', () => {
  it('finds the key V17 says is missing, and its stub turns the issue into a TODO', () => {
    const web = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);
    const messages = fixtureMessages();
    const key = 'web.fusion.fire.poison.title';
    const { [key]: dropped, ...lacking } = messages['zh-TW'];
    expect(dropped).toBeDefined();
    const missing = missingKeys(
      textIssues([web], fixtureLookups({ ...messages, 'zh-TW': lacking })),
    );
    const [file, ...others] = [...missing.keys()];
    expect(others).toEqual([]);
    // The file --stubs writes: the repo's zh-TW web JSON.
    expect(file).toMatch(/zh-TW\.json$/);
    expect(existsSync(new URL(file as string, REPO))).toBe(true);
    expect(missing.get(file as string)).toContain(key);

    const stubs = stubbedText(JSON.stringify(lacking), [key]);
    const stubbed = JSON.parse(stubs) as Record<string, string>;
    expect(stubbed[key]).toBe('TODO');
    const after = textIssues([web], fixtureLookups({ ...messages, 'zh-TW': stubbed }));
    expect(missingKeys(after).size).toBe(0);
    expect(after.some((issue) => issue.includes(key))).toBe(true);
  });

  it('adds a TODO after the keys for each key a file lacks, and rewrites nothing else', () => {
    const text = '{\n  "web.a": "A",\n  "web.c": "C"\n}\n';
    expect(stubbedText(text, ['web.b', 'web.a'])).toBe(
      '{\n  "web.a": "A",\n  "web.c": "C",\n  "web.b": "TODO"\n}\n',
    );
    for (const locale of LOCALES) {
      const shipped = readFileSync(new URL(`src/i18n/web.${locale}.json`, REPO), 'utf8');
      expect(stubbedText(shipped, [])).toBe(shipped);
    }
  });
});

const FIXTURE_SNAPSHOTS = new URL('../../src/data/web/snapshots/fixture/', import.meta.url);

/** `content` as npm run content -- --fixture checks the fixture (R8). */
const fixtureSource = (content: Content): CheckSource => ({
  name: 'fixture',
  content,
  firstPick: 'fire',
  lookups: fixtureLookups(),
  stored: (name) => {
    const file = new URL(name, FIXTURE_SNAPSHOTS);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  },
  renames: {},
  fixture: true,
});

/**
 * The fixture with two faults: 熔核's defaultOrder starting two steps from the root (V25), and
 * fire.crit calibrated for fire.poison's digest, a stale entry (V9).
 */
function faulty(): Content {
  const content = fixtureContent();
  const fire = { ...content.characters.fire, defaultOrder: ['fire.center.alpha.r2'] };
  const digest = assembleWeb(content, 'fire', FULL_SCOPE).fusions.get('poison')?.digest as string;
  const crit = {
    coef: 1,
    status: 'ok',
    median: 1.2,
    min: 1.1,
    max: 1.3,
    seeds: 8,
    startWave: 1,
  } as const;
  return {
    ...content,
    characters: { ...content.characters, fire },
    calibrated: { 'fire.crit': { ...crit, digest } },
  };
}

/** check.ts run as `npm run content -- <args>`, in-process: its exit code and what it printed. */
async function npmRunContent(
  args: readonly string[],
): Promise<{ readonly exitCode: typeof process.exitCode; readonly lines: readonly string[] }> {
  const { argv, exitCode } = process;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    process.argv = [
      argv[0] as string,
      fileURLToPath(new URL('./check.ts', import.meta.url)),
      ...args,
    ];
    process.exitCode = undefined;
    vi.resetModules();
    await import('./check');
    return { exitCode: process.exitCode, lines: log.mock.calls.map(([text]) => String(text)) };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    log.mockRestore();
  }
}

describe('checkContent and npm run content (§4.8, §4.11; R8)', () => {
  it("counts every issue but the fixture's missing V9 entries, V25's included", () => {
    const checked = checkContent(fixtureSource(faulty()));
    expect(checked.issues).toEqual([
      expect.stringMatching(
        /^fusion 'fire\.crit' \(src\/data\/fusion\/calibrated\.ts\): calibrated for digest /,
      ),
      "character 'fire' defaultOrder[0] 'fire.center.alpha.r2' (src/data/characters/fire.ts): " +
        'notAdjacent; move it after one of its neighbours',
    ]);
    // Only the fixture's missing entries are expected (R8): the stale one is an issue.
    expect(checked.expected).toHaveLength(43);
  }, 30_000);

  it('exits 1 on an issue, and refuses --stubs with --fixture (R8)', async () => {
    planted.content = faulty();
    const failed = await npmRunContent(['--fixture']).finally(() => {
      planted.content = null;
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.lines).toContain('fixture (src/data/web/testing.ts): 2 issues:');
    const refused = await npmRunContent(['--fixture', '--stubs']);
    expect(refused).toEqual({
      exitCode: 1,
      lines: [
        'npm run content: --stubs writes stubs for the registered content only; drop --fixture',
      ],
    });
  }, 30_000);
});
