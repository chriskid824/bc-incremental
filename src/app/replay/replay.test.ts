/**
 * createReplay (docs/v3 C10 design §1.7, §2.5) as replay.ts wires it, on a stub page: Pixi's
 * Application and the game's Renderer are stubs, and so are the page's window, document,
 * navigator and requestAnimationFrame, so node runs the component itself: step mode's
 * frameTicks, play mode through FixedStepClock, the readout fed the rAF intervals, its restarts,
 * and its panel with Copy and a read-only textarea, `page:` read from the protocol.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fusionClipSpec } from './specs';
import type { FrameStats, ReplayOptions, ReplaySpec } from './types';

const stubs = vi.hoisted(() => ({
  /** Each Application's init options, and its render and destroy calls. */
  inits: [] as Record<string, unknown>[],
  renders: 0,
  appsDestroyed: 0,
  /** Each Renderer's options, its frames' alpha and ms, and its destroy calls. */
  renderers: [] as Record<string, unknown>[],
  draws: [] as (readonly [number, number])[],
  renderersDestroyed: 0,
}));

vi.mock('pixi.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Application: class {
    readonly canvas = { style: { display: '' }, width: 0, height: 0 };
    init(options: { width: number; height: number; resolution: number }): Promise<void> {
      stubs.inits.push(options);
      this.canvas.width = options.width * options.resolution;
      this.canvas.height = options.height * options.resolution;
      return Promise.resolve();
    }
    render(): void {
      stubs.renders++;
    }
    destroy(): void {
      stubs.appsDestroyed++;
    }
  },
}));
vi.mock('../../render', () => ({
  Renderer: class {
    constructor(_app: unknown, _data: unknown, options: Record<string, unknown>) {
      stubs.renderers.push(options);
    }
    restart(): void {}
    handleEvents(): void {}
    render(_state: unknown, alpha: number, frameMs: number): void {
      stubs.draws.push([alpha, frameMs]);
    }
    destroy(): void {
      stubs.renderersDestroyed++;
    }
  },
}));

/** A page object with listeners: the window, the document and the panel's elements. */
class Target {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
  count(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

/** What createPanel makes of an element. */
class StubElement extends Target {
  readonly style = { cssText: '', display: '' };
  readonly children: StubElement[] = [];
  textContent = '';
  hidden = false;
  readOnly = false;
  rows = 0;
  type = '';
  value = '';
  removed = false;
  selected = false;
  constructor(readonly tag: string) {
    super();
  }
  append(...nodes: StubElement[]): void {
    this.children.push(...nodes);
  }
  appendChild(node: StubElement): void {
    this.children.push(node);
  }
  remove(): void {
    this.removed = true;
  }
  select(): void {
    this.selected = true;
  }
}

interface Handle {
  readonly tick: number;
  pause(): void;
  step(frames?: number): void;
  seek(tick: number): void;
  frameStats(): FrameStats;
  destroy(): void;
}
interface ReplayModule {
  createReplay(host: unknown, spec: ReplaySpec, options: ReplayOptions): Promise<Handle>;
}

// A computed path: replay.ts needs the DOM's types, which the tools' tsconfig (the tests') leaves
// out (main.test.ts loads main.ts the same way).
const REPLAY = './replay';
const { createReplay } = (await import(/* @vite-ignore */ REPLAY)) as ReplayModule;

/** 熔核's 霜焰 clip on the fixture content from wave 1, as build.test.ts plays it: light in node. */
const SPEC = fusionClipSpec('fire.ice', {
  content: 'fixture',
  startWave: 1,
  warmupTicks: 60,
  durationTicks: 900,
});

/** The page's window and document, as much of them as createReplay reads. */
let win: Target & {
  location: { protocol: string };
  devicePixelRatio: number;
  screen: { width: number; height: number };
};
let doc: Target & {
  fonts: { ready: Promise<void> };
  body: StubElement;
  createElement(tag: string): StubElement;
};
let body: StubElement;
let clipboard: string[];
/** The callback requestAnimationFrame holds, and how many frames were cancelled. */
let raf: { pending: ((now: number) => void) | null; cancelled: number };

/** Runs the frame requestAnimationFrame holds, at `now`. */
function frameAt(now: number): void {
  const pending = raf.pending;
  raf.pending = null;
  pending?.(now);
}

beforeEach(() => {
  for (const list of [stubs.inits, stubs.renderers, stubs.draws]) list.length = 0;
  Object.assign(stubs, { renders: 0, appsDestroyed: 0, renderersDestroyed: 0 });
  body = new StubElement('body');
  clipboard = [];
  raf = { pending: null, cancelled: 0 };
  win = Object.assign(new Target(), {
    location: { protocol: 'http:' },
    devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
  });
  doc = Object.assign(new Target(), {
    fonts: { ready: Promise.resolve() },
    body,
    createElement: (tag: string) => new StubElement(tag),
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (test)',
    clipboard: {
      writeText: (text: string) => {
        clipboard.push(text);
        return Promise.resolve();
      },
    },
  });
  vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => {
    raf.pending = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    raf.pending = null;
    raf.cancelled++;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = (options: Partial<ReplayOptions>): Promise<Handle> =>
  createReplay(new StubElement('main'), SPEC, {
    width: 320,
    height: 180,
    mode: 'play',
    ...options,
  });

describe('createReplay (docs/v3 C10 design §1.7)', () => {
  it('steps frameTicks ticks a frame in step mode, and seeks to a tick, never asking for a frame', async () => {
    win.devicePixelRatio = 2;
    // A capture's resolution is 1 (the route's), whatever the screen's.
    const handle = await open({ mode: 'step', frameTicks: 2, resolution: 1 });
    expect(stubs.inits[0]).toMatchObject({
      width: 320,
      height: 180,
      resolution: 1,
      autoStart: false,
      preserveDrawingBuffer: true,
    });
    expect(stubs.renderers).toHaveLength(1);
    expect(handle.tick).toBe(0);
    handle.step(3);
    expect(handle.tick).toBe(6);
    handle.seek(5);
    expect(handle.tick).toBe(5);
    handle.step();
    expect(handle.tick).toBe(7);
    expect(raf.pending).toBeNull();
    // One renderer for the replay's life, through every seek (D1).
    expect(stubs.renderers).toHaveLength(1);
  });

  it('plays through FixedStepClock: its ticks follow the rAF time, not the count of frames', async () => {
    win.devicePixelRatio = 3;
    const handle = await open({ mode: 'play' });
    // min(2, devicePixelRatio) by default.
    expect(stubs.inits[0]).toMatchObject({ resolution: 2, autoStart: false });
    let now = 1000;
    // The first frame only starts the clock.
    frameAt(now);
    expect(handle.tick).toBe(0);
    for (let i = 0; i < 10; i++) frameAt((now += 47));
    // 470 ms at 60 ticks a second: 28.2 ticks.
    expect(handle.tick).toBe(28);
    for (let i = 0; i < 25; i++) frameAt((now += 8.3));
    // 677.5 ms in all: 40.65 ticks.
    expect(handle.tick).toBe(40);
    // Drawn 0.65 of a tick on, with the frame's wall-clock ms of effect time.
    const [alpha, frameMs] = stubs.draws.at(-1) ?? [];
    expect(alpha).toBeCloseTo(0.65, 6);
    expect(frameMs).toBeCloseTo(8.3, 6);
    handle.pause();
    expect(raf.pending).toBeNull();
  });

  it('feeds the readout the rAF intervals and shows the block, with Copy and a read-only textarea', async () => {
    win.location = { protocol: 'file:' };
    const handle = await open({ mode: 'play', readout: true });
    const panel = body.children[0] as StubElement;
    const [text, copy, area] = panel.children as [StubElement, StubElement, StubElement];
    expect([copy.textContent, copy.hidden, area.hidden, area.readOnly]).toEqual([
      'Copy',
      true,
      true,
      true,
    ]);
    let now = 0;
    frameAt(now);
    for (let i = 0; i < 100; i++) frameAt((now += 20));
    expect(text.textContent).toBe('measuring 0 / 30 s (warm-up)');
    // 5 s of warm-up at 20 ms a frame, then the 30 s window, and frames after it.
    for (let i = 0; i < 1700; i++) frameAt((now += 20));
    expect(handle.frameStats()).toMatchObject({
      phase: 'done',
      frames: 1500,
      medianMs: 20,
      p95Ms: 20,
      maxMs: 20,
      longFrames: 0,
      pass: true,
    });
    const block = text.textContent.split('\n');
    expect(block[0]).toBe('bc-incremental fps v1');
    // The Steam shell's loadFile page: file:.
    expect(block[1]).toMatch(/^page: steam {2}build: \S+$/);
    expect(block.slice(2, 5)).toEqual([
      'ua: Mozilla/5.0 (test)',
      'screen: 1920x1080 @1  canvas: 320x180',
      'warm-up 5 s, window 30 s, frames 1500, median interval 20.0 ms',
    ]);
    expect(block.at(-1)).toBe('end fps');
    expect([copy.hidden, area.hidden, area.readOnly, area.value]).toEqual([
      false,
      false,
      true,
      text.textContent,
    ]);
    copy.fire('click');
    expect(area.selected).toBe(true);
    expect(clipboard).toEqual([text.textContent]);
  });

  it('reads the page as web over http, and starts the readout over on a resize or a hidden page', async () => {
    const handle = await open({ mode: 'play', readout: true });
    let now = 0;
    frameAt(now);
    for (let i = 0; i < 300; i++) frameAt((now += 20));
    expect(handle.frameStats()).toMatchObject({ phase: 'window', frames: 50 });
    win.fire('resize');
    expect(handle.frameStats()).toMatchObject({ phase: 'warmup', elapsedMs: 0, frames: 0 });
    for (let i = 0; i < 300; i++) frameAt((now += 20));
    doc.fire('visibilitychange');
    expect(handle.frameStats()).toMatchObject({ phase: 'warmup', elapsedMs: 0, frames: 0 });
    for (let i = 0; i < 2000; i++) frameAt((now += 20));
    const panel = body.children[0] as StubElement;
    expect((panel.children[0] as StubElement).textContent.split('\n')[1]).toMatch(/^page: web {2}/);
  });

  it('waits for document.fonts.ready before its first frame', async () => {
    let ready = (): void => undefined;
    doc.fonts = { ready: new Promise<void>((resolve) => (ready = resolve)) };
    const opening = open({ mode: 'step' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([stubs.inits.length, stubs.draws.length, stubs.renders]).toEqual([0, 0, 0]);
    ready();
    await opening;
    expect([stubs.inits.length, stubs.draws.length, stubs.renders]).toEqual([1, 1, 1]);
  });

  it('stops, removes its panel and stops listening when destroyed', async () => {
    const handle = await open({ mode: 'play', readout: true });
    frameAt(0);
    frameAt(20);
    handle.destroy();
    expect(raf.pending).toBeNull();
    expect((body.children[0] as StubElement).removed).toBe(true);
    expect([stubs.renderersDestroyed, stubs.appsDestroyed]).toEqual([1, 1]);
    expect([win.count(), doc.count()]).toEqual([0, 0]);
  });
});
