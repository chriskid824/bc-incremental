import { describe, expect, it } from 'vitest';
import { digest } from '../../core/digest';
import { CHAIN_JUMP_CHANCE, compileEffect, compileTrigger, EVENT } from '../../sim/effects/types';
import { CHARACTER_IDS, OUTER_IDS, sourceOfNode } from '../sources';
import type { CharacterId, OuterId } from '../sources';
import type { Modifier } from '../stats';
import { flat, fusionRank, inc } from '../templates';
import { CENTER_EVENTS } from '../triggers';
import type { CenterEvent, EffectSpec, TriggerSpec } from '../triggers';
import { parseNodeId } from '../web/ids';
import { fixtureContent } from '../web/testing';
import type {
  BonusSpec,
  FusionDef,
  FusionKey,
  FusionOverride,
  FusionRanks,
  OuterDef,
  OuterPayload,
  PayloadEffect,
  WebNode,
} from '../web/types';
import { CALIBRATED } from './calibrated';
import {
  bonusModifiers,
  EMPTY_RANKS,
  fusionDigest,
  generate,
  HAND_PAIRS,
  HAND_RANKS,
  place,
  templateOf,
} from './generate';
import { ACCEPTED_FAILS, OVERRIDES, TEMPLATE_RULE_OVERRIDES } from './overrides';

const content = fixtureContent();

/** Every pair c.o of a character with an outer but its own: 4 × 11. */
const PAIRS: readonly FusionKey[] = CHARACTER_IDS.flatMap((c) =>
  OUTER_IDS.filter((o) => o !== c).map((o): FusionKey => `${c}.${o}`),
);

/** gd's center events (SIGNATURE_EVENT of each character's signature). */
const EVENT_OF: Readonly<Record<CharacterId, CenterEvent>> = {
  fire: 'explode',
  ice: 'freeze',
  lightning: 'chainJump',
  summon: 'droneImpact',
};

const partsOf = (key: FusionKey): [CharacterId, OuterId] =>
  key.split('.') as [CharacterId, OuterId];
const outerOf = (o: OuterId): OuterDef => content.outers[o] as OuterDef;

/** The fixture's fusion `key` at `coef`, with its override. */
function fusion(key: FusionKey, coef = 1): FusionDef {
  const [c, o] = partsOf(key);
  return generate(content.characters[c], outerOf(o), content.overrides[key], coef);
}

/** The fixture's outer `o` with `payload` in place of its own. */
const outerWith = (payload: OuterPayload | null, o: OuterId = 'bleed'): OuterDef => ({
  ...outerOf(o),
  payload,
});

/** A node of `def` by its slot name. */
const nodeOf = (def: FusionDef, slot: string): WebNode =>
  def.board.nodes.find((node) => node.id === `fusion.${def.key}.${slot}`) as WebNode;
const coreOf = (def: FusionDef): WebNode => nodeOf(def, 'core');
const rankValues = (def: FusionDef): number[][] =>
  ['r1', 'r2', 'r3', 'mastery'].map((slot) =>
    nodeOf(def, slot).effects.modifiers.map((mod) => mod.value),
  );

/** D13a's rank, the fixture's ranks on every payload but poison's. */
const RANK: Modifier = { stat: 'damage', kind: 'increased', value: 0.1, scope: 'fusion' };
const FIXTURE_RANKS: FusionRanks = [
  { modifiers: [RANK], ranks: 3 },
  { modifiers: [RANK], ranks: 3 },
  { modifiers: [RANK], ranks: 3 },
];

/** A payload of `effects` with no bonus and D13a's ranks. */
const payloadOf = (...effects: PayloadEffect[]): OuterPayload => ({
  type: 'placement',
  effects,
  bonus: null,
  ranks: FIXTURE_RANKS,
});

describe('registries', () => {
  it('HAND_PAIRS holds the 12 pairs of a character with another archetype, none its own', () => {
    expect([...HAND_PAIRS].sort()).toEqual(
      [
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
      ].sort(),
    );
    for (const c of CHARACTER_IDS) expect(HAND_PAIRS.has(`${c}.${c}`)).toBe(false);
  });

  it("HAND_RANKS is D13a's default: 3 ranks of +10 % damage increased, scoped to the fusion", () => {
    expect(HAND_RANKS).toEqual(FIXTURE_RANKS);
  });

  it('EMPTY_RANKS is three rank-3 nodes with no modifiers', () => {
    expect(EMPTY_RANKS).toEqual([
      { modifiers: [], ranks: 3 },
      { modifiers: [], ranks: 3 },
      { modifiers: [], ranks: 3 },
    ]);
  });

  it('OVERRIDES, ACCEPTED_FAILS and CALIBRATED start empty; 冰光 and 雷光 may add rules', () => {
    expect(OVERRIDES).toEqual({});
    expect(ACCEPTED_FAILS).toEqual({});
    expect(CALIBRATED).toEqual({});
    expect(TEMPLATE_RULE_OVERRIDES).toEqual(['ice.aura', 'lightning.aura']);
    for (const key of TEMPLATE_RULE_OVERRIDES) expect(HAND_PAIRS.has(key)).toBe(false);
  });
});

describe('generate on the fixture', () => {
  it('makes the 44 pairs: 12 hand, 29 template and 3 template with an override', () => {
    expect(PAIRS).toHaveLength(44);
    const byKind = (kind: FusionDef['kind']): FusionKey[] =>
      PAIRS.filter((key) => fusion(key).kind === kind).sort();
    expect(byKind('hand')).toEqual([...HAND_PAIRS].sort());
    expect(byKind('templateOverride')).toEqual(['fire.poison', 'ice.aura', 'lightning.aura']);
    expect(byKind('template')).toHaveLength(29);
    for (const key of PAIRS) expect(fusion(key).key).toBe(key);
  });

  it('builds each board as core–r1–r2–r3–mastery under fusion.<c>.<o>', () => {
    for (const key of PAIRS) {
      const def = fusion(key);
      const source = `fusion.${key}`;
      const id = (slot: string): string => `${source}.${slot}`;
      expect(def.board.id).toBe(source);
      expect(
        def.board.nodes.map((node) => [node.id, node.kind, node.board, node.slot, node.ranks]),
      ).toEqual([
        [id('core'), 'core', source, { at: 'fusion', step: 0 }, 1],
        [id('r1'), 'ranked', source, { at: 'fusion', step: 1 }, 3],
        [id('r2'), 'ranked', source, { at: 'fusion', step: 2 }, 3],
        [id('r3'), 'ranked', source, { at: 'fusion', step: 3 }, 3],
        [id('mastery'), 'mastery', source, { at: 'fusion', step: 4 }, 'unlimited'],
      ]);
      expect(def.board.edges).toEqual([
        [id('core'), id('r1')],
        [id('r1'), id('r2')],
        [id('r2'), id('r3')],
        [id('r3'), id('mastery')],
      ]);
      expect(def.board.branches).toEqual([]);
      for (const node of def.board.nodes) {
        expect(parseNodeId(node.id)?.board).toBe(source);
        expect(sourceOfNode(node.id)).toBe(source);
        expect(node.answers).toEqual([]);
      }
    }
  });

  it('gives every mastery more 0.04 damage a rank on its own fusion, and nothing else', () => {
    for (const key of PAIRS) {
      expect(nodeOf(fusion(key), 'mastery').effects).toEqual({
        modifiers: [{ stat: 'damage', kind: 'more', value: 0.04, scope: `fusion.${key}` }],
        triggers: [],
        conversions: [],
        emitters: [],
        rules: [],
      });
    }
  });

  it("gives each hand pair its override's rule, no trigger or bonus, and HAND_RANKS", () => {
    for (const key of HAND_PAIRS) {
      const def = fusion(key);
      expect(def.kind).toBe('hand');
      expect(def.template).toBeNull();
      expect(def.coefScalesBonus).toBe(false);
      expect(coreOf(def).effects).toEqual({
        modifiers: [],
        triggers: [],
        conversions: [],
        emitters: [],
        rules: [content.overrides[key]?.rule],
      });
      for (const slot of ['r1', 'r2', 'r3']) {
        expect(nodeOf(def, slot).effects.modifiers).toEqual([{ ...RANK, scope: `fusion.${key}` }]);
      }
    }
  });

  it('gives each template pair its payload placed on the center event, then its bonus', () => {
    for (const key of PAIRS.filter((pair) => !HAND_PAIRS.has(pair))) {
      const [c, o] = partsOf(key);
      const payload = outerOf(o).payload as OuterPayload;
      const event = EVENT_OF[c];
      const placed = payload.effects.map((effect) => place(effect, event));
      const def = fusion(key);
      expect(content.characters[c].centerEvent).toBe(event);
      expect(def.template).toEqual({ on: event, do: placed, bonus: payload.bonus });
      expect(coreOf(def).effects.triggers[0]).toEqual({ on: event, do: placed });
      expect(coreOf(def).effects.modifiers).toEqual(
        bonusModifiers(payload.bonus, `fusion.${key}`, 1),
      );
      expect(def.skin).toEqual(outerOf(o).skin);
      expect(def.coef).toBe(1);
    }
  });

  it("writes each bonus form's modifier: status, inZone, and none for inPayload and null", () => {
    const at = (key: FusionKey): readonly Modifier[] => coreOf(fusion(key)).effects.modifiers;
    const bonus = (when: NonNullable<Modifier['when']>): Modifier[] => [
      { stat: 'damage', kind: 'increased', value: 0.2, scope: 'center', when },
    ];
    expect(at('ice.poison')).toEqual(bonus([{ targetHas: 'poison' }]));
    expect(at('summon.bleed')).toEqual(bonus([{ targetHas: 'bleed' }]));
    expect(at('fire.aura')).toEqual(bonus([{ inZone: 'fusion.fire.aura' }]));
    expect(at('summon.aura')).toEqual(bonus([{ inZone: 'fusion.summon.aura' }]));
    for (const o of ['crit', 'thorns', 'barrage', 'combo', 'greed'] as const) {
      expect(at(`lightning.${o}`)).toEqual([]);
    }
  });

  it("narrows each rank's scope 'fusion' to the fusion and keeps every other modifier", () => {
    const poison = fusion('summon.poison');
    expect(nodeOf(poison, 'r1').effects.modifiers).toEqual([
      { ...RANK, scope: 'fusion.summon.poison' },
    ]);
    expect(nodeOf(poison, 'r2').effects.modifiers).toEqual([flat('poisonDuration', 0.5)]);
    expect(nodeOf(poison, 'r3').effects.modifiers).toEqual([
      inc('damage', 0.04, { scope: 'center', when: [{ targetHas: 'poison' }] }),
    ]);
    for (const key of PAIRS.filter((pair) => !pair.endsWith('.poison'))) {
      for (const slot of ['r1', 'r2', 'r3']) {
        expect(nodeOf(fusion(key), slot).effects.modifiers).toEqual([
          { ...RANK, scope: `fusion.${key}` },
        ]);
      }
    }
    // The outer's own ranks are left as written, for its other fusions.
    expect((outerOf('poison').payload as OuterPayload).ranks[0].modifiers).toEqual([RANK]);
  });

  it("applies fire.poison's 瘟疫爆彈 after the template trigger", () => {
    const def = fusion('fire.poison');
    const plague = content.overrides['fire.poison']?.addTriggers?.[0] as TriggerSpec;
    expect(coreOf(def).effects.triggers).toEqual([
      { on: 'explode', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }] },
      plague,
    ]);
    expect(plague.do).toEqual([
      { kind: 'spreadAilment', ailment: 'poison', radius: 90, effect: 0.5 },
    ]);
    // A transfer-only kill trigger runs at the kill.
    expect(compileTrigger(1, plague, 0, def.coef, 0).inline).toBe(true);
  });

  it("adds 冰光's and 雷光's rules to their template cores", () => {
    for (const key of ['ice.aura', 'lightning.aura'] as const) {
      const def = fusion(key);
      expect(coreOf(def).effects.rules).toEqual(content.overrides[key]?.addRules);
      expect(coreOf(def).effects.triggers).toHaveLength(1);
      expect(coreOf(def).effects.modifiers).toEqual(
        bonusModifiers({ form: 'inZone', value: 0.2 }, `fusion.${key}`, 1),
      );
    }
  });

  it('gives every fusion its own digest', () => {
    expect(new Set(PAIRS.map((key) => fusion(key).digest)).size).toBe(44);
    for (const key of PAIRS) expect(fusion(key).digest).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('place', () => {
  const SLASH: PayloadEffect = {
    kind: 'slashLine',
    length: 300,
    width: 24,
    damagePct: 1,
    alwaysCrit: true,
    critScale: 1,
  };
  /** §4.1's slash column, as F11 gives it. */
  const SLASH_AT: Readonly<Record<CenterEvent, Partial<EffectSpec>>> = {
    explode: { from: 'event', toward: 'nearest' },
    freeze: { from: 'target', toward: 'outward' },
    chainJump: { from: 'target', toward: 'along' },
    droneImpact: { from: 'target', toward: 'outward' },
  };
  interface Cell {
    readonly effect: PayloadEffect;
    /** The fields place() fills on every event, or by event for the slash. */
    readonly placed: (event: CenterEvent) => Partial<EffectSpec>;
    /** The COEF fields at coef 2, as the compile scales them (D10). */
    readonly atCoef2: Readonly<Record<string, number>>;
    /** A single-target status effect the engine fans out over an event's list. */
    readonly fanout: boolean;
  }
  const none = (): Partial<EffectSpec> => ({});
  const CELLS: readonly Cell[] = [
    {
      effect: { kind: 'applyAilment', ailment: 'poison', stacks: 2 },
      placed: none,
      atCoef2: { damagePct: 2 },
      fanout: true,
    },
    { effect: { kind: 'addFrost', amount: 0.25 }, placed: none, atCoef2: {}, fanout: true },
    { effect: SLASH, placed: (event) => SLASH_AT[event], atCoef2: { damagePct: 2 }, fanout: false },
    {
      effect: { kind: 'projectiles', count: 4, damagePct: 0.25, aim: 'radial' },
      placed: () => ({ from: 'event' }),
      atCoef2: { damagePct: 0.5 },
      fanout: false,
    },
    {
      effect: { kind: 'nova', radius: 90, damagePct: 3, tags: ['thorns'] },
      placed: () => ({ at: 'event' }),
      atCoef2: { damagePct: 6 },
      fanout: false,
    },
    {
      effect: {
        kind: 'groundZone',
        radius: 80,
        durationSec: 2,
        damagePctPerSec: 0.5,
        ailment: 'burn',
        ailmentDamagePct: 0.5,
      },
      placed: none,
      atCoef2: { damagePctPerSec: 1, ailmentDamagePct: 1 },
      fanout: false,
    },
    {
      effect: { kind: 'coinHit', multiplier: 10, ignoreShield: true },
      placed: none,
      atCoef2: { multiplier: 20 },
      fanout: false,
    },
    {
      effect: { kind: 'chainBolt', jumps: 2, damagePct: 0.5 },
      placed: none,
      atCoef2: { damagePct: 1 },
      fanout: false,
    },
    {
      effect: { kind: 'explode', radius: 60, damagePct: 1 },
      placed: none,
      atCoef2: { damagePct: 2 },
      fanout: false,
    },
    {
      effect: { kind: 'push', distance: 40, radius: 60 },
      placed: none,
      atCoef2: {},
      fanout: false,
    },
  ];

  it('fills only the fields the center event decides', () => {
    for (const event of CENTER_EVENTS) {
      for (const cell of CELLS) {
        expect(place(cell.effect, event)).toEqual({ ...cell.effect, ...cell.placed(event) });
      }
    }
  });

  for (const c of CHARACTER_IDS) {
    const event = EVENT_OF[c];
    it(`compiles each cell's trigger on ${event} (${c}) at the fusion's coef`, () => {
      for (const cell of CELLS) {
        const def = generate(
          content.characters[c],
          outerWith(payloadOf(cell.effect)),
          undefined,
          2,
        );
        const trigger = coreOf(def).effects.triggers[0] as TriggerSpec;
        expect(trigger).toEqual({ on: event, do: [{ ...cell.effect, ...cell.placed(event) }] });
        const compiled = compileTrigger(0, trigger, 0, def.coef, 0);
        expect(compiled.on).toBe(EVENT[event]);
        // chance min(1, chance × coef): chainJump's fixed 0.3, the others' 1 clamped.
        expect(compiled.chance).toBe(event === 'chainJump' ? CHAIN_JUMP_CHANCE * 2 : 1);
        const [effect] = trigger.do.map((spec) => compileEffect(spec, 0, def.coef, 100));
        expect(effect?.spec).toEqual({ ...cell.effect, ...cell.placed(event), ...cell.atCoef2 });
        expect(effect?.fanout).toBe(cell.fanout);
        if (cell.fanout) {
          expect('radius' in (trigger.do[0] as EffectSpec)).toBe(false);
          expect(effect?.radiusSq).toBe(0);
        }
      }
    });
  }

  it("clamps a chainJump trigger's chance at 1", () => {
    const def = generate(content.characters.lightning, outerWith(payloadOf(SLASH)), undefined, 4);
    const trigger = coreOf(def).effects.triggers[0] as TriggerSpec;
    expect(compileTrigger(0, trigger, 0, def.coef, 0).chance).toBe(1);
  });

  it("takes a payload's perEvent list for its event, as written", () => {
    const perEvent = [{ kind: 'explode', radius: 40, damagePct: 0.5 }] as const;
    const payload: OuterPayload = { ...payloadOf(SLASH), perEvent: { freeze: perEvent } };
    expect(templateOf('freeze', payload).do).toEqual(perEvent);
    expect(templateOf('explode', payload).do).toEqual([place(SLASH, 'explode')]);
    const def = generate(content.characters.ice, outerWith(payload), undefined, 1);
    expect(coreOf(def).effects.triggers).toEqual([{ on: 'freeze', do: perEvent }]);
  });
});

describe('bonusModifiers', () => {
  const source = 'fusion.fire.greed';
  it('writes each form at value × k, scope center', () => {
    expect(bonusModifiers({ form: 'status', ailment: 'frost', value: 0.2 }, source, 2.5)).toEqual([
      {
        stat: 'damage',
        kind: 'increased',
        value: 0.5,
        scope: 'center',
        when: [{ targetHas: 'frost' }],
      },
    ]);
    expect(bonusModifiers({ form: 'inZone', value: 0.2 }, source, 1)).toEqual([
      {
        stat: 'damage',
        kind: 'increased',
        value: 0.2,
        scope: 'center',
        when: [{ inZone: source }],
      },
    ]);
    const scaling = { per: 'targetPoisonStacks', cap: 0.5 } as const;
    for (const kind of ['increased', 'more'] as const) {
      expect(bonusModifiers({ form: 'scaling', kind, value: 0.02, scaling }, source, 2)).toEqual([
        { stat: 'damage', kind, value: 0.04, scope: 'center', scaling },
      ]);
    }
    expect(bonusModifiers({ form: 'inPayload' }, source, 2)).toEqual([]);
    expect(bonusModifiers(null, source, 2)).toEqual([]);
  });
});

describe('overrides', () => {
  const TRIGGER: TriggerSpec = { on: 'explode', do: [{ kind: 'push', distance: 40, radius: 60 }] };
  const ADDED: TriggerSpec = { on: 'kill', do: [{ kind: 'heal', lifePct: 0.01 }] };
  const MOD = inc('damage', 0.05, { scope: 'center' });
  const BONUS: BonusSpec = { form: 'status', ailment: 'burn', value: 0.3 };
  const RANKS: FusionRanks = [
    fusionRank([flat('damage', 1, { scope: 'fusion' })], 4),
    fusionRank([], 5),
    fusionRank([inc('damage', 0.2)], 3),
  ];
  const FULL: FusionOverride = {
    rule: { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2 },
    triggers: [TRIGGER],
    addTriggers: [ADDED],
    addRules: [{ id: 'glassCannon', damageMore: 1 }],
    modifiers: [MOD],
    bonus: BONUS,
    ranks: RANKS,
    skin: { accent: 0x123456 },
  };

  it("apply in §4.1's order on a template pair; a rule is a hand pair's only", () => {
    const def = generate(content.characters.fire, outerOf('bleed'), FULL, 1);
    const placed = [{ kind: 'applyAilment', ailment: 'bleed' }];
    expect(def.kind).toBe('templateOverride');
    expect(def.template).toEqual({ on: 'explode', do: placed, bonus: BONUS });
    expect(coreOf(def).effects).toEqual({
      modifiers: [...bonusModifiers(BONUS, 'fusion.fire.bleed', 1), MOD],
      triggers: [TRIGGER, ADDED],
      conversions: [],
      emitters: [],
      rules: FULL.addRules,
    });
    expect(['r1', 'r2', 'r3'].map((slot) => nodeOf(def, slot))).toMatchObject([
      { ranks: 4, effects: { modifiers: [flat('damage', 1, { scope: 'fusion.fire.bleed' })] } },
      { ranks: 5, effects: { modifiers: [] } },
      { ranks: 3, effects: { modifiers: [inc('damage', 0.2)] } },
    ]);
    expect(def.skin).toEqual({ accent: 0x123456, shape: 'trail' });
  });

  it('keep the template trigger first without `triggers`, and drop the bonus with null', () => {
    const def = generate(
      content.characters.fire,
      outerOf('poison'),
      { addTriggers: [ADDED], bonus: null, modifiers: [MOD] },
      1,
    );
    expect(coreOf(def).effects.triggers).toEqual([
      { on: 'explode', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }] },
      ADDED,
    ]);
    expect(def.template?.bonus).toBeNull();
    expect(coreOf(def).effects.modifiers).toEqual([MOD]);
  });

  it("give a hand pair its rule, its added triggers and modifiers; a template's parts don't apply", () => {
    const def = generate(content.characters.fire, outerOf('ice'), FULL, 1);
    expect(def.kind).toBe('hand');
    expect(def.template).toBeNull();
    expect(coreOf(def).effects).toEqual({
      modifiers: [MOD],
      triggers: [ADDED],
      conversions: [],
      emitters: [],
      rules: [FULL.rule],
    });
    expect(nodeOf(def, 'r1').effects.modifiers).toEqual([
      flat('damage', 1, { scope: 'fusion.fire.ice' }),
    ]);
    expect(def.skin).toEqual({ accent: 0x123456, shape: 'crystal' });
  });

  it('never throw: a hand pair without its override, a template pair without a payload', () => {
    const hand = generate(content.characters.ice, outerOf('fire'), undefined, 1);
    expect(hand.kind).toBe('hand');
    expect(coreOf(hand).effects).toEqual({
      modifiers: [],
      triggers: [],
      conversions: [],
      emitters: [],
      rules: [],
    });
    expect(nodeOf(hand, 'r2').effects.modifiers).toEqual([{ ...RANK, scope: 'fusion.ice.fire' }]);
    const empty = generate(content.characters.ice, outerWith(null), undefined, 1);
    expect(empty.kind).toBe('template');
    expect(empty.template).toBeNull();
    expect(coreOf(empty).effects.triggers).toEqual([]);
    expect(coreOf(empty).effects.modifiers).toEqual([]);
    for (const slot of ['r1', 'r2', 'r3']) {
      expect(nodeOf(empty, slot)).toMatchObject({ ranks: 3, effects: { modifiers: [] } });
    }
    const overridden = generate(content.characters.ice, outerWith(null), FULL, 1);
    expect(overridden.kind).toBe('templateOverride');
    expect(coreOf(overridden).effects.triggers).toEqual([ADDED]);
    expect(coreOf(overridden).effects.modifiers).toEqual([MOD]);
  });
});

describe('the coefficient', () => {
  it('scales the bonus and r3 under coefScalesBonus, never r1, r2 or the mastery', () => {
    const aura = fusion('fire.aura', 2);
    expect(aura.coef).toBe(2);
    expect(aura.coefScalesBonus).toBe(true);
    expect(coreOf(aura).effects.modifiers).toEqual(
      bonusModifiers({ form: 'inZone', value: 0.4 }, 'fusion.fire.aura', 1),
    );
    expect(rankValues(aura)).toEqual([[0.1], [0.1], [0.2], [0.04]]);
    // The template keeps the payload's bonus, the trigger its numbers: the compile scales those.
    expect(aura.template?.bonus).toEqual({ form: 'inZone', value: 0.2 });
    expect(coreOf(aura).effects.triggers).toEqual([
      {
        on: 'explode',
        do: [{ kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0 }],
      },
    ]);
    expect(rankValues(fusion('summon.combo', 0.5))).toEqual([[0.1], [0.1], [0.05], [0.04]]);
  });

  it("scales every r3 modifier's value under coefScalesBonus, each narrowed as written", () => {
    const fused = inc('damage', 0.1, { scope: 'fusion' });
    const poisoned = inc('damage', 0.05, { scope: 'center', when: [{ targetHas: 'poison' }] });
    const flagged: OuterPayload = {
      ...payloadOf({ kind: 'addFrost', amount: 0.25 }),
      ranks: [FIXTURE_RANKS[0], FIXTURE_RANKS[1], fusionRank([fused, poisoned], 3)],
      coefScalesBonus: true,
    };
    const def = generate(content.characters.fire, outerWith(flagged), undefined, 3);
    expect(nodeOf(def, 'r3').effects.modifiers).toEqual([
      { ...fused, scope: 'fusion.fire.bleed', value: 0.1 * 3 },
      { ...poisoned, value: 0.05 * 3 },
    ]);
  });

  it('scales nothing without the flag, nor on a hand pair', () => {
    const bleed = fusion('fire.bleed', 2);
    expect(bleed.coefScalesBonus).toBe(false);
    expect(coreOf(bleed).effects.modifiers.map((mod) => mod.value)).toEqual([0.2]);
    expect(rankValues(bleed)).toEqual([[0.1], [0.1], [0.1], [0.04]]);
    expect(coreOf(bleed).effects.triggers[0]?.do).toEqual([
      { kind: 'applyAilment', ailment: 'bleed' },
    ]);
    const flagged: OuterPayload = {
      ...payloadOf({ kind: 'addFrost', amount: 0.25 }),
      coefScalesBonus: true,
    };
    const hand = generate(
      content.characters.fire,
      outerWith(flagged, 'ice'),
      content.overrides['fire.ice'],
      2,
    );
    expect(hand.kind).toBe('hand');
    expect(hand.coefScalesBonus).toBe(false);
    expect(rankValues(hand)).toEqual([[0.1], [0.1], [0.1], [0.04]]);
  });
});

describe('fusionDigest', () => {
  it('is blind to the coef, the bonus and r3 it scales included', () => {
    for (const key of PAIRS) expect(fusion(key, 2.5).digest).toBe(fusion(key).digest);
  });

  it("is the digest of the event, the template, the override, the ranks as written and the payload's flag", () => {
    const poison = fusion('fire.poison');
    expect(poison.digest).toBe(
      digest({
        event: 'explode',
        template: poison.template,
        override: content.overrides['fire.poison'],
        ranks: (outerOf('poison').payload as OuterPayload).ranks,
        scalesBonus: false,
      }),
    );
    const aura = fusion('summon.aura', 3);
    expect(aura.digest).toBe(
      digest({
        event: 'droneImpact',
        template: aura.template,
        ranks: FIXTURE_RANKS,
        scalesBonus: true,
      }),
    );
    const hand = fusion('ice.summon');
    expect(hand.digest).toBe(
      fusionDigest({
        event: 'freeze',
        template: null,
        override: content.overrides['ice.summon'],
        ranks: HAND_RANKS,
        scalesBonus: false,
      }),
    );
  });

  it("reads the payload's flag on a hand pair too, which scales nothing there (§4.1)", () => {
    const flagged: OuterPayload = {
      ...payloadOf({ kind: 'addFrost', amount: 0.25 }),
      coefScalesBonus: true,
    };
    const override = content.overrides['fire.ice'];
    const hand = generate(content.characters.fire, outerWith(flagged, 'ice'), override, 2);
    expect(hand.coefScalesBonus).toBe(false);
    expect(hand.digest).toBe(
      fusionDigest({
        event: 'explode',
        template: null,
        override,
        ranks: HAND_RANKS,
        scalesBonus: true,
      }),
    );
    expect(hand.digest).not.toBe(fusion('fire.ice').digest);
  });

  it('is stable under key order', () => {
    const plague = content.overrides['fire.poison'] as FusionOverride;
    const reordered: FusionOverride = {
      addTriggers: [
        {
          do: [{ effect: 0.5, radius: 90, ailment: 'poison', kind: 'spreadAilment' }],
          when: [{ victimHas: 'poison' }, { killedBy: 'burn' }],
          on: 'kill',
        },
      ],
    };
    const fire = content.characters.fire;
    expect(generate(fire, outerOf('poison'), reordered, 1).digest).toBe(
      generate(fire, outerOf('poison'), plague, 1).digest,
    );
    const def = fusion('fire.crit');
    expect(
      fusionDigest({
        scalesBonus: false,
        ranks: FIXTURE_RANKS,
        override: undefined,
        template: def.template,
        event: 'explode',
      }),
    ).toBe(def.digest);
  });

  it('moves with the event, the payload, the override, the ranks and the flag', () => {
    const base = generate(content.characters.fire, outerOf('aura'), undefined, 1).digest;
    const payload = outerOf('aura').payload as OuterPayload;
    const zone = payload.effects[0] as PayloadEffect;
    const unflagged: OuterPayload = {
      type: payload.type,
      effects: payload.effects,
      bonus: payload.bonus,
      ranks: payload.ranks,
    };
    const variants: OuterDef[] = [
      outerWith(unflagged, 'aura'),
      outerWith({ ...payload, effects: [{ ...zone, radius: 81 } as PayloadEffect] }, 'aura'),
      outerWith(
        { ...payload, ranks: [FIXTURE_RANKS[0], EMPTY_RANKS[1], FIXTURE_RANKS[2]] },
        'aura',
      ),
    ];
    const digests = [
      ...variants.map((outer) => generate(content.characters.fire, outer, undefined, 1).digest),
      generate(content.characters.fire, outerOf('aura'), { modifiers: [] }, 1).digest,
      generate(content.characters.ice, outerOf('aura'), undefined, 1).digest,
    ];
    expect(new Set([base, ...digests]).size).toBe(6);
  });
});
