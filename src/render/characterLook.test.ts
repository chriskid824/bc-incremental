import { describe, expect, it } from 'vitest';
import { FIRE } from '../data/characters/fire';
import { fusionSkin, hitNumberColor } from './characterLook';
import type { CharacterLook } from './characterLook';
import { CONSTRUCT_COLORS, mixColor } from './palette';

const look: CharacterLook = {
  construct: FIRE.construct,
  arena: FIRE.arena,
  color: FIRE.color,
  fusions: [{ outer: 'poison', skin: { accent: 0x3fd08a, shape: 'bubble' } }],
};

describe('a character run’s looks', () => {
  it('finds the skin of an owned fusion core only', () => {
    expect(fusionSkin(look, 'poison')).toEqual({ accent: 0x3fd08a, shape: 'bubble' });
    expect(fusionSkin(look, 'crit')).toBeNull();
  });

  it('colours hit numbers in the character colour, lifted for the dark arena (gd §11.6)', () => {
    expect(FIRE.color).toBe(CONSTRUCT_COLORS.magmaCore.main);
    expect(hitNumberColor(look)).toBe(mixColor(0xff7a2f, 0xffffff, 0.25));
  });
});
