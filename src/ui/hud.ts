/**
 * In-run HUD as a DOM overlay: wave, life, run currencies, run time and game speed.
 * Only the speed buttons take pointer input. Text nodes are written only when they change.
 */

import { formatNum } from '../core/format';
import type { Num } from '../core/num';
import { t } from '../i18n';
import { formatClock } from './strings';
import { el } from './style';

export interface HudInfo {
  readonly runNumber: number;
  readonly startWave: number;
  readonly wave: number;
  readonly life: number;
  readonly maxLife: number;
  readonly shards: Num;
  readonly cores: number;
  readonly elapsedSec: number;
  readonly limitSec: number;
  readonly speed: number;
}

const FORMAT = { format: 'short' } as const;

export class Hud<S extends number> {
  readonly root: HTMLElement;
  private readonly wave: HTMLElement;
  private readonly runLine: HTMLElement;
  private readonly time: HTMLElement;
  private readonly lifeValue: HTMLElement;
  private readonly lifeFill: HTMLElement;
  private readonly shards: HTMLElement;
  private readonly cores: HTMLElement;
  private readonly speedButtons = new Map<S, HTMLButtonElement>();
  private readonly shown = new Map<HTMLElement, string>();
  private lifeRatio = -1;
  private speed: number | null = null;

  constructor(doc: Document, speeds: readonly S[], onSpeed: (speed: S) => void) {
    this.root = el(doc, 'div', 'bc-ui bc-hud');

    const waveBox = el(doc, 'div', 'bc-hud-wave');
    this.wave = el(doc, 'div', 'bc-hud-wave-number');
    this.runLine = el(doc, 'div', 'bc-hud-sub');
    this.time = el(doc, 'div', 'bc-hud-sub');
    waveBox.append(el(doc, 'div', 'bc-label', t('hud.wave')), this.wave, this.runLine, this.time);

    const lifeBox = el(doc, 'div', 'bc-hud-life');
    const lifeRow = el(doc, 'div', 'bc-hud-life-row');
    this.lifeValue = el(doc, 'span', 'bc-hud-life-value');
    lifeRow.append(el(doc, 'span', 'bc-label', t('hud.life')), this.lifeValue);
    const bar = el(doc, 'div', 'bc-bar');
    this.lifeFill = el(doc, 'div', 'bc-bar-fill');
    bar.append(this.lifeFill);
    lifeBox.append(lifeRow, bar);

    const currency = el(doc, 'div', 'bc-hud-currency');
    this.shards = el(doc, 'span', 'bc-hud-currency-value');
    this.cores = el(doc, 'span', 'bc-hud-currency-value');
    currency.append(
      el(doc, 'span', 'bc-label', t('hud.shards')),
      this.shards,
      el(doc, 'span', 'bc-label', t('hud.cores')),
      this.cores,
    );

    const speedBox = el(doc, 'div', 'bc-hud-speed');
    const buttons = el(doc, 'div', 'bc-speed-buttons');
    for (const speed of speeds) {
      const button = el(doc, 'button', 'bc-speed-button', t('hud.speedOption', { speed }));
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => onSpeed(speed));
      this.speedButtons.set(speed, button);
      buttons.append(button);
    }
    speedBox.append(el(doc, 'span', 'bc-label', t('hud.speed')), buttons);

    this.root.append(waveBox, lifeBox, currency, speedBox);
  }

  update(info: HudInfo): void {
    this.set(this.wave, String(info.wave));
    this.set(this.runLine, t('hud.run', { run: info.runNumber, startWave: info.startWave }));
    this.set(
      this.time,
      t('hud.time', { elapsed: formatClock(info.elapsedSec), limit: formatClock(info.limitSec) }),
    );
    this.set(
      this.lifeValue,
      t('hud.lifeValue', { life: Math.ceil(info.life), maxLife: Math.ceil(info.maxLife) }),
    );
    const ratio = info.maxLife > 0 ? Math.min(1, Math.max(0, info.life / info.maxLife)) : 0;
    if (ratio !== this.lifeRatio) {
      this.lifeRatio = ratio;
      this.lifeFill.style.transform = `scaleX(${ratio})`;
    }
    this.set(this.shards, formatNum(info.shards, FORMAT));
    this.set(this.cores, String(info.cores));
    if (info.speed !== this.speed) {
      this.speed = info.speed;
      for (const [speed, button] of this.speedButtons) {
        button.setAttribute('aria-pressed', speed === info.speed ? 'true' : 'false');
      }
    }
  }

  private set(node: HTMLElement, text: string): void {
    if (this.shown.get(node) === text) return;
    this.shown.set(node, text);
    node.textContent = text;
  }
}
