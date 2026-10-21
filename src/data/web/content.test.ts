/**
 * The registered content against its snapshots (docs/v3 C6 design §4.8): V21 and V22 through
 * idSnapshotIssues and layoutIssues on src/data/web/snapshots/, which `npm run snapshots --
 * --write` writes. V9 joins in C6.9. The load-time checks run in loadContent().
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../sources';
import {
  assembleWeb,
  contentIds,
  FULL_SCOPE,
  idSnapshotIssues,
  layoutIssues,
  layoutWeb,
  loadContent,
} from './index';

const snapshot = (name: string): string =>
  readFileSync(new URL(`./snapshots/${name}`, import.meta.url), 'utf8');

describe('the registered content (V21, V22)', () => {
  const content = loadContent();

  it('keeps every id snapshots/ids.txt lists, or renames it (V21)', () => {
    expect(idSnapshotIssues(contentIds(content), snapshot('ids.txt'))).toEqual([]);
  });

  it.each(CHARACTER_IDS)("lays out %s's web as its snapshot has it (V22)", (c) => {
    const stored = snapshot(`layout-${c}.txt`);
    if (content.characters[c].center === null) {
      // Empty until the character's batch writes its center (D24's snapshots start at B1).
      expect(stored).toBe('');
      return;
    }
    const web = assembleWeb(content, c, FULL_SCOPE);
    expect(layoutIssues(layoutWeb(web), web, stored)).toEqual([]);
  });
});
