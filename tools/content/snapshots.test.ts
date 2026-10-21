import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../../src/data/sources';
import { contentIds, idSnapshot, loadContent } from '../../src/data/web';
import type { Content } from '../../src/data/web';
import { fixtureContent } from '../../src/data/web/testing';
import {
  IDS_FILE,
  layoutFile,
  snapshotIssues,
  snapshotTexts,
  snapshotWrites,
  staleFiles,
} from './snapshots';
import type { StoredText } from './snapshots';

const SNAPSHOTS = new URL('../../src/data/web/snapshots/', import.meta.url);
const FILES = [IDS_FILE, ...CHARACTER_IDS.map(layoutFile)];

/** A set's stored files as the tool reads them; the tests write none. */
function storedSet(dir: URL): StoredText {
  const texts = new Map(FILES.map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]));
  return (name) => texts.get(name) ?? null;
}
const FIXTURE = storedSet(new URL('fixture/', SNAPSHOTS));

/** Stored texts from a map; a name it lacks reads as a missing file. */
const storedFrom =
  (texts: Readonly<Record<string, string>>): StoredText =>
  (name) =>
    texts[name] ?? null;

const OLD = 'outer.poison.alpha.alpha-one';
const NEW = 'outer.poison.alpha.toxic-cloud';

/** The full fixture with poison's first ◆ renamed from OLD to `to`. */
function renamed(to: string): Content {
  const content = structuredClone(fixtureContent());
  const board = content.outers.poison?.board;
  if (board === undefined) throw new Error('the fixture has no poison board');
  Reflect.set(
    board,
    'nodes',
    board.nodes.map((node) => (node.id === OLD ? { ...node, id: to } : node)),
  );
  Reflect.set(
    board,
    'edges',
    board.edges.map((edge) => edge.map((id) => (id === OLD ? to : id))),
  );
  return content;
}

describe('npm run snapshots (D17, D24)', () => {
  it("writes the fixture's set as src/data/web/snapshots/fixture/ holds it", () => {
    const texts = snapshotTexts(fixtureContent());
    expect([...texts.keys()]).toEqual(FILES);
    for (const name of FILES) expect(texts.get(name), name).toBe(FIXTURE(name));
    expect(snapshotIssues(fixtureContent(), FIXTURE, {})).toEqual([]);
    expect(staleFiles(fixtureContent(), FIXTURE).size).toBe(0);
    expect(snapshotWrites(fixtureContent(), FIXTURE, {})).toEqual({
      files: new Map(),
      refused: [],
    });
  });

  it('keeps the registered set, empty until B1, up to date', () => {
    const content = loadContent();
    const stored = storedSet(SNAPSHOTS);
    expect(Object.fromEntries(snapshotTexts(content))).toEqual(
      Object.fromEntries(FILES.map((name) => [name, ''])),
    );
    expect(snapshotIssues(content, stored)).toEqual([]);
    expect(snapshotWrites(content, stored)).toEqual({ files: new Map(), refused: [] });
  });

  it('--write adds new ids and the layouts that gain nodes', () => {
    const b3 = fixtureContent('B3');
    const stored = storedFrom(Object.fromEntries(snapshotTexts(b3)));
    const full = fixtureContent();
    expect(snapshotIssues(full, stored, {})).toEqual([]);
    const { files, refused } = snapshotWrites(full, stored, {});
    expect(refused).toEqual([]);
    expect([...files.keys()]).toEqual(FILES);
    const added = (files.get(IDS_FILE) ?? '')
      .split('\n')
      .filter((id) => id !== '' && !contentIds(b3).includes(id));
    expect(added).toHaveLength(644 - contentIds(b3).length);
    expect(files.get(IDS_FILE)).toBe(FIXTURE(IDS_FILE));
    expect(files.get(layoutFile('lightning'))).toBe(FIXTURE(layoutFile('lightning')));
  });

  it('--write refuses to drop an id that ID_RENAMES does not name, and writes nothing', () => {
    const content = renamed(NEW);
    const issue = `id '${OLD}' is in snapshots/ids.txt and gone from the content; add it to ID_RENAMES in src/data/web/renames.ts (new id, or null to refund)`;
    expect(snapshotWrites(content, FIXTURE, {})).toEqual({ files: new Map(), refused: [issue] });
    // ID_RENAMES itself is empty until a batch renames an id.
    expect(snapshotWrites(content, FIXTURE)).toEqual({ files: new Map(), refused: [issue] });
    expect(snapshotIssues(content, FIXTURE, {})).toEqual([issue]);
    const wrong = { [OLD]: 'outer.poison.alpha.gone' };
    expect(snapshotWrites(content, FIXTURE, wrong).refused).toEqual([
      `id '${OLD}' is renamed to 'outer.poison.alpha.gone' in src/data/web/renames.ts, which is not in the content either; name an id the content has, or null to refund`,
    ]);
    expect(snapshotWrites(content, FIXTURE, wrong).files.size).toBe(0);
  });

  it('--write takes a dropped id that ID_RENAMES renames or refunds', () => {
    const content = renamed(NEW);
    for (const renames of [{ [OLD]: NEW }, { [OLD]: null }]) {
      const { files, refused } = snapshotWrites(content, FIXTURE, renames);
      expect(refused).toEqual([]);
      // ids.txt and every layout that shows poison: all four.
      expect([...files.keys()]).toEqual(FILES);
      const ids = (files.get(IDS_FILE) ?? '').split('\n');
      expect(ids).toContain(NEW);
      expect(ids).not.toContain(OLD);
      expect(files.get(layoutFile('fire'))).toContain(`\n${NEW} `);
    }
  });

  it('reads a missing file as empty, and lists it to write', () => {
    const content = fixtureContent();
    const none: StoredText = () => null;
    expect(snapshotIssues(content, none, {})).toEqual([]);
    expect([...staleFiles(content, none).keys()]).toEqual(FILES);
    const early = fixtureContent('B1');
    const texts = snapshotTexts(early);
    // B1 builds fire's center only: the other layouts are empty files.
    expect(CHARACTER_IDS.map((c) => texts.get(layoutFile(c)) === '')).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(texts.get(IDS_FILE)).toBe(idSnapshot(contentIds(early)));
  });

  it('reports a layout that moved since its snapshot', () => {
    const stored = storedFrom({
      ...Object.fromEntries(FILES.map((name) => [name, FIXTURE(name) ?? ''])),
      [layoutFile('ice')]: (FIXTURE(layoutFile('ice')) ?? '').replace(
        '\nice.center.alpha.r1 0 -120\n',
        '\nice.center.alpha.r1 0 -119\n',
      ),
    });
    expect(snapshotIssues(fixtureContent(), stored, {})).toEqual([
      "layout 'ice': 'ice.center.alpha.r1' moved from (0, -119) to (0, -120); run npm run snapshots -- --write if intended",
    ]);
    expect([...staleFiles(fixtureContent(), stored).keys()]).toEqual([layoutFile('ice')]);
  });
});
