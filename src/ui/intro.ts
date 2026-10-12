/** First-launch overlay: three lines on how the game plays, then a start button. */

import { t } from '../i18n';
import { el } from './style';

export class IntroPanel {
  readonly root: HTMLElement;

  constructor(doc: Document, onStart: () => void) {
    this.root = el(doc, 'div', 'bc-ui bc-intro');
    this.root.hidden = true;
    const card = el(doc, 'div', 'bc-intro-card');
    const lines = el(doc, 'ol', 'bc-intro-lines');
    lines.append(
      el(doc, 'li', '', t('intro.auto')),
      el(doc, 'li', '', t('intro.goal')),
      el(doc, 'li', '', t('intro.talents')),
    );
    const start = el(doc, 'button', 'bc-button bc-button-primary', t('intro.start'));
    start.type = 'button';
    start.addEventListener('click', onStart);
    card.append(el(doc, 'div', 'bc-intro-title', t('intro.title')), lines, start);
    this.root.append(card);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }
}
