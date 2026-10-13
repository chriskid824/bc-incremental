/** A short message near the top of the screen that fades out on its own. */

import { el } from './style';

/** How long a toast stays fully visible. */
const TOAST_MS = 2600;

export class Toast {
  readonly root: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(doc: Document) {
    this.root = el(doc, 'div', 'bc-ui bc-toast');
    this.root.setAttribute('role', 'status');
  }

  show(text: string): void {
    this.root.textContent = text;
    this.root.classList.add('bc-visible');
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.root.classList.remove('bc-visible');
    }, TOAST_MS);
  }
}
