/**
 * The platform is chosen when the build is made (docs/v3 C9 design §1.7, C9/F9): Vite builds
 * src/platform/index.ts for a mode with MODE as a literal, and Rollup drops the other platform's
 * modules. So the web build carries nothing of the Steam bridge, and the Steam build no
 * localStorage save. A module under ./steam that runs anything on import would stay in the web
 * build, so the modules each bundle holds are checked as well as its text. The builds run with
 * NODE_ENV production, as `vite build` sets it, so the page's PROD and DEV are the real builds'.
 */

import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface Bundle {
  /** Every chunk's code. */
  readonly code: string;
  /** The modules the chunks hold, relative to the repo root. */
  readonly modules: readonly string[];
}

/** src/platform/index.ts built as a library in `mode`, unminified, in memory. */
async function bundle(mode: 'production' | 'steam'): Promise<Bundle> {
  vi.stubEnv('NODE_ENV', 'production');
  const result = await build({
    configFile: false,
    root: ROOT,
    mode,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/platform/index.ts', formats: ['es'] },
    },
  });
  const chunks = (Array.isArray(result) ? result : [result])
    .flatMap((output) => ('output' in output ? output.output : []))
    .flatMap((file) => (file.type === 'chunk' ? [file] : []));
  return {
    code: chunks.map((chunk) => chunk.code).join('\n'),
    modules: chunks
      .flatMap((chunk) => Object.keys(chunk.modules))
      .map((id) => relative(ROOT, id).replaceAll('\\', '/'))
      .sort(),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// Each build takes well under a second, more on a busy machine.
describe('build-time platform selection', { timeout: 60_000 }, () => {
  it('builds the web platform alone in the web build (mode production)', async () => {
    const web = await bundle('production');
    expect(web.modules).toEqual([
      'src/platform/achievements.ts',
      'src/platform/index.ts',
      'src/platform/platform.ts',
      'src/platform/storage.ts',
      'src/platform/web.ts',
    ]);
    expect(web.code).toContain('bc-incremental.save.');
    expect(web.code).not.toContain('bcNative');
    // Nor anything of the check mode (C9 design §2.2).
    expect(web.code).not.toContain('data-check');
    expect(web.code).not.toContain('bc-incremental steam check');
  });

  it('builds the Steam platform alone in the steam build, with no localStorage save', async () => {
    const steam = await bundle('steam');
    expect(steam.modules).toEqual([
      'src/platform/achievements.ts',
      'src/platform/index.ts',
      'src/platform/platform.ts',
      'src/platform/steam/bridge.ts',
      'src/platform/steam/checkPanel.ts',
      'src/platform/steam/index.ts',
      'src/platform/steam/report.ts',
    ]);
    expect(steam.code).toContain('bcNative');
    expect(steam.code).toContain('bc-incremental steam check v1');
    expect(steam.code).not.toContain('bc-incremental.save.');
  });
});
