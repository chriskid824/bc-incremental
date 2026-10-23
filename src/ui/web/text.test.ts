/**
 * text.ts (docs/v3 C6 design D22, §3.9, §4.7): the registries and STAT_FORMAT (R3, F52), a node
 * holding one of everything every template writes, and describeNode on the fixture through its
 * lookups (F45): hand text, ranks, a fusion's coef and the answers.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EmitterGrant } from '../../data/emitters';
import { ALWAYS_STATS, STAT_IDS } from '../../data/stats';
import type { Modifier } from '../../data/stats';
import { DAMAGE_TAGS } from '../../data/tags';
import { flat, inc, more } from '../../data/templates';
import {
  APPLIED_AILMENTS,
  CENTER_EVENTS,
  COEF_FIELDS,
  HELD_AILMENTS,
  HIT_KINDS,
  KILL_KINDS,
  SCALING_CURVES,
  SCALING_VARS,
  TARGET_KINDS,
  TARGET_PICKS,
  TARGET_STATES,
} from '../../data/triggers';
import type { EffectKind, TriggerSpec } from '../../data/triggers';
import { assembleWeb, FULL_SCOPE } from '../../data/web';
import type { AssembledWeb, BonusSpec, FusionKey, NodeEffects, WebNode } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import { LOCALES, MESSAGES } from '../../i18n';
import type { Locale } from '../../i18n';
import { BUY_REASONS } from '../../meta/web';
import { describeModifier } from '../describe';
import { APP_LOOKUP } from './names';
import { fixtureLookups, fixtureMessages } from './testing';
import {
  BONUS_TEXT,
  BUY_CHECK_TEXT,
  buyCheckText,
  COEF_FORMAT,
  CONDITION_TEXT,
  coreBonus,
  CURVE_TEXT,
  describeNode,
  EFFECT_TEXT,
  EVENT_TEXT,
  FANOUT_TEXT,
  GRANT_TEXT,
  KIND_TEXT,
  messageLookup,
  SCALING_TEXT,
  STAT_FORMAT,
} from './text';
import type { TextLookup } from './text';

const content = fixtureContent();
const fire = assembleWeb(content, 'fire', FULL_SCOPE);
const lookups = fixtureLookups();
/** A fixture notable with no effects, which the tests fill. */
const NOTABLE = 'fire.center.alpha.alpha-two';

const effects = (part: Partial<NodeEffects>): NodeEffects => ({
  modifiers: [],
  triggers: [],
  conversions: [],
  emitters: [],
  rules: [],
  ...part,
});

/** `web` with node `id`'s effects replaced. */
function withEffects(web: AssembledWeb, id: string, part: Partial<NodeEffects>): AssembledWeb {
  const nodes = web.nodes.map((node): WebNode =>
    node.id === id ? { ...node, effects: effects(part) } : node,
  );
  return { ...web, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
}

const linesOf = (web: AssembledWeb, id: string, locale: Locale, rank = 1): readonly string[] =>
  describeNode(web, id, rank, lookups[locale]).lines;

/** The first line of a lone modifier on the notable. */
const modifierLine = (mod: Modifier, lookup: TextLookup): string =>
  describeNode(withEffects(fire, NOTABLE, { modifiers: [mod] }), NOTABLE, 1, lookup).lines[0] ?? '';

/** `lookup` with every key it is asked for added to `keys`. */
function recording(lookup: TextLookup, keys: Set<string>): TextLookup {
  return {
    ...lookup,
    get: (key, values) => {
      keys.add(key);
      return lookup.get(key, values);
    },
  };
}

/** A line V19 would fail: empty, a placeholder or brace left, undefined, NaN or Infinity. */
const isFaulty = (line: string): boolean =>
  line.trim() === '' || /[{}]/.test(line) || /\b(?:undefined|NaN|Infinity)\b/.test(line);

describe('the registries (§4.7)', () => {
  const REGISTRIES = {
    KIND_TEXT,
    EFFECT_TEXT,
    CONDITION_TEXT,
    CURVE_TEXT,
    EVENT_TEXT,
    GRANT_TEXT,
    BONUS_TEXT,
    BUY_CHECK_TEXT,
  };
  const keys = [
    ...Object.values(REGISTRIES).flatMap((registry) => Object.values(registry)),
    ...Object.values(SCALING_TEXT).flatMap(({ name, one, other }) => [name, one, other]),
    ...Object.values(FANOUT_TEXT).flatMap((types) => Object.values(types)),
  ];

  it.each(LOCALES)('gives every template a web key with text in %s', (locale) => {
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      expect(key.startsWith('web.'), key).toBe(true);
      expect(MESSAGES[locale][key].trim(), `${locale} ${key}`).not.toBe('');
    }
  });

  it("names exactly COEF_FIELDS' fields in COEF_FORMAT", () => {
    for (const kind of Object.keys(COEF_FIELDS) as EffectKind[]) {
      expect(Object.keys(COEF_FORMAT[kind]).sort(), kind).toEqual([...COEF_FIELDS[kind]].sort());
    }
  });

  it('sits in no value-import cycle of src/ui/web (L8)', () => {
    const modules = readdirSync(new URL('./', import.meta.url))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => file.slice(0, -'.ts'.length));
    const imports = (name: string): string[] => {
      const text = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      return [...text.matchAll(/^import(\s+type)?\s[^;]*?from '\.\/(\w+)';/gm)]
        .filter((match) => match[1] === undefined)
        .map((match) => match[2] as string);
    };
    const done = new Set<string>();
    const visit = (name: string, trail: readonly string[]): void => {
      expect(trail, `cycle ${[...trail, name].join(' → ')}`).not.toContain(name);
      if (done.has(name)) return;
      for (const next of imports(name)) visit(next, [...trail, name]);
      done.add(name);
    };
    for (const name of modules) visit(name, []);
    expect(imports('names')).toEqual([]);
    expect(done.size).toBe(modules.length);
  });
});

describe('STAT_FORMAT (R3, F52)', () => {
  it('reads a fraction stat as a percentage and a number stat as written', () => {
    expect(modifierLine(flat('poisonChance', 0.15), lookups.en)).toBe('+15% Poison chance');
    expect(modifierLine(flat('poisonChance', 0.15), lookups['zh-TW'])).toBe('中毒機率 +15%');
    expect(modifierLine(flat('chainCount', 1), lookups.en)).toBe('+1 Chains');
    expect(modifierLine(flat('poisonDuration', 0.5), lookups['zh-TW'])).toBe('中毒持續時間 +0.5');
    expect(modifierLine(flat('frozenDamageTaken', -0.3), lookups.en)).toMatch(/^−30% /);
  });

  it('reads exactly the stats whose flat value is a fraction of 1 as percentages', () => {
    expect(STAT_IDS.filter((stat) => STAT_FORMAT[stat] === 'percent')).toEqual([
      'critChance',
      'critMultiplier',
      'igniteChance',
      'burnDamage',
      'chainRetention',
      'shardGain',
      'coreGain',
      'poisonChance',
      'poisonDamage',
      'bleedChance',
      'bleedDamage',
      'shockChance',
      'shockEffect',
      'bleedStationaryMult',
      'frostOnHit',
      'frostSlowCap',
      'shatterDamage',
      'frozenDamageTaken',
      'contactDamageTaken',
      'lifeRegen',
      'enemyRegen',
      'toughDropMult',
      'treasureRate',
    ]);
  });

  it("agrees with M1's describeModifier wherever M1 writes the line", () => {
    const en = messageLookup(MESSAGES.en);
    for (const stat of STAT_IDS) {
      if ((ALWAYS_STATS as readonly string[]).includes(stat)) continue;
      const m1 = describeModifier(flat(stat, 0.15)) as string;
      if (m1.includes('%')) expect(STAT_FORMAT[stat], stat).toBe('percent');
      if (m1.includes('%') || STAT_FORMAT[stat] === 'number') {
        expect(modifierLine(flat(stat, 0.15), en), stat).toBe(m1);
      }
    }
  });

  it("writes an *Always stat as its name and M1's more, less and increased", () => {
    expect(modifierLine(flat('critAlways', 1), lookups['zh-TW'])).toBe('必定暴擊');
    expect(modifierLine(more('damage', 0.2), lookups.en)).toBe('20% more Damage');
    expect(modifierLine(more('damage', -0.2), lookups['zh-TW'])).toBe('傷害總減 20%');
    expect(modifierLine(inc('damage', 0.1), lookups.en)).toBe('10% increased Damage');
  });

  it('writes an increased value below 0 as reduced, at rank 1 and per rank with its total (D4)', () => {
    expect(modifierLine(inc('damage', -0.1), lookups.en)).toBe('10% reduced Damage');
    expect(modifierLine(inc('damage', -0.1), lookups['zh-TW'])).toBe('傷害降低 10%');
    expect(modifierLine(inc('damage', 0), lookups.en)).toBe('0% increased Damage');
    const ranked = withEffects(fire, 'fire.center.alpha.r1', { modifiers: [inc('damage', -0.1)] });
    expect(linesOf(ranked, 'fire.center.alpha.r1', 'en', 2)).toEqual([
      '10% reduced Damage per rank (2/3: −20%)',
    ]);
    expect(linesOf(ranked, 'fire.center.alpha.r1', 'zh-TW', 2)).toEqual([
      '每級傷害降低 10%（2/3：−20%）',
    ]);
  });
});

/** One of everything a node's generated text can say. */
function kitchenSink(): NodeEffects {
  const heal = { kind: 'heal', lifePct: 0.01 } as const;
  const triggers: TriggerSpec[] = [
    {
      on: 'hit',
      when: [{ targetHas: 'burn' }, { chance: 0.25 }],
      do: [
        {
          kind: 'applyAilment',
          ailment: 'burn',
          stacks: 2,
          damagePct: 1.5,
          radius: 60,
          maxTargets: 3,
          order: 'nearest',
        },
      ],
    },
    {
      on: 'crit',
      when: [{ hitIs: 'crit' }, { cooldownSec: 2 }],
      do: [
        {
          kind: 'explode',
          radius: 90,
          damagePct: 0.5,
          maxTargets: 3,
          tags: ['area'],
          element: 'cold',
        },
      ],
    },
    {
      on: 'kill',
      when: [{ victimHas: 'poison' }, { killedBy: 'burn' }],
      do: [
        {
          kind: 'spreadAilment',
          ailment: 'poison',
          radius: 90,
          effect: 0.5,
          stacks: 0.5,
          maxTargets: 4,
          order: 'nearest',
          toSplitChildren: 0.5,
        },
      ],
    },
    { on: 'kill', do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 120 }] },
    {
      on: 'nthAttack',
      every: 4,
      when: [{ targetHpBelow: 0.3 }],
      do: [{ kind: 'nova', radius: 200, damagePct: 1.5 }],
    },
    { on: 'nthAttack', every: 1, do: [{ kind: 'push', radius: 80, distance: 40 }] },
    {
      on: 'ailmentApplied',
      when: [{ ailment: 'shock' }, { stacksAtLeast: { ailment: 'shock', stacks: 'max' } }],
      do: [{ kind: 'addFrost', amount: 0.25, radius: 70, maxTargets: 2 }],
    },
    {
      on: 'ailmentTick',
      every: 0.5,
      when: [{ ailment: 'poison' }, { stacksAtLeast: { ailment: 'poison', stacks: 5 } }],
      do: [{ kind: 'heal', lifePct: 0.05 }],
    },
    { on: 'diedWithAilment', do: [{ kind: 'gainShards', fraction: 0.1 }] },
    {
      on: 'shatter',
      do: [
        {
          kind: 'groundZone',
          radius: 80,
          durationSec: 2,
          damagePctPerSec: 0.5,
          ailment: 'burn',
          ailmentStacks: 2,
          ailmentDamagePct: 1.5,
          addFrostPerSec: 0.1,
          slow: 0.2,
          tags: ['zone'],
          element: 'lightning',
        },
      ],
    },
    {
      on: 'heroHit',
      do: [{ kind: 'repeatAttack', count: 2, damagePct: 0.5, timing: 'nextAttack' }],
    },
    // ◆波次護盾 as B1 writes it (lead ruling L3), and 霜甲 (gd:110) on a center event: the
    // player's, not the target's.
    { on: 'waveStart', do: [{ kind: 'shield', lifePct: 0.2, capPct: 0.2 }] },
    { on: 'freeze', do: [{ kind: 'shield', lifePct: 0.02, capPct: 0.3 }] },
    {
      on: 'contact',
      when: [{ targetKind: 'boss' }, { inZone: 'outer.aura' }],
      do: [
        {
          kind: 'detonate',
          ailment: 'bleed',
          fraction: 0.5,
          damage: 2,
          radius: 100,
          maxTargets: 2,
        },
      ],
    },
    {
      on: 'waveStart',
      do: [
        {
          kind: 'projectiles',
          count: 3,
          aim: 'fan',
          from: 'player',
          pierce: 2,
          bounce: 1,
          spreadDeg: 45,
          damagePct: 0.3,
          tags: ['projectile'],
        },
        { kind: 'projectiles', count: 1, aim: 'target', pierce: -1, damagePct: 0.3 },
      ],
    },
    {
      on: 'periodic',
      every: 5,
      target: {
        pick: 'mostStacks',
        ailment: 'burn',
        range: 300,
        from: 'player',
        excludeEventTarget: true,
        excludeBoss: true,
      },
      do: [
        {
          kind: 'slashLine',
          length: 300,
          width: 24,
          damagePct: 1,
          toward: 'eventTarget',
          alwaysCrit: true,
          critScale: 1,
          tags: ['crit'],
        },
      ],
    },
    {
      on: 'droneExpire',
      do: [{ kind: 'coinHit', multiplier: 10, ignoreShield: true, ignoreArmour: true }],
    },
    {
      on: 'explode',
      target: { pick: 'nearest' },
      do: [{ kind: 'chainBolt', jumps: 2, damagePct: 0.4, shockStacks: 1, from: 'nearestToPoint' }],
    },
    // Each center event's fan-outs (status, self, placement) and a selector's.
    ...CENTER_EVENTS.flatMap((on): TriggerSpec[] => [
      { on, do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }] },
      { on, do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }] },
      {
        on,
        when: [{ chance: 0.5 }],
        do: [{ kind: 'nova', radius: 50, damagePct: 0.2, at: 'event' }],
      },
      { on, target: { pick: 'farthest' }, do: [heal] },
    ]),
    ...HELD_AILMENTS.map((a): TriggerSpec => ({
      on: 'kill',
      when: [{ victimHas: a }],
      do: [heal],
    })),
    ...APPLIED_AILMENTS.map((a): TriggerSpec => ({
      on: 'ailmentApplied',
      when: [{ ailment: a }],
      do: [heal],
    })),
    ...KILL_KINDS.map((k): TriggerSpec => ({ on: 'kill', when: [{ killedBy: k }], do: [heal] })),
    ...HIT_KINDS.map((h): TriggerSpec => ({ on: 'hit', when: [{ hitIs: h }], do: [heal] })),
    ...TARGET_KINDS.map((k): TriggerSpec => ({ on: 'hit', when: [{ targetKind: k }], do: [heal] })),
    ...TARGET_STATES.map((st): TriggerSpec => ({
      on: 'hit',
      when: [{ targetState: st }],
      do: [heal],
    })),
    { on: 'hit', when: [{ targetFrostAtLeast: 0.3 }], do: [heal] },
    ...TARGET_PICKS.map((pick): TriggerSpec => ({ on: 'hit', target: { pick }, do: [heal] })),
    ...(['outward', 'nearest', 'eventTarget', 'along'] as const).map((toward): TriggerSpec => ({
      on: 'hit',
      do: [{ kind: 'slashLine', length: 100, width: 10, damagePct: 1, toward }],
    })),
    ...(['target', 'distinct', 'radial', 'fan'] as const).map((aim): TriggerSpec => ({
      on: 'hit',
      do: [{ kind: 'projectiles', count: 1, aim, damagePct: 1 }],
    })),
  ];
  const modifiers: Modifier[] = [
    {
      stat: 'damage',
      kind: 'increased',
      value: 0.1,
      tags: ['burn', 'area'],
      notTags: ['crit'],
      scope: 'outer.poison',
      when: [{ targetHas: 'frozen' }, { targetHpBelow: 0.5 }],
    },
    inc('damage', 0.1, { scope: 'fusion.fire.poison' }),
    inc('attackSpeed', -0.1),
    ...(['center', 'outer', 'fusion', 'hub', 'asc'] as const).map((scope) =>
      inc('damage', 0.1, { scope }),
    ),
    ...DAMAGE_TAGS.map((tag) => flat('critChance', 0.01, { tags: [tag] })),
    ...SCALING_VARS.flatMap((per) =>
      SCALING_CURVES.filter((curve) => curve !== 'powFactor').flatMap((curve) => [
        more('damage', 0.02, {
          scaling: { per, curve, ...(curve === 'pow' ? { exponent: 2 } : {}), cap: 0.5 },
        }),
        flat('critChance', 0.02, {
          scaling: {
            per,
            every: per === 'lifeLostPct' || per === 'targetFrost' ? 0.1 : 5,
            curve,
            ...(curve === 'pow' ? { exponent: 0.5 } : {}),
          },
        }),
      ]),
    ),
    more('damage', 1, { scaling: { per: 'lifeLostPct', curve: 'powFactor', exponent: 2, cap: 3 } }),
  ];
  const emitters: EmitterGrant[] = [
    { kind: 'thorns' },
    { kind: 'segment', endpoints: 'shocked' },
    {
      kind: 'strike',
      name: 'sink',
      periodSec: 3,
      target: { pick: 'densest' },
      damagePct: 2,
      radius: 60,
      element: 'lightning',
      chainJumps: 2,
      shockStacks: 1,
    },
    {
      kind: 'strike',
      name: 'one',
      periodSec: 3,
      target: { pick: 'nearest' },
      damagePct: 1,
      chainJumps: 1,
    },
    { kind: 'drone', drones: 2, turrets: 1 },
    { kind: 'drone', drones: 1, turrets: 2 },
    { kind: 'aura', everyNth: { n: 4, mult: 4 }, corona: { periodSec: 2, damagePct: 1 } },
    { kind: 'orbit', ring: 1, count: 2 },
    { kind: 'orbit' },
  ];
  return effects({
    modifiers,
    triggers,
    emitters,
    conversions: [
      { tags: ['hit'], to: 'cold', fraction: 0.5 },
      { to: 'burn', fraction: 0.25 },
    ],
    rules: [{ id: 'glassCannon', damageMore: 1 }],
  });
}

/** fire's web with a template core's bonus replaced (scaling, either curve). */
function withBonus(key: FusionKey, bonus: BonusSpec): AssembledWeb {
  return assembleWeb(
    {
      ...content,
      overrides: { ...content.overrides, [key]: { ...content.overrides[key], bonus } },
    },
    'fire',
    FULL_SCOPE,
  );
}

describe('every template, through one node (§4.7)', () => {
  const sink = withEffects(fire, NOTABLE, kitchenSink());
  const ranked = withEffects(fire, 'fire.center.alpha.r1', {
    modifiers: [inc('damage', 0.04)],
    triggers: [{ on: 'kill', do: [{ kind: 'gainShards', fraction: 0.1 }] }],
    conversions: [{ to: 'burn', fraction: 0.25 }],
  });
  const scaling = withBonus('fire.bleed', {
    form: 'scaling',
    kind: 'increased',
    value: 0.04,
    scaling: { per: 'targetPoisonStacks', cap: 0.5 },
  });
  const factor = withBonus('fire.combo', {
    form: 'scaling',
    kind: 'more',
    value: 1,
    scaling: { per: 'lifeLostPct', curve: 'powFactor', exponent: 2, cap: 3 },
  });

  it('fills every template of every family, in both locales', () => {
    const asked = new Set<string>();
    const kinds = new Set<string>();
    for (const locale of LOCALES) {
      const lookup = recording(lookups[locale], asked);
      const texts = [
        describeNode(sink, NOTABLE, 1, lookup),
        describeNode(ranked, 'fire.center.alpha.r1', 2, lookup),
        describeNode(scaling, 'fusion.fire.bleed.core', 1, lookup),
        describeNode(factor, 'fusion.fire.combo.core', 1, lookup),
        ...fire.nodes.map((node) => {
          kinds.add(node.kind);
          return describeNode(fire, node.id, 2, lookup);
        }),
      ];
      for (const text of texts) {
        for (const line of [text.name, text.kind, ...text.lines]) {
          expect(isFaulty(line), `${locale}: ${line}`).toBe(false);
        }
      }
    }
    expect([...kinds].sort()).toEqual(Object.keys(KIND_TEXT).sort());
    const families =
      /^web\.(?:kind|effect|word|ailment|applied|held|state|killedBy|toward|aim|extra|event|fanout|cond|hit|targetKind|enemies|how|trigger|conds|pick|scaling|curve|mod|qual|scope|tag|rank|conversion|ruleFallback|centerDamage|bonus|grant|ring|masteryName|coreName|answers|join)\b/;
    const unasked = Object.keys(MESSAGES.en).filter((key) => families.test(key) && !asked.has(key));
    // An ailment condition sits on ailmentApplied and ailmentTick only (CONDITION_CONTEXTS), whose
    // templates name the ailment themselves: its registry entry is never a line of its own.
    expect(unasked).toEqual(['web.cond.ailment']);
  });

  it.each([
    [
      'en',
      [
        '10% increased Burn damage (Poison only, tagged area only, not tagged crit, against frozen enemies below 50% life)',
        '+2% Crit chance (per 10% of life lost)',
        'Damage ×(the share of life lost to the power 2), at most ×3',
        'On hitting burning enemies (25% chance): 2 burn stacks, damage ×1.5, on the enemies within 60, at most 3 enemies, nearest first',
        'When poisoned enemies are killed by burn: spread the poison stacks at 50% strength to the enemies within 90, each taking 50% of the stacks, at most 4 enemies, nearest first; split-off enemies each take 50% of the poison',
        'Every 5 s, at the enemy with the most burn stacks within 300 (measured from you, not this one, never a boss): a slash at the target, 300 long and 24 wide, for 100% damage, always a crit, +10% damage per 10% crit chance, tagged crit',
        'Each explosion (50% chance), where it lands: a nova of radius 50 for 20% damage',
        'On each freeze: 2 poison stacks on the target and the enemies within 90, at most 5',
        '+2 drones: 80% damage an impact, +1 turret: 40% damage a shot',
        'At the start of each wave: gain a shield of 20% of max life',
        'On each freeze: gain a shield of 2% of max life',
        'Special rule (glassCannon)',
      ],
    ],
    [
      'zh-TW',
      [
        '燃燒傷害提高 10%（限毒，限範圍標籤，不含暴擊標籤，對生命低於 50% 的凍結中的敵人）',
        '暴擊率 +2%（每損失 10% 生命）',
        '傷害 ×（已損失的生命比例的 2 次方），最多 ×3',
        '擊中燃燒中的敵人時（25% 機率）：燃燒 2 層，傷害 ×1.5，對半徑 60 內的敵人，最多 3 隻，由近到遠',
        '中毒的敵人被燃燒殺死時：把毒層以 50% 的效果傳給半徑 90 內的敵人，每隻分到 50% 的層數，最多 4 隻，由近到遠；分裂出的敵人各得 50% 的毒',
        '每 5 秒，對半徑 300 內燃燒層數最多的敵人（從你算起，不含這一隻，不含 Boss）：朝目標畫一條長 300、寬 24 的斬擊線，100% 傷害，必定暴擊，每 10% 暴擊率傷害 +10%，帶暴擊標籤',
        '每次爆炸（50% 機率），在落點：放出半徑 50 的新星，20% 傷害',
        '凍結時，對目標與半徑 90 內最多 5 隻敵人：毒 2 層',
        '擊中 Boss 時：回復 1% 生命',
        '每波開始時：得到 20% 最大生命的護盾',
        '凍結時：得到 2% 最大生命的護盾',
        '特殊規則（glassCannon）',
      ],
    ],
  ] as const)('writes the lines of the node in %s', (locale, expected) => {
    expect(linesOf(sink, NOTABLE, locale)).toEqual(expect.arrayContaining([...expected]));
  });

  it.each([
    [
      'en',
      [
        '60% less Enemy regeneration (against enemies with at least 30% chill)',
        '100% more Damage (against dashing enemies)',
        '+25% Chill on hit (against dashing enemies)',
        '80% less Enemy regeneration (against chilled enemies)',
        '100% more Elite and boss drops',
        '50% increased Treasure appearance rate',
        '100% more Damage (against stopped enemies below 50% life)',
        'On hitting dashing enemies: heal 1% of max life',
        'On hitting stopped enemies with at least 30% chill: heal 1% of max life',
      ],
    ],
    [
      'zh-TW',
      [
        '敵人回血總減 60%（對冰冷 ≥ 30% 的敵人）',
        '傷害總增 100%（對衝刺中的敵人）',
        '擊中冰冷 +25%（對衝刺中的敵人）',
        '敵人回血總減 80%（對有冰冷的敵人）',
        '菁英與 Boss 掉落總增 100%',
        '寶藏怪出現率提高 50%',
        '傷害總增 100%（對生命低於 50% 的停下來的敵人）',
        '擊中衝刺中的敵人時：回復 1% 生命',
        '擊中冰冷 ≥ 30% 的停下來的敵人時：回復 1% 生命',
      ],
    ],
  ] as const)(
    'writes the enemy states, the chill threshold and the enemy stats in %s (docs/v3 C7 design §1.7)',
    (locale, expected) => {
      const heal = { kind: 'heal', lifePct: 0.01 } as const;
      const web = withEffects(fire, NOTABLE, {
        modifiers: [
          { stat: 'enemyRegen', kind: 'more', value: -0.6, when: [{ targetFrostAtLeast: 0.3 }] },
          { stat: 'damage', kind: 'more', value: 1, when: [{ targetState: 'dashing' }] },
          { stat: 'frostOnHit', kind: 'flat', value: 0.25, when: [{ targetState: 'dashing' }] },
          { stat: 'enemyRegen', kind: 'more', value: -0.8, when: [{ targetHas: 'frost' }] },
          { stat: 'toughDropMult', kind: 'more', value: 1 },
          { stat: 'treasureRate', kind: 'increased', value: 0.5 },
          {
            stat: 'damage',
            kind: 'more',
            value: 1,
            when: [{ targetState: 'stopped' }, { targetHpBelow: 0.5 }],
          },
        ],
        triggers: [
          { on: 'hit', when: [{ targetState: 'dashing' }], do: [heal] },
          {
            on: 'hit',
            when: [{ targetState: 'stopped' }, { targetFrostAtLeast: 0.3 }],
            do: [heal],
          },
        ],
      });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
    },
  );

  it("writes a ranked node's triggers and conversions once a rank, and the bonus forms", () => {
    expect(linesOf(ranked, 'fire.center.alpha.r1', 'zh-TW', 2)).toEqual([
      '每級傷害提高 4%（2/3：+8%）',
      '敵人死亡時：再掉落 10% 的碎片（每級各一次）',
      '擊中傷害的 25% 轉為燃燒（每級各一次）',
    ]);
    expect(linesOf(scaling, 'fusion.fire.bleed.core', 'en')[1]).toBe(
      '+4% center damage per poison stack on the target, at most +50%',
    );
    expect(linesOf(scaling, 'fusion.fire.bleed.core', 'zh-TW')[1]).toBe(
      '目標每層毒，中心傷害 +4%，最多 +50%',
    );
    expect(linesOf(factor, 'fusion.fire.combo.core', 'zh-TW')[1]).toBe(
      '中心傷害 ×（已損失的生命比例的 2 次方），最多 ×3',
    );
  });
});

describe('describeNode (§4.7)', () => {
  it('names each kind and the generated nodes', () => {
    const at = (id: string, locale: Locale, rank = 1) => {
      const { name, kind } = describeNode(fire, id, rank, lookups[locale]);
      return `${name} [${kind}]`;
    };
    expect(at('fire.center.main.star-one', 'en')).toBe('Star One [Keystone]');
    expect(at(NOTABLE, 'zh-TW')).toBe('甲二 [顯著節點]');
    expect(at('fusion.fire.poison.core', 'en')).toBe('Fire Poison "Plague Bomb" [Fusion core]');
    expect(at('fusion.fire.poison.core', 'zh-TW')).toBe('火毒「瘟爆」 [融合核心]');
    expect(at('fusion.fire.poison.mastery', 'zh-TW')).toBe('火毒精通 [精通]');
    expect(at('fire.center.alpha.mastery', 'en')).toBe('Alpha Mastery [Mastery]');
    expect(at('fusion.fire.poison.r1', 'zh-TW')).toBe('傷害 [等級節點]');
    expect(at('hub.might.might', 'zh-TW')).toBe('強化∞ [強化∞]');
  });

  it('shows a ranked node per rank with its total at the rank', () => {
    expect(linesOf(fire, 'fusion.fire.poison.r1', 'en', 2)).toEqual([
      '10% increased Damage per rank (Fire Poison only, 2/3: +20%)',
    ]);
    expect(linesOf(fire, 'fusion.fire.poison.r3', 'zh-TW', 2)).toEqual([
      '每級傷害提高 4%（限中心，對中毒的敵人，2/3：+8%）',
    ]);
    expect(linesOf(fire, 'fusion.fire.poison.mastery', 'zh-TW', 2)).toEqual([
      '每級傷害總增 4%（限火毒，2 級：×1.08）',
    ]);
    expect(linesOf(fire, 'hub.might.might', 'en', 2)).toEqual([
      '10% more Damage per rank (rank 2: ×1.21)',
    ]);
    expect(linesOf(fire, 'fusion.fire.poison.r2', 'en', 2)).toEqual([
      '+0.5 Poison duration per rank (2/3: +1)',
    ]);
  });

  it('writes a template core as its fan-out, its bonus and its override', () => {
    expect(linesOf(fire, 'fusion.fire.poison.core', 'zh-TW')).toEqual([
      '每次爆炸，對範圍內最多 5 隻敵人：毒 2 層',
      '中毒的敵人受到中心傷害 +20%',
      '中毒的敵人被燃燒殺死時：把毒層以 50% 的效果傳給半徑 90 內的敵人',
    ]);
    expect(linesOf(fire, 'fusion.fire.aura.core', 'en')).toEqual([
      'Each explosion, where it lands: a 2 s pulse zone (radius 80)',
      'Enemies in its zones take +20% center damage',
    ]);
    expect(linesOf(fire, 'fusion.fire.crit.core', 'zh-TW')).toEqual([
      '每次爆炸，在落點：朝最近的敵人畫一條長 300、寬 24 的斬擊線，100% 傷害，必定暴擊，每 10% 暴擊率傷害 +10%',
      '這條融合吃暴擊外盤的加成',
    ]);
  });

  it("shows a fusion board's numbers at its coef, a default-1 field once the coef moves it, a chance at most 100% (D10)", () => {
    const at = (key: FusionKey, coef: number) =>
      assembleWeb(content, key.split('.')[0] as 'fire', FULL_SCOPE, { coefs: { [key]: coef } });
    const poison = at('fire.poison', 1.5);
    expect(linesOf(poison, 'fusion.fire.poison.core', 'zh-TW')).toEqual([
      '每次爆炸，對範圍內最多 5 隻敵人：毒 2 層，傷害 ×1.5',
      '中毒的敵人受到中心傷害 +20%',
      '中毒的敵人被燃燒殺死時：把毒層以 75% 的效果傳給半徑 90 內的敵人',
    ]);
    const lightning = (coef: number) =>
      linesOf(
        assembleWeb(content, 'lightning', FULL_SCOPE, { coefs: { 'lightning.poison': coef } }),
        'fusion.lightning.poison.core',
        'en',
      )[0];
    expect(lightning(1)).toBe(
      'Each jump, with a 30% chance (at most 3 times an attack): 2 poison stacks on the enemy jumped to',
    );
    expect(lightning(2)).toMatch(/^Each jump, with a 60% chance .*: 2 poison stacks, damage ×2 on/);
    expect(lightning(4)).toMatch(/^Each jump, with a 100% chance /);
    const core = poison.byId.get('fusion.fire.poison.core') as WebNode;
    const withChance = (web: AssembledWeb) =>
      withEffects(web, core.id, {
        ...core.effects,
        triggers: [
          ...core.effects.triggers,
          { on: 'hit', when: [{ chance: 0.4 }], do: [{ kind: 'heal', lifePct: 0.01 }] },
        ],
      });
    expect(linesOf(withChance(poison), core.id, 'en').at(-1)).toBe(
      'On hitting enemies (60% chance): heal 1% of max life',
    );
    expect(linesOf(withChance(at('fire.poison', 3)), core.id, 'en').at(-1)).toBe(
      'On hitting enemies (100% chance): heal 1% of max life',
    );
    expect(linesOf(at('fire.poison', 3), 'fusion.fire.poison.r1', 'en', 1)).toEqual(
      linesOf(fire, 'fusion.fire.poison.r1', 'en', 1),
    );
  });

  it('shows the chance a coef below 1 gives a fusion trigger that has none (D10: min(1, 1 × coef))', () => {
    const web = assembleWeb(content, 'fire', FULL_SCOPE, { coefs: { 'fire.poison': 0.45 } });
    const [fanout, , spread] = linesOf(web, 'fusion.fire.poison.core', 'en');
    expect(fanout).toMatch(/\b45% chance\b/);
    expect(spread).toMatch(/\b45% chance\b/);
    expect(linesOf(web, 'fusion.fire.poison.core', 'zh-TW')[0]).toMatch(/45% 機率/);
    expect(linesOf(fire, 'fusion.fire.poison.core', 'en')[0]).not.toMatch(/chance/);
  });

  it('shows one chance under coef 1, the one the run rolls, and none off the fusion board (D10)', () => {
    const lightning = assembleWeb(content, 'lightning', FULL_SCOPE, {
      coefs: { 'lightning.poison': 0.5 },
    });
    expect(linesOf(lightning, 'fusion.lightning.poison.core', 'en')[0]).toBe(
      'Each jump, with a 15% chance (at most 3 times an attack): 2 poison stacks, damage ×0.5 on the enemy jumped to',
    );
    const poison = assembleWeb(content, 'fire', FULL_SCOPE, { coefs: { 'fire.poison': 0.5 } });
    const core = poison.byId.get('fusion.fire.poison.core') as WebNode;
    const heal: TriggerSpec = {
      on: 'hit',
      when: [{ chance: 0.4 }],
      do: [{ kind: 'heal', lifePct: 0.01 }],
    };
    const healing = withEffects(poison, core.id, {
      ...core.effects,
      triggers: [...core.effects.triggers, heal],
    });
    expect(linesOf(healing, core.id, 'zh-TW').at(-1)).toBe('擊中敵人時（20% 機率）：回復 1% 生命');
    const hit: TriggerSpec = {
      on: 'hit',
      do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2, damagePct: 0.5 }],
    };
    // The run gives every trigger on the fusion board the coef, and none off it (webBuild).
    const [outer, ranked] = ['outer.poison.alpha.alpha-one', 'fusion.fire.poison.r1'];
    let placed = poison;
    for (const id of [outer, NOTABLE, ranked])
      placed = withEffects(placed, id, { triggers: [hit] });
    for (const id of [outer, NOTABLE]) {
      expect(linesOf(placed, id, 'en')).toEqual([
        'On hitting enemies: 2 poison stacks, damage ×0.5',
      ]);
    }
    expect(linesOf(placed, ranked, 'en')).toEqual([
      'On hitting enemies (50% chance): 2 poison stacks, damage ×0.25 (once per rank)',
    ]);
  });

  /** `c`'s web with its aura fusion (冰光, 雷光) at `coef`. */
  const aura = (c: 'ice' | 'lightning', coef: number) =>
    assembleWeb(content, c, FULL_SCOPE, { coefs: { [`${c}.aura`]: coef } });

  it("fills {bonus} with a template core's bonus as the run has it, signed as its line writes it (D12)", () => {
    for (const [coef, bonus] of [
      [0.45, '+9%'],
      [1, '+20%'],
      [2.3, '+46%'],
    ] as const) {
      for (const c of ['ice', 'lightning'] as const) {
        const core = `fusion.${c}.aura.core`;
        expect(linesOf(aura(c, coef), core, 'en')[0]).toContain(
          `enemies in it take ${bonus} center damage.`,
        );
        expect(linesOf(aura(c, coef), core, 'zh-TW')[0]).toContain(
          `區內的敵人受到中心傷害 ${bonus}；`,
        );
      }
    }
    // Filled without coefScalesBonus too, where the coef leaves the bonus as written.
    const messages = fixtureMessages();
    messages['zh-TW']['web.node.fusion.fire.poison.core.desc'] = '中毒的敵人受到中心傷害 {bonus}。';
    const poison = assembleWeb(content, 'fire', FULL_SCOPE, { coefs: { 'fire.poison': 1.5 } });
    expect(
      describeNode(poison, 'fusion.fire.poison.core', 1, fixtureLookups(messages)['zh-TW']).lines,
    ).toEqual(['中毒的敵人受到中心傷害 +20%。']);
  });

  it('fills {bonus} only on a template core whose bonus line writes a value: not on another node of its board, a powFactor bonus or an inPayload one (D12)', () => {
    /** Node `id`'s first line under the en hand text 'B {bonus}'. */
    const hand = (web: AssembledWeb, id: string): string | undefined => {
      const messages = fixtureMessages();
      messages.en[`web.node.${id}.desc`] = 'B {bonus}';
      return describeNode(web, id, 1, fixtureLookups(messages).en).lines[0];
    };
    const ice = aura('ice', 2.3);
    const core = ice.byId.get('fusion.ice.aura.core') as WebNode;
    // The bonus is the core's first modifier itself, the one V17 matches by identity.
    expect(coreBonus(ice.fusions.get('aura'), core)?.mod).toBe(core.effects.modifiers[0]);
    expect(hand(ice, core.id)).toBe('B +46%');
    // r3, which coefScalesBonus scales too, is not the core.
    expect(hand(ice, 'fusion.ice.aura.r3')).toBe('B {bonus}');
    // A powFactor bonus's line writes a factor, not a value.
    const factor = withBonus('fire.combo', {
      form: 'scaling',
      kind: 'more',
      value: 1,
      scaling: { per: 'lifeLostPct', curve: 'powFactor', exponent: 2, cap: 3 },
    });
    expect(hand(factor, 'fusion.fire.combo.core')).toBe('B {bonus}');
    // An inPayload bonus adds no modifier: the core's first one is the override's own.
    const crit = assembleWeb(
      {
        ...content,
        overrides: {
          ...content.overrides,
          'fire.crit': { ...content.overrides['fire.crit'], modifiers: [inc('damage', 0.1)] },
        },
      },
      'fire',
      FULL_SCOPE,
    );
    expect(crit.byId.get('fusion.fire.crit.core')?.effects.modifiers).toHaveLength(1);
    expect(hand(crit, 'fusion.fire.crit.core')).toBe('B {bonus}');
  });

  it("fills 雷光's {chance} with chainJump's chance at its coef (D11): 13.5% at 0.45, 69% at 2.3", () => {
    const core = 'fusion.lightning.aura.core';
    expect(linesOf(aura('lightning', 0.45), core, 'en')[0]).toContain(
      'Each jump has a 13.5% chance to leave',
    );
    expect(linesOf(aura('lightning', 0.45), core, 'zh-TW')[0]).toContain('每跳有 13.5% 機率');
    expect(linesOf(aura('lightning', 2.3), core, 'en')).toEqual([
      'Each jump has a 69% chance to leave a 2 s pulse zone at the target; enemies in it take +46% center damage. Chain count ×2 and chain hits deal ×4.5 damage; chain retention −20 percentage points.',
    ]);
    expect(linesOf(aura('lightning', 2.3), core, 'zh-TW')[0]).toContain('每跳有 69% 機率');
  });

  it('adds the chance of a trigger with no chance condition after a hand description under coef 1 (D10)', () => {
    const core = 'fusion.ice.aura.core';
    expect(linesOf(aura('ice', 0.45), core, 'en')).toEqual([
      'On each freeze, a 2 s pulse zone at the target; enemies in it take +9% center damage. Every 3rd shot is a guaranteed crit and the crit multiplier ×1.5; no random crits.',
      '45% chance to trigger',
    ]);
    expect(linesOf(aura('ice', 0.45), core, 'zh-TW')).toEqual([
      '凍結時在目標留下 2 秒脈衝區，區內的敵人受到中心傷害 +9%；每第 3 發必定暴擊，暴擊倍率 ×1.5；不會隨機暴擊。',
      '觸發機率 45%',
    ]);
    for (const locale of LOCALES) {
      for (const coef of [1, 2.3]) expect(linesOf(aura('ice', coef), core, locale)).toHaveLength(1);
      // 雷光's one trigger is chainJump, whose chance its {chance} writes.
      expect(linesOf(aura('lightning', 0.45), 'fusion.lightning.aura.core', locale)).toHaveLength(
        1,
      );
    }
    // A trigger with a chance condition has its chance in {chance}.
    const ice = aura('ice', 0.45);
    const node = ice.byId.get(core) as WebNode;
    const chanced = withEffects(ice, core, {
      ...node.effects,
      triggers: node.effects.triggers.map((trigger) => ({ ...trigger, when: [{ chance: 0.5 }] })),
    });
    expect(linesOf(chanced, core, 'en')).toHaveLength(1);
    // The line comes before 「答案：…」.
    const nodes = ice.nodes.map((n): WebNode =>
      n.id === core ? { ...n, answers: ['triangle'] } : n,
    );
    const answering = { ...ice, nodes, byId: new Map(nodes.map((n) => [n.id, n])) };
    expect(linesOf(answering, core, 'zh-TW').slice(1)).toEqual(['觸發機率 45%', '答案：三角']);
    // Off fusion boards nothing is added: a keystone of an outer whose fusion is at 0.45.
    const hit: TriggerSpec = {
      on: 'hit',
      do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }],
    };
    const star = 'outer.poison.main.star';
    const poison = assembleWeb(content, 'fire', FULL_SCOPE, { coefs: { 'fire.poison': 0.45 } });
    expect(linesOf(withEffects(poison, star, { triggers: [hit] }), star, 'en')).toEqual([
      'A fixture keystone with no effect.',
    ]);
  });

  it("puts the hand text in the generated lines' place, its placeholders filled (F25)", () => {
    const messages = fixtureMessages();
    messages.en['web.node.fusion.fire.poison.core.desc'] =
      'Poison {damagePct}, spread at {effect}.';
    messages['zh-TW']['web.node.fusion.lightning.poison.core.desc'] =
      '每跳 {chance}，毒 {damagePct}。';
    messages['zh-TW']['web.node.outer.poison.main.counter.desc'] = '手寫。';
    const hand = fixtureLookups(messages);
    const poison = assembleWeb(content, 'fire', FULL_SCOPE, { coefs: { 'fire.poison': 0.9 } });
    // Its triggers have no chance condition: at 0.9 they roll 90%, which the line after it shows.
    expect(describeNode(poison, 'fusion.fire.poison.core', 1, hand.en).lines).toEqual([
      'Poison ×0.9, spread at 45%.',
      '90% chance to trigger',
    ]);
    const lightning = assembleWeb(content, 'lightning', FULL_SCOPE, {
      coefs: { 'lightning.poison': 1.5 },
    });
    expect(describeNode(lightning, 'fusion.lightning.poison.core', 1, hand['zh-TW']).lines).toEqual(
      ['每跳 45%，毒 ×1.5。'],
    );
    expect(describeNode(fire, 'outer.poison.main.counter', 1, hand['zh-TW']).lines).toEqual([
      '手寫。',
      '答案：三角、五角、盾兵、衝刺者',
    ]);
    expect(describeNode(fire, 'fire.center.main.star-one', 1, lookups.en).lines).toEqual([
      'A fixture keystone with no effect.',
    ]);
  });

  it('adds 「答案：…」 for a node with answers', () => {
    expect(linesOf(fire, 'outer.poison.main.counter', 'zh-TW')).toEqual([
      '答案：三角、五角、盾兵、衝刺者',
    ]);
    expect(linesOf(fire, 'outer.poison.main.counter', 'en')).toEqual([
      'Answers: Triangle, Pentagon, Shielder, Dasher',
    ]);
  });

  it('throws on an id the web does not hold', () => {
    expect(() => describeNode(fire, 'fire.center.main.nope', 1, lookups.en)).toThrow(
      "node 'fire.center.main.nope' is not on character 'fire''s web",
    );
  });
});

describe('the lookups (R6)', () => {
  it("reads the app's messages at the current locale, and lists them", () => {
    expect(APP_LOOKUP.has('web.answers')).toBe(true);
    expect(APP_LOOKUP.has('web.node.fire.center.main.c1.name')).toBe(false);
    const keys = [...APP_LOOKUP.keys()];
    expect(keys).toContain('web.answers');
    expect(keys).toContain('hud.run');
    expect(APP_LOOKUP.get('web.answers', { enemies: 'Triangle' })).toBe('Answers: Triangle');
  });

  it('gives a missing key back as itself', () => {
    const lookup = messageLookup({ a: 'A {x}' });
    expect(lookup.get('a', { x: 1 })).toBe('A 1');
    expect(lookup.get('b')).toBe('b');
    expect(lookup.has('b')).toBe(false);
    expect([...lookup.keys()]).toEqual(['a']);
  });
});

describe('buyCheckText', () => {
  it.each(LOCALES)('writes every refusal in %s', (locale) => {
    for (const reason of BUY_REASONS) {
      const text = buyCheckText({ ok: false, reason, gate: null }, lookups[locale]);
      expect(isFaulty(text), `${reason}: ${text}`).toBe(false);
    }
  });

  it("fills a gate's counts", () => {
    const gate = { center: 8, centerNeed: 8, outer: 3, outerNeed: 6 };
    expect(buyCheckText({ ok: false, reason: 'fusionGate', gate }, lookups['zh-TW'])).toBe(
      '融合解鎖：中心 8/8・外盤 3/6',
    );
    expect(buyCheckText({ ok: false, reason: 'outerGate', gate }, lookups.en)).toBe(
      'Needs 6 nodes on this board (3 so far)',
    );
  });
});
