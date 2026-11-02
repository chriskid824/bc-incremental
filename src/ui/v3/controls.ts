/**
 * The v3 page's small controls: the save notices (src/ui/saveNotice.ts' text, with 「重新開始」 on
 * an unreadable save), the start-wave picker beside the talent web (M1's slider: 1 to the highest
 * allowed wave), and the run's pause button with its 「暫停中」 veil.
 */

import { formatNum } from '../../core/format';
import type { CharacterId } from '../../data/sources';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import type { SaveNotice } from '../../save/profile';
import { saveNoticeText } from '../saveNotice';
import { el } from '../style';

const FORMAT = { format: 'short' } as const;

export class NoticeList {
  readonly root: HTMLElement;

  constructor(
    private readonly doc: Document,
    private readonly characterName: (c: CharacterId) => string,
  ) {
    this.root = el(doc, 'div', 'bc-ui bc-game-notices');
  }

  /** Removes the cards of `kind` (v1Waiting once the first pick claimed the progress). */
  dismiss(kind: SaveNotice['kind']): void {
    for (const card of this.root.querySelectorAll<HTMLElement>(`[data-notice="${kind}"]`)) {
      card.remove();
    }
  }

  /** Adds one card per notice; `startOver` puts the button on an `unreadable` one. */
  show(notices: readonly SaveNotice[], startOver?: () => void): void {
    for (const notice of notices) {
      const text = saveNoticeText(notice, {
        shards: (value) => formatNum(value, FORMAT),
        character: this.characterName,
      });
      const card = el(this.doc, 'div', 'bc-game-notice');
      card.dataset['notice'] = notice.kind;
      card.append(el(this.doc, 'div', 'bc-game-notice-text', t(text.key, text.values)));
      const buttons = el(this.doc, 'div', 'bc-game-notice-buttons');
      if (notice.kind === 'unreadable' && startOver !== undefined) {
        const again = el(
          this.doc,
          'button',
          'bc-button bc-button-small',
          t('save.action.startOver'),
        );
        again.type = 'button';
        again.addEventListener('click', () => {
          card.remove();
          startOver();
        });
        buttons.append(again);
      }
      const ok = el(
        this.doc,
        'button',
        'bc-button bc-button-small bc-button-quiet',
        t('v3.notice.dismiss'),
      );
      ok.type = 'button';
      ok.addEventListener('click', () => card.remove());
      buttons.append(ok);
      card.append(buttons);
      this.root.append(card);
    }
  }
}

export class StartWavePicker {
  readonly root: HTMLElement;
  private readonly value: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly hint: HTMLElement;

  constructor(doc: Document, onPick: (wave: number) => void) {
    this.root = el(doc, 'div', 'bc-ui bc-game-wave');
    const box = el(doc, 'div', 'bc-game-wave-box');
    this.value = el(doc, 'div', 'bc-talents-wave-value');
    this.input = el(doc, 'input', 'bc-talents-wave-input');
    this.input.type = 'range';
    this.input.min = '1';
    this.input.step = '1';
    this.input.addEventListener('input', () => onPick(Number(this.input.value)));
    this.hint = el(doc, 'div', 'bc-game-wave-hint');
    box.append(
      el(doc, 'div', 'bc-label', t('talents.startWave')),
      this.value,
      this.input,
      this.hint,
    );
    this.root.append(box);
    this.root.hidden = true;
  }

  set(wave: number, max: number): void {
    this.input.max = String(max);
    this.input.value = String(wave);
    this.input.disabled = max <= 1;
    this.value.textContent = t('talents.startWaveValue', { wave, max });
    this.hint.textContent = t('v3.startWave.hint', { max });
  }
}

export class PauseControl {
  readonly root: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly veil: HTMLElement;
  private pausedValue = false;

  constructor(doc: Document, onToggle: () => void) {
    this.root = el(doc, 'div', 'bc-ui bc-game-pause');
    this.button = el(
      doc,
      'button',
      'bc-button bc-button-small bc-game-pause-button',
      t('v3.pause'),
    );
    this.button.type = 'button';
    this.button.addEventListener('click', () => onToggle());
    this.veil = el(doc, 'div', 'bc-game-paused', t('v3.paused'));
    this.veil.hidden = true;
    this.root.append(this.veil, this.button);
    this.root.hidden = true;
  }

  get paused(): boolean {
    return this.pausedValue;
  }

  set paused(on: boolean) {
    this.pausedValue = on;
    this.veil.hidden = !on;
    this.button.textContent = t((on ? 'v3.resume' : 'v3.pause') satisfies MessageKey);
  }
}
