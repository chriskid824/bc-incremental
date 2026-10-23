/**
 * The replay page writes no storage, sends no playtest event and calls no platform API (docs/v3
 * C10 design §1.7; the lead's ruling J3), so the Steam shell can open it (--bc-replay) and a dev
 * page leaves the player's save and the playtest log alone. The guard follows every module the
 * replay's modules load, in turn, through src/ (type-only imports load nothing): none of them is
 * the platform, the save or the page's playtest wiring, and none names a browser store or a
 * request. replaySmoke checks the same on the page itself (tools/sheets/replaySmoke.ts).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REPLAY = 'src/app/replay';

/** What the replay must not load: the platform, the save, and the M1 page and its playtest. */
const FORBIDDEN = [/^src\/platform\//, /^src\/save\//, /^src\/app\/(main|session|playtest)\.ts$/];
/** The stores and requests a page could write or send through. */
const SENDS =
  /\b(localStorage|sessionStorage|indexedDB|fetch|sendBeacon|XMLHttpRequest|WebSocket)\b|\bdocument\s*\.\s*cookie\b/g;

/** Comments blanked out, as src/data/web/isolation.test.ts reads code. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');

/** Static, re-exported, bare and dynamic specifiers; not type-only ones, which load nothing. */
const SPECIFIER =
  /^\s*(?:import|export)\s+(?!type\s)[^'"]*?\sfrom\s+(['"])([^'"]+)\1|^\s*import\s+(['"])([^'"]+)\3|\bimport\(\s*(['"])([^'"]+)\5\s*\)/gm;

/** The repo-relative .ts file a relative `specifier` of `file` loads; null for a package or JSON. */
function resolveImport(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = relative(ROOT, resolve(ROOT, dirname(file), specifier)).replaceAll('\\', '/');
  for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
    if (candidate.endsWith('.ts') && existsSync(resolve(ROOT, candidate))) return candidate;
  }
  return null;
}

/** Every src module the replay's own modules load, in turn, with the replay's own. */
function closure(): string[] {
  const start = readdirSync(resolve(ROOT, REPLAY), { encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => posix.join(REPLAY, name));
  const seen = new Set(start);
  const queue = [...start];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const source = code(readFileSync(resolve(ROOT, file), 'utf8'));
    for (const match of source.matchAll(SPECIFIER)) {
      const next = resolveImport(file, (match[2] ?? match[4] ?? match[6]) as string);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen].sort();
}

describe('the replay page (docs/v3 C10 design §1.7, the lead’s ruling J3)', () => {
  const modules = closure();

  it('follows the replay’s imports into the renderer, the sim and the data', () => {
    expect(modules).toEqual(
      expect.arrayContaining([
        'src/app/replay/route.ts',
        'src/app/replay/replay.ts',
        'src/app/typicalHit.ts',
        'src/app/loop.ts',
        'src/render/renderer.ts',
        'src/sim/index.ts',
        'src/data/web/index.ts',
      ]),
    );
  });

  it('loads neither the platform, nor the save, nor the M1 page and its playtest', () => {
    expect(modules.filter((file) => FORBIDDEN.some((pattern) => pattern.test(file)))).toEqual([]);
  });

  it('names no browser store and no request in any module it loads', () => {
    const found = modules.flatMap((file) =>
      [...code(readFileSync(resolve(ROOT, file), 'utf8')).matchAll(SENDS)].map(
        (match) => `${file}: ${match[0]}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
