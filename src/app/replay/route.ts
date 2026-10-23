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
  let handle = await open();
  expose(handle);
  if (route.width !== null) return;
  let pending: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      if (route.readout && handle.frameStats().phase === 'done') return;
      handle.destroy();
      open()
        .then((next) => {
          handle = next;
          expose(next);
        })
        .catch((error: unknown) => showError(root, String(error)));
    }, RESIZE_SETTLE_MS);
  });
}
