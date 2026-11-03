/**
 * The select screen (docs/v3/game-design-v3.md §1.1, §8 item 10): four cards, one per character,
 * each with its construct on a preview, its one-liner, its difficulty stars and the enemies it is
 * strong and weak against (its enemyRow). A playable card's preview is a fixed-seed loop of a real
 * run; a locked card shows its construct still and cannot be picked: 「完整版」 outside the build's
 * scope (the Demo's 霜晶 and 雷塔, gd §1.1, §10), else 「製作中」. The cursor starts on the
 * last character picked, else on the first pick, which carries 「第一次玩推薦」. Only the card under
 * the cursor animates (docs/v3/implementation-plan-v3.md §6's fallback): the others pause.
 */

import type { CharacterId } from '../../data/sources';
import { ROW_ENEMIES } from '../../data/web';
import type { CharacterDef } from '../../data/web';
import { isMessageKey, t } from '../../i18n';
import { enemyIcon } from './enemyIcons';
import { el } from '../style';

/** A card's preview, mounted by the page (a replay, or a still). */
export interface CardPreview {
  play(): void;
  pause(): void;
  destroy(): void;
}

/** Why a card cannot be picked (src/app/v3/scope.ts' cardLock); null when it can. */
export type SelectLock = 'fullVersion' | 'inProgress' | null;

export interface SelectCard {
  readonly def: CharacterDef;
  /** False while the character is 「製作中」 (center null) or outside the scope. */
  readonly playable: boolean;
  /** The locked card's label: 「完整版」 outside the scope, 「製作中」 otherwise. */
  readonly lock?: SelectLock;
  /** The character's all-time best wave; 0 before a run. */
  readonly bestWave: number;
}

export interface SelectOptions {
  readonly cards: readonly SelectCard[];
  readonly cursor: CharacterId;
  /** The card that says 「第一次玩推薦」. */
  readonly firstPick: CharacterId;
  /** Mounts a card's preview into `host`: a replay for a playable card, a still otherwise. */
  mountPreview(host: HTMLElement, card: SelectCard): CardPreview;
  onPick(character: CharacterId): void;
}

/** The preview area's size in CSS px. */
export const PREVIEW_WIDTH = 248;
export const PREVIEW_HEIGHT = 186;

interface Mounted {
  readonly card: SelectCard;
  readonly root: HTMLElement;
  readonly preview: CardPreview;
}

export class SelectScreen {
  readonly root: HTMLElement;
  private readonly mounted: Mounted[] = [];
  private cursor: CharacterId;
  private readonly onKey = (event: KeyboardEvent): void => this.key(event);

  constructor(
    doc: Document,
    private readonly options: SelectOptions,
  ) {
    this.root = el(doc, 'div', 'bc-ui bc-game-select');
    this.cursor = options.cursor;
    const header = el(doc, 'div', 'bc-game-select-header');
    header.append(
      el(doc, 'div', 'bc-game-select-title', t('select.title')),
      el(doc, 'div', 'bc-game-select-sub', t('select.subtitle')),
    );
    const row = el(doc, 'div', 'bc-game-select-cards');
    this.root.append(header, row, el(doc, 'div', 'bc-game-select-hint', t('select.hint')));
    for (const card of options.cards) row.append(this.cardOf(doc, card));
    doc.defaultView?.addEventListener('keydown', this.onKey);
    this.moveCursor(this.cursor);
  }

  destroy(): void {
    this.root.ownerDocument.defaultView?.removeEventListener('keydown', this.onKey);
    for (const { preview } of this.mounted) preview.destroy();
    this.mounted.length = 0;
    this.root.remove();
  }

  private cardOf(doc: Document, card: SelectCard): HTMLElement {
    const { def } = card;
    const root = el(doc, 'button', 'bc-game-card');
    root.type = 'button';
    root.dataset['character'] = def.id;
    root.style.setProperty('--c', `#${def.color.toString(16).padStart(6, '0')}`);
    root.disabled = false;
    root.setAttribute('aria-disabled', card.playable ? 'false' : 'true');
    if (!card.playable) root.classList.add('bc-game-card-locked');

    const preview = el(doc, 'div', 'bc-game-card-preview');
    preview.style.width = `${PREVIEW_WIDTH}px`;
    preview.style.height = `${PREVIEW_HEIGHT}px`;
    if (def.id === this.options.firstPick && card.playable) {
      preview.append(el(doc, 'div', 'bc-game-card-badge', t('select.firstPick')));
    }
    if (!card.playable) {
      const full = card.lock === 'fullVersion';
      const badge = el(
        doc,
        'div',
        'bc-game-card-badge bc-game-card-wip',
        t(full ? 'select.fullVersion' : 'select.inProgress'),
      );
      badge.dataset['lock'] = full ? 'fullVersion' : 'inProgress';
      preview.append(badge);
    }

    const name = el(doc, 'div', 'bc-game-card-name', t(def.nameKey));
    const stars = el(doc, 'div', 'bc-game-card-stars');
    stars.append(
      el(doc, 'span', 'bc-label', t('select.difficulty')),
      el(
        doc,
        'span',
        'bc-game-card-star',
        '★'.repeat(def.difficulty) + '☆'.repeat(2 - def.difficulty),
      ),
    );
    stars.dataset['difficulty'] = String(def.difficulty);
    // A character's one-liner comes with its batch's text; until then its card has none.
    const intro = el(
      doc,
      'div',
      'bc-game-card-intro',
      isMessageKey(def.introKey) ? t(def.introKey) : '',
    );
    const rows = el(doc, 'div', 'bc-game-card-rows');
    rows.append(this.enemyRow(doc, card, 'strong'), this.enemyRow(doc, card, 'weak'));
    const parts: HTMLElement[] = [preview, name, stars, intro, rows];
    if (card.bestWave > 0) {
      parts.push(
        el(doc, 'div', 'bc-game-card-best', t('select.bestWave', { wave: card.bestWave })),
      );
    }
    root.append(...parts);

    root.addEventListener('pointerenter', () => this.moveCursor(def.id));
    root.addEventListener('focus', () => this.moveCursor(def.id));
    root.addEventListener('click', () => this.pick(def.id));
    this.mounted.push({ card, root, preview: this.options.mountPreview(preview, card) });
    return root;
  }

  private enemyRow(doc: Document, card: SelectCard, mark: 'strong' | 'weak'): HTMLElement {
    const row = el(doc, 'div', `bc-game-card-enemies bc-game-card-${mark}`);
    row.append(el(doc, 'span', 'bc-label', t(mark === 'strong' ? 'select.strong' : 'select.weak')));
    const icons = el(doc, 'span', 'bc-game-card-icons');
    for (const enemy of ROW_ENEMIES) {
      if (card.def.enemyRow[enemy] === mark) icons.append(enemyIcon(doc, enemy));
    }
    row.append(icons);
    return row;
  }

  private moveCursor(character: CharacterId): void {
    this.cursor = character;
    for (const { card, root, preview } of this.mounted) {
      const on = card.def.id === character;
      root.classList.toggle('bc-game-card-cursor', on);
      if (on) preview.play();
      else preview.pause();
    }
  }

  private pick(character: CharacterId): void {
    const card = this.mounted.find((m) => m.card.def.id === character)?.card;
    if (card === undefined || !card.playable) return;
    this.options.onPick(character);
  }

  private key(event: KeyboardEvent): void {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const index = this.mounted.findIndex((m) => m.card.def.id === this.cursor);
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = this.mounted[(index + step + this.mounted.length) % this.mounted.length];
      if (next !== undefined) this.moveCursor(next.card.def.id);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.pick(this.cursor);
    }
  }
}
