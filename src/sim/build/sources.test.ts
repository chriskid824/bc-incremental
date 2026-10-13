import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, OUTER_IDS } from '../../data/sources';
import type { SourceSelector } from '../../data/sources';
import { AILMENT_KINDS } from '../../data/triggers';
import {
  ailmentCredit,
  CENTER,
  createAttribution,
  createSourceTable,
  M1_CENTER_AILMENTS,
  MAX_SOURCES,
  rowKey,
  SOURCE_CLASS_ORDINAL,
  SOURCE_SHIFT,
} from './sources';

describe('SourceTable', () => {
  it('starts with the center at index 0', () => {
    const sources = createSourceTable();
    expect(sources.names).toEqual(['center']);
    expect(CENTER).toBe(0);
    expect(sources.index('center')).toBe(CENTER);
    expect(sources.cls[CENTER]).toBe(SOURCE_CLASS_ORDINAL.center);
  });

  it('numbers sources in first-use order with their class, once each', () => {
    const sources = createSourceTable();
    expect(sources.index('outer.poison')).toBe(1);
    expect(sources.index('fusion.fire.poison')).toBe(2);
    expect(sources.index('outer.poison')).toBe(1);
    expect(sources.index('hub')).toBe(3);
    expect(sources.index('asc')).toBe(4);
    expect(sources.names).toEqual(['center', 'outer.poison', 'fusion.fire.poison', 'hub', 'asc']);
    expect([...sources.cls.slice(0, 5)]).toEqual(
      (['center', 'outer', 'fusion', 'hub', 'asc'] as const).map((c) => SOURCE_CLASS_ORDINAL[c]),
    );
  });

  it('rejects ids that are not source ids', () => {
    const sources = createSourceTable();
    for (const bad of ['outer', 'outer.water', 'fusion.fire', 'fire.asc.x.y', '']) {
      expect(() => sources.index(bad), bad).toThrow(/source id/);
    }
    expect(sources.names).toEqual(['center']);
  });

  it('has room for every source id of the scheme', () => {
    const sources = createSourceTable();
    const ids = [
      'hub',
      'asc',
      ...OUTER_IDS.map((o) => `outer.${o}`),
      ...CHARACTER_IDS.flatMap((c) => OUTER_IDS.map((o) => `fusion.${c}.${o}`)),
    ];
    ids.forEach((id, i) => expect(sources.index(id)).toBe(i + 1));
    expect(sources.names.length).toBeLessThanOrEqual(MAX_SOURCES);
  });

  it('selects sources by class or by exact id', () => {
    const sources = createSourceTable();
    for (const id of ['outer.poison', 'outer.fire', 'fusion.fire.poison', 'hub', 'asc']) {
      sources.index(id);
    }
    const picked = (sel: SourceSelector): string[] =>
      sources.names.filter((_, ix) => sources.matches(sel, ix));
    expect(picked('center')).toEqual(['center']);
    expect(picked('outer')).toEqual(['outer.poison', 'outer.fire']);
    expect(picked('outer.fire')).toEqual(['outer.fire']);
    expect(picked('outer.greed')).toEqual([]);
    expect(picked('fusion')).toEqual(['fusion.fire.poison']);
    expect(picked('fusion.fire.poison')).toEqual(['fusion.fire.poison']);
    expect(picked('fusion.ice.poison')).toEqual([]);
    expect(picked('hub')).toEqual(['hub']);
    expect(picked('asc')).toEqual(['asc']);
    expect(sources.matches('center', 40)).toBe(false);
  });

  it('keeps scope masks current as sources are numbered, one array per selector', () => {
    const sources = createSourceTable();
    sources.index('outer.fire');
    const outer = sources.scopeMask('outer');
    const poison = sources.scopeMask('outer.poison');
    expect(sources.scopeMask('outer')).toBe(outer);
    expect([...outer.slice(0, 2)]).toEqual([0, 1]);
    sources.index('hub');
    sources.index('outer.poison');
    expect([...outer.slice(0, 4)]).toEqual([0, 1, 0, 1]);
    expect([...poison.slice(0, 4)]).toEqual([0, 0, 0, 1]);
    expect(outer).toHaveLength(MAX_SOURCES);
    expect(() => sources.scopeMask('outer.water' as SourceSelector)).toThrow(/selector/);
  });

  it('keys ModTable rows by tags below bit 17 and the source above', () => {
    expect(SOURCE_SHIFT).toBe(17);
    expect(rowKey(5, CENTER)).toBe(5);
    expect(rowKey(0x1ffff, 1)).toBe(0x3ffff);
    expect(rowKey(3, MAX_SOURCES - 1)).toBe(3 | (63 << 17));
    expect(rowKey(0x1ffff, MAX_SOURCES - 1)).toBeLessThan(2 ** 23);
  });
});

describe('ailment attribution', () => {
  it('credits every ailment to the applier in M1, where all are the center own', () => {
    const sources = createSourceTable();
    const policy = createAttribution(M1_CENTER_AILMENTS);
    for (const kind of AILMENT_KINDS) {
      expect(ailmentCredit(sources, policy, kind, CENTER), kind).toBe(CENTER);
    }
    expect(sources.names).toEqual(['center']);
  });

  it("credits the character's own kind to the center and others to their outer board", () => {
    const sources = createSourceTable();
    const hub = sources.index('hub');
    const fusion = sources.index('fusion.fire.poison');
    const policy = createAttribution(['burn']);
    expect(ailmentCredit(sources, policy, 'burn', CENTER)).toBe(CENTER);
    expect(ailmentCredit(sources, policy, 'burn', hub)).toBe(CENTER);
    const poison = ailmentCredit(sources, policy, 'poison', CENTER);
    expect(sources.names[poison]).toBe('outer.poison');
    expect(ailmentCredit(sources, policy, 'poison', hub)).toBe(poison);
    expect(sources.names[ailmentCredit(sources, policy, 'frost', CENTER)]).toBe('outer.ice');
    expect(sources.names[ailmentCredit(sources, policy, 'shock', CENTER)]).toBe('outer.lightning');
    // A fusion keeps what it applies, its own kind or not.
    expect(ailmentCredit(sources, policy, 'poison', fusion)).toBe(fusion);
    expect(ailmentCredit(sources, policy, 'burn', fusion)).toBe(fusion);
    expect(sources.names).toEqual([
      'center',
      'hub',
      'fusion.fire.poison',
      'outer.poison',
      'outer.ice',
      'outer.lightning',
    ]);
  });

  it('numbers an outer board once, on its first credit', () => {
    const sources = createSourceTable();
    const policy = createAttribution(['frost']);
    expect([...policy.outerSource]).toEqual([-1, -1, -1, -1, -1]);
    const bleed = ailmentCredit(sources, policy, 'bleed', CENTER);
    expect(ailmentCredit(sources, policy, 'bleed', CENTER)).toBe(bleed);
    expect(sources.names).toEqual(['center', 'outer.bleed']);
    expect(policy.centerAilments).toBe(1 << AILMENT_KINDS.indexOf('frost'));
  });
});
