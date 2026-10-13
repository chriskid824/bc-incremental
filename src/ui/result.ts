/** End-of-run panel: why the run ended, how far it got and what it earned. */

import { formatNum } from '../core/format';
import { num } from '../core/num';
import type { Num } from '../core/num';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import type { EndReason } from '../sim/types';
import { describeRunEnd } from './runEnd';
import type { EnemySpeeds, RunEndFacts } from './runEnd';
import { el } from './style';

export interface ResultInfo extends RunEndFacts {
  readonly runNumber: number;
  readonly startWave: number;
  readonly kills: number;
  /** Damage dealt per second over the whole run, all sources. */
  readonly averageDps: Num;
  readonly shardsFromRun: Num;
  readonly coresFromRun: number;
  /** Whether the start wave was cleared, which skip compensation requires. */
  readonly clearedStartWave: boolean;
  readonly skipShards: Num;
  readonly skipCores: number;
  /** A talent is affordable. */
  readonly affordable: boolean;
  /** The panel leads to the talent web instead of counting down (affordable, or T pressed). */
  readonly toTalents: boolean;
}

export interface ResultActions {
  /** Click anywhere: the talent web if the panel leads there, else the next run. */
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
    private readonly enemies: EnemySpeeds,
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
    const text = describeRunEnd(info, this.enemies);
    const cause = el(doc, 'div', 'bc-result-cause');
    if (text.cause !== null) cause.append(el(doc, 'div', 'bc-result-cause-main', text.cause));
    cause.append(el(doc, 'div', 'bc-result-cause-leaks', text.leaks));

    const rows = el(doc, 'dl', 'bc-result-rows');
    const row = (label: string, value: string): void => {
      rows.append(el(doc, 'dt', '', label), el(doc, 'dd', '', value));
    };
    row(t('result.highestWave'), String(info.highestWave));
    row(t('result.startWave'), String(info.startWave));
    row(t('result.kills'), String(info.kills));
    row(t('result.averageDps'), formatNum(info.averageDps, FORMAT));
    row(t('result.damageTaken'), formatNum(num(info.damageTaken), FORMAT));
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

    this.talentsButton.classList.toggle('bc-button-glow', info.toTalents);
    this.talentsButton.classList.toggle('bc-button-primary', info.toTalents);
    const hint = el(
      doc,
      'div',
      'bc-result-hint',
      info.affordable ? t('result.affordable') : t('result.toTalentsHint'),
    );

    this.shownSeconds = '';
    this.next.textContent = '';
    const parts: HTMLElement[] = [run, title, cause, rows];
    if (text.tip !== null) {
      const tip = el(doc, 'div', 'bc-result-tip');
      tip.append(el(doc, 'span', 'bc-result-tip-label', t('result.tipLabel')), text.tip);
      parts.push(tip);
    }
    parts.push(this.actions, info.toTalents ? hint : this.next);
    this.card.replaceChildren(...parts);
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
