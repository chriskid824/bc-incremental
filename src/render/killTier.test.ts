/**
 * The kill tier (docs/v3 C7 design §1.2; C7.1's hand-off to C7.8, the lead's ruling P4): read from
 * the def's flags, pinned on every M1 and v3 type, and the one place the renderer takes it from.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { characterGameData, loadGameData } from '../data';
import { ENEMY_IDS } from '../data/types';
import type { EnemyId } from '../data/types';
import { killTier, TIER_BOSS, TIER_ELITE, TIER_NORMAL } from './killTier';

const RENDER_DIR = new URL('./', import.meta.url);

/** Comments blanked out, so only code is read. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');

const TIERS: Readonly<Record<EnemyId, number>> = {
  triangle: TIER_NORMAL,
  square: TIER_NORMAL,
  pentagon: TIER_NORMAL,
  shard: TIER_NORMAL,
  hexagon: TIER_ELITE,
  boss: TIER_BOSS,
  shielder: TIER_NORMAL,
  regenerator: TIER_NORMAL,
  dasher: TIER_NORMAL,
  shooter: TIER_NORMAL,
  summoner: TIER_NORMAL,
  treasure: TIER_NORMAL,
  onion: TIER_BOSS,
};

describe('killTier (C7.1’s hand-off, the lead’s ruling P4)', () => {
  it.each([
    ['M1', loadGameData()],
    ['v3', characterGameData()],
  ])('gives every type of %s data its tier: the bosses, the elite, the rest', (_, data) => {
    expect(Object.keys(TIERS)).toEqual([...ENEMY_IDS]);
    for (const id of ENEMY_IDS) expect(killTier(data.enemies[id]), id).toBe(TIERS[id]);
  });

  it('reads the flags, not the id: a boss-flagged def explodes as a boss, a tough one as an elite', () => {
    expect(killTier({ tough: true, boss: true })).toBe(TIER_BOSS);
    expect(killTier({ tough: false, boss: true })).toBe(TIER_BOSS);
    expect(killTier({ tough: true, boss: false })).toBe(TIER_ELITE);
    expect(killTier({ tough: false, boss: false })).toBe(TIER_NORMAL);
  });

  it('is where the renderer’s kill takes its tier, and no render module compares an enemy id', () => {
    const renderer = code(readFileSync(new URL('renderer.ts', RENDER_DIR), 'utf8'));
    const onKill = /private onKill\([^)]*\): void \{([\s\S]*?)\n {2}\}/.exec(renderer)?.[1] ?? '';
    expect(onKill).toMatch(/const tier = killTier\(def\);/);
    expect(onKill).not.toMatch(/\.(boss|tough)\b/);
    // An id, a type or an event's enemy against an id literal (a shape's name is not an id).
    const ids = ENEMY_IDS.join('|');
    const compares = new RegExp(
      `\\b(id|type|enemy)\\s*[!=]==?\\s*'(${ids})'|'(${ids})'\\s*[!=]==?\\s*[\\w.]*\\b(id|type|enemy)\\b`,
      'g',
    );
    const found = readdirSync(RENDER_DIR)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .flatMap((name) =>
        [...code(readFileSync(new URL(name, RENDER_DIR), 'utf8')).matchAll(compares)].map(
          (match) => `${name}: ${match[0]}`,
        ),
      );
    expect(found).toEqual([]);
  });
});
