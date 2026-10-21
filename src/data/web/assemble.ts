/**
 * A character's web in a scope (docs/v3 C6 design §4.3, D16): its center, the hub, the 11 outers
 * at their clocks with a fusion on each open one, and its two ascendancies at its own clock,
 * joined by the fixed cross-board edges of D15. A board outside the scope is locked, one in it
 * but not registered absent; neither has nodes. Pure and uncached: an assembly takes well under a
 * millisecond (merge row 1).
 */

import { generate } from '../fusion/generate';
import { OUTER_IDS } from '../sources';
import type { CharacterId, OuterId } from '../sources';
import { MAIN_BRANCH, nodeId } from './ids';
import type {
  AssembledWeb,
  AssembleOptions,
  BoardDef,
  BoardStatus,
  Content,
  FusionDef,
  FusionKey,
  OuterDef,
  WebBoard,
  WebNode,
  WebScope,
} from './types';

type Edge = readonly [string, string];

/** True when `list` (a scope's characters or outers) holds `id`. */
export function scopeHolds(list: readonly string[] | 'all', id: string): boolean {
  return list === 'all' || list.includes(id);
}

/** The id of the first node of `board` that `matches` (a slot test, as the layout reads slots). */
function nodeAt(board: BoardDef | undefined, matches: (node: WebNode) => boolean): string | null {
  return board?.nodes.find(matches)?.id ?? null;
}

/**
 * The web of `character` in `scope` (§4.3). Throws when the character's center is null
 * (「製作中」) or the scope does not list it: the UI never asks for such a web. A fusion's coef is
 * `options.coefs[key]`, else its calibrated coef, else 1.
 */
export function assembleWeb(
  content: Content,
  character: CharacterId,
  scope: WebScope,
  options: AssembleOptions = {},
): AssembledWeb {
  const def = content.characters[character];
  const center = def.center;
  if (center === null) {
    throw new Error(`character '${character}' has no center yet (製作中); it has no web`);
  }
  if (!scopeHolds(scope.characters, character)) {
    throw new Error(`scope '${scope.name}' does not list character '${character}'`);
  }
  const own = OUTER_IDS.indexOf(character);
  const boards: WebBoard[] = [];
  const nodes: WebNode[] = [];
  const edges: Edge[] = [];
  const add = (board: BoardDef): void => {
    nodes.push(...board.nodes);
    edges.push(...board.edges);
  };

  boards.push({ id: center.id, kind: 'center', clock: null, status: 'open' });
  add(center);
  const hub = content.hub?.board;
  boards.push({
    id: 'hub',
    kind: 'hub',
    clock: null,
    status: hub === undefined ? 'absent' : 'open',
  });
  if (hub !== undefined) add(hub);

  const outers = new Map<OuterId, OuterDef>();
  const outerStatus = new Map<OuterId, BoardStatus>();
  OUTER_IDS.forEach((o, clock) => {
    if (o === character) return;
    const outer = content.outers[o];
    const status: BoardStatus = !scopeHolds(scope.outers, o)
      ? 'locked'
      : outer === undefined
        ? 'absent'
        : 'open';
    outerStatus.set(o, status);
    boards.push({ id: `outer.${o}`, kind: 'outer', clock, status });
    if (outer !== undefined && status === 'open') {
      outers.set(o, outer);
      add(outer.board);
    }
  });

  const fusions = new Map<OuterId, FusionDef>();
  OUTER_IDS.forEach((o, clock) => {
    if (o === character) return;
    const key: FusionKey = `${character}.${o}`;
    const outer = outers.get(o);
    const deferred = scope.deferredFusions.includes(key);
    const status: BoardStatus =
      outer === undefined ? (outerStatus.get(o) ?? 'absent') : deferred ? 'locked' : 'open';
    boards.push({ id: `fusion.${key}`, kind: 'fusion', clock, status });
    if (outer === undefined || deferred) return;
    const coef = options.coefs?.[key] ?? content.calibrated[key]?.coef ?? 1;
    const fusion = generate(def, outer, content.overrides[key], coef);
    fusions.set(o, fusion);
    add(fusion.board);
  });

  for (const ascendancy of def.ascendancies ?? []) {
    boards.push({ id: ascendancy.board.id, kind: 'asc', clock: own, status: 'open' });
    add(ascendancy.board);
  }

  // The cross-board edges of §4.3 step 6, from D15's fixed table.
  const ring = (clock: number): string | null =>
    nodeAt(hub, (node) => node.slot.at === 'hubRing' && node.slot.clock === clock);
  const cross: Edge[] = [];
  const join = (a: string | null, b: string | null): void => {
    if (a !== null && b !== null) cross.push([a, b]);
  };
  for (let clock = 1; clock < 12; clock += 2) {
    join(
      nodeAt(center, (node) => node.slot.at === 'centerEdge' && node.slot.clock === clock),
      ring(clock),
    );
  }
  OUTER_IDS.forEach((o, clock) => {
    const board = outers.get(o)?.board;
    join(
      ring(clock),
      nodeAt(board, (node) => node.slot.at === 'outerEntry'),
    );
  });
  OUTER_IDS.forEach((o, clock) => {
    const board = fusions.get(o)?.board;
    join(
      ring(clock),
      nodeAt(board, (node) => node.slot.at === 'fusion' && node.slot.step === 0),
    );
  });
  for (const ascendancy of def.ascendancies ?? []) {
    join(
      ring(own),
      nodeAt(ascendancy.board, (node) => node.slot.at === 'asc' && node.slot.step === 0),
    );
  }

  const byId = new Map<string, WebNode>();
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  // An edge to a slot left empty (a hole V3 reports) is not part of the web.
  const joined = [...edges, ...cross].filter(([a, b]) => byId.has(a) && byId.has(b));
  const neighbours = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const [a, b] of joined) {
    neighbours.get(a)?.push(b);
    neighbours.get(b)?.push(a);
  }
  return {
    character,
    def,
    scope,
    nodes,
    byId,
    edges: joined,
    neighbours,
    boards,
    outers,
    fusions,
    root: nodeId(`${character}.center`, MAIN_BRANCH, 'signature'),
  };
}
