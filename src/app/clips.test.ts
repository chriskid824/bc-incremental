/**
 * The clip wall (src/app/clips.ts, docs/v3 C10 design §2.6): which fusions it shows and how it
 * pages them (OWN test 1), each tile's label, the pager's flips (the lead's ruling H9), and the
 * page itself on a stub DOM with createReplay a stub: the tiles' specs and options,
 * `window.__clips` stepping every tile, and a flip destroying every replay of the page before it
 * makes the next.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalibrationEntry, Content, FusionDef, FusionKey, FusionKind } from '../data/web';
import { fixtureContent } from '../data/web/testing';
import { fusionClipSpec } from './replay/specs';
import type { ReplayOptions, ReplaySpec } from './replay/types';

interface Created {
  readonly spec: ReplaySpec;
  readonly options: ReplayOptions;
  readonly steps: number[];
  destroyed: number;
}

const stubs = vi.hoisted(() => ({
  created: [] as Created[],
  /** What happened, in order: `make <key>` and `destroy <key>`. */
  log: [] as string[],
  /** Keys whose replay rejects, as one whose spec does not resolve. */
  failing: new Set<string>(),
  /** What loadContent() gives: the registered content, which no test may depend on. */
  registered: null as Content | null,
}));

vi.mock('../data/web', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadContent: () => stubs.registered,
}));
vi.mock('./replay/replay', () => ({
  createReplay: (_host: unknown, spec: ReplaySpec, options: ReplayOptions) => {
    const key = spec.build.kind === 'fusion' ? spec.build.key : spec.build.kind;
    stubs.log.push(`make ${key}`);
    if (stubs.failing.has(key)) return Promise.reject(new Error(`no fusion '${key}'`));
    const entry: Created = { spec, options, steps: [], destroyed: 0 };
    stubs.created.push(entry);
    return Promise.resolve({
      step: (frames = 1) => entry.steps.push(frames),
      destroy: () => {
        entry.destroyed++;
        stubs.log.push(`destroy ${key}`);
      },
    });
  },
}));

/** What createElement makes: enough of an element for clips.ts. */
class StubElement {
  readonly children: StubElement[] = [];
  className = '';
  textContent = '';
  id = '';
  type = '';
  disabled = false;
  onclick: (() => void) | null = null;
  constructor(readonly tag: string) {}
  append(...nodes: StubElement[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: StubElement[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }
  /** Every element under this one, depth first. */
  all(): StubElement[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
}

interface ClipsApi {
  ready: boolean;
  readonly pages: number;
  page(n: number): Promise<void>;
  step(frames?: number): void;
}
interface WallTile {
  readonly key: FusionKey;
  readonly kind: FusionKind;
  readonly calibration: CalibrationEntry | null;
}
interface ClipsModule {
  WALL_PAGE_SIZE: number;
  WALL_FRAME_TICKS: number;
  builtFusions(content: Content): FusionDef[];
  wallTiles(
    fusions: readonly Pick<FusionDef, 'key' | 'kind'>[],
    calibrated: Content['calibrated'],
    all: boolean,
  ): WallTile[];
  wallPages<T>(tiles: readonly T[], size?: number): T[][];
  tileLabel(tile: WallTile): readonly [string, string];
  wallPager<H extends { destroy(): void }>(
    make: (n: number) => Promise<readonly H[]>,
  ): { page(n: number): Promise<void>; handles(): readonly H[] };
  startClipWall(root: unknown, search: string): Promise<void>;
}

// clips.ts boots the page on import when it finds #clips: here there is none.
vi.stubGlobal('document', { getElementById: () => null });
// A computed path: clips.ts needs the DOM's types, which the tools' tsconfig (the tests') leaves
// out (replay.test.ts loads replay.ts the same way).
const CLIPS = './clips';
const clips = (await import(/* @vite-ignore */ CLIPS)) as ClipsModule;
const { builtFusions, startClipWall, tileLabel, wallPager, wallPages, wallTiles } = clips;
vi.unstubAllGlobals();

let win: { __clips?: ClipsApi | undefined };

beforeEach(() => {
  stubs.created.length = 0;
  stubs.log.length = 0;
  stubs.failing.clear();
  // The registered content as B1 leaves it: 熔核's center and four outers.
  stubs.registered = fixtureContent('B1');
  win = {};
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { createElement: (tag: string) => new StubElement(tag) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const B5 = fixtureContent('B5');
const lengths = (pages: readonly (readonly unknown[])[]): number[] => pages.map((p) => p.length);
const isWallKind = (kind: FusionKind): boolean =>
  kind === 'template' || kind === 'templateOverride';

/** A calibration entry with this median. */
const entry = (median: number, status: CalibrationEntry['status'] = 'ok'): CalibrationEntry => ({
  coef: 1,
  status,
  median,
  min: median - 0.05,
  max: median + 0.05,
  seeds: 8,
  startWave: 18,
  digest: 'test',
});

describe('the wall’s tiles and pages (docs/v3 C10 design §2.6, OWN test 1)', () => {
  it('pages 25 template fusions as 12, 12 and 1, and keeps the hand fusions off the default wall', () => {
    const fusions = builtFusions(B5);
    const templates = fusions.filter((fusion) => isWallKind(fusion.kind)).slice(0, 25);
    const hands = fusions.filter((fusion) => fusion.kind === 'hand');
    expect([templates.length, hands.length]).toEqual([25, 12]);
    // The hand fusions among them, in the webs' own order.
    const mixed = fusions.filter((fusion) => templates.includes(fusion) || hands.includes(fusion));
    const tiles = wallTiles(mixed, {}, false);
    expect(lengths(wallPages(tiles))).toEqual([12, 12, 1]);
    expect(tiles.map((tile) => tile.key)).toEqual(templates.map((fusion) => fusion.key));
    expect(clips.WALL_PAGE_SIZE).toBe(12);
    // ?all keeps them: 37 tiles.
    expect(lengths(wallPages(wallTiles(mixed, {}, true)))).toEqual([12, 12, 12, 1]);
  });

  it('shows the fixture’s 32 template and templateOverride fusions by default, all 44 with ?all', () => {
    const fusions = builtFusions(B5);
    expect(fusions).toHaveLength(44);
    const tiles = wallTiles(fusions, B5.calibrated, false);
    expect(lengths(wallPages(tiles))).toEqual([12, 12, 8]);
    expect(
      tiles.filter((tile) => tile.kind === 'templateOverride').map((tile) => tile.key),
    ).toEqual(['fire.poison', 'ice.aura', 'lightning.aura']);
    expect(tiles.every((tile) => isWallKind(tile.kind))).toBe(true);
    expect(lengths(wallPages(wallTiles(fusions, B5.calibrated, true)))).toEqual([12, 12, 12, 8]);
  });

  it('takes only the built characters’ fusions: B1’s fixture is 熔核’s four, one page', () => {
    const fusions = builtFusions(fixtureContent('B1'));
    expect(fusions.map((fusion) => [fusion.key, fusion.kind])).toEqual([
      ['fire.poison', 'templateOverride'],
      ['fire.crit', 'template'],
      ['fire.ice', 'hand'],
      ['fire.summon', 'hand'],
    ]);
    expect(lengths(wallPages(wallTiles(fusions, {}, true)))).toEqual([4]);
    expect(wallTiles(fusions, {}, false).map((tile) => tile.key)).toEqual([
      'fire.poison',
      'fire.crit',
    ]);
  });

  it('labels each tile with its key, its kind and its own calibration’s status and median', () => {
    const fusions = [
      { key: 'fire.poison', kind: 'templateOverride' },
      { key: 'fire.crit', kind: 'template' },
      { key: 'ice.crit', kind: 'template' },
    ] as const;
    const calibrated = { 'fire.poison': entry(1.2034), 'fire.crit': entry(1.31, 'strong') };
    const labels = wallTiles(fusions, calibrated, false).map(tileLabel);
    expect(labels).toEqual([
      ['fire.poison', 'templateOverride · ok, median 1.203'],
      ['fire.crit', 'template · strong, median 1.310'],
      ['ice.crit', 'template · uncalibrated'],
    ]);
  });
});

/** A turn of the event loop: every promise callback queued so far runs. */
const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Handle {
  destroyed: number;
  destroy(): void;
}

/** A pager whose pages are made when the test says: each page's handles log their destroys. */
function deferredPager() {
  const pending: (() => void)[] = [];
  const handles = new Map<number, Handle[]>();
  const log: string[] = [];
  const pager = wallPager((n) => {
    log.push(`make ${n}`);
    return new Promise<readonly Handle[]>((resolve) => {
      pending.push(() => {
        const made = [1, 2, 3].map((i) => {
          const handle = {
            destroyed: 0,
            destroy: () => {
              handle.destroyed++;
              log.push(`destroy ${n}.${i}`);
            },
          };
          return handle;
        });
        handles.set(n, [...(handles.get(n) ?? []), ...made]);
        resolve(made);
      });
    });
  });
  /** Lets the flips waiting run, makes the oldest page asked for, and lets its flip finish. */
  const settle = async (): Promise<void> => {
    await turn();
    pending.shift()?.();
    await turn();
  };
  return { pager, handles, log, settle };
}

describe('the wall’s flips (the lead’s ruling H9)', () => {
  it('destroys every handle of the page shown before it makes the next', async () => {
    const { pager, log, settle } = deferredPager();
    const first = pager.page(1);
    await settle();
    await first;
    const second = pager.page(2);
    await turn();
    expect(log).toEqual(['make 1', 'destroy 1.1', 'destroy 1.2', 'destroy 1.3', 'make 2']);
    // While page 2 is being made, the pager holds no handle.
    expect(pager.handles()).toEqual([]);
    await settle();
    await second;
    expect(pager.handles()).toHaveLength(3);
  });

  it('waits for the page being made when a flip comes during a flip: each handle destroyed once', async () => {
    const { pager, handles, log, settle } = deferredPager();
    const flips = [pager.page(1), pager.page(2), pager.page(3)];
    await turn();
    // Page 1 is being made: neither later flip has started.
    expect(log).toEqual(['make 1']);
    await settle();
    expect(log).toEqual(['make 1', 'destroy 1.1', 'destroy 1.2', 'destroy 1.3', 'make 2']);
    await settle();
    await settle();
    await Promise.all(flips);
    expect(log.slice(5)).toEqual(['destroy 2.1', 'destroy 2.2', 'destroy 2.3', 'make 3']);
    for (const n of [1, 2]) {
      expect(handles.get(n)?.map((handle) => handle.destroyed)).toEqual([1, 1, 1]);
    }
    // The last flip's page stays.
    expect(pager.handles()).toEqual(handles.get(3));
    expect(handles.get(3)?.map((handle) => handle.destroyed)).toEqual([0, 0, 0]);
  });

  it('flips on after a page that fails to make, and the failed flip rejects', async () => {
    let calls = 0;
    const pager = wallPager(async (n) => {
      calls++;
      if (n === 2) throw new Error('page 2');
      return [{ destroy: () => undefined }];
    });
    await pager.page(1);
    await expect(pager.page(2)).rejects.toThrow('page 2');
    await pager.page(3);
    expect([calls, pager.handles().length]).toEqual([3, 1]);
  });
});

/** The page in a stub root: its tiles, the window's __clips and its header text. */
async function openWall(search: string): Promise<{ root: StubElement; api: ClipsApi | undefined }> {
  const root = new StubElement('main');
  await startClipWall(root, search);
  return { root, api: win.__clips };
}

const tilesOf = (root: StubElement): StubElement[] =>
  root.all().filter((node) => node.className === 'tile');

describe('the wall page (docs/v3 C10 design §2.6)', () => {
  it('opens ?fixture&step=1 as 12 stepped tiles of fixture clips, with window.__clips', async () => {
    const { root, api } = await openWall('?fixture&step=1');
    expect(api).toMatchObject({ ready: true, pages: 3 });
    expect(stubs.created).toHaveLength(12);
    expect(tilesOf(root)).toHaveLength(12);
    const keys = builtFusions(B5)
      .filter((fusion) => isWallKind(fusion.kind))
      .map((fusion) => fusion.key);
    expect(stubs.created.map((created) => created.spec)).toEqual(
      keys.slice(0, 12).map((key) => fusionClipSpec(key, { content: 'fixture' })),
    );
    for (const created of stubs.created) {
      expect(created.options).toEqual({
        width: 320,
        height: 180,
        mode: 'step',
        frameTicks: 2,
        resolution: 1,
      });
    }
    expect(clips.WALL_FRAME_TICKS).toBe(2);
    // Each tile's label: its key, then its kind and calibration (none on the fixture).
    const first = tilesOf(root)[0]
      ?.all()
      .map((node) => node.textContent);
    expect(first).toEqual(expect.arrayContaining([keys[0], 'templateOverride · uncalibrated']));
  });

  it('turns ready on only once page 1 is shown (ready set before the page is made)', async () => {
    // tools/sheets/clips.ts opens the wall by waiting for `window.__clips.ready`, then steps and
    // shoots at once: ready before page 1 is made would capture an empty wall.
    const root = new StubElement('main');
    const opening = startClipWall(root, '?fixture&step=1');
    expect(win.__clips?.ready).toBe(false);
    expect(stubs.created).toHaveLength(0);
    await opening;
    expect(win.__clips?.ready).toBe(true);
    expect(stubs.created).toHaveLength(12);
  });

  it('steps every tile of the page through window.__clips.step', async () => {
    const { api } = await openWall('?fixture&step=1');
    api?.step(5);
    api?.step();
    expect(stubs.created.map((created) => created.steps)).toEqual(
      Array.from({ length: 12 }, () => [5, 1]),
    );
  });

  it('destroys every replay of the page before it makes the next, each once, to the last page', async () => {
    const { root, api } = await openWall('?fixture&step=1');
    stubs.log.length = 0;
    await api?.page(2);
    const destroys = stubs.log.filter((line) => line.startsWith('destroy'));
    expect(destroys).toHaveLength(12);
    expect(stubs.log.slice(0, 12)).toEqual(destroys);
    expect(stubs.created.slice(12)).toHaveLength(12);
    await api?.page(3);
    expect(tilesOf(root)).toHaveLength(8);
    expect(stubs.created.map((created) => created.destroyed)).toEqual([
      ...Array.from({ length: 24 }, () => 1),
      ...Array.from({ length: 8 }, () => 0),
    ]);
    api?.step(2);
    expect(stubs.created.slice(24).every((created) => created.steps.join() === '2')).toBe(true);
    await expect(api?.page(4)).rejects.toThrow('no page 4');
  });

  it('shows every fusion with ?all, and plays without ?step=1, exposing nothing', async () => {
    const all = await openWall('?all&fixture&step=1');
    expect(all.api?.pages).toBe(4);
    stubs.created.length = 0;
    win.__clips = undefined;
    await openWall('?fixture');
    expect(win.__clips).toBeUndefined();
    expect(stubs.created[0]?.options).toEqual({ width: 320, height: 180, mode: 'play' });
  });

  it('says why a tile fails in its place, and plays the others', async () => {
    stubs.failing.add('fire.bleed');
    const { root, api } = await openWall('?fixture&step=1');
    expect(stubs.created).toHaveLength(11);
    const errors = root.all().filter((node) => node.className === 'error');
    expect(errors.map((node) => node.textContent)).toEqual(["replay: no fusion 'fire.bleed'"]);
    api?.step();
    expect(stubs.created.every((created) => created.steps.join() === '1')).toBe(true);
  });

  it('shows the registered content without ?fixture: its specs read registered content', async () => {
    const { api } = await openWall('?step=1');
    expect(api).toMatchObject({ ready: true, pages: 1 });
    expect(stubs.created.map((created) => created.spec)).toEqual([
      fusionClipSpec('fire.poison'),
      fusionClipSpec('fire.crit'),
    ]);
  });

  it('opens an empty wall on content with no built character, and says how to see one', async () => {
    const characters = Object.fromEntries(
      Object.entries(B5.characters).map(([c, def]) => [c, { ...def, center: null }]),
    ) as unknown as Content['characters'];
    stubs.registered = { ...B5, characters };
    const { root, api } = await openWall('?step=1');
    expect(api).toMatchObject({ ready: true, pages: 0 });
    expect(stubs.created).toHaveLength(0);
    const text = root.all().map((node) => node.textContent);
    expect(text.some((line) => line.includes('?fixture'))).toBe(true);
  });
});
