/**
 * Import order for content (docs/v3 C6 design L8, §2.3). The registries are module-level consts:
 * the content files fill theirs by calling templates.ts' builders at their top level, and the
 * builders read templates.ts' own consts (BRANCH_CLOCKS, KEYSTONE_CLOCKS, THRESHOLD_CLOCK,
 * NOTABLE_STEPS, slugOf); fusion/generate.ts computes HAND_PAIRS, HAND_RANKS and EMPTY_RANKS at its
 * top level from CHARACTER_IDS and those builders. That is safe only while no module of the v3
 * web sits in a value-import cycle: entered from inside one, a content file would run before
 * templates.ts' body and meet a const in the temporal dead zone (a ReferenceError natively, an
 * `undefined` import under Vitest). So each module is imported first into a fresh module
 * registry, then loadContent() runs and the fixture is built and validated through the same
 * registry, and every registry entry must be defined.
 */

import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/** The v3 web's modules but the tests, as paths from this directory without their extension. */
const MODULES = [
  ...['web', 'characters', 'outer', 'fusion'].flatMap((dir) =>
    readdirSync(new URL(`../${dir}/`, import.meta.url))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => `../${dir}/${file.slice(0, -'.ts'.length)}`),
  ),
  '../templates',
  '../hub',
  '../rules',
].sort();

/** The entries of a registry: a record's values, a list's or a set's members. */
const entriesOf = (registry: object): [string, unknown][] =>
  registry instanceof Set
    ? [...(registry as Set<unknown>)].map((member, i): [string, unknown] => [String(i), member])
    : Object.entries(registry);

describe('content module import order (L8)', () => {
  it('covers the content, the templates, the generator and src/data/web', () => {
    expect(MODULES).toEqual(
      expect.arrayContaining([
        '../templates',
        '../hub',
        '../rules',
        '../characters/index',
        '../characters/fire',
        '../outer/index',
        '../fusion/generate',
        '../fusion/overrides',
        '../web/index',
        '../web/validate',
      ]),
    );
  });

  it.each(MODULES)('defines every registry entry when %s is imported first', async (name) => {
    vi.resetModules();
    // A computed path: @vite-ignore keeps Vite from rewriting it into a glob.
    await import(/* @vite-ignore */ name);
    const web = await import('./index');
    const content = web.loadContent();
    const { CHARACTERS, FIRST_PICK } = await import('../characters');
    const { OUTERS } = await import('../outer');
    const { HUB } = await import('../hub');
    const { ACCEPTED_FAILS, OVERRIDES, TEMPLATE_RULE_OVERRIDES } =
      await import('../fusion/overrides');
    const { CALIBRATED } = await import('../fusion/calibrated');
    const { EMPTY_RANKS, HAND_PAIRS, HAND_RANKS } = await import('../fusion/generate');
    const { CHARACTER_SIGNATURE, POLICY_RULES, RULE_COEF_FIELDS, SIGNATURE_EVENT } =
      await import('../rules');
    expect(content.characters).toBe(CHARACTERS);
    expect(content.outers).toBe(OUTERS);
    expect(content.hub).toBe(HUB);
    expect(content.overrides).toBe(OVERRIDES);
    expect(content.calibrated).toBe(CALIBRATED);
    expect(content.acceptedFails).toBe(ACCEPTED_FAILS);
    expect(CHARACTERS[FIRST_PICK]).toBeDefined();
    const registries: Record<string, object> = {
      CHARACTERS,
      OUTERS,
      OVERRIDES,
      ACCEPTED_FAILS,
      TEMPLATE_RULE_OVERRIDES,
      CALIBRATED,
      ID_RENAMES: web.ID_RENAMES,
      SCOPES: web.SCOPES,
      BATCH_COUNTS: web.BATCH_COUNTS,
      BATCH_PLANS: web.BATCH_PLANS,
      CHARACTER_SIGNATURE,
      SIGNATURE_EVENT,
      RULE_COEF_FIELDS,
      POLICY_RULES,
      HAND_PAIRS,
      HAND_RANKS,
      EMPTY_RANKS,
    };
    for (const [registry, value] of Object.entries(registries)) {
      expect(value, registry).toBeDefined();
      for (const [key, entry] of entriesOf(value)) {
        expect(entry, `${registry}.${key}`).toBeDefined();
      }
    }
    expect(Object.keys(CHARACTERS)).toHaveLength(4);
    expect(HAND_PAIRS.size).toBe(12);
    expect(web.SCOPES).toHaveLength(3);
    // The builders and the generator through the same registry: the fixture passes.
    const { fixtureContent } = await import('./testing');
    expect(web.contentIssues(fixtureContent('B3'), { firstPick: 'fire' })).toEqual([]);
  });
});
