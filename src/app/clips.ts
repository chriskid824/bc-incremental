/**
 * The clip wall (docs/v3 C10 design §2.6; impl:569, :571): a dev page, served by `npm run dev` at
 * /clips.html and never built, as viewer.html is, that plays fusions' 3 s clips side by side, each
 * fusionClipSpec's loop of the fusion's unlock investment and core from CLIP_WAVE at REPLAY_SEED.
 * By default the tiles are the built characters' template and templateOverride fusions, whose
 * review is the wall (impl:569; a hand fusion gets a GIF of its own, tools/sheets/gif.ts
 * --fusion); `?all` shows every fusion and `?fixture` fixtureContent('B5'). WALL_PAGE_SIZE tiles
 * make a page, each a replay of its own (src/app/replay) on a 320 × 180 canvas, labelled with its
 * key, kind, calibration status and median (content.calibrated). A flip waits for the page being
 * made, destroys every replay of it, then makes the next page's (the lead's ruling H9), so a page
 * holds at most WALL_PAGE_SIZE WebGL contexts (G13). A tile re-simulates its warm-up within one
 * frame when its clip loops, so a playing wall hitches once a loop.
 *
 * `?step=1` draws the tiles only on `window.__clips.step(frames)`, WALL_FRAME_TICKS ticks a frame
 * (tools/sheets/clips.ts captures the wall at GIF_FPS), and exposes `window.__clips`: `ready`,
 * `pages`, `page(n)` (n from 1) and `step(frames)`, which steps every tile of the page.
 *
 * The text here is for developers, not players: plain English outside i18n, as viewer.ts' is. The
 * page writes no storage and sends nothing, as the replay route does.
 */

import { CHARACTER_IDS } from '../data/sources';
import { assembleWeb, FULL_SCOPE, loadContent } from '../data/web';
import type { CalibrationEntry, Content, FusionDef, FusionKey, FusionKind } from '../data/web';
import { fixtureContent } from '../data/web/testing';
import { TICK_RATE } from '../sim';
import { createReplay } from './replay/replay';
import type { ReplayHandle } from './replay/replay';
import { CLIP_TICKS, CLIP_WAVE, fusionClipSpec, GIF_FPS, REPLAY_SEED } from './replay/specs';
import type { ReplayOptions, ReplaySpec } from './replay/types';

/**
 * Tiles a page (初始值): one WebGL context each, under Chromium's 16 live contexts with room for
 * the page's own (G13).
 */
export const WALL_PAGE_SIZE = 12;
/** A tile's canvas in CSS px (§2.6). */
export const TILE_WIDTH = 320;
export const TILE_HEIGHT = 180;
/** Step mode's ticks a frame: tools/sheets/clips.ts captures the wall at GIF_FPS (H10). */
export const WALL_FRAME_TICKS = TICK_RATE / GIF_FPS;

/** The kinds the wall shows without `?all`: the template fusions' 3 s clips (impl:569). */
const WALL_KINDS: ReadonlySet<FusionKind> = new Set(['template', 'templateOverride']);

/** A tile: a fusion, its kind and its calibration entry (null without one). */
export interface WallTile {
  readonly key: FusionKey;
  readonly kind: FusionKind;
  readonly calibration: CalibrationEntry | null;
}

/** The built characters' fusions (a center written), in character order, each web's in order. */
export function builtFusions(content: Content): FusionDef[] {
  return CHARACTER_IDS.filter((c) => content.characters[c].center !== null).flatMap((c) => [
    ...assembleWeb(content, c, FULL_SCOPE).fusions.values(),
  ]);
}

/** The wall's tiles of `fusions`: the template and templateOverride ones, or all with `all`. */
export function wallTiles(
  fusions: readonly Pick<FusionDef, 'key' | 'kind'>[],
  calibrated: Content['calibrated'],
  all: boolean,
): WallTile[] {
  return fusions
    .filter((fusion) => all || WALL_KINDS.has(fusion.kind))
    .map(({ key, kind }) => ({ key, kind, calibration: calibrated[key] ?? null }));
}

/** `tiles` in pages of `size`, the last holding the rest. */
export function wallPages<T>(tiles: readonly T[], size: number = WALL_PAGE_SIZE): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < tiles.length; i += size) pages.push(tiles.slice(i, i + size));
  return pages;
}

/** A tile's label: its key; then its kind, calibration status and median. */
export function tileLabel(tile: WallTile): readonly [string, string] {
  const entry = tile.calibration;
  const calibration =
    entry === null ? 'uncalibrated' : `${entry.status}, median ${entry.median.toFixed(3)}`;
  return [tile.key, `${tile.kind} · ${calibration}`];
}

/** A tile's replay: the fusion's wall clip, on fixtureContent('B5') with `fixture`. */
export const tileSpec = (key: FusionKey, fixture: boolean): ReplaySpec =>
  fusionClipSpec(key, fixture ? { content: 'fixture' } : {});

/** A tile's replay options: playing, or stepped at resolution 1 for a capture, as the route's. */
export const tileOptions = (step: boolean): ReplayOptions =>
  step
    ? {
        width: TILE_WIDTH,
        height: TILE_HEIGHT,
        mode: 'step',
        frameTicks: WALL_FRAME_TICKS,
        resolution: 1,
      }
    : { width: TILE_WIDTH, height: TILE_HEIGHT, mode: 'play' };

/** The wall's page of handles, made by `make` (the replays of page n). */
export interface WallPager<H> {
  /**
   * Shows page n: waits for every earlier flip, destroys each handle of the page shown, then makes
   * page n's; rejects as `make` does. A flip during a flip waits, so each handle is destroyed once
   * and the last flip's page stays.
   */
  page(n: number): Promise<void>;
  /** The handles of the page shown; none while a page is being made. */
  handles(): readonly H[];
}

export function wallPager<H extends { destroy(): void }>(
  make: (n: number) => Promise<readonly H[]>,
): WallPager<H> {
  let shown: readonly H[] = [];
  /** The last flip, settled: the next one starts once it has. */
  let last: Promise<void> = Promise.resolve();
  const flip = async (n: number): Promise<void> => {
    const old = shown;
    shown = [];
    for (const handle of old) handle.destroy();
    shown = await make(n);
  };
  return {
    page(n) {
      const next = last.then(() => flip(n));
      last = next.catch(() => undefined);
      return next;
    },
    handles: () => shown,
  };
}

/** What `window.__clips` holds with `?step=1`. */
export interface ClipsApi {
  /** True once page 1 is shown (at once on an empty wall). */
  ready: boolean;
  readonly pages: number;
  /** Shows page n, 1 to pages (WallPager.page); resolves once its tiles are made. */
  page(n: number): Promise<void>;
  /** Steps every tile of the page shown `frames` frames (default 1) of WALL_FRAME_TICKS ticks. */
  step(frames?: number): void;
}

function element(tag: string, className: string, text = ''): HTMLElement {
  const made = document.createElement(tag);
  made.className = className;
  made.textContent = text;
  return made;
}

function button(text: string): HTMLButtonElement {
  const made = document.createElement('button');
  made.type = 'button';
  made.textContent = text;
  made.disabled = true;
  return made;
}

/** A tile's figure: the host its replay's canvas goes in, and its label under it. */
function tileOf(tile: WallTile): { readonly figure: HTMLElement; readonly host: HTMLElement } {
  const [key, about] = tileLabel(tile);
  const figure = element('figure', 'tile');
  const host = element('div', 'clip');
  const caption = element('figcaption', 'label');
  caption.append(element('div', 'key', key), element('div', 'about', about));
  figure.append(host, caption);
  return { figure, host };
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Opens the wall `search` (location.search) asks for in `root`. */
export async function startClipWall(root: HTMLElement, search: string): Promise<void> {
  const params = new URLSearchParams(search);
  const step = params.get('step') === '1';
  const all = params.has('all');
  const fixture = params.has('fixture');
  const content = fixture ? fixtureContent('B5') : loadContent();
  const fusions = builtFusions(content);
  const tiles = wallTiles(fusions, content.calibrated, all);
  const pages = wallPages(tiles);

  const prev = button('◀ prev');
  const next = button('next ▶');
  const where = element('span', 'where');
  const header = element('header', 'bar');
  header.append(
    element('h1', 'title', 'Clip wall'),
    element(
      'span',
      'summary',
      `${fixture ? 'fixture content' : 'registered content'}: ${tiles.length} ` +
        `${all ? 'fusions (?all)' : 'template and templateOverride fusions'}, ` +
        `${WALL_PAGE_SIZE} a page; seed ${REPLAY_SEED} from wave ${CLIP_WAVE}, ` +
        `${CLIP_TICKS / TICK_RATE} s loops`,
    ),
    prev,
    where,
    next,
  );
  const wall = element('div', 'wall');
  wall.id = 'wall';
  root.replaceChildren(header, wall);

  const pager = wallPager(async (n): Promise<ReplayHandle[]> => {
    const made = (pages[n - 1] ?? []).map((tile) => ({ tile, ...tileOf(tile) }));
    wall.replaceChildren(...made.map(({ figure }) => figure));
    const settled = await Promise.allSettled(
      made.map(({ tile, host }) =>
        createReplay(host, tileSpec(tile.key, fixture), tileOptions(step)),
      ),
    );
    // A tile whose replay fails says why in its place; the others play.
    return settled.flatMap((result, i): ReplayHandle[] => {
      if (result.status === 'fulfilled') return [result.value];
      made[i]?.host.replaceChildren(element('pre', 'error', `replay: ${errorText(result.reason)}`));
      return [];
    });
  });
  /** The page shown last; 0 before the first. */
  let shown = 0;
  const show = async (n: number): Promise<void> => {
    if (!Number.isInteger(n) || n < 1 || n > pages.length) {
      throw new Error(`clips: no page ${n}: the wall has ${pages.length}`);
    }
    await pager.page(n);
    shown = n;
    where.textContent = `page ${n} / ${pages.length}`;
    prev.disabled = n === 1;
    next.disabled = n === pages.length;
  };
  prev.onclick = () => void show(shown - 1);
  next.onclick = () => void show(shown + 1);
  const clips: ClipsApi = {
    ready: false,
    pages: pages.length,
    page: show,
    step(frames = 1) {
      for (const handle of pager.handles()) handle.step(frames);
    },
  };
  if (step) Object.assign(window, { __clips: clips });
  if (pages.length > 0) {
    await show(1);
  } else {
    where.textContent = 'no page';
    wall.replaceChildren(
      element(
        'p',
        'empty',
        fusions.length === 0
          ? 'No character has a center yet (製作中 until B1 registers 熔核): ?fixture shows the test fixture.'
          : 'No template or templateOverride fusion yet: ?all shows every fusion.',
      ),
    );
  }
  clips.ready = true;
}

const root = document.getElementById('clips');
if (root !== null) {
  startClipWall(root, window.location.search).catch((error: unknown) => {
    console.error(error);
    root.replaceChildren(element('pre', 'error', `clips: ${errorText(error)}`));
  });
}
