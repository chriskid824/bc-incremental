/**
 * STUB of the v3 talent-web panel, kept until the real one (built separately with this exact
 * API) is merged: the nodes in reach of the character's web, each with its price and a buy
 * button, the wallet, and the start and back buttons. Hidden and locked boards are left out, as
 * the real panel hides them (revealedOuters).
 */

import { formatNum } from '../../core/format';
import type { OuterId } from '../../data/sources';
import type { AssembledWeb } from '../../data/web';
import { t } from '../../i18n';
import type { Locale } from '../../i18n';
import { buy, canBuy, nextPrice, revealedOuters } from '../../meta/web';
import type { AccountProgress, BuyCheck, CharacterProgress, Price } from '../../meta/web';
import { nodeName } from '../web/names';
import { buyCheckText } from '../web/text';
import { el } from '../style';

export interface WebPanelOptions {
  readonly web: AssembledWeb;
  readonly account: AccountProgress;
  readonly locale: Locale;
  readonly initial: CharacterProgress;
  readonly onChange: (progress: CharacterProgress) => void;
  readonly onStartRun: () => void;
  readonly onBack: () => void;
}

const FORMAT = { format: 'short' } as const;

const STYLE_ID = 'bc-v3-web-stub-style';
const CSS = `
.bc-v3-web {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 24px 24px 24px;
  background: #0b0d12;
  box-sizing: border-box;
}
.bc-v3-web-title { font-size: 30px; font-weight: 800; }
.bc-v3-web-help { font-size: 15px; color: #8e98b3; margin-top: 4px; }
.bc-v3-web-wallet { font-size: 20px; font-weight: 700; }
.bc-v3-web-list {
  flex: 1;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  align-content: start;
  gap: 6px;
  padding-bottom: 150px;
}
.bc-v3-web-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(20, 24, 36, 0.92);
}
.bc-v3-web-rank { color: #9fe8ff; font-weight: 800; }
.bc-v3-web-row .bc-button:disabled { opacity: 0.5; cursor: default; }
.bc-v3-web-actions { position: fixed; right: 24px; bottom: 24px; display: flex; gap: 10px; }
`;

function injectStubStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.append(style);
}

/** Reasons a node in reach can still be refused: the wallet's. */
const WALLET_REASONS = new Set(['notEnoughShards', 'notEnoughCores', 'notEnoughResonance']);

function priceText(price: Price): string {
  const shards = formatNum(price.shards, FORMAT);
  return price.cores > 0
    ? t('v3.price.cores', { shards, cores: price.cores })
    : t('v3.price.shards', { shards });
}

export class WebPanel {
  private readonly root: HTMLElement;
  private readonly wallet: HTMLElement;
  private readonly list: HTMLElement;
  private progress: CharacterProgress;

  constructor(
    parent: HTMLElement,
    private readonly options: WebPanelOptions,
  ) {
    const doc = parent.ownerDocument;
    this.progress = options.initial;
    injectStubStyle(doc);
    this.root = el(doc, 'div', 'bc-ui bc-v3-web');
    const header = el(doc, 'div', 'bc-v3-web-header');
    header.append(
      el(doc, 'div', 'bc-v3-web-title', `${t(options.web.def.nameKey)} · ${t('talents.title')}`),
      el(doc, 'div', 'bc-v3-web-help', t('v3.webStub.help')),
    );
    this.wallet = el(doc, 'div', 'bc-v3-web-wallet');
    this.list = el(doc, 'div', 'bc-v3-web-list');
    const actions = el(doc, 'div', 'bc-v3-web-actions');
    const back = el(doc, 'button', 'bc-button bc-button-quiet', t('v3.characters'));
    back.type = 'button';
    back.dataset['action'] = 'back';
    back.addEventListener('click', () => options.onBack());
    const start = el(doc, 'button', 'bc-button bc-button-primary', t('talents.start'));
    start.type = 'button';
    start.dataset['action'] = 'start';
    start.addEventListener('click', () => options.onStartRun());
    actions.append(back, start);
    this.root.append(header, this.wallet, this.list, actions);
    parent.append(this.root);
    this.render();
  }

  setProgress(p: CharacterProgress): void {
    this.progress = p;
    this.render();
  }

  destroy(): void {
    this.root.remove();
  }

  /** The nodes in reach: a purchase refused for the wallet alone, or allowed. */
  private inReach(): { readonly id: string; readonly check: BuyCheck }[] {
    const { web, account } = this.options;
    const revealed = revealedOuters(web.def, this.progress.bestWave);
    const shown = (board: string): boolean => {
      if (!board.startsWith('outer.')) return true;
      return revealed.has(board.slice('outer.'.length) as OuterId);
    };
    const found: { id: string; check: BuyCheck }[] = [];
    for (const node of web.nodes) {
      if (node.kind === 'signature' || !shown(node.board)) continue;
      const check = canBuy(web, this.progress, account, node.id);
      if (check.ok || WALLET_REASONS.has(check.reason)) found.push({ id: node.id, check });
    }
    return found;
  }

  private render(): void {
    const doc = this.root.ownerDocument;
    const { web, account } = this.options;
    const { wallet } = this.progress;
    this.wallet.textContent = `${t('hud.shards')} ${formatNum(wallet.shards, FORMAT)} · ${t('hud.cores')} ${wallet.cores}`;
    const rows = this.inReach().map(({ id, check }) => {
      const row = el(doc, 'div', 'bc-v3-web-row');
      const name = el(doc, 'span', 'bc-v3-web-name', nodeName(web, id));
      const rank = this.progress.ranks[id] ?? 0;
      if (rank > 0) name.append(el(doc, 'span', 'bc-v3-web-rank', ` ${rank}`));
      const button = el(doc, 'button', 'bc-button bc-button-small');
      button.type = 'button';
      button.dataset['node'] = id;
      if (check.ok) {
        button.textContent = priceText(check.price);
        button.addEventListener('click', () => {
          if (!canBuy(web, this.progress, account, id).ok) return;
          this.progress = buy(web, this.progress, account, id);
          this.options.onChange(this.progress);
          this.render();
        });
      } else {
        button.textContent = priceText(nextPrice(web, this.progress, id));
        button.title = buyCheckText(check);
        button.disabled = true;
      }
      row.append(name, button);
      return row;
    });
    if (rows.length === 0) rows.push(el(doc, 'div', 'bc-v3-web-help', t('v3.webStub.empty')));
    this.list.replaceChildren(...rows);
  }
}
