/**
 * The web's snapshots (docs/v3 C6 design D17, D24, §4.4, §4.8 V21–V22): `ids.txt`, every
 * registered node id, and `layout-<c>.txt`, each built character's layout in FULL_SCOPE (empty
 * while its center is null). One set for the registered content in src/data/web/snapshots/, one
 * for the test fixture in src/data/web/snapshots/fixture/.
 *
 *   npm run snapshots -- [--write]
 *
 * Without a flag each set is checked through idSnapshotIssues (V21) and layoutIssues (V22), and
 * the run fails on any issue; lines the content adds are not issues, so the run only names the
 * files --write would change. --write rewrites the files that changed, and refuses to touch a set
 * while an id its ids.txt lists is gone from the content without an ID_RENAMES entry (D24). The
 * fixture's ids reach no save, so it takes no renames: a fixture change that drops ids starts
 * from an empty fixture/ids.txt.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CHARACTER_IDS } from '../../src/data/sources';
import type { CharacterId } from '../../src/data/sources';
import {
  assembleWeb,
  contentIds,
  FULL_SCOPE,
  ID_RENAMES,
  idSnapshot,
  idSnapshotIssues,
  layoutIssues,
  layoutSnapshot,
  layoutWeb,
  loadContent,
} from '../../src/data/web';
import type { Content } from '../../src/data/web';
import { fixtureContent } from '../../src/data/web/testing';

type Renames = Readonly<Record<string, string | null>>;

/** A stored snapshot file's text by its name in the set, or null when the file is missing. */
export type StoredText = (name: string) => string | null;

export const IDS_FILE = 'ids.txt';
export const layoutFile = (c: CharacterId): string => `layout-${c}.txt`;

/** Every file of a set for `content` and its text: ids.txt and a layout-<c>.txt per character. */
export function snapshotTexts(content: Content): Map<string, string> {
  const texts = new Map([[IDS_FILE, idSnapshot(contentIds(content))]]);
  for (const c of CHARACTER_IDS) {
    if (content.characters[c].center === null) {
      texts.set(layoutFile(c), '');
      continue;
    }
    const web = assembleWeb(content, c, FULL_SCOPE);
    texts.set(layoutFile(c), layoutSnapshot(layoutWeb(web), web));
  }
  return texts;
}

/** V21 and V22 of `content` against its stored set (a missing file reads as empty). */
export function snapshotIssues(
  content: Content,
  stored: StoredText,
  renames: Renames = ID_RENAMES,
): string[] {
  const issues = idSnapshotIssues(contentIds(content), stored(IDS_FILE) ?? '', renames);
  for (const c of CHARACTER_IDS) {
    if (content.characters[c].center === null) continue;
    const web = assembleWeb(content, c, FULL_SCOPE);
    issues.push(...layoutIssues(layoutWeb(web), web, stored(layoutFile(c)) ?? ''));
  }
  return issues;
}

/** The files of a set whose text differs from what is stored, a missing file included. */
export function staleFiles(content: Content, stored: StoredText): Map<string, string> {
  return new Map([...snapshotTexts(content)].filter(([name, text]) => stored(name) !== text));
}

/**
 * What --write writes: the stale files, or none while an id ids.txt lists is gone from the
 * content without a rename (D24); `refused` holds those ids' issues.
 */
export function snapshotWrites(
  content: Content,
  stored: StoredText,
  renames: Renames = ID_RENAMES,
): { readonly files: ReadonlyMap<string, string>; readonly refused: readonly string[] } {
  const refused = idSnapshotIssues(contentIds(content), stored(IDS_FILE) ?? '', renames);
  return { files: refused.length > 0 ? new Map() : staleFiles(content, stored), refused };
}

const SNAPSHOTS = new URL('../../src/data/web/snapshots/', import.meta.url);

/** The two sets: the registered content (validated by loadContent) and the full fixture. */
const SETS: readonly { readonly dir: URL; readonly content: () => Content; renames: Renames }[] = [
  { dir: SNAPSHOTS, content: loadContent, renames: ID_RENAMES },
  { dir: new URL('fixture/', SNAPSHOTS), content: () => fixtureContent(), renames: {} },
];

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: { write: { type: 'boolean', default: false } },
  });
  for (const set of SETS) {
    const where = relative(process.cwd(), fileURLToPath(set.dir)) || '.';
    const stored: StoredText = (name) => {
      const file = new URL(name, set.dir);
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    };
    let content: Content;
    try {
      content = set.content();
    } catch (error) {
      console.log(`${where}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      continue;
    }
    if (values.write) {
      const { files, refused } = snapshotWrites(content, stored, set.renames);
      if (refused.length > 0) {
        console.log(`${where}: not written; ${refused.length} ids would be dropped:`);
        for (const issue of refused) console.log(`- ${issue}`);
        process.exitCode = 1;
        continue;
      }
      mkdirSync(set.dir, { recursive: true });
      for (const [name, text] of files) writeFileSync(new URL(name, set.dir), text);
      console.log(
        files.size === 0
          ? `${where}: up to date`
          : `${where}: wrote ${[...files.keys()].join(', ')}`,
      );
      continue;
    }
    const issues = snapshotIssues(content, stored, set.renames);
    const stale = [...staleFiles(content, stored).keys()];
    if (issues.length > 0) {
      console.log(`${where}: ${issues.length === 1 ? '1 issue' : `${issues.length} issues`}:`);
      for (const issue of issues) console.log(`- ${issue}`);
      process.exitCode = 1;
    } else {
      console.log(`${where}: no issues`);
    }
    if (stale.length > 0) {
      console.log(`${where}: npm run snapshots -- --write would update ${stale.join(', ')}`);
    }
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
