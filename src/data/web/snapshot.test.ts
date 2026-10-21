import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleWeb } from './assemble';
import { layoutSnapshot, layoutWeb } from './layout';
import { FULL_SCOPE } from './scope';
import {
  contentIds,
  idSnapshot,
  idSnapshotIssues,
  layoutIssues,
  MIN_EDGE_CLEARANCE,
  MIN_NODE_SPACING,
} from './snapshot';
import { fixtureContent } from './testing';
import type { Content, OuterDef, Point, WebLayout } from './types';

const content = fixtureContent();
const fixture = (name: string): string =>
  readFileSync(new URL(`./snapshots/fixture/${name}`, import.meta.url), 'utf8');
const IDS = fixture('ids.txt');
const LAYOUT_FIRE = fixture('layout-fire.txt');
const fire = assembleWeb(content, 'fire', FULL_SCOPE);

/** The point at depth d and offset l on clock k (§4.4's frame), for planting a moved node. */
function at(clock: number, d: number, l: number): Point {
  const beta = (clock * Math.PI) / 6;
  return {
    x: 100 * (d * Math.sin(beta) + l * Math.cos(beta)),
    y: 100 * (l * Math.sin(beta) - d * Math.cos(beta)),
  };
}

/** fire's layout with some nodes moved. */
function moved(points: Readonly<Record<string, Point>>): WebLayout {
  const layout = layoutWeb(fire);
  return { ...layout, nodes: { ...layout.nodes, ...points } };
}

describe('the id snapshot (V21, D24)', () => {
  const ids = contentIds(content);
  const deleted = 'outer.poison.alpha.alpha-one';
  const without = ids.filter((id) => id !== deleted);

  it("lists the full fixture's 644 ids, sorted, one per line", () => {
    expect(ids).toHaveLength(644);
    expect(idSnapshot(ids)).toBe(IDS);
    expect(IDS.split('\n')).toHaveLength(645);
    expect(idSnapshot([])).toBe('');
    expect(idSnapshot(['b', 'a', 'b'])).toBe('a\nb\n');
  });

  it('reports a deleted id that ID_RENAMES does not name', () => {
    expect(idSnapshotIssues(without, IDS)).toEqual([
      `id '${deleted}' is in snapshots/ids.txt and gone from the content; add it to ID_RENAMES in src/data/web/renames.ts (new id, or null to refund)`,
    ]);
    expect(idSnapshotIssues(without, IDS, {})).toHaveLength(1);
  });

  it('takes a deleted id that is renamed to an id the content has, or refunded', () => {
    const renamed = [...without, 'outer.poison.alpha.toxic-cloud'];
    expect(idSnapshotIssues(renamed, IDS, { [deleted]: 'outer.poison.alpha.toxic-cloud' })).toEqual(
      [],
    );
    expect(idSnapshotIssues(without, IDS, { [deleted]: null })).toEqual([]);
  });

  it('reports a rename to an id the content does not have', () => {
    expect(idSnapshotIssues(without, IDS, { [deleted]: 'outer.poison.alpha.gone' })).toEqual([
      `id '${deleted}' is renamed to 'outer.poison.alpha.gone' in src/data/web/renames.ts, which is not in the content either; name an id the content has, or null to refund`,
    ]);
  });

  it('takes new ids and reads blank lines as nothing', () => {
    expect(idSnapshotIssues([...ids, 'outer.poison.alpha.new-one'], IDS)).toEqual([]);
    expect(idSnapshotIssues(ids, '')).toEqual([]);
    expect(idSnapshotIssues(['a'], '\na\n\n')).toEqual([]);
  });

  it('lists an ascendancy and the hub before any center is built', () => {
    const b1 = fixtureContent('B1');
    // fire's ascendancies written before its center (B1 has none).
    const { ascendancies } = content.characters.fire;
    const early: Content = {
      ...b1,
      characters: { ...b1.characters, fire: { ...b1.characters.fire, center: null, ascendancies } },
    };
    const listed = contentIds(early);
    expect(listed).toHaveLength(24 + 4 * 18 + 2 * 3);
    expect(listed).toContain('fire.asc.path-one.n1');
    expect(listed).toContain('hub.might.might');
    expect(listed.some((id) => id.startsWith('fusion.'))).toBe(false);
    expect(contentIds(b1)).toHaveLength(156);
  });
});

describe('the layout snapshot and geometry (V22, D17)', () => {
  it('passes the full fixture against its snapshot', () => {
    expect(MIN_NODE_SPACING).toBe(90);
    expect(MIN_EDGE_CLEARANCE).toBe(40);
    expect(layoutIssues(layoutWeb(fire), fire, LAYOUT_FIRE)).toEqual([]);
  });

  it('reports a node that moved since the snapshot', () => {
    // Poison's branches swap sides: each node of a branch moves to the other side.
    const poison = content.outers.poison as OuterDef;
    const swapped: OuterDef = {
      ...poison,
      board: {
        ...poison.board,
        nodes: poison.board.nodes.map((node) =>
          node.slot.at === 'outerBranch'
            ? { ...node, slot: { ...node.slot, side: node.slot.side === 1 ? -1 : 1 } }
            : node,
        ),
      },
    };
    const web = assembleWeb(
      { ...content, outers: { ...content.outers, poison: swapped } },
      'fire',
      FULL_SCOPE,
    );
    const issues = layoutIssues(layoutWeb(web), web, LAYOUT_FIRE);
    expect(issues).toContain(
      "layout 'fire': 'outer.poison.beta.r3' moved from (898, -1906) to (1202, -1731); run npm run snapshots -- --write if intended",
    );
    expect(issues).toContain(
      "layout 'fire': 'outer.poison.alpha.r3' moved from (1202, -1731) to (898, -1906); run npm run snapshots -- --write if intended",
    );
    expect(issues).toHaveLength(14);
  });

  it('reports a move of one unit, and a moved board', () => {
    const stored = LAYOUT_FIRE.replace(
      '\nfire.center.alpha.r1 0 -120\n',
      '\nfire.center.alpha.r1 0 -121\n',
    ).replace(
      'board outer.poison label 975 -1689 collapsed 975 -1689 200',
      'board outer.poison label 975 -1690 collapsed 975 -1690 200',
    );
    expect(layoutIssues(layoutWeb(fire), fire, stored)).toEqual([
      "layout 'fire': 'fire.center.alpha.r1' moved from (0, -121) to (0, -120); run npm run snapshots -- --write if intended",
      "layout 'fire': board 'outer.poison' moved from 'label 975 -1690 collapsed 975 -1690 200' to 'label 975 -1689 collapsed 975 -1689 200'; run npm run snapshots -- --write if intended",
    ]);
  });

  it('takes lines the snapshot lacks: a batch only adds lines', () => {
    const b1 = assembleWeb(fixtureContent('B1'), 'fire', FULL_SCOPE);
    const early = layoutSnapshot(layoutWeb(b1), b1);
    expect(layoutIssues(layoutWeb(fire), fire, early)).toEqual([]);
    const later = layoutSnapshot(layoutWeb(fire), fire).split('\n');
    expect(early.split('\n').filter((line) => !later.includes(line))).toEqual([
      'edges 179',
      'bounds -2380 -2091 2150 2380',
    ]);
  });

  it('reports two nodes closer than 90', () => {
    const layout = moved({ 'fire.center.alpha.r1': { x: 0, y: -170 } });
    expect(layoutIssues(layout, fire, '')).toEqual([
      "layout 'fire': 'fire.center.alpha.r1' and 'fire.center.alpha.r2' are 50.0 apart; nodes stay at least 90 apart",
    ]);
  });

  it('reports an edge closer than 40 to a node it does not end at', () => {
    const layout = moved({ 'fusion.fire.poison.r2': at(1, 12.8, -0.3) });
    expect(layoutIssues(layout, fire, '')).toEqual([
      "layout 'fire': edge 'hub.defense.r1'–'outer.poison.main.entry' passes 30.0 from 'fusion.fire.poison.r2'; edges stay at least 40 from other nodes",
    ]);
  });

  it('reports two edges that cross', () => {
    const layout = moved({ 'fusion.fire.poison.r2': at(1, 12.8, 0.6) });
    expect(layoutIssues(layout, fire, '')).toEqual([
      "layout 'fire': edges 'fusion.fire.poison.r1'–'fusion.fire.poison.r2' and 'hub.defense.r1'–'outer.poison.main.entry' cross; edges may not cross",
      "layout 'fire': edges 'fusion.fire.poison.r2'–'fusion.fire.poison.r3' and 'hub.defense.r1'–'outer.poison.main.entry' cross; edges may not cross",
    ]);
  });
});
