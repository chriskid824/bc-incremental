/**
 * The snapshot checks (docs/v3 C6 design D17, D24, §4.8 V21–V22; S-3). Each takes a snapshot's
 * text, which tools/content/snapshots.ts reads with node:fs and the viewer imports with Vite's
 * `?raw`, and returns its issues; `npm run snapshots -- --write` writes the texts these functions
 * read.
 */

import { assembleWeb } from './assemble';
import { layoutSnapshot } from './layout';
import { ID_RENAMES } from './renames';
import { FULL_SCOPE } from './scope';
import type { AssembledWeb, Content, Point, WebLayout } from './types';

/** V22: the closest two nodes may be (M1's click rule, src/data/validate.test.ts:76-85). */
export const MIN_NODE_SPACING = 90;
/** V22: the closest an edge may pass a node it does not end at. */
export const MIN_EDGE_CLEARANCE = 40;

/** A snapshot's lines, without blank ones. */
function snapshotLines(snapshot: string): string[] {
  return snapshot
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Every node id the content registers, sorted: each built character's web in FULL_SCOPE,
 * generated fusion nodes included, and the written nodes of the hub, the outers and every
 * ascendancy, so an id registered before any center is listed too.
 */
export function contentIds(content: Content): string[] {
  const ids = new Set<string>();
  for (const def of Object.values(content.characters)) {
    if (def.center !== null) {
      for (const node of assembleWeb(content, def.id, FULL_SCOPE).nodes) ids.add(node.id);
    }
    for (const ascendancy of def.ascendancies ?? []) {
      for (const node of ascendancy.board.nodes) ids.add(node.id);
    }
  }
  for (const node of content.hub?.board.nodes ?? []) ids.add(node.id);
  for (const outer of Object.values(content.outers)) {
    for (const node of outer?.board.nodes ?? []) ids.add(node.id);
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The text of `snapshots/ids.txt` for `ids`: one per line, sorted; empty for none. */
export function idSnapshot(ids: Iterable<string>): string {
  const sorted = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.length === 0 ? '' : `${sorted.join('\n')}\n`;
}

/**
 * V21 (D24): each id the snapshot lists is in `ids`, or ID_RENAMES maps it to null (refunded)
 * or to an id in `ids`. New ids are not issues: `--write` adds them.
 */
export function idSnapshotIssues(
  ids: Iterable<string>,
  snapshot: string,
  renames: Readonly<Record<string, string | null>> = ID_RENAMES,
): string[] {
  const current = new Set(ids);
  const issues: string[] = [];
  for (const id of snapshotLines(snapshot)) {
    if (current.has(id)) continue;
    const renamed = Object.hasOwn(renames, id) ? renames[id] : undefined;
    if (renamed === undefined) {
      issues.push(
        `id '${id}' is in snapshots/ids.txt and gone from the content; add it to ID_RENAMES in ` +
          'src/data/web/renames.ts (new id, or null to refund)',
      );
    } else if (renamed !== null && !current.has(renamed)) {
      issues.push(
        `id '${id}' is renamed to '${renamed}' in src/data/web/renames.ts, which is not in the ` +
          'content either; name an id the content has, or null to refund',
      );
    }
  }
  return issues;
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The distance from `p` to the segment from `a` to `b`. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / length;
  const k = Math.max(0, Math.min(1, t));
  return distance(p, { x: a.x + k * dx, y: a.y + k * dy });
}

/** The sign of the turn a → b → c. */
const turn = (a: Point, b: Point, c: Point): number =>
  Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

/** True when the segments ab and cd cross at a point inside both. */
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0;
}

/** A snapshot's node and board lines by their key (a node's id, or `board <id>`); the rest of each line. */
function snapshotEntries(snapshot: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of snapshotLines(snapshot)) {
    const words = line.split(' ');
    const head = words[0] as string;
    if (head === 'edges' || head === 'bounds') continue;
    const key = head === 'board' ? `board ${words[1] ?? ''}` : head;
    entries.set(key, words.slice(head === 'board' ? 2 : 1).join(' '));
  }
  return entries;
}

/**
 * V22 (D17): no two nodes of `web` closer than MIN_NODE_SPACING, no edge closer than
 * MIN_EDGE_CLEARANCE to a node it does not end at, no two edges crossing, and no node or board
 * moved from where `snapshot` (its layout-<c>.txt) has it. Lines the snapshot lacks are new, not
 * issues; `--write` adds them.
 */
export function layoutIssues(layout: WebLayout, web: AssembledWeb, snapshot: string): string[] {
  const at = `layout '${web.character}'`;
  const issues: string[] = [];
  const ids = Object.keys(layout.nodes);
  const pos = (id: string): Point => layout.nodes[id] ?? { x: 0, y: 0 };
  ids.forEach((a, i) => {
    for (const b of ids.slice(i + 1)) {
      const gap = distance(pos(a), pos(b));
      if (gap < MIN_NODE_SPACING) {
        issues.push(
          `${at}: '${a}' and '${b}' are ${gap.toFixed(1)} apart; nodes stay at least ` +
            `${MIN_NODE_SPACING} apart`,
        );
      }
    }
  });
  const edges = web.edges.filter(([a, b]) => a in layout.nodes && b in layout.nodes);
  for (const [a, b] of edges) {
    for (const id of ids) {
      if (id === a || id === b) continue;
      const gap = segmentDistance(pos(id), pos(a), pos(b));
      if (gap < MIN_EDGE_CLEARANCE) {
        issues.push(
          `${at}: edge '${a}'–'${b}' passes ${gap.toFixed(1)} from '${id}'; edges stay at least ` +
            `${MIN_EDGE_CLEARANCE} from other nodes`,
        );
      }
    }
  }
  edges.forEach(([a, b], i) => {
    for (const [c, d] of edges.slice(i + 1)) {
      if (a === c || a === d || b === c || b === d) continue;
      if (crosses(pos(a), pos(b), pos(c), pos(d))) {
        issues.push(`${at}: edges '${a}'–'${b}' and '${c}'–'${d}' cross; edges may not cross`);
      }
    }
  });
  const stored = snapshotEntries(snapshot);
  for (const [key, now] of snapshotEntries(layoutSnapshot(layout, web))) {
    const before = stored.get(key);
    if (before === undefined || before === now) continue;
    issues.push(
      key.startsWith('board ')
        ? `${at}: ${key.replace('board ', "board '")}' moved from '${before}' to '${now}'; run ` +
            'npm run snapshots -- --write if intended'
        : `${at}: '${key}' moved from (${before.replace(' ', ', ')}) to ` +
            `(${now.replace(' ', ', ')}); run npm run snapshots -- --write if intended`,
    );
  }
  return issues;
}
