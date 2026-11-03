/**
 * The v3 result screen (docs/v3/game-design-v3.md §1, §7's 結算, A.4): why the run ended (with
 * B1's bullet lines, Q11), how far it got, the shards and cores it earned and the character's best
 * wave, one tip on a death, and the way back to the talent web or straight into the next run; on
 * the account's first 3 runs, once a second character is playable, 「換一個角色試試」 back to the
 * select screen (gd §1.1). It waits for the player: no countdown, since the web is where the
 * shards go.
 */

import { formatNum } from '../../core/format';
import { num } from '../../core/num';
import type { Num } from '../../core/num';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import type { EndReason } from '../../sim/types';
import { el } from '../style';
import { describeV3RunEnd } from './runEnd';
import type { V3Enemies, V3RunEndFacts } from './runEnd';

export interface V3ResultInfo extends V3RunEndFacts {
  readonly runNumber: number;
  readonly characterName: string;
  readonly kills: number;
  readonly averageDps: Num;
  readonly shardsFromRun: Num;
  readonly coresFromRun: number;
  readonly skipShards: Num;
  readonly skipCores: number;
  /** The character's all-time best wave, the run settled. */
  readonly bestWave: number;
  /** The wallet's shards after the run. */
  readonly walletShards: Num;
  /** Shows 「換一個角色試試」 (src/app/v3/scope.ts' showsSwitchHint). */
  readonly switchHint?: boolean;
}

export interface V3ResultActions {
  toWeb(): void;
  nextRun(): void;
  /** 「換一個角色試試」: back to the select screen. */
  toSelect?(): void;
}

const FORMAT = { format: 'short' } as const;

const TITLES: Readonly<Record<EndReason, MessageKey>> = {
  death: 'result.title.death',
  timeout: 'result.title.timeout',
  waveCap: 'result.title.waveCap',
};

export class V3ResultPanel {
  readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly switchButton: HTMLButtonElement;

  constructor(
    private readonly doc: Document,
    private readonly enemies: V3Enemies,
    handlers: V3ResultActions,
  ) {
    this.root = el(doc, 'div', 'bc-ui bc-result');
    this.root.hidden = true;
    this.card = el(doc, 'div', 'bc-result-card');
    this.actions = el(doc, 'div', 'bc-result-actions');
    const web = el(doc, 'button', 'bc-button bc-button-primary', t('v3.result.toWeb'));
    web.type = 'button';
    web.dataset['action'] = 'web';
    web.addEventListener('click', () => handlers.toWeb());
    const again = el(doc, 'button', 'bc-button', t('v3.result.again'));
    again.type = 'button';
    again.dataset['action'] = 'again';
    again.addEventListener('click', () => handlers.nextRun());
    this.switchButton = el(doc, 'button', 'bc-button', t('v3.result.switch'));
    this.switchButton.type = 'button';
    this.switchButton.dataset['action'] = 'switch';
    this.switchButton.addEventListener('click', () => handlers.toSelect?.());
    this.actions.append(web, again, this.switchButton);
    this.root.append(this.card);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(info: V3ResultInfo): void {
    const doc = this.doc;
    const head = el(
      doc,
      'div',
      'bc-label',
      `${info.characterName} · ${t('result.run', { run: info.runNumber })}`,
    );
    const title = el(doc, 'div', 'bc-result-title', t(TITLES[info.endReason]));
    title.dataset['reason'] = info.endReason;
    const text = describeV3RunEnd(info, this.enemies);
    const cause = el(doc, 'div', 'bc-result-cause');
    if (text.cause !== null) cause.append(el(doc, 'div', 'bc-result-cause-main', text.cause));
    cause.append(el(doc, 'div', 'bc-result-cause-leaks', text.leaks));
    if (text.bullets !== null) {
      cause.append(el(doc, 'div', 'bc-result-cause-leaks bc-game-result-bullets', text.bullets));
    }
    if (text.reflected !== null) {
      cause.append(el(doc, 'div', 'bc-result-cause-leaks bc-game-result-bullets', text.reflected));
    }

    const rows = el(doc, 'dl', 'bc-result-rows');
    const row = (label: string, value: string): void => {
      rows.append(el(doc, 'dt', '', label), el(doc, 'dd', '', value));
    };
    row(t('result.highestWave'), String(info.highestWave));
    row(t('v3.result.bestWave'), String(info.bestWave));
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
    row(t('v3.result.wallet'), formatNum(info.walletShards, FORMAT));

    const parts: HTMLElement[] = [head, title, cause, rows];
    const tips = [text.lowerStart, text.tip].filter((line): line is string => line !== null);
    if (tips.length > 0) {
      const tip = el(doc, 'div', 'bc-result-tip');
      tip.append(...tips.map((line) => el(doc, 'div', 'bc-result-tip-line', line)));
      tip.firstElementChild?.prepend(el(doc, 'span', 'bc-result-tip-label', t('result.tipLabel')));
      parts.push(tip);
    }
    this.switchButton.hidden = info.switchHint !== true;
    parts.push(this.actions);
    this.card.replaceChildren(...parts);
    this.root.hidden = false;
    requestAnimationFrame(() => {
      if (!this.root.hidden) this.root.classList.add('bc-visible');
    });
  }

  hide(): void {
    this.root.classList.remove('bc-visible');
    this.root.hidden = true;
  }
}
