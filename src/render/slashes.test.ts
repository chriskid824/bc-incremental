import { Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { SLASH_CAP, SLASH_MS, SlashLayer, slashAlpha, slashReach } from './slashes';

describe('slash lines (gd §4.6: 斬擊線; 火暴「爆斬」)', () => {
  it('snaps out along its line, then fades by SLASH_MS', () => {
    expect(slashReach(0)).toBe(0);
    expect(slashReach(30)).toBeGreaterThan(0.5);
    expect(slashReach(60)).toBe(1);
    expect(slashAlpha(30)).toBe(1);
    expect(slashAlpha(SLASH_MS / 2)).toBeLessThan(1);
    expect(slashAlpha(SLASH_MS)).toBe(0);
  });

  it('draws three streaks a slash, the blade’s head at the tip of the cut along its line', () => {
    const layer = new SlashLayer(Texture.WHITE);
    layer.add(100, 100, 400, 100, 24);
    // Its first frame ages it at most one 60 Hz frame (timing.ts): it is out by the second.
    layer.update(16);
    layer.update(84);
    const children = layer.view.particleChildren;
    expect(children).toHaveLength(3);
    for (const sprite of children) {
      expect([sprite.x, sprite.y, sprite.rotation]).toEqual([400, 100, 0]);
    }
    layer.update(SLASH_MS);
    expect(layer.view.particleChildren).toHaveLength(0);
    expect(layer.size).toBe(0);
  });

  it('keeps at most SLASH_CAP slashes, the newest replacing the oldest', () => {
    const layer = new SlashLayer(Texture.WHITE);
    for (let i = 0; i < SLASH_CAP + 4; i++) layer.add(0, i, 300, i, 24);
    expect(layer.size).toBe(SLASH_CAP);
    layer.update(16);
    const ys = new Set(layer.view.particleChildren.map((sprite) => sprite.y));
    expect(ys.has(SLASH_CAP + 3)).toBe(true);
    expect(ys.has(0)).toBe(false);
    layer.clear();
    expect(layer.size).toBe(0);
  });
});
