/**
 * The dev viewer's drawing of a v3 web (docs/v3 C6 design §3.9, §4.4, §4.11): an SVG string of
 * `layoutWeb`'s positions with one element per node in its kind's shape (F33, the legend of
 * docs/v3/talent-web-v3.svg:20-34), the edges, the board labels, and the issues marked beside
 * the nodes they name. Collapsed, an open outer is drawn as its circle, as a locked or absent one
 * always is (gd:310). Names come through the lookup; the shapes are B1's to reuse.
 */

import type { OuterId } from '../../data/sources';
import type { AssembledWeb, Point, WebBoard, WebLayout, WebNodeKind } from '../../data/web/types';
import { APP_LOOKUP, contentText, fusionKeyOf, fusionName, nodeName, say } from './names';
import type { TextLookup } from './text';

export type NodeShape =
  | 'circle'
  | 'largeCircle'
  | 'ringedCircle'
  | 'doubleCircle'
  | 'diamond'
  | 'largeDiamond'
  | 'star'
  | 'square'
  | 'hexagon'
  | 'filledHexagon';

/** One shape per kind (F33); asc, which the legend lacks, takes the notable's diamond. */
export const SHAPE_OF: Readonly<Record<WebNodeKind, NodeShape>> = {
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
};

/** An issue as the viewer collects them: the node or board it names, or null for none. */
export interface SvgIssue {
  readonly node: string | null;
  readonly message: string;
}

export interface SvgOptions {
  readonly lookup?: TextLookup;
  /** Draw every open outer as its collapsed circle. */
  readonly collapsed?: boolean;
}

const MARGIN = 160;
const ISSUE_OFFSET = 26;
const STROKE = '#5c6270';
const GOLD = '#c99a12';

const escape = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** A coordinate with at most one decimal and no negative zero. */
const n = (value: number): string => String(Math.round(value * 10) / 10 || 0);

const polygon = (points: readonly (readonly [number, number])[], fill: string): string =>
  `<polygon points="${points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="${fill}" stroke="${STROKE}" stroke-width="3"/>`;

const diamond = (r: number, fill: string): string =>
  polygon(
    [
      [0, -r],
      [r, 0],
      [0, r],
      [-r, 0],
    ],
    fill,
  );

const regular = (corners: number, r: number, inner: number | null, fill: string): string => {
  const points: [number, number][] = [];
  const steps = inner === null ? corners : corners * 2;
  for (let i = 0; i < steps; i++) {
    const radius = inner !== null && i % 2 === 1 ? inner : r;
    const angle = (Math.PI * 2 * i) / steps - Math.PI / 2;
    points.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  return polygon(points, fill);
};

const circle = (r: number, fill: string): string =>
  `<circle r="${n(r)}" fill="${fill}" stroke="${STROKE}" stroke-width="3"/>`;

/** A node's shape centred on its position, `color` its board's fill. */
function shape(kind: NodeShape, color: string): string {
  switch (kind) {
    case 'circle':
      return circle(16, color);
    case 'largeCircle':
      return circle(32, color);
    case 'ringedCircle':
      return circle(24, '#ffffff') + circle(13, color);
    case 'doubleCircle':
      return circle(26, '#ffffff') + circle(15, color);
    case 'diamond':
      return diamond(22, color);
    case 'largeDiamond':
      return diamond(34, color);
    case 'star':
      return regular(5, 28, 12, color);
    case 'square':
      return `<rect x="-17" y="-17" width="34" height="34" fill="${color}" stroke="${STROKE}" stroke-width="3"/>`;
    case 'hexagon':
      return regular(6, 24, null, '#ffffff');
    case 'filledHexagon':
      return regular(6, 24, null, color);
  }
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A board's label: the character's, the hub's, an outer's or a fusion's name, an ascendancy's key. */
function boardLabel(web: AssembledWeb, board: WebBoard, lookup: TextLookup): string {
  switch (board.kind) {
    case 'center':
      return say(lookup, web.def.nameKey);
    case 'hub':
      return sentence(say(lookup, 'web.scope.hub'));
    case 'outer':
      return say(lookup, `web.outer.${board.id.slice('outer.'.length) as OuterId}.name`);
    case 'fusion':
      return fusionName(fusionKeyOf(board.id), lookup);
    case 'asc':
      return contentText(lookup, `web.asc.${board.id.replace('.asc.', '.')}.name`);
  }
}

/** The fill of a board's nodes: the character's colour on its own boards, grey elsewhere. */
function boardColor(web: AssembledWeb, board: WebBoard | undefined): string {
  const own = `#${web.def.color.toString(16).padStart(6, '0')}`;
  if (board === undefined) return '#d9dce3';
  if (board.kind === 'center' || board.kind === 'asc') return own;
  if (board.kind === 'fusion') return '#f2c46b';
  return board.kind === 'hub' ? '#b9bdc8' : '#d9dce3';
}

/**
 * `web` drawn at `layout` (§4.4): edges, each drawn node as `<g data-id data-kind data-shape>`
 * with its name as a `<title>`, each collapsed board as `<g data-board data-status>`, the board
 * labels, and each issue that names a drawn node or board as `<g class="issue">` beside it, its
 * message as the title. Issues naming nothing drawn are the caller's to list.
 */
export function webSvg(
  layout: WebLayout,
  web: AssembledWeb,
  issues: readonly SvgIssue[],
  options: SvgOptions = {},
): string {
  const lookup = options.lookup ?? APP_LOOKUP;
  const boards = new Map<string, WebBoard>(web.boards.map((board) => [board.id, board]));
  const folded = new Set<string>(
    web.boards
      .filter(
        (board) =>
          board.kind === 'outer' && (board.status !== 'open' || options.collapsed === true),
      )
      .map((board) => board.id),
  );
  /** Where a node is drawn: its position, or its collapsed board's centre. */
  const at = (id: string): Point | undefined => {
    const node = web.byId.get(id);
    if (node === undefined) return undefined;
    if (folded.has(node.board)) return layout.boards[node.board]?.collapsed ?? undefined;
    return layout.nodes[id];
  };

  const parts: string[] = [];
  for (const [a, b] of web.edges) {
    const nodeA = web.byId.get(a);
    const nodeB = web.byId.get(b);
    if (nodeA?.board === nodeB?.board && folded.has(nodeA?.board ?? '')) continue;
    const p = at(a);
    const q = at(b);
    if (p === undefined || q === undefined) continue;
    parts.push(
      `<line class="edge" x1="${n(p.x)}" y1="${n(p.y)}" x2="${n(q.x)}" y2="${n(q.y)}" stroke="#9aa0ad" stroke-width="4"/>`,
    );
  }

  for (const id of folded) {
    const board = boards.get(id) as WebBoard;
    const circleAt = layout.boards[id]?.collapsed;
    if (circleAt === null || circleAt === undefined) continue;
    const dash = board.status === 'absent' ? ' stroke-dasharray="18 12"' : '';
    const status =
      board.status === 'locked'
        ? `<text y="44" text-anchor="middle" font-size="30" fill="#666">${escape(say(lookup, 'web.buy.locked'))}</text>`
        : '';
    parts.push(
      `<g class="board" data-board="${escape(id)}" data-status="${board.status}" transform="translate(${n(circleAt.x)} ${n(circleAt.y)})">` +
        `<circle r="${n(circleAt.r)}" fill="#eef0f4" stroke="${STROKE}" stroke-width="4"${dash}/>` +
        `<text text-anchor="middle" font-size="44" fill="#333">${escape(boardLabel(web, board, lookup))}</text>${status}</g>`,
    );
  }

  for (const node of web.nodes) {
    if (folded.has(node.board)) continue;
    const position = layout.nodes[node.id];
    if (position === undefined) continue;
    const board = boards.get(node.board);
    const fusion =
      node.kind === 'core'
        ? web.fusions.get(fusionKeyOf(node.board).split('.')[1] as OuterId)
        : undefined;
    const hand = fusion?.kind === 'hand';
    const frame = hand
      ? `<rect class="hand" x="-34" y="-34" width="68" height="68" rx="10" fill="#fff6d8" stroke="${GOLD}" stroke-width="4"/>`
      : '';
    parts.push(
      `<g class="node" data-id="${escape(node.id)}" data-kind="${node.kind}" data-shape="${SHAPE_OF[node.kind]}"${hand ? ' data-hand="true"' : ''} transform="translate(${n(position.x)} ${n(position.y)})">` +
        `<title>${escape(nodeName(web, node.id, lookup))}</title>${frame}${shape(SHAPE_OF[node.kind], boardColor(web, board))}</g>`,
    );
  }

  for (const board of web.boards) {
    if (board.status !== 'open' || folded.has(board.id)) continue;
    const label = layout.boards[board.id]?.label;
    if (label === undefined) continue;
    parts.push(
      `<text class="label" data-board="${escape(board.id)}" x="${n(label.x)}" y="${n(label.y - 40)}" text-anchor="middle" font-size="34" fill="#222">${escape(boardLabel(web, board, lookup))}</text>`,
    );
  }

  const marked = new Map<string, number>();
  for (const issue of issues) {
    if (issue.node === null) continue;
    const point = boards.has(issue.node)
      ? (layout.boards[issue.node]?.collapsed ?? layout.boards[issue.node]?.label)
      : at(issue.node);
    if (point === undefined || point === null) continue;
    const count = marked.get(issue.node) ?? 0;
    marked.set(issue.node, count + 1);
    const x = point.x + ISSUE_OFFSET + count * ISSUE_OFFSET;
    const y = point.y - ISSUE_OFFSET;
    parts.push(
      `<g class="issue" data-node="${escape(issue.node)}" transform="translate(${n(x)} ${n(y)})">` +
        `<title>${escape(issue.message)}</title><circle r="14" fill="#d93025"/>` +
        `<text y="10" text-anchor="middle" font-size="28" font-weight="bold" fill="#ffffff">!</text></g>`,
    );
  }

  const { minX, minY, maxX, maxY } = layout.bounds;
  const box = [minX - MARGIN, minY - MARGIN, maxX - minX + 2 * MARGIN, maxY - minY + 2 * MARGIN];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.map(n).join(' ')}" font-family="sans-serif">` +
    `${parts.join('')}</svg>`
  );
}
