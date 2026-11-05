import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArcLayer } from './arcs';

/** Stroke widths drawn by the layer's last update, in draw order. */
function strokeWidths(arcs: ArcLayer): number[] {
  const widths: number[] = [];
  for (const instruction of arcs.view.context.instructions) {
    if (instruction.action === 'stroke') widths.push(instruction.data.style.width);
  }
  return widths;
}

describe('ArcLayer', () => {
  it('caps live bolts, replacing the oldest', () => {
    const arcs = new ArcLayer();
    for (let i = 0; i < 200; i++) arcs.add(0, 0, 200, 0, 1);
    arcs.update(16);
    // Four strokes per bolt, four more for a fork: 80 bolts at most.
    const strokes = strokeWidths(arcs).length;
    expect(strokes).toBeGreaterThanOrEqual(80 * 4);
    expect(strokes).toBeLessThanOrEqual(80 * 8);
  });

  it('keeps a new bolt on screen through a slow first frame, then lets it fade out', () => {
    const arcs = new ArcLayer();
    arcs.add(0, 0, 40, 0, 1);
    arcs.update(500);
    expect(strokeWidths(arcs)).toHaveLength(4);
    arcs.update(500);
    expect(strokeWidths(arcs)).toHaveLength(0);
  });

  it('draws later chain jumps thinner', () => {
    const widest = (chainIndex: number): number => {
      const arcs = new ArcLayer();
      // Short bolts never fork, so the strokes are exactly the bolt's four layers.
      arcs.add(0, 0, 40, 0, chainIndex);
      arcs.update(16);
      return Math.max(...strokeWidths(arcs));
    };
    expect(widest(2)).toBeLessThan(widest(1));
    expect(widest(4)).toBeLessThan(widest(2));
    expect(widest(50)).toBeGreaterThan(0);
  });
});

/** Comments blanked out, so only code is read. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');

describe('the renderer’s hit arcs', () => {
  // The Renderer needs a canvas, so its routing of a hit is read from its source.
  const source = code(readFileSync(new URL('renderer.ts', import.meta.url), 'utf8'));

  it('draws a bolt for every hit that comes from a point, a jump’s or a chainBolt’s arc’d first hit, as wide as a first jump’s (E7)', () => {
    // Planted bug: the arc kept to the jumps (chainIndex > 0), so an arc'd first hit draws none.
    expect(source).toMatch(
      /if \(event\.fromX !== null && event\.fromY !== null\) \{\s*this\.arcs\.add\(event\.fromX, event\.fromY, x, y, Math\.max\(1, event\.chainIndex\)\);\s*this\.bursts\.chain\(x, y\);\s*\} else if \(!crit\) \{/,
    );
  });
});
