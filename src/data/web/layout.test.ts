import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../sources';
import { assembleWeb } from './assemble';
import { LAYOUT_UNIT, layoutSnapshot, layoutWeb, slotPosition } from './layout';
import { FULL_SCOPE } from './scope';
import { layoutIssues } from './snapshot';
import { fixtureContent } from './testing';
import type { AssembledWeb, Content, Point, WebLayout } from './types';

const content = fixtureContent();
const webs = CHARACTER_IDS.map((c) => assembleWeb(content, c, FULL_SCOPE));

/** A point to the snapshot's precision, which the design's numbers use. */
const rounded = ({ x, y }: Point): [number, number] => [Math.round(x) || 0, Math.round(y) || 0];

/** The closest two nodes, the closest an edge passes a node it does not end at, and the crossings. */
function geometry(layout: WebLayout, web: AssembledWeb) {
  const ids = Object.keys(layout.nodes);
  const at = (id: string): Point => layout.nodes[id] as Point;
  let spacing = Infinity;
  ids.forEach((a, i) => {
    for (const b of ids.slice(i + 1)) {
      spacing = Math.min(spacing, Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y));
    }
  });
  let clearance = Infinity;
  for (const [a, b] of web.edges) {
    const p = at(a);
    const q = at(b);
    for (const id of ids) {
      if (id === a || id === b) continue;
      const r = at(id);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const t = Math.max(
        0,
        Math.min(1, ((r.x - p.x) * dx + (r.y - p.y) * dy) / (dx * dx + dy * dy)),
      );
      clearance = Math.min(clearance, Math.hypot(r.x - p.x - t * dx, r.y - p.y - t * dy));
    }
  }
  return { spacing, clearance };
}

describe('the clock layout (§4.4, D17)', () => {
  it('places 323 nodes and 367 edges per character of the full fixture, 100 apart, clear, uncrossed', () => {
    for (const web of webs) {
      const layout = layoutWeb(web);
      expect(Object.keys(layout.nodes), web.character).toHaveLength(323);
      expect(web.edges, web.character).toHaveLength(367);
      const { spacing, clearance } = geometry(layout, web);
      expect(spacing, web.character).toBeGreaterThanOrEqual(LAYOUT_UNIT - 1e-9);
      // §4.4 reports 53.5: the closest pass, an echo spur beside the ring, is 53.49.
      expect(Number(clearance.toFixed(1)), web.character).toBeGreaterThanOrEqual(53.5);
      // layoutIssues also checks that no two edges cross.
      expect(layoutIssues(layout, web, ''), web.character).toEqual([]);
      const { minX, minY, maxX, maxY } = layout.bounds;
      for (const bound of [minX, minY, maxX, maxY]) {
        expect(Math.abs(bound), web.character).toBeLessThanOrEqual(2380 + 1e-9);
      }
      expect(Math.max(-minX, -minY, maxX, maxY), web.character).toBeCloseTo(2380, 6);
    }
  });

  it('places each slot at S × (d·u + l·v) on its clock', () => {
    const [fire] = webs;
    if (fire === undefined) throw new Error('fire');
    const at = (id: string): [number, number] => rounded(layoutWeb(fire).nodes[id] as Point);
    expect(LAYOUT_UNIT).toBe(100);
    // The center: the signature, branch alpha at clock 0, beta at 4, gamma at 8.
    expect(at('fire.center.main.signature')).toEqual([0, 0]);
    expect(at('fire.center.alpha.r1')).toEqual([0, -120]);
    expect(at('fire.center.alpha.r2')).toEqual([0, -220]);
    expect(at('fire.center.alpha.alpha-one')).toEqual([0, -320]);
    expect(at('fire.center.alpha.r3')).toEqual([80, -420]);
    expect(at('fire.center.alpha.r4')).toEqual([80, -520]);
    expect(at('fire.center.alpha.alpha-two')).toEqual([80, -620]);
    expect(at('fire.center.alpha.r5')).toEqual([-80, -420]);
    expect(at('fire.center.alpha.alpha-three')).toEqual([-80, -620]);
    expect(at('fire.center.alpha.mastery')).toEqual([0, -720]);
    expect(at('fire.center.beta.r1')).toEqual([104, 60]);
    expect(at('fire.center.gamma.r1')).toEqual([-104, 60]);
    // The ring 8.2: c1 at clock 1, the ★ at 2 and 10, the threshold at 6.
    expect(at('fire.center.main.c1')).toEqual([410, -710]);
    expect(at('fire.center.main.c6')).toEqual([-410, -710]);
    expect(at('fire.center.main.star-one')).toEqual([710, -410]);
    expect(at('fire.center.main.star-two')).toEqual([-710, -410]);
    expect(at('fire.center.main.threshold')).toEqual([0, 820]);
    // The hub (F9): 強化∞ at clock 0, a spur 12° past its ring node, at 8.75.
    expect(at('hub.might.might')).toEqual([0, -960]);
    expect(at('hub.defense.r1')).toEqual([480, -831]);
    expect(at('hub.echo.r4')).toEqual([-480, -831]);
    expect(at('hub.rules.rule-one')).toEqual([182, -856]);
    expect(at('hub.defense.r5')).toEqual([856, 182]);
    expect(at('hub.economy.r4')).toEqual([-182, 856]);
    // An outer: poison at clock 1, its first branch on side +1.
    expect(at('outer.poison.main.entry')).toEqual([850, -1472]);
    expect(at('outer.poison.alpha.r1')).toEqual([1008, -1496]);
    expect(at('outer.poison.alpha.r3')).toEqual([1202, -1731]);
    expect(at('outer.poison.beta.r3')).toEqual([898, -1906]);
    expect(at('outer.poison.beta.beta-two')).toEqual([1010, -1899]);
    expect(at('outer.poison.main.counter')).toEqual([1125, -1949]);
    expect(at('outer.poison.main.star')).toEqual([1138, -2091]);
    expect(at('outer.poison.main.threshold')).toEqual([1242, -2031]);
    // A fusion beside its spoke, from the core at 10.8 to the mastery at 14.8 (F18).
    expect(at('fusion.fire.poison.core')).toEqual([488, -965]);
    expect(at('fusion.fire.poison.mastery')).toEqual([688, -1312]);
    // The ascendancies at the own clock, chain 0 left and chain 1 right.
    expect(at('fire.asc.path-one.n1')).toEqual([-80, -1100]);
    expect(at('fire.asc.path-two.final')).toEqual([80, -1300]);
  });

  it('labels each board and draws each outer collapsed (§4.4, D16)', () => {
    const [fire] = webs;
    if (fire === undefined) throw new Error('fire');
    const layout = layoutWeb(fire);
    const label = (id: string): [number, number] => rounded(layout.boards[id]?.label as Point);
    expect(Object.keys(layout.boards)).toHaveLength(fire.boards.length);
    expect(label('fire.center')).toEqual([0, 0]);
    expect(label('hub')).toEqual([0, -960]);
    expect(label('outer.poison')).toEqual([975, -1689]);
    expect(layout.boards['outer.poison']?.collapsed).toEqual({
      ...layout.boards['outer.poison']?.label,
      r: 200,
    });
    // A fusion's label at its r2, an ascendancy's at its n2.
    expect(label('fusion.fire.poison')).toEqual(
      rounded(layout.nodes['fusion.fire.poison.r2'] as Point),
    );
    expect(label('fire.asc.path-two')).toEqual(
      rounded(layout.nodes['fire.asc.path-two.n2'] as Point),
    );
    expect(layout.boards['fusion.fire.poison']?.collapsed).toBeNull();
    // 「中心 8/8・毒 3/6」 on each open spoke.
    expect(Object.keys(layout.progressMarks)).toHaveLength(11);
    expect(rounded(layout.progressMarks.poison as Point)).toEqual([728, -1081]);
    expect(layout.progressMarks.fire).toBeUndefined();
  });

  it('draws a locked or absent outer collapsed, with no nodes, and no mark on its spoke', () => {
    const web = assembleWeb(fixtureContent('B1'), 'fire', FULL_SCOPE);
    const layout = layoutWeb(web);
    const greed = layout.boards['outer.greed']?.collapsed;
    expect(greed && [...rounded(greed), greed.r]).toEqual([-975, -1689, 200]);
    expect(Object.keys(layout.nodes).some((id) => id.startsWith('outer.greed.'))).toBe(false);
    expect(Object.keys(layout.progressMarks).sort()).toEqual(['crit', 'ice', 'poison', 'summon']);
    expect(layout.bounds.minX).toBeCloseTo(-2380, 6);
  });

  it('moves no node when a board is removed (positions follow slots alone)', () => {
    const fire = layoutWeb(webs[0] as AssembledWeb);
    const removals: ((full: Content) => Content)[] = [
      (full) => {
        const outers = { ...full.outers };
        Reflect.deleteProperty(outers, 'poison');
        return { ...full, outers };
      },
      (full) => ({ ...full, hub: null }),
      (full) => ({
        ...full,
        characters: { ...full.characters, fire: { ...full.characters.fire, ascendancies: null } },
      }),
    ];
    for (const remove of removals) {
      const fewer = layoutWeb(assembleWeb(remove(content), 'fire', FULL_SCOPE));
      expect(Object.keys(fewer.nodes).length).toBeLessThan(323);
      for (const [id, point] of Object.entries(fewer.nodes))
        expect(point, id).toEqual(fire.nodes[id]);
    }
    // The same slot on another character's web sits at the same place.
    const ice = layoutWeb(webs[1] as AssembledWeb);
    expect(ice.nodes['outer.poison.alpha.r3']).toEqual(fire.nodes['outer.poison.alpha.r3']);
  });

  it('places a slot by its clock alone', () => {
    const slot = { at: 'outerBranch', step: 'r3', side: -1 } as const;
    expect(rounded(slotPosition(slot, 1))).toEqual([898, -1906]);
    expect(rounded(slotPosition(slot, 7))).toEqual([-898, 1906]);
    expect(rounded(slotPosition({ at: 'hubRing', clock: 3 }, 9))).toEqual([960, 0]);
  });

  it("matches the fixture's snapshot, src/data/web/snapshots/fixture/layout-<c>.txt", () => {
    for (const web of webs) {
      const file = new URL(`./snapshots/fixture/layout-${web.character}.txt`, import.meta.url);
      const snapshot = readFileSync(file, 'utf8');
      const layout = layoutWeb(web);
      expect(layoutSnapshot(layout, web), web.character).toBe(snapshot);
      expect(layoutIssues(layout, web, snapshot), web.character).toEqual([]);
    }
  });

  it('writes the snapshot sorted, in integers, with the edge count and the bounds', () => {
    const web = webs[0] as AssembledWeb;
    const lines = layoutSnapshot(layoutWeb(web), web).trimEnd().split('\n');
    expect(lines).toHaveLength(323 + 26 + 2);
    expect(lines).toContain('fire.center.alpha.r1 0 -120');
    expect(lines).toContain('fire.center.main.signature 0 0');
    expect(lines).toContain('board outer.poison label 975 -1689 collapsed 975 -1689 200');
    expect(lines).toContain('board hub label 0 -960');
    expect(lines.at(-2)).toBe('edges 367');
    expect(lines.at(-1)).toBe('bounds -2380 -2091 2380 2380');
    const nodes = lines.slice(0, 323).map((line) => line.split(' ')[0] as string);
    expect(nodes).toEqual([...nodes].sort());
    for (const line of lines.slice(0, 323)) expect(line).toMatch(/^\S+ -?\d+ -?\d+$/);
    const boards = lines.slice(323, 349);
    expect(boards.every((line) => line.startsWith('board '))).toBe(true);
    expect(boards).toEqual([...boards].sort());
  });
});
