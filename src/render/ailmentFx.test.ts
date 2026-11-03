/**
 * Poison, chill and freeze on screen (render only; the playtest of 熔核 found them unreadable):
 * poison and bleed ticks (dotTick) show as their own tallied numbers, poisoned enemies take a
 * green cast, chilled ones lean icy blue with the meter, frozen ones turn pale ice-blue, and a
 * freeze and a shatter draw an ice burst. The Renderer needs a canvas, so its routing of the
 * events is read from its source, as v3Events.test.ts does.
 */

import { readFileSync } from 'node:fs';
import { Texture } from 'pixi.js';
import type { BitmapText, Container } from 'pixi.js';
import type * as PixiModule from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { num } from '../core/num';
import type { GameData } from '../data/types';
import type { EnemyState } from '../sim';
import type { Enemy } from '../sim/systems/context';
import { makeTestData } from '../sim/testing';
import { DamageNumbers } from './damageNumbers';
import { FX_DEBRIS, FxParticles } from './fx';
import type { FxParticle } from './fx';
import { COLORS } from './palette';
import { RingLayer } from './rings';

vi.mock('pixi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof PixiModule>()),
  // No canvas in node to draw the fonts on.
  BitmapFont: { install: () => undefined },
}));

interface Flames {
  flame(x: number, y: number, radius: number, heat: number): void;
}
interface Layer {
  readonly view: Container;
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
interface BurstsModule {
  readonly Bursts: new (
    fx: FxParticles,
    under: FxParticles,
    textures: Readonly<Record<string, Texture>>,
    rings: RingLayer,
  ) => {
    freeze(x: number, y: number, radius: number): void;
    shatter(x: number, y: number, radius: number): void;
  };
}

// Computed paths: enemies.ts and bursts.ts reach fxTextures.ts and the DOM that the tools'
// tsconfig (the tests') leaves out, as random.test.ts loads them.
const ENEMIES = './enemies';
const BURSTS = './bursts';
const { EnemyLayer } = (await import(/* @vite-ignore */ ENEMIES)) as EnemiesModule;
const { Bursts } = (await import(/* @vite-ignore */ BURSTS)) as BurstsModule;

const DATA = makeTestData();
const tex = Texture.WHITE;
const TEXTURES = { glow: tex, star: tex, streak: tex, shard: tex, flame: tex };

/** Comments blanked out, so only code is read. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');

type Ailing = EnemyState &
  Pick<
    Enemy,
    'burns' | 'burnRingEnd' | 'poisonStacks' | 'poisonRingEnd' | 'frost' | 'frozenUntil' | 'boss'
  >;

/** A triangle at (500, 400) holding the given ailments at tick 100. */
function enemy(ailments: Partial<Ailing> = {}): Ailing {
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
    burnStacks: 0,
    alive: true,
    v3: null,
    burns: [],
    burnRingEnd: 0,
    poisonStacks: 0,
    poisonRingEnd: 0,
    frost: 0,
    frozenUntil: 0,
    boss: false,
    ...ailments,
  };
}

/** Every node's tint under `view`, depth first. */
const tints = (view: Container): number[] => [
  view.tint,
  ...view.children.flatMap((child) => tints(child)),
];

/** The body's tint of `subject` drawn alone at tick 100: the one tint a bare enemy lacks. */
function bodyTint(subject: Ailing): number {
  const draw = (e: Ailing): number[] => {
    const layer = new EnemyLayer(DATA, tex, () => 0);
    layer.update([e], 100, 1, 1000, { flame: () => undefined });
    return tints(layer.view);
  };
  const bare = draw(enemy());
  const drawn = draw(subject);
  const base = DATA.enemies.triangle.color;
  if (drawn.every((t, i) => t === bare[i])) return base;
  const changed = drawn.filter((t, i) => t !== bare[i]);
  expect(changed).toHaveLength(1);
  return changed[0] as number;
}

const channels = (c: number): [number, number, number] => [
  (c >> 16) & 0xff,
  (c >> 8) & 0xff,
  c & 0xff,
];
/** Distance in RGB from `a` to `b`. */
const distance = (a: number, b: number): number => {
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
};

describe('poison and bleed numbers', () => {
  const shown = (numbers: DamageNumbers): BitmapText[] =>
    (numbers.view.children[0] as Container).children.filter((t) => t.visible) as BitmapText[];

  it('shows poison ticks in the poison green and bleed ticks in the bleed red', () => {
    const numbers = new DamageNumbers(() => 0.5);
    expect(numbers.spawn('poison', num(12), 400, 400, 1)).toBe('shown');
    expect(numbers.spawn('bleed', num(7), 900, 400, 2)).toBe('shown');
    expect(shown(numbers).map((t) => [t.text, t.tint])).toEqual([
      ['12', COLORS.damagePoison],
      ['7', COLORS.damageBleed],
    ]);
    // A character's hit colour leaves them alone.
    numbers.setHitColor(0x123456);
    numbers.spawn('poison', num(3), 400, 800, 3);
    expect(shown(numbers).at(-1)?.tint).toBe(COLORS.damagePoison);
  });

  it('merges a young poison number on the same enemy, apart from its burn number', () => {
    const numbers = new DamageNumbers(() => 0.5);
    numbers.spawn('poison', num(10), 400, 400, 1);
    expect(numbers.spawn('poison', num(5), 400, 400, 1)).toBe('merged');
    expect(numbers.spawn('burn', num(4), 400, 400, 1)).not.toBe('merged');
    expect(shown(numbers)[0]?.text).toBe('15');
  });

  it('caps poison numbers on their own, so a poisoned crowd leaves room for hits', () => {
    const numbers = new DamageNumbers(() => 0.5);
    const results: string[] = [];
    for (let i = 0; i < 40; i++) {
      const x = 150 + (i % 8) * 220;
      const y = 150 + Math.floor(i / 8) * 180;
      results.push(numbers.spawn('poison', num(10), x, y, i));
    }
    expect(results.filter((r) => r === 'shown')).toHaveLength(24);
    expect(numbers.spawn('hit', num(10), 960, 1040, 99)).toBe('shown');
  });
});

describe('the ailment casts on enemies', () => {
  const base = DATA.enemies.triangle.color;

  it('draws an enemy with no ailment in its own colour', () => {
    expect(bodyTint(enemy())).toBe(base);
    // Ended poison and a stale frozenUntil draw nothing.
    expect(bodyTint(enemy({ poisonStacks: 3, poisonRingEnd: 100, frozenUntil: 100 }))).toBe(base);
  });

  it('leans a poisoned enemy toward the poison green, more with more stacks', () => {
    const one = bodyTint(enemy({ poisonStacks: 1, poisonRingEnd: 200 }));
    const six = bodyTint(enemy({ poisonStacks: 6, poisonRingEnd: 200 }));
    expect(distance(one, COLORS.poison)).toBeLessThan(distance(base, COLORS.poison));
    expect(distance(six, COLORS.poison)).toBeLessThan(distance(one, COLORS.poison));
    // A cast, not a repaint: the enemy's own colour still leads.
    expect(distance(six, base)).toBeLessThan(distance(six, COLORS.poison));
  });

  it('shows burn plus poison as neither alone', () => {
    const burns = [{ dps: num(1), start: 0, end: 200, depth: 0, source: 0, cls: 0 }];
    const fire = bodyTint(enemy({ burns, burnStacks: 1 }));
    const poison = bodyTint(enemy({ poisonStacks: 3, poisonRingEnd: 200 }));
    const both = bodyTint(enemy({ burns, burnStacks: 1, poisonStacks: 3, poisonRingEnd: 200 }));
    expect(new Set([fire, poison, both]).size).toBe(3);
    expect(distance(both, COLORS.poison)).toBeLessThan(distance(fire, COLORS.poison));
    expect(distance(both, COLORS.burn)).toBeLessThan(distance(poison, COLORS.burn));
  });

  it('leans a chilled enemy toward icy blue with its meter, and turns a frozen one pale ice', () => {
    const steps = [0.25, 0.5, 1].map((frost) => distance(bodyTint(enemy({ frost })), COLORS.chill));
    expect(steps[0]).toBeLessThan(distance(base, COLORS.chill));
    expect(steps[1]).toBeLessThan(steps[0] as number);
    expect(steps[2]).toBeLessThan(steps[1] as number);
    const frozen = bodyTint(enemy({ frozenUntil: 200 }));
    // Frozen reads closer to the ice than to the enemy, and paler than a full meter.
    expect(distance(frozen, COLORS.frozen)).toBeLessThan(distance(frozen, base));
    const full = bodyTint(enemy({ frost: 1 }));
    expect(channels(frozen).reduce((a, b) => a + b)).toBeGreaterThan(
      channels(full).reduce((a, b) => a + b),
    );
    // Frost goes over the other casts: a frozen poisoned enemy still reads as ice.
    const frozenPoisoned = bodyTint(
      enemy({ frozenUntil: 200, poisonStacks: 6, poisonRingEnd: 200 }),
    );
    expect(distance(frozenPoisoned, COLORS.frozen)).toBeLessThan(distance(frozenPoisoned, base));
  });
});

describe('the freeze and shatter bursts', () => {
  function spawnedBy(draw: (bursts: InstanceType<BurstsModule['Bursts']>) => void): FxParticle[] {
    const fx = new FxParticles({ glow: tex });
    const spawned: FxParticle[] = [];
    const spawn = fx.spawn.bind(fx);
    vi.spyOn(fx, 'spawn').mockImplementation((...args) => {
      const p = spawn(...args);
      if (p !== null) spawned.push(p);
      return p;
    });
    const rings = new RingLayer();
    const shock = vi.spyOn(rings, 'shock');
    draw(new Bursts(fx, new FxParticles({ glow: tex }), TEXTURES, rings));
    expect(shock).toHaveBeenCalledTimes(1);
    expect(shock.mock.calls[0]?.[3]).toBe(COLORS.frozen);
    return spawned;
  }

  it('draws a freeze as an ice flash, a frost ring and glints in the chill blue', () => {
    const spawned = spawnedBy((b) => b.freeze(300, 200, 12));
    expect(spawned.length).toBeGreaterThan(1);
    expect(spawned.every((p) => p.color1 === COLORS.chill)).toBe(true);
  });

  it('draws a shatter as an ice flash, a ring and ice shards flying out', () => {
    const spawned = spawnedBy((b) => b.shatter(300, 200, 90));
    const shards = spawned.filter((p) => p.group === FX_DEBRIS);
    expect(shards.length).toBeGreaterThanOrEqual(8);
    expect(spawned.every((p) => p.color1 === COLORS.chill)).toBe(true);
  });
});

describe('the renderer’s ailment events', () => {
  const source = code(readFileSync(new URL('renderer.ts', import.meta.url), 'utf8'));

  it('tallies dotTick by ailment and shows poison and bleed numbers', () => {
    expect(source).toMatch(
      /case 'dotTick':\s*\(event\.ailment === 'poison' \? this\.poisonTally : this\.bleedTally\)\.add\(/,
    );
    expect(source).toMatch(/this\.numbers\.spawn\('poison', amount, x, y, enemyId\)/);
    expect(source).toMatch(/this\.numbers\.spawn\('bleed', amount, x, y, enemyId\)/);
    for (const tally of ['poisonTally', 'bleedTally']) {
      // Updated each frame, flushed on a kill, cleared on a new run.
      expect(source).toMatch(new RegExp(`this\\.${tally}\\.update\\(dt, this\\.show\\w+\\);`));
      expect(source).toMatch(
        new RegExp(`this\\.${tally}\\.flush\\(event\\.enemyId, this\\.show\\w+\\);`),
      );
      expect(source).toMatch(new RegExp(`this\\.${tally}\\.clear\\(\\);`));
    }
  });

  it('routes freeze (not a boss’s emptied meter) and shatter to the ice bursts', () => {
    expect(source).toMatch(
      /case 'freeze':\s*if \(!event\.boss\) this\.onFrozen\(event\.targetId\);/,
    );
    expect(source).toMatch(
      /case 'shatter':\s*this\.bursts\.shatter\(event\.x, event\.y, event\.radius\);/,
    );
    const frozen = /private onFrozen\([^)]*\): void \{([\s\S]*?)\n {2}\}/.exec(source)?.[1];
    expect(frozen).toMatch(/this\.enemies\.positionOf\(enemyId\)/);
    expect(frozen).toMatch(/this\.bursts\.freeze\(spot\.x, spot\.y, spot\.radius\)/);
  });
});
