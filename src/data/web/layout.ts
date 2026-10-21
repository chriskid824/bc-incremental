/**
 * The clock layout of a web (docs/v3 C6 design §4.4, D17). A board at clock k has the angle
 * β = 30° × k, the radial unit u = (sin β, −cos β) and the clockwise unit v = (cos β, sin β); a
 * slot at depth d and lateral offset l sits at S × (d·u + l·v). Clock 0 is up and y grows
 * downward, as in PixiJS. A node's position is a function of its slot and its board's clock
 * alone, never of another board, the content or an array's order, so writing a batch's boards
 * never moves an earlier batch's nodes. Every constant is an 初始值 (L10).
 */

import { OUTER_IDS } from '../sources';
import type {
  AssembledWeb,
  CenterStep,
  Circle,
  NodeSlot,
  OuterStep,
  Point,
  WebBoard,
  WebLayout,
} from './types';

/** S: the layout units between neighbouring nodes, above M1's 90 (V22). */
export const LAYOUT_UNIT = 100;

/** A slot's depth d and lateral offset l, in S. */
type Polar = readonly [d: number, l: number];

/** A center branch at clock 0, 4 or 8: r1, r2, ◆a, then arm A (l = +0.8) and arm B (l = −0.8). */
const CENTER_BRANCH: Readonly<Record<CenterStep, Polar>> = {
  r1: [1.2, 0],
  r2: [2.2, 0],
  a: [3.2, 0],
  r3: [4.2, 0.8],
  r4: [5.2, 0.8],
  b: [6.2, 0.8],
  r5: [4.2, -0.8],
  r6: [5.2, -0.8],
  c: [6.2, -0.8],
  mastery: [7.2, 0],
};
/** The center's ring: connectors at the odd clocks, ★ at 2 and 10, the threshold at 6. */
const CENTER_RING = 8.2;
const HUB_RING = 9.6;
/** A hub spur: its depth, turned 12° (0.4 of a clock) clockwise from its ring node. */
const HUB_SPUR = 8.75;
const SPUR_TURN = 12 / 30;
/** A fusion's core, r1, r2, r3 and mastery beside the spoke. */
const FUSION_DEPTHS = [10.8, 11.8, 12.8, 13.8, 14.8] as const;
const FUSION_SIDE = -0.6;
/** An ascendancy's n1, n2 and final at the own clock; chain 0 on the left, chain 1 on the right. */
const ASC_DEPTHS = [11, 12, 13] as const;
const ASC_SIDES = [-0.8, 0.8] as const;
const OUTER_ENTRY: Polar = [17, 0];
/** An outer branch on side s = +1 (the file's first branch) or −1: l × s. */
const OUTER_BRANCH: Readonly<Record<OuterStep, Polar>> = {
  r1: [18, 1.25],
  r2: [19, 1.25],
  a: [20, 1.25],
  r3: [21, 1.75],
  r4: [22, 1.75],
  b: [21.5, 0.75],
  mastery: [23, 1.25],
};
const OUTER_EDGE = {
  answer: [22.5, 0],
  keystone: [23.8, -0.6],
  threshold: [23.8, 0.6],
} as const satisfies Record<string, Polar>;
/** An outer drawn collapsed (gd:310): a circle at its middle. */
const COLLAPSED: Polar = [19.5, 0];
const COLLAPSED_RADIUS = 2;
/** The spoke's 「中心 8/8・毒 3/6」 (gd:295). */
const PROGRESS_MARK: Polar = [13, 0.9];

/** The point at depth d and offset l on clock `clock` (§4.4's frame). */
function place(clock: number, [d, l]: Polar): Point {
  const beta = (clock * Math.PI) / 6;
  const sin = Math.sin(beta);
  const cos = Math.cos(beta);
  return { x: LAYOUT_UNIT * (d * sin + l * cos), y: LAYOUT_UNIT * (l * sin - d * cos) };
}

/** Where `slot` sits on a board at `clock`; the center's and the hub's slots carry their own clock. */
export function slotPosition(slot: NodeSlot, clock: number): Point {
  switch (slot.at) {
    case 'signature':
      return place(0, [0, 0]);
    case 'centerBranch':
      return place(4 * slot.branch, CENTER_BRANCH[slot.step]);
    case 'centerEdge':
      return place(slot.clock, [CENTER_RING, 0]);
    case 'hubRing':
      return place(slot.clock, [HUB_RING, 0]);
    case 'hubSpur':
      return place(slot.clock + SPUR_TURN, [HUB_SPUR, 0]);
    case 'outerEntry':
      return place(clock, OUTER_ENTRY);
    case 'outerBranch': {
      const [d, l] = OUTER_BRANCH[slot.step];
      return place(clock, [d, l * slot.side]);
    }
    case 'outerEdge':
      return place(clock, OUTER_EDGE[slot.place]);
    case 'fusion':
      return place(clock, [FUSION_DEPTHS[slot.step], FUSION_SIDE]);
    case 'asc':
      return place(clock, [ASC_DEPTHS[slot.step], ASC_SIDES[slot.chain]]);
  }
}

/** A board's label anchor and, for an outer, its collapsed circle (§4.4's last row). */
function boardMarks(board: WebBoard, chain: 0 | 1): { label: Point; collapsed: Circle | null } {
  const clock = board.clock ?? 0;
  switch (board.kind) {
    case 'center':
      return { label: place(0, [0, 0]), collapsed: null };
    case 'hub':
      return { label: place(0, [HUB_RING, 0]), collapsed: null };
    case 'outer': {
      const centre = place(clock, COLLAPSED);
      return { label: centre, collapsed: { ...centre, r: LAYOUT_UNIT * COLLAPSED_RADIUS } };
    }
    case 'fusion':
      return { label: place(clock, [FUSION_DEPTHS[2], FUSION_SIDE]), collapsed: null };
    case 'asc':
      return { label: place(clock, [ASC_DEPTHS[1], ASC_SIDES[chain]]), collapsed: null };
  }
}

/**
 * The layout of `web`: every node's expanded position, every board's label and an outer's
 * collapsed circle (a locked or absent board's too, D16), a progress mark on each open fusion's
 * spoke, and the bounds of all of them.
 */
export function layoutWeb(web: AssembledWeb): WebLayout {
  const clocks = new Map(web.boards.map((board) => [board.id, board.clock ?? 0]));
  const nodes: Record<string, Point> = {};
  for (const node of web.nodes)
    nodes[node.id] = slotPosition(node.slot, clocks.get(node.board) ?? 0);
  const chains = (web.def.ascendancies ?? []).map((ascendancy) => ascendancy.board.id);
  const boards: Record<string, { label: Point; collapsed: Circle | null }> = {};
  const progressMarks: Partial<Record<(typeof OUTER_IDS)[number], Point>> = {};
  for (const board of web.boards) {
    boards[board.id] = boardMarks(board, chains.indexOf(board.id) === 1 ? 1 : 0);
    const outer = board.clock === null ? undefined : OUTER_IDS[board.clock];
    if (board.kind === 'fusion' && board.status === 'open' && outer !== undefined) {
      progressMarks[outer] = place(board.clock ?? 0, PROGRESS_MARK);
    }
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const { x, y } of Object.values(nodes)) {
    xs.push(x);
    ys.push(y);
  }
  for (const { collapsed } of Object.values(boards)) {
    if (collapsed !== null) {
      xs.push(collapsed.x - collapsed.r, collapsed.x + collapsed.r);
      ys.push(collapsed.y - collapsed.r, collapsed.y + collapsed.r);
    }
  }
  const bounds = {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
  return { nodes, boards, progressMarks, bounds };
}

/** A coordinate as the snapshot writes it: an integer, with no negative zero. */
const coordinate = (value: number): string => String(Math.round(value) || 0);
const point = ({ x, y }: Point): string => `${coordinate(x)} ${coordinate(y)}`;

/**
 * The snapshot `src/data/web/snapshots/layout-<c>.txt` of `layout` (§4.4): a line per node sorted
 * by id with integer coordinates, a line per board sorted by id, the edge count and the bounds.
 * Since positions follow slots, a batch's snapshot diff only adds lines.
 */
export function layoutSnapshot(layout: WebLayout, web: AssembledWeb): string {
  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const lines = Object.keys(layout.nodes)
    .sort(byId)
    .map((id) => `${id} ${point(layout.nodes[id] as Point)}`);
  for (const id of Object.keys(layout.boards).sort(byId)) {
    const { label, collapsed } = layout.boards[id] as WebLayout['boards'][string];
    const circle =
      collapsed === null ? '' : ` collapsed ${point(collapsed)} ${coordinate(collapsed.r)}`;
    lines.push(`board ${id} label ${point(label)}${circle}`);
  }
  const { minX, minY, maxX, maxY } = layout.bounds;
  lines.push(`edges ${web.edges.length}`);
  lines.push(`bounds ${point({ x: minX, y: minY })} ${point({ x: maxX, y: maxY })}`);
  return `${lines.join('\n')}\n`;
}
