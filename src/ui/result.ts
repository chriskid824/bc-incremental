/** End-of-run panel: why the run ended, how far it got and what it earned. */

import { formatNum } from '../core/format';
import type { Num } from '../core/num';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import type { EndReason } from '../sim/types';
import { el } from './style';

export interface ResultInfo {
  readonly runNumber: number;
  readonly endReason: EndReason;
  readonly startWave: number;
  readonly highestWave: number;
  readonly kills: number;
  readonly shardsFromRun: Num;
  readonly coresFromRun: number;
  /** Whether the start wave was cleared, which skip compensation requires. */
  readonly clearedStartWave: boolean;
  readonly skipShards: Num;
  readonly skipCores: number;
  /** A talent is affordable: the panel leads to the talent web instead of counting down. */
  readonly affordable: boolean;
}

export interface ResultActions {
  /** Click anywhere: talent web if affordable, else the next run. */
  continue(): void;
  openTalents(): void;
  nextRun(): void;
}

const FORMAT = { format: 'short' } as const;

const TITLES: Readonly<Record<EndReason, MessageKey>> = {
  death: 'result.title.death',
  timeout: 'result.title.timeout',
  waveCap: 'result.title.waveCap',
};

export class ResultPanel {
  readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly next: HTMLElement;
  private shownSeconds = '';

  private readonly actions: HTMLElement;
  private readonly talentsButton: HTMLButtonElement;

  constructor(
    private readonly doc: Document,
    handlers: ResultActions,
  ) {
    this.root = el(doc, 'div', 'bc-ui bc-result');
    this.root.hidden = true;
    this.card = el(doc, 'div', 'bc-result-card');
    this.next = el(doc, 'div', 'bc-result-next');
    this.actions = el(doc, 'div', 'bc-result-actions');
    this.talentsButton = el(doc, 'button', 'bc-button', t('result.toTalents'));
    const nextButton = el(doc, 'button', 'bc-button', t('result.nextRun'));
    this.talentsButton.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.openTalents();
    });
    nextButton.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.nextRun();
    });
    this.actions.append(this.talentsButton, nextButton);
    this.root.append(this.card);
    this.root.addEventListener('click', () => handlers.continue());
  }

  show(info: ResultInfo): void {
    const doc = this.doc;
    const run = el(doc, 'div', 'bc-label', t('result.run', { run: info.runNumber }));
    const title = el(doc, 'div', 'bc-result-title', t(TITLES[info.endReason]));
    title.dataset['reason'] = info.endReason;

    const rows = el(doc, 'dl', 'bc-result-rows');
    const row = (label: string, value: string): void => {
      rows.append(el(doc, 'dt', '', label), el(doc, 'dd', '', value));
    };
    row(t('result.highestWave'), String(info.highestWave));
    row(t('result.startWave'), String(info.startWave));
    row(t('result.kills'), String(info.kills));
    row(t('result.shardsFromRun'), formatNum(info.shardsFromRun, FORMAT));
    row(t('result.coresFromRun'), String(info.coresFromRun));
    let skip: string;
    if (info.startWave <= 1) skip = t('result.skipNone');
    else if (!info.clearedStartWave) skip = t('result.skipNotCleared');
    else {
      skip = t('result.skipValue', {
        shards: formatNum(info.skipShards, FORMAT),
        cores: info.skipCores,
      });
    }
    row(t('result.skipCompensation'), skip);

    this.talentsButton.classList.toggle('bc-button-glow', info.affordable);
    this.talentsButton.classList.toggle('bc-button-primary', info.affordable);
    const hint = el(doc, 'div', 'bc-result-hint', info.affordable ? t('result.affordable') : '');

    this.shownSeconds = '';
    this.next.textContent = '';
    this.card.replaceChildren(run, title, rows, this.actions, info.affordable ? hint : this.next);
    this.root.hidden = false;
    // Next frame, so the opacity transition runs.
    requestAnimationFrame(() => {
      if (!this.root.hidden) this.root.classList.add('bc-visible');
    });
  }

  /** Updates the countdown to the next run; 0 hides it. */
  setTimeLeft(ms: number): void {
    if (ms <= 0) return;
    const seconds = (Math.max(0, ms) / 1000).toFixed(1);
    if (seconds === this.shownSeconds) return;
    this.shownSeconds = seconds;
    this.next.textContent = t('result.next', { seconds });
  }

  hide(): void {
    this.root.classList.remove('bc-visible');
    this.root.hidden = true;
  }
}
