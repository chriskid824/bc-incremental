/**
 * What a burning enemy's fire reads (Hoshi's answer (A) to Q10: the sim unchanged, the flame drawn
 * from the burn still burning). EnemyLayer draws the glow, the warm cast and the flames from the
 * enemy's live burn stacks at the tick the frame shows (liveBurnStacks, src/sim/ailments/
 * records.ts), not from Enemy.burnStacks: a damage-over-time step's ring recount (syncRingStacks,
 * src/sim/ailments/apply.ts) sets that to 0 while a burn record still burns on an enemy that also
 * holds a ring, burn plus poison. The heat and the flame rate keep their formulas.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Texture } from 'pixi.js';
import type { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { num } from '../core/num';
import type { GameData } from '../data/types';
import type { EnemyState } from '../sim';
import { hitWithPayload } from '../sim/combat/hit';
import { updateAilments } from '../sim/systems/ailments';
import type { BurnStack, Enemy } from '../sim/systems/context';
import { makeStats, makeTestData, placedEnemies } from '../sim/testing';
import { TICK_RATE } from '../sim/types';

interface Flames {
  flame(x: number, y: number, radius: number, heat: number): void;
}
interface Layer {
  readonly view: Container;
  readonly burnGlow: {
    readonly particleChildren: readonly {
      x: number;
      y: number;
      scaleX: number;
      scaleY: number;
      color: number;
    }[];
  };
  update(
    enemies: readonly EnemyState[],
    tick: number,
    alpha: number,
    dtMs: number,
    bursts: Flames,
  ): void;
}
interface EnemiesModule {
  readonly EnemyLayer: new (data: GameData, glow: Texture, random?: () => number) => Layer;
}

// A computed path: enemies.ts reads bursts.ts' types, which reach fxTextures.ts and the DOM that
// the tools' tsconfig (the tests') leaves out, as random.test.ts loads it.
const ENEMIES = './enemies';
const { EnemyLayer } = (await import(/* @vite-ignore */ ENEMIES)) as EnemiesModule;

const DATA = makeTestData();
/** EnemyLayer's caps and rates (src/render/enemies.ts), and its glow texture's size. */
const BURN_VISUAL_STACKS = 4;
const FLAME_RATE = 11;
const FLAME_RATE_PER_STACK = 3;
const GLOW_SIZE = 64;

/** An enemy as the sim hands it to render, with only the burn fields liveBurnStacks reads. */
type Burning = EnemyState & Pick<Enemy, 'burns' | 'burnRingEnd'>;

/** A triangle at (500, 400) with burn records ending at `ends` and the given counts. */
function enemy(ends: readonly number[], burnStacks: number, burnRingEnd = 0): Burning {
  return {
    id: 3,
    type: 'triangle',
    wave: 1,
    x: 500,
    y: 400,
    prevX: 500,
    prevY: 400,
    hp: num(5),
    maxHp: num(10),
    radius: 12,
    burnStacks,
    alive: true,
    v3: null,
    burns: ends.map((end) => ({ dps: num(1), start: 0, end, depth: 0, source: 0, cls: 0 })),
    burnRingEnd,
  };
}

/** Every node's tint under `view`, depth first: the warm cast of the fire among them. */
const tints = (view: Container): number[] => [
  view.tint,
  ...view.children.flatMap((child) => tints(child)),
];

/** What a layer drew: its glows, every tint, and the heat of each flame it shed. */
interface Drawn {
  readonly glows: number[][];
  readonly tints: number[];
  readonly heats: number[];
}

/** One frame of `dtMs` at tick `tick` on `layer` (a new one by default), its flame debt at 0. */
function frame(
  enemies: readonly EnemyState[],
  tick: number,
  dtMs = 1000,
  layer = new EnemyLayer(DATA, Texture.WHITE, () => 0),
): Drawn {
  const heats: number[] = [];
  layer.update(enemies, tick, 1, dtMs, { flame: (_x, _y, _r, heat) => void heats.push(heat) });
  return {
    glows: layer.burnGlow.particleChildren.map((g) => [g.x, g.y, g.scaleX, g.scaleY, g.color]),
    tints: tints(layer.view),
    heats,
  };
}

/** Whether the frame shows the enemy on fire: its glow and at least one flame. */
const lit = (drawn: Drawn): boolean => drawn.glows.length === 1 && drawn.heats.length > 0;

/** An enemy hit once at tick 1 with every hit igniting, and poisoning too with `poison`. */
function hitOnce(poison: boolean) {
  const values = poison ? { igniteChance: 1, poisonChance: 1 } : { igniteChance: 1 };
  const ctx = placedEnemies([{ x: 1100, y: 540, hp: 1e6 }], {
    stats: makeStats({ damage: 10, critChance: 0, ...values }),
  });
  const target = ctx.enemies[0] as Enemy;
  const payload = ctx.emitters[0]?.payload;
  if (payload === undefined) throw new Error('no signature payload');
  hitWithPayload(ctx, target, payload, 0, 1, null, null, false, 0, -1);
  return { ctx, target };
}

describe('EnemyLayer’s fire reads the live burn (Hoshi’s Q10 (A))', () => {
  it('draws a burn-plus-poison enemy’s flame and glow after its first damage-over-time step as the same burn alone’s', () => {
    const runs = [false, true].map((poison) => {
      const { ctx, target } = hitOnce(poison);
      const end = (target.burns[0] as BurnStack).end;
      const layer = new EnemyLayer(DATA, Texture.WHITE, () => 0);
      const shown: Drawn[] = [];
      const stale: number[] = [];
      for (let tick = 1; tick <= end + 5; tick++) {
        if (tick > 1) {
          ctx.now = ++ctx.state.tick;
          updateAilments(ctx);
        }
        if (target.burnStacks === 0 && target.burns.some((b) => b.end > tick)) stale.push(tick);
        shown.push(frame(ctx.state.enemies, ctx.state.tick, 1000 / TICK_RATE, layer));
      }
      return { end, shown, stale };
    });
    const [alone, withPoison] = runs as [(typeof runs)[0], (typeof runs)[0]];
    // The sim as it is (Q10 (A)): from the first step (tick 15) the poisoned enemy's burnStacks
    // reads 0 while its record burns; burn alone keeps its count.
    expect(alone.stale).toEqual([]);
    expect(withPoison.stale[0]).toBe(15);
    expect(withPoison.stale.at(-1)).toBe(withPoison.end - 1);
    // Both burn on every tick before the record's end and on none from it; the flames are one
    // stack's.
    for (const run of runs) {
      const litTicks = run.shown.flatMap((drawn, i) => (drawn.glows.length === 1 ? [i + 1] : []));
      expect(litTicks).toEqual(Array.from({ length: run.end - 1 }, (_, i) => i + 1));
      expect(new Set(run.shown.flatMap((drawn) => drawn.heats))).toEqual(new Set([0.25]));
    }
    expect(withPoison.end).toBe(alone.end);
    // The same fire; only the poison's green cast (src/render/ailmentFx.test.ts) tells them apart.
    const fire = (drawn: Drawn): Omit<Drawn, 'tints'> => ({
      glows: drawn.glows,
      heats: drawn.heats,
    });
    expect(withPoison.shown.map(fire)).toEqual(alone.shown.map(fire));
  });

  it('draws a stale burnStacks of 0 at the heat of the live records, as the same enemy counted right', () => {
    const quirk = frame([enemy([300, 400], 0)], 100);
    expect(quirk).toEqual(frame([enemy([300, 400], 2)], 100));
    expect(quirk.heats).toEqual(Array(FLAME_RATE + FLAME_RATE_PER_STACK).fill(0.5));
  });

  it('draws burn alone as before: n live records at heat min(n, 4) / 4, 11 + 3 (min(n, 4) − 1) flames a second', () => {
    for (let n = 1; n <= 6; n++) {
      const drawn = frame([enemy(Array(n).fill(1000), n)], 100);
      const heat = Math.min(n, BURN_VISUAL_STACKS) / BURN_VISUAL_STACKS;
      const rate = FLAME_RATE + FLAME_RATE_PER_STACK * (Math.min(n, BURN_VISUAL_STACKS) - 1);
      expect(drawn.heats, `${n} stacks`).toEqual(Array(rate).fill(heat));
      // The glow's size by the same heat, at the layer's clock of 1 s.
      const flutter = 0.5 + 0.5 * Math.sin(37 + 3 * 0.9);
      const size = (12 * (3.4 + 1.6 * heat) * (0.9 + 0.15 * flutter)) / GLOW_SIZE;
      expect(drawn.glows.length, `${n} stacks`).toBe(1);
      expect(drawn.glows[0]?.[2], `${n} stacks`).toBeCloseTo(size, 12);
    }
  });

  it('draws no fire without a live burn: none held, every record ended, the rings’ stacks past burnRingEnd', () => {
    const none = frame([enemy([], 0)], 100);
    expect(none.glows).toEqual([]);
    expect(none.heats).toEqual([]);
    expect(none.tints).toContain(DATA.enemies.triangle.color);
    // Ended records before the ailments step expires them, and ring stacks counted until their
    // last step: burnStacks still counts both.
    for (const stale of [enemy([90, 100], 2), enemy([], 3, 100)]) {
      expect(frame([stale], 100)).toEqual(none);
    }
    expect(lit(frame([enemy([], 3, 100)], 99))).toBe(true);
  });

  it('ends the flame on the tick the burn ends: a record’s end, a fractional end, the later of two, the rings’ end', () => {
    const litAt = (burning: Burning, ticks: readonly number[]): boolean[] =>
      ticks.map((tick) => lit(frame([burning], tick)));
    expect(litAt(enemy([120], 1), [118, 119, 120, 121])).toEqual([true, true, false, false]);
    expect(litAt(enemy([120.5], 1), [119, 120, 121])).toEqual([true, true, false]);
    expect(litAt(enemy([], 3, 120), [118, 119, 120, 121])).toEqual([true, true, false, false]);
    const two = enemy([100, 130], 2);
    expect([99, 100, 129, 130].map((tick) => frame([two], tick).heats[0])).toEqual([
      0.5,
      0.25,
      0.25,
      undefined,
    ]);
  });

  it('draws eternalFlame’s rings by their stacks while burnRingEnd is ahead of the tick', () => {
    expect(frame([enemy([], 3, 200)], 100).heats).toEqual(
      Array(FLAME_RATE + 2 * FLAME_RATE_PER_STACK).fill(0.75),
    );
    expect(frame([enemy([], 7, 200)], 100).heats).toEqual(
      Array(FLAME_RATE + 3 * FLAME_RATE_PER_STACK).fill(1),
    );
    expect(frame([enemy([], 3, 200)], 100)).toEqual(frame([enemy([200, 200, 200], 3)], 100));
  });

  it('reads the tick it is handed, not the frame clock: 5 s of frames on one tick keep the flame, the end tick puts it out at once', () => {
    const burning = [enemy([120], 1)];
    const layer = new EnemyLayer(DATA, Texture.WHITE, () => 0);
    const glows: number[] = [];
    for (let f = 0; f < 5 * TICK_RATE; f++) {
      glows.push(frame(burning, 119, 1000 / TICK_RATE, layer).glows.length);
    }
    expect(glows).toEqual(Array(5 * TICK_RATE).fill(1));
    expect(frame(burning, 120, 0, layer).glows).toEqual([]);
    expect(frame(burning, 119, 0, layer).glows.length).toBe(1);
    // A new layer on its first frame: its clock near 0, the tick past the end.
    expect(frame(burning, 120, 1000 / TICK_RATE).glows).toEqual([]);
  });

  it('is handed the state’s tick by the renderer', () => {
    const source = readFileSync(fileURLToPath(new URL('./renderer.ts', import.meta.url)), 'utf8');
    expect(source.match(/this\.enemies\.update\([^)]*\)/g)).toEqual([
      'this.enemies.update(state.enemies, state.tick, alpha, dt, this.bursts)',
    ]);
  });
});
