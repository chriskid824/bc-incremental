/**
 * What Renderer.restart puts back besides beginRun (docs/v3 C10 design §1.7: a replay's seek and
 * loop draw what a fresh replay draws, on the one renderer the replay keeps): the animation clocks
 * at zero and the number slots handed out first-made first, so a restarted layer draws as a new
 * one and makes nothing new. The Renderer itself needs a canvas: tools/sheets/replaySmoke.ts
 * checks it whole, a seek and a loop against a fresh load's frame.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Texture } from 'pixi.js';
import type { BitmapText, Container } from 'pixi.js';
import type * as PixiModule from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { num } from '../core/num';
import type { GameData } from '../data/types';
import type { EnemyState } from '../sim';
import { makeTestData } from '../sim/testing';
import { HiveCoreView } from './core';
import type { CoreView } from './core';
import { DamageNumbers } from './damageNumbers';
import { PlayerView } from './player';

vi.mock('pixi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof PixiModule>()),
  // No canvas in node to draw the fonts on: the slots' order needs none.
  BitmapFont: { install: () => undefined },
}));

interface EnemiesModule {
  readonly EnemyLayer: new (
    data: GameData,
    glow: Texture,
    random?: () => number,
  ) => {
    readonly view: Container;
    readonly burnGlow: { readonly particleChildren: readonly { color: number; scaleX: number }[] };
    update(
      enemies: readonly EnemyState[],
      alpha: number,
      dtMs: number,
      bursts: { flame(x: number, y: number, radius: number, heat: number): void },
    ): void;
    clear(): void;
    rewind(): void;
  };
}

// A computed path: enemies.ts reads bursts.ts' types, which reach fxTextures.ts and the DOM that
// the tools' tsconfig (the tests') leaves out, as random.test.ts loads it.
const ENEMIES = './enemies';
const { EnemyLayer } = (await import(/* @vite-ignore */ ENEMIES)) as EnemiesModule;

const PLAYER = { x: 960, y: 540, life: 100, maxLife: 100, shield: 0 };
/** A frame of 16 ms, and the frames a run has shown before it restarts. */
const FRAME_MS = 16;
const PLAYED_FRAMES = 50;

/** Every part's rotation, scale, alpha and tint, depth first: what the clocks move. */
function pose(view: Container): number[][] {
  return [
    [view.rotation, view.scale.x, view.scale.y, view.alpha, view.tint],
    ...view.children.flatMap((child) => pose(child)),
  ];
}

describe('Renderer.restart (docs/v3 C10 design §1.7, C10.5a)', () => {
  it.each([
    ['M1’s hexagon', (): CoreView => new PlayerView()],
    ['the hive’s comb', (): CoreView => new HiveCoreView({ dockedShare: 1 })],
  ])('rewinds the center’s clock: %s then draws as a new one', (_name, make) => {
    const played = (rewind: boolean): CoreView => {
      const core = make();
      for (let f = 0; f < PLAYED_FRAMES; f++) core.update(PLAYER, FRAME_MS);
      core.reset();
      if (rewind) core.rewind();
      return core;
    };
    const [rewound, reset, fresh] = [played(true), played(false), make()];
    for (const core of [rewound, reset, fresh]) {
      core.update(PLAYER, FRAME_MS);
      core.update(PLAYER, FRAME_MS);
    }
    expect(pose(rewound.view)).toEqual(pose(fresh.view));
    // beginRun's reset alone keeps the clock: the spin, the breathing, the comb's pulse.
    expect(pose(reset.view)).not.toEqual(pose(fresh.view));
  });

  it('rewinds the enemies’ clock: a rewound layer spins and flickers as a new one', () => {
    const data = makeTestData();
    const bursts = { flame: (): void => undefined };
    const crowd = [1, 2, 3].map((id): EnemyState => ({
      id,
      type: 'triangle',
      wave: 1,
      x: 300 * id,
      y: 400,
      prevX: 300 * id,
      prevY: 400,
      hp: num(5),
      maxHp: num(10),
      radius: 12,
      burnStacks: id - 1,
      alive: true,
      v3: null,
    }));
    const layer = () => new EnemyLayer(data, Texture.WHITE, () => 0.5);
    const played = (rewind: boolean) => {
      const enemies = layer();
      for (let f = 0; f < PLAYED_FRAMES; f++) enemies.update(crowd, 1, FRAME_MS, bursts);
      enemies.clear();
      if (rewind) enemies.rewind();
      return enemies;
    };
    const [rewound, cleared, fresh] = [played(true), played(false), layer()];
    const drawn = (enemies: ReturnType<typeof layer>) => [
      pose(enemies.view),
      enemies.burnGlow.particleChildren.map((glow) => [glow.color, glow.scaleX]),
    ];
    for (const enemies of [rewound, cleared, fresh]) {
      enemies.update(crowd, 1, FRAME_MS, bursts);
      enemies.update(crowd, 1, FRAME_MS, bursts);
    }
    expect(drawn(rewound)).toEqual(drawn(fresh));
    expect(drawn(cleared)).not.toEqual(drawn(fresh));
  });

  it('hands the number slots out first-made first: new numbers stack as on a new DamageNumbers, on no new slot', () => {
    /** Each layer's (normal, then crits) shown numbers, bottom first, with their place in it. */
    const shown = (numbers: DamageNumbers): string[][] =>
      (numbers.view.children as Container[]).map((layer) =>
        layer.children.flatMap((text, i) =>
          text.visible ? [`${i}:${(text as BitmapText).text}`] : [],
        ),
      );
    const spawn = (numbers: DamageNumbers, count: number, y: number): void => {
      for (let i = 0; i < count; i++) {
        numbers.spawn('hit', num(10 * (i + 1)), 200 + 300 * i, y, i);
        numbers.spawn('crit', num(1000 * (i + 1)), 200 + 300 * i, y + 300, 10 + i);
      }
    };
    const played = (rewind: boolean): DamageNumbers => {
      const numbers = new DamageNumbers(() => 0.5);
      spawn(numbers, 5, 300);
      numbers.clear();
      if (rewind) numbers.rewind();
      return numbers;
    };
    const [rewound, cleared, fresh] = [played(true), played(false), new DamageNumbers(() => 0.5)];
    for (const numbers of [rewound, cleared, fresh]) spawn(numbers, 3, 200);
    expect(shown(fresh)).toEqual([
      ['0:10', '1:20', '2:30'],
      ['0:1.00K', '1:2.00K', '2:3.00K'],
    ]);
    expect(shown(rewound)).toEqual(shown(fresh));
    // Nothing made: the five slots of each layer the run before made.
    expect((rewound.view.children as Container[]).map((layer) => layer.children.length)).toEqual([
      5, 5,
    ]);
    // beginRun's clear alone hands the last-freed slot out first: the top one.
    expect(shown(cleared)).not.toEqual(shown(fresh));
  });

  it('is beginRun, then each rewind: the center’s, the enemies’ and the numbers’', () => {
    const source = readFileSync(fileURLToPath(new URL('./renderer.ts', import.meta.url)), 'utf8');
    const body = /\n {2}restart\(typicalHit: number\): void \{\n([\s\S]*?)\n {2}\}\n/.exec(source);
    expect(body?.[1]?.split('\n').map((line) => line.trim())).toEqual([
      'this.beginRun(typicalHit);',
      'this.core.rewind();',
      'this.enemies.rewind();',
      'this.numbers.rewind();',
    ]);
  });
});
