/** Keyboard shortcuts of the browser build. */

import { SPEEDS } from './loop';
import type { Speed } from './loop';

/** Keys 1, 2 and 4 set the game speed. Returns a function that removes the listener. */
export function bindSpeedKeys(target: Window, onSpeed: (speed: Speed) => void): () => void {
  const listener = (event: KeyboardEvent): void => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const speed = SPEEDS.find((s) => event.key === String(s));
    if (speed !== undefined) onSpeed(speed);
  };
  target.addEventListener('keydown', listener);
  return () => target.removeEventListener('keydown', listener);
}

export interface MenuKeys {
  /** Space or Enter: start the first run from the intro, or the next one between runs. */
  confirm(): void;
  /** T: open the talent web between runs, or queue it for the end of the current run. */
  talents(): void;
}

/** Menu shortcuts. Returns a function that removes the listener. */
export function bindMenuKeys(target: Window, keys: MenuKeys): () => void {
  const listener = (event: KeyboardEvent): void => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement && event.key !== 'Enter') return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      keys.confirm();
    } else if (event.key === 't' || event.key === 'T') {
      keys.talents();
    }
  };
  target.addEventListener('keydown', listener);
  return () => target.removeEventListener('keydown', listener);
}
