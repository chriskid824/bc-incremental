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
