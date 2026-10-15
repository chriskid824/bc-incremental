/**
 * Import order (docs/v3 C4 design §0.7). rules/index.ts reads the signature and rule modules'
 * consts at its top level (SIGNATURES, RULE_MODULES), and systems/context.ts reaches it through
 * build/compile.ts. That is safe only while no rules module value-imports anything that reaches
 * systems/context.ts: entered from such a module, index.ts would run before that module's body
 * and read its const in the temporal dead zone, a ReferenceError natively and `undefined` under
 * Vitest. So each rules module is imported first into a fresh module registry, then
 * rules/index.ts and systems/context.ts, and every registry entry must be defined.
 */

import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/** Every module of src/sim/rules but index.ts and the tests, by name without its extension. */
const MODULES = readdirSync(new URL('.', import.meta.url))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'index.ts')
  .map((file) => file.slice(0, -'.ts'.length))
  .sort();

describe('rules module import order', () => {
  it('covers the signature and rule modules', () => {
    expect(MODULES).toContain('m1Volley');
    expect(MODULES).toContain('overload');
  });

  it.each(MODULES)('defines every registry entry when %s is imported first', async (name) => {
    vi.resetModules();
    // A computed path: @vite-ignore keeps Vite from rewriting it into a glob of this directory.
    await import(/* @vite-ignore */ `./${name}`);
    const { RULE_MODULES, SIGNATURES } = await import('./index');
    await import('../systems/context');
    for (const [id, module] of Object.entries(SIGNATURES)) expect(module, id).toBeDefined();
    for (const [id, module] of Object.entries(RULE_MODULES)) expect(module, id).toBeDefined();
  });
});
