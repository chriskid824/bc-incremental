/** End-of-run panel: why the run ended, how far it got, what it earned and what was bought. */

import { formatNum } from '../core/format';
import type { Num } from '../core/num';
import type { TalentNode } from '../data/types';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import type { EndReason } from '../sim/types';
import { talentName } from './strings';
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
  readonly purchases: readonly {
    readonly talent: Pick<TalentNode, 'id' | 'nameKey'>;
    readonly count: number;
  }[];
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

  constructor(
    private readonly doc: Document,
    onContinue: () => void,
  ) {
    this.root = el(doc, 'div', 'bc-ui bc-result');
    this.root.hidden = true;
    this.card = el(doc, 'div', 'bc-result-card');
    this.next = el(doc, 'div', 'bc-result-next');
    this.root.append(this.card);
    this.root.addEventListener('click', () => onContinue());
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

    const talents = el(doc, 'div', 'bc-result-talents');
    const bought = info.purchases.map((p) =>
      p.count > 1
        ? t('result.talentRank', { name: talentName(p.talent), count: p.count })
        : talentName(p.talent),
    );
    talents.append(
      el(doc, 'span', 'bc-label', t('result.talents')),
      doc.createTextNode(
        bought.length > 0 ? bought.join(t('result.talentSeparator')) : t('result.talentsNone'),
      ),
    );

    this.shownSeconds = '';
    this.card.replaceChildren(run, title, rows, talents, this.next);
    this.root.hidden = false;
    // Next frame, so the opacity transition runs.
    requestAnimationFrame(() => {
      if (!this.root.hidden) this.root.classList.add('bc-visible');
    });
  }

  /** Updates the countdown to the next run. */
  setTimeLeft(ms: number): void {
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
