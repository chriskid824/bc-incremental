/**
 * Talent web screen between runs (docs/GDD.md §4): an SVG of the web with pan and zoom,
 * a tooltip per node, and a side card with currencies, the start-wave picker, the build
 * summary, free respec and the start button. All state lives in meta; the panel only
 * renders it and reports clicks.
 */

import { formatNum } from '../core/format';
import type { Num } from '../core/num';
import type { RuleSpec } from '../data/rules';
import type { StatBlock } from '../data/stats';
import type { TalentNode } from '../data/types';
import { isMessageKey, t } from '../i18n';
import type { MessageKey } from '../i18n';
import type { AllocateCheck, BuildEstimate } from '../meta';
import { describeBuild, describeModifier } from './describe';
import { talentName } from './strings';
import { el } from './style';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FORMAT = { format: 'short' } as const;

/** What the panel needs to draw one frame of the web. */
export interface TalentWebView {
  readonly talents: readonly TalentNode[];
  readonly shards: Num;
  readonly cores: number;
  readonly rank: (node: TalentNode) => number;
  readonly check: (node: TalentNode) => AllocateCheck;
  readonly price: (node: TalentNode) => { readonly shards: Num; readonly cores: number };
  readonly stats: StatBlock;
  readonly rules: readonly RuleSpec[];
  readonly startWave: number;
  readonly maxStartWave: number;
  /** How far the current talents should get; a start wave past estimate.frontier warns. */
  readonly estimate: Pick<BuildEstimate, 'frontier' | 'startWave'>;
  /** Shard price multiplier per allocated node (EconomyConfig.talentGrowth). */
  readonly priceGrowth: number;
}

export interface TalentWebActions {
  allocate(nodeId: string): void;
  refund(): void;
  setStartWave(wave: number): void;
  start(): void;
}

type NodeState = 'allocated' | 'available' | 'reachable' | 'locked';

const RADIUS: Readonly<Record<TalentNode['kind'], number>> = {
  start: 26,
  small: 20,
  notable: 30,
  keystone: 38,
  repeatable: 30,
};

const KIND_KEYS: Readonly<Record<TalentNode['kind'], MessageKey>> = {
  start: 'talents.kind.start',
  small: 'talents.kind.small',
  notable: 'talents.kind.notable',
  keystone: 'talents.kind.keystone',
  repeatable: 'talents.kind.repeatable',
};

const ARCHETYPE_KEYS: Readonly<Record<TalentNode['archetype'], MessageKey>> = {
  none: 'talents.archetype.none',
  crit: 'talents.archetype.crit',
  dot: 'talents.archetype.dot',
  chain: 'talents.archetype.chain',
  hybrid: 'talents.archetype.hybrid',
};

const STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  notAdjacent: 'talents.status.notAdjacent',
  notEnoughShards: 'talents.status.notEnoughShards',
  notEnoughCores: 'talents.status.notEnoughCores',
};

/** Margin around the web when fitting it to the screen, in web units. */
const FIT_MARGIN = 80;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;

interface NodeView {
  readonly node: TalentNode;
  readonly group: SVGGElement;
  readonly label: SVGTextElement;
}

export class TalentWebPanel {
  readonly root: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly links: SVGGElement;
  private readonly nodes = new Map<string, NodeView>();
  private readonly tooltip: HTMLElement;
  private readonly shardsValue: HTMLElement;
  private readonly coresValue: HTMLElement;
  private readonly waveInput: HTMLInputElement;
  private readonly waveValue: HTMLElement;
  private readonly waveWarning: HTMLElement;
  private readonly build: HTMLElement;
  private view: TalentWebView | null = null;
  private hovered: TalentNode | null = null;

  /** Visible window in web units. */
  private camera = { x: 0, y: 0, w: 1, h: 1 };
  private bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;

  constructor(
    private readonly doc: Document,
    talents: readonly TalentNode[],
    private readonly actions: TalentWebActions,
  ) {
    this.root = el(doc, 'div', 'bc-ui bc-talents');
    this.root.hidden = true;

    this.svg = doc.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('bc-talents-svg');
    this.links = doc.createElementNS(SVG_NS, 'g');
    const nodeLayer = doc.createElementNS(SVG_NS, 'g');
    this.svg.append(this.links, nodeLayer);
    this.buildWeb(talents, nodeLayer);

    this.tooltip = el(doc, 'div', 'bc-talents-tooltip');
    this.tooltip.hidden = true;

    const header = el(doc, 'div', 'bc-talents-header');
    header.append(
      el(doc, 'div', 'bc-talents-title', t('talents.title')),
      el(doc, 'div', 'bc-talents-help', t('talents.help')),
    );

    const card = el(doc, 'div', 'bc-talents-card');
    const currencies = el(doc, 'div', 'bc-talents-currencies');
    this.shardsValue = el(doc, 'span', 'bc-talents-currency');
    this.coresValue = el(doc, 'span', 'bc-talents-currency');
    currencies.append(
      el(doc, 'span', 'bc-label', t('hud.shards')),
      this.shardsValue,
      el(doc, 'span', 'bc-label', t('hud.cores')),
      this.coresValue,
    );

    const waveBox = el(doc, 'div', 'bc-talents-wave');
    this.waveValue = el(doc, 'div', 'bc-talents-wave-value');
    this.waveInput = el(doc, 'input', 'bc-talents-wave-input');
    this.waveInput.type = 'range';
    this.waveInput.min = '1';
    this.waveInput.step = '1';
    this.waveInput.addEventListener('input', () => {
      this.actions.setStartWave(Number(this.waveInput.value));
    });
    this.waveWarning = el(doc, 'div', 'bc-talents-warning');
    this.waveWarning.hidden = true;
    waveBox.append(
      el(doc, 'div', 'bc-label', t('talents.startWave')),
      this.waveValue,
      this.waveInput,
      this.waveWarning,
    );

    this.build = el(doc, 'dl', 'bc-talents-build');

    const refund = el(doc, 'button', 'bc-button bc-button-quiet', t('talents.refund'));
    refund.addEventListener('click', () => this.actions.refund());
    const start = el(doc, 'button', 'bc-button bc-button-primary', t('talents.start'));
    start.addEventListener('click', () => this.actions.start());

    card.append(
      currencies,
      waveBox,
      el(doc, 'div', 'bc-label', t('talents.build')),
      this.build,
      refund,
      start,
    );

    this.root.append(this.svg, header, card, this.tooltip);
    this.bindCamera();
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(view: TalentWebView): void {
    const wasHidden = this.root.hidden;
    this.root.hidden = false;
    if (wasHidden) this.fit();
    this.update(view);
  }

  hide(): void {
    this.root.hidden = true;
    this.tooltip.hidden = true;
    this.hovered = null;
  }

  /** Redraws node states, currencies and the side card. */
  update(view: TalentWebView): void {
    this.view = view;
    const states = new Map<string, NodeState>();
    for (const node of view.talents) {
      const state = nodeState(node, view);
      states.set(node.id, state);
      const nv = this.nodes.get(node.id);
      if (nv === undefined) continue;
      nv.group.dataset['state'] = state;
      const rank = view.rank(node);
      nv.label.textContent = node.kind === 'repeatable' ? String(rank) : '';
    }
    for (const line of this.links.children) {
      const a = states.get((line as SVGElement).dataset['a'] ?? '');
      const b = states.get((line as SVGElement).dataset['b'] ?? '');
      const lit = a === 'allocated' && b === 'allocated';
      const open = !lit && (a === 'allocated' || b === 'allocated');
      (line as SVGElement).dataset['state'] = lit ? 'lit' : open ? 'open' : 'dim';
    }

    this.shardsValue.textContent = formatNum(view.shards, FORMAT);
    this.coresValue.textContent = String(view.cores);
    this.waveInput.max = String(view.maxStartWave);
    this.waveInput.value = String(view.startWave);
    this.waveInput.disabled = view.maxStartWave <= 1;
    this.waveValue.textContent = t('talents.startWaveValue', {
      wave: view.startWave,
      max: view.maxStartWave,
    });
    const tooHigh = view.startWave > view.estimate.frontier;
    this.waveWarning.hidden = !tooHigh;
    this.waveWarning.textContent = tooHigh
      ? t('talents.startWaveWarning', {
          frontier: view.estimate.frontier,
          wave: view.estimate.startWave,
        })
      : '';

    const lines = describeBuild(view.stats, view.rules);
    this.build.replaceChildren(
      ...lines.flatMap((line) => [
        el(this.doc, 'dt', '', line.label),
        el(this.doc, 'dd', '', line.value),
      ]),
    );
    if (this.hovered !== null) this.showTooltip(this.hovered);
  }

  private buildWeb(talents: readonly TalentNode[], layer: SVGGElement): void {
    const doc = this.doc;
    const byId = new Map(talents.map((node) => [node.id, node]));
    for (const node of talents) {
      for (const link of node.links) {
        // Each undirected link once.
        if (link < node.id) continue;
        const other = byId.get(link);
        if (other === undefined) continue;
        const line = doc.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(node.pos.x));
        line.setAttribute('y1', String(node.pos.y));
        line.setAttribute('x2', String(other.pos.x));
        line.setAttribute('y2', String(other.pos.y));
        line.classList.add('bc-talent-link');
        line.dataset['a'] = node.id;
        line.dataset['b'] = other.id;
        this.links.append(line);
      }
    }
    for (const node of talents) {
      const group = doc.createElementNS(SVG_NS, 'g');
      group.classList.add('bc-talent-node');
      group.dataset['kind'] = node.kind;
      group.dataset['archetype'] = node.archetype;
      group.setAttribute('transform', `translate(${node.pos.x} ${node.pos.y})`);
      const r = RADIUS[node.kind];
      const shape =
        node.kind === 'keystone'
          ? polygon(doc, [
              [0, -r],
              [r, 0],
              [0, r],
              [-r, 0],
            ])
          : circle(doc, r);
      shape.classList.add('bc-talent-shape');
      const label = doc.createElementNS(SVG_NS, 'text');
      label.classList.add('bc-talent-rank');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      group.append(shape, label);
      group.addEventListener('pointerenter', () => this.showTooltip(node));
      group.addEventListener('pointerleave', () => {
        if (this.hovered === node) {
          this.hovered = null;
          this.tooltip.hidden = true;
        }
      });
      group.addEventListener('click', (event) => {
        event.stopPropagation();
        if (this.drag?.moved === true) return;
        this.actions.allocate(node.id);
      });
      layer.append(group);
      this.nodes.set(node.id, { node, group, label });
      const pad = r + FIT_MARGIN;
      this.bounds.minX = Math.min(this.bounds.minX, node.pos.x - pad);
      this.bounds.minY = Math.min(this.bounds.minY, node.pos.y - pad);
      this.bounds.maxX = Math.max(this.bounds.maxX, node.pos.x + pad);
      this.bounds.maxY = Math.max(this.bounds.maxY, node.pos.y + pad);
    }
  }

  private showTooltip(node: TalentNode): void {
    this.hovered = node;
    const view = this.view;
    if (view === null) return;
    const doc = this.doc;
    const tip = this.tooltip;
    const head = el(doc, 'div', 'bc-tip-head');
    head.dataset['archetype'] = node.archetype;
    head.append(
      el(doc, 'div', 'bc-tip-name', talentName(node)),
      el(
        doc,
        'div',
        'bc-tip-kind',
        `${t(KIND_KEYS[node.kind])} · ${t(ARCHETYPE_KEYS[node.archetype])}`,
      ),
    );
    const body = el(doc, 'div', 'bc-tip-body');
    for (const mod of node.modifiers)
      body.append(el(doc, 'div', 'bc-tip-mod', describeModifier(mod)));
    if (node.descKey !== undefined && isMessageKey(node.descKey)) {
      body.append(el(doc, 'div', 'bc-tip-rule', t(node.descKey)));
    }
    const children: HTMLElement[] = [head, body];
    if (node.kind !== 'start') {
      const foot = el(doc, 'div', 'bc-tip-foot');
      const rank = view.rank(node);
      if (node.kind === 'repeatable') foot.append(el(doc, 'div', '', t('talents.rank', { rank })));
      const check = view.check(node);
      if (check.ok || node.kind === 'repeatable' || rank === 0) {
        const price = view.price(node);
        const shards = formatNum(price.shards, FORMAT);
        foot.append(
          el(
            doc,
            'div',
            '',
            price.cores > 0
              ? t('talents.costCores', { shards, cores: price.cores })
              : t('talents.cost', { shards }),
          ),
        );
        if (node.kind !== 'repeatable') {
          const growth = String(Math.round(view.priceGrowth * 100) / 100);
          foot.append(el(doc, 'div', 'bc-tip-note', t('talents.priceGrowth', { growth })));
        }
      }
      const status = check.ok
        ? t('talents.status.available')
        : check.reason === 'allocated'
          ? t('talents.status.allocated')
          : STATUS_KEYS[check.reason] !== undefined
            ? t(STATUS_KEYS[check.reason] as MessageKey)
            : '';
      if (status !== '') {
        const line = el(doc, 'div', 'bc-tip-status', status);
        line.dataset['ok'] = String(check.ok);
        foot.append(line);
      }
      children.push(foot);
    }
    tip.replaceChildren(...children);
    tip.hidden = false;
    this.placeTooltip(node);
  }

  /** Puts the tooltip next to the node, flipped to stay on screen. */
  private placeTooltip(node: TalentNode): void {
    const rect = this.svg.getBoundingClientRect();
    const scale = rect.width / this.camera.w;
    const sx = rect.left + (node.pos.x - this.camera.x) * scale;
    const sy = rect.top + (node.pos.y - this.camera.y) * scale;
    const offset = RADIUS[node.kind] * scale + 12;
    const tip = this.tooltip;
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let left = sx + offset;
    if (left + width > window.innerWidth - 12) left = sx - offset - width;
    const top = Math.min(Math.max(12, sy - height / 2), window.innerHeight - height - 12);
    tip.style.left = `${Math.max(12, left)}px`;
    tip.style.top = `${top}px`;
  }

  /** Fits the whole web into the screen. */
  private fit(): void {
    const { minX, minY, maxX, maxY } = this.bounds;
    const rect = this.svg.getBoundingClientRect();
    const aspect = rect.height > 0 ? rect.width / rect.height : 16 / 9;
    let w = maxX - minX;
    let h = maxY - minY;
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    this.camera = { x: (minX + maxX - w) / 2, y: (minY + maxY - h) / 2, w, h };
    this.fitW = w;
    this.applyCamera();
  }

  /** Camera width at "fit", the zoom reference. */
  private fitW = 1;

  private applyCamera(): void {
    const { x, y, w, h } = this.camera;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    if (this.hovered !== null && !this.tooltip.hidden) this.placeTooltip(this.hovered);
  }

  private bindCamera(): void {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (event) => {
      this.drag = {
        x: event.clientX,
        y: event.clientY,
        cx: this.camera.x,
        cy: this.camera.y,
        moved: false,
      };
    });
    svg.addEventListener('pointermove', (event) => {
      const drag = this.drag;
      if (drag === null || (event.buttons & 1) === 0) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      const scale = this.camera.w / svg.getBoundingClientRect().width;
      this.camera.x = drag.cx - dx * scale;
      this.camera.y = drag.cy - dy * scale;
      this.applyCamera();
    });
    const endDrag = (): void => {
      // Keep `moved` until the click that follows pointerup has been handled.
      setTimeout(() => {
        this.drag = null;
      }, 0);
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointerleave', endDrag);
    svg.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        const factor = Math.exp(event.deltaY * 0.0015);
        const zoom = this.fitW / (this.camera.w * factor);
        if (zoom < MIN_ZOOM || zoom > MAX_ZOOM) return;
        // Zoom around the cursor.
        const px = this.camera.x + ((event.clientX - rect.left) / rect.width) * this.camera.w;
        const py = this.camera.y + ((event.clientY - rect.top) / rect.height) * this.camera.h;
        this.camera.w *= factor;
        this.camera.h *= factor;
        this.camera.x = px - ((event.clientX - rect.left) / rect.width) * this.camera.w;
        this.camera.y = py - ((event.clientY - rect.top) / rect.height) * this.camera.h;
        this.applyCamera();
      },
      { passive: false },
    );
    window.addEventListener('resize', () => {
      if (this.visible) this.fit();
    });
  }
}

function nodeState(node: TalentNode, view: TalentWebView): NodeState {
  if (node.kind === 'start') return 'allocated';
  const check = view.check(node);
  if (node.kind === 'repeatable') {
    if (check.ok) return 'available';
    return view.rank(node) > 0
      ? 'allocated'
      : check.reason === 'notAdjacent'
        ? 'locked'
        : 'reachable';
  }
  if (view.rank(node) > 0) return 'allocated';
  if (check.ok) return 'available';
  return check.reason === 'notAdjacent' ? 'locked' : 'reachable';
}

function circle(doc: Document, r: number): SVGCircleElement {
  const shape = doc.createElementNS(SVG_NS, 'circle');
  shape.setAttribute('r', String(r));
  return shape;
}

function polygon(doc: Document, points: readonly (readonly [number, number])[]): SVGPolygonElement {
  const shape = doc.createElementNS(SVG_NS, 'polygon');
  shape.setAttribute('points', points.map(([x, y]) => `${x},${y}`).join(' '));
  return shape;
}
