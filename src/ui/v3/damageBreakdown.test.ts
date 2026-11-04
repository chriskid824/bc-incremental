import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import type { DamageBreakdown } from '../../sim/types';
import type { TextLookup } from '../web/text';
import { damageBreakdown, sourceLabel } from './damageBreakdown';

/** Echoes each key with its values, so the test reads which text a row asked for. */
const ECHO: TextLookup = {
  has: () => true,
  get: (key, values) => (values === undefined ? key : `${key}${JSON.stringify(values)}`),
  keys: () => [],
};

const kinds = (parts: Partial<Record<keyof DamageBreakdown, number>>): DamageBreakdown => ({
  hit: num(parts.hit ?? 0),
  crit: num(parts.crit ?? 0),
  burn: num(parts.burn ?? 0),
  chain: num(parts.chain ?? 0),
  poison: num(parts.poison ?? 0),
  bleed: num(parts.bleed ?? 0),
});

describe('damageBreakdown', () => {
  it('sorts sources largest first with their shares, leaving zero rows out', () => {
    const view = damageBreakdown(
      { center: num(600), 'outer.poison': num(300), 'fusion.fire.ice': num(100), hub: num(0) },
      kinds({ hit: 500, burn: 400, poison: 100 }),
      'Magma Core',
      ECHO,
    );
    expect(toNumber(view.total)).toBe(1000);
    expect(view.sources.map((r) => [r.id, r.share])).toEqual([
      ['center', 0.6],
      ['outer.poison', 0.3],
      ['fusion.fire.ice', 0.1],
    ]);
    expect(view.kinds.map((r) => [r.id, r.share])).toEqual([
      ['hit', 0.5],
      ['burn', 0.4],
      ['poison', 0.1],
    ]);
    expect(view.kinds.map((r) => r.label)).toEqual([
      'web.tag.hit',
      'web.tag.burn',
      'web.tag.poison',
    ]);
  });

  it('is empty for a run without damage', () => {
    const view = damageBreakdown({ center: num(0) }, kinds({}), 'Magma Core', ECHO);
    expect(view.sources).toEqual([]);
    expect(view.kinds).toEqual([]);
  });
});

describe('sourceLabel', () => {
  it('names every source class', () => {
    expect(sourceLabel('center', 'Magma Core', ECHO)).toBe('v3.damage.center{"name":"Magma Core"}');
    expect(sourceLabel('hub', 'Magma Core', ECHO)).toBe('web.scope.hub');
    expect(sourceLabel('asc', 'Magma Core', ECHO)).toBe('web.scope.asc');
    expect(sourceLabel('outer.poison', 'Magma Core', ECHO)).toBe(
      'v3.damage.outer{"name":"web.outer.poison.name"}',
    );
    expect(sourceLabel('fusion.fire.ice', 'Magma Core', ECHO)).toContain('web.coreName');
  });

  it('names sources in the shipped text', () => {
    expect(sourceLabel('outer.poison', 'Magma Core')).toBe('Poison board');
    expect(sourceLabel('fusion.fire.ice', 'Magma Core')).toContain('Frostflame');
  });
});
