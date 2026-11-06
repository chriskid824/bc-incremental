/**
 * text.ts (docs/v3 C6 design D22, §3.9, §4.7): the registries and STAT_FORMAT (R3, F52), a node
 * holding one of everything every template writes, and describeNode on the fixture through its
 * lookups (F45): hand text, ranks, a fusion's coef and the answers.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EmitterGrant } from '../../data/emitters';
import { mentions, quotedNumbers, triggerNumbers } from '../../data/ruleNumbers';
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
import type { ChainBoltSpec, EffectKind, TriggerSpec } from '../../data/triggers';
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
  COUNT_STAT_TEXT,
  CURVE_TEXT,
  describeNode,
  EFFECT_TEXT,
  EVENT_TEXT,
  FANOUT_TEXT,
  GRANT_TEXT,
  KIND_TEXT,
  messageLookup,
  SCALING_TEXT,
  SEGMENT_TEXT,
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
    COUNT_STAT_TEXT,
    CONDITION_TEXT,
    CURVE_TEXT,
    EVENT_TEXT,
    GRANT_TEXT,
    SEGMENT_TEXT,
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
      'areaSize',
      'bombRadius',
      'spreadRadius',
      'droneSpeed',
      'summonDuration',
      'barrageSplit',
      'orbitSpeed',
      'thornsArea',
      'walletWeight',
      'interestRate',
      'bonusWaveInterest',
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
    // 爆靈-like timed rows (C5.7), and rows with every other field.
    {
      on: 'nthAttack',
      every: 4,
      do: [
        {
          kind: 'spawnDrone',
          lifeSec: 4,
          damagePct: 1,
          maxLive: 6,
          ailment: 'burn',
          ailmentStacks: 3,
        },
      ],
    },
    {
      on: 'kill',
      do: [
        {
          kind: 'spawnDrone',
          lifeSec: 4,
          damagePct: 0.5,
          count: 2,
          impacts: 3,
          aim: 'outer',
          speed: 500,
          splash: 30,
          ailment: 'shock',
          ailmentDamagePct: 1.5,
          tags: ['projectile'],
          element: 'cold',
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
      on: 'droneImpact',
      when: [{ targetHas: 'frozen' }, { targetKind: 'elite' }],
      do: [{ kind: 'execute' }],
    },
    {
      on: 'explode',
      target: { pick: 'nearest' },
      do: [{ kind: 'chainBolt', jumps: 2, damagePct: 0.4, shockStacks: 1, from: 'nearestToPoint' }],
    },
    // E7's nearest other enemy and its several bolts.
    ...(
      [
        { from: 'nearestOther' },
        { from: 'nearestOther', bolts: 3, arc: true },
        { from: 'nearestToPoint', bolts: 2 },
      ] as const
    ).map((more): TriggerSpec => ({
      on: 'freeze',
      do: [{ kind: 'chainBolt', jumps: 0, damagePct: 0.5, ...more }],
    })),
    { on: 'hit', do: [{ kind: 'comboStack', stacks: 2 }] },
    {
      on: 'periodic',
      every: 10,
      do: [{ kind: 'buff', stat: 'attackSpeed', more: 2, durationSec: 2, tags: ['minion'] }],
    },
    // E6: 熱震's 解凍.
    {
      on: 'ailmentApplied',
      when: [{ ailment: 'burn' }, { targetHas: 'frozen' }],
      do: [{ kind: 'thaw' }],
    },
    // E15: ◆引力's pull to the aura's edge, and one to a distance.
    {
      on: 'periodic',
      every: 4,
      target: { pick: 'outermost', excludeBoss: true },
      do: [{ kind: 'pull', to: 'auraEdge' }],
    },
    { on: 'hit', do: [{ kind: 'pull', to: 120 }] },
    // E17: ◆撒幣's spend before its coin, paid only while the target lives (G5), and a spend
    // paid on every firing.
    {
      on: 'nthAttack',
      every: 10,
      do: [
        { kind: 'spendShards', fraction: 0.001, liveTarget: true },
        { kind: 'coinHit', multiplier: 10, ignoreShield: true, ignoreArmour: true },
      ],
    },
    { on: 'waveStart', do: [{ kind: 'spendShards', fraction: 0.05 }] },
    // E17: 利息's payout at the clear, at its defaults and with both fields set.
    { on: 'waveCleared', do: [{ kind: 'interest' }] },
    { on: 'waveCleared', do: [{ kind: 'interest', rateStep: 0.0025, rateMax: 0.15 }] },
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
    { on: 'hit', when: [{ targetIs: 'highestHp' }], do: [heal] },
    // E14's combo condition: a count, and 滿層 (◆爆發's).
    { on: 'periodic', every: 1, when: [{ comboAtLeast: 15 }], do: [heal] },
    { on: 'nthAttack', every: 5, when: [{ comboAtLeast: 'full' }], do: [heal] },
    // E15's aura condition.
    { on: 'hit', when: [{ inAura: true }], do: [heal] },
    ...TARGET_PICKS.map((pick): TriggerSpec => ({ on: 'hit', target: { pick }, do: [heal] })),
    ...(['outward', 'nearest', 'eventTarget', 'along', 'flight'] as const).map(
      (toward): TriggerSpec => ({
        on: 'hit',
        do: [{ kind: 'slashLine', length: 100, width: 10, damagePct: 1, toward }],
      }),
    ),
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
    // 雷網蜂- and 雷射柵欄-like links between the pool's rows (C5.8).
    { kind: 'segment', endpoints: 'drones', links: 1, pairPeriodSec: 0.5 },
    { kind: 'segment', endpoints: 'summons', links: 1 },
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
    // E16: 刺蝟's six at once, tagged thorns.
    {
      kind: 'strike',
      name: 'hedgehog',
      periodSec: 1,
      target: { pick: 'nearest', range: 200 },
      targets: 6,
      damagePct: 0.75,
      tags: ['thorns'],
    },
    { kind: 'drone', drones: 2, turrets: 1 },
    { kind: 'drone', drones: 1, turrets: 2 },
    { kind: 'aura', everyNth: { n: 4, mult: 4 }, corona: { periodSec: 2, damagePct: 1 } },
    { kind: 'orbit', ring: 1, count: 2 },
    { kind: 'orbit' },
    { kind: 'barrage' },
    // E17: 金山's gold ring.
    { kind: 'goldRing', radius: 200, dropPct: 0.5 },
  ];
  return effects({
    modifiers,
    triggers,
    emitters,
    conversions: [
      { tags: ['hit'], to: 'cold', fraction: 0.5 },
      { to: 'burn', fraction: 0.25 },
    ],
    rules: [
      { id: 'glassCannon', damageMore: 1 },
      { id: 'gigantism', sizeMult: 2 },
      { id: 'poisonSlow', stacksPer: 5, slowPer: 0.02, max: 0.4 },
    ],
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
      /^web\.(?:kind|effect|word|ailment|applied|held|state|killedBy|toward|aim|spawnAim|extra|event|fanout|cond|hit|targetKind|enemies|how|trigger|conds|pick|scaling|curve|mod|qual|scope|tag|rank|conversion|ruleFallback|rule|targetIs|centerDamage|bonus|grant|ring|masteryName|coreName|answers|join)\b/;
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

  it.each([
    [
      'en',
      [
        'Every 4 attacks: 1 spirit of 4 s, each dashing at the nearest enemy, impacting for 100% damage, 3 burn stacks on each enemy its impact reaches, at most 6 at once',
        'On hitting enemies: 3 spirits of 2.5 s, each dashing at the outermost enemy, impacting for 40% damage, up to 3 times each, radius 25, tagged projectile',
        'When enemies are killed: 1 spirit of 1 s, each dashing at the nearest enemy, 1 poison stack on each enemy its impact reaches, damage ×2',
      ],
    ],
    [
      'zh-TW',
      [
        '每 4 次攻擊：生出 1 隻 4 秒的靈，衝向最近的敵人，撞擊造成 100% 傷害，衝擊範圍內的敵人燃燒 3 層（最多 6 隻）',
        '擊中敵人時：生出 3 隻 2.5 秒的靈，衝向最外圈的敵人，撞擊造成 40% 傷害，每隻最多撞擊 3 次，範圍半徑 25，帶投射物標籤',
        '敵人死亡時：生出 1 隻 1 秒的靈，衝向最近的敵人，衝擊範圍內的敵人毒 1 層，傷害 ×2',
      ],
    ],
  ] as const)('writes spawnDrone, its rows and their terms, in %s (C5.7)', (locale, expected) => {
    const web = withEffects(fire, NOTABLE, {
      triggers: [
        {
          on: 'nthAttack',
          every: 4,
          do: [
            {
              kind: 'spawnDrone',
              lifeSec: 4,
              damagePct: 1,
              maxLive: 6,
              ailment: 'burn',
              ailmentStacks: 3,
            },
          ],
        },
        {
          on: 'hit',
          do: [
            {
              kind: 'spawnDrone',
              lifeSec: 2.5,
              damagePct: 0.4,
              count: 3,
              impacts: 3,
              aim: 'outer',
              splash: 25,
              tags: ['projectile'],
            },
          ],
        },
        {
          on: 'kill',
          do: [
            {
              kind: 'spawnDrone',
              lifeSec: 1,
              damagePct: 0,
              ailment: 'poison',
              ailmentDamagePct: 2,
            },
          ],
        },
      ],
    });
    expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
  });

  it.each([
    [
      'en',
      [
        'Lightning web: every 0.25 s, shocked enemies link to their 2 nearest within 200; each enemy on a link takes 10% damage and 1 shock stack',
        'Arcs: every 0.25 s, each drone links to its 1 nearest within 200, relinking every 0.5 s; each enemy on a link takes 10% damage and 1 shock stack',
        'Laser fence: every 0.5 s, each summon links to its 2 nearest within 150; each enemy on a link takes 20% damage and 2 shock stacks',
      ],
    ],
    [
      'zh-TW',
      [
        '雷網：每 0.25 秒，感電的敵人連向最近的 2 隻（200 內），線上的敵人受到 10% 傷害並感電 1 層',
        '電弧：每 0.25 秒，每架無人機連向最近的 1 架（200 內），每 0.5 秒重新連線，線上的敵人受到 10% 傷害並感電 1 層',
        '雷射：每 0.5 秒，每個召喚物連向最近的 2 個（150 內），線上的敵人受到 20% 傷害並感電 2 層',
      ],
    ],
  ] as const)(
    'writes a segment grant by its endpoints, the pairing period with it, in %s (C5.8)',
    (locale, expected) => {
      const web = withEffects(fire, NOTABLE, {
        emitters: [
          { kind: 'segment', endpoints: 'shocked' },
          { kind: 'segment', endpoints: 'drones', links: 1, pairPeriodSec: 0.5 },
          {
            kind: 'segment',
            endpoints: 'summons',
            periodSec: 0.5,
            range: 150,
            damagePct: 0.2,
            shockStacks: 2,
            pairPeriodSec: 0,
          },
        ],
      });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
    },
  );

  it.each([
    [
      'en',
      [
        '+2 Small projectiles',
        '+1 Small projectile pierce',
        'Small projectiles: after each attack, they fly straight at different enemies, nearest first; 25% damage each',
        'Small projectiles: after each attack, they fly straight at different enemies, nearest first; 60% damage each',
      ],
    ],
    [
      'zh-TW',
      [
        '小彈數量 +2',
        '小彈穿透 +1',
        '小彈：每次攻擊後，小彈直線射向不同的敵人（近的先），每發 25% 傷害',
        '小彈：每次攻擊後，小彈直線射向不同的敵人（近的先），每發 60% 傷害',
      ],
    ],
  ] as const)(
    'writes 副彈’s barrage grant beside its count and pierce, its share at its default, in %s (E10a)',
    (locale, expected) => {
      const web = withEffects(fire, NOTABLE, {
        modifiers: [
          { stat: 'barrageCount', kind: 'flat', value: 2 },
          { stat: 'barragePierce', kind: 'flat', value: 1 },
        ],
        emitters: [{ kind: 'barrage' }, { kind: 'barrage', damagePct: 0.6 }],
      });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
    },
  );

  it.each([
    ['en', ['+15% Small projectile split chance', '+1 Small projectile pierce']],
    ['zh-TW', ['小彈分裂機率 +15%', '小彈穿透 +1']],
  ] as const)(
    'writes the 分裂 rank’s barrageSplit as a chance beside the pierce rank, in %s (E10b)',
    (locale, expected) => {
      const web = withEffects(fire, NOTABLE, {
        modifiers: [
          { stat: 'barrageSplit', kind: 'flat', value: 0.15 },
          { stat: 'barragePierce', kind: 'flat', value: 1 },
        ],
      });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
    },
  );

  it.each([
    [
      'en',
      [
        '+2 Combo stack cap',
        'Every 5 attacks (at full combo): repeat the signature attack 1 time at 100% damage',
        'Every 1 s (at 15+ combo stacks, 50% chance): heal 1% of max life',
      ],
    ],
    [
      'zh-TW',
      [
        '連擊層數上限 +2',
        '每 5 次攻擊（連擊滿層時）：重複招牌攻擊 1 次，每次 100% 傷害',
        '每 1 秒（連擊 15 層以上時，50% 機率）：回復 1% 生命',
      ],
    ],
  ] as const)(
    'writes a comboCap modifier, ◆爆發’s full combo and a count of stacks on a notable, in %s (E14)',
    (locale, expected) => {
      // Plants the condition's text missing (the registry's key unfilled), or 'full' as a count.
      const web = withEffects(fire, NOTABLE, {
        modifiers: [{ stat: 'comboCap', kind: 'flat', value: 2 }],
        triggers: [
          {
            on: 'nthAttack',
            every: 5,
            when: [{ comboAtLeast: 'full' }],
            do: [{ kind: 'repeatAttack', count: 1, damagePct: 1 }],
          },
          {
            on: 'periodic',
            every: 1,
            when: [{ comboAtLeast: 15 }, { chance: 0.5 }],
            do: [{ kind: 'heal', lifePct: 0.01 }],
          },
        ],
      });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
    },
  );

  it.each([
    [
      'en',
      [
        '20% increased Damage (against enemies inside the aura)',
        'On hitting elites inside the aura (50% chance): heal 1% of max life',
        'Every 4 attacks (against enemies inside the aura): heal 1% of max life',
      ],
    ],
    [
      'zh-TW',
      [
        '傷害提高 20%（對光環內的敵人）',
        '擊中光環內的菁英時（50% 機率）：回復 1% 生命',
        '每 4 次攻擊（對光環內的敵人）：回復 1% 生命',
      ],
    ],
  ] as const)(
    'writes ◆弱化’s inAura modifier and a hit trigger’s inAura as enemies inside the aura, in %s (E15)',
    (locale, expected) => {
      // Plants the condition's text missing, left off the enemies (ENEMY_CONDITIONS), or written
      // through another condition's branch, which asks for a key that does not ship.
      const web = withEffects(fire, NOTABLE, {
        modifiers: [{ stat: 'damage', kind: 'increased', value: 0.2, when: [{ inAura: true }] }],
        triggers: [
          {
            on: 'hit',
            when: [{ inAura: true }, { targetKind: 'elite' }, { chance: 0.5 }],
            do: [{ kind: 'heal', lifePct: 0.01 }],
          },
          {
            on: 'nthAttack',
            every: 4,
            when: [{ inAura: true }],
            do: [{ kind: 'heal', lifePct: 0.01 }],
          },
        ],
      });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
      const asked = new Set<string>();
      describeNode(web, NOTABLE, 1, recording(lookups[locale], asked));
      expect([...asked].filter((key) => !lookups[locale].has(key))).toEqual([]);
    },
  );

  it.each([
    [
      'en',
      [
        [
          '+1 Ignore shields (tagged aura only)',
          'Aura: each pulse, enemies around you take 25% damage, one pulse in 4 hits, at ×4',
        ],
        [
          'Aura: each pulse, enemies around you take 25% damage, and a corona every 8 s: ' +
            "every enemy takes ×1 a pulse's damage",
        ],
      ],
    ],
    [
      'zh-TW',
      [
        [
          '無視護盾 +1（限光環標籤）',
          '光環：每次脈衝，你周圍的敵人受到 25% 傷害，每 4 次脈衝只打一次，傷害 ×4',
        ],
        ['光環：每次脈衝，你周圍的敵人受到 25% 傷害，每 8 秒放一次日冕：所有敵人受到 ×1 脈衝傷害'],
      ],
    ],
  ] as const)(
    'writes 聚能脈衝’s and 日冕’s aura grants as their nodes hold them, not as the aura they combine into, in %s (E15)',
    (locale, expected) => {
      // A node's text reads its own grant (grantText), its unset damagePct at the default; the
      // run combines the source's grants (lead ruling W1), which no node's text sees.
      const focus = withEffects(fire, NOTABLE, {
        modifiers: [{ stat: 'ignoreShield', kind: 'flat', value: 1, tags: ['aura'] }],
        emitters: [{ kind: 'aura', everyNth: { n: 4, mult: 4 } }],
      });
      const corona = withEffects(fire, NOTABLE, {
        emitters: [{ kind: 'aura', corona: { periodSec: 8, damagePct: 1 } }],
      });
      expect([linesOf(focus, NOTABLE, locale), linesOf(corona, NOTABLE, locale)]).toEqual(expected);
    },
  );

  it.each([
    ['en', '+2 Combo stack cap per rank (2/3: +4)'],
    ['zh-TW', '每級連擊層數上限 +2（2/3：+4）'],
  ] as const)(
    'writes 動能’s 層數上限 on a ranked node, a flat count a rank with its total, in %s (E14)',
    (locale, line) => {
      // ranked('comboCap', 2, 3, 'flat') at rank 2: stacks, never a percentage.
      const web = withEffects(fire, 'fire.center.alpha.r1', {
        modifiers: [{ stat: 'comboCap', kind: 'flat', value: 2 }],
      });
      expect(linesOf(web, 'fire.center.alpha.r1', locale, 2)).toEqual([line]);
    },
  );

  it.each([
    ['en', '15% increased Orbit speed per rank (2/3: +30%)'],
    ['zh-TW', '每級環繞球轉速提高 15%（2/3：+30%）'],
  ] as const)(
    'writes 環繞’s 轉速 on a ranked node, an increased percentage a rank with its total, in %s (E15)',
    (locale, line) => {
      // ranked('orbitSpeed', 0.15, 3) at rank 2: a percentage, as the increased stats beside it.
      const web = withEffects(fire, 'fire.center.alpha.r1', {
        modifiers: [{ stat: 'orbitSpeed', kind: 'increased', value: 0.15 }],
      });
      expect(linesOf(web, 'fire.center.alpha.r1', locale, 2)).toEqual([line]);
    },
  );

  it.each([
    ['en', '15% increased Thorns area per rank (2/3: +30%)'],
    ['zh-TW', '每級荊棘範圍提高 15%（2/3：+30%）'],
  ] as const)(
    'writes 尖刺’s 荊棘範圍 on a ranked node, an increased percentage a rank with its total, in %s (E16)',
    (locale, line) => {
      // ranked('thornsArea', 0.15, 3) at rank 2: a percentage, as bombRadius's and orbitSpeed's.
      const web = withEffects(fire, 'fire.center.alpha.r1', {
        modifiers: [{ stat: 'thornsArea', kind: 'increased', value: 0.15 }],
      });
      expect(linesOf(web, 'fire.center.alpha.r1', locale, 2)).toEqual([line]);
    },
  );

  it.each([
    [
      'en',
      [
        'Every 1 s, a strike on the nearest enemy within 200: 75% damage, up to 6 enemies at ' +
          'once, tagged thorns',
        'Every 2 s, a strike on the farthest enemy: 100% damage, radius 40, tagged thorns and ' +
          'projectile',
      ],
    ],
    [
      'zh-TW',
      [
        '每 1 秒一道打擊，打半徑 200 內最近的敵人，75% 傷害，一次最多打 6 隻，帶荊棘標籤',
        '每 2 秒一道打擊，打最遠的敵人，100% 傷害，範圍半徑 40，帶荊棘、投射物標籤',
      ],
    ],
  ] as const)(
    'writes 刺蝟’s strike of targets 6 tagged thorns on a notable, its targets and tags quoted, in %s (E16)',
    (locale, expected) => {
      // Plants the targets or the tags left out of the line.
      const web = withEffects(fire, NOTABLE, {
        emitters: [
          {
            kind: 'strike',
            name: 'hedgehog',
            periodSec: 1,
            target: { pick: 'nearest', range: 200 },
            targets: 6,
            damagePct: 0.75,
            tags: ['thorns'],
          },
          {
            kind: 'strike',
            name: 'one',
            periodSec: 2,
            target: { pick: 'farthest' },
            targets: 1,
            damagePct: 1,
            radius: 40,
            tags: ['thorns', 'projectile'],
          },
        ],
      });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
    },
  );

  it.each([
    [
      'en',
      [
        "Every 4 s, at the enemy farthest from you (never a boss): pull it to the aura's edge",
        'On hitting enemies: pull it to within 120 of you',
      ],
    ],
    [
      'zh-TW',
      ['每 4 秒，對離你最遠的敵人（不含 Boss）：拉到光環邊緣', '擊中敵人時：拉到離你 120 以內'],
    ],
  ] as const)(
    'writes ◆引力’s pull to the aura’s edge and a pull to a distance on a notable, in %s (E15)',
    (locale, expected) => {
      // Plants the pull's text missing, or its distance unquoted.
      const web = withEffects(fire, NOTABLE, {
        triggers: [
          {
            on: 'periodic',
            every: 4,
            target: { pick: 'outermost', excludeBoss: true },
            do: [{ kind: 'pull', to: 'auraEdge' }],
          },
          { on: 'hit', do: [{ kind: 'pull', to: 120 }] },
        ],
      });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
    },
  );

  it.each([
    ['en', ['+50% Wallet weight']],
    ['zh-TW', ['錢包碎片權重 +50%']],
  ] as const)(
    'writes ◆金庫’s flat walletWeight 0.5 as a percentage on the weight, in %s (E17)',
    (locale, expected) => {
      // Plants walletWeight read as a number (+0.5), or its name missing.
      const web = withEffects(fire, NOTABLE, { modifiers: [flat('walletWeight', 0.5)] });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
    },
  );

  it.each([
    [
      'en',
      [
        '+1% Interest rate',
        '+200% Bonus wave interest',
        "At the end of each wave: earn interest on this run's shards, the rate rising 0.5 percentage points each time, at most 10%",
        "At the end of each wave (50% chance): earn interest on this run's shards, the rate rising 0.25 percentage points each time, at most 15%",
      ],
    ],
    [
      'zh-TW',
      [
        '利率 +1%',
        '獎勵波利息倍率 +200%',
        '每波結束時：拿本局碎片的一部分當利息，每次利率提高 0.5 個百分點，最多 10%',
        '每波結束時（50% 機率）：拿本局碎片的一部分當利息，每次利率提高 0.25 個百分點，最多 15%',
      ],
    ],
  ] as const)(
    'writes 利息’s waveCleared interest at its defaults and set, and the two stats as percentages, in %s (E17)',
    (locale, expected) => {
      // Plants the defaults left out of the line, the step written as a fraction (0.005) or a
      // percent (0.5%), the stats read as numbers (+0.01, +2), or a name missing.
      const web = withEffects(fire, NOTABLE, {
        triggers: [
          { on: 'waveCleared', do: [{ kind: 'interest' }] },
          {
            on: 'waveCleared',
            when: [{ chance: 0.5 }],
            do: [{ kind: 'interest', rateStep: 0.0025, rateMax: 0.15 }],
          },
        ],
        modifiers: [flat('interestRate', 0.01), flat('bonusWaveInterest', 2)],
      });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
    },
  );

  it.each([
    [
      'en',
      ['1% increased Interest rate per rank (2/3: +2%)'],
      ['+1% Interest rate per rank (2/3: +2%)'],
    ],
    ['zh-TW', ['每級利率提高 1%（2/3：+2%）'], ['每級利率 +1%（2/3：+2%）']],
  ] as const)(
    'writes ranked interestRate 0.01 at rank 2, increased (as ranked() writes it) and flat, in %s (E17)',
    (locale, increased, flatLines) => {
      const id = 'fire.center.alpha.r1';
      const inced = withEffects(fire, id, { modifiers: [inc('interestRate', 0.01)] });
      expect(linesOf(inced, id, locale, 2)).toEqual(increased);
      const flatted = withEffects(fire, id, { modifiers: [flat('interestRate', 0.01)] });
      expect(linesOf(flatted, id, locale, 2)).toEqual(flatLines);
    },
  );

  it.each([
    [
      'en',
      [
        '+0.5% Interest rate per rank (3/4: +1.5%)',
        "At the end of each wave: earn interest on this run's shards, the rate rising 0.5 percentage points each time, at most 10%",
        'When enemies are killed: heal 1% of max life (once per rank)',
      ],
    ],
    [
      'zh-TW',
      [
        '每級利率 +0.5%（3/4：+1.5%）',
        '每波結束時：拿本局碎片的一部分當利息，每次利率提高 0.5 個百分點，最多 10%',
        '敵人死亡時：回復 1% 生命（每級各一次）',
      ],
    ],
  ] as const)(
    'writes 利息’s 4-rank node at rank 3: its rate per rank, its interest trigger once and not once per rank, and an ordinary trigger once per rank, in %s (lead ruling 23a)',
    (locale, expected) => {
      // Plants the interest trigger's line still saying once per rank, or every trigger's line
      // without it (B4's lead ruling 23a: webBuild puts the interest trigger in once).
      const id = 'outer.greed.alpha.r1';
      const nodes = fire.nodes.map((node): WebNode =>
        node.id === id
          ? {
              ...node,
              ranks: 4,
              effects: effects({
                modifiers: [flat('interestRate', 0.005)],
                triggers: [
                  { on: 'waveCleared', do: [{ kind: 'interest' }] },
                  { on: 'kill', do: [{ kind: 'heal', lifePct: 0.01 }] },
                ],
              }),
            }
          : node,
      );
      const web = { ...fire, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
      expect(linesOf(web, id, locale, 3)).toEqual(expected);
    },
  );

  it.each([
    [
      'en',
      [
        "Every 10 attacks: spend 0.1% of this run's shards if the target still lives; a coin hit for 10× hit damage, ignoring shields, ignoring armour",
        "On hitting normal enemies below 15% life: spend 0.2% of this run's shards if the target still lives; an execute: an enemy that is no boss dies at once",
      ],
    ],
    [
      'zh-TW',
      [
        '每 10 次攻擊：目標還活著才花本局碎片 0.1%；金幣擊中，10 倍擊中，無視護盾，無視堅甲',
        '擊中生命低於 15% 的一般敵人時：目標還活著才花本局碎片 0.2%；處決：非 Boss 的敵人立刻死亡',
      ],
    ],
  ] as const)(
    'writes ◆撒幣’s and ◆買斷’s spends before their coin and execute on a notable, paid while the target lives, in %s (E17, G5)',
    (locale, expected) => {
      // Plants the spend's text missing, its share rounded to a whole percent, or liveTarget
      // left out of it.
      const web = withEffects(fire, NOTABLE, {
        triggers: [
          {
            on: 'nthAttack',
            every: 10,
            do: [
              { kind: 'spendShards', fraction: 0.001, liveTarget: true },
              { kind: 'coinHit', multiplier: 10, ignoreShield: true, ignoreArmour: true },
            ],
          },
          {
            on: 'hit',
            when: [{ targetHpBelow: 0.15 }, { targetKind: 'normal' }],
            do: [{ kind: 'spendShards', fraction: 0.002, liveTarget: true }, { kind: 'execute' }],
          },
        ],
      });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
    },
  );

  it.each([
    [
      'en',
      [
        'Gold ring: enemies killed within 200 of you drop 50% more shards',
        'Gold ring: enemies killed within 87.5 of you drop 12.5% more shards',
      ],
    ],
    [
      'zh-TW',
      [
        '金色光圈：你周圍半徑 200 內擊殺的敵人多掉 50% 碎片',
        '金色光圈：你周圍半徑 87.5 內擊殺的敵人多掉 12.5% 碎片',
      ],
    ],
  ] as const)(
    'writes 金山’s gold ring on a notable, its radius as written and its share more, in %s (E17)',
    (locale, expected) => {
      // Plants the ring's line missing, its radius rounded, or its share quoted as the ring's
      // mult (150%) or rounded to a whole percent.
      const web = withEffects(fire, NOTABLE, {
        emitters: [
          { kind: 'goldRing', radius: 200, dropPct: 0.5 },
          { kind: 'goldRing', radius: 87.5, dropPct: 0.125 },
        ],
      });
      expect(linesOf(web, NOTABLE, locale)).toEqual(expected);
    },
  );

  it.each([
    [
      'en',
      [
        "On each freeze: spend 1% of this run's shards",
        "Each explosion: spend 0.5% of this run's shards; heal 2% of max life",
      ],
    ],
    ['zh-TW', ['凍結時：花本局碎片 1%', '每次爆炸：花本局碎片 0.5%；回復 2% 生命']],
  ] as const)(
    'reads a center event’s spend as one on the player, not at the target, in %s (E17)',
    (locale, expected) => {
      // Plants spendShards missing from onPlayer: a lone spend on a freeze would read 「在目標」,
      // and one beside a heal on an explosion 「在落點」, though the run's shards are the player's.
      const web = withEffects(fire, NOTABLE, {
        triggers: [
          { on: 'freeze', do: [{ kind: 'spendShards', fraction: 0.01 }] },
          {
            on: 'explode',
            do: [
              { kind: 'spendShards', fraction: 0.005 },
              { kind: 'heal', lifePct: 0.02 },
            ],
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

  it("writes the hive crit core's slash along its flight, in both locales (FL, gd:643)", () => {
    // Planted bug: web.toward.flight missing or wrong in either locale.
    const summon = assembleWeb(content, 'summon', FULL_SCOPE);
    expect(linesOf(summon, 'fusion.summon.crit.core', 'en')).toEqual([
      'Each drone impact, at its target: a slash along its flight, 300 long and 24 wide, for 100% damage, always a crit, +10% damage per 10% crit chance',
      "This fusion takes the Crit board's bonuses",
    ]);
    expect(linesOf(summon, 'fusion.summon.crit.core', 'zh-TW')).toEqual([
      '每次撞擊，在目標：沿飛行方向畫一條長 300、寬 24 的斬擊線，100% 傷害，必定暴擊，每 10% 暴擊率傷害 +10%',
      '這條融合吃暴擊外盤的加成',
    ]);
  });

  it('writes the barrage core’s count link after its count, and no link on projectiles without one (C6b.1, gd:564)', () => {
    expect(linesOf(fire, 'fusion.fire.barrage.core', 'en')).toEqual([
      'Each explosion, where it lands: 4 small projectiles all around, 25% damage each, +1 for each of your small projectiles above 2',
      "This fusion takes the Barrage board's bonuses",
    ]);
    expect(linesOf(fire, 'fusion.fire.barrage.core', 'zh-TW')).toEqual([
      '每次爆炸，在落點：朝四周射出 4 發小彈，每發 25% 傷害，彈幕外盤每多 1 發小彈，這裡也多 1 發',
      '這條融合吃彈幕外盤的加成',
    ]);
    const radial = { kind: 'projectiles', count: 4, aim: 'radial', damagePct: 0.25 } as const;
    const web = withEffects(fire, NOTABLE, {
      modifiers: [flat('barrageCount', 2)],
      triggers: [{ on: 'kill', do: [radial] }],
    });
    expect(linesOf(web, NOTABLE, 'en')).toEqual([
      '+2 Small projectiles',
      'When enemies are killed: 4 small projectiles all around, 25% damage each',
    ]);
    expect(linesOf(web, NOTABLE, 'zh-TW')).toEqual([
      '小彈數量 +2',
      '敵人死亡時：朝四周射出 4 發小彈，每發 25% 傷害',
    ]);
  });

  it('writes the count link on a linked projectiles effect of any aim, as the barrage entry would fire it (C6b.1)', () => {
    const entry = {
      kind: 'projectiles',
      count: 2,
      aim: 'distinct',
      damagePct: 0.25,
      countStat: 'barrageCount',
    } as const;
    const web = withEffects(fire, NOTABLE, {
      triggers: [{ on: 'kill', do: [entry, { ...entry, aim: 'fan', spreadDeg: 40 }] }],
    });
    expect(linesOf(web, NOTABLE, 'en')).toEqual([
      'When enemies are killed: 2 small projectiles one at each of the nearest enemies, 25% damage each, +1 for each of your small projectiles above 2; 2 small projectiles in a fan at the target, 25% damage each, over 40°, +1 for each of your small projectiles above 2',
    ]);
    expect(linesOf(web, NOTABLE, 'zh-TW')).toEqual([
      '敵人死亡時：分別朝最近的敵人射出 2 發小彈，每發 25% 傷害，彈幕外盤每多 1 發小彈，這裡也多 1 發；呈扇形朝目標射出 2 發小彈，每發 25% 傷害，扇形 40°，彈幕外盤每多 1 發小彈，這裡也多 1 發',
    ]);
  });

  it('writes the combo stacks, the buffs and comboStacks in both locales (C6b.2)', () => {
    // Plants a template or a locale left without them: the lines would hold their keys.
    const lines = (part: Partial<NodeEffects>, locale: Locale): readonly string[] =>
      describeNode(withEffects(fire, NOTABLE, part), NOTABLE, 1, lookups[locale]).lines;
    const triggers: TriggerSpec[] = [
      { on: 'hit', do: [{ kind: 'comboStack', stacks: 1 }] },
      { on: 'kill', do: [{ kind: 'comboStack', stacks: 3 }] },
      {
        on: 'periodic',
        every: 10,
        do: [{ kind: 'buff', stat: 'attackSpeed', more: 2, durationSec: 2, tags: ['minion'] }],
      },
      { on: 'waveStart', do: [{ kind: 'buff', stat: 'attackSpeed', more: 0.5, durationSec: 1.5 }] },
    ];
    const modifiers: Modifier[] = [
      { stat: 'attackSpeed', kind: 'more', value: 0.03, scaling: { per: 'comboStacks' } },
      { stat: 'damage', kind: 'increased', value: 0.04, scaling: { per: 'comboStacks', every: 5 } },
    ];
    expect(LOCALES.map((locale) => lines({ triggers, modifiers }, locale))).toEqual([
      [
        '3% more Attack speed (per combo stack)',
        '4% increased Damage (per 5 combo stacks)',
        'On hitting enemies: +1 combo stack',
        'When enemies are killed: +3 combo stacks',
        'Every 10 s: Attack speed ×3 for 2 s, minion attacks only',
        'At the start of each wave: Attack speed ×1.5 for 1.5 s',
      ],
      [
        '攻擊速度總增 3%（每層連擊）',
        '傷害提高 4%（每 5 層連擊）',
        '擊中敵人時：+1 層連擊',
        '敵人死亡時：+3 層連擊',
        '每 10 秒：攻擊速度 ×3，持續 2 秒，只限召喚物的攻擊',
        '每波開始時：攻擊速度 ×1.5，持續 1.5 秒',
      ],
    ]);
    // The fixture's combo payload (lead ruling K8, gd:565): a stack per explosion, a bonus on them.
    expect(LOCALES.map((locale) => linesOf(fire, 'fusion.fire.combo.core', locale))).toEqual([
      ['Each explosion: +1 combo stack', '+4% center damage per 5 combo stacks'],
      ['每次爆炸：+1 層連擊', '每 5 層連擊，中心傷害 +4%'],
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

describe('the per-tick variables and the kill shards (C6b.3)', () => {
  const greedCore = (c: 'fire' | 'summon', locale: Locale): readonly string[] =>
    linesOf(assembleWeb(content, c, FULL_SCOPE), `fusion.${c}.greed.core`, locale);

  it('writes shardsHeld and enemiesInAura in both locales', () => {
    const mods = [
      inc('damage', 0.02, { scaling: { per: 'enemiesInAura', cap: 0.2 } }),
      flat('critChance', 0.01, { scaling: { per: 'shardsHeld', every: 1000 } }),
      more('damage', 0.1, { scaling: { per: 'enemiesInAura', curve: 'log10' } }),
      more('damage', 1, { scaling: { per: 'shardsHeld', curve: 'powFactor', exponent: 0.06 } }),
    ];
    expect(LOCALES.map((locale) => mods.map((mod) => modifierLine(mod, lookups[locale])))).toEqual([
      [
        '2% increased Damage (per enemy in your aura, at most 20%)',
        '+1% Crit chance (per 1000 shards you hold)',
        '10% more Damage (rising with the enemies in your aura at a slowing rate (log₁₀))',
        'Damage ×(the shards you hold to the power 0.06)',
      ],
      [
        '傷害提高 2%（光環內每隻敵人，最多 20%）',
        '暴擊率 +1%（每持有 1000 碎片）',
        '傷害總增 10%（隨光環內的敵人數成長，越來越慢（log₁₀））',
        '傷害 ×（持有的碎片的 0.06 次方）',
      ],
    ]);
  });

  it('writes greed’s core: its coin with the kill shards, and its held-shard factor', () => {
    expect([
      greedCore('fire', 'en'),
      greedCore('fire', 'zh-TW'),
      greedCore('summon', 'en'),
    ]).toEqual([
      [
        'Each explosion, where it lands: a coin hit for 10× hit damage, ignoring shields; the enemies it kills drop +1% shards',
        'Center damage ×(the shards you hold to the power 0.06)',
      ],
      [
        '每次爆炸，在落點：金幣擊中，10 倍擊中，無視護盾；它造成的擊殺碎片 +1%',
        '中心傷害 ×（持有的碎片的 0.06 次方）',
      ],
      [
        'Each drone impact, at its target: a coin hit for 10× hit damage, ignoring shields; the enemies it kills drop +1% shards',
        'Center damage ×(the shards you hold to the power 0.06)',
      ],
    ]);
  });

  it('writes the kill shards after a plain trigger’s effects, and none without them', () => {
    const heal: TriggerSpec = { on: 'kill', do: [{ kind: 'heal', lifePct: 0.05 }] };
    const line = (trigger: TriggerSpec, locale: Locale): string =>
      linesOf(withEffects(fire, NOTABLE, { triggers: [trigger] }), NOTABLE, locale)[0] ?? '';
    expect(
      LOCALES.map((locale) => [line({ ...heal, killShards: 0.25 }, locale), line(heal, locale)]),
    ).toEqual([
      [
        'When enemies are killed: heal 5% of max life; the enemies it kills drop +25% shards',
        'When enemies are killed: heal 5% of max life',
      ],
      ['敵人死亡時：回復 5% 生命；它造成的擊殺碎片 +25%', '敵人死亡時：回復 5% 生命'],
    ]);
  });

  it('names the armour a coin ignores 堅甲, as the stat and the affix do', () => {
    const coin: TriggerSpec = {
      on: 'hit',
      do: [{ kind: 'coinHit', multiplier: 10, ignoreShield: true, ignoreArmour: true }],
    };
    const line = (locale: Locale): string =>
      linesOf(withEffects(fire, NOTABLE, { triggers: [coin] }), NOTABLE, locale)[0] ?? '';
    expect(line('en')).toMatch(/, ignoring shields, ignoring armour$/);
    expect(line('zh-TW')).toMatch(/，無視護盾，無視堅甲$/);
  });
});

describe('C5.9: droneSpeed and minionCount (lead rulings P6, P7)', () => {
  const lines = (mod: Modifier): string[] =>
    LOCALES.map((locale) => modifierLine(mod, lookups[locale]));

  it('writes 無人機速度 as a percentage in both locales', () => {
    expect(LOCALES.map((locale) => MESSAGES[locale]['stat.droneSpeed'])).toEqual([
      'Drone speed',
      '無人機速度',
    ]);
    expect(lines(inc('droneSpeed', 0.25))).toEqual([
      '25% increased Drone speed',
      '無人機速度提高 25%',
    ]);
    expect(lines(more('droneSpeed', 0.5))).toEqual(['50% more Drone speed', '無人機速度總增 50%']);
  });

  it("writes :572's line, center damage per temporary summon on the field, in both locales", () => {
    const perMinion = inc('damage', 0.04, {
      scope: 'center',
      scaling: { per: 'minionCount', cap: 0.2 },
    });
    expect(lines(perMinion)).toEqual([
      '4% increased Damage (center only, per temporary summon on the field, at most 20%)',
      '傷害提高 4%（限中心，場上每個臨時召喚物，最多 20%）',
    ]);
    expect(lines(flat('critChance', 0.01, { scaling: { per: 'minionCount', every: 3 } }))).toEqual([
      '+1% Crit chance (per 3 temporary summons on the field)',
      '暴擊率 +1%（場上每 3 個臨時召喚物）',
    ]);
    expect(lines(more('damage', 0.1, { scaling: { per: 'minionCount', curve: 'log10' } }))).toEqual(
      [
        '10% more Damage (rising with the temporary summons on the field at a slowing rate (log₁₀))',
        '傷害總增 10%（隨場上的臨時召喚物數成長，越來越慢（log₁₀））',
      ],
    );
  });
});

describe('E4: summonDuration (lead ruling R5)', () => {
  it('writes 召喚物存在時間 as a percentage in both locales', () => {
    const lines = (mod: Modifier): string[] =>
      LOCALES.map((locale) => modifierLine(mod, lookups[locale]));
    expect(LOCALES.map((locale) => MESSAGES[locale]['stat.summonDuration'])).toEqual([
      'Summon duration',
      '召喚物存在時間',
    ]);
    expect(lines(inc('summonDuration', 0.5))).toEqual([
      '50% increased Summon duration',
      '召喚物存在時間提高 50%',
    ]);
    expect(lines(more('summonDuration', 0.2))).toEqual([
      '20% more Summon duration',
      '召喚物存在時間總增 20%',
    ]);
  });
});

describe('E1: areaSize, bombRadius and 巨大化 (docs/v3 C4 design D29)', () => {
  it('writes 範圍 and 爆炸半徑 as percentages in both locales', () => {
    const lines = (mod: Modifier): string[] =>
      LOCALES.map((locale) => modifierLine(mod, lookups[locale]));
    expect(lines(flat('areaSize', 0.2))).toEqual(['+20% Area size', '範圍 +20%']);
    expect(lines(inc('areaSize', 0.15))).toEqual(['15% increased Area size', '範圍提高 15%']);
    expect(lines(flat('bombRadius', 0.25))).toEqual(['+25% Explosion radius', '爆炸半徑 +25%']);
    expect(lines(inc('bombRadius', 0.1))).toEqual([
      '10% increased Explosion radius',
      '爆炸半徑提高 10%',
    ]);
    expect(lines(more('areaSize', 0.5))).toEqual(['50% more Area size', '範圍總增 50%']);
  });

  it("writes 巨大化's rule line from gd:268 in both locales, its sizeMult as ×2, V17's number", () => {
    const line = (sizeMult: number, locale: Locale): string =>
      linesOf(
        withEffects(fire, NOTABLE, { rules: [{ id: 'gigantism', sizeMult }] }),
        NOTABLE,
        locale,
      )[0] ?? '';
    expect(LOCALES.map((locale) => line(2, locale))).toEqual([
      'Area, explosion, projectile and drone size ×2; projectile, ice cone, chain jump and drone counts halved, rounded down, at least 1',
      '範圍、爆炸、投射物、無人機的大小 ×2；數量類（投射物、冰錐、連鎖跳數、無人機）減半，一律無條件捨去，最少 1',
    ]);
    expect(line(3, 'en')).toMatch(/ size ×3; /);
    expect(line(2.5, 'zh-TW')).toMatch(/的大小 ×2\.5；/);
    // V17's numbers (quotedNumbers): a 巨大化 node's hand description must quote its ×sizeMult,
    // the one number the generated line quotes too.
    for (const sizeMult of [2, 3, 2.5]) {
      expect(quotedNumbers({ id: 'gigantism', sizeMult })).toEqual([[`×${sizeMult}`]]);
      for (const locale of LOCALES) {
        expect(mentions(line(sizeMult, locale), `×${sizeMult}`)).toBe(true);
      }
    }
    // Every other rule keeps the fallback until its node's hand description names it.
    const glass = withEffects(fire, NOTABLE, { rules: [{ id: 'glassCannon', damageMore: 1 }] });
    expect(linesOf(glass, NOTABLE, 'en')).toEqual(['Special rule (glassCannon)']);
  });
});

describe('E3: spreadRadius and the spread mark', () => {
  it('writes 擴散距離 as a percentage in both locales', () => {
    const lines = (mod: Modifier): string[] =>
      LOCALES.map((locale) => modifierLine(mod, lookups[locale]));
    expect(lines(flat('spreadRadius', 0.2))).toEqual(['+20% Spread distance', '擴散距離 +20%']);
    expect(lines(inc('spreadRadius', 0.25))).toEqual([
      '25% increased Spread distance',
      '擴散距離提高 25%',
    ]);
    expect(lines(more('spreadRadius', 0.5))).toEqual([
      '50% more Spread distance',
      '擴散距離總增 50%',
    ]);
    expect(MESSAGES.en['stat.spreadRadius']).toBe('Spread distance');
    expect(MESSAGES['zh-TW']['stat.spreadRadius']).toBe('擴散距離');
  });

  it('gives the mark no text of its own: a marked radius or range reads as written, as the unmarked one does', () => {
    // 火星's form (gd:376) and a marked selector; their node's description says the spread.
    const spark: TriggerSpec = {
      on: 'diedWithAilment',
      when: [{ victimHas: 'burn' }],
      do: [
        {
          kind: 'applyAilment',
          ailment: 'burn',
          radius: 90,
          maxTargets: 2,
          order: 'nearest',
          spread: true,
        },
      ],
    };
    const picked: TriggerSpec = {
      on: 'kill',
      target: { pick: 'farthest', range: 120, spread: true },
      do: [{ kind: 'applyAilment', ailment: 'shock' }],
    };
    const unmarkedSpark: TriggerSpec = {
      ...spark,
      do: [{ kind: 'applyAilment', ailment: 'burn', radius: 90, maxTargets: 2, order: 'nearest' }],
    };
    const unmarkedPick: TriggerSpec = { ...picked, target: { pick: 'farthest', range: 120 } };
    const line = (trigger: TriggerSpec, locale: Locale): readonly string[] =>
      linesOf(withEffects(fire, NOTABLE, { triggers: [trigger] }), NOTABLE, locale);
    for (const [marked, unmarked, written] of [
      [spark, unmarkedSpark, '90'],
      [picked, unmarkedPick, '120'],
    ] as const) {
      for (const locale of LOCALES) {
        const lines = line(marked, locale);
        expect(lines, locale).toEqual(line(unmarked, locale));
        expect(
          lines.some((text) => mentions(text, written)),
          `${locale} ${written}`,
        ).toBe(true);
        expect(lines.some(isFaulty), locale).toBe(false);
      }
      // V17's numbers: the mark adds none, and a radius is never one (arena units are words).
      expect(triggerNumbers(marked)).toEqual(triggerNumbers(unmarked));
    }
    expect(LOCALES.map((locale) => line(spark, locale)[0])).toEqual([
      'When burning enemies are killed: 1 burn stack, on the enemies within 90, at most 2 enemies, nearest first',
      '燃燒中的敵人死亡時：燃燒 1 層，對半徑 90 內的敵人，最多 2 隻，由近到遠',
    ]);
  });
});

describe('E7: chainBolt from the nearest other enemy, several bolts and an arc (lead ruling B4)', () => {
  const lines = (trigger: TriggerSpec, locale: Locale): readonly string[] =>
    linesOf(withEffects(fire, NOTABLE, { triggers: [trigger] }), NOTABLE, locale);
  const bolt = { kind: 'chainBolt', jumps: 0, damagePct: 0.4 } as const;
  const onFreeze = (more: Partial<ChainBoltSpec>): TriggerSpec => ({
    on: 'freeze',
    do: [{ ...bolt, ...more }],
  });

  it('writes the nearest other enemy and the count of bolts in both locales, and nothing for arc', () => {
    // Planted bugs: the count dropped, or the other enemy written as any enemy, in either locale.
    const cases: [Partial<ChainBoltSpec>, string, string][] = [
      [
        { from: 'nearestOther' },
        'On each freeze, at the target: a 0-jump bolt for 40% damage, starting at the nearest other enemy',
        '凍結時，在目標：放一道 0 跳的電弧，40% 傷害，從最近的另一隻敵人開始',
      ],
      [
        { from: 'nearestOther', bolts: 3 },
        'On each freeze, at the target: a 0-jump bolt for 40% damage, one each to the 3 nearest other enemies',
        '凍結時，在目標：放一道 0 跳的電弧，40% 傷害，朝最近的 3 隻其他敵人各一道',
      ],
      [
        { from: 'nearestToPoint', bolts: 2, shockStacks: 1 },
        'On each freeze, at the target: a 0-jump bolt for 40% damage, 1 shock stack on each hit, one each to the 2 nearest enemies',
        '凍結時，在目標：放一道 0 跳的電弧，40% 傷害，帶 1 層感電，朝最近的 2 隻敵人各一道',
      ],
    ];
    for (const [more, en, zh] of cases) {
      expect(lines(onFreeze(more), 'en'), en).toEqual([en]);
      expect(lines(onFreeze(more), 'zh-TW'), zh).toEqual([zh]);
      // arc adds no text, and bolts 1 none either.
      for (const locale of LOCALES) {
        expect(lines(onFreeze({ ...more, arc: true }), locale)).toEqual(
          lines(onFreeze(more), locale),
        );
      }
    }
    for (const locale of LOCALES) {
      expect(lines(onFreeze({ from: 'nearestOther', bolts: 1, arc: false }), locale)).toEqual(
        lines(onFreeze({ from: 'nearestOther' }), locale),
      );
    }
  });

  it('keeps every existing chainBolt text as it was', () => {
    const existing: [Partial<ChainBoltSpec>, string, string][] = [
      [
        {},
        'On each freeze, at the target: a 0-jump bolt for 40% damage',
        '凍結時，在目標：放一道 0 跳的電弧，40% 傷害',
      ],
      [
        { from: 'eventTarget', jumps: 2, shockStacks: 2 },
        'On each freeze, at the target: a 2-jump bolt for 40% damage, 2 shock stacks on each hit',
        '凍結時，在目標：放一道 2 跳的電弧，40% 傷害，帶 2 層感電',
      ],
      [
        { from: 'nearestToPoint', jumps: 3 },
        'On each freeze, at the target: a 3-jump bolt for 40% damage, starting at the nearest enemy',
        '凍結時，在目標：放一道 3 跳的電弧，40% 傷害，從最近的敵人開始',
      ],
      [
        { from: 'nearestToPoint', bolts: 1 },
        'On each freeze, at the target: a 0-jump bolt for 40% damage, starting at the nearest enemy',
        '凍結時，在目標：放一道 0 跳的電弧，40% 傷害，從最近的敵人開始',
      ],
    ];
    for (const [more, en, zh] of existing) {
      expect(lines(onFreeze(more), 'en')).toEqual([en]);
      expect(lines(onFreeze(more), 'zh-TW')).toEqual([zh]);
    }
  });

  it('quotes the count of bolts above 1 among its numbers, V17’s check, and only then', () => {
    const numbers = (more: Partial<ChainBoltSpec>): string[][] => triggerNumbers(onFreeze(more));
    expect(numbers({ from: 'nearestOther', bolts: 3 })).toEqual([['3'], ['40%']]);
    expect(numbers({ from: 'nearestToPoint', bolts: 2, jumps: 4, shockStacks: 1 })).toEqual([
      ['2'],
      ['4'],
      ['40%'],
      ['1'],
    ]);
    expect(numbers({ from: 'nearestOther', bolts: 1, arc: true })).toEqual([['40%']]);
    expect(numbers({})).toEqual([['40%']]);
  });
});

describe('E6: thaw', () => {
  it("writes 熱震's thaw in both locales, and a freeze's thaw on its list as an addFrost's", () => {
    // Plants a locale without the thaw, or a thaw whose fan-out the line leaves out.
    const heatShock: TriggerSpec = {
      on: 'ailmentApplied',
      when: [{ ailment: 'burn' }, { targetHas: 'frozen' }],
      do: [{ kind: 'thaw' }],
    };
    const onFreeze: TriggerSpec = { on: 'freeze', do: [{ kind: 'thaw' }] };
    const chill: TriggerSpec = { on: 'freeze', do: [{ kind: 'addFrost', amount: 0.2 }] };
    const web = withEffects(fire, NOTABLE, { triggers: [heatShock, onFreeze, chill] });
    expect(LOCALES.map((locale) => linesOf(web, NOTABLE, locale))).toEqual([
      [
        'When frozen enemies are ignited: thaw at once',
        'On each freeze: thaw at once on the target and the enemies within 90, at most 5',
        'On each freeze: +20% chill on the target and the enemies within 90, at most 5',
      ],
      [
        '凍結中的敵人被點燃時：立刻解凍',
        '凍結時，對目標與半徑 90 內最多 5 隻敵人：立刻解凍',
        '凍結時，對目標與半徑 90 內最多 5 隻敵人：冰冷 +20%',
      ],
    ]);
    expect(MESSAGES.en['web.effect.thaw']).toBe('thaw at once{extra}');
    expect(MESSAGES['zh-TW']['web.effect.thaw']).toBe('立刻解凍{extra}');
  });
});

describe('E15: pull on a center event', () => {
  it("writes a freeze's pull on its list as a thaw's, in both locales", () => {
    // Plants text.ts's fansOut without pull, while compileEffect fans it out.
    const onFreeze: TriggerSpec = { on: 'freeze', do: [{ kind: 'pull', to: 'auraEdge' }] };
    const web = withEffects(fire, NOTABLE, { triggers: [onFreeze] });
    expect(LOCALES.map((locale) => linesOf(web, NOTABLE, locale))).toEqual([
      [
        "On each freeze: pull it to the aura's edge on the target and the enemies within 90, at most 5",
      ],
      ['凍結時，對目標與半徑 90 內最多 5 隻敵人：拉到光環邊緣'],
    ]);
  });
});

describe('E9: 血河’s bleed spread (lead ruling S7)', () => {
  const lines = (trigger: TriggerSpec, locale: Locale): readonly string[] =>
    linesOf(withEffects(fire, NOTABLE, { triggers: [trigger] }), NOTABLE, locale);
  /** B3's data. */
  const bloodRiver: TriggerSpec = {
    on: 'ailmentTick',
    when: [{ ailment: 'bleed' }],
    every: 0.5,
    do: [{ kind: 'spreadAilment', ailment: 'bleed', radius: 60, behind: true }],
  };
  const withSpread = (more: object): TriggerSpec => ({
    ...bloodRiver,
    do: [{ kind: 'spreadAilment', ailment: 'bleed', radius: 60, behind: true, ...more }],
  });
  const EVERY_EN = 'Every 0.5 s while enemies take bleed damage: ';
  const EVERY_ZH = '敵人受到流血傷害時，每 0.5 秒：';

  it('writes a bleed spread as a poison one, with its cap and order, in both locales', () => {
    // Planted bugs: a locale without the line, or the cap or the order left out of it.
    const cases: [TriggerSpec, string, string][] = [
      [
        bloodRiver,
        'spread the bleed stacks at 100% strength to the enemies within 60',
        '把流血層以 100% 的效果傳給半徑 60 內的敵人',
      ],
      [
        withSpread({ effect: 0.5, maxTargets: 2, order: 'nearest' }),
        'spread the bleed stacks at 50% strength to the enemies within 60, at most 2 enemies, ' +
          'nearest first',
        '把流血層以 50% 的效果傳給半徑 60 內的敵人，最多 2 隻，由近到遠',
      ],
      [
        withSpread({ maxTargets: 3 }),
        'spread the bleed stacks at 100% strength to the enemies within 60, at most 3 enemies',
        '把流血層以 100% 的效果傳給半徑 60 內的敵人，最多 3 隻',
      ],
    ];
    for (const [trigger, en, zh] of cases) {
      expect(lines(trigger, 'en'), en).toEqual([EVERY_EN + en]);
      expect(lines(trigger, 'zh-TW'), zh).toEqual([EVERY_ZH + zh]);
    }
  });

  it('gives behind no text of its own, so 血河 needs its hand description', () => {
    for (const locale of LOCALES) {
      expect(lines(bloodRiver, locale)).toEqual(lines(withSpread({ behind: false }), locale));
      expect(lines(bloodRiver, locale).some(isFaulty), locale).toBe(false);
    }
  });

  it('quotes the trigger’s 0.5 s and a set effect among its numbers, V17’s check, and no more', () => {
    // The radius, behind and the cap are not numbers V17 asks for, as a poison spread's are not.
    expect(triggerNumbers(bloodRiver)).toEqual([['0.5']]);
    expect(triggerNumbers(withSpread({ effect: 0.5, maxTargets: 2, order: 'nearest' }))).toEqual([
      ['0.5'],
      ['50%'],
    ]);
    expect(triggerNumbers(withSpread({ behind: false, maxTargets: 3 }))).toEqual([['0.5']]);
  });
});

describe('a ranked node’s waveCleared trigger that is not interest alone', () => {
  it.each([
    [
      'en',
      [
        '+0.5% Interest rate per rank (3/4: +1.5%)',
        "At the end of each wave: earn interest on this run's shards, the rate rising 0.5 percentage points each time, at most 10%",
        'At the end of each wave: heal 1% of max life (once per rank)',
      ],
    ],
    [
      'zh-TW',
      [
        '每級利率 +0.5%（3/4：+1.5%）',
        '每波結束時：拿本局碎片的一部分當利息，每次利率提高 0.5 個百分點，最多 10%',
        '每波結束時：回復 1% 生命（每級各一次）',
      ],
    ],
  ] as const)(
    'keeps “once per rank” on it, as webBuild repeats it, in %s (lead ruling 23a is runsAtClear)',
    (locale, expected) => {
      // Planted bug: the per-rank suffix dropped for every waveCleared trigger.
      const id = 'outer.greed.alpha.r1';
      const nodes = fire.nodes.map((node): WebNode =>
        node.id === id
          ? {
              ...node,
              ranks: 4,
              effects: effects({
                modifiers: [flat('interestRate', 0.005)],
                triggers: [
                  { on: 'waveCleared', do: [{ kind: 'interest' }] },
                  { on: 'waveCleared', do: [{ kind: 'heal', lifePct: 0.01 }] },
                ],
              }),
            }
          : node,
      );
      const web = { ...fire, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
      expect(linesOf(web, id, locale, 3)).toEqual(expected);
    },
  );
});
