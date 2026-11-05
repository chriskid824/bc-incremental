/**
 * The v3 talent-web panel between runs (docs/v3/game-design-v3.md §2.3, §2.4, §3, §8 items 1, 2,
 * 5, 9, 11, 12): the wallet, the slot bar (fusion and keystone slots; a click unequips, which is a
 * free refund), the web as SVG with three zoom levels and a pan, a tooltip per node, buying by
 * click (a far node plans its path and a second click or Confirm buys it all), refunding by right
 * click, the outers' reveal and collapse, the spokes' fusion progress and an outer's preview card;
 * from wave 30 the 轉生 button and its confirm (gd §1.7, §7), and after a prestige the line over
 * the web that says which ascendancy is chosen (the chains are bought on the web, with 迴響).
 * The rules are src/meta/web's; the panel only draws them and hands each new progress to the host.
 *
 * The last death's suggested nodes are ringed (gd §8 item 8), and a node's tooltip previews its
 * DPS change (gd §8 item 7). Search, filters and loadouts are
 * later batches.
 */

import { formatNum } from '../../core/format';
import type { OuterId } from '../../data/sources';
import { layoutWeb } from '../../data/web';
import type { AssembledWeb, WebLayout } from '../../data/web';
import { MESSAGES } from '../../i18n';
import type { Locale, MessageKey } from '../../i18n';
import { buy, buyPath, outerView, prestige, refundAll, refundNode } from '../../meta/web';
import type { AccountProgress, CharacterProgress } from '../../meta/web';
import { readDps, withRanks } from '../../meta/web/dps';
import type { DpsReading } from '../../meta/web/dps';
import type { GameData } from '../../data/types';
import { previewCard } from '../web/card';
import { say } from '../web/names';
import { messageLookup } from '../web/text';
import type { TextLookup } from '../web/text';
import type { ClickPlan, WebModel } from './model';
import {
  ascendancyLine,
  maxRankOf,
  nodeTip,
  planClick,
  prestigeLines,
  prestigeOffer,
  priceText,
  slotBar,
  webModel,
} from './model';
import { renderWeb } from './render';
import { injectPanelStyle } from './style';
import {
  fitScale,
  homeCamera,
  panBy,
  scaleOf,
  viewBoxOf,
  wheelLevel,
  zoomTo,
  ZOOM_LEVELS,
} from './zoom';
import type { Camera, Viewport, ZoomLevel } from './zoom';

export interface WebPanelOptions {
  readonly web: AssembledWeb; // assembleWeb(loadContent(), character, scope)
  readonly account: AccountProgress;
  readonly locale: Locale;
  readonly initial: CharacterProgress;
  /** Called after every purchase/refund with the new progress; the host saves it. */
  readonly onChange: (progress: CharacterProgress) => void;
  /** The 「開始」 button: the host starts a run. */
  readonly onStartRun: () => void;
  /** Back to the character select. */
  readonly onBack: () => void;
  /** The last death's suggested nodes (gd §8 item 8): ringed until maxed or the next run ends. */
  readonly suggested?: readonly string[];
  /** The run's game data: with it the tooltip previews the node's DPS change (gd §8 item 7). */
  readonly data?: GameData;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const FORMAT = { format: 'short' } as const;
/** Pointer travel, in pixels, past which a press is a drag rather than a click. */
const DRAG_SLOP = 5;
const LEVEL_NAME: Readonly<Record<ZoomLevel, MessageKey>> = {
  0: 'panel.zoom.far',
  1: 'panel.zoom.mid',
  2: 'panel.zoom.near',
};

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

type PathPlanned = Extract<ClickPlan, { readonly kind: 'path' }>;

export class WebPanel {
  private readonly options: WebPanelOptions;
  private readonly web: AssembledWeb;
  private readonly layout: WebLayout;
  private readonly lookup: TextLookup;
  private readonly doc: Document;
  private readonly root: HTMLDivElement;
  private readonly wallet: HTMLDivElement;
  private readonly slots: HTMLDivElement;
  private readonly refundButton: HTMLButtonElement;
  private readonly prestigeButton: HTMLButtonElement;
  private readonly prestigeDialog: HTMLDivElement;
  private readonly ascLine: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly tip: HTMLDivElement;
  private readonly card: HTMLElement;
  private readonly pathBar: HTMLDivElement;
  private readonly zoomName: HTMLSpanElement;
  private readonly pips: HTMLSpanElement[] = [];
  private readonly resize: ResizeObserver | null;
  private readonly cleanups: (() => void)[] = [];

  private progress: CharacterProgress;
  private model: WebModel;
  private camera: Camera;
  private viewport: Viewport = { width: 1, height: 1 };
  private fit = 1;
  private readonly expanded = new Set<OuterId>();
  private pending: PathPlanned | null = null;
  private hovered: string | null = null;
  private pointer = { x: 0, y: 0 };
  /** The outer whose card is pinned by a click; a hover shows one only while none is. */
  private pinned: OuterId | null = null;
  private refundArmed = false;
  private prestigeOpen = false;
  private drag: { x: number; y: number; camera: Camera; moved: boolean } | null = null;
  private destroyed = false;
  /** The DPS preview's readings for one progress: before, and after one more rank of a node. */
  private dps: {
    readonly progress: CharacterProgress;
    before: DpsReading | null;
    readonly after: Map<string, DpsReading>;
  } | null = null;
  private dpsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement, options: WebPanelOptions) {
    this.options = options;
    this.web = options.web;
    this.layout = layoutWeb(options.web);
    this.lookup = messageLookup(MESSAGES[options.locale]);
    this.progress = options.initial;
    this.doc = parent.ownerDocument;
    injectPanelStyle(this.doc);
    const doc = this.doc;
    const t = (key: MessageKey, values?: Record<string, string | number>): string =>
      say(this.lookup, key, values);

    this.root = el(doc, 'div', 'v3p');
    this.root.lang = options.locale;
    const top = el(doc, 'header', 'v3p-top');
    const back = el(doc, 'button', 'v3p-back', `← ${t('panel.back')}`);
    back.type = 'button';
    back.onclick = () => options.onBack();
    const title = el(doc, 'div', 'v3p-title', t(this.web.def.nameKey));
    this.wallet = el(doc, 'div', 'v3p-wallet');
    this.refundButton = el(doc, 'button', 'v3p-refund', t('panel.refundAll'));
    this.refundButton.type = 'button';
    this.refundButton.onclick = () => this.onRefundAll();
    this.prestigeButton = el(doc, 'button', 'v3p-prestige', t('panel.prestige'));
    this.prestigeButton.type = 'button';
    this.prestigeButton.hidden = true;
    this.prestigeButton.onclick = () => this.openPrestige();
    const start = el(doc, 'button', 'v3p-start', t('panel.start'));
    start.type = 'button';
    start.onclick = () => options.onStartRun();
    top.append(
      back,
      title,
      this.wallet,
      el(doc, 'div', 'v3p-spacer'),
      this.prestigeButton,
      this.refundButton,
      start,
    );

    this.slots = el(doc, 'div', 'v3p-slots');

    this.stage = el(doc, 'div', 'v3p-stage');
    this.svg = doc.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'v3p-svg');
    this.svg.setAttribute('font-family', 'inherit');
    this.tip = el(doc, 'div', 'v3p-tip');
    this.tip.hidden = true;
    this.card = el(doc, 'aside', 'v3p-card');
    this.card.hidden = true;
    this.pathBar = el(doc, 'div', 'v3p-pathbar');
    this.pathBar.hidden = true;
    this.prestigeDialog = el(doc, 'div', 'v3p-dialog');
    this.prestigeDialog.hidden = true;
    this.prestigeDialog.setAttribute('role', 'dialog');
    this.ascLine = el(doc, 'div', 'v3p-asc');
    this.ascLine.hidden = true;
    const zoom = el(doc, 'div', 'v3p-zoom');
    const out = el(doc, 'button', 'v3p-zoom-out', '−');
    out.type = 'button';
    out.title = t('panel.zoom.out');
    out.setAttribute('aria-label', t('panel.zoom.out'));
    out.onclick = () => this.setLevel(Math.max(0, this.camera.level - 1) as ZoomLevel);
    const zin = el(doc, 'button', 'v3p-zoom-in', '+');
    zin.type = 'button';
    zin.title = t('panel.zoom.in');
    zin.setAttribute('aria-label', t('panel.zoom.in'));
    zin.onclick = () => this.setLevel(Math.min(2, this.camera.level + 1) as ZoomLevel);
    const pips = el(doc, 'span', 'v3p-pips');
    for (const level of ZOOM_LEVELS) {
      const pip = el(doc, 'span', 'v3p-pip');
      pip.onclick = () => this.setLevel(level);
      this.pips.push(pip);
      pips.append(pip);
    }
    this.zoomName = el(doc, 'span', 'v3p-zoom-name');
    zoom.append(out, pips, this.zoomName, zin);
    const hint = el(doc, 'div', 'v3p-hint', t('panel.hint'));
    this.stage.append(
      this.svg,
      hint,
      this.ascLine,
      zoom,
      this.pathBar,
      this.card,
      this.tip,
      this.prestigeDialog,
    );
    this.root.append(top, this.slots, this.stage);
    parent.append(this.root);

    this.camera = homeCamera(this.layout.bounds);
    this.model = this.buildModel();
    this.bindEvents();
    const View = doc.defaultView;
    this.resize =
      View !== null && 'ResizeObserver' in View
        ? new View.ResizeObserver(() => this.measure())
        : null;
    this.resize?.observe(this.stage);
    this.measure();
  }

  /** The host replaces the progress after a run (new shards, best wave). */
  setProgress(progress: CharacterProgress): void {
    this.progress = progress;
    this.pending = null;
    this.refresh();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.dpsTimer !== null) clearTimeout(this.dpsTimer);
    this.resize?.disconnect();
    for (const cleanup of this.cleanups) cleanup();
    this.root.remove();
  }

  // Drawing.

  private buildModel(): WebModel {
    return webModel(this.web, this.layout, this.progress, this.options.account, this.expanded);
  }

  private measure(): void {
    const rect = this.stage.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    if (width === this.viewport.width && height === this.viewport.height) return;
    this.viewport = { width, height };
    this.fit = fitScale(this.layout.bounds, this.viewport);
    if (this.camera.level === 0) this.camera = homeCamera(this.layout.bounds);
    this.draw();
  }

  /** Rebuilds the model from the progress and redraws everything. */
  private refresh(): void {
    this.model = this.buildModel();
    this.draw();
  }

  private draw(): void {
    const scale = scaleOf(this.camera.level, this.fit);
    this.svg.innerHTML = renderWeb(this.web, this.model, {
      level: this.camera.level,
      scale,
      lookup: this.lookup,
      path: new Set(this.pending?.ids ?? []),
      suggested: new Set(this.options.suggested ?? []),
    });
    this.applyCamera();
    this.drawWallet();
    this.drawSlots();
    this.drawPathBar();
    this.drawPrestige();
    this.drawZoom();
    this.drawCard();
    this.drawTip();
  }

  private applyCamera(): void {
    const box = viewBoxOf(this.camera, this.viewport, this.fit);
    this.svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
  }

  private t(key: MessageKey, values?: Record<string, string | number>): string {
    return say(this.lookup, key, values);
  }

  private drawWallet(): void {
    const { wallet } = this.progress;
    const coin = (key: MessageKey, value: string, kind: string): HTMLElement => {
      const box = el(this.doc, 'div', 'v3p-coin');
      box.dataset.coin = kind;
      box.append(el(this.doc, 'span', '', this.t(key)), el(this.doc, 'b', '', value));
      return box;
    };
    const coins = [
      coin('panel.wallet.shards', formatNum(wallet.shards, FORMAT), 'shards'),
      coin('panel.wallet.cores', String(wallet.cores), 'cores'),
    ];
    if (wallet.resonance > 0 || this.progress.prestiges > 0) {
      coins.push(coin('panel.wallet.resonance', String(wallet.resonance), 'resonance'));
    }
    this.wallet.replaceChildren(...coins);
  }

  private drawSlots(): void {
    const bar = slotBar(this.web, this.progress, this.options.account, this.lookup);
    const children: HTMLElement[] = [];
    const group = (label: MessageKey, kind: string, views: typeof bar.fusions): void => {
      children.push(el(this.doc, 'span', 'v3p-slots-label', this.t(label)));
      for (const view of views) {
        const button = el(this.doc, 'button', 'v3p-slot', view.name ?? this.t('panel.slots.empty'));
        button.type = 'button';
        button.dataset.kind = kind;
        button.dataset.filled = String(view.id !== null);
        if (view.id !== null && view.refund !== null) {
          const id = view.id;
          const more = view.refund.dropped.length - 1;
          button.title =
            this.t('panel.slots.unequip', { price: priceText(view.refund.refund, this.lookup) }) +
            (more > 0 ? ` ${this.t('panel.refund.drops', { count: more })}` : '');
          button.dataset.id = id;
          button.onclick = () => this.refund(id);
        } else {
          button.disabled = true;
        }
        children.push(button);
      }
    };
    group('panel.slots.fusion', 'fusion', bar.fusions);
    group('panel.slots.keystone', 'keystone', bar.keystones);
    this.slots.replaceChildren(...children);
    this.refundButton.textContent = this.t(
      this.refundArmed ? 'panel.refundAll.confirm' : 'panel.refundAll',
    );
    this.refundButton.dataset.armed = String(this.refundArmed);
  }

  private drawPathBar(): void {
    const plan = this.pending;
    this.pathBar.hidden = plan === null;
    if (plan === null) return;
    const label = el(
      this.doc,
      'span',
      'v3p-path-text',
      this.t('panel.path.confirm', {
        count: plan.ids.length,
        price: priceText(plan.price, this.lookup),
      }),
    );
    const confirm = el(this.doc, 'button', 'v3p-confirm', this.t('panel.path.buy'));
    confirm.type = 'button';
    confirm.onclick = () => this.confirmPath();
    const cancel = el(this.doc, 'button', 'v3p-cancel', this.t('panel.path.cancel'));
    cancel.type = 'button';
    cancel.onclick = () => this.cancelPath();
    this.pathBar.replaceChildren(label, confirm, cancel);
  }

  /** The 轉生 button while a prestige is allowed, and its confirm while open. */
  private drawPrestige(): void {
    const offer = prestigeOffer(this.progress);
    this.prestigeButton.hidden = offer === null;
    if (offer === null) this.prestigeOpen = false;
    const line = ascendancyLine(this.web, this.progress, this.lookup);
    this.ascLine.hidden = line === null;
    this.ascLine.textContent = line ?? '';
    this.prestigeDialog.hidden = !this.prestigeOpen || offer === null;
    if (this.prestigeDialog.hidden || offer === null) return;
    const rows: HTMLElement[] = [
      el(this.doc, 'div', 'v3p-dialog-title', this.t('panel.prestige.title')),
    ];
    for (const text of prestigeLines(offer, this.lookup)) {
      rows.push(el(this.doc, 'div', 'v3p-dialog-line', text));
    }
    const buttons = el(this.doc, 'div', 'v3p-dialog-buttons');
    const confirm = el(this.doc, 'button', 'v3p-confirm', this.t('panel.prestige.confirm'));
    confirm.type = 'button';
    confirm.onclick = () => this.confirmPrestige();
    const cancel = el(this.doc, 'button', 'v3p-cancel', this.t('panel.prestige.cancel'));
    cancel.type = 'button';
    cancel.onclick = () => this.closePrestige();
    buttons.append(confirm, cancel);
    rows.push(buttons);
    this.prestigeDialog.replaceChildren(...rows);
  }

  private drawZoom(): void {
    for (const [index, pip] of this.pips.entries()) {
      pip.dataset.on = String(index === this.camera.level);
    }
    this.zoomName.textContent = this.t(LEVEL_NAME[this.camera.level]);
    this.root.dataset.zoom = String(this.camera.level);
  }

  private drawTip(): void {
    const id = this.hovered;
    if (id === null || !this.web.byId.has(id)) {
      this.tip.hidden = true;
      return;
    }
    const tip = nodeTip(this.web, this.progress, this.options.account, id, this.lookup);
    const rows: HTMLElement[] = [el(this.doc, 'div', 'v3p-tip-name', tip.name)];
    const kind = tip.rank === null ? tip.kind : `${tip.kind} · ${tip.rank}`;
    rows.push(el(this.doc, 'div', 'v3p-tip-kind', kind));
    for (const line of tip.lines) rows.push(el(this.doc, 'div', 'v3p-tip-line', line));
    const dps = this.dpsLine(id);
    if (dps !== null) rows.push(el(this.doc, 'div', 'v3p-tip-dps', dps));
    if (tip.price !== null) rows.push(el(this.doc, 'div', 'v3p-tip-price', tip.price));
    const pending = this.pending?.id === id;
    const actionText = pending ? this.t('panel.tip.pathPending') : tip.action;
    if (actionText !== null) {
      const action = el(this.doc, 'div', 'v3p-tip-action', actionText);
      action.dataset.refused = String(!pending && tip.refused);
      rows.push(action);
    }
    if (tip.refund !== null) rows.push(el(this.doc, 'div', 'v3p-tip-refund', tip.refund));
    this.tip.replaceChildren(...rows);
    this.tip.hidden = false;
    this.placeTip();
  }

  /**
   * 「對一般怪 1.2K → 1.9K、對 Boss 8K → 9K」 (gd §8 item 7) for a node that can take a rank: the
   * probes (src/meta/web/dps.ts) run a moment after the hover settles, and the tip redraws.
   */
  private dpsLine(id: string): string | null {
    const data = this.options.data;
    if (data === undefined || id === this.web.root) return null;
    const max = maxRankOf(this.web, id);
    if (max !== null && (this.progress.ranks[id] ?? 0) >= max) return null;
    if (this.dps?.progress !== this.progress) {
      this.dps = { progress: this.progress, before: null, after: new Map() };
    }
    const before = this.dps.before;
    const after = this.dps.after.get(id);
    if (before === null || after === undefined) {
      this.scheduleDps(id, data);
      return this.t('panel.tip.dpsPending');
    }
    const f = (value: DpsReading['crowd']): string => formatNum(value, FORMAT);
    return this.t('panel.tip.dps', {
      crowd: f(before.crowd),
      crowdAfter: f(after.crowd),
      boss: f(before.boss),
      bossAfter: f(after.boss),
    });
  }

  private scheduleDps(id: string, data: GameData): void {
    if (this.dpsTimer !== null) clearTimeout(this.dpsTimer);
    this.dpsTimer = setTimeout(() => {
      this.dpsTimer = null;
      const cache = this.dps;
      if (this.destroyed || this.hovered !== id || cache?.progress !== this.progress) return;
      cache.before ??= readDps(this.web, this.progress, data);
      cache.after.set(id, readDps(this.web, withRanks(this.progress, [id]), data));
      this.drawTip();
    }, 120);
  }

  private placeTip(): void {
    const gap = 18;
    const width = this.tip.offsetWidth;
    const height = this.tip.offsetHeight;
    let x = this.pointer.x + gap;
    let y = this.pointer.y + gap;
    if (x + width > this.viewport.width - 8) x = this.pointer.x - gap - width;
    if (y + height > this.viewport.height - 8) y = Math.max(8, this.viewport.height - 8 - height);
    this.tip.style.left = `${Math.max(8, x)}px`;
    this.tip.style.top = `${y}px`;
  }

  /** The preview card 「接到你的角色會得到什麼」 of the pinned outer, else the hovered one. */
  private cardOuter: OuterId | null = null;

  private drawCard(): void {
    const outer = this.pinned ?? this.cardOuter;
    const view = this.model.outers.find((o) => o.outer === outer);
    if (outer === null || view === undefined) {
      this.card.hidden = true;
      return;
    }
    const rows: HTMLElement[] = [];
    const head = el(this.doc, 'div', 'v3p-card-head');
    const name = say(this.lookup, `web.outer.${outer}.name`);
    if (view.state === 'hidden') {
      head.append(el(this.doc, 'div', 'v3p-card-name', this.t('panel.outer.unknown')));
      rows.push(head);
      // A board not in the game yet says so now, not 「第 30 波出現」 and then 「即將推出」.
      if (outerView(this.web, this.progress, outer) === 'absent') {
        rows.push(el(this.doc, 'div', 'v3p-tip-line', this.t('panel.outer.absent')));
      } else {
        const wave = this.web.def.revealAt15.includes(outer) ? 15 : 30;
        rows.push(el(this.doc, 'div', 'v3p-tip-line', this.t('panel.outer.revealAt', { wave })));
      }
    } else {
      const card = previewCard(this.web, this.progress, outer, this.lookup);
      head.append(
        el(this.doc, 'div', 'v3p-card-name', name),
        el(this.doc, 'div', 'v3p-card-sub', this.t('panel.card.heading')),
      );
      rows.push(head);
      if (view.state === 'absent' || view.state === 'locked') {
        const note =
          view.state === 'locked' ? this.t('web.buy.locked') : this.t('panel.outer.absent');
        rows.push(el(this.doc, 'div', 'v3p-tip-line', note));
      }
      if (card.entry.length > 0) {
        rows.push(el(this.doc, 'h3', '', this.t('panel.card.entry')));
        for (const line of card.entry) rows.push(el(this.doc, 'div', 'v3p-tip-line', line));
      }
      rows.push(el(this.doc, 'h3', '', this.t('panel.card.fusion')));
      if (card.fusion === null) {
        rows.push(el(this.doc, 'div', 'v3p-tip-line', this.t('panel.card.noFusion')));
      } else {
        const hand = card.fusion.hand ? ` · ${this.t('panel.card.hand')}` : '';
        const head = this.t('web.coreName', { name: card.fusion.name, title: card.fusion.title });
        rows.push(el(this.doc, 'div', 'v3p-card-fusion', `${head}${hand}`));
        for (const line of card.fusion.rule) rows.push(el(this.doc, 'div', 'v3p-tip-line', line));
      }
      const join = this.t('web.join.list');
      if (card.covers.answer.length > 0) {
        rows.push(
          el(
            this.doc,
            'div',
            'v3p-tip-line',
            this.t('panel.card.answer', { enemies: card.covers.answer.join(join) }),
          ),
        );
      }
      if (card.covers.helps.length > 0) {
        rows.push(
          el(
            this.doc,
            'div',
            'v3p-tip-line',
            this.t('panel.card.helps', { enemies: card.covers.helps.join(join) }),
          ),
        );
      }
      const gate = el(
        this.doc,
        'div',
        'v3p-card-gate',
        this.t('panel.spoke', {
          center: card.gate.center,
          centerNeed: card.gate.centerNeed,
          outer: name,
          count: card.gate.outer ?? 0,
          outerNeed: card.gate.outerNeed ?? 0,
        }),
      );
      gate.dataset.ready = String(
        card.gate.center >= card.gate.centerNeed &&
          (card.gate.outer ?? 0) >= (card.gate.outerNeed ?? 0),
      );
      rows.push(gate);
      if (view.state === 'collapsed') {
        rows.push(el(this.doc, 'div', 'v3p-tip-action', this.t('panel.outer.open')));
      }
    }
    if (this.pinned !== null) {
      const buttons = el(this.doc, 'div', 'v3p-card-buttons');
      if (view.state === 'open' && view.invested === 0 && this.expanded.has(outer)) {
        const collapse = el(this.doc, 'button', 'v3p-collapse', this.t('panel.card.collapse'));
        collapse.type = 'button';
        collapse.onclick = () => {
          this.expanded.delete(outer);
          this.refresh();
        };
        buttons.append(collapse);
      }
      const close = el(this.doc, 'button', 'v3p-close', this.t('panel.card.close'));
      close.type = 'button';
      close.onclick = () => {
        this.pinned = null;
        this.drawCard();
      };
      buttons.append(close);
      rows.push(buttons);
    }
    this.card.replaceChildren(...rows);
    this.card.dataset.outer = outer;
    this.card.hidden = false;
  }

  // Actions.

  private apply(progress: CharacterProgress): void {
    this.progress = progress;
    this.pending = null;
    this.refundArmed = false;
    this.options.onChange(progress);
    this.refresh();
  }

  private clickNode(id: string): void {
    if (this.pending !== null && this.pending.id === id) {
      this.confirmPath();
      return;
    }
    const plan = planClick(this.web, this.progress, this.options.account, id);
    if (plan.kind === 'buy') {
      this.apply(buy(this.web, this.progress, this.options.account, id));
    } else if (plan.kind === 'path') {
      this.pending = plan;
      this.draw();
    } else if (this.pending !== null) {
      this.cancelPath();
    }
  }

  private confirmPath(): void {
    const plan = this.pending;
    if (plan === null) return;
    const now = planClick(this.web, this.progress, this.options.account, plan.id);
    if (now.kind === 'refused') {
      this.cancelPath();
      return;
    }
    this.apply(buyPath(this.web, this.progress, this.options.account, plan.id));
  }

  private cancelPath(): void {
    this.pending = null;
    this.draw();
  }

  private refund(id: string): void {
    if (id === this.web.root) return;
    const rank = this.progress.ranks[id];
    if (rank === undefined || rank < 1) return;
    this.apply(refundNode(this.web, this.progress, this.options.account, id));
  }

  private onRefundAll(): void {
    if (!this.refundArmed) {
      this.refundArmed = true;
      this.drawSlots();
      return;
    }
    this.apply(refundAll(this.progress));
  }

  private openPrestige(): void {
    if (prestigeOffer(this.progress) === null) return;
    this.pending = null;
    this.refundArmed = false;
    this.prestigeOpen = true;
    this.draw();
  }

  private closePrestige(): void {
    this.prestigeOpen = false;
    this.drawPrestige();
  }

  /** The prestige, saved through onChange as any purchase is; the camera goes home. */
  private confirmPrestige(): void {
    if (prestigeOffer(this.progress) === null) return;
    this.prestigeOpen = false;
    this.pinned = null;
    this.expanded.clear();
    this.camera = homeCamera(this.layout.bounds);
    this.apply(prestige(this.progress));
  }

  private clickOuter(outer: OuterId): void {
    const view = this.model.outers.find((o) => o.outer === outer);
    if (view === undefined) return;
    if (view.state === 'collapsed') this.expanded.add(outer);
    this.pinned = outer;
    this.refresh();
  }

  private setLevel(level: ZoomLevel, at?: { x: number; y: number }): void {
    if (level === this.camera.level) return;
    this.camera = zoomTo(this.camera, level, this.viewport, this.fit, this.layout.bounds, at);
    this.draw();
  }

  // Events.

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | SVGSVGElement | Document,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, options);
    this.cleanups.push(() => target.removeEventListener(type, listener, options));
  }

  private local(event: MouseEvent): { x: number; y: number } {
    const rect = this.stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** The node id or outer under an event's target. */
  private hit(target: EventTarget | null): { node: string | null; outer: OuterId | null } {
    const element = target instanceof Element ? target : null;
    const node = element?.closest('.v3p-node')?.getAttribute('data-id') ?? null;
    if (node !== null) return { node, outer: null };
    const outer = element?.closest('[data-outer]')?.getAttribute('data-outer') ?? null;
    return { node: null, outer: outer as OuterId | null };
  }

  private bindEvents(): void {
    this.listen(
      this.svg,
      'wheel',
      (event) => {
        event.preventDefault();
        const level = wheelLevel(this.camera.level, event.deltaY);
        this.setLevel(level, this.local(event));
      },
      { passive: false },
    );
    this.listen(this.svg, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      this.drag = { ...this.local(event), camera: this.camera, moved: false };
    });
    this.listen(this.doc, 'pointermove', (event) => {
      const drag = this.drag;
      if (drag === null) return;
      const at = this.local(event);
      const dx = at.x - drag.x;
      const dy = at.y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      if (!drag.moved) {
        drag.moved = true;
        this.svg.dataset.dragging = 'true';
        this.svg.setPointerCapture?.(event.pointerId);
        this.hovered = null;
        this.tip.hidden = true;
      }
      this.camera = panBy(drag.camera, dx, dy, this.fit, this.layout.bounds);
      this.applyCamera();
    });
    this.listen(this.doc, 'pointerup', (event) => {
      const drag = this.drag;
      this.drag = null;
      this.svg.dataset.dragging = 'false';
      if (drag === null || drag.moved || event.button !== 0) return;
      const { node, outer } = this.hit(event.target);
      if (node !== null) this.clickNode(node);
      else if (outer !== null) this.clickOuter(outer);
      else if (this.pending !== null) this.cancelPath();
    });
    this.listen(this.svg, 'contextmenu', (event) => {
      event.preventDefault();
      const { node } = this.hit(event.target);
      if (node !== null) this.refund(node);
    });
    this.listen(this.svg, 'mousemove', (event) => {
      this.pointer = this.local(event);
      if (this.drag?.moved === true) return;
      const { node, outer } = this.hit(event.target);
      if (node !== this.hovered) {
        this.hovered = node;
        this.drawTip();
      } else if (node !== null) {
        this.placeTip();
      }
      const shown = node === null ? outer : null;
      if (shown !== this.cardOuter) {
        this.cardOuter = shown;
        this.drawCard();
      }
    });
    this.listen(this.svg, 'mouseleave', () => {
      this.hovered = null;
      this.tip.hidden = true;
      if (this.cardOuter !== null) {
        this.cardOuter = null;
        this.drawCard();
      }
    });
    this.listen(this.doc, 'keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (this.prestigeOpen) this.closePrestige();
      else if (this.pending !== null) this.cancelPath();
      else if (this.pinned !== null) {
        this.pinned = null;
        this.drawCard();
      }
    });
  }
}
