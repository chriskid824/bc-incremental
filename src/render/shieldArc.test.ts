/**
 * The player's shield arc (docs/v3 C7 design §2.9): read from PlayerState.shield, nothing at 0,
 * an arc centered on the top whose sweep is the shield's share of max life, the full ring at
 * SHIELD_FULL_SHARE, brighter for SHIELD_FLASH_MS after a shieldAbsorbed; and made for v3 data
 * only, so an M1 frame has no arc.
 */

import { readFileSync } from 'node:fs';
import type { Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { characterGameData, loadGameData } from '../data';
import {
  PlayerShield,
  SHIELD_ALPHA,
  SHIELD_FLASH_MS,
  SHIELD_FULL_SHARE,
  SHIELD_RADIUS,
} from './shieldArc';

const PLAYER = { x: 960, y: 540, life: 100, maxLife: 100, shield: 0 };
const TOP = -Math.PI / 2;

/** The path actions of a Graphics' strokes, with their numbers (the transform left out). */
function paths(g: Graphics): unknown[][] {
  return g.context.instructions.flatMap((instruction) => {
    const data = instruction.data as unknown as {
      path: { instructions: { action: string; data: unknown[] }[] };
    };
    return data.path.instructions.map((op) => [
      op.action,
      ...op.data.filter((value) => typeof value === 'number'),
    ]);
  });
}

describe('PlayerShield', () => {
  it('draws nothing while the shield is 0', () => {
    const shield = new PlayerShield();
    shield.update(PLAYER, 16);
    expect(paths(shield.view)).toEqual([]);
  });

  it('sweeps the shield’s share of max life round the top, the full ring at SHIELD_FULL_SHARE', () => {
    const shield = new PlayerShield();
    // Half the full share: half a turn, a quarter each side of the top.
    shield.update({ ...PLAYER, shield: 50 * SHIELD_FULL_SHARE }, 16);
    const [[action, x, y, radius, start, end]] = paths(shield.view) as [unknown[]];
    expect([action, x, y, radius]).toEqual(['arc', 0, 0, SHIELD_RADIUS]);
    expect(start).toBeCloseTo(TOP - Math.PI / 2, 12);
    expect(end).toBeCloseTo(TOP + Math.PI / 2, 12);
    expect([shield.view.x, shield.view.y]).toEqual([960, 540]);
    // At or past the full share: the whole ring.
    for (const amount of [100 * SHIELD_FULL_SHARE, 100]) {
      shield.update({ ...PLAYER, shield: amount }, 16);
      expect(paths(shield.view)).toEqual([['circle', 0, 0, SHIELD_RADIUS]]);
    }
    shield.update(PLAYER, 16);
    expect(paths(shield.view)).toEqual([]);
  });

  it('brightens when the shield takes a hit, back to rest SHIELD_FLASH_MS later', () => {
    const shield = new PlayerShield();
    const held = { ...PLAYER, shield: 10 };
    shield.update(held, 16);
    expect(shield.view.alpha).toBe(SHIELD_ALPHA);
    shield.absorb();
    shield.update(held, 0);
    expect(shield.view.alpha).toBe(1);
    shield.update(held, SHIELD_FLASH_MS / 2);
    expect(shield.view.alpha).toBeCloseTo((SHIELD_ALPHA + 1) / 2, 12);
    shield.update(held, SHIELD_FLASH_MS / 2);
    expect(shield.view.alpha).toBe(SHIELD_ALPHA);
    shield.absorb();
    shield.reset();
    expect(paths(shield.view)).toEqual([]);
    shield.update(PLAYER, 0);
    expect(shield.view.alpha).toBe(SHIELD_ALPHA);
  });

  it('is made on v3 data only, as the bullets are: an M1 frame has neither', () => {
    expect(loadGameData().waves.v3).toBeUndefined();
    expect(characterGameData().waves.v3).toBeDefined();
    const source = readFileSync(new URL('renderer.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/const v3 = data\.waves\.v3 !== undefined;/);
    expect(source).toMatch(/this\.bullets = v3 \? new BulletLayer\(textures\) : null;/);
    expect(source).toMatch(/this\.playerShield = v3 \? new PlayerShield\(\) : null;/);
  });
});
