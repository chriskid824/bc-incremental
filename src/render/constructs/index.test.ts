import type { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { CHARACTERS } from '../../data/characters';
import { COLORS, CONSTRUCT_COLORS } from '../palette';
import { CONSTRUCT_IDS, MAX_PART_OFFSET, createConstructView } from '.';

/** Farthest any construct's resting silhouette (halo included) reaches from its center. */
const REST_REACH = 60;

function reach(view: Container): number {
  const b = view.getLocalBounds();
  return Math.max(-b.minX, b.maxX, -b.minY, b.maxY);
}

describe.each(CONSTRUCT_IDS)('%s view', (id) => {
  it('idles, attacks in every direction and resets without leaving its bounds', () => {
    const construct = createConstructView(id);
    for (let t = 0; t < 4000; t += 16) construct.update(16);
    expect(reach(construct.view)).toBeLessThanOrEqual(REST_REACH);
    for (let k = 0; k < 16; k++) {
      construct.attack((k / 16) * 2 * Math.PI);
      for (let t = 0; t < 400; t += 16) {
        construct.update(16);
        // Parts move at most MAX_PART_OFFSET; effects may reach a little past them.
        expect(reach(construct.view)).toBeLessThanOrEqual(REST_REACH + MAX_PART_OFFSET + 10);
      }
    }
    construct.reset();
    for (let t = 0; t < 2000; t += 16) construct.update(16);
    expect(reach(construct.view)).toBeLessThanOrEqual(REST_REACH);
  });

  it('keeps the red hit flash', () => {
    const construct = createConstructView(id);
    const body = construct.view.children[0] as Container;
    construct.hit();
    construct.update(0);
    expect(body.tint).toBe(COLORS.playerHit);
    construct.update(400);
    expect(body.tint).toBe(0xffffff);
  });

  it('leaves position and scale of its view to the caller', () => {
    const construct = createConstructView(id);
    construct.view.position.set(960, 540);
    construct.view.scale.set(3);
    construct.attack(1);
    construct.hit();
    construct.update(50);
    expect(construct.view.position.x).toBe(960);
    expect(construct.view.scale.x).toBe(3);
  });
});

describe('character colours', () => {
  it.each(Object.values(CHARACTERS))("$id's colour is its construct's main colour", (def) => {
    expect(def.color).toBe(CONSTRUCT_COLORS[def.construct].main);
  });
});
