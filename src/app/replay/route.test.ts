/**
 * The `?replay=` page (route.ts, docs/v3 C10 design §1.7, §2.5) with createReplay a stub: the
 * options each route hands the component (a gif:'s frameTicks and width, step mode's resolution,
 * the readout on for renderStress and off in step mode), `window.__replay` in step mode, the
 * replay re-created once a resize settles, a done readout's block kept through a resize, a fixed
 * `&width=` never re-created, a bad route shown as an error, and a settle during a re-creation
 * chained on it, a failed one included (the lead's ruling H9).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameStats, ReplayOptions, ReplaySpec } from './types';

interface Created {
  readonly spec: ReplaySpec;
  readonly options: ReplayOptions;
  readonly handle: { frameStats(): Pick<FrameStats, 'phase'>; destroy(): void };
  phase: FrameStats['phase'];
  destroyed: number;
}

const created = vi.hoisted(() => [] as Created[]);
/**
 * While `hold` is set, createReplay's promise waits for the test, as app.init keeps a re-creation
 * in flight: `release` resolves the oldest one waiting, and `fail` rejects it.
 */
const deferred = vi.hoisted(() => ({
  hold: false,
  waiting: [] as { resolve(): void; reject(error: Error): void }[],
}));
const release = (): void => deferred.waiting.shift()?.resolve();
const fail = (error: Error): void => deferred.waiting.shift()?.reject(error);

vi.mock('./replay', () => ({
  createReplay: (_root: unknown, spec: ReplaySpec, options: ReplayOptions) => {
    const entry: Created = {
      spec,
      options,
      phase: 'warmup',
      destroyed: 0,
      handle: {
        frameStats: () => ({ phase: entry.phase }),
        destroy: () => {
          entry.destroyed++;
        },
      },
    };
    created.push(entry);
    if (!deferred.hold) return Promise.resolve(entry.handle);
    return new Promise((resolve, reject) =>
      deferred.waiting.push({ resolve: () => resolve(entry.handle), reject }),
    );
  },
}));

interface RouteModule {
  startReplayRoute(root: unknown, search: string): Promise<void>;
}

// A computed path: route.ts needs the DOM's types, which the tools' tsconfig (the tests') leaves
// out (main.test.ts loads main.ts the same way).
const ROUTE = './route';
const { startReplayRoute } = (await import(/* @vite-ignore */ ROUTE)) as RouteModule;

/** The window: its size, its resize listeners and whatever the page assigns to it. */
let win: {
  innerWidth: number;
  innerHeight: number;
  resizes: Set<() => void>;
  addEventListener(type: string, listener: () => void): void;
  __replay?: unknown;
};
/** What the page put in its root: an error's text. */
let shown: string[];
const root = {
  replaceChildren: (...nodes: { textContent: string }[]) => {
    shown.push(...nodes.map((node) => node.textContent));
  },
};

function resize(width: number, height: number): void {
  win.innerWidth = width;
  win.innerHeight = height;
  for (const listener of [...win.resizes]) listener();
}

beforeEach(() => {
  vi.useFakeTimers();
  created.length = 0;
  Object.assign(deferred, { hold: false, waiting: [] });
  shown = [];
  const resizes = new Set<() => void>();
  win = {
    innerWidth: 1280,
    innerHeight: 720,
    resizes,
    addEventListener: (type, listener) => {
      if (type === 'resize') resizes.add(listener);
    },
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    createElement: () => ({ style: { cssText: '' }, textContent: '' }),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startReplayRoute (docs/v3 C10 design §1.7)', () => {
  it('opens a gif: at 30 fps capture in step mode, at its fixed width, as window.__replay', async () => {
    await startReplayRoute(root, '?replay=gif:fire&step=1');
    expect(created).toHaveLength(1);
    expect(created[0]?.options).toEqual({
      width: 640,
      height: 360,
      mode: 'step',
      frameTicks: 2,
      readout: false,
      resolution: 1,
    });
    expect(win.__replay).toBe(created[0]?.handle);
    // A fixed width is never re-created.
    expect(win.resizes.size).toBe(0);
  });

  it('fills the window with renderStress and its readout, re-created once a resize settles', async () => {
    await startReplayRoute(root, '?replay=renderStress');
    expect(created[0]?.options).toEqual({
      width: 1280,
      height: 720,
      mode: 'play',
      frameTicks: 1,
      readout: true,
    });
    expect(win.__replay).toBeUndefined();
    resize(1100, 700);
    await vi.advanceTimersByTimeAsync(200);
    resize(1000, 600);
    await vi.advanceTimersByTimeAsync(249);
    expect([created.length, created[0]?.destroyed]).toEqual([1, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect([created.length, created[0]?.destroyed]).toEqual([2, 1]);
    expect(created[1]?.options).toMatchObject({ width: 1000, height: 600, readout: true });
  });

  it("keeps a done readout's block through a resize", async () => {
    await startReplayRoute(root, '?replay=renderStress');
    resize(1000, 600);
    await vi.advanceTimersByTimeAsync(250);
    const current = created[1];
    if (current === undefined) throw new Error('not re-created');
    current.phase = 'done';
    resize(800, 450);
    await vi.advanceTimersByTimeAsync(1000);
    expect([created.length, current.destroyed]).toEqual([2, 0]);
  });

  it('re-creates a step-mode replay with a new window.__replay, without its readout', async () => {
    await startReplayRoute(root, '?replay=renderStress&step=1');
    expect(created[0]?.options).toEqual({
      width: 1280,
      height: 720,
      mode: 'step',
      frameTicks: 1,
      readout: false,
      resolution: 1,
    });
    expect(win.__replay).toBe(created[0]?.handle);
    resize(1000, 600);
    await vi.advanceTimersByTimeAsync(250);
    expect(win.__replay).toBe(created[1]?.handle);
  });

  it('fixes the size at &width= and 16:9', async () => {
    await startReplayRoute(root, '?replay=preview:ice&width=480');
    expect(created[0]?.options).toMatchObject({ width: 480, height: 270, mode: 'play' });
    expect(win.resizes.size).toBe(0);
  });

  it('shows a bad route as an error and opens nothing', async () => {
    await startReplayRoute(root, '?replay=nothing');
    expect(created).toHaveLength(0);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/^replay: /);
  });

  it('chains a settle on the re-creation in flight: each handle destroyed once, the last size kept', async () => {
    await startReplayRoute(root, '?replay=renderStress&step=1');
    deferred.hold = true;
    resize(1000, 600);
    await vi.advanceTimersByTimeAsync(250);
    // The first re-creation is in flight: the first handle is destroyed, the second being made.
    expect(created.map((entry) => entry.destroyed)).toEqual([1, 0]);
    resize(800, 450);
    await vi.advanceTimersByTimeAsync(250);
    // The second settle waits for it: nothing more is destroyed or made yet.
    expect(created.map((entry) => entry.destroyed)).toEqual([1, 0]);
    deferred.hold = false;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(created.map((entry) => entry.destroyed)).toEqual([1, 1, 0]);
    expect(created[2]?.options).toMatchObject({ width: 800, height: 450, mode: 'step' });
    expect(win.__replay).toBe(created[2]?.handle);
    expect(shown).toEqual([]);
  });

  it('shows a failed re-creation and opens afresh at the next settle, destroying no handle twice', async () => {
    await startReplayRoute(root, '?replay=renderStress');
    deferred.hold = true;
    resize(1000, 600);
    await vi.advanceTimersByTimeAsync(250);
    fail(new Error('no WebGL'));
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual(['replay: Error: no WebGL']);
    deferred.hold = false;
    resize(900, 500);
    await vi.advanceTimersByTimeAsync(250);
    // The failed one made no handle: the next settle destroys nothing and opens at its size.
    expect(created.map((entry) => entry.destroyed)).toEqual([1, 0, 0]);
    expect(created[2]?.options).toMatchObject({ width: 900, height: 500, readout: true });
  });
});
