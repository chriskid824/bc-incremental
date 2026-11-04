import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { parseRelease } from './electron/release';

/**
 * The Electron shell's build (docs/v3 C9 design §1.6): `vite build --config
 * vite.electron.config.ts --mode main` makes dist-electron/main.cjs, then `--mode preload` adds
 * preload.cjs beside it (`npm run build:electron`, after the page's `vite build --mode steam`).
 * Each is one CommonJS file for Node 22+; Electron, steamworks.js and Node's built-ins stay
 * require() calls, so the sandboxed preload requires nothing but `electron`. Paths are anchored at
 * this file's folder, not the working directory.
 */

const ROOT = fileURLToPath(new URL('.', import.meta.url));

const ENTRIES = { main: 'electron/main.ts', preload: 'electron/preload.ts' } as const;

const EXTERNAL = [
  'electron',
  'steamworks.js',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

export default defineConfig(({ mode }) => {
  if (mode !== 'main' && mode !== 'preload') {
    throw new Error(`vite.electron.config.ts builds --mode main or --mode preload, not '${mode}'`);
  }
  // BC_RELEASE picks the Steam app and page (electron/release.ts); a bad value fails here.
  const release = parseRelease(process.env['BC_RELEASE']);
  return {
    root: ROOT,
    define: { __BC_RELEASE__: JSON.stringify(release) },
    publicDir: false,
    build: {
      target: 'node22',
      outDir: 'dist-electron',
      // The main run starts the folder afresh; the preload run adds its file beside main.cjs.
      emptyOutDir: mode === 'main',
      minify: false,
      lib: { entry: ENTRIES[mode], formats: ['cjs'], fileName: () => `${mode}.cjs` },
      rollupOptions: { external: EXTERNAL },
    },
  };
});
