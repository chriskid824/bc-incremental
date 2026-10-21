import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { EffectSpecSchema } from '../schema';
import type { Modifier } from '../stats';
import {
  AscendancyDefSchema,
  BoardIdSchema,
  BonusSpecSchema,
  CalibrationEntrySchema,
  CharacterDefSchema,
  FusionKeySchema,
  FusionOverrideSchema,
  HubDefSchema,
  NodeSlotSchema,
  OuterDefSchema,
  PayloadEffectSchema,
  WebScopeSchema,
} from './schema';
import type {
  AscendancyDef,
  BoardDef,
  BoardId,
  BonusSpec,
  CalibrationEntry,
  CharacterDef,
  FusionOverride,
  HubDef,
  NodeEffects,
  NodeSlot,
  OuterDef,
  PayloadEffect,
  RankSpec,
  Ranks,
  RowEnemy,
  WebNode,
  WebNodeKind,
  WebScope,
} from './types';

/** The paths of the issues `schema` finds in `value`, each joined by '.'; none when it parses. */
function issuePaths(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

/** The issues `schema` finds in `value`, each as its path joined by '.' and its code. */
function issueCodes(schema: z.ZodType, value: unknown): [string, string][] {
  const result = schema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => [issue.path.join('.'), issue.code]);
}

interface NodeOptions {
  readonly ranks?: Ranks;
  readonly effects?: Partial<NodeEffects>;
  readonly answers?: readonly RowEnemy[];
}

function node(
  id: string,
  kind: WebNodeKind,
  board: BoardId,
  slot: NodeSlot,
  options: NodeOptions = {},
): WebNode {
  return {
    id,
    kind,
    board,
    slot,
    ranks: options.ranks ?? 1,
    effects: {
      modifiers: [],
      triggers: [],
      conversions: [],
      emitters: [],
      rules: [],
      ...options.effects,
    },
    answers: options.answers ?? [],
  };
}

const BURN_DAMAGE: Modifier = { stat: 'damage', kind: 'increased', value: 0.05, tags: ['burn'] };

const ROOT = node('fire.center.main.signature', 'signature', 'fire.center', { at: 'signature' });
const SPREAD_R1 = node(
  'fire.center.spread.r1',
  'ranked',
  'fire.center',
  { at: 'centerBranch', branch: 0, step: 'r1' },
  { ranks: 3, effects: { modifiers: [BURN_DAMAGE] } },
);
const PANDEMIC = node(
  'fire.center.spread.pandemic',
  'notable',
  'fire.center',
  { at: 'centerBranch', branch: 0, step: 'a' },
  {
    effects: {
      triggers: [
        {
          on: 'diedWithAilment',
          when: [{ victimHas: 'burn' }],
          do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 250, effect: 0.4 }],
        },
      ],
    },
    answers: ['regenerator'],
  },
);
const VOLCANO = node(
  'fire.center.main.volcano',
  'keystone',
  'fire.center',
  { at: 'centerEdge', clock: 2 },
  { effects: { rules: [{ id: 'volcano', periodSec: 3, radiusMult: 3, damageMult: 5 }] } },
);
const CONNECTOR = node(
  'fire.center.main.c1',
  'ranked',
  'fire.center',
  { at: 'centerEdge', clock: 1 },
  { ranks: 3, effects: { conversions: [{ to: 'burn', fraction: 0.2 }] } },
);

const CENTER: BoardDef = {
  id: 'fire.center',
  nodes: [ROOT, SPREAD_R1, PANDEMIC, VOLCANO, CONNECTOR],
  edges: [
    [ROOT.id, SPREAD_R1.id],
    [SPREAD_R1.id, PANDEMIC.id],
    [ROOT.id, CONNECTOR.id],
  ],
  branches: ['spread', 'eruption', 'ember'],
};

function ascendancy(slug: string, chain: 0 | 1): AscendancyDef {
  const board: BoardId = `fire.asc.${slug}`;
  return {
    slug,
    board: {
      id: board,
      nodes: [
        node(`${board}.n1`, 'asc', board, { at: 'asc', chain, step: 0 }),
        node(`${board}.n2`, 'asc', board, { at: 'asc', chain, step: 1 }),
        node(`${board}.final`, 'ascFinal', board, { at: 'asc', chain, step: 2 }),
      ],
      edges: [
        [`${board}.n1`, `${board}.n2`],
        [`${board}.n2`, `${board}.final`],
      ],
      branches: [],
    },
  };
}

const INCINERATOR = ascendancy('incinerator', 0);
const [INCINERATOR_N1, INCINERATOR_N2, INCINERATOR_FINAL] = INCINERATOR.board.nodes as [
  WebNode,
  WebNode,
  WebNode,
];

const CHARACTER: CharacterDef = {
  id: 'fire',
  archetype: 'fire',
  nameKey: 'web.char.fire.name',
  introKey: 'web.char.fire.intro',
  color: 0xff7a2f,
  signature: { id: 'magmaBomb' },
  centerEvent: 'explode',
  center: CENTER,
  ascendancies: [INCINERATOR, ascendancy('pyre', 1)],
  recommendedOuter: ['ice', 'crit', 'summon'],
  revealAt15: ['poison', 'lightning', 'thorns'],
  enemyRow: {
    triangle: 'strong',
    square: 'strong',
    pentagon: 'even',
    shielder: 'weak',
    regenerator: 'even',
    dasher: 'weak',
    shooter: 'even',
    summoner: 'strong',
    treasure: 'weak',
    boss: 'even',
  },
  difficulty: 1,
  construct: 'magmaCore',
  arena: 'fire',
  defaultOrder: [SPREAD_R1.id, SPREAD_R1.id, PANDEMIC.id],
};

/** A character whose batch has not landed: 「製作中」. */
const UNBUILT: CharacterDef = {
  ...CHARACTER,
  id: 'ice',
  archetype: 'ice',
  nameKey: 'web.char.ice.name',
  introKey: 'web.char.ice.intro',
  color: 0x8fe3ff,
  signature: { id: 'iceFan' },
  centerEvent: 'freeze',
  center: null,
  ascendancies: null,
  recommendedOuter: ['fire', 'poison', 'crit'],
  revealAt15: ['lightning', 'bleed', 'summon'],
  difficulty: 2,
  construct: 'frostCrystal',
  arena: 'ice',
  defaultOrder: [],
};

const MIGHT = node(
  'hub.might.might',
  'might',
  'hub',
  { at: 'hubRing', clock: 0 },
  { ranks: 'unlimited', effects: { modifiers: [{ stat: 'damage', kind: 'more', value: 0.1 }] } },
);
const DEFENSE_R1 = node(
  'hub.defense.r1',
  'ranked',
  'hub',
  { at: 'hubRing', clock: 1 },
  { ranks: 5 },
);
const SECOND_LIFE = node('hub.defense.second-life', 'notable', 'hub', { at: 'hubSpur', clock: 1 });

const HUB: HubDef = {
  board: {
    id: 'hub',
    nodes: [MIGHT, DEFENSE_R1, SECOND_LIFE],
    edges: [
      [MIGHT.id, DEFENSE_R1.id],
      [DEFENSE_R1.id, SECOND_LIFE.id],
    ],
    branches: ['might', 'defense', 'economy', 'echo', 'rules'],
  },
};

const FUSION_RANK: RankSpec = {
  modifiers: [{ stat: 'damage', kind: 'increased', value: 0.1, scope: 'fusion' }],
  ranks: 3,
};

/** crit's payload (docs/v3 C6 design D11): a slash written without the event's placement. */
const CRIT_SLASH: PayloadEffect = {
  kind: 'slashLine',
  length: 300,
  width: 40,
  damagePct: 1,
  alwaysCrit: true,
  critScale: 1,
};

const CRIT_ENTRY = node('outer.crit.main.entry', 'entry', 'outer.crit', { at: 'outerEntry' });
const CRIT_R1 = node(
  'outer.crit.precision.r1',
  'ranked',
  'outer.crit',
  { at: 'outerBranch', side: 1, step: 'r1' },
  { ranks: 4, effects: { modifiers: [{ stat: 'critChance', kind: 'flat', value: 0.02 }] } },
);
const ARMOR_BREAK = node(
  'outer.crit.main.armor-break',
  'notable',
  'outer.crit',
  { at: 'outerEdge', place: 'answer' },
  { answers: ['shielder'] },
);

const OUTER: OuterDef = {
  id: 'crit',
  board: {
    id: 'outer.crit',
    nodes: [CRIT_ENTRY, CRIT_R1, ARMOR_BREAK],
    edges: [
      [CRIT_ENTRY.id, CRIT_R1.id],
      [CRIT_ENTRY.id, ARMOR_BREAK.id],
    ],
    branches: ['precision', 'lethality'],
  },
  payload: {
    type: 'placement',
    effects: [CRIT_SLASH],
    perEvent: { chainJump: [{ ...CRIT_SLASH, toward: 'along' }] },
    bonus: { form: 'inPayload' },
    ranks: [FUSION_RANK, FUSION_RANK, FUSION_RANK],
  },
  skin: { accent: 0xffd34d, shape: 'slash' },
  covers: { shielder: 'answer', boss: 'helps' },
};

/** An archetype outer, which feeds no template fusion (AMB30). */
const ARCHETYPE_OUTER: OuterDef = {
  ...OUTER,
  id: 'ice',
  board: { ...OUTER.board, id: 'outer.ice', nodes: [], edges: [] },
  payload: null,
  skin: { accent: 0x8fe3ff, shape: 'crystal' },
  covers: {},
};

const HAND_OVERRIDE: FusionOverride = {
  rule: { id: 'chainBlast', radius: 40, damagePct: 0.5, perBomb: 2 },
  ranks: [FUSION_RANK, FUSION_RANK, FUSION_RANK],
};

/** 瘟疫爆彈 as data: a transfer kill trigger added after the core's (docs/v3 C6 design D12). */
const TEMPLATE_OVERRIDE: FusionOverride = {
  addTriggers: [
    {
      on: 'kill',
      when: [{ victimHas: 'poison' }],
      do: [{ kind: 'spreadAilment', ailment: 'poison', radius: 150, effect: 0.5 }],
    },
  ],
  bonus: null,
  modifiers: [BURN_DAMAGE],
  skin: { accent: 0x88ff00 },
};

const CALIBRATION: CalibrationEntry = {
  coef: 1.35,
  status: 'ok',
  median: 1.2,
  min: 1.12,
  max: 1.28,
  seeds: 8,
  startWave: 1,
  digest: '3f9a0c1d',
};

const DEMO_SCOPE: WebScope = {
  name: 'demoA',
  characters: ['fire', 'summon'],
  outers: ['fire', 'ice', 'poison', 'crit', 'summon'],
  deferredFusions: [],
  waveCap: 40,
};
const FULL_SCOPE: WebScope = {
  name: 'full',
  characters: 'all',
  outers: 'all',
  deferredFusions: ['fire.greed'],
  waveCap: null,
};

describe('web content schemas', () => {
  it.each([
    ['a character', CharacterDefSchema, CHARACTER],
    ['a character not built yet', CharacterDefSchema, UNBUILT],
    ['an ascendancy', AscendancyDefSchema, INCINERATOR],
    ['the hub', HubDefSchema, HUB],
    ['an outer', OuterDefSchema, OUTER],
    ['an archetype outer without a payload', OuterDefSchema, ARCHETYPE_OUTER],
    ['a hand fusion override', FusionOverrideSchema, HAND_OVERRIDE],
    ['a template fusion override', FusionOverrideSchema, TEMPLATE_OVERRIDE],
    ['an empty fusion override', FusionOverrideSchema, {}],
    ['a calibration entry', CalibrationEntrySchema, CALIBRATION],
    ['the Demo scope', WebScopeSchema, DEMO_SCOPE],
    ['the full scope', WebScopeSchema, FULL_SCOPE],
  ] as const)('accepts %s', (_label, schema, value) => {
    expect(issuePaths(schema, value)).toEqual([]);
    expect(schema.parse(value)).toEqual(value);
  });

  it.each([
    // An unknown field: what the M1 node or impl's shapes carry and v3 keeps elsewhere.
    [
      'a character with a name, which i18n holds',
      CharacterDefSchema,
      { ...CHARACTER, name: '熔核' },
      '',
    ],
    [
      'a node with a position, which the layout computes',
      CharacterDefSchema,
      { ...CHARACTER, center: { ...CENTER, nodes: [{ ...ROOT, pos: { x: 0, y: 0 } }] } },
      'center.nodes.0',
    ],
    [
      'a board with links on a node, which the board holds as edges',
      HubDefSchema,
      { board: { ...HUB.board, nodes: [{ ...MIGHT, links: [DEFENSE_R1.id] }] } },
      'board.nodes.0',
    ],
    ['an ascendancy with a name', AscendancyDefSchema, { ...INCINERATOR, name: 'Incinerator' }, ''],
    [
      'a payload naming its outer, which OuterDef holds',
      OuterDefSchema,
      { ...OUTER, payload: { ...OUTER.payload, outer: 'crit' } },
      'payload',
    ],
    ['an override with a coef, which calibration sets', FusionOverrideSchema, { coef: 2 }, ''],
    [
      'an override skin with a colour',
      FusionOverrideSchema,
      { skin: { accent: 0x88ff00, color: 0xffffff } },
      'skin',
    ],
    ['a calibration entry with a mean', CalibrationEntrySchema, { ...CALIBRATION, mean: 1.2 }, ''],
    ['a scope with a flag', WebScopeSchema, { ...DEMO_SCOPE, demo: true }, ''],
  ] as const)('rejects an unknown field: %s', (_label, schema, value, path) => {
    expect(issuePaths(schema, value)).toEqual([path]);
  });

  it.each([
    [
      'a center node of an M1 kind',
      CharacterDefSchema,
      { ...CHARACTER, center: { ...CENTER, nodes: [{ ...SPREAD_R1, kind: 'small' }] } },
      'center.nodes.0.kind',
    ],
    [
      'a slot of no kind',
      CharacterDefSchema,
      { ...CHARACTER, center: { ...CENTER, nodes: [{ ...CONNECTOR, slot: { at: 'spoke' } }] } },
      'center.nodes.0.slot.at',
    ],
    [
      'a construct of no character',
      CharacterDefSchema,
      { ...CHARACTER, construct: 'magma' },
      'construct',
    ],
    [
      'an ascendancy node of engine kind',
      AscendancyDefSchema,
      {
        ...INCINERATOR,
        board: { ...INCINERATOR.board, nodes: [{ ...INCINERATOR_N1, kind: 'ascNotable' }] },
      },
      'board.nodes.0.kind',
    ],
    [
      'a hub gate, which no template builds',
      HubDefSchema,
      { board: { ...HUB.board, nodes: [{ ...SECOND_LIFE, kind: 'gate' }] } },
      'board.nodes.0.kind',
    ],
    [
      'an outer payload of no type',
      OuterDefSchema,
      { ...OUTER, payload: { ...OUTER.payload, type: 'aura' } },
      'payload.type',
    ],
    [
      'a payload effect of no kind',
      OuterDefSchema,
      {
        ...OUTER,
        payload: { ...OUTER.payload, effects: [{ kind: 'spawnDrone', durationSec: 4 }] },
      },
      'payload.effects.0.kind',
    ],
    [
      'an override bonus of no form',
      FusionOverrideSchema,
      { bonus: { form: 'flat', value: 0.2 } },
      'bonus.form',
    ],
    [
      'a calibration status of no kind',
      CalibrationEntrySchema,
      { ...CALIBRATION, status: 'fail' },
      'status',
    ],
    [
      'a scope listing no outer',
      WebScopeSchema,
      { ...DEMO_SCOPE, outers: ['fire', 'cirt'] },
      'outers',
    ],
  ] as const)('rejects a wrong kind: %s', (_label, schema, value, path) => {
    expect(issuePaths(schema, value)).toEqual([path]);
  });

  it.each([
    [
      'an enemy row without its boss column',
      CharacterDefSchema,
      {
        ...CHARACTER,
        enemyRow: Object.fromEntries(
          Object.entries(CHARACTER.enemyRow).filter(([enemy]) => enemy !== 'boss'),
        ),
      },
      'enemyRow.boss',
    ],
    [
      'a center node without its slot',
      CharacterDefSchema,
      { ...CHARACTER, center: { ...CENTER, nodes: [{ ...SPREAD_R1, slot: undefined }] } },
      'center.nodes.0.slot',
    ],
    [
      'a branch slot without its step',
      CharacterDefSchema,
      {
        ...CHARACTER,
        center: { ...CENTER, nodes: [{ ...SPREAD_R1, slot: { at: 'centerBranch', branch: 0 } }] },
      },
      'center.nodes.0.slot.step',
    ],
    [
      'an ascendancy slot without its chain',
      AscendancyDefSchema,
      {
        ...INCINERATOR,
        board: {
          ...INCINERATOR.board,
          nodes: [
            INCINERATOR_N1,
            INCINERATOR_N2,
            { ...INCINERATOR_FINAL, slot: { at: 'asc', step: 2 } },
          ],
        },
      },
      'board.nodes.2.slot.chain',
    ],
    [
      'a ring slot without its clock',
      HubDefSchema,
      { board: { ...HUB.board, nodes: [{ ...MIGHT, slot: { at: 'hubRing' } }] } },
      'board.nodes.0.slot.clock',
    ],
    [
      'an outer node without its slot',
      OuterDefSchema,
      { ...OUTER, board: { ...OUTER.board, nodes: [{ ...CRIT_R1, slot: undefined }] } },
      'board.nodes.0.slot',
    ],
    [
      'a payload with two fusion ranks of three',
      OuterDefSchema,
      { ...OUTER, payload: { ...OUTER.payload, ranks: [FUSION_RANK, FUSION_RANK] } },
      'payload.ranks',
    ],
    [
      'an override with two fusion ranks of three',
      FusionOverrideSchema,
      { ranks: [FUSION_RANK, FUSION_RANK] },
      'ranks',
    ],
    [
      'a calibration entry without its digest',
      CalibrationEntrySchema,
      { ...CALIBRATION, digest: undefined },
      'digest',
    ],
    [
      'a scope without its deferred fusions',
      WebScopeSchema,
      { ...DEMO_SCOPE, deferredFusions: undefined },
      'deferredFusions',
    ],
  ] as const)('rejects a missing slot: %s', (_label, schema, value, path) => {
    expect(issuePaths(schema, value)).toEqual([path]);
  });

  it.each([
    ['toward on a slash', { ...CRIT_SLASH, toward: 'outward' }],
    ['from on a slash', { ...CRIT_SLASH, from: 'target' }],
    [
      'from on projectiles',
      { kind: 'projectiles', count: 4, aim: 'radial', damagePct: 0.5, from: 'player' },
    ],
    ['at on a nova', { kind: 'nova', radius: 120, damagePct: 1, tags: ['thorns'], at: 'event' }],
  ] as const)('rejects a placement field on a payload effect: %s', (_label, effect) => {
    expect(
      issuePaths(OuterDefSchema, { ...OUTER, payload: { ...OUTER.payload, effects: [effect] } }),
    ).toEqual(['payload.effects.0']);
    const issue = PayloadEffectSchema.safeParse(effect).error?.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
  });
});

describe('PayloadEffectSchema', () => {
  it.each([
    ['a slash, placed by the event', CRIT_SLASH],
    ['radial projectiles', { kind: 'projectiles', count: 4, aim: 'radial', damagePct: 0.5 }],
    ['a thorns nova', { kind: 'nova', radius: 120, damagePct: 1, tags: ['thorns'] }],
    ['poison', { kind: 'applyAilment', ailment: 'poison', stacks: 2 }],
    ['frost', { kind: 'addFrost', amount: 0.25 }],
    ['a chain bolt', { kind: 'chainBolt', jumps: 2, damagePct: 0.5 }],
    ['a zone', { kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0.5 }],
    ['a coin', { kind: 'coinHit', multiplier: 10, ignoreShield: true }],
    ['a burn spread', { kind: 'spreadAilment', ailment: 'burn', radius: 100, effect: 0.5 }],
  ] as const)('accepts %s', (_label, effect) => {
    expect(PayloadEffectSchema.parse(effect)).toEqual(effect);
  });

  it('leaves the placed effects to perEvent, where EffectSpecSchema takes them whole', () => {
    const placed = { ...CRIT_SLASH, toward: 'along', from: 'target' };
    expect(EffectSpecSchema.parse(placed)).toEqual(placed);
    expect(PayloadEffectSchema.safeParse(placed).success).toBe(false);
    expect(
      issuePaths(OuterDefSchema, {
        ...OUTER,
        payload: { ...OUTER.payload, perEvent: { chainJump: [placed] } },
      }),
    ).toEqual([]);
  });

  it('still requires what EffectSpecSchema requires', () => {
    expect(
      issuePaths(PayloadEffectSchema, { kind: 'slashLine', length: 300, damagePct: 1 }),
    ).toEqual(['width']);
    expect(
      issuePaths(PayloadEffectSchema, { kind: 'groundZone', radius: 80, durationSec: 2 }),
    ).toEqual(['damagePctPerSec']);
  });
});

describe('board ids and fusion keys', () => {
  it.each(['fire.center', 'hub', 'outer.greed', 'fusion.summon.ice', 'lightning.asc.storm-caller'])(
    'accepts the board id %s',
    (id) => {
      expect(BoardIdSchema.parse(id)).toBe(id);
    },
  );

  it.each([
    'fire',
    'fire.centre',
    'water.center',
    'outer.water',
    'fusion.fire',
    'hub.defense',
    'outer',
  ])('rejects the board id %o', (id) => {
    expect(BoardIdSchema.safeParse(id).success).toBe(false);
  });

  it('keys a fusion by character and outer', () => {
    expect(FusionKeySchema.parse('fire.poison')).toBe('fire.poison');
    for (const key of ['poison.fire', 'fire', 'fire.poison.core', 'fire.water']) {
      expect(FusionKeySchema.safeParse(key).success, key).toBe(false);
    }
  });
});

/** One slot of each kind (§3.1) and one bonus of each form (§3.4). */
const SLOTS: readonly NodeSlot[] = [
  { at: 'signature' },
  { at: 'centerBranch', branch: 2, step: 'mastery' },
  { at: 'centerEdge', clock: 5 },
  { at: 'hubRing', clock: 0 },
  { at: 'hubSpur', clock: 3 },
  { at: 'outerEntry' },
  { at: 'outerBranch', side: -1, step: 'b' },
  { at: 'outerEdge', place: 'keystone' },
  { at: 'fusion', step: 4 },
  { at: 'asc', chain: 1, step: 0 },
];
const BONUSES: readonly BonusSpec[] = [
  { form: 'status', ailment: 'poison', value: 0.3 },
  { form: 'inZone', value: 0.2 },
  { form: 'scaling', kind: 'more', value: 0.01, scaling: { per: 'chainJump' } },
  { form: 'inPayload' },
];

/**
 * Every object content writes is strict (docs/v3 C6 design §2.2, V1): an unknown field is an
 * error wherever it sits, never dropped.
 */
describe('strict objects', () => {
  it('lists one slot of each kind and one bonus of each form', () => {
    expect(new Set(SLOTS.map((slot) => slot.at)).size).toBe(NodeSlotSchema.options.length);
    expect(new Set(BONUSES.map((bonus) => bonus.form)).size).toBe(BonusSpecSchema.options.length);
  });

  it.each(SLOTS.map((slot) => [slot.at, slot] as const))(
    'rejects an unknown field on a %s slot',
    (_at, slot) => {
      expect(issueCodes(NodeSlotSchema, slot)).toEqual([]);
      expect(issueCodes(NodeSlotSchema, { ...slot, radius: 2 })).toEqual([
        ['', 'unrecognized_keys'],
      ]);
    },
  );

  it.each(BONUSES.map((bonus) => [bonus.form, bonus] as const))(
    'rejects an unknown field on a %s bonus',
    (_form, bonus) => {
      expect(issueCodes(BonusSpecSchema, bonus)).toEqual([]);
      expect(issueCodes(BonusSpecSchema, { ...bonus, scope: 'center' })).toEqual([
        ['', 'unrecognized_keys'],
      ]);
    },
  );

  it.each(['m1Volley', 'magmaBomb', 'iceFan', 'triphaseArc', 'swarm'] as const)(
    'rejects an unknown field on the %s signature',
    (id) => {
      expect(issueCodes(CharacterDefSchema, { ...CHARACTER, signature: { id } })).toEqual([]);
      expect(
        issueCodes(CharacterDefSchema, { ...CHARACTER, signature: { id, radius: 80 } }),
      ).toEqual([['signature', 'unrecognized_keys']]);
    },
  );

  it.each([
    [
      "a node's effects",
      CharacterDefSchema,
      {
        ...CHARACTER,
        center: {
          ...CENTER,
          nodes: [{ ...SPREAD_R1, effects: { ...SPREAD_R1.effects, auras: [] } }],
        },
      },
      'center.nodes.0.effects',
    ],
    [
      "a node's slot",
      HubDefSchema,
      {
        board: {
          ...HUB.board,
          nodes: [{ ...SECOND_LIFE, slot: { ...SECOND_LIFE.slot, radius: 2 } }],
        },
      },
      'board.nodes.0.slot',
    ],
    [
      'a center',
      CharacterDefSchema,
      { ...CHARACTER, center: { ...CENTER, root: ROOT.id } },
      'center',
    ],
    [
      "an ascendancy's board",
      AscendancyDefSchema,
      { ...INCINERATOR, board: { ...INCINERATOR.board, chain: 0 } },
      'board',
    ],
    ["the hub's board", HubDefSchema, { board: { ...HUB.board, ring: 6 } }, 'board'],
    ['the hub', HubDefSchema, { ...HUB, groups: 5 }, ''],
    [
      "an outer's board",
      OuterDefSchema,
      { ...OUTER, board: { ...OUTER.board, entry: CRIT_ENTRY.id } },
      'board',
    ],
    ['an outer', OuterDefSchema, { ...OUTER, nameKey: 'web.outer.crit.name' }, ''],
    [
      "an outer's skin",
      OuterDefSchema,
      { ...OUTER, skin: { ...OUTER.skin, color: 0xffffff } },
      'skin',
    ],
    [
      "a payload's bonus",
      OuterDefSchema,
      { ...OUTER, payload: { ...OUTER.payload, bonus: { form: 'inPayload', value: 0.2 } } },
      'payload.bonus',
    ],
    [
      "a payload's fusion rank",
      OuterDefSchema,
      {
        ...OUTER,
        payload: {
          ...OUTER.payload,
          ranks: [{ ...FUSION_RANK, cost: 1 }, FUSION_RANK, FUSION_RANK],
        },
      },
      'payload.ranks.0',
    ],
    [
      "an override's fusion rank",
      FusionOverrideSchema,
      { ranks: [FUSION_RANK, FUSION_RANK, { ...FUSION_RANK, cost: 1 }] },
      'ranks.2',
    ],
  ] as const)('rejects an unknown field in %s', (_label, schema, value, path) => {
    expect(issueCodes(schema, value)).toEqual([[path, 'unrecognized_keys']]);
  });
});
