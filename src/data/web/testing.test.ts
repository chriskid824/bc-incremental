import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, OUTER_IDS, sourceOfNode } from '../sources';
import { parseNodeId, sourceOfBoard } from './ids';
import { BATCH_COUNTS } from './scope';
import type { Batch } from './scope';
import { CharacterDefSchema, FusionOverrideSchema, HubDefSchema, OuterDefSchema } from './schema';
import { fixtureContent } from './testing';
import { ROW_ENEMIES, SHAPE_IDS } from './types';
import type { BoardDef, Content, NodeSlot, WebNodeKind } from './types';

const BATCHES = ['B1', 'B2', 'B3', 'B4', 'B5'] as const satisfies readonly Batch[];

/** Every board of `content`: centers, ascendancies, the hub and the outers. */
function boardsOf(content: Content): BoardDef[] {
  return [
    ...CHARACTER_IDS.flatMap((c) => {
      const def = content.characters[c];
      return [
        ...(def.center === null ? [] : [def.center]),
        ...(def.ascendancies ?? []).map((asc) => asc.board),
      ];
    }),
    ...(content.hub === null ? [] : [content.hub.board]),
    ...OUTER_IDS.flatMap((o) => content.outers[o]?.board ?? []),
  ];
}

/** A slot as one string, so a board's slots can be compared as a set. */
const slotKey = (slot: NodeSlot): string => JSON.stringify(Object.values(slot));

/** The slots of each board kind, each once, with the kind of node it takes (§3.3, V3). */
const CENTER_SLOTS: [string, WebNodeKind][] = [
  [slotKey({ at: 'signature' }), 'signature'],
  ...([0, 1, 2] as const).flatMap((branch) =>
    (
      [
        ['r1', 'ranked'],
        ['r2', 'ranked'],
        ['a', 'notable'],
        ['r3', 'ranked'],
        ['r4', 'ranked'],
        ['b', 'notable'],
        ['r5', 'ranked'],
        ['r6', 'ranked'],
        ['c', 'notable'],
        ['mastery', 'mastery'],
      ] as const
    ).map(([step, kind]): [string, WebNodeKind] => [
      slotKey({ at: 'centerBranch', branch, step }),
      kind,
    ]),
  ),
  ...[1, 3, 5, 7, 9, 11].map((clock): [string, WebNodeKind] => [
    slotKey({ at: 'centerEdge', clock }),
    'ranked',
  ]),
  [slotKey({ at: 'centerEdge', clock: 2 }), 'keystone'],
  [slotKey({ at: 'centerEdge', clock: 10 }), 'keystone'],
  [slotKey({ at: 'centerEdge', clock: 6 }), 'threshold'],
];
const OUTER_SLOTS: [string, WebNodeKind][] = [
  [slotKey({ at: 'outerEntry' }), 'entry'],
  ...([1, -1] as const).flatMap((side) =>
    (
      [
        ['r1', 'ranked'],
        ['r2', 'ranked'],
        ['a', 'notable'],
        ['r3', 'ranked'],
        ['r4', 'ranked'],
        ['b', 'notable'],
        ['mastery', 'mastery'],
      ] as const
    ).map(([step, kind]): [string, WebNodeKind] => [
      slotKey({ at: 'outerBranch', side, step }),
      kind,
    ]),
  ),
  [slotKey({ at: 'outerEdge', place: 'answer' }), 'notable'],
  [slotKey({ at: 'outerEdge', place: 'keystone' }), 'keystone'],
  [slotKey({ at: 'outerEdge', place: 'threshold' }), 'threshold'],
];
/** D15's table: 強化∞ at ring 0, the ★ at spurs 0 and 4, ranked spurs at 3 and 6, ◆ elsewhere. */
const HUB_SLOTS: [string, WebNodeKind][] = Array.from({ length: 12 }, (_, clock) => [
  [slotKey({ at: 'hubRing', clock }), clock === 0 ? 'might' : 'ranked'],
  [
    slotKey({ at: 'hubSpur', clock }),
    clock === 0 || clock === 4 ? 'keystone' : clock === 3 || clock === 6 ? 'ranked' : 'notable',
  ],
]).flat() as [string, WebNodeKind][];
const ASC_SLOTS = (chain: 0 | 1): [string, WebNodeKind][] => [
  [slotKey({ at: 'asc', chain, step: 0 }), 'asc'],
  [slotKey({ at: 'asc', chain, step: 1 }), 'asc'],
  [slotKey({ at: 'asc', chain, step: 2 }), 'ascFinal'],
];

const sorted = (pairs: [string, WebNodeKind][]) => [...pairs].sort();
const slotsOf = (board: BoardDef): [string, WebNodeKind][] =>
  sorted(board.nodes.map((node) => [slotKey(node.slot), node.kind]));

/** What each batch variant registers, the batch and those before it (impl:585-589). */
const VARIANTS: Record<
  Batch,
  {
    centers: string[];
    hub: boolean;
    outers: string[];
    ascendancies: string[];
    overrides: string[];
    written: number;
    pairs: number;
  }
> = {
  B1: {
    centers: ['fire'],
    hub: true,
    outers: ['poison', 'crit', 'ice', 'summon'],
    ascendancies: [],
    overrides: ['fire.ice', 'fire.summon', 'fire.poison'],
    written: 40 + 24 + 4 * 18,
    pairs: 4,
  },
  B2: {
    centers: ['fire', 'summon'],
    hub: true,
    outers: ['fire', 'poison', 'crit', 'ice', 'summon'],
    ascendancies: ['fire', 'summon'],
    overrides: ['fire.ice', 'fire.summon', 'summon.fire', 'summon.ice', 'fire.poison'],
    written: 2 * 40 + 24 + 5 * 18 + 4 * 3,
    pairs: 8,
  },
  B3: {
    centers: ['fire', 'ice', 'summon'],
    hub: true,
    outers: ['fire', 'poison', 'bleed', 'lightning', 'crit', 'ice', 'summon', 'barrage'],
    ascendancies: ['fire', 'summon'],
    overrides: [
      'fire.ice',
      'fire.lightning',
      'fire.summon',
      'ice.fire',
      'ice.lightning',
      'ice.summon',
      'summon.fire',
      'summon.ice',
      'summon.lightning',
      'fire.poison',
    ],
    written: 3 * 40 + 24 + 8 * 18 + 4 * 3,
    pairs: 21,
  },
  B4: {
    centers: ['fire', 'ice', 'lightning', 'summon'],
    hub: true,
    outers: [...OUTER_IDS],
    ascendancies: ['fire', 'summon'],
    overrides: [
      'fire.ice',
      'fire.lightning',
      'fire.summon',
      'ice.fire',
      'ice.lightning',
      'ice.summon',
      'lightning.fire',
      'lightning.ice',
      'lightning.summon',
      'summon.fire',
      'summon.ice',
      'summon.lightning',
      'ice.aura',
      'lightning.aura',
      'fire.poison',
    ],
    written: 4 * 40 + 24 + 12 * 18 + 4 * 3,
    pairs: 44,
  },
  B5: {
    centers: ['fire', 'ice', 'lightning', 'summon'],
    hub: true,
    outers: [...OUTER_IDS],
    ascendancies: ['fire', 'ice', 'lightning', 'summon'],
    overrides: [
      'fire.ice',
      'fire.lightning',
      'fire.summon',
      'ice.fire',
      'ice.lightning',
      'ice.summon',
      'lightning.fire',
      'lightning.ice',
      'lightning.summon',
      'summon.fire',
      'summon.ice',
      'summon.lightning',
      'ice.aura',
      'lightning.aura',
      'fire.poison',
    ],
    written: 4 * 40 + 24 + 12 * 18 + 8 * 3,
    pairs: 44,
  },
};

/** The rule each hand core and rule override borrows (F26), as gd numbers it. */
const ETERNAL_FLAME = { id: 'eternalFlame', durationMore: -0.5 };
const STEADY_AIM = { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'shot' };
const OVERLOAD = { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2, chainMore: 3.5 };
const GLASS_CANNON = { id: 'glassCannon', damageMore: 1 };
/** 火毒's 瘟疫爆彈 as §4.1 writes it (F24): the one override that adds triggers. */
const PLAGUE_BOMB = {
  on: 'kill',
  when: [{ victimHas: 'poison' }, { killedBy: 'burn' }],
  do: [{ kind: 'spreadAilment', ailment: 'poison', radius: 90, effect: 0.5 }],
};
const OVERRIDES = {
  'fire.ice': { rule: STEADY_AIM },
  'fire.lightning': { rule: OVERLOAD },
  'fire.summon': { rule: GLASS_CANNON },
  'ice.fire': { rule: ETERNAL_FLAME },
  'ice.lightning': { rule: OVERLOAD },
  'ice.summon': { rule: GLASS_CANNON },
  'lightning.fire': { rule: ETERNAL_FLAME },
  'lightning.ice': { rule: STEADY_AIM },
  'lightning.summon': { rule: GLASS_CANNON },
  'summon.fire': { rule: ETERNAL_FLAME },
  'summon.ice': { rule: STEADY_AIM },
  'summon.lightning': { rule: OVERLOAD },
  'ice.aura': { addRules: [STEADY_AIM] },
  'lightning.aura': { addRules: [OVERLOAD] },
  'fire.poison': { addTriggers: [PLAGUE_BOMB] },
};

/** gd §4's accents and §6.5's bonus forms; null payloads on the four archetype outers (AMB30). */
const OUTER_CARDS = {
  fire: [0xff7a2f, null],
  poison: [0x3fd08a, 'status'],
  bleed: [0xd7263d, 'status'],
  lightning: [0xb48cff, null],
  combo: [0xff4fb8, 'none'],
  crit: [0xfff4d6, 'inPayload'],
  ice: [0x8fe3ff, null],
  aura: [0xffd6ec, 'inZone'],
  thorns: [0x8a8f98, 'inPayload'],
  summon: [0x9bf25c, null],
  barrage: [0xffb627, 'inPayload'],
  greed: [0xffd23f, 'none'],
} as const;

describe('fixtureContent() writes every slot of the full web (F26)', () => {
  const content = fixtureContent();

  it('writes 4 × 40 center, 24 hub, 12 × 18 outer and 8 × 3 ascendancy nodes: 424', () => {
    const boards = boardsOf(content);
    const count = (prefix: string) =>
      boards.filter((board) => board.id.includes(prefix)).flatMap((board) => board.nodes).length;
    expect(count('.center')).toBe(4 * 40);
    expect(count('hub')).toBe(24);
    expect(count('outer.')).toBe(12 * 18);
    expect(count('.asc.')).toBe(8 * 3);
    const ids = boards.flatMap((board) => board.nodes.map((node) => node.id));
    expect(ids).toHaveLength(424);
    expect(new Set(ids).size).toBe(424);
  });

  it.each(CHARACTER_IDS)("fills every slot of %s's center and ascendancies with its kind", (c) => {
    const def = content.characters[c];
    expect(def.center?.id).toBe(`${c}.center`);
    expect(slotsOf(def.center as BoardDef)).toEqual(sorted(CENTER_SLOTS));
    expect(def.ascendancies?.map((asc) => slotsOf(asc.board))).toEqual([
      sorted(ASC_SLOTS(0)),
      sorted(ASC_SLOTS(1)),
    ]);
  });

  it.each(OUTER_IDS)('fills every slot of outer.%s with its kind', (o) => {
    expect(content.outers[o]?.board.id).toBe(`outer.${o}`);
    expect(slotsOf(content.outers[o]?.board as BoardDef)).toEqual(sorted(OUTER_SLOTS));
  });

  it("fills every slot of the hub's fixed table with its kind", () => {
    expect(slotsOf(content.hub?.board as BoardDef)).toEqual(sorted(HUB_SLOTS));
  });

  it('uses the real character and outer ids: every node id parses to its own board and source', () => {
    expect(Object.keys(content.characters)).toEqual([...CHARACTER_IDS]);
    expect(Object.keys(content.outers)).toEqual([...OUTER_IDS]);
    for (const board of boardsOf(content)) {
      for (const node of board.nodes) {
        expect(node.board, node.id).toBe(board.id);
        expect(parseNodeId(node.id)?.board, node.id).toBe(board.id);
        expect(sourceOfNode(node.id), node.id).toBe(sourceOfBoard(board.id));
      }
    }
    for (const o of OUTER_IDS) expect(content.outers[o]?.id).toBe(o);
    for (const c of CHARACTER_IDS) expect(content.characters[c].id).toBe(c);
  });

  it('holds the 12 hand pairs with their rules, the 2 rule overrides and 瘟疫爆彈, nothing calibrated', () => {
    expect(content.overrides).toEqual(OVERRIDES);
    expect(Object.keys(content.overrides)).toEqual(Object.keys(OVERRIDES));
    expect([content.calibrated, content.acceptedFails]).toEqual([{}, {}]);
  });

  it("splits the 44 pairs as §8's C6.4 row counts: 12 hand, 29 template, 3 template with override", () => {
    const archetypes: readonly string[] = CHARACTER_IDS;
    const pairs = CHARACTER_IDS.flatMap((c) =>
      OUTER_IDS.filter((o) => o !== c).map((o) => ({
        o,
        override: content.overrides[`${c}.${o}`],
      })),
    );
    const hand = pairs.filter(({ o }) => archetypes.includes(o));
    const overridden = pairs.filter(({ o, override }) => !archetypes.includes(o) && override);
    expect([pairs.length, hand.length, overridden.length]).toEqual([44, 12, 3]);
    expect(pairs.length - hand.length - overridden.length).toBe(29);
    expect(hand.every(({ override }) => override?.rule !== undefined)).toBe(true);
  });

  it.each(CHARACTER_IDS)("puts each rule on one board of %s's web", (c) => {
    const rules = Object.entries(content.overrides)
      .filter(([key]) => key.startsWith(`${c}.`))
      .flatMap(([, override]) => [
        ...(override?.rule === undefined ? [] : [override.rule]),
        ...(override?.addRules ?? []),
      ]);
    const nodeRules = boardsOf(content).flatMap((board) =>
      board.nodes.flatMap((node) => node.effects.rules),
    );
    expect(nodeRules).toEqual([]);
    expect(rules.length).toBe(c === 'ice' || c === 'lightning' ? 4 : 3);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
  });

  it('passes the strict schemas of C6.2', () => {
    for (const c of CHARACTER_IDS) {
      expect(CharacterDefSchema.safeParse(content.characters[c]).error, c).toBeUndefined();
    }
    for (const o of OUTER_IDS) {
      expect(OuterDefSchema.safeParse(content.outers[o]).error, o).toBeUndefined();
    }
    expect(HubDefSchema.safeParse(content.hub).error).toBeUndefined();
    for (const [key, override] of Object.entries(content.overrides)) {
      expect(FusionOverrideSchema.safeParse(override).error, key).toBeUndefined();
    }
  });

  it('gives every character a valid card: its reveal sets, construct and a full enemy row', () => {
    const constructs = CHARACTER_IDS.map((c) => content.characters[c].construct);
    expect(new Set(constructs).size).toBe(4);
    for (const c of CHARACTER_IDS) {
      const def = content.characters[c];
      const outers = [...def.recommendedOuter, ...def.revealAt15];
      expect(new Set(outers).size, c).toBe(6);
      expect(outers, c).not.toContain(c);
      expect(Object.keys(def.enemyRow), c).toEqual([...ROW_ENEMIES]);
      expect(def.defaultOrder, c).toEqual([]);
    }
  });

  it.each(CHARACTER_IDS)('answers every ✗ of %s but 寶藏 on its center (V18)', (c) => {
    const def = content.characters[c];
    const weak = ROW_ENEMIES.filter((e) => e !== 'treasure' && def.enemyRow[e] === 'weak');
    const answered = new Set(def.center?.nodes.flatMap((node) => node.answers));
    expect(weak.length).toBeGreaterThan(0);
    for (const enemy of weak) expect(answered.has(enemy), enemy).toBe(true);
  });

  it.each(OUTER_IDS)("answers what outer.%s's covers mark ◆, on its answer ◆ (V18)", (o) => {
    const outer = content.outers[o];
    const covered = ROW_ENEMIES.filter((e) => outer?.covers[e] === 'answer');
    const answer = outer?.board.nodes.find(
      (node) => node.slot.at === 'outerEdge' && node.slot.place === 'answer',
    )?.answers;
    expect(covered.length).toBeGreaterThan(0);
    expect(answer).toEqual(covered);
    expect(outer?.board.nodes.flatMap((node) => node.answers)).toEqual(covered);
  });

  it.each(OUTER_IDS)("gives outer.%s gd's skin and a payload unless it is an archetype's", (o) => {
    const outer = content.outers[o];
    const [accent, bonus] = OUTER_CARDS[o];
    expect(outer?.skin).toEqual({ accent, shape: SHAPE_IDS[OUTER_IDS.indexOf(o)] });
    if (bonus === null) {
      expect(outer?.payload).toBeNull();
    } else {
      expect(outer?.payload?.bonus?.form ?? 'none').toBe(bonus);
      expect(outer?.payload?.effects.length).toBeGreaterThan(0);
      expect(outer?.payload?.coefScalesBonus ?? false).toBe(o === 'combo' || o === 'aura');
    }
  });

  it("gives every ranked node D13a's default rank and the named nodes no effects", () => {
    for (const node of boardsOf(content).flatMap((board) => board.nodes)) {
      if (node.kind === 'ranked') {
        expect(node.ranks, node.id).toBe(3);
        expect(node.effects.modifiers, node.id).toEqual([
          { stat: 'damage', kind: 'increased', value: 0.1 },
        ]);
      } else if (node.kind !== 'mastery' && node.kind !== 'might') {
        expect(node.effects, node.id).toEqual({
          modifiers: [],
          triggers: [],
          conversions: [],
          emitters: [],
          rules: [],
        });
      }
    }
  });

  it('builds the same content on every call, as fresh objects', () => {
    const again = fixtureContent();
    expect(again).toEqual(content);
    expect(again.characters.fire.center).not.toBe(content.characters.fire.center);
  });
});

describe('each batch variant registers exactly its batch blocks (impl:585-589; F26)', () => {
  it.each(BATCHES)('%s', (batch) => {
    const content = fixtureContent(batch);
    const expected = VARIANTS[batch];
    const centers = CHARACTER_IDS.filter((c) => content.characters[c].center !== null);
    const chains = CHARACTER_IDS.filter((c) => content.characters[c].ascendancies !== null);
    expect(centers).toEqual(expected.centers);
    expect(content.hub !== null).toBe(expected.hub);
    expect(Object.keys(content.outers)).toEqual(expected.outers);
    expect(chains).toEqual(expected.ascendancies);
    expect(Object.keys(content.overrides)).toEqual(expected.overrides);
    expect(Object.keys(content.characters)).toEqual([...CHARACTER_IDS]);
    const written = boardsOf(content).flatMap((board) => board.nodes).length;
    expect(written).toBe(expected.written);
    // The pairs C6.5 assembles, 5 fusion nodes each, complete BATCH_COUNTS (B-2).
    const pairs = centers.flatMap((c) => Object.keys(content.outers).filter((o) => o !== c));
    expect(pairs).toHaveLength(expected.pairs);
    expect(written + 5 * pairs.length).toBe(BATCH_COUNTS[batch]);
  });

  it('defaults to the full web, B5', () => {
    expect(fixtureContent()).toEqual(fixtureContent('B5'));
  });

  it('registers no block for a variant that is not a batch, and does not throw', () => {
    const content = fixtureContent('B6' as Batch);
    expect(CHARACTER_IDS.map((c) => content.characters[c].center)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect([content.outers, content.hub, content.overrides]).toEqual([{}, null, {}]);
  });
});
