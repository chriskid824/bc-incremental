/**
 * The replay component (docs/v3 C10 design §1.7): one seeded run of a build from a wave, drawn by
 * the game's renderer on a canvas of its own, for the clip wall and the PR GIF (C10.5b), B1's
 * select card, B5's dev start options and the frame-time readout (§2.5). Play mode steps the run
 * on rAF through FixedStepClock (src/app/loop.ts), its effects aged by wall-clock time; step mode
 * draws a frame only on step(), frameTicks ticks and frameMsOf(frameTicks) of effect time each,
 * at alpha 1, so a frame depends only on the spec (build.ts). Hit-stop is a no-op in both, and
 * frame 1 waits for document.fonts.ready. The renderer draws M1's center until B1 wires the
 * constructs; the summons, orbs and aura are counted, not drawn.
 */

import { Application } from 'pixi.js';
import { Renderer } from '../../render';
import { COLORS } from '../../render/palette';
import { FixedStepClock } from '../loop';
import { rendererView, ReplayRun, resolveSpec } from './build';
import { FrameTimer, fpsBlock, measuringText, pageOf, watchRestarts } from './readout';
import type { FrameStats, ReplayOptions, ReplaySpec } from './types';

export interface ReplayHandle {
  readonly canvas: HTMLCanvasElement;
  /** Ticks since the clip's start, after the warm-up. */
  readonly tick: number;
  play(): void;
  pause(): void;
  /** `frames` frames (default 1) of frameTicks ticks each: step mode's, or a paused play. */
  step(frames?: number): void;
  /** Re-creates the run, warms it up and steps to `tick`: deterministic. */
  seek(tick: number): void;
  /** The readout's numbers over play mode's frames so far (readout.ts). */
  frameStats(): FrameStats;
  /** Stops, then renderer.destroy() and app.destroy(), whose renderer loses the WebGL context. */
  destroy(): void;
}

/** The readout's panel: `measuring`, then the block with Copy and a read-only textarea. */
interface Panel {
  update(timer: FrameTimer, block: () => string): void;
  remove(): void;
}

function createPanel(): Panel {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:8px;left:8px;z-index:10;max-width:calc(100vw - 32px);padding:8px;' +
    'background:rgba(0,0,0,0.8);color:#e8ecf4;font:12px/1.4 ui-monospace,monospace;';
  const text = document.createElement('pre');
  text.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-all;';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.hidden = true;
  const area = document.createElement('textarea');
  area.readOnly = true;
  area.rows = 10;
  area.style.cssText = 'width:100%;box-sizing:border-box;margin-top:6px;';
  area.hidden = true;
  // Where the clipboard refuses, the selection stays for Ctrl+C (the C9 runbook's §8.5).
  copy.addEventListener('click', () => {
    area.select();
    navigator.clipboard.writeText(area.value).catch(() => undefined);
  });
  panel.append(text, copy, area);
  document.body.append(panel);
  let shown = '';
  return {
    update(timer, block) {
      if (timer.phase === 'done') {
        if (!area.hidden) return;
        // The block stays: the timer keeps its numbers once done (FrameTimer.restart).
        const done = block();
        text.textContent = done;
        area.value = done;
        copy.hidden = false;
        area.hidden = false;
        return;
      }
      const next = measuringText(timer.phase, timer.elapsedMs);
      if (next === shown) return;
      shown = next;
      text.textContent = next;
    },
    remove() {
      panel.remove();
    },
  };
}

/**
 * A replay of `spec` on a canvas appended to `host`, `options.width` × `options.height` CSS px:
 * playing in play mode, paused on its first frame in step mode. Rejects when the spec does not
 * resolve (resolveSpec).
 */
export async function createReplay(
  host: HTMLElement,
  spec: ReplaySpec,
  options: ReplayOptions,
): Promise<ReplayHandle> {
  const { run: setup } = resolveSpec(spec);
  const stepMode = options.mode === 'step';
  const frameTicks = options.frameTicks ?? 1;
  await document.fonts.ready;
  const app = new Application();
  await app.init({
    width: options.width,
    height: options.height,
    background: COLORS.background,
    antialias: true,
    autoDensity: true,
    resolution: options.resolution ?? Math.min(2, window.devicePixelRatio),
    autoStart: false,
    // A capture reads the canvas between steps (C10.5b).
    preserveDrawingBuffer: stepMode,
  });
  app.canvas.style.display = 'block';
  host.appendChild(app.canvas);
  // One renderer for the replay's life, its effects on the replay's own RenderRandom (build.ts).
  const view = rendererView(
    (random) => new Renderer(app, setup.data, { reducedMotion: false, random }),
  );
  const run = new ReplayRun(spec, setup, view, options.onLoop);
  app.render();

  const clock = new FixedStepClock();
  const timer = new FrameTimer();
  const panel = options.readout === true ? createPanel() : null;
  const block = (): string =>
    fpsBlock(timer.stats(), {
      page: pageOf(window.location.protocol),
      build: __BUILD_ID__,
      userAgent: navigator.userAgent,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      canvasWidth: app.canvas.width,
      canvasHeight: app.canvas.height,
    });
  let raf = 0;
  let playing = false;
  /** The last rAF's time; null after a (re)start, so the next interval is not counted. */
  let last: number | null = null;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    if (last !== null) {
      const elapsed = now - last;
      run.advance(clock.advance(elapsed, 1));
      run.draw(clock.alpha, elapsed);
      app.render();
      timer.frame(elapsed, run.counts());
      panel?.update(timer, block);
    }
    last = now;
  };
  const unwatch = watchRestarts(window, document, () => {
    timer.restart();
    last = null;
  });
  const play = (): void => {
    if (playing) return;
    playing = true;
    last = null;
    raf = requestAnimationFrame(frame);
  };
  const pause = (): void => {
    playing = false;
    cancelAnimationFrame(raf);
  };
  if (!stepMode) play();

  return {
    canvas: app.canvas,
    get tick() {
      return run.tick;
    },
    play,
    pause,
    step(frames = 1) {
      run.stepFrames(frames, frameTicks);
      app.render();
    },
    seek(tick) {
      run.seek(tick, frameTicks);
      app.render();
    },
    frameStats: () => timer.stats(),
    destroy() {
      pause();
      unwatch();
      panel?.remove();
      view.destroy();
      app.destroy({ removeView: true }, { children: true });
    },
  };
}
