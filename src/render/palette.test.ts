import { describe, expect, it } from 'vitest';
import { CONSTRUCT_COLORS } from './palette';

/** OKLCH hue in degrees of a 0xRRGGBB sRGB color (Björn Ottosson's OKLab). */
function oklchHue(color: number): number {
  const linear = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = linear((color >> 16) & 0xff);
  const g = linear((color >> 8) & 0xff);
  const b = linear(color & 0xff);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return hue < 0 ? hue + 360 : hue;
}

describe('CONSTRUCT_COLORS', () => {
  it('uses the character colors of game-design-v3 §11.6 at their listed OKLCH hues', () => {
    const expected = { magmaCore: 46, hive: 134, frostCrystal: 221, teslaTower: 298 };
    for (const [id, hue] of Object.entries(expected)) {
      const main = CONSTRUCT_COLORS[id as keyof typeof expected].main;
      expect(Math.abs(oklchHue(main) - hue)).toBeLessThan(1.5);
    }
  });

  it('keeps the four main hues at least 70° apart (§11.6)', () => {
    const hues = Object.values(CONSTRUCT_COLORS).map((c) => oklchHue(c.main));
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const d = Math.abs((hues[i] ?? 0) - (hues[j] ?? 0));
        expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(70);
      }
    }
  });
});
