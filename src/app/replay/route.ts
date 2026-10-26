/**
 * The `?replay=` page (docs/v3 C10 design §1.7), which main.ts loads instead of the game: a chunk
 * of its own, so the M1 page and `?hive` never fetch it. It writes no storage, sends no playtest
 * event and calls no platform API, which lets the Steam shell open it (--bc-replay, the lead's
 * ruling L1). The canvas fills the window, re-created when the window settles at a new size,
 * unless `&width=` fixes it; `&step=1` exposes the handle as `window.__replay` for captures; a
 * done readout keeps its block on screen, resize or not. Errors are dev text, in English.
 */

import { createReplay } from './replay';
import type { ReplayHandle } from './replay';
import { parseReplayRoute } from './specs';
import type { ReplayRoute } from './specs';

/** A window drag fires resizes in bursts: the replay is re-created once they settle (初始值). */
const RESIZE_SETTLE_MS = 250;

function showError(root: HTMLElement, message: string): void {
  const box = document.createElement('pre');
  box.style.cssText = 'margin:16px;color:#ff8a8a;font:14px/1.4 ui-monospace,monospace;';
  box.textContent = `replay: ${message}`;
  root.replaceChildren(box);
}

/** The canvas's CSS size: `&width=` at 16:9, else the window's. */
function sizeOf(route: ReplayRoute): { width: number; height: number } {
  if (route.width === null) return { width: window.innerWidth, height: window.innerHeight };
  return { width: route.width, height: Math.round((route.width * 9) / 16) };
}

/** Opens the replay `search` (location.search) names in `root`, or says why it cannot. */
export async function startReplayRoute(root: HTMLElement, search: string): Promise<void> {
  const route = parseReplayRoute(search);
  if ('error' in route) {
    showError(root, route.error);
    return;
  }
  const open = (): Promise<ReplayHandle> =>
    createReplay(root, route.spec, {
      ...sizeOf(route),
      mode: route.step ? 'step' : 'play',
      frameTicks: route.frameTicks,
      // The readout times play mode's frames; a capture's are its own (C10.5b).
      readout: route.readout && !route.step,
      ...(route.step ? { resolution: 1 } : {}),
    });
  const expose = (handle: ReplayHandle): void => {
    if (route.step) Object.assign(window, { __replay: handle });
  };
  const first = await open();
  expose(first);
  if (route.width !== null) return;
  /** The handle in `handle`'s place at the window's size now: itself while its readout is done. */
  const recreate = async (handle: ReplayHandle | null): Promise<ReplayHandle | null> => {
    if (handle !== null) {
      if (route.readout && handle.frameStats().phase === 'done') return handle;
      handle.destroy();
    }
    try {
      const next = await open();
      expose(next);
      return next;
    } catch (error) {
      showError(root, String(error));
      return null;
    }
  };
  // Each re-creation waits for the one before it and replaces the handle that one made (null
  // when it failed): a settle during a re-creation never destroys a handle twice or leaks the
  // one being made, and the last settle's size wins (the lead's ruling H9).
  let last: Promise<ReplayHandle | null> = Promise.resolve(first);
  let pending: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      last = last.then(recreate);
    }, RESIZE_SETTLE_MS);
  });
}
