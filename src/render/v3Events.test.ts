/**
 * The renderer's v3 events (docs/v3 C7 design §2.9): a hit the defences took whole (hitBlocked)
 * draws a dull flash and steel sparks glancing back towards the player, a ward's break pops a
 * ring, a shell 洋蔥 sheds draws one out to its radius. Bursts is built as random.test.ts builds
 * it; the Renderer needs a canvas, so its routing of the events is read from its source.
 */

import { readFileSync } from 'node:fs';
import { Texture } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { FX_SPARK, FxParticles } from './fx';
import type { FxParticle } from './fx';
import { COLORS } from './palette';
import { RingLayer } from './rings';

interface BurstsModule {
  readonly Bursts: new (
    fx: FxParticles,
    under: FxParticles,
    textures: Readonly<Record<string, Texture>>,
    rings: RingLayer,
  ) => { blocked(x: number, y: number, dirX: number, dirY: number): void };
}

// A computed path: bursts.ts reads fxTextures.ts' types, which need the DOM the tools' tsconfig
// (the tests') leaves out, as random.test.ts loads it.
const BURSTS = './bursts';
const { Bursts } = (await import(/* @vite-ignore */ BURSTS)) as BurstsModule;

const tex = Texture.WHITE;
const TEXTURES = { glow: tex, star: tex, streak: tex, shard: tex, flame: tex };

/** Comments blanked out, so only code is read. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');

describe('the renderer’s v3 events (§2.9)', () => {
  it('draws a blocked hit as a dull flash and steel sparks glancing back along its direction', () => {
    const fx = new FxParticles({ glow: tex });
    const spawned: FxParticle[] = [];
    const spawn = fx.spawn.bind(fx);
    vi.spyOn(fx, 'spawn').mockImplementation((...args) => {
      const p = spawn(...args);
      if (p !== null) spawned.push(p);
      return p;
    });
    const bursts = new Bursts(fx, new FxParticles({ glow: tex }), TEXTURES, new RingLayer());
    // The player is to the left of the enemy: the sparks fly left.
    bursts.blocked(1200, 540, -240, 0);
    expect(spawned.length).toBeGreaterThan(1);
    expect(spawned.every((p) => p.group === FX_SPARK)).toBe(true);
    expect(spawned.every((p) => p.color1 === COLORS.blocked)).toBe(true);
    expect(spawned.map((p) => [p.sprite.x, p.sprite.y])).toEqual(spawned.map(() => [1200, 540]));
    const [glow, ...sparks] = spawned;
    expect([glow?.vx, glow?.vy]).toEqual([0, 0]);
    for (const spark of sparks) {
      expect(spark.vx).toBeLessThan(0);
      expect(Math.abs(Math.atan2(spark.vy, -spark.vx))).toBeLessThanOrEqual(0.9);
    }
  });

  it('routes hitBlocked, wardBroken and onionLayer to their effects', () => {
    const source = code(readFileSync(new URL('renderer.ts', import.meta.url), 'utf8'));
    expect(source).toMatch(
      /case 'hitBlocked':\s*this\.bursts\.blocked\(event\.x, event\.y, CENTER_X - event\.x, CENTER_Y - event\.y\);/,
    );
    expect(source).toMatch(/case 'wardBroken':\s*this\.onWardBroken\(event\.targetId\);/);
    expect(source).toMatch(
      /case 'onionLayer':\s*this\.onShellBroken\(event\.enemyId, event\.x, event\.y\);/,
    );
    const ward = /private onWardBroken\([^)]*\): void \{([\s\S]*?)\n {2}\}/.exec(source)?.[1];
    expect(ward).toMatch(/this\.enemies\.positionOf\(enemyId\)/);
    expect(ward).toMatch(
      /this\.rings\.shock\(\s*spot\.x,\s*spot\.y,\s*spot\.radius \* WARD_BREAK_SCALE/,
    );
    const shell = /private onShellBroken\([^)]*\): void \{([\s\S]*?)\n {2}\}/.exec(source)?.[1];
    expect(shell).toMatch(
      /this\.rings\.shock\(x, y, spot\.radius, [\w.]+, SHELL_BREAK_WIDTH, SHELL_BREAK_MS, true\)/,
    );
  });

  it('sparks on hitBlocked alone: a hit that lands, M1’s included, draws no blocked burst', () => {
    const source = code(readFileSync(new URL('renderer.ts', import.meta.url), 'utf8'));
    expect(source.match(/\.blocked\(/g)).toHaveLength(1);
  });
});
