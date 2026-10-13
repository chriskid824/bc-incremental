import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

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

export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
  },
});
