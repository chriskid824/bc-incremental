/**
 * The segment-line layer (V1d, src/render/segmentLines.ts): the id lookups in the two pools as
 * their rows come and go, each link's ends (alive and interpolated, gone and stored, both gone
 * and skipped), what the layer draws for i < count in which style, and its life in the Renderer:
 * made only once a state with a segment emitter is drawn, under the enemies, and destroyed with
 * the renderer (the lead's ruling J10). The Renderer runs in node on a stand-in Application,
 * with the effect sheet and the backdrop, which need a canvas, stubbed.
 */

import { Container, Texture } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import type * as PixiModule from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { num } from '../core/num';
import { createRng } from '../core/rng';
import type { GameData } from '../data/types';
import type {
  DroneViewState,
  EnemyState,
  SegmentEndPool,
  SegmentLinesState,
  SimEvent,
  SimState,
} from '../sim';
import { createSimulation } from '../sim/simulation';
import { makeConfig, makeStats, makeTestData } from '../sim/testing';
import { NO_INPUT } from '../sim/types';
import { COLORS } from './palette';
import {
  droneSlotOf,
  enemyIndexOf,
  POOL_STYLE,
  resolveLink,
  SegmentLineLayer,
  SHOCK_STYLE,
} from './segmentLines';
import type { LinkFrame } from './segmentLines';

vi.mock('pixi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof PixiModule>()),
  // No canvas in node to draw the fonts on (restart.test.ts does the same).
  BitmapFont: { install: () => undefined },
}));
// The effect sheet and the backdrop draw on a 2D canvas, which node has not.
vi.mock('./fxTextures', async () => {
  const { Texture: T } = await import('pixi.js');
  const t = T.WHITE;
  return { createFxTextures: () => ({ glow: t, star: t, streak: t, shard: t, flame: t }) };
});
vi.mock('./backdrop', async () => {
  const { Container: C } = await import('pixi.js');
  return { createBackdrop: () => new C({ label: 'backdrop' }) };
});

interface Row {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly prevX?: number;
  readonly prevY?: number;
  readonly alive?: boolean;
}

/** An enemy of the view as SimState holds it, at (x, y), at (prevX, prevY) a tick before. */
function enemyOf(row: Row): EnemyState {
  return {
    id: row.id,
    type: 'triangle',
    wave: 1,
    x: row.x,
    y: row.y,
    prevX: row.prevX ?? row.x,
    prevY: row.prevY ?? row.y,
    hp: num(5),
    maxHp: num(10),
    radius: 12,
    burnStacks: 0,
    alive: row.alive ?? true,
    v3: null,
  };
}

/** A drone pool holding `rows` in its first slots, in order, with two slots to spare. */
function dronePool(rows: readonly Row[]): DroneViewState {
  const n = rows.length + 2;
  const ds = {
    id: new Int32Array(n),
    kind: new Uint8Array(n),
    mode: new Uint8Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    prevX: new Float64Array(n),
    prevY: new Float64Array(n),
    targetId: new Int32Array(n),
    owner: new Int16Array(n),
    seat: new Int16Array(n),
    size: new Float64Array(n).fill(1),
  };
  rows.forEach((row, s) => {
    ds.id[s] = row.id;
    ds.x[s] = row.x;
    ds.y[s] = row.y;
    ds.prevX[s] = row.prevX ?? row.x;
    ds.prevY[s] = row.prevY ?? row.y;
  });
  return ds;
}

/** A link's stored ends, where its endpoints stood at the judgement, and their ids. */
type Link = readonly [x1: number, y1: number, x2: number, y2: number, id1: number, id2: number];

/** An emitter's lines: `links` for i < count, then `stale` ones past count. */
function linesOf(
  pool: SegmentEndPool,
  links: readonly Link[],
  stale: readonly Link[] = [],
): SegmentLinesState {
  const all = [...links, ...stale];
  const n = all.length + 1;
  const ln = {
    count: links.length,
    x1: new Float64Array(n),
    y1: new Float64Array(n),
    x2: new Float64Array(n),
    y2: new Float64Array(n),
    id1: new Int32Array(n),
    id2: new Int32Array(n),
    pool,
  };
  all.forEach(([x1, y1, x2, y2, id1, id2], i) => {
    ln.x1[i] = x1;
    ln.y1[i] = y1;
    ln.x2[i] = x2;
    ln.y2[i] = y2;
    ln.id1[i] = id1;
    ln.id2[i] = id2;
  });
  return ln;
}

function frameOf(
  enemies: readonly Row[],
  drones: readonly Row[],
  lines: readonly SegmentLinesState[],
): LinkFrame {
  return {
    enemies: enemies.map(enemyOf),
    drones: dronePool(drones),
    droneCount: drones.length,
    segments: { lines },
  };
}

interface DrawnStroke {
  readonly color: number;
  readonly width: number;
  readonly alpha: number;
  /** Each sub-path as [x1, y1, x2, y2]. */
  readonly links: number[][];
}

/** The layer's strokes of its last update, in draw order, each with its sub-paths. */
function strokesOf(view: Graphics): DrawnStroke[] {
  const out: DrawnStroke[] = [];
  for (const instruction of view.context.instructions) {
    if (instruction.action !== 'stroke') continue;
    const links: number[][] = [];
    let from: [number, number] | null = null;
    for (const step of instruction.data.path.instructions) {
      const data = step.data as number[];
      if (step.action === 'moveTo') from = [data[0] as number, data[1] as number];
      else if (step.action === 'lineTo' && from !== null) {
        links.push([from[0], from[1], data[0] as number, data[1] as number]);
        from = null;
      }
    }
    const style = instruction.data.style;
    out.push({ color: style.color, width: style.width, alpha: style.alpha, links });
  }
  return out;
}

const resolved = (frame: LinkFrame, ln: SegmentLinesState, i: number, alpha: number) => {
  const out = new Float64Array(4);
  const live = resolveLink(frame, ln, i, alpha, out);
  return { live, ends: Array.from(out) };
};

describe('the id lookups (enemyIndexOf, droneSlotOf)', () => {
  it('find every row of a pool whose rows come and go, as a scan does, and −1 for one gone', () => {
    const rng = createRng(4021);
    let ids: number[] = [];
    let next = 1;
    let checked = 0;
    let gone = 0;
    for (let round = 0; round < 300; round++) {
      // Appends take the next ids; removals keep the order, as both pools' compactions do.
      const adds = Math.floor(rng.next() * 6);
      for (let k = 0; k < adds; k++) ids.push(next++);
      const drop = rng.next() * 0.4;
      ids = ids.filter(() => rng.next() >= drop);
      const ds = dronePool(ids.map((id) => ({ id, x: id, y: -id })));
      // Enemies a tick left dead in the array read as gone too.
      const dead = new Set(ids.filter(() => rng.next() < 0.1));
      const enemies = ids.map((id) => enemyOf({ id, x: id, y: 0, alive: !dead.has(id) }));
      for (let id = 0; id <= next; id++) {
        const slot = ids.indexOf(id);
        expect(droneSlotOf(ds, ids.length, id), `round ${round} id ${id}`).toBe(slot);
        expect(enemyIndexOf(enemies, id), `round ${round} id ${id}`).toBe(
          slot >= 0 && !dead.has(id) ? slot : -1,
        );
        checked++;
        if (slot < 0) gone++;
      }
    }
    expect(checked).toBeGreaterThan(5000);
    expect(gone).toBeGreaterThan(2000);
  });

  it('reads only the first `count` slots of the drone pool: a row past it is gone', () => {
    const ds = dronePool([
      { id: 3, x: 0, y: 0 },
      { id: 5, x: 0, y: 0 },
      { id: 9, x: 0, y: 0 },
    ]);
    expect([3, 5, 9].map((id) => droneSlotOf(ds, 3, id))).toEqual([0, 1, 2]);
    expect([3, 5, 9].map((id) => droneSlotOf(ds, 2, id))).toEqual([0, 1, -1]);
    expect(droneSlotOf(ds, 0, 3)).toBe(-1);
  });
});

describe('resolveLink', () => {
  const shocked = linesOf('enemies', [
    [100, 100, 300, 100, 4, 7],
    [300, 100, 500, 500, 7, 9],
    [700, 700, 800, 800, 2, 11],
  ]);

  it('draws a shocked link’s ends on its alive enemies, between their last two ticks', () => {
    const frame = frameOf(
      [
        { id: 4, x: 120, y: 80, prevX: 100, prevY: 100 },
        { id: 7, x: 280, y: 140, prevX: 320, prevY: 100 },
        { id: 9, x: 520, y: 500 },
      ],
      [],
      [shocked],
    );
    expect(resolved(frame, shocked, 0, 0.25)).toEqual({ live: 2, ends: [105, 95, 310, 110] });
    expect(resolved(frame, shocked, 0, 1)).toEqual({ live: 2, ends: [120, 80, 280, 140] });
    expect(resolved(frame, shocked, 0, 0)).toEqual({ live: 2, ends: [100, 100, 320, 100] });
    expect(resolved(frame, shocked, 1, 0.5)).toEqual({ live: 2, ends: [300, 120, 520, 500] });
  });

  it('keeps a gone or dead enemy’s end at the stored coordinate, and reads 0 when both have gone', () => {
    const frame = frameOf(
      [
        { id: 4, x: 120, y: 80, prevX: 100, prevY: 100 },
        { id: 7, x: 280, y: 140, alive: false },
      ],
      [],
      [shocked],
    );
    // 7 is in the array but dead: its end stays where the judgement saw it.
    expect(resolved(frame, shocked, 0, 0.5)).toEqual({ live: 1, ends: [110, 90, 300, 100] });
    // 9 has gone from the array: the other end stays too, at 7's stored coordinate.
    expect(resolved(frame, shocked, 1, 0.5)).toEqual({ live: 0, ends: [300, 100, 500, 500] });
    expect(resolved(frame, shocked, 2, 0.5)).toEqual({ live: 0, ends: [700, 700, 800, 800] });
  });

  it('draws a pool link’s ends on its rows by id, interpolated, the stored coordinate for a row that left', () => {
    const pooled = linesOf('drones', [
      [10, 10, 50, 50, 2, 6],
      [50, 50, 90, 10, 6, 8],
    ]);
    // The ids name drone rows, not enemies: the enemies of the same ids stand elsewhere.
    const frame = frameOf(
      [
        { id: 2, x: 999, y: 999 },
        { id: 6, x: 999, y: 999 },
        { id: 8, x: 999, y: 999 },
      ],
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 20, y: 30, prevX: 12, prevY: 10 },
        { id: 6, x: 60, y: 40, prevX: 52, prevY: 48 },
      ],
      [pooled],
    );
    expect(resolved(frame, pooled, 0, 0.5)).toEqual({ live: 2, ends: [16, 20, 56, 44] });
    // Row 8 has left the pool: its end stays at the stored (90, 10).
    expect(resolved(frame, pooled, 1, 0.5)).toEqual({ live: 1, ends: [56, 44, 90, 10] });
    const empty = frameOf([], [{ id: 1, x: 0, y: 0 }], [pooled]);
    expect(resolved(empty, pooled, 0, 0.5)).toEqual({ live: 0, ends: [10, 10, 50, 50] });
  });
});

describe('SegmentLineLayer', () => {
  it('draws each emitter’s links for i < count in its pool’s style, skipping one whose ends have both gone', () => {
    const shocked = linesOf(
      'enemies',
      [
        [100, 100, 300, 100, 4, 7],
        [300, 100, 500, 500, 7, 9],
        [700, 700, 800, 800, 2, 11],
      ],
      // Stale links past count, whose endpoints are alive: never drawn.
      [
        [1, 2, 3, 4, 4, 9],
        [5, 6, 7, 8, 7, 4],
      ],
    );
    const pooled = linesOf('drones', [[10, 10, 50, 50, 2, 6]], [[9, 9, 9, 9, 2, 6]]);
    const frame = frameOf(
      [
        { id: 4, x: 120, y: 80, prevX: 100, prevY: 100 },
        { id: 7, x: 280, y: 140, prevX: 320, prevY: 100 },
      ],
      [
        { id: 2, x: 20, y: 30, prevX: 12, prevY: 10 },
        { id: 6, x: 60, y: 40, prevX: 52, prevY: 48 },
      ],
      [shocked, pooled],
    );
    const layer = new SegmentLineLayer();
    layer.update(frame, 0.5, 16);
    expect([layer.drawnShocked, layer.drawnPool]).toEqual([2, 1]);
    const drawn = strokesOf(layer.view);
    const shockLinks = [
      [110, 90, 300, 120],
      [300, 120, 500, 500],
    ];
    const poolLinks = [[16, 20, 56, 44]];
    expect(drawn.map((s) => [s.color, s.width, s.links])).toEqual([
      [SHOCK_STYLE.glow, SHOCK_STYLE.glowWidth, shockLinks],
      [SHOCK_STYLE.core, SHOCK_STYLE.coreWidth, shockLinks],
      [POOL_STYLE.glow, POOL_STYLE.glowWidth, poolLinks],
      [POOL_STYLE.core, POOL_STYLE.coreWidth, poolLinks],
    ]);
    // The chain lightning's cyan for shocked links, a cooler blue for the pool's.
    expect([SHOCK_STYLE.glow, POOL_STYLE.glow]).toEqual([COLORS.chain, COLORS.droneLink]);
    for (const s of drawn) {
      expect(s.alpha).toBeGreaterThan(0);
      expect(s.alpha).toBeLessThanOrEqual(0.7);
    }
  });

  it('draws a link whose endpoint has gone at its stored coordinate, not where it was drawn last', () => {
    const shocked = linesOf('enemies', [[100, 100, 300, 100, 4, 7]]);
    const alive = frameOf(
      [
        { id: 4, x: 140, y: 60, prevX: 100, prevY: 100 },
        { id: 7, x: 340, y: 160, prevX: 300, prevY: 100 },
      ],
      [],
      [shocked],
    );
    const layer = new SegmentLineLayer();
    layer.update(alive, 0.5, 16);
    expect(strokesOf(layer.view)[0]?.links).toEqual([[120, 80, 320, 130]]);
    // 7 has died since: its end goes back to the judgement's (300, 100), 4's follows it.
    const later = frameOf([{ id: 4, x: 160, y: 40, prevX: 140, prevY: 60 }], [], [shocked]);
    layer.update(later, 0.5, 16);
    expect(strokesOf(layer.view)[0]?.links).toEqual([[150, 50, 300, 100]]);
    // Both gone: nothing drawn, no stroke at all.
    layer.update(frameOf([], [], [shocked]), 0.5, 16);
    expect(strokesOf(layer.view)).toEqual([]);
    expect([layer.drawnShocked, layer.drawnPool]).toEqual([0, 0]);
  });

  it('draws nothing for count 0, and grows its scratch past FIRST_LINKS links', () => {
    const many = Array.from({ length: 300 }, (_, i): Link => [
      i,
      0,
      i,
      10,
      1 + (i % 50),
      51 + (i % 50),
    ]);
    const enemies = Array.from({ length: 100 }, (_, i): Row => ({ id: i + 1, x: i, y: 5 }));
    const layer = new SegmentLineLayer();
    layer.update(frameOf(enemies, [], [linesOf('enemies', many)]), 1, 16);
    expect(layer.drawnShocked).toBe(300);
    const links = strokesOf(layer.view)[1]?.links ?? [];
    expect(links).toHaveLength(300);
    expect(links[299]).toEqual([49, 5, 99, 5]);
    layer.update(frameOf(enemies, [], [linesOf('enemies', [], many)]), 1, 16);
    expect(strokesOf(layer.view)).toEqual([]);
  });

  it('pulses on its own frame clock, which clear() puts back at zero, and draws no randomness', () => {
    const math = vi.spyOn(Math, 'random');
    const frame = frameOf(
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 100, y: 0 },
      ],
      [],
      [linesOf('enemies', [[0, 0, 100, 0, 1, 2]])],
    );
    const alphas = (layer: SegmentLineLayer): number[] => strokesOf(layer.view).map((s) => s.alpha);
    const played = new SegmentLineLayer();
    for (let f = 0; f < 7; f++) played.update(frame, 1, 16);
    const fresh = new SegmentLineLayer();
    fresh.update(frame, 1, 16);
    expect(alphas(played)).not.toEqual(alphas(fresh));
    played.clear();
    expect(strokesOf(played.view)).toEqual([]);
    played.update(frame, 1, 16);
    expect(alphas(played)).toEqual(alphas(fresh));
    expect(math).not.toHaveBeenCalled();
    math.mockRestore();
  });

  it('destroys its Graphics, taking it out of its parent', () => {
    const parent = new Container();
    const layer = new SegmentLineLayer();
    parent.addChild(layer.view);
    layer.destroy();
    expect(layer.view.destroyed).toBe(true);
    expect(parent.children).toHaveLength(0);
  });
});

describe('SegmentLineLayer without `pools` (the lead’s ruling L2)', () => {
  it('draws the shocked links only, never reading a pool emitter’s links or the drone pool; with it, both', () => {
    const shocked = linesOf('enemies', [[100, 100, 300, 100, 4, 7]]);
    const fence = linesOf('drones', [[10, 10, 50, 50, 2, 6]]);
    const web = linesOf('drones', [[50, 50, 90, 10, 6, 8]]);
    const frame = frameOf(
      [
        { id: 4, x: 120, y: 80, prevX: 100, prevY: 100 },
        { id: 7, x: 280, y: 140, prevX: 320, prevY: 100 },
      ],
      [
        { id: 2, x: 20, y: 30, prevX: 12, prevY: 10 },
        { id: 6, x: 60, y: 40, prevX: 52, prevY: 48 },
        { id: 8, x: 90, y: 10 },
      ],
      [fence, shocked, web],
    );
    // Every read of the drone pool, and of a pool emitter's links past its count and pool.
    let reads = 0;
    const watched = (ln: SegmentLinesState): SegmentLinesState =>
      new Proxy(ln, {
        get: (target, key, receiver) => {
          if (key !== 'count' && key !== 'pool') reads++;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
    const lines = [watched(fence), shocked, watched(web)];
    const counted: LinkFrame = {
      enemies: frame.enemies,
      get drones() {
        reads++;
        return frame.drones;
      },
      get droneCount() {
        reads++;
        return frame.droneCount;
      },
      segments: { lines },
    };
    const shockLinks = [[110, 90, 300, 120]];
    const poolLinks = [
      [16, 20, 56, 44],
      [56, 44, 90, 10],
    ];
    const off = new SegmentLineLayer({ pools: false });
    for (let f = 0; f < 3; f++) off.update(counted, 0.5, 16);
    expect([off.drawnShocked, off.drawnPool]).toEqual([1, 0]);
    expect(strokesOf(off.view).map((s) => [s.color, s.links])).toEqual([
      [SHOCK_STYLE.glow, shockLinks],
      [SHOCK_STYLE.core, shockLinks],
    ]);
    expect(reads).toBe(0);
    // A frame of pool links only draws nothing at all.
    off.update({ ...frame, segments: { lines: [fence, web] } }, 0.5, 16);
    expect(strokesOf(off.view)).toEqual([]);
    expect([off.drawnShocked, off.drawnPool]).toEqual([0, 0]);
    for (const on of [new SegmentLineLayer({ pools: true }), new SegmentLineLayer()]) {
      on.update(counted, 0.5, 16);
      expect([on.drawnShocked, on.drawnPool]).toEqual([1, 2]);
      expect(strokesOf(on.view).map((s) => [s.color, s.links])).toEqual([
        [SHOCK_STYLE.glow, shockLinks],
        [SHOCK_STYLE.core, shockLinks],
        [POOL_STYLE.glow, poolLinks],
        [POOL_STYLE.core, poolLinks],
      ]);
    }
    expect(reads).toBeGreaterThan(0);
  });
});

/** What these tests use of renderer.ts' Renderer. */
interface RendererLike {
  render(state: Readonly<SimState>, alpha: number, frameMs: number): void;
  handleEvents(events: readonly SimEvent[]): void;
  beginRun(typicalHit: number): void;
  destroy(): void;
}
interface RendererModule {
  readonly Renderer: new (
    app: unknown,
    data: GameData,
    options: { reducedMotion: boolean; random?: () => number; construct?: 'hive' },
  ) => RendererLike;
}
// A computed path: renderer.ts reaches the DOM's types, which the tools' tsconfig (the tests')
// leaves out, as random.test.ts loads bursts.ts.
const RENDERER = './renderer';
const { Renderer } = (await import(/* @vite-ignore */ RENDERER)) as RendererModule;

/** A stand-in Application: a stage, a screen and a renderer that makes textures and listens. */
function fakeApp(): { stage: Container; listeners: number } {
  const app = {
    stage: new Container(),
    screen: { width: 1920, height: 1080 },
    listeners: 0,
    renderer: {
      resolution: 1,
      generateTexture: () => Texture.WHITE,
      on: () => {
        app.listeners++;
      },
      off: () => {
        app.listeners--;
      },
    },
  };
  return app;
}

/** The world container: the stage's first child (the letterbox is the second). */
const worldOf = (app: { stage: Container }): Container => app.stage.children[0] as Container;
const labels = (app: { stage: Container }): string[] =>
  worldOf(app).children.map((child) => child.label);

/** M1's volley build, or one with 雷網 on outer.lightning that shocks its hits. */
function simOf(segment: boolean) {
  const stats = makeStats(
    { damage: 5, maxLife: 1e6, shockChance: 1, chainCount: 0 },
    [],
    segment
      ? {
          triggers: [],
          conversions: [],
          emitters: [
            { source: 'outer.lightning', grant: { kind: 'segment', endpoints: 'shocked' } },
          ],
        }
      : undefined,
  );
  return createSimulation(makeConfig({ seed: 3, stats, startWave: 8 }), makeTestData());
}

describe('the segment-line layer in the Renderer', () => {
  it('is made only once a state with a segment emitter is drawn, under the enemies and over their flames', () => {
    const app = fakeApp();
    const renderer = new Renderer(app, makeTestData(), { reducedMotion: true, random: () => 0.5 });
    const before = labels(app);
    expect(before).not.toContain('segment-lines');
    // A run without a segment emitter never makes it.
    const plain = simOf(false);
    for (let t = 0; t < 120; t++) {
      renderer.handleEvents(plain.step(NO_INPUT));
      renderer.render(plain.state, 1, 16);
    }
    expect(plain.state.segments.lines).toHaveLength(0);
    expect(labels(app)).toEqual(before);
    // The first frame of a run with one makes it, just under the enemies.
    renderer.beginRun(5);
    const web = simOf(true);
    web.step(NO_INPUT);
    renderer.render(web.state, 1, 16);
    const after = labels(app);
    const at = after.indexOf('segment-lines');
    expect(after.filter((label) => label === 'segment-lines')).toHaveLength(1);
    expect(after[at + 1]).toBe('enemies');
    expect(after.slice(0, at)).toEqual(['backdrop', 'burn-glow', 'fx']);
    expect([...after.slice(0, at), ...after.slice(at + 1)]).toEqual(before);
    // It draws the run's links as they come, and is kept, not remade, for later frames and runs.
    let drawn = 0;
    for (let t = 0; t < 600; t++) {
      renderer.handleEvents(web.step(NO_INPUT));
      renderer.render(web.state, 1, 16);
      const layer = worldOf(app).children[at] as Graphics;
      drawn += layer.context.instructions.length;
    }
    expect(drawn).toBeGreaterThan(0);
    // beginRun clears the last run's lines before the next run draws a frame.
    const view = worldOf(app).children[at] as Graphics;
    for (let t = 0; t < 600 && view.context.instructions.length === 0; t++) {
      renderer.handleEvents(web.step(NO_INPUT));
      renderer.render(web.state, 1, 16);
    }
    expect(view.context.instructions.length).toBeGreaterThan(0);
    renderer.beginRun(5);
    expect(view.context.instructions).toEqual([]);
    renderer.render(plain.state, 1, 16);
    expect(labels(app)).toEqual(after);
    expect(view.context.instructions).toEqual([]);
    // Destroyed with the renderer.
    expect(app.listeners).toBe(1);
    renderer.destroy();
    expect(app.listeners).toBe(0);
    expect(view.destroyed).toBe(true);
    expect(labels(app)).toEqual(before);
  });

  it('is never made on a renderer that draws no segment emitter, and destroy() is safe without it', () => {
    const app = fakeApp();
    const renderer = new Renderer(app, makeTestData(), { reducedMotion: true, random: () => 0.5 });
    const plain = simOf(false);
    for (let t = 0; t < 30; t++) {
      renderer.handleEvents(plain.step(NO_INPUT));
      renderer.render(plain.state, 1, 16);
    }
    expect(labels(app)).not.toContain('segment-lines');
    renderer.destroy();
    expect(app.listeners).toBe(0);
  });
});

describe('the segment-line layer past its first scratch and on a real frame (review)', () => {
  it('draws every link of both styles exactly once each scratch grows, the pool’s across its emitters', () => {
    // 130 shocked links, and 70 + 70 links of two pool emitters, which share the pool's scratch:
    // both grow past FIRST_LINKS (64), and every link, the 65th among them, keeps its ends.
    const enemies = Array.from({ length: 140 }, (_, i): Row => ({ id: i + 1, x: 3 * i, y: 7 }));
    const drones = Array.from({ length: 141 }, (_, i): Row => ({ id: i + 1, x: 5 * i, y: -11 }));
    const chainOf = (n: number, from: number): Link[] =>
      Array.from({ length: n }, (_, i): Link => [0, 0, 0, 0, from + i, from + i + 1]);
    const shocked = chainOf(130, 1);
    const poolA = chainOf(70, 1);
    const poolB = chainOf(70, 71);
    const layer = new SegmentLineLayer();
    layer.update(
      frameOf(enemies, drones, [
        linesOf('enemies', shocked),
        linesOf('drones', poolA),
        linesOf('drones', poolB),
      ]),
      1,
      16,
    );
    expect([layer.drawnShocked, layer.drawnPool]).toEqual([130, 140]);
    const shockEnds = shocked.map(([, , , , a, b]) => [3 * (a - 1), 7, 3 * (b - 1), 7]);
    const poolEnds = [...poolA, ...poolB].map(([, , , , a, b]) => [
      5 * (a - 1),
      -11,
      5 * (b - 1),
      -11,
    ]);
    expect(strokesOf(layer.view).map((s) => s.links)).toEqual([
      shockEnds,
      shockEnds,
      poolEnds,
      poolEnds,
    ]);
  });

  it('draws each frame’s links in the Renderer where resolveLink puts them at that frame’s alpha', () => {
    const app = fakeApp();
    const renderer = new Renderer(app, makeTestData(), { reducedMotion: true, random: () => 0.5 });
    renderer.beginRun(5);
    const web = simOf(true);
    const out = new Float64Array(4);
    const at1 = new Float64Array(4);
    let frames = 0;
    let apart = 0;
    for (let t = 0; t < 600; t++) {
      renderer.handleEvents(web.step(NO_INPUT));
      const alpha = [0.25, 0.5, 0.75][t % 3] as number;
      renderer.render(web.state, alpha, 16);
      const view = worldOf(app).children[labels(app).indexOf('segment-lines')] as Graphics;
      const expected: number[][] = [];
      for (const ln of web.state.segments.lines) {
        for (let i = 0; i < ln.count; i++) {
          if (resolveLink(web.state, ln, i, alpha, out) === 0) continue;
          expected.push(Array.from(out));
          resolveLink(web.state, ln, i, 1, at1);
          if (at1.some((v, k) => v !== out[k])) apart++;
        }
      }
      expect(strokesOf(view)[1]?.links ?? [], `tick ${web.state.tick}`).toEqual(expected);
      if (expected.length > 0) frames++;
    }
    // Frames with links, whose moving ends sit apart from where they stand on the tick.
    expect(frames).toBeGreaterThan(100);
    expect(apart).toBeGreaterThan(100);
    renderer.destroy();
  });
});

/**
 * A fence (four drones and a turret, each row linked to its nearest) and a drone web re-paired
 * every 0.5 s, and with `shocked` 雷網 on hits that all shock.
 */
function fenceSimOf(shocked: boolean) {
  const stats = makeStats({ damage: 5, maxLife: 1e6, shockChance: 1, chainCount: 0 }, [], {
    triggers: [],
    conversions: [],
    emitters: [
      { source: 'outer.summon', grant: { kind: 'drone', drones: 4, turrets: 1 } },
      { source: 'outer.summon', grant: { kind: 'segment', endpoints: 'summons', links: 1 } },
      {
        source: 'outer.lightning',
        grant: { kind: 'segment', endpoints: 'drones', links: 1, pairPeriodSec: 0.5 },
      },
      ...(shocked
        ? [
            {
              source: 'outer.lightning',
              grant: { kind: 'segment' as const, endpoints: 'shocked' as const },
            },
          ]
        : []),
    ],
  });
  return createSimulation(makeConfig({ seed: 5, stats, startWave: 8 }), makeTestData());
}

/** The core strokes' links the Renderer's segment-line layer drew last, by style. */
function drawnLinks(app: { stage: Container }): { shocked: number[][]; pool: number[][] } {
  const at = labels(app).indexOf('segment-lines');
  const strokes = at < 0 ? [] : strokesOf(worldOf(app).children[at] as Graphics);
  const core = (color: number): number[][] => strokes.find((s) => s.color === color)?.links ?? [];
  return { shocked: core(SHOCK_STYLE.core), pool: core(POOL_STYLE.core) };
}

describe('links between drones only where the Renderer draws the drones (the lead’s ruling L2)', () => {
  for (const shocked of [false, true]) {
    it(`draws a fence’s and a drone web’s links with the hive construct only${shocked ? ', 雷網’s on both' : ''}`, () => {
      const plainApp = fakeApp();
      const hiveApp = fakeApp();
      const options = { reducedMotion: true, random: () => 0.5 };
      const plain = new Renderer(plainApp, makeTestData(), options);
      const hive = new Renderer(hiveApp, makeTestData(), { ...options, construct: 'hive' });
      plain.beginRun(5);
      hive.beginRun(5);
      const sim = fenceSimOf(shocked);
      const out = new Float64Array(4);
      let poolFrames = 0;
      let shockFrames = 0;
      for (let t = 0; t < 600; t++) {
        const events = sim.step(NO_INPUT);
        plain.handleEvents(events);
        hive.handleEvents(events);
        plain.render(sim.state, 0.5, 16);
        hive.render(sim.state, 0.5, 16);
        const want = { shocked: [] as number[][], pool: [] as number[][] };
        for (const ln of sim.state.segments.lines) {
          for (let i = 0; i < ln.count; i++) {
            if (resolveLink(sim.state, ln, i, 0.5, out) === 0) continue;
            (ln.pool === 'drones' ? want.pool : want.shocked).push(Array.from(out));
          }
        }
        const tick = `tick ${sim.state.tick}`;
        expect(drawnLinks(plainApp), tick).toEqual({ shocked: want.shocked, pool: [] });
        expect(drawnLinks(hiveApp), tick).toEqual(want);
        if (want.pool.length > 0) poolFrames++;
        if (want.shocked.length > 0) shockFrames++;
      }
      // Both renderers made the layer (the build has segment emitters); the plain one, on a
      // fence alone, draws nothing into it.
      expect(labels(plainApp)).toContain('segment-lines');
      expect(labels(hiveApp)).toContain('segment-lines');
      expect(poolFrames).toBeGreaterThan(300);
      if (shocked) expect(shockFrames).toBeGreaterThan(100);
      else expect(shockFrames).toBe(0);
      plain.destroy();
      hive.destroy();
    });
  }
});
