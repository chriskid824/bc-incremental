import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Texture } from 'pixi.js';
import type { Renderer as PixiRenderer } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { num } from '../core/num';
import { createRng } from '../core/rng';
import type { GameData } from '../data/types';
import type { EnemyState } from '../sim';
import { makeTestData } from '../sim/testing';
import { ArcLayer } from './arcs';
import { FxParticles } from './fx';
import { ShardParticles } from './particles';
import { defaultRandom } from './random';
import type { RenderRandom } from './random';
import { RingLayer } from './rings';
import { ScreenShake } from './shake';

/** What the scenes use of bursts.ts' Bursts. */
interface BurstsLayer {
  kill(x: number, y: number, color: number, radius: number, tier: number, crowd: number): void;
  hit(x: number, y: number, dirX: number, dirY: number): void;
  crit(x: number, y: number, decades: number, big: boolean): void;
  flame(x: number, y: number, radius: number, heat: number): void;
  nova(x: number, y: number, radius: number): void;
  ember(fromX: number, fromY: number, toX: number, toY: number): void;
}
interface BurstsModule {
  readonly Bursts: new (
    fx: FxParticles,
    under: FxParticles,
    textures: Readonly<Record<string, Texture>>,
    rings: RingLayer,
    random?: RenderRandom,
  ) => BurstsLayer;
  readonly TIER_NORMAL: number;
  readonly TIER_BOSS: number;
}
interface EnemiesModule {
  readonly EnemyLayer: new (
    data: GameData,
    glow: Texture,
    random?: RenderRandom,
  ) => {
    update(enemies: readonly EnemyState[], alpha: number, dtMs: number, bursts: BurstsLayer): void;
  };
}

// Computed paths: bursts.ts and enemies.ts read fxTextures.ts' types, and fxTextures.ts needs the
// DOM, which the tools' tsconfig (the tests') leaves out (main.test.ts loads main.ts the same way).
const BURSTS = './bursts';
const ENEMIES = './enemies';
const { Bursts, TIER_BOSS, TIER_NORMAL } = (await import(
  /* @vite-ignore */ BURSTS
)) as BurstsModule;
const { EnemyLayer } = (await import(/* @vite-ignore */ ENEMIES)) as EnemiesModule;

const tex = Texture.WHITE;
const TEXTURES = { glow: tex, star: tex, streak: tex, shard: tex, flame: tex };
/** No renderer in node: ShardParticles only asks it for its shard texture. */
const RENDERER = { generateTexture: () => tex } as unknown as PixiRenderer;
const DATA = makeTestData();

function newBursts(random?: RenderRandom): {
  bursts: BurstsLayer;
  fx: FxParticles;
  under: FxParticles;
} {
  const fx = new FxParticles({ glow: tex });
  const under = new FxParticles({ glow: tex });
  return { bursts: new Bursts(fx, under, TEXTURES, new RingLayer(), random), fx, under };
}

const burning = (id: number, x: number): EnemyState => ({
  id,
  type: 'triangle',
  wave: 1,
  x,
  y: 40,
  prevX: x,
  prevY: 40,
  hp: num(5),
  maxHp: num(10),
  radius: 12,
  burnStacks: 3,
  alive: true,
  v3: null,
});

/**
 * Every layer the Renderer hands its RenderRandom to and node can build (DamageNumbers installs
 * its fonts on a canvas), each through one fixed scene that draws: what it shows after it.
 */
const SCENES: Readonly<Record<string, (random?: RenderRandom) => unknown>> = {
  shake: (random) => {
    const shake = new ScreenShake(false, random);
    shake.add(1);
    const offsets: number[] = [];
    for (let i = 0; i < 4; i++) {
      shake.update(16);
      offsets.push(shake.offsetX, shake.offsetY);
    }
    return offsets;
  },
  arcs: (random) => {
    const arcs = new ArcLayer(random);
    arcs.add(0, 0, 320, 60, 1);
    arcs.add(-200, 10, 140, -220, 2);
    arcs.update(16);
    arcs.update(50);
    return arcs.view.context.instructions.map((i) =>
      JSON.stringify((i.data as { path?: { instructions: unknown } }).path?.instructions),
    );
  },
  bursts: (random) => {
    const { bursts, fx } = newBursts(random);
    bursts.kill(0, 0, 0xff8040, 24, TIER_BOSS, 1);
    bursts.kill(50, 0, 0x40ff80, 12, TIER_NORMAL, 0.5);
    bursts.hit(10, 10, 1, 0);
    bursts.crit(20, 20, 1, true);
    bursts.flame(30, 30, 12, 0.5);
    bursts.nova(0, 0, 120);
    bursts.ember(0, 0, 100, 50);
    return fx.view.particleChildren.map((p) => [p.x, p.y, p.rotation, p.scaleX]);
  },
  shards: (random) => {
    const shards = new ShardParticles(RENDERER, random);
    shards.burst(0, 0, 0xffffff, 12, 1);
    return shards.view.particleChildren.map((p) => [p.rotation, p.scaleX]);
  },
  enemies: (random) => {
    const enemies = new EnemyLayer(DATA, tex, random);
    const { bursts, under } = newBursts(random);
    for (let frame = 0; frame < 30; frame++) {
      enemies.update([burning(1, 0), burning(2, 60)], 1, 16, bursts);
    }
    // Each burning enemy sheds flames from a random debt (flameDebt) at random spots.
    return under.view.particleChildren.map((p) => [p.x, p.y]);
  },
};

/** A RenderRandom on a seeded stream that keeps every number it gives. */
function recording(seed: number): { random: RenderRandom; draws: number[] } {
  const rng = createRng(seed);
  const draws: number[] = [];
  return {
    random: () => {
      const value = rng.next();
      draws.push(value);
      return value;
    },
    draws,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RenderRandom (src/render/random.ts, docs/v3 C10 design §2.5, OWN test 2)', () => {
  it.each(Object.keys(SCENES))(
    '%s draws only through the RenderRandom it is given: equal seeds draw equal sequences',
    (name) => {
      const scene = SCENES[name] as (random?: RenderRandom) => unknown;
      const math = vi.spyOn(Math, 'random');
      const [a, b, c] = [1, 1, 2].map(recording) as [
        ReturnType<typeof recording>,
        ReturnType<typeof recording>,
        ReturnType<typeof recording>,
      ];
      const shown = [scene(a.random), scene(b.random), scene(c.random)];
      expect(math).not.toHaveBeenCalled();
      expect(a.draws.length).toBeGreaterThan(0);
      expect(b.draws).toEqual(a.draws);
      expect(shown[1]).toEqual(shown[0]);
      expect(c.draws).not.toEqual(a.draws);
    },
  );

  it('defaults to Math.random itself: its numbers, in its order, one call a draw (J2)', () => {
    const math = vi.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValueOnce(0.875);
    expect([defaultRandom(), defaultRandom()]).toEqual([0.25, 0.875]);
    expect(math).toHaveBeenCalledTimes(2);
  });

  it.each(Object.keys(SCENES))(
    '%s draws Math.random when given none, as the M1 page and ?hive build it',
    (name) => {
      const scene = SCENES[name] as (random?: RenderRandom) => unknown;
      const math = vi.spyOn(Math, 'random');
      scene();
      expect(math).toHaveBeenCalled();
    },
  );
});

const RENDER_DIR = fileURLToPath(new URL('.', import.meta.url));
/** The clocks and the unseeded stream a frame must not read. */
const UNSEEDED = /\bMath\s*\.\s*random\b|\bperformance\s*\.\s*now\b|\bDate\s*\.\s*now\b/g;

/** `source` with its comments blanked out, as the D1 guard reads code (isolation.test.ts). */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');

describe('src/render reads no clock and no unseeded stream (OWN test 3)', () => {
  it('names Math.random once, in random.ts’ default, and performance.now and Date.now nowhere', () => {
    const files = readdirSync(RENDER_DIR, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => file.replaceAll('\\', '/'))
      .sort();
    expect(files).toEqual(expect.arrayContaining(['renderer.ts', 'random.ts', 'shake.ts']));
    const found = files.flatMap((file) =>
      [...code(readFileSync(`${RENDER_DIR}${file}`, 'utf8')).matchAll(UNSEEDED)].map(
        (match) => `${file}: ${match[0]}`,
      ),
    );
    expect(found).toEqual(['random.ts: Math.random']);
  });

  it('hands the renderer’s RenderRandom to every layer that draws one', () => {
    const source = code(readFileSync(`${RENDER_DIR}renderer.ts`, 'utf8'));
    expect(source).toContain('const random = options.random ?? defaultRandom;');
    for (const layer of [
      'ArcLayer',
      'DamageNumbers',
      'EnemyLayer',
      'Bursts',
      'ShardParticles',
      'ScreenShake',
    ]) {
      const call = new RegExp(`new ${layer}\\(([^)]*)\\)`).exec(source);
      expect(call?.[1], layer).toMatch(/(^|[\s,(])random\s*$/);
    }
  });
});
