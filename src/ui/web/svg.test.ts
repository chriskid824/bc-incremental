/**
 * svg.ts (docs/v3 C6 design §3.9, §4.4, §4.11; F33): one element per node in its kind's shape,
 * the edges, collapsed and locked outers as circles, names through the lookup, and each issue
 * beside the node or board it names.
 */

import { describe, expect, it } from 'vitest';
import { assembleWeb, DEMO_SCOPE_A, FULL_SCOPE, layoutWeb } from '../../data/web';
import type { WebNodeKind } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import { SHAPE_OF, webSvg } from './svg';
import type { NodeShape } from './svg';
import { fixtureLookups } from './testing';

const content = fixtureContent();
const fire = assembleWeb(content, 'fire', FULL_SCOPE);
const layout = layoutWeb(fire);
const lookups = fixtureLookups();

/** Each node group: its id, kind, shape and the markup inside it. */
const nodesOf = (svg: string) =>
  [
    ...svg.matchAll(
      /<g class="node" data-id="([^"]+)" data-kind="(\w+)" data-shape="(\w+)"[^>]*>(.*?)<\/g>/g,
    ),
  ].map(([, id, kind, shape, inner]) => ({
    id: id as string,
    kind: kind as WebNodeKind,
    shape: shape as NodeShape,
    inner: inner as string,
  }));

/** A shape's markup after the title: its primitives and the corners of its polygon. */
const SHAPE_MARKUP: Readonly<Record<NodeShape, RegExp>> = {
  circle: /^<circle r="16" /,
  largeCircle: /^<circle r="32" /,
  ringedCircle: /^<circle r="24" fill="#ffffff"[^>]*\/><circle r="13" /,
  doubleCircle: /^<circle r="26" fill="#ffffff"[^>]*\/><circle r="15" /,
  diamond: /^<polygon points="0,-22 22,0 0,22 -22,0" /,
  largeDiamond: /^<polygon points="0,-34 34,0 0,34 -34,0" /,
  star: /^<polygon points="(?:-?[\d.]+,-?[\d.]+ ){9}-?[\d.]+,-?[\d.]+" /,
  square: /^<rect x="-17" y="-17" width="34" height="34" /,
  hexagon: /^<polygon points="(?:-?[\d.]+,-?[\d.]+ ){5}-?[\d.]+,-?[\d.]+" fill="#ffffff"/,
  filledHexagon: /^<polygon points="(?:-?[\d.]+,-?[\d.]+ ){5}-?[\d.]+,-?[\d.]+" fill="#(?!ffffff)/,
};

const n = (value: number): string => String(Math.round(value * 10) / 10 || 0);

describe('webSvg (§3.9, F33)', () => {
  it("draws every node once, in its kind's shape", () => {
    const drawn = nodesOf(webSvg(layout, fire, [], { lookup: lookups.en }));
    expect(drawn.map((node) => node.id).sort()).toEqual(fire.nodes.map((node) => node.id).sort());
    for (const { id, kind, shape, inner } of drawn) {
      expect(shape, id).toBe(SHAPE_OF[kind]);
      const markup = inner.replace(/^<title>[^<]*<\/title>(?:<rect class="hand"[^>]*\/>)?/, '');
      expect(markup, id).toMatch(SHAPE_MARKUP[shape]);
      const at = layout.nodes[id];
      expect(at, id).toBeDefined();
    }
    expect(new Set(drawn.map((node) => node.kind)).size).toBe(Object.keys(SHAPE_OF).length);
  });

  it("follows the legend's shapes (docs/v3/talent-web-v3.svg)", () => {
    expect(SHAPE_OF).toEqual({
      signature: 'largeCircle',
      ranked: 'circle',
      notable: 'diamond',
      threshold: 'square',
      keystone: 'star',
      mastery: 'hexagon',
      might: 'filledHexagon',
      entry: 'ringedCircle',
      core: 'doubleCircle',
      asc: 'diamond',
      ascFinal: 'largeDiamond',
    });
  });

  it('draws every edge and frames the hand cores', () => {
    const svg = webSvg(layout, fire, []);
    expect(svg.match(/<line class="edge"/g)).toHaveLength(fire.edges.length);
    const hand = [...svg.matchAll(/data-id="([^"]+)"[^>]*data-hand="true"/g)].map((m) => m[1]);
    expect(hand.sort()).toEqual([
      'fusion.fire.ice.core',
      'fusion.fire.lightning.core',
      'fusion.fire.summon.core',
    ]);
  });

  it('names nodes and boards through the lookup, escaped', () => {
    const zh = webSvg(layout, fire, [], { lookup: lookups['zh-TW'] });
    expect(zh).toContain(
      '<g class="node" data-id="fire.center.main.star-one" data-kind="keystone" data-shape="star"',
    );
    expect(zh).toMatch(/data-id="fire\.center\.main\.star-one"[^>]*><title>星一<\/title>/);
    for (const label of ['熔核', '樞紐環', '毒', '火毒', '路線一']) {
      expect(zh).toContain(`>${label}</text>`);
    }
    const en = webSvg(layout, fire, [], { lookup: lookups.en });
    expect(en).toContain('<title>Fire Poison &quot;Plague Bomb&quot;</title>');
    expect(en).toContain('>Hub</text>');
  });

  it('draws each outer collapsed as its circle, and a locked one with 完整版才有', () => {
    const collapsed = webSvg(layout, fire, [], { collapsed: true, lookup: lookups.en });
    expect(nodesOf(collapsed).some((node) => node.id.startsWith('outer.'))).toBe(false);
    const boards = [
      ...collapsed.matchAll(/<g class="board" data-board="([^"]+)" data-status="(\w+)"/g),
    ];
    expect(boards.map(([, id, status]) => `${id} ${status}`)).toEqual(
      fire.boards.filter((board) => board.kind === 'outer').map((board) => `${board.id} open`),
    );
    const demo = assembleWeb(content, 'fire', DEMO_SCOPE_A);
    const svg = webSvg(layoutWeb(demo), demo, [], { lookup: lookups['zh-TW'] });
    expect(svg).toMatch(
      /<g class="board" data-board="outer\.lightning" data-status="locked"[^>]*><circle[^>]*\/><text[^>]*>雷<\/text><text[^>]*>完整版才有<\/text><\/g>/,
    );
    expect(nodesOf(svg).some((node) => node.id.startsWith('outer.lightning.'))).toBe(false);
    expect(nodesOf(svg).some((node) => node.id.startsWith('outer.poison.'))).toBe(true);
  });

  it('marks each issue beside the node or board it names, its message as the title', () => {
    const entry = 'outer.poison.main.entry';
    const svg = webSvg(layout, fire, [
      { node: entry, message: 'first' },
      { node: entry, message: 'second <&>' },
      { node: 'outer.ice', message: 'a board' },
      { node: null, message: 'no node' },
      { node: 'nowhere', message: 'not drawn' },
    ]);
    const marks = [
      ...svg.matchAll(
        /<g class="issue" data-node="([^"]+)" transform="translate\(([^)]+)\)"><title>([^<]*)<\/title>/g,
      ),
    ];
    const at = layout.nodes[entry] as { x: number; y: number };
    const label = layout.boards['outer.ice']?.label as { x: number; y: number };
    expect(marks.map(([, node, transform, title]) => [node, transform, title])).toEqual([
      [entry, `${n(at.x + 26)} ${n(at.y - 26)}`, 'first'],
      [entry, `${n(at.x + 52)} ${n(at.y - 26)}`, 'second &lt;&amp;&gt;'],
      ['outer.ice', `${n(label.x + 26)} ${n(label.y - 26)}`, 'a board'],
    ]);
    const collapsed = webSvg(layout, fire, [{ node: entry, message: 'folded' }], {
      collapsed: true,
    });
    const circle = layout.boards['outer.poison']?.collapsed as { x: number; y: number };
    expect(collapsed).toContain(
      `<g class="issue" data-node="${entry}" transform="translate(${n(circle.x + 26)} ${n(circle.y - 26)})">`,
    );
  });
});
