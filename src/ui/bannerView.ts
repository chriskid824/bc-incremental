/**
 * The banner's line on the page (src/ui/banner.ts): a strip at the top of the screen that slides
 * down to show a line and back up to hide it (.bc-banner in src/ui/style.ts). It takes no input,
 * so clicks pass through to the game.
 */

import type { BannerView } from './banner';
import { el } from './style';

export class BannerLine implements BannerView {
  readonly root: HTMLElement;

  constructor(doc: Document) {
    this.root = el(doc, 'div', 'bc-ui bc-banner');
    this.root.setAttribute('role', 'status');
  }

  show(text: string): void {
    this.root.textContent = text;
    this.root.classList.add('bc-visible');
  }

  hide(): void {
    this.root.classList.remove('bc-visible');
  }
}
