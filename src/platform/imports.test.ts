/**
 * Nothing under src/ imports Electron, steamworks.js or the shell's own code in electron/ (docs/v3
 * C9 design §1.7): the page is the same in a browser and in the shell's sandboxed renderer, and it
 * reaches the shell only through the bridge (./steam/bridge.ts). An `electron` import that a test
 * ran would also fetch Electron's binary (C9/F1). TypeScript's own scanner reads each file's
 * imports: static, type-only, dynamic, require() and triple-slash references alike.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The packages the page must not load; their subpaths count too. */
const PACKAGES = ['electron', 'steamworks.js'];
/** The shell's directory at the repo root. */
const SHELL = 'electron';

/** Every module `source` names: imports, re-exports, import(), require() and references. */
function specifiers(source: string): string[] {
  const { importedFiles, referencedFiles, typeReferenceDirectives } = ts.preProcessFile(
    source,
    true,
    true,
  );
  return [...importedFiles, ...referencedFiles, ...typeReferenceDirectives].map(
    (reference) => reference.fileName,
  );
}

/** Whether `specifier`, named in `file` (relative to the root), reaches a package or the shell. */
function forbidden(file: string, specifier: string): boolean {
  const path = specifier.split('?')[0] as string;
  if (!path.startsWith('.') && !path.startsWith('/')) {
    return PACKAGES.some((name) => path === name || path.startsWith(`${name}/`));
  }
  const target = path.startsWith('/')
    ? resolve(ROOT, path.slice(1))
    : resolve(ROOT, dirname(file), path);
  const fromRoot = relative(ROOT, target).replaceAll('\\', '/');
  return fromRoot === SHELL || fromRoot.startsWith(`${SHELL}/`);
}

/** The specifiers in `source`, named in `file`, that reach a package or the shell. */
function forbiddenImports(file: string, source: string): string[] {
  return specifiers(source).filter((specifier) => forbidden(file, specifier));
}

describe('the page reaches the Electron shell only through the bridge', () => {
  it('no module under src/ imports electron, steamworks.js or electron/', () => {
    const files = readdirSync(resolve(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .map((path) => posix.join('src', path.replaceAll('\\', '/')))
      .filter((path) => /\.(ts|tsx|js|mjs|cjs)$/.test(path))
      .sort();
    expect(files).toEqual(
      expect.arrayContaining([
        'src/app/main.ts',
        'src/env.d.ts',
        'src/platform/index.ts',
        'src/platform/steam/bridge.ts',
        'src/platform/steam/index.ts',
        'src/platform/imports.test.ts',
      ]),
    );
    const found = files.flatMap((file) =>
      forbiddenImports(file, readFileSync(resolve(ROOT, file), 'utf8')).map(
        (specifier) => `${file}: ${specifier}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('reads every form of import, and no comment or string', () => {
    const source = [
      '/// <reference types="electron" />',
      '/// <reference path="../../../electron/types.d.ts" />',
      "import { app } from 'electron';",
      "import type { IpcRenderer } from 'electron';",
      "import { ipcRenderer } from 'electron/renderer';",
      "import 'electron/main';",
      "export { shell } from 'electron/common';",
      "export * from 'steamworks.js';",
      "export type { Client } from 'steamworks.js/client';",
      'import {',
      '  dialog, // a trailing comment',
      "} from 'electron/utility';",
      "const steamworks = await import('steamworks.js/dynamic');",
      "const electron = require('electron/required');",
      "type Shell = typeof import('electron/typeof');",
      "import { CHANNELS } from '../../../electron/channels';",
      "import { main } from '/electron/main';",
      "import { shellDir } from '../../../electron';",
      "import { BRIDGE } from './bridge';",
      "import { near } from './electron';",
      "import { local } from '../../electron/x';",
      "import { store } from 'electron-store';",
      "import { json } from 'steamworks.json';",
      "import { files } from '../../../electron-files/x';",
      "// import { app } from 'electron/comment';",
      "/* import { app } from 'electron/block'; */",
      'const text = "import { app } from \'electron/string\'";',
    ].join('\n');
    expect(forbiddenImports('src/platform/steam/probe.ts', source)).toEqual([
      'electron',
      'electron',
      'electron/renderer',
      'electron/main',
      'electron/common',
      'steamworks.js',
      'steamworks.js/client',
      'electron/utility',
      'steamworks.js/dynamic',
      'electron/required',
      'electron/typeof',
      '../../../electron/channels',
      '/electron/main',
      '../../../electron',
      '../../../electron/types.d.ts',
      'electron',
    ]);
  });
});
