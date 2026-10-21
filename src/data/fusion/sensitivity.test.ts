import { describe, expect, it, vi } from 'vitest';
import { CHAIN_JUMP_CHANCE } from '../../sim/effects/types';
import { RULE_COEF_FIELDS } from '../rules';
import type { RuleSpec } from '../rules';
import type * as RulesModule from '../rules';
import { CHARACTER_IDS, OUTER_IDS } from '../sources';
import type { CharacterId, OuterId } from '../sources';
import { COEF_MAX, COEF_MIN } from '../triggers';
import type { EffectSpec, TriggerSpec } from '../triggers';
import { fixtureContent } from '../web/testing';
import type {
  FusionDef,
  FusionKey,
  FusionOverride,
  OuterDef,
  OuterPayload,
  PayloadEffect,
} from '../web/types';
import { generate } from './generate';
import { coefRange } from './sensitivity';
import type { CoefRange } from './sensitivity';

const content = fixtureContent();
const outerOf = (o: OuterId): OuterDef => content.outers[o] as OuterDef;

/** The fixture's fusion `key`, with its override. */
function fusion(key: FusionKey): FusionDef {
  const [c, o] = key.split('.') as [CharacterId, OuterId];
  return generate(content.characters[c], outerOf(o), content.overrides[key], 1);
}

/** `c` with a template outer whose payload is `effects` (no bonus), `override` and the flag. */
function templated(
  c: CharacterId,
  effects: readonly PayloadEffect[],
  override?: FusionOverride,
  coefScalesBonus = false,
): FusionDef {
  const payload: OuterPayload = {
    ...(outerOf('bleed').payload as OuterPayload),
    effects,
    bonus: null,
    ...(coefScalesBonus ? { coefScalesBonus: true as const } : {}),
  };
  return generate(content.characters[c], { ...outerOf('bleed'), payload }, override, 1);
}

/** fire's template core with only `triggers` in it. */
const withTriggers = (...triggers: TriggerSpec[]): FusionDef => templated('fire', [], { triggers });
const push: EffectSpec = { kind: 'push', distance: 40, radius: 60 };
const spread = (effect?: number): EffectSpec => ({
  kind: 'spreadAilment',
  ailment: 'poison',
  radius: 90,
  ...(effect === undefined ? {} : { effect }),
});

const TEN: CoefRange = [0.1, 10];
const JUMP: CoefRange = [0.1, 1 / 0.3];

describe('the coef bounds', () => {
  it("are impl:480's 二分法範圍 0.1–10", () => {
    expect(COEF_MIN).toBe(0.1);
    expect(COEF_MAX).toBe(10);
  });

  it("read chainJump's chance as the simulation's CHAIN_JUMP_CHANCE", () => {
    expect(CHAIN_JUMP_CHANCE).toBe(0.3);
    expect(coefRange(fusion('lightning.combo'))).toEqual([COEF_MIN, 1 / CHAIN_JUMP_CHANCE]);
  });
});

describe('coefRange', () => {
  it("gives the fixture's 44 fusions their ranges", () => {
    // fire, ice, lightning and summon with each outer; '-' is the character's own.
    const table: Readonly<Record<OuterId, readonly (CoefRange | null | '-')[]>> = {
      fire: ['-', null, null, null],
      poison: [[0.1, 1.98], TEN, TEN, TEN],
      bleed: [TEN, TEN, TEN, TEN],
      lightning: [null, null, '-', null],
      combo: [TEN, TEN, JUMP, TEN],
      crit: [TEN, TEN, TEN, TEN],
      ice: [null, '-', null, null],
      aura: [TEN, TEN, JUMP, TEN],
      thorns: [TEN, TEN, TEN, TEN],
      summon: [null, null, null, '-'],
      barrage: [TEN, TEN, TEN, TEN],
      greed: [TEN, TEN, TEN, TEN],
    };
    let pairs = 0;
    for (const o of OUTER_IDS) {
      CHARACTER_IDS.forEach((c, index) => {
        const expected = table[o][index];
        if (expected === '-') return;
        pairs++;
        expect([`${c}.${o}`, coefRange(fusion(`${c}.${o}`))]).toEqual([`${c}.${o}`, expected]);
      });
    }
    expect(pairs).toBe(44);
  });

  it('gives a core with a COEF field above 0 the whole range, a field left out counting as 1', () => {
    const damaging: readonly PayloadEffect[] = [
      { kind: 'applyAilment', ailment: 'burn' },
      { kind: 'explode', radius: 60, damagePct: 1 },
      { kind: 'nova', radius: 90, damagePct: 0.5 },
      { kind: 'slashLine', length: 300, width: 24, damagePct: 1 },
      { kind: 'projectiles', count: 4, damagePct: 0.25, aim: 'radial' },
      { kind: 'coinHit', multiplier: 10 },
      { kind: 'chainBolt', jumps: 2, damagePct: 0.5 },
      { kind: 'detonate', ailment: 'burn' },
      { kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0.5 },
      // A zone's ailment, at its default ailmentDamagePct 1.
      { kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0, ailment: 'poison' },
    ];
    for (const effect of damaging) {
      expect([effect.kind, coefRange(templated('fire', [effect]))]).toEqual([effect.kind, TEN]);
    }
    // Damage scales past the chance's saturation.
    const chanced = withTriggers({
      on: 'explode',
      when: [{ chance: 0.25 }],
      do: [{ kind: 'explode', radius: 60, damagePct: 1 }],
    });
    expect(coefRange(chanced)).toEqual(TEN);
  });

  it('counts no COEF field at 0, nor a zone ailment damage without an ailment', () => {
    const idle: readonly PayloadEffect[] = [
      { kind: 'applyAilment', ailment: 'burn', damagePct: 0 },
      { kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0 },
      {
        kind: 'groundZone',
        radius: 80,
        durationSec: 2,
        damagePctPerSec: 0,
        ailment: 'burn',
        ailmentDamagePct: 0,
      },
      { kind: 'addFrost', amount: 0.25 },
      { kind: 'repeatAttack', count: 1, damagePct: 0.5 },
    ];
    for (const effect of idle) {
      expect([effect.kind, coefRange(templated('summon', [effect]))]).toEqual([effect.kind, null]);
    }
  });

  it("lowers the top to 0.99 / e for each transfer of effect e: 瘟疫爆彈's 1.98", () => {
    const plague = coefRange(fusion('fire.poison'));
    expect(plague).toEqual([0.1, 1.98]);
    expect(plague?.[1]).toBe(1.98);
    // The lowest bound wins, in either order and across triggers.
    const highest: CoefRange = [0.1, 0.99 / 0.9];
    expect(coefRange(withTriggers({ on: 'kill', do: [spread(0.5), spread(0.9)] }))).toEqual(
      highest,
    );
    expect(coefRange(withTriggers({ on: 'kill', do: [spread(0.9), spread(0.5)] }))).toEqual(
      highest,
    );
    const apart = withTriggers(
      { on: 'kill', do: [spread(0.9)] },
      { on: 'kill', do: [spread(0.5)] },
    );
    expect(coefRange(apart)).toEqual(highest);
    expect(coefRange(withTriggers({ on: 'kill', do: [spread()] }))).toEqual([0.1, 0.99]);
    const burn: EffectSpec = { kind: 'spreadAilment', ailment: 'burn', radius: 60, effect: 0.25 };
    expect(coefRange(withTriggers({ on: 'kill', do: [burn] }))).toEqual([0.1, 3.96]);
  });

  it('saturates a chance p < 1 at 1 / p, p the largest, when nothing deals damage', () => {
    const chance = (...chances: number[]): TriggerSpec => ({
      on: 'explode',
      when: chances.map((p) => ({ chance: p })),
      do: [push],
    });
    expect(coefRange(withTriggers(chance(0.25)))).toEqual([0.1, 4]);
    expect(coefRange(withTriggers(chance(0.25), chance(0.5)))).toEqual([0.1, 2]);
    expect(coefRange(withTriggers(chance(0.5), chance(0.25)))).toEqual([0.1, 2]);
    // The last chance condition is the trigger's, as compileTrigger reads it.
    expect(coefRange(withTriggers(chance(0.5, 0.25)))).toEqual([0.1, 4]);
    expect(coefRange(withTriggers(chance(1)))).toBeNull();
    expect(coefRange(withTriggers(chance(0.05)))).toEqual(TEN);
    // chainJump's fixed 0.3, with or without the flag.
    expect(coefRange(templated('lightning', [{ kind: 'addFrost', amount: 0.25 }]))).toEqual(JUMP);
    expect(coefRange(fusion('lightning.aura'))).toEqual(JUMP);
  });

  it('gives the whole range under coefScalesBonus when nothing else scales, and none without', () => {
    const repeat: PayloadEffect = { kind: 'repeatAttack', count: 1, damagePct: 0.5 };
    expect(coefRange(templated('fire', [repeat], undefined, true))).toEqual(TEN);
    expect(coefRange(templated('fire', [repeat]))).toBeNull();
    expect(coefRange(fusion('ice.combo'))).toEqual(TEN);
    expect(coefRange(fusion('summon.aura'))).toEqual(TEN);
    // 冰光's rule has no RULE_COEF_FIELDS entry: the flag decides.
    expect(coefRange(fusion('ice.aura'))).toEqual(TEN);
    const zone = (outerOf('aura').payload as OuterPayload).effects;
    expect(coefRange(templated('summon', zone))).toBeNull();
  });

  it('reads the core: an override trigger in place of the template, or added to it', () => {
    expect(coefRange(templated('fire', [push]))).toBeNull();
    expect(
      coefRange(
        templated('fire', [push], {
          addTriggers: [{ on: 'kill', do: [{ kind: 'coinHit', multiplier: 1 }] }],
        }),
      ),
    ).toEqual(TEN);
    expect(
      coefRange(
        templated('fire', [{ kind: 'coinHit', multiplier: 1 }], {
          triggers: [{ on: 'explode', do: [push] }],
        }),
      ),
    ).toBeNull();
  });

  describe('a hand core', () => {
    const lend = (key: FusionKey, rule: RuleSpec, triggers: TriggerSpec[] = []): FusionDef => {
      const [c, o] = key.split('.') as [CharacterId, OuterId];
      return generate(content.characters[c], outerOf(o), { rule, addTriggers: triggers }, 1);
    };
    const overload: RuleSpec = {
      id: 'overload',
      chainCountMultiplier: 2,
      retentionPenalty: 0.2,
      chainMore: 3.5,
    };

    it('has none without a RULE_COEF_FIELDS entry, as every fixture hand core', () => {
      expect(RULE_COEF_FIELDS).toEqual({});
      expect(coefRange(fusion('ice.fire'))).toBeNull();
      expect(
        coefRange(fusion('fire.lightning'), { steadyAim: { critMultiplierMore: 'pct' } }),
      ).toBeNull();
    });

    it('reads RULE_COEF_FIELDS itself when no table is passed', async () => {
      vi.resetModules();
      vi.doMock('../rules', async (importOriginal) => ({
        ...(await importOriginal<typeof RulesModule>()),
        RULE_COEF_FIELDS: { eternalFlame: { durationMore: 'pct' } },
      }));
      try {
        const { coefRange: withTable } = await import('./sensitivity');
        expect(withTable(fusion('ice.fire'))).toEqual(TEN);
        expect(withTable(fusion('ice.lightning'))).toBeNull();
      } finally {
        vi.doUnmock('../rules');
        vi.resetModules();
      }
    });

    it('takes the whole range from a pct or mult entry', () => {
      expect(coefRange(fusion('ice.fire'), { eternalFlame: { durationMore: 'pct' } })).toEqual(TEN);
      expect(coefRange(fusion('fire.summon'), { glassCannon: { damageMore: 'mult' } })).toEqual(
        TEN,
      );
      const mixed = { overload: { chainMore: 'pct', retentionPenalty: 'chance' } } as const;
      expect(coefRange(lend('summon.lightning', overload), mixed)).toEqual(TEN);
    });

    it('saturates at 1 / p with only chance entries, p the largest', () => {
      expect(
        coefRange(fusion('fire.lightning'), { overload: { retentionPenalty: 'chance' } }),
      ).toEqual([0.1, 5]);
      const rule: RuleSpec = { id: 'overload', chainCountMultiplier: 0.4, retentionPenalty: 0.2 };
      const both = {
        overload: { chainCountMultiplier: 'chance', retentionPenalty: 'chance' },
      } as const;
      expect(coefRange(lend('ice.lightning', rule), both)).toEqual([0.1, 2.5]);
    });

    it('scales no field the spec leaves out', () => {
      const rule: RuleSpec = { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2 };
      expect(
        coefRange(lend('fire.lightning', rule), { overload: { chainMore: 'pct' } }),
      ).toBeNull();
    });

    it("reads its added triggers, and a template core's added rules", () => {
      const coin: TriggerSpec = { on: 'kill', do: [{ kind: 'coinHit', multiplier: 1 }] };
      expect(coefRange(lend('fire.ice', { id: 'glassCannon', damageMore: 1 }, [coin]))).toEqual(
        TEN,
      );
      expect(coefRange(fusion('lightning.aura'), { overload: { chainMore: 'pct' } })).toEqual(TEN);
    });
  });

  it('never leaves [COEF_MIN, COEF_MAX]', () => {
    // An effect past validation's [0, 1]: the top stops at COEF_MIN.
    expect(coefRange(withTriggers({ on: 'kill', do: [spread(20)] }))).toEqual([0.1, 0.1]);
    for (const c of CHARACTER_IDS) {
      for (const o of OUTER_IDS) {
        if (o === c) continue;
        const range = coefRange(fusion(`${c}.${o}`));
        if (range === null) continue;
        expect(range[0]).toBe(COEF_MIN);
        expect(range[1]).toBeGreaterThanOrEqual(COEF_MIN);
        expect(range[1]).toBeLessThanOrEqual(COEF_MAX);
      }
    }
  });
});
