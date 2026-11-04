/**
 * The select cards' previews (docs/v3/game-design-v3.md §1.1; docs/v3/implementation-plan-v3.md
 * §6, §7 per-character item 4): a playable character's card plays a 10 s fixed-seed loop of its
 * default build (CharacterDef.defaultOrder through defaultProgress) from wave PREVIEW_WAVE on the
 * replay component (src/app/replay), and a 「製作中」 card shows its construct still, drawn once by
 * one shared offscreen PixiJS app (createConstructView) into a plain canvas, so it holds no WebGL
 * context of its own.
 */

import { Application } from 'pixi.js';
import type { CharacterId } from '../../data/sources';
import type { ConstructId } from '../../data/web';
import { createConstructView } from '../../render/constructs';
import { COLORS } from '../../render/palette';
import { TICK_RATE } from '../../sim';
import type { CardPreview, SelectCard } from '../../ui/v3/select';
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from '../../ui/v3/select';
import { createReplay } from '../replay/replay';
import type { ReplayHandle } from '../replay/replay';
import type { ReplaySpec } from '../replay/types';

/** The preview's start wave (gd §1.1 asks for a real run; 10–15 shows the build at work). */
export const PREVIEW_WAVE = 12;
export const PREVIEW_SEED = 20261102;
/** Simulated before the first frame, so the loop opens on a filled arena. */
const PREVIEW_WARMUP_TICKS = 2 * TICK_RATE;
/** gd §1.1: 10 seconds a loop. */
const PREVIEW_TICKS = 10 * TICK_RATE;
/** The construct's share of the preview's height on a still card. */
const STILL_FILL = 0.55;

export function previewSpec(character: CharacterId): ReplaySpec {
  return {
    build: { kind: 'default', character },
    content: 'registered',
    scope: 'full',
    seed: PREVIEW_SEED,
    startWave: PREVIEW_WAVE,
    warmupTicks: PREVIEW_WARMUP_TICKS,
    durationTicks: PREVIEW_TICKS,
    loop: true,
  };
}

/** A playable card's replay; it starts paused, and plays while the cursor is on its card. */
function replayPreview(host: HTMLElement, character: CharacterId): CardPreview {
  let handle: ReplayHandle | null = null;
  let wantPlay = false;
  let destroyed = false;
  createReplay(host, previewSpec(character), {
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    mode: 'play',
  })
    .then((made) => {
      if (destroyed) {
        made.destroy();
        return;
      }
      handle = made;
      made.canvas.classList.add('bc-game-card-canvas');
      if (!wantPlay) made.pause();
    })
    .catch((error: unknown) => console.error(`The ${character} preview failed`, error));
  return {
    play() {
      wantPlay = true;
      handle?.play();
    },
    pause() {
      wantPlay = false;
      handle?.pause();
    },
    destroy() {
      destroyed = true;
      handle?.destroy();
      handle = null;
    },
  };
}

/** Draws each construct once into a 2D canvas of the preview's size, on one shared app. */
export class ConstructStills {
  private app: Application | null = null;
  private readonly ready: Promise<Application>;

  constructor() {
    this.ready = (async () => {
      const app = new Application();
      await app.init({
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        background: COLORS.background,
        antialias: true,
        resolution: Math.min(2, window.devicePixelRatio),
        autoDensity: true,
        autoStart: false,
        preserveDrawingBuffer: true,
      });
      this.app = app;
      return app;
    })();
  }

  /** A still of `construct` drawn into `canvas` once the shared app is up. */
  draw(canvas: HTMLCanvasElement, construct: ConstructId): void {
    this.ready
      .then((app) => {
        const view = createConstructView(construct);
        view.update(0);
        const bounds = view.view.getLocalBounds();
        const size = Math.max(bounds.width, bounds.height, 1);
        const scale = (PREVIEW_HEIGHT * STILL_FILL) / size;
        view.view.scale.set(scale);
        view.view.position.set(
          PREVIEW_WIDTH / 2 - (bounds.x + bounds.width / 2) * scale,
          PREVIEW_HEIGHT / 2 - (bounds.y + bounds.height / 2) * scale,
        );
        app.stage.addChild(view.view);
        app.render();
        canvas.width = app.canvas.width;
        canvas.height = app.canvas.height;
        canvas.getContext('2d')?.drawImage(app.canvas, 0, 0);
        app.stage.removeChild(view.view);
        view.view.destroy({ children: true });
      })
      .catch((error: unknown) => console.error(`The ${construct} still failed`, error));
  }

  destroy(): void {
    void this.ready.then(() => {
      this.app?.destroy({ removeView: true }, { children: true });
      this.app = null;
    });
  }
}

const NO_PREVIEW = { play: () => undefined, pause: () => undefined };

/** The select screen's mountPreview: a replay for a playable card, else a construct still. */
export function mountCardPreview(
  stills: ConstructStills,
): (host: HTMLElement, card: SelectCard) => CardPreview {
  return (host, card) => {
    if (card.playable) return replayPreview(host, card.def.id);
    const canvas = document.createElement('canvas');
    canvas.className = 'bc-game-card-canvas';
    canvas.style.width = `${PREVIEW_WIDTH}px`;
    canvas.style.height = `${PREVIEW_HEIGHT}px`;
    host.append(canvas);
    stills.draw(canvas, card.def.construct);
    return { ...NO_PREVIEW, destroy: () => canvas.remove() };
  };
}
