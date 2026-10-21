/**
 * The test fixture of the v3 web (docs/v3 C6 design §2.2, F26): synthetic content that writes
 * every slot of the full web with the real character and outer ids, so the assembly, validation,
 * text, fuzz and calibration tests run before any batch has written content. The full fixture
 * writes 424 nodes: 4 × 40 center, 24 hub, 12 × 18 outer and 8 × 3 ascendancy nodes; assembled
 * (C6.5), the generator adds 44 × 5 fusion nodes for 644. Imported by tests and tools only, as
 * src/sim/testing.ts is.
 *
 * Its numbers are design defaults, not balance: every ranked node is D13a's default rank, the
 * named nodes have no effects, the cards are gd's and the payloads gd §5.3's (H22, F24). Its 12
 * hand cores and 2 rule overrides borrow M1's four rule modules, one board each per web (F26);
 * 火毒 carries §4.1's 瘟疫爆彈, so 3 of the 32 template pairs have an override (§8's C6.4 row).
 */

import type { RuleSpec } from '../rules';
import { CHARACTER_IDS, OUTER_IDS } from '../sources';
import type { CharacterId, OuterId } from '../sources';
import {
  answers,
  ascendancy,
  ascFinal,
  ascNode,
  centerBranch,
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
  notable,
  outerBranch,
  ranked,
  signatureNode,
  threshold,
} from '../templates';
import type { AscendancySpec, CenterSpec, CharacterSpec, OuterBranchSpec } from '../templates';
import type { TriggerSpec } from '../triggers';
import type { Batch } from './scope';
import { ROW_ENEMIES } from './types';
import type {
  CharacterDef,
  Content,
  Covers,
  FusionKey,
  FusionOverride,
  FusionRanks,
  HubDef,
  OuterDef,
  OuterPayload,
  Skin,
} from './types';

/** What each batch registers (impl:585-589, impl:600-604); a variant holds its batch and those before. */
interface Block {
  readonly batch: Batch;
  readonly centers: readonly CharacterId[];
  readonly hub: boolean;
  readonly outers: readonly OuterId[];
  readonly ascendancies: readonly CharacterId[];
}
const BLOCKS: readonly Block[] = [
  {
    batch: 'B1',
    centers: ['fire'],
    hub: true,
    outers: ['ice', 'poison', 'crit', 'summon'],
    ascendancies: [],
  },
  {
    batch: 'B2',
    centers: ['summon'],
    hub: false,
    outers: ['fire'],
    ascendancies: ['fire', 'summon'],
  },
  {
    batch: 'B3',
    centers: ['ice'],
    hub: false,
    outers: ['lightning', 'bleed', 'barrage'],
    ascendancies: [],
  },
  {
    batch: 'B4',
    centers: ['lightning'],
    hub: false,
    outers: ['combo', 'aura', 'greed', 'thorns'],
    ascendancies: [],
  },
  { batch: 'B5', centers: [], hub: false, outers: [], ascendancies: ['ice', 'lightning'] },
];

/** A character's select card: gd:30-33, gd:304-305 and gd:735-738, as src/data/characters/ has it. */
type Card = Pick<
  CharacterSpec,
  'color' | 'recommendedOuter' | 'revealAt15' | 'enemyRow' | 'difficulty' | 'construct'
>;
const CARDS: Readonly<Record<CharacterId, Card>> = {
  fire: {
    color: 0xff7a2f,
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
  },
  ice: {
    color: 0x8fe3ff,
    recommendedOuter: ['fire', 'poison', 'crit'],
    revealAt15: ['lightning', 'bleed', 'summon'],
    enemyRow: {
      triangle: 'strong',
      square: 'even',
      pentagon: 'strong',
      shielder: 'weak',
      regenerator: 'weak',
      dasher: 'strong',
      shooter: 'even',
      summoner: 'even',
      treasure: 'strong',
      boss: 'weak',
    },
    difficulty: 2,
    construct: 'frostCrystal',
  },
  lightning: {
    color: 0xb48cff,
    recommendedOuter: ['fire', 'crit', 'poison'],
    revealAt15: ['ice', 'bleed', 'barrage'],
    enemyRow: {
      triangle: 'strong',
      square: 'even',
      pentagon: 'strong',
      shielder: 'weak',
      regenerator: 'even',
      dasher: 'strong',
      shooter: 'strong',
      summoner: 'strong',
      treasure: 'even',
      boss: 'weak',
    },
    difficulty: 1,
    construct: 'teslaTower',
  },
  summon: {
    color: 0x9bf25c,
    recommendedOuter: ['fire', 'ice', 'crit'],
    revealAt15: ['poison', 'lightning', 'thorns'],
    enemyRow: {
      triangle: 'even',
      square: 'even',
      pentagon: 'even',
      shielder: 'weak',
      regenerator: 'even',
      dasher: 'weak',
      shooter: 'strong',
      summoner: 'strong',
      treasure: 'strong',
      boss: 'even',
    },
    difficulty: 2,
    construct: 'hive',
  },
};

/** D13a's default rank, the fixture's every ranked node and connector: +10 % damage, 3 ranks. */
const rank = () => ranked('damage', 0.1, 3);

/** r1–r3 of a payload gd gives no ranks for: D13a's default rank, scoped to the fusion. */
const RANKS: FusionRanks = [
  fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3),
  fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3),
  fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3),
];

/** An outer's skin (gd §4), the enemies it covers (gd §6.5) and its payload (gd:560-573, F24). */
interface OuterCard {
  readonly skin: Skin;
  readonly covers: Covers;
  /** null on the four archetype outers, which feed no template (AMB30). */
  readonly payload: OuterPayload | null;
}
const OUTER_CARDS: Readonly<Record<OuterId, OuterCard>> = {
  fire: {
    skin: { accent: 0xff7a2f, shape: 'flame' },
    covers: {
      triangle: 'answer',
      square: 'helps',
      shielder: 'helps',
      regenerator: 'helps',
      dasher: 'answer',
      boss: 'helps',
    },
    payload: null,
  },
  poison: {
    skin: { accent: 0x3fd08a, shape: 'bubble' },
    covers: {
      triangle: 'answer',
      square: 'helps',
      pentagon: 'answer',
      shielder: 'answer',
      dasher: 'answer',
      shooter: 'helps',
      summoner: 'helps',
      boss: 'helps',
    },
    // §5.3's poison, B1's 初始值.
    payload: {
      type: 'status',
      effects: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }],
      bonus: { form: 'status', ailment: 'poison', value: 0.2 },
      ranks: [
        fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3),
        fusionRank([flat('poisonDuration', 0.5)], 3),
        fusionRank([inc('damage', 0.04, { scope: 'center', when: [{ targetHas: 'poison' }] })], 3),
      ],
    },
  },
  bleed: {
    skin: { accent: 0xd7263d, shape: 'trail' },
    covers: {
      square: 'helps',
      shielder: 'answer',
      regenerator: 'answer',
      dasher: 'helps',
      shooter: 'answer',
      summoner: 'answer',
      treasure: 'helps',
    },
    // 流血 4 秒: the base bleed duration.
    payload: {
      type: 'status',
      effects: [{ kind: 'applyAilment', ailment: 'bleed' }],
      bonus: { form: 'status', ailment: 'bleed', value: 0.2 },
      ranks: RANKS,
    },
  },
  lightning: {
    skin: { accent: 0xb48cff, shape: 'arc' },
    covers: {
      triangle: 'helps',
      pentagon: 'helps',
      dasher: 'helps',
      shooter: 'helps',
      summoner: 'answer',
    },
    payload: null,
  },
  combo: {
    skin: { accent: 0xff4fb8, shape: 'afterimage' },
    covers: {
      triangle: 'answer',
      square: 'helps',
      regenerator: 'helps',
      dasher: 'answer',
      shooter: 'answer',
      boss: 'helps',
    },
    // A stand-in until C6b's comboStack (D11): 殘影's repeat at 50 % (gd:425), which no COEF field
    // scales, so coef reaches the bonus and r3 instead (Q2 (A)); no bonus until comboStacks (F42).
    payload: {
      type: 'self',
      effects: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }],
      bonus: null,
      ranks: RANKS,
      coefScalesBonus: true,
    },
  },
  crit: {
    skin: { accent: 0xfff4d6, shape: 'slash' },
    covers: {
      triangle: 'answer',
      square: 'helps',
      shielder: 'helps',
      regenerator: 'answer',
      treasure: 'helps',
      boss: 'helps',
    },
    payload: {
      type: 'placement',
      effects: [
        { kind: 'slashLine', length: 300, width: 24, damagePct: 1, alwaysCrit: true, critScale: 1 },
      ],
      bonus: { form: 'inPayload' },
      ranks: RANKS,
    },
  },
  ice: {
    skin: { accent: 0x8fe3ff, shape: 'crystal' },
    covers: {
      triangle: 'helps',
      pentagon: 'helps',
      regenerator: 'answer',
      dasher: 'answer',
      treasure: 'helps',
    },
    payload: null,
  },
  aura: {
    skin: { accent: 0xffd6ec, shape: 'ring' },
    covers: {
      triangle: 'helps',
      pentagon: 'helps',
      shielder: 'answer',
      dasher: 'helps',
      shooter: 'answer',
      summoner: 'answer',
    },
    // The zone deals no damage (F24), so coef reaches the bonus and r3 (Q2 (A)).
    payload: {
      type: 'placement',
      effects: [{ kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0 }],
      bonus: { form: 'inZone', value: 0.2 },
      ranks: RANKS,
      coefScalesBonus: true,
    },
  },
  thorns: {
    skin: { accent: 0x8a8f98, shape: 'spike' },
    covers: {
      triangle: 'helps',
      pentagon: 'helps',
      dasher: 'answer',
      shooter: 'answer',
      summoner: 'answer',
      boss: 'answer',
    },
    payload: {
      type: 'placement',
      effects: [{ kind: 'nova', radius: 90, damagePct: 3, tags: ['thorns'] }],
      bonus: { form: 'inPayload' },
      ranks: RANKS,
    },
  },
  summon: {
    skin: { accent: 0x9bf25c, shape: 'drone' },
    covers: {
      triangle: 'helps',
      pentagon: 'helps',
      shielder: 'answer',
      shooter: 'helps',
      summoner: 'helps',
      treasure: 'helps',
      boss: 'answer',
    },
    payload: null,
  },
  barrage: {
    skin: { accent: 0xffb627, shape: 'bullet' },
    covers: {
      triangle: 'helps',
      pentagon: 'helps',
      shielder: 'answer',
      dasher: 'helps',
      boss: 'answer',
    },
    payload: {
      type: 'placement',
      effects: [{ kind: 'projectiles', count: 4, damagePct: 0.25, aim: 'radial' }],
      bonus: { form: 'inPayload' },
      ranks: RANKS,
    },
  },
  greed: {
    skin: { accent: 0xffd23f, shape: 'coin' },
    covers: { shielder: 'answer', regenerator: 'answer', treasure: 'helps' },
    // No bonus until C6b's shardsHeld (F42).
    payload: {
      type: 'placement',
      effects: [{ kind: 'coinHit', multiplier: 10, ignoreShield: true }],
      bonus: null,
      ranks: RANKS,
    },
  },
};

/**
 * The rule each archetype lends its hand cores: M1's four modules (F26) at gd's numbers, 無盡烈焰
 * (gd:69), 冷靜狙擊 (gd:435), 過載 (gd:151) and 玻璃大砲 (gd:268).
 */
const RULES: Readonly<Record<CharacterId, RuleSpec>> = {
  fire: { id: 'eternalFlame', durationMore: -0.5 },
  ice: { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'shot' },
  lightning: { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2, chainMore: 3.5 },
  summon: { id: 'glassCannon', damageMore: 1 },
};

/** 火毒's 瘟疫爆彈 as §4.1 writes it (B1's numbers, F24): the fixture's one data override. */
const PLAGUE_BOMB: TriggerSpec = {
  on: 'kill',
  when: [{ victimHas: 'poison' }, { killedBy: 'burn' }],
  do: [{ kind: 'spreadAilment', ailment: 'poison', radius: 90, effect: 0.5 }],
};

/**
 * The 12 hand pairs (a character with another archetype's outer), each with the rule its outer
 * lends, then the 2 rule overrides (TEMPLATE_RULE_OVERRIDES, D12) and 火毒's 瘟疫爆彈 (§4.1); a
 * pair is registered once its center and its outer are. Each web holds each rule on one board.
 */
const OVERRIDES: readonly (readonly [CharacterId, OuterId, FusionOverride])[] = [
  ...CHARACTER_IDS.flatMap((c) =>
    CHARACTER_IDS.filter((o) => o !== c).map((o) => [c, o, { rule: RULES[o] }] as const),
  ),
  ['ice', 'aura', { addRules: [RULES.ice] }],
  ['lightning', 'aura', { addRules: [RULES.lightning] }],
  ['fire', 'poison', { addTriggers: [PLAGUE_BOMB] }],
];

function fixtureCenter(card: Card): CenterSpec {
  // Every ✗ but 寶藏 answered on a ◆a, one a branch (V18).
  const weak = ROW_ENEMIES.filter(
    (enemy) => enemy !== 'treasure' && card.enemyRow[enemy] === 'weak',
  );
  const branch = (slug: string, index: number) => {
    const answer = weak[index];
    const a = notable(`${slug}-one`, {});
    return centerBranch(slug, {
      r1: rank(),
      r2: rank(),
      a: answer === undefined ? a : answers(a, answer),
      r3: rank(),
      r4: rank(),
      b: notable(`${slug}-two`, {}),
      r5: rank(),
      r6: rank(),
      c: notable(`${slug}-three`, {}),
      mastery: mastery(),
    });
  };
  return {
    signature: signatureNode(),
    branches: [branch('alpha', 0), branch('beta', 1), branch('gamma', 2)],
    keystones: [keystone('star-one', {}), keystone('star-two', {})],
    threshold: threshold({}),
    connectors: [rank(), rank(), rank(), rank(), rank(), rank()],
  };
}

function fixtureCharacter(c: CharacterId, built: boolean, ascended: boolean): CharacterDef {
  const card = CARDS[c];
  const path = (slug: string): AscendancySpec =>
    ascendancy(slug, { n1: ascNode({}), n2: ascNode({}), final: ascFinal({}) });
  return defineCharacter({
    id: c,
    ...card,
    center: built ? fixtureCenter(card) : null,
    ascendancies: ascended ? [path('path-one'), path('path-two')] : null,
    defaultOrder: [], // the order falls back to breadth-first (F26)
  });
}

function fixtureOuter(o: OuterId): OuterDef {
  const card = OUTER_CARDS[o];
  // The answer ◆ answers every enemy the outer covers with ◆ (V18).
  const [first, ...rest] = ROW_ENEMIES.filter((enemy) => card.covers[enemy] === 'answer');
  const branch = (slug: string): OuterBranchSpec =>
    outerBranch(slug, {
      r1: rank(),
      r2: rank(),
      a: notable(`${slug}-one`, {}),
      r3: rank(),
      r4: rank(),
      b: notable(`${slug}-two`, {}),
      mastery: mastery(),
    });
  const counter = notable('counter', {});
  return defineOuter({
    id: o,
    entry: entry({}),
    branches: [branch('alpha'), branch('beta')],
    answer: first === undefined ? counter : answers(counter, first, ...rest),
    keystone: keystone('star', {}),
    threshold: threshold({}),
    payload: card.payload,
    skin: card.skin,
    covers: card.covers,
  });
}

function fixtureHub(): HubDef {
  return defineHub({
    might: might(),
    defense: {
      ranked: [rank(), rank(), rank(), rank(), rank()],
      notables: [notable('defense-one', {}), notable('defense-two', {})],
    },
    economy: {
      ranked: [rank(), rank(), rank(), rank()],
      notables: [notable('economy-one', {}), notable('economy-two', {})],
    },
    echo: {
      ranked: [rank(), rank(), rank(), rank()],
      notables: [
        notable('echo-one', {}),
        notable('echo-two', {}),
        notable('echo-three', {}),
        notable('echo-four', {}),
      ],
    },
    rules: { keystones: [keystone('rule-one', {}), keystone('rule-two', {})] },
  });
}

/**
 * The fixture's content after `variant` (default B5, the full web): every character with its
 * card, and the centers, hub, outers and ascendancies that batch and the ones before it write,
 * with the overrides of every pair whose center and outer are registered; nothing calibrated.
 */
export function fixtureContent(variant: Batch = 'B5'): Content {
  const blocks = BLOCKS.slice(0, BLOCKS.findIndex((block) => block.batch === variant) + 1);
  const centers = new Set(blocks.flatMap((block) => block.centers));
  const outers = new Set(blocks.flatMap((block) => block.outers));
  const chains = new Set(blocks.flatMap((block) => block.ascendancies));
  const character = (c: CharacterId) => fixtureCharacter(c, centers.has(c), chains.has(c));
  const registered: Partial<Record<OuterId, OuterDef>> = {};
  for (const o of OUTER_IDS) if (outers.has(o)) registered[o] = fixtureOuter(o);
  const overrides: Partial<Record<FusionKey, FusionOverride>> = {};
  for (const [c, o, override] of OVERRIDES) {
    if (centers.has(c) && outers.has(o)) overrides[`${c}.${o}`] = override;
  }
  return {
    characters: {
      fire: character('fire'),
      ice: character('ice'),
      lightning: character('lightning'),
      summon: character('summon'),
    },
    outers: registered,
    hub: blocks.some((block) => block.hub) ? fixtureHub() : null,
    overrides,
    calibrated: {},
    acceptedFails: {},
  };
}
