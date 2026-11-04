/**
 * The web panel's drawing (docs/v3/game-design-v3.md §2.4, §3, §8 items 1, 2, 9, 11, 12): the
 * view model as SVG markup at a zoom level. Shapes are the dev viewer's (SHAPE_OF, shapeSvg in
 * src/ui/web/svg.ts) filled by the node's state; text is sized in screen pixels, so it reads the
 * same at every level, and each level draws what LEVEL_SHOWS lists. Pure: a string the panel puts
 * inside its <svg>.
 */

import type { OuterId } from '../../data/sources';
import type { AssembledWeb, FusionKey, Point, ShapeId, WebBoard } from '../../data/web/types';
import { contentText, fusionName, nodeName, say } from '../web/names';
import { SHAPE_OF, shapeSvg } from '../web/svg';
import type { TextLookup } from '../web/text';
import type { NodeView, OuterBoardView, WebModel } from './model';
import { spokeText } from './model';
import { LEVEL_SHOWS } from './zoom';
import type { ZoomLevel } from './zoom';

export const PALETTE = {
  edge: '#2c3448',
  edgeOpen: '#56627f',
  stroke: '#3a4358',
  strokeFar: '#4a536b',
  fillDark: '#161b27',
  fillFar: '#131823',
  text: '#e8ecf6',
  textDim: '#8e98b3',
  hub: '#c7cfe6',
  fusion: '#f2c46b',
  path: '#9fe8ff',
  ready: '#7ee08a',
} as const;

export interface RenderOptions {
  readonly level: ZoomLevel;
  /** Screen pixels per layout unit. */
  readonly scale: number;
  readonly lookup: TextLookup;
  /** The planned path's nodes, outlined. */
  readonly path?: ReadonlySet<string>;
}

const esc = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const n = (value: number): string => String(Math.round(value * 10) / 10 || 0);

const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

/** The colour a board's owned nodes take: the character's on its own boards, gold on a fusion's, the outer's accent on an outer's. */
export function boardColor(web: AssembledWeb, board: string): string {
  const own = hex(web.def.color);
  if (board === 'hub') return PALETTE.hub;
  if (board.startsWith('fusion.')) return PALETTE.fusion;
  if (board.startsWith('outer.')) {
    const def = web.outers.get(board.slice('outer.'.length) as OuterId);
    return def === undefined ? PALETTE.hub : hex(def.skin.accent);
  }
  return own;
}

/** A node's fill and outline by its state (owned: the board's colour; buyable: outlined in it). */
export function nodeColors(
  web: AssembledWeb,
  node: NodeView,
): { readonly fill: string; readonly stroke: string } {
  const color = boardColor(web, node.board);
  switch (node.state) {
    case 'owned':
    case 'maxed':
      return { fill: color, stroke: '#ffffff' };
    case 'buyable':
      return { fill: PALETTE.fillDark, stroke: color };
    case 'blocked':
      return { fill: PALETTE.fillDark, stroke: PALETTE.stroke };
    case 'far':
      return { fill: PALETTE.fillFar, stroke: PALETTE.strokeFar };
  }
}

/** A text element at `at`, `px` screen pixels high at `scale`. */
function text(
  at: Point,
  content: string,
  px: number,
  scale: number,
  attrs: {
    readonly cls?: string;
    readonly fill?: string;
    readonly dy?: number;
    readonly weight?: number;
  } = {},
): string {
  const size = px / scale;
  const y = at.y + (attrs.dy ?? 0) / scale + size * 0.35;
  const weight = attrs.weight === undefined ? '' : ` font-weight="${attrs.weight}"`;
  return (
    `<text class="${attrs.cls ?? 'v3p-text'}" x="${n(at.x)}" y="${n(y)}" font-size="${n(size)}" stroke-width="${n(3 / scale)}"` +
    ` fill="${attrs.fill ?? PALETTE.text}" text-anchor="middle"${weight}>${esc(content)}</text>`
  );
}

/** A small glyph of an outer's skin shape (its icon on the collapsed circle), `r` units wide. */
export function iconSvg(shape: ShapeId, r: number, color: string): string {
  const s = (v: number): string => n(v * r);
  const line = `stroke="${color}" stroke-width="${s(0.18)}" fill="none" stroke-linecap="round"`;
  switch (shape) {
    case 'flame':
      return `<path d="M0 ${s(-1)} C ${s(0.7)} ${s(-0.3)} ${s(0.8)} ${s(0.3)} 0 ${s(1)} C ${s(-0.8)} ${s(0.3)} ${s(-0.7)} ${s(-0.3)} 0 ${s(-1)} Z" fill="${color}"/>`;
    case 'bubble':
      return `<circle cx="${s(-0.3)}" cy="${s(0.2)}" r="${s(0.55)}" ${line}/><circle cx="${s(0.5)}" cy="${s(-0.4)}" r="${s(0.35)}" ${line}/>`;
    case 'trail':
      return `<path d="M${s(-1)} 0 Q ${s(-0.5)} ${s(-0.7)} 0 0 T ${s(1)} 0" ${line}/>`;
    case 'arc':
      return `<path d="M${s(-0.3)} ${s(-1)} L ${s(0.3)} ${s(-0.1)} L ${s(-0.3)} ${s(0.1)} L ${s(0.3)} ${s(1)}" ${line}/>`;
    case 'afterimage':
      return `<circle cx="${s(-0.35)}" r="${s(0.5)}" ${line} opacity="0.5"/><circle cx="${s(0.35)}" r="${s(0.5)}" fill="${color}"/>`;
    case 'slash':
      return `<path d="M${s(-0.9)} ${s(0.9)} L ${s(0.9)} ${s(-0.9)}" ${line}/>`;
    case 'crystal':
      return `<path d="M0 ${s(-1)} L ${s(0.55)} 0 L 0 ${s(1)} L ${s(-0.55)} 0 Z" fill="${color}"/>`;
    case 'ring':
      return `<circle r="${s(0.75)}" ${line}/>`;
    case 'spike':
      return `<path d="M0 ${s(-1)} L ${s(0.8)} ${s(0.8)} L ${s(-0.8)} ${s(0.8)} Z" fill="${color}"/>`;
    case 'drone':
      return `<rect x="${s(-0.6)}" y="${s(-0.4)}" width="${s(1.2)}" height="${s(0.8)}" fill="${color}"/><circle cy="${s(-0.75)}" r="${s(0.2)}" fill="${color}"/>`;
    case 'bullet':
      return `<rect x="${s(-0.3)}" y="${s(-0.9)}" width="${s(0.6)}" height="${s(1.8)}" rx="${s(0.3)}" fill="${color}"/>`;
    case 'coin':
      return `<circle r="${s(0.8)}" fill="${color}"/><circle r="${s(0.45)}" ${line} stroke="${PALETTE.fillDark}"/>`;
  }
}

/** A board's name: the hub's, a fusion's or an ascendancy's. */
function boardName(web: AssembledWeb, board: WebBoard, lookup: TextLookup): string {
  switch (board.kind) {
    case 'hub': {
      const hub = say(lookup, 'web.scope.hub');
      return hub.charAt(0).toUpperCase() + hub.slice(1);
    }
    case 'fusion':
      return fusionName(board.id.slice('fusion.'.length) as FusionKey, lookup);
    case 'asc':
      return contentText(lookup, `web.asc.${board.id.replace('.asc.', '.')}.name`);
    case 'center':
      return say(lookup, web.def.nameKey);
    case 'outer':
      return say(lookup, `web.outer.${board.id.slice('outer.'.length) as OuterId}.name`);
  }
}

/**
 * Where an open outer's name goes: beyond its board, on the line from the web's centre through the
 * board's middle, clear of its nodes.
 */
export function outerLabelAt(outer: OuterBoardView, scale: number): Point {
  const { x, y, r } = outer.circle;
  const length = Math.hypot(x, y);
  if (length === 0) return { x, y };
  const out = r * 2.5 + 14 / scale;
  return { x: x + (x / length) * out, y: y + (y / length) * out };
}

function outerSvg(
  outer: OuterBoardView,
  options: RenderOptions,
): { readonly back: string; readonly front: string } {
  const { scale, lookup, level } = options;
  const shows = LEVEL_SHOWS[level];
  const name = say(lookup, `web.outer.${outer.outer}.name`);
  const { circle } = outer;
  const at = { x: circle.x, y: circle.y };
  const data = `data-outer="${outer.outer}" data-state="${outer.state}"`;
  if (outer.state === 'open') {
    // Its nodes are drawn; a far view keeps its name over them.
    const front = shows.boardNames
      ? `<g class="v3p-outer-label" ${data}>${text(level === 0 ? outer.label : outerLabelAt(outer, scale), name, level === 0 ? 20 : 17, scale, { weight: 800 })}</g>`
      : '';
    return { back: '', front };
  }
  const dashed = outer.state === 'absent' || outer.state === 'locked';
  const stroke = outer.state === 'collapsed' ? (outer.accent ?? PALETTE.stroke) : PALETTE.stroke;
  const ring =
    `<circle class="v3p-outer-circle" cx="${n(at.x)}" cy="${n(at.y)}" r="${n(circle.r)}" fill="${PALETTE.fillDark}"` +
    ` stroke="${stroke}" stroke-width="${n(2 / scale)}"${dashed ? ` stroke-dasharray="${n(8 / scale)} ${n(6 / scale)}"` : ''}/>`;
  const parts = [ring];
  if (outer.state === 'hidden') {
    parts.push(
      text(at, say(lookup, 'panel.outer.unknown'), 30, scale, {
        fill: PALETTE.textDim,
        weight: 700,
      }),
    );
  } else {
    const dim = outer.state === 'collapsed' ? PALETTE.text : PALETTE.textDim;
    const iconR = Math.min(circle.r * 0.28, 12 / scale);
    if (outer.icon !== null && outer.accent !== null) {
      parts.push(
        `<g transform="translate(${n(at.x)} ${n(at.y - iconR * 1.6)})">${iconSvg(outer.icon, iconR, outer.accent)}</g>`,
      );
    }
    parts.push(text(at, name, level === 0 ? 18 : 15, scale, { fill: dim, weight: 700, dy: 6 }));
    if (outer.state !== 'collapsed') {
      const note = say(lookup, outer.state === 'locked' ? 'web.buy.locked' : 'panel.outer.absent');
      parts.push(text(at, note, 11, scale, { fill: PALETTE.textDim, dy: 26 }));
    } else if (shows.covers) {
      const join = say(lookup, 'web.join.list');
      const names = outer.answers.map((e) => say(lookup, `web.enemy.${e}`));
      if (names.length > 0) {
        parts.push(text(at, names.join(join), 11, scale, { fill: PALETTE.textDim, dy: 26 }));
      }
    }
  }
  return { back: `<g class="v3p-outer" ${data}>${parts.join('')}</g>`, front: '' };
}

/** The web's markup at `options.level`: edges, collapsed outers, nodes, then the labels on top. */
export function renderWeb(web: AssembledWeb, model: WebModel, options: RenderOptions): string {
  const { scale, lookup, level } = options;
  const shows = LEVEL_SHOWS[level];
  const path = options.path ?? new Set<string>();
  const parts: string[] = [];
  const front: string[] = [];
  const owned = new Set(model.nodes.filter((v) => v.rank > 0).map((v) => v.id));
  /** On the planned path: both ends planned, or one planned and the other owned. */
  const reached = (id: string): boolean => path.has(id) || owned.has(id);

  for (const edge of model.edges) {
    const onPath = (path.has(edge.a) || path.has(edge.b)) && reached(edge.a) && reached(edge.b);
    const color = onPath
      ? PALETTE.path
      : edge.lit
        ? boardColor(web, web.byId.get(edge.b)?.board ?? 'hub')
        : edge.open
          ? PALETTE.edgeOpen
          : PALETTE.edge;
    const width = edge.lit || onPath ? 8 : 5;
    parts.push(
      `<line class="v3p-edge" x1="${n(edge.from.x)}" y1="${n(edge.from.y)}" x2="${n(edge.to.x)}" y2="${n(edge.to.y)}" stroke="${color}" stroke-width="${width}"/>`,
    );
  }

  for (const outer of model.outers) {
    const drawn = outerSvg(outer, options);
    parts.push(drawn.back);
    if (drawn.front !== '') front.push(drawn.front);
  }

  for (const node of model.nodes) {
    const { fill, stroke } = nodeColors(web, node);
    const onPath = path.has(node.id);
    const halo =
      node.state === 'buyable' || onPath
        ? `<circle class="v3p-halo" r="34" fill="none" stroke="${onPath ? PALETTE.path : stroke}" stroke-width="5" opacity="0.8"/>`
        : '';
    const shape = shapeSvg(
      SHAPE_OF[node.kind],
      fill,
      onPath ? PALETTE.path : stroke,
      PALETTE.fillDark,
    );
    parts.push(
      `<g class="v3p-node" data-id="${esc(node.id)}" data-state="${node.state}" data-kind="${node.kind}"${onPath ? ' data-path="true"' : ''} transform="translate(${n(node.at.x)} ${n(node.at.y)})">` +
        `<circle class="v3p-hit" r="40" fill="transparent"/>${halo}${shape}</g>`,
    );
    if (shows.nodeLabels) {
      const below = { x: node.at.x, y: node.at.y };
      if (node.maxRank === null) {
        if (node.rank > 0)
          front.push(text(below, `${node.rank}`, 11, scale, { dy: 44 * scale + 4 }));
      } else if (node.maxRank !== 1 && node.id !== web.root) {
        const rank = `${node.rank}/${node.maxRank}`;
        front.push(
          text(below, rank, 11, scale, {
            dy: 44 * scale + 4,
            fill: node.rank > 0 ? PALETTE.text : PALETTE.textDim,
          }),
        );
      } else if (node.kind !== 'ranked') {
        front.push(
          text(below, nodeName(web, node.id, lookup), 11, scale, {
            dy: 44 * scale + 4,
            fill: node.rank > 0 ? PALETTE.text : PALETTE.textDim,
          }),
        );
      }
    }
  }

  if (shows.branchNames) {
    for (const branch of model.branches) {
      front.push(
        text(branch.at, contentText(lookup, branch.key), 13, scale, {
          fill: PALETTE.textDim,
          weight: 600,
        }),
      );
    }
  }
  if (shows.boardNames) {
    for (const { board, at } of model.labels) {
      // A fusion's name is on its spoke.
      if (board.kind === 'fusion') continue;
      front.push(
        text(at, boardName(web, board, lookup), 14, scale, { weight: 700, dy: -54 * scale - 8 }),
      );
    }
  }
  if (shows.spokeProgress) {
    for (const spoke of model.spokes) {
      const ready = spoke.gate.unlocked && !spoke.owned;
      const px = level === 0 ? 13 : 12;
      // Beyond the far view an unowned fusion's name stands over its progress.
      const name =
        level > 0 && !spoke.owned
          ? text(
              spoke.at,
              fusionName(`${web.character}.${spoke.outer}` as FusionKey, lookup),
              px,
              scale,
              {
                fill: PALETTE.fusion,
                weight: 700,
                dy: -px - 2,
              },
            )
          : '';
      front.push(
        `<g class="v3p-spoke" data-outer="${spoke.outer}">${name}` +
          text(spoke.at, spokeText(web, spoke, lookup), px, scale, {
            fill: spoke.owned ? PALETTE.fusion : ready ? PALETTE.ready : PALETTE.textDim,
            weight: 700,
          }) +
          '</g>',
      );
    }
  }
  return parts.join('') + front.join('');
}
