import { describe, expect, it } from 'vitest';
import type { EmitterGrant } from './emitters';
import { CHARACTER_IDS, OUTER_IDS } from './sources';
import type { OuterId } from './sources';
import {
  answers,
  ascendancy,
  ascFinal,
  ascNode,
  centerBranch,
  defaultMasteryTarget,
  defineCharacter,
  defineHub,
  defineOuter,
  entry,
  flat,
  fusionRank,
  inc,
  keystone,
  mastery,
  might,
  more,
  notable,
  outerBranch,
  ranked,
  rankedMods,
  signatureNode,
  threshold,
} from './templates';
import type {
  CenterBranchSlots,
  CenterSpec,
  CharacterSpec,
  HubSpec,
  MasteryTarget,
  OuterBranchSlots,
  OuterSpec,
} from './templates';
import { parseNodeId } from './web/ids';
import type {
  BoardDef,
  CenterStep,
  NodeEffects,
  NodeSlot,
  NodeSpec,
  OuterStep,
  WebNode,
  WebNodeKind,
} from './web/types';

const EMPTY = { modifiers: [], triggers: [], conversions: [], emitters: [], rules: [] };

/** A board's edges as sorted 'a b' pairs with each pair sorted: order and direction do not count. */
function edgeSet(edges: BoardDef['edges']): string[] {
  return edges.map((pair) => [...pair].sort().join(' ')).sort();
}

/** `pairs` of names relative to `prefix` ('x.y z.w') as edgeSet writes them. */
function expectedEdges(prefix: string, pairs: readonly string[]): string[] {
  return edgeSet(
    pairs.map((pair) => {
      const [a, b] = pair.split(' ') as [string, string];
      return [`${prefix}.${a}`, `${prefix}.${b}`] as const;
    }),
  );
}

/** Each node as [its id without `prefix.`, its slot, its kind]. */
function placed(board: BoardDef, prefix: string): [string, NodeSlot, WebNodeKind][] {
  return board.nodes.map((node) => [node.id.slice(prefix.length + 1), node.slot, node.kind]);
}

const byId = (board: BoardDef, id: string): WebNode | undefined =>
  board.nodes.find((node) => node.id === id);

/** A ranked node whose value tells which spec landed where. */
const r = (value: number) => ranked('damage', value, 3);

const centerSlots = (a: string, b: string, c: string): CenterBranchSlots => ({
  r1: r(0.01),
  r2: r(0.02),
  a: notable(a, {}),
  r3: r(0.03),
  r4: r(0.04),
  b: notable(b, {}),
  r5: r(0.05),
  r6: r(0.06),
  c: notable(c, {}),
  mastery: mastery(),
});

const CENTER: CenterSpec = {
  signature: signatureNode(),
  branches: [
    centerBranch('spread', centerSlots('pandemic', 'wildfire', 'ember')),
    centerBranch('blast', centerSlots('shockwave', 'crater', 'quake')),
    centerBranch('heat', centerSlots('melt', 'forge', 'kiln')),
  ],
  keystones: [keystone('inferno', {}), keystone('volcano', {})],
  threshold: threshold({}),
  connectors: [r(0.11), r(0.12), r(0.13), r(0.14), r(0.15), r(0.16)],
};

/** 熔核's card (gd:30, gd:304-305, gd:735) with no center and no ascendancies. */
const CARD: CharacterSpec = {
  id: 'fire',
  color: 0xff7a2f,
  center: null,
  ascendancies: null,
  recommendedOuter: ['ice', 'crit', 'summon'],
  revealAt15: ['poison', 'lightning', 'thorns'],
  enemyRow: {
    triangle: 'even',
    square: 'strong',
    pentagon: 'even',
    shielder: 'strong',
    regenerator: 'strong',
    dasher: 'weak',
    shooter: 'even',
    summoner: 'weak',
    treasure: 'weak',
    boss: 'strong',
  },
  difficulty: 1,
  construct: 'magmaCore',
  defaultOrder: [],
};

const outerSlots = (a: string, b: string): OuterBranchSlots => ({
  r1: r(0.01),
  r2: r(0.02),
  a: notable(a, {}),
  r3: r(0.03),
  r4: r(0.04),
  b: notable(b, {}),
  mastery: mastery(),
});

/** §5.3's poison with its slugs and no payload. */
const outerSpec = (id: OuterId): OuterSpec => ({
  id,
  entry: entry({}),
  branches: [
    outerBranch('virulence', outerSlots('double-dose', 'seep')),
    outerBranch('contagion', outerSlots('toxic-cloud', 'contagion')),
  ],
  answer: answers(notable('neurotoxin', {}), 'dasher'),
  keystone: keystone('lethal-toxin', {}),
  threshold: threshold({}),
  payload: null,
  skin: { accent: 0x3fd08a, shape: 'bubble' },
  covers: { dasher: 'answer' },
});

const HUB: HubSpec = {
  might: might(),
  defense: {
    ranked: [r(0.11), r(0.12), r(0.13), r(0.14), r(0.15)],
    notables: [notable('second-life', {}), notable('wave-shield', {})],
  },
  economy: {
    ranked: [r(0.21), r(0.22), r(0.23), r(0.24)],
    notables: [notable('elite-bounty', {}), notable('treasure-sense', {})],
  },
  echo: {
    ranked: [r(0.31), r(0.32), r(0.33), r(0.34)],
    notables: [
      notable('multicast', {}),
      notable('reverb', {}),
      notable('kill-blast', {}),
      notable('nova', {}),
    ],
  },
  rules: { keystones: [keystone('glass-cannon', {}), keystone('gigantism', {})] },
};

const branchAt = (branch: 0 | 1 | 2, step: CenterStep): NodeSlot => ({
  at: 'centerBranch',
  branch,
  step,
});
const ringAt = (clock: number): NodeSlot => ({ at: 'centerEdge', clock });

/** The center of §4.4 on CENTER: ids, slots and kinds in builder order. */
const CENTER_NODES: [string, NodeSlot, WebNodeKind][] = [
  ['main.signature', { at: 'signature' }, 'signature'],
  ['spread.r1', branchAt(0, 'r1'), 'ranked'],
  ['spread.r2', branchAt(0, 'r2'), 'ranked'],
  ['spread.pandemic', branchAt(0, 'a'), 'notable'],
  ['spread.r3', branchAt(0, 'r3'), 'ranked'],
  ['spread.r4', branchAt(0, 'r4'), 'ranked'],
  ['spread.wildfire', branchAt(0, 'b'), 'notable'],
  ['spread.r5', branchAt(0, 'r5'), 'ranked'],
  ['spread.r6', branchAt(0, 'r6'), 'ranked'],
  ['spread.ember', branchAt(0, 'c'), 'notable'],
  ['spread.mastery', branchAt(0, 'mastery'), 'mastery'],
  ['blast.r1', branchAt(1, 'r1'), 'ranked'],
  ['blast.r2', branchAt(1, 'r2'), 'ranked'],
  ['blast.shockwave', branchAt(1, 'a'), 'notable'],
  ['blast.r3', branchAt(1, 'r3'), 'ranked'],
  ['blast.r4', branchAt(1, 'r4'), 'ranked'],
  ['blast.crater', branchAt(1, 'b'), 'notable'],
  ['blast.r5', branchAt(1, 'r5'), 'ranked'],
  ['blast.r6', branchAt(1, 'r6'), 'ranked'],
  ['blast.quake', branchAt(1, 'c'), 'notable'],
  ['blast.mastery', branchAt(1, 'mastery'), 'mastery'],
  ['heat.r1', branchAt(2, 'r1'), 'ranked'],
  ['heat.r2', branchAt(2, 'r2'), 'ranked'],
  ['heat.melt', branchAt(2, 'a'), 'notable'],
  ['heat.r3', branchAt(2, 'r3'), 'ranked'],
  ['heat.r4', branchAt(2, 'r4'), 'ranked'],
  ['heat.forge', branchAt(2, 'b'), 'notable'],
  ['heat.r5', branchAt(2, 'r5'), 'ranked'],
  ['heat.r6', branchAt(2, 'r6'), 'ranked'],
  ['heat.kiln', branchAt(2, 'c'), 'notable'],
  ['heat.mastery', branchAt(2, 'mastery'), 'mastery'],
  ['main.inferno', ringAt(2), 'keystone'],
  ['main.volcano', ringAt(10), 'keystone'],
  ['main.threshold', ringAt(6), 'threshold'],
  ['main.c1', ringAt(1), 'ranked'],
  ['main.c2', ringAt(3), 'ranked'],
  ['main.c3', ringAt(5), 'ranked'],
  ['main.c4', ringAt(7), 'ranked'],
  ['main.c5', ringAt(9), 'ranked'],
  ['main.c6', ringAt(11), 'ranked'],
];

/** §4.4's 45 center edges on CENTER. */
const CENTER_EDGES = [
  // spread at clock 0: its r3 to the connector at 1, its r5 to the one at 11.
  'main.signature spread.r1',
  'spread.r1 spread.r2',
  'spread.r2 spread.pandemic',
  'spread.pandemic spread.r3',
  'spread.r3 spread.r4',
  'spread.r4 spread.wildfire',
  'spread.wildfire spread.mastery',
  'spread.pandemic spread.r5',
  'spread.r5 spread.r6',
  'spread.r6 spread.ember',
  'spread.ember spread.mastery',
  'spread.r3 main.c1',
  'spread.r5 main.c6',
  // blast at clock 4: to the connectors at 5 and 3.
  'main.signature blast.r1',
  'blast.r1 blast.r2',
  'blast.r2 blast.shockwave',
  'blast.shockwave blast.r3',
  'blast.r3 blast.r4',
  'blast.r4 blast.crater',
  'blast.crater blast.mastery',
  'blast.shockwave blast.r5',
  'blast.r5 blast.r6',
  'blast.r6 blast.quake',
  'blast.quake blast.mastery',
  'blast.r3 main.c3',
  'blast.r5 main.c2',
  // heat at clock 8: to the connectors at 9 and 7.
  'main.signature heat.r1',
  'heat.r1 heat.r2',
  'heat.r2 heat.melt',
  'heat.melt heat.r3',
  'heat.r3 heat.r4',
  'heat.r4 heat.forge',
  'heat.forge heat.mastery',
  'heat.melt heat.r5',
  'heat.r5 heat.r6',
  'heat.r6 heat.kiln',
  'heat.kiln heat.mastery',
  'heat.r3 main.c5',
  'heat.r5 main.c4',
  // The ★ at 2 and 10 and the threshold at 6, each to the connectors either side.
  'main.inferno main.c1',
  'main.inferno main.c2',
  'main.volcano main.c5',
  'main.volcano main.c6',
  'main.threshold main.c3',
  'main.threshold main.c4',
];

const sideAt = (side: 1 | -1, step: OuterStep): NodeSlot => ({ at: 'outerBranch', side, step });

const OUTER_NODES: [string, NodeSlot, WebNodeKind][] = [
  ['main.entry', { at: 'outerEntry' }, 'entry'],
  ['virulence.r1', sideAt(1, 'r1'), 'ranked'],
  ['virulence.r2', sideAt(1, 'r2'), 'ranked'],
  ['virulence.double-dose', sideAt(1, 'a'), 'notable'],
  ['virulence.r3', sideAt(1, 'r3'), 'ranked'],
  ['virulence.r4', sideAt(1, 'r4'), 'ranked'],
  ['virulence.seep', sideAt(1, 'b'), 'notable'],
  ['virulence.mastery', sideAt(1, 'mastery'), 'mastery'],
  ['contagion.r1', sideAt(-1, 'r1'), 'ranked'],
  ['contagion.r2', sideAt(-1, 'r2'), 'ranked'],
  ['contagion.toxic-cloud', sideAt(-1, 'a'), 'notable'],
  ['contagion.r3', sideAt(-1, 'r3'), 'ranked'],
  ['contagion.r4', sideAt(-1, 'r4'), 'ranked'],
  ['contagion.contagion', sideAt(-1, 'b'), 'notable'],
  ['contagion.mastery', sideAt(-1, 'mastery'), 'mastery'],
  ['main.neurotoxin', { at: 'outerEdge', place: 'answer' }, 'notable'],
  ['main.lethal-toxin', { at: 'outerEdge', place: 'keystone' }, 'keystone'],
  ['main.threshold', { at: 'outerEdge', place: 'threshold' }, 'threshold'],
];

/** §4.4's 20 outer edges on outerSpec. */
const OUTER_EDGES = [
  'main.entry virulence.r1',
  'virulence.r1 virulence.r2',
  'virulence.r2 virulence.double-dose',
  'virulence.double-dose virulence.r3',
  'virulence.r3 virulence.r4',
  'virulence.r4 virulence.mastery',
  'virulence.double-dose virulence.seep',
  'virulence.seep virulence.mastery',
  'main.entry contagion.r1',
  'contagion.r1 contagion.r2',
  'contagion.r2 contagion.toxic-cloud',
  'contagion.toxic-cloud contagion.r3',
  'contagion.r3 contagion.r4',
  'contagion.r4 contagion.mastery',
  'contagion.toxic-cloud contagion.contagion',
  'contagion.contagion contagion.mastery',
  'main.neurotoxin virulence.seep',
  'main.neurotoxin contagion.contagion',
  'main.lethal-toxin main.neurotoxin',
  'main.threshold main.neurotoxin',
];

/** D15's fixed table on HUB: per clock the ring node, then its spur. */
const HUB_NODES: [string, NodeSlot, WebNodeKind][] = [
  ['might.might', { at: 'hubRing', clock: 0 }, 'might'],
  ['rules.glass-cannon', { at: 'hubSpur', clock: 0 }, 'keystone'],
  ['defense.r1', { at: 'hubRing', clock: 1 }, 'ranked'],
  ['defense.second-life', { at: 'hubSpur', clock: 1 }, 'notable'],
  ['defense.r2', { at: 'hubRing', clock: 2 }, 'ranked'],
  ['defense.wave-shield', { at: 'hubSpur', clock: 2 }, 'notable'],
  ['defense.r3', { at: 'hubRing', clock: 3 }, 'ranked'],
  ['defense.r5', { at: 'hubSpur', clock: 3 }, 'ranked'],
  ['defense.r4', { at: 'hubRing', clock: 4 }, 'ranked'],
  ['rules.gigantism', { at: 'hubSpur', clock: 4 }, 'keystone'],
  ['economy.r1', { at: 'hubRing', clock: 5 }, 'ranked'],
  ['economy.elite-bounty', { at: 'hubSpur', clock: 5 }, 'notable'],
  ['economy.r2', { at: 'hubRing', clock: 6 }, 'ranked'],
  ['economy.r4', { at: 'hubSpur', clock: 6 }, 'ranked'],
  ['economy.r3', { at: 'hubRing', clock: 7 }, 'ranked'],
  ['economy.treasure-sense', { at: 'hubSpur', clock: 7 }, 'notable'],
  ['echo.r1', { at: 'hubRing', clock: 8 }, 'ranked'],
  ['echo.multicast', { at: 'hubSpur', clock: 8 }, 'notable'],
  ['echo.r2', { at: 'hubRing', clock: 9 }, 'ranked'],
  ['echo.reverb', { at: 'hubSpur', clock: 9 }, 'notable'],
  ['echo.r3', { at: 'hubRing', clock: 10 }, 'ranked'],
  ['echo.kill-blast', { at: 'hubSpur', clock: 10 }, 'notable'],
  ['echo.r4', { at: 'hubRing', clock: 11 }, 'ranked'],
  ['echo.nova', { at: 'hubSpur', clock: 11 }, 'notable'],
];

/** The closed ring, then each spur to its ring node. */
const HUB_EDGES = [
  'might.might defense.r1',
  'defense.r1 defense.r2',
  'defense.r2 defense.r3',
  'defense.r3 defense.r4',
  'defense.r4 economy.r1',
  'economy.r1 economy.r2',
  'economy.r2 economy.r3',
  'economy.r3 echo.r1',
  'echo.r1 echo.r2',
  'echo.r2 echo.r3',
  'echo.r3 echo.r4',
  'echo.r4 might.might',
  'might.might rules.glass-cannon',
  'defense.r1 defense.second-life',
  'defense.r2 defense.wave-shield',
  'defense.r3 defense.r5',
  'defense.r4 rules.gigantism',
  'economy.r1 economy.elite-bounty',
  'economy.r2 economy.r4',
  'economy.r3 economy.treasure-sense',
  'echo.r1 echo.multicast',
  'echo.r2 echo.reverb',
  'echo.r3 echo.kill-blast',
  'echo.r4 echo.nova',
];

/** CHARACTER_SIGNATURE and SIGNATURE_EVENT per character (implementation-plan-v3 §2.13). */
const DERIVED = {
  fire: ['magmaBomb', 'explode'],
  ice: ['iceFan', 'freeze'],
  lightning: ['triphaseArc', 'chainJump'],
  summon: ['swarm', 'droneImpact'],
} as const;

/** F7's default mastery target on each outer: its archetype's tags, else its own scope. */
const OUTER_MASTERY: Record<OuterId, MasteryTarget> = {
  fire: { tags: ['burn'] },
  poison: { tags: ['poison'] },
  bleed: { tags: ['bleed'] },
  lightning: { tags: ['chain'] },
  combo: { scope: 'outer.combo' },
  crit: { tags: ['crit'] },
  ice: { tags: ['cold'] },
  aura: { tags: ['aura'] },
  thorns: { tags: ['thorns'] },
  summon: { tags: ['minion'] },
  barrage: { scope: 'outer.barrage' },
  greed: { scope: 'outer.greed' },
};

const masteryMods = (board: BoardDef) =>
  board.nodes.filter((node) => node.kind === 'mastery').map((node) => node.effects.modifiers);

describe('the modifier helpers', () => {
  it('write one modifier of their kind, with only the options given', () => {
    expect(flat('maxLife', 5)).toStrictEqual({ stat: 'maxLife', kind: 'flat', value: 5 });
    expect(inc('damage', 0.2, { tags: ['burn'], scope: 'center' })).toStrictEqual({
      stat: 'damage',
      kind: 'increased',
      value: 0.2,
      tags: ['burn'],
      scope: 'center',
    });
    expect(
      more('damage', 0.5, { when: [{ targetHas: 'poison' }], notTags: ['hit'] }),
    ).toStrictEqual({
      stat: 'damage',
      kind: 'more',
      value: 0.5,
      when: [{ targetHas: 'poison' }],
      notTags: ['hit'],
    });
  });
});

describe('the node templates', () => {
  it('ranked gives one increased modifier a rank unless told otherwise', () => {
    expect(ranked('damage', 0.05, 4)).toStrictEqual({
      kind: 'ranked',
      slug: null,
      ranks: 4,
      effects: { ...EMPTY, modifiers: [{ stat: 'damage', kind: 'increased', value: 0.05 }] },
      answers: [],
    });
    expect(ranked('poisonChance', 0.03, 3, 'flat', { tags: ['poison'] }).effects.modifiers).toEqual(
      [{ stat: 'poisonChance', kind: 'flat', value: 0.03, tags: ['poison'] }],
    );
  });

  it('rankedMods grants its emitters at rank 1 only: once in the node, never once a rank', () => {
    const thorns: EmitterGrant = { kind: 'thorns' };
    const mods = [inc('damage', 0.1), flat('maxLife', 5)];
    const spec = rankedMods(mods, 5, { emitters: [thorns] });
    expect(spec).toStrictEqual({
      kind: 'ranked',
      slug: null,
      ranks: 5,
      effects: { ...EMPTY, modifiers: mods, emitters: [thorns] },
      answers: [],
    });
    expect(rankedMods(mods, 3).effects.emitters).toEqual([]);
  });

  it('names a ◆ and a ★ by slug and gives them 1 rank and their effects', () => {
    const rule = { id: 'glassCannon', damageMore: 1 } as const;
    expect(notable('pandemic', { modifiers: [inc('damage', 0.3)] })).toStrictEqual({
      kind: 'notable',
      slug: 'pandemic',
      ranks: 1,
      effects: { ...EMPTY, modifiers: [{ stat: 'damage', kind: 'increased', value: 0.3 }] },
      answers: [],
    });
    expect(keystone('glass-cannon', { rules: [rule] })).toStrictEqual({
      kind: 'keystone',
      slug: 'glass-cannon',
      ranks: 1,
      effects: { ...EMPTY, rules: [rule] },
      answers: [],
    });
  });

  it('gives the slot-named one-rank nodes no slug', () => {
    for (const [spec, kind] of [
      [threshold({}), 'threshold'],
      [entry({}), 'entry'],
      [signatureNode(), 'signature'],
      [ascNode({}), 'asc'],
      [ascFinal({}), 'ascFinal'],
    ] as const) {
      expect(spec).toStrictEqual({ kind, slug: null, ranks: 1, effects: EMPTY, answers: [] });
    }
    expect(threshold({ modifiers: [flat('maxLife', 1)] }).effects.modifiers).toEqual([
      flat('maxLife', 1),
    ]);
  });

  it('mastery is more 0.04 damage a rank, unlimited, with the target it is given or none', () => {
    expect(mastery()).toStrictEqual({
      kind: 'mastery',
      slug: null,
      ranks: 'unlimited',
      effects: { ...EMPTY, modifiers: [{ stat: 'damage', kind: 'more', value: 0.04 }] },
      answers: [],
    });
    expect(mastery({ tags: ['burn'] }).effects.modifiers).toEqual([
      { stat: 'damage', kind: 'more', value: 0.04, tags: ['burn'] },
    ]);
  });

  it("might is M1's 強化∞: more 0.10 damage a rank, unlimited", () => {
    expect(might()).toStrictEqual({
      kind: 'might',
      slug: null,
      ranks: 'unlimited',
      effects: { ...EMPTY, modifiers: [{ stat: 'damage', kind: 'more', value: 0.1 }] },
      answers: [],
    });
  });

  it('answers marks a copy, each enemy once', () => {
    const spec = notable('seep', {});
    const marked = answers(answers(spec, 'shielder'), 'dasher', 'shielder');
    expect(marked.answers).toEqual(['shielder', 'dasher']);
    expect({ ...marked, answers: [] }).toStrictEqual(spec);
    expect(spec.answers).toEqual([]);
  });

  it('fusionRank is a RankSpec', () => {
    const mods = [inc('damage', 0.1, { scope: 'fusion' })];
    expect(fusionRank(mods, 3)).toStrictEqual({ modifiers: mods, ranks: 3 });
  });

  it('keeps every effect a node is given, each in its own array', () => {
    const effects: NodeEffects = {
      modifiers: [inc('damage', 0.2)],
      triggers: [
        {
          on: 'diedWithAilment',
          when: [{ victimHas: 'burn' }],
          do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 250, effect: 0.4 }],
        },
      ],
      conversions: [{ to: 'burn', fraction: 0.5 }],
      emitters: [{ kind: 'thorns' }],
      rules: [{ id: 'glassCannon', damageMore: 1 }],
    };
    for (const spec of [
      notable('blaze', effects),
      keystone('blaze', effects),
      threshold(effects),
      entry(effects),
      ascNode(effects),
      ascFinal(effects),
    ]) {
      expect(spec.effects, spec.kind).toStrictEqual(effects);
    }
  });
});

describe('defineCharacter', () => {
  it.each(CHARACTER_IDS)('derives the archetype, keys, signature, event and arena of %s', (c) => {
    const def = defineCharacter({ ...CARD, id: c });
    const [signature, event] = DERIVED[c];
    expect(def.archetype).toBe(c);
    expect(def.nameKey).toBe(`web.char.${c}.name`);
    expect(def.introKey).toBe(`web.char.${c}.intro`);
    expect(def.signature).toStrictEqual({ id: signature });
    expect(def.centerEvent).toBe(event);
    expect(def.arena).toBe(c);
  });

  it('copies the card and the 預設 build, and keeps a null center and null ascendancies', () => {
    const order = ['fire.center.spread.r1', 'fire.center.spread.r1', 'fire.center.spread.r2'];
    expect(defineCharacter({ ...CARD, defaultOrder: order }).defaultOrder).toEqual(order);
    const def = defineCharacter(CARD);
    expect(def).toStrictEqual({
      id: 'fire',
      archetype: 'fire',
      nameKey: 'web.char.fire.name',
      introKey: 'web.char.fire.intro',
      color: 0xff7a2f,
      signature: { id: 'magmaBomb' },
      centerEvent: 'explode',
      center: null,
      ascendancies: null,
      recommendedOuter: ['ice', 'crit', 'summon'],
      revealAt15: ['poison', 'lightning', 'thorns'],
      enemyRow: CARD.enemyRow,
      difficulty: 1,
      construct: 'magmaCore',
      arena: 'fire',
      defaultOrder: [],
    });
  });

  it('builds the center: 40 nodes with their ids, slots and kinds, 45 edges (§4.4)', () => {
    const center = defineCharacter({ ...CARD, center: CENTER }).center as BoardDef;
    expect(center.id).toBe('fire.center');
    expect(center.branches).toEqual(['spread', 'blast', 'heat']);
    expect(placed(center, 'fire.center')).toEqual(CENTER_NODES);
    expect(center.nodes.every((node) => node.board === 'fire.center')).toBe(true);
    expect(center.edges).toHaveLength(45);
    expect(edgeSet(center.edges)).toEqual(expectedEdges('fire.center', CENTER_EDGES));
  });

  it('puts each spec in its own slot, as written', () => {
    const center = defineCharacter({ ...CARD, center: CENTER }).center as BoardDef;
    for (const branch of ['spread', 'blast', 'heat']) {
      for (const n of [1, 2, 3, 4, 5, 6]) {
        const node = byId(center, `fire.center.${branch}.r${n}`);
        expect(node?.effects.modifiers[0]?.value, `${branch}.r${n}`).toBeCloseTo(n / 100, 12);
        expect(node?.ranks).toBe(3);
      }
    }
    expect(byId(center, 'fire.center.main.inferno')?.effects).toBe(CENTER.keystones[0].effects);
    expect(byId(center, 'fire.center.main.threshold')?.ranks).toBe(1);
  });

  it('places connectors c1–c6 at clocks 1, 3, 5, 7, 9 and 11, in the order written', () => {
    const center = defineCharacter({ ...CARD, center: CENTER }).center as BoardDef;
    const connectors = center.nodes
      .filter((node) => /\.c\d$/.test(node.id))
      .map((node) => [node.id, node.slot, node.effects.modifiers[0]?.value]);
    expect(connectors).toEqual([
      ['fire.center.main.c1', { at: 'centerEdge', clock: 1 }, 0.11],
      ['fire.center.main.c2', { at: 'centerEdge', clock: 3 }, 0.12],
      ['fire.center.main.c3', { at: 'centerEdge', clock: 5 }, 0.13],
      ['fire.center.main.c4', { at: 'centerEdge', clock: 7 }, 0.14],
      ['fire.center.main.c5', { at: 'centerEdge', clock: 9 }, 0.15],
      ['fire.center.main.c6', { at: 'centerEdge', clock: 11 }, 0.16],
    ]);
  });

  it('builds the two ascendancies: n1–n2–final, chain 0 the first', () => {
    const chain = (slug: string) =>
      ascendancy(slug, {
        n1: ascNode({ modifiers: [inc('damage', 0.1)] }),
        n2: ascNode({ modifiers: [inc('damage', 0.2)] }),
        final: ascFinal({ modifiers: [inc('damage', 0.3)] }),
      });
    const def = defineCharacter({
      ...CARD,
      ascendancies: [chain('incinerator'), chain('inferno')],
    });
    expect(def.ascendancies?.map((asc) => asc.slug)).toEqual(['incinerator', 'inferno']);
    const [first, second] = def.ascendancies ?? [];
    expect(first?.board.id).toBe('fire.asc.incinerator');
    expect(first && placed(first.board, 'fire.asc.incinerator')).toEqual([
      ['n1', { at: 'asc', chain: 0, step: 0 }, 'asc'],
      ['n2', { at: 'asc', chain: 0, step: 1 }, 'asc'],
      ['final', { at: 'asc', chain: 0, step: 2 }, 'ascFinal'],
    ]);
    expect(first?.board.edges).toEqual([
      ['fire.asc.incinerator.n1', 'fire.asc.incinerator.n2'],
      ['fire.asc.incinerator.n2', 'fire.asc.incinerator.final'],
    ]);
    expect(first?.board.branches).toEqual([]);
    expect(first?.board.nodes.map((node) => node.effects.modifiers)).toEqual([
      [inc('damage', 0.1)],
      [inc('damage', 0.2)],
      [inc('damage', 0.3)],
    ]);
    expect(second?.board.nodes.map((node) => [node.id, node.slot])).toEqual([
      ['fire.asc.inferno.n1', { at: 'asc', chain: 1, step: 0 }],
      ['fire.asc.inferno.n2', { at: 'asc', chain: 1, step: 1 }],
      ['fire.asc.inferno.final', { at: 'asc', chain: 1, step: 2 }],
    ]);
  });
});

describe('defineOuter', () => {
  it('builds the outer: 18 nodes with their ids, slots and kinds, 20 edges (§4.4)', () => {
    const spec = outerSpec('poison');
    const def = defineOuter(spec);
    expect(def.id).toBe('poison');
    expect(def.board.id).toBe('outer.poison');
    expect(def.board.branches).toEqual(['virulence', 'contagion']);
    expect(placed(def.board, 'outer.poison')).toEqual(OUTER_NODES);
    expect(def.board.edges).toHaveLength(20);
    expect(edgeSet(def.board.edges)).toEqual(expectedEdges('outer.poison', OUTER_EDGES));
    expect(byId(def.board, 'outer.poison.main.neurotoxin')?.answers).toEqual(['dasher']);
    for (const branch of ['virulence', 'contagion']) {
      for (const n of [1, 2, 3, 4]) {
        const node = byId(def.board, `outer.poison.${branch}.r${n}`);
        expect(node?.effects.modifiers[0]?.value, `${branch}.r${n}`).toBeCloseTo(n / 100, 12);
      }
    }
    expect([def.payload, def.skin, def.covers]).toEqual([null, spec.skin, spec.covers]);
  });
});

describe('defineHub', () => {
  it("places the hub's 24 nodes by D15's fixed table, each ranked spec in its slot", () => {
    const board = defineHub(HUB).board;
    expect(board.id).toBe('hub');
    expect(board.branches).toEqual(['might', 'defense', 'economy', 'echo', 'rules']);
    expect(placed(board, 'hub')).toEqual(HUB_NODES);
    const value = (id: string) => byId(board, `hub.${id}`)?.effects.modifiers[0]?.value;
    expect(['r1', 'r2', 'r3', 'r4', 'r5'].map((name) => value(`defense.${name}`))).toEqual([
      0.11, 0.12, 0.13, 0.14, 0.15,
    ]);
    expect(['r1', 'r2', 'r3', 'r4'].map((name) => value(`economy.${name}`))).toEqual([
      0.21, 0.22, 0.23, 0.24,
    ]);
    expect(['r1', 'r2', 'r3', 'r4'].map((name) => value(`echo.${name}`))).toEqual([
      0.31, 0.32, 0.33, 0.34,
    ]);
    expect(value('might.might')).toBe(0.1);
  });

  it('joins the closed ring and one spur per ring node: 24 edges', () => {
    const board = defineHub(HUB).board;
    expect(board.edges).toHaveLength(24);
    expect(edgeSet(board.edges)).toEqual(expectedEdges('hub', HUB_EDGES));
  });
});

describe('the default mastery targets (F7)', () => {
  it("gives the center's masteries scope 'center'", () => {
    const center = defineCharacter({ ...CARD, center: CENTER }).center as BoardDef;
    expect(masteryMods(center)).toEqual(
      [0, 1, 2].map(() => [{ stat: 'damage', kind: 'more', value: 0.04, scope: 'center' }]),
    );
  });

  it.each(OUTER_IDS)("gives outer.%s's masteries its archetype's tags, or its own scope", (o) => {
    const mod = { stat: 'damage', kind: 'more', value: 0.04, ...OUTER_MASTERY[o] };
    expect(masteryMods(defineOuter(outerSpec(o)).board)).toEqual([[mod], [mod]]);
  });

  it('keeps a target that is written', () => {
    const slots = {
      ...centerSlots('pandemic', 'wildfire', 'ember'),
      mastery: mastery({ tags: ['burn'] }),
    };
    const center = defineCharacter({
      ...CARD,
      center: {
        ...CENTER,
        branches: [centerBranch('spread', slots), ...CENTER.branches.slice(1)] as never,
      },
    }).center as BoardDef;
    expect(byId(center, 'fire.center.spread.mastery')?.effects.modifiers).toEqual([
      { stat: 'damage', kind: 'more', value: 0.04, tags: ['burn'] },
    ]);
    const outer = defineOuter({
      ...outerSpec('combo'),
      branches: [
        outerBranch('virulence', {
          ...outerSlots('a-one', 'b-one'),
          mastery: mastery({ scope: 'hub' }),
        }),
        outerBranch('contagion', outerSlots('a-two', 'b-two')),
      ],
    });
    expect(masteryMods(outer.board)).toEqual([
      [{ stat: 'damage', kind: 'more', value: 0.04, scope: 'hub' }],
      [{ stat: 'damage', kind: 'more', value: 0.04, scope: 'outer.combo' }],
    ]);
  });

  it('targets masteries only: 強化∞ and the ranked nodes keep their modifiers as written', () => {
    expect(byId(defineHub(HUB).board, 'hub.might.might')?.effects.modifiers).toEqual([
      { stat: 'damage', kind: 'more', value: 0.1 },
    ]);
    const center = defineCharacter({ ...CARD, center: CENTER }).center as BoardDef;
    expect(byId(center, 'fire.center.main.c1')?.effects.modifiers).toEqual([
      { stat: 'damage', kind: 'increased', value: 0.11 },
    ]);
  });

  it('names the target of every board kind', () => {
    expect(defaultMasteryTarget('ice.center')).toEqual({ scope: 'center' });
    expect(defaultMasteryTarget('outer.thorns')).toEqual({ tags: ['thorns'] });
    expect(defaultMasteryTarget('outer.greed')).toEqual({ scope: 'outer.greed' });
    expect(defaultMasteryTarget('fusion.summon.poison')).toEqual({ scope: 'fusion.summon.poison' });
    expect(defaultMasteryTarget('hub')).toEqual({ scope: 'hub' });
    expect(defaultMasteryTarget('fire.asc.incinerator')).toEqual({ scope: 'asc' });
  });
});

describe('a wrong slot is recorded, never thrown (V3 reports it)', () => {
  it('keeps a center slot holding the wrong template, and a missing one, with the edges', () => {
    const wrong = ranked('damage', 0.5, 4) as unknown as NodeSpec<'notable'>;
    const missing = undefined as unknown as NodeSpec<'ranked'>;
    const slots = { ...centerSlots('pandemic', 'wildfire', 'ember'), b: wrong, r4: missing };
    const branches = [centerBranch('spread', slots), ...CENTER.branches.slice(1)] as never;
    let center: BoardDef | null = null;
    expect(() => {
      center = defineCharacter({ ...CARD, center: { ...CENTER, branches } }).center;
    }).not.toThrow();
    const board = center as unknown as BoardDef;
    const b = board.nodes.find((node) => node.slot.at === 'centerBranch' && node.slot.step === 'b');
    expect(b).toMatchObject({ id: 'fire.center.spread.b', kind: 'ranked', ranks: 4 });
    expect(byId(board, 'fire.center.spread.r4')).toBeUndefined();
    expect(board.nodes).toHaveLength(39);
    expect(edgeSet(board.edges)).toEqual(
      expectedEdges(
        'fire.center',
        CENTER_EDGES.map((pair) => pair.replaceAll('spread.wildfire', 'spread.b')),
      ),
    );
  });

  it('names a missing center ★ by its clock, so the edges of each stay apart', () => {
    const keystones = [] as unknown as CenterSpec['keystones'];
    const center = defineCharacter({ ...CARD, center: { ...CENTER, keystones } })
      .center as BoardDef;
    expect(center.nodes).toHaveLength(38);
    expect(edgeSet(center.edges)).toEqual(
      expectedEdges(
        'fire.center',
        CENTER_EDGES.map((pair) =>
          pair
            .replace('main.inferno', 'main.keystone-2')
            .replace('main.volcano', 'main.keystone-10'),
        ),
      ),
    );
  });

  it('keeps an outer slot holding the wrong template, and a missing one', () => {
    const spec: OuterSpec = {
      ...outerSpec('poison'),
      answer: keystone('neurotoxin', {}) as unknown as NodeSpec<'notable'>,
      keystone: undefined as unknown as NodeSpec<'keystone'>,
      threshold: mastery() as unknown as NodeSpec<'threshold'>,
    };
    let board: BoardDef | null = null;
    expect(() => {
      board = defineOuter(spec).board;
    }).not.toThrow();
    const nodes = (board as unknown as BoardDef).nodes;
    expect(nodes).toHaveLength(17);
    expect(nodes.find((node) => node.id === 'outer.poison.main.neurotoxin')?.kind).toBe('keystone');
    expect(nodes.find((node) => node.id === 'outer.poison.main.threshold')?.kind).toBe('mastery');
    expect(
      nodes.some((node) => node.slot.at === 'outerEdge' && node.slot.place === 'keystone'),
    ).toBe(false);
    expect(edgeSet((board as unknown as BoardDef).edges)).toEqual(
      expectedEdges(
        'outer.poison',
        OUTER_EDGES.map((pair) => pair.replace('main.lethal-toxin', 'main.keystone')),
      ),
    );
  });

  it('keeps a hub slot holding the wrong template, and missing ones', () => {
    const spec = {
      ...HUB,
      might: notable('power', {}) as unknown as NodeSpec<'might'>,
      echo: { ranked: HUB.echo.ranked, notables: [] as unknown as HubSpec['echo']['notables'] },
    };
    let board: BoardDef | null = null;
    expect(() => {
      board = defineHub(spec).board;
    }).not.toThrow();
    const hub = board as unknown as BoardDef;
    expect(byId(hub, 'hub.might.might')?.kind).toBe('notable');
    expect(hub.nodes).toHaveLength(20);
    const spurs = ['multicast', 'reverb', 'kill-blast', 'nova'];
    expect(edgeSet(hub.edges)).toEqual(
      expectedEdges(
        'hub',
        HUB_EDGES.map((pair) =>
          spurs.reduce((edge, slug, n) => edge.replace(`echo.${slug}`, `echo.spur-${8 + n}`), pair),
        ),
      ),
    );
  });

  it('builds a half-written character, ascendancies included', () => {
    const half = {
      ...CARD,
      center: { ...CENTER, branches: [CENTER.branches[0]] },
      ascendancies: [ascendancy('incinerator', { n1: ascNode({}) } as never)],
    } as unknown as CharacterSpec;
    let def = null as unknown as ReturnType<typeof defineCharacter>;
    expect(() => {
      def = defineCharacter(half);
    }).not.toThrow();
    expect(def.center?.nodes).toHaveLength(20);
    expect(def.ascendancies?.[0].board.nodes.map((node) => node.id)).toEqual([
      'fire.asc.incinerator.n1',
    ]);
    expect(def.ascendancies?.[1].board.nodes).toEqual([]);
  });
});

describe('every id a builder writes is in the D4 grammar, on its own board', () => {
  it('holds for the center, an outer, the hub and the ascendancies', () => {
    const chain = ascendancy('incinerator', {
      n1: ascNode({}),
      n2: ascNode({}),
      final: ascFinal({}),
    });
    const def = defineCharacter({ ...CARD, center: CENTER, ascendancies: [chain, chain] });
    const boards = [
      def.center as BoardDef,
      ...(def.ascendancies ?? []).map((asc) => asc.board),
      defineOuter(outerSpec('poison')).board,
      defineHub(HUB).board,
    ];
    for (const board of boards) {
      for (const node of board.nodes) expect(parseNodeId(node.id)?.board, node.id).toBe(board.id);
    }
  });
});
