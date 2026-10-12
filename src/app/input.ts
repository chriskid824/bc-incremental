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
