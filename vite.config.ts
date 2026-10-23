import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { parseFlavor } from './src/platform/flavor';

/** Names the build in playtest events, so their data can be split by version. */
function buildId(): string {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] });
    return `${version}+${sha.toString().trim()}`;
  } catch {
    return `${version}+dev`;
  }
}

export default defineConfig(({ mode }) => {
  // A VITE_FLAVOR other than demo or full fails here, before any build or server starts.
  parseFlavor(loadEnv(mode, process.cwd(), 'VITE_').VITE_FLAVOR);
  return {
    base: './',
    define: {
      __BUILD_ID__: JSON.stringify(buildId()),
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      // `vite build --mode steam` makes the Steam build's page (src/platform/index.ts).
      outDir: mode === 'steam' ? 'dist-steam' : 'dist',
    },
    test: {
      include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'tools/**/*.test.ts'],
      environment: 'node',
    },
  };
});
