import { describe, expect, it } from 'vitest';
import {
  AILMENT_OUTER,
  ARCHETYPE_TAGS,
  CHARACTER_IDS,
  isSourceSelector,
  OUTER_IDS,
  SOURCE_CLASSES,
  sourceClass,
  sourceOfNode,
} from './sources';
import { DAMAGE_TAGS } from './tags';
import { TALENTS } from './talents';
import { AILMENT_KINDS } from './triggers';

describe('sourceOfNode', () => {
  it.each([
    ['fire.center.spread.pandemic', 'center'],
    ['summon.center.swarm.hive', 'center'],
    ['hub.defense.second-life', 'hub'],
    ['outer.poison.contagion.toxic-cloud', 'outer.poison'],
    ['outer.greed.coins.jackpot', 'outer.greed'],
    ['fusion.fire.poison.core', 'fusion.fire.poison'],
    ['fusion.summon.ice.r2', 'fusion.summon.ice'],
    ['fire.asc.incinerator.final', 'asc'],
    ['lightning.asc.storm.r1', 'asc'],
  ])('maps %s to %s', (id, source) => {
    expect(sourceOfNode(id)).toBe(source);
  });

  it('maps every M1 node to the center', () => {
    for (const node of TALENTS) expect(sourceOfNode(node.id), node.id).toBe('center');
  });

  it.each([
    'outer.water.x.y',
    'outer.poison',
    'fusion.fire.water.core',
    'fusion.poison.fire.core',
    'fusion.fire.poison',
    'hub',
    'poison.asc.x.y',
    'fire.asc',
    'center',
    '',
  ])('maps %o, which follows no other scheme, to the center', (id) => {
    expect(sourceOfNode(id)).toBe('center');
  });

  it('gives a source id that is a valid selector', () => {
    const ids = [
      'hub.a.b',
      ...OUTER_IDS.map((o) => `outer.${o}.a.b`),
      ...CHARACTER_IDS.flatMap((c) => [
        `${c}.center.a.b`,
        `${c}.asc.a.b`,
        ...OUTER_IDS.map((o) => `fusion.${c}.${o}.core`),
      ]),
    ];
    for (const id of ids) {
      const source = sourceOfNode(id);
      expect(isSourceSelector(source), id).toBe(true);
      expect(sourceClass(source), id).not.toBeNull();
    }
  });
});

describe('source ids and selectors', () => {
  it('classifies every form of source id', () => {
    expect(sourceClass('center')).toBe('center');
    expect(sourceClass('hub')).toBe('hub');
    expect(sourceClass('asc')).toBe('asc');
    expect(sourceClass('outer.barrage')).toBe('outer');
    expect(sourceClass('fusion.ice.aura')).toBe('fusion');
  });

  it.each([
    'outer',
    'fusion',
    'outer.water',
    'outer.poison.x',
    'fusion.fire',
    'fusion.poison.fire',
    'fusion.fire.poison.core',
    'Center',
    '',
  ])('has no class for %o', (id) => {
    expect(sourceClass(id)).toBeNull();
  });

  it('accepts class names and source ids as selectors, nothing else', () => {
    for (const cls of SOURCE_CLASSES) expect(isSourceSelector(cls)).toBe(true);
    for (const outer of OUTER_IDS) expect(isSourceSelector(`outer.${outer}`)).toBe(true);
    expect(isSourceSelector('fusion.summon.greed')).toBe(true);
    for (const bad of ['outer.water', 'fusion.fire', 'fusion.fire.poison.core', 'all', '']) {
      expect(isSourceSelector(bad), bad).toBe(false);
    }
  });
});

describe('archetype tables', () => {
  it('names each character by its own outer id', () => {
    for (const id of CHARACTER_IDS) expect(OUTER_IDS).toContain(id);
  });

  it('credits each ailment kind to an outer board', () => {
    expect(Object.keys(AILMENT_OUTER).sort()).toEqual([...AILMENT_KINDS].sort());
    expect(AILMENT_OUTER).toEqual({
      burn: 'fire',
      poison: 'poison',
      bleed: 'bleed',
      shock: 'lightning',
      frost: 'ice',
    });
  });

  it('gives every archetype but combo, barrage and greed a damage tag', () => {
    const untagged = OUTER_IDS.filter((id) => ARCHETYPE_TAGS[id] === undefined);
    expect(untagged).toEqual(['combo', 'barrage', 'greed']);
    for (const tags of Object.values(ARCHETYPE_TAGS)) {
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(DAMAGE_TAGS).toContain(tag);
    }
  });
});
