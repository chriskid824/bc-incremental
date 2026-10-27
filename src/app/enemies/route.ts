/**
 * The `?enemies` page (docs/v3 C7 design §2.9, the lead's ruling P7), which main.ts loads instead
 * of the game: a chunk of its own, as the replay's, so the M1 page and `?hive` never fetch it. It
 * draws the grid (grid.ts) with the game's renderer, its effects on a seeded RenderRandom, labels
 * each enemy in English (dev text, outside i18n, as viewer.ts' is) and slides the banner in for
 * each type the page has not seen since it loaded (the lead's ruling L7: a fresh set per load,
 * recorded nowhere). It writes no storage, sends no playtest event and calls no platform API.
 * `&step=1` draws a frame only on `window.__enemies.step(n)`, one tick a frame, for the captures
 * (tools/sheets/capture.ts, enemiesSmoke.ts); `html[data-enemies-ready="true"]` marks the first
 * frame drawn. No hit-stop, as in the replay: a frame is a function of the tick.
 */

import { Application } from 'pixi.js';
import { createRng } from '../../core/rng';
import { Renderer } from '../../render';
import { COLORS } from '../../render/palette';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../../sim';
import { EnemyBanner } from '../../ui/banner';
import { BannerLine } from '../../ui/bannerView';
import { injectStyle } from '../../ui/style';
import { GameLoop, TICK_MS } from '../loop';
import { EnemyGrid, GRID_RENDER_SEED, gridData } from './grid';
import type { GridSpot } from './grid';

/** A label's drop below its enemy's center, arena units: under the largest look, 洋蔥's 70. */
const LABEL_DROP = 84;

/** One dev label per spot, laid over the canvas where the renderer draws the arena. */
function createLabels(spots: readonly GridSpot[]): { layout(): void } {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
  const labels = spots.map((spot) => {
    const label = document.createElement('div');
    label.textContent = spot.label;
    label.style.cssText =
      'position:absolute;transform:translateX(-50%);white-space:nowrap;' +
      'color:#8e98b3;font:12px/1.2 ui-monospace,monospace;';
    box.append(label);
    return label;
  });
  document.body.append(box);
  return {
    // The renderer's fit (src/render/renderer.ts): the arena scaled to the window, centered.
    layout() {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const scale = Math.min(width / ARENA_WIDTH, height / ARENA_HEIGHT);
      const left = (width - ARENA_WIDTH * scale) / 2;
      const top = (height - ARENA_HEIGHT * scale) / 2;
      spots.forEach((spot, i) => {
        const label = labels[i] as HTMLElement;
        label.style.left = `${left + (ARENA_WIDTH / 2 + spot.dx) * scale}px`;
        label.style.top = `${top + (ARENA_HEIGHT / 2 + spot.dy + LABEL_DROP) * scale}px`;
      });
    },
  };
}

/** Opens the grid in `root`; `search` is location.search. */
export async function startEnemiesRoute(root: HTMLElement, search: string): Promise<void> {
  const step = new URLSearchParams(search).get('step') === '1';
  injectStyle(document);
  await document.fonts.ready;
  const app = new Application();
  await app.init({
    resizeTo: window,
    background: COLORS.background,
    antialias: true,
    autoDensity: true,
    resolution: step ? 1 : Math.min(2, window.devicePixelRatio),
    autoStart: !step,
    // A capture reads the canvas between steps.
    preserveDrawingBuffer: step,
  });
  root.appendChild(app.canvas);

  const data = gridData();
  const rng = createRng(GRID_RENDER_SEED);
  const renderer = new Renderer(app, data, { reducedMotion: false, random: () => rng.next() });
  const line = new BannerLine(document);
  document.body.append(line.root);
  const banner = new EnemyBanner(data.enemies, [], line);
  const grid = new EnemyGrid(
    {
      start: (typicalHit) => renderer.beginRun(typicalHit),
      events: (events) => renderer.handleEvents(events),
      frame: (state, alpha, elapsedMs) => renderer.render(state, alpha, elapsedMs),
    },
    banner,
    data,
  );
  const loop = new GameLoop(grid);
  const labels = createLabels(grid.spots);
  labels.layout();
  window.addEventListener('resize', () => labels.layout());

  if (step) {
    const handle = {
      canvas: app.canvas,
      get tick(): number {
        return grid.state.tick;
      },
      /** `frames` frames of one tick each, then the canvas drawn. */
      step(frames = 1): void {
        for (let f = 0; f < frames; f++) loop.tick(TICK_MS);
        app.render();
      },
    };
    Object.assign(window, { __enemies: handle });
    handle.step(0);
  } else {
    app.ticker.add((ticker) => loop.tick(ticker.elapsedMS));
  }
  document.documentElement.dataset.enemiesReady = 'true';
}
