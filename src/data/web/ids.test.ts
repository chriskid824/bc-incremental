import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, OUTER_IDS, sourceOfNode } from '../sources';
import { TALENTS } from '../talents';
import {
  boardIdOf,
  isSlug,
  nearestName,
  nodeId,
  parseNodeId,
  RESERVED_SLUGS,
  sourceOfBoard,
} from './ids';

/** The examples of docs/v3 C6 design D4's table, with the root and 強化∞, and their boards. */
const D4_EXAMPLES = [
  ['fire.center.spread.pandemic', 'fire.center'],
  ['fire.center.spread.r3', 'fire.center'],
  ['fire.center.main.c4', 'fire.center'],
  ['fire.center.main.endless-inferno', 'fire.center'],
  ['fire.center.main.signature', 'fire.center'],
  ['hub.defense.second-life', 'hub'],
  ['hub.echo.r2', 'hub'],
  ['hub.might.might', 'hub'],
  ['outer.poison.contagion.toxic-cloud', 'outer.poison'],
  ['outer.poison.main.neurotoxin', 'outer.poison'],
  ['fusion.fire.poison.core', 'fusion.fire.poison'],
  ['fusion.summon.ice.r2', 'fusion.summon.ice'],
  ['fire.asc.incinerator.final', 'fire.asc.incinerator'],
] as const;

/** One id of every slot of every block, for every character and outer. */
function everySlotId(): string[] {
  const ids = ['hub.might.might'];
  for (const group of ['defense', 'economy', 'echo']) {
    ids.push(...[1, 2, 3, 4, 5].map((n) => `hub.${group}.r${n}`), `hub.${group}.notable`);
  }
  ids.push('hub.rules.keystone');
  for (const c of CHARACTER_IDS) {
    for (const name of ['signature', 'threshold', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'star']) {
      ids.push(`${c}.center.main.${name}`);
    }
    for (const name of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'mastery', 'notable']) {
      ids.push(`${c}.center.branch.${name}`);
    }
    ids.push(`${c}.asc.chain.n1`, `${c}.asc.chain.n2`, `${c}.asc.chain.final`);
    for (const o of OUTER_IDS) {
      if (o === c) continue;
      for (const slot of ['core', 'r1', 'r2', 'r3', 'mastery'])
        ids.push(`fusion.${c}.${o}.${slot}`);
    }
  }
  for (const o of OUTER_IDS) {
    for (const name of ['entry', 'threshold', 'answer', 'star'])
      ids.push(`outer.${o}.main.${name}`);
    for (const name of ['r1', 'r2', 'r3', 'r4', 'mastery', 'notable']) {
      ids.push(`outer.${o}.branch.${name}`);
    }
  }
  return ids;
}

describe('the id grammar (D4)', () => {
  it.each(D4_EXAMPLES)('parses %s on board %s', (id, board) => {
    expect(parseNodeId(id)?.board).toBe(board);
    expect(boardIdOf(id)).toBe(board);
  });

  it('takes each block apart', () => {
    expect(parseNodeId('fire.center.spread.pandemic')).toEqual({
      block: 'center',
      board: 'fire.center',
      character: 'fire',
      branch: 'spread',
      name: 'pandemic',
    });
    expect(parseNodeId('hub.echo.r2')).toEqual({
      block: 'hub',
      board: 'hub',
      group: 'echo',
      name: 'r2',
    });
    expect(parseNodeId('outer.poison.main.neurotoxin')).toEqual({
      block: 'outer',
      board: 'outer.poison',
      outer: 'poison',
      branch: 'main',
      name: 'neurotoxin',
    });
    expect(parseNodeId('fusion.summon.ice.r2')).toEqual({
      block: 'fusion',
      board: 'fusion.summon.ice',
      character: 'summon',
      outer: 'ice',
      slot: 'r2',
    });
    expect(parseNodeId('fire.asc.incinerator.final')).toEqual({
      block: 'asc',
      board: 'fire.asc.incinerator',
      character: 'fire',
      slug: 'incinerator',
      slot: 'final',
    });
  });

  it('gives every id the board whose source sourceOfNode names', () => {
    const ids = [...D4_EXAMPLES.map(([id]) => id), ...everySlotId()];
    expect(ids.length).toBe(13 + 1 + 3 * 6 + 1 + 4 * (9 + 8 + 3 + 11 * 5) + 12 * (4 + 6));
    for (const id of ids) {
      const board = boardIdOf(id);
      expect(board, id).not.toBeNull();
      if (board !== null) expect(sourceOfBoard(board), id).toBe(sourceOfNode(id));
    }
  });

  it('names each board source as sourceOfNode does', () => {
    expect(sourceOfBoard('ice.center')).toBe('center');
    expect(sourceOfBoard('hub')).toBe('hub');
    expect(sourceOfBoard('outer.greed')).toBe('outer.greed');
    expect(sourceOfBoard('fusion.lightning.crit')).toBe('fusion.lightning.crit');
    expect(sourceOfBoard('summon.asc.queen')).toBe('asc');
  });

  it('builds the ids it parses', () => {
    expect(nodeId('fire.center', 'spread', 'pandemic')).toBe('fire.center.spread.pandemic');
    expect(nodeId('hub', 'might', 'might')).toBe('hub.might.might');
    expect(nodeId('outer.poison', 'main', 'entry')).toBe('outer.poison.main.entry');
    expect(nodeId('fusion.summon.ice', 'r2')).toBe('fusion.summon.ice.r2');
    expect(nodeId('fire.asc.incinerator', 'final')).toBe('fire.asc.incinerator.final');
    // It joins and never throws; parsing tells a bad name.
    expect(nodeId('fire.center', 'spread', 'Bad_Name')).toBe('fire.center.spread.Bad_Name');
    expect(parseNodeId(nodeId('fire.center', 'spread', 'Bad_Name'))).toBeNull();
  });

  it.each([
    // Not in any block.
    '',
    'fire',
    'glassCannon',
    'fire.center.spread',
    'fire.center.spread.r1.extra',
    'center.spread.r1',
    'water.center.main.c1',
    // Center: a slot of the other part of the board, or past the last.
    'fire.center.main.r1',
    'fire.center.main.mastery',
    'fire.center.spread.c1',
    'fire.center.spread.signature',
    'fire.center.spread.r7',
    'fire.center.main.c7',
    'fire.center.main.c01',
    // Hub: an unknown group, 強化∞ elsewhere, a ranked ★.
    'hub.attack.r1',
    'hub.might.r1',
    'hub.defense.might',
    'hub.rules.r1',
    'hub.defense.r6',
    'hub.defense.second-life.r1',
    // Outer: an unknown outer, a mastery on main, a slot past the last.
    'outer.water.main.entry',
    'outer.poison.main.mastery',
    'outer.poison.contagion.r5',
    'outer.poison.contagion.entry',
    // Fusion: the own outer, an unknown slot, a swapped pair.
    'fusion.fire.fire.core',
    'fusion.fire.poison.r4',
    'fusion.fire.poison.final',
    'fusion.poison.fire.core',
    'fusion.fire.water.core',
    // Ascendancy: a ranked slot, a reserved slug.
    'fire.asc.incinerator.r1',
    'fire.asc.main.final',
    'poison.asc.plague.final',
    // An empty segment: a leading, trailing or doubled separator.
    '.fire.center.spread.r1',
    'fire.center.spread.r1.',
    'fire..center.spread.r1',
    'fire.center..r1',
    'hub.defense.r1.',
    'hub..defense.r1',
    'outer.poison.contagion.r1.',
    'fusion.fire.poison.core.',
    'fire.asc.incinerator.final.',
  ])('rejects %o', (id) => {
    expect(parseNodeId(id)).toBeNull();
    expect(boardIdOf(id)).toBeNull();
  });

  it('parses no M1 talent id', () => {
    for (const node of TALENTS) expect(parseNodeId(node.id), node.id).toBeNull();
  });
});

describe('slugs', () => {
  it.each([
    'toxic-cloud',
    'second-life',
    'endless-inferno',
    'a',
    'x2',
    'r1-burst',
    'main-gate',
    'r',
  ])('accepts %o', (slug) => {
    expect(isSlug(slug)).toBe(true);
  });

  it('rejects every reserved word and numbered slot name', () => {
    expect(RESERVED_SLUGS).toEqual([
      'main',
      'signature',
      'threshold',
      'entry',
      'mastery',
      'core',
      'final',
      'might',
    ]);
    for (const word of [...RESERVED_SLUGS, 'r1', 'r12', 'c4', 'n2', 'n10']) {
      expect(isSlug(word), word).toBe(false);
    }
    expect(parseNodeId('fire.center.main.main')).toBeNull();
    expect(parseNodeId('fire.center.core.r1')).toBeNull();
    expect(parseNodeId('outer.poison.entry.r1')).toBeNull();
  });

  it.each([
    ['an underscore', 'toxic_cloud'],
    ['all digits', '123'],
    ['a leading digit', '1st-strike'],
    ['a capital', 'Toxic-cloud'],
    ['camel case', 'toxicCloud'],
    ['a trailing hyphen', 'toxic-'],
    ['a leading hyphen', '-toxic'],
    ['a double hyphen', 'toxic--cloud'],
    ['a space', 'toxic cloud'],
    ['a dot', 'toxic.cloud'],
    ['nothing', ''],
  ])('rejects %s', (_label, slug) => {
    expect(isSlug(slug)).toBe(false);
    expect(parseNodeId(`outer.poison.contagion.${slug}`)).toBeNull();
    expect(parseNodeId(`fire.asc.${slug}.final`)).toBeNull();
  });

  it('rejects a bad slug in each block', () => {
    expect(parseNodeId('outer.poison.contagion.toxic_cloud')).toBeNull();
    expect(parseNodeId('fire.center.Spread.r1')).toBeNull();
    expect(parseNodeId('hub.defense.Second-life')).toBeNull();
    expect(parseNodeId('outer.poison.42.r1')).toBeNull();
    expect(parseNodeId('fire.center.main.endless_inferno')).toBeNull();
  });
});

describe('nearestName', () => {
  const STATS = ['poisonDamage', 'poisonChance', 'critChance', 'crit', 'burn'];

  it('finds the nearest name within an edit distance of 2', () => {
    expect(nearestName('posionDamage', STATS)).toBe('poisonDamage');
    expect(nearestName('critChanse', STATS)).toBe('critChance');
    expect(nearestName('cirt', STATS)).toBe('crit');
    expect(nearestName('brn', STATS)).toBe('burn');
    expect(nearestName('burn', STATS)).toBe('burn');
  });

  it('finds none farther than 2, or than the bound it is given', () => {
    expect(nearestName('bxrnxx', STATS)).toBeNull();
    expect(nearestName('poison', STATS)).toBeNull();
    expect(nearestName('cirt', STATS, 1)).toBeNull();
    expect(nearestName('crt', STATS, 1)).toBe('crit');
    expect(nearestName('anything', [])).toBeNull();
  });

  it('takes the nearest, then the first in order', () => {
    expect(nearestName('critChancee', ['critChanc', 'critChance'])).toBe('critChance');
    expect(nearestName('cat', ['bat', 'cot', 'cut'])).toBe('bat');
    expect(nearestName('cat', ['cut', 'bat'])).toBe('cut');
  });
});
