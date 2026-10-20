import { describe, expect, it } from 'vitest';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import { compileBuild } from '../build/compile';
import { makeStats } from '../testing';
import { icicle, prism } from './fanForms';
import type { TestModule } from './module';

const ICE_FAN: SignatureSpec = { id: 'iceFan' };
const ICICLE: RuleSpec = { id: 'icicle', every: 4, damagePct: 4 };
const PRISM: RuleSpec = { id: 'prism', perPierce: 0.2, maxBonus: 2 };

describe('fan forms', () => {
  it('leave the fan params neutral without a form, and set one member each', () => {
    const neutral = { icicleEvery: 0, icicleDamagePct: 0, prism: null };
    expect(compileBuild(makeStats(), [], ICE_FAN).signature.fan).toEqual(neutral);
    expect(compileBuild(makeStats(), [ICICLE], ICE_FAN).signature.fan).toEqual({
      ...neutral,
      icicleEvery: 4,
      icicleDamagePct: 4,
    });
    expect(compileBuild(makeStats(), [PRISM], ICE_FAN).signature.fan).toEqual({
      ...neutral,
      prism: { perPierce: 0.2, maxBonus: 2 },
    });
    expect(compileBuild(makeStats(), [PRISM, ICICLE], ICE_FAN).signature.fan).toEqual({
      icicleEvery: 4,
      icicleDamagePct: 4,
      prism: { perPierce: 0.2, maxBonus: 2 },
    });
  });

  it('merge their instances: 冰柱 the smallest every and the first damagePct, 稜鏡 the first instance', () => {
    const rules: RuleSpec[] = [
      { id: 'icicle', every: 6, damagePct: 3 },
      { id: 'prism', perPierce: 0.1, maxBonus: 1 },
      { id: 'icicle', every: 3, damagePct: 5 },
      PRISM,
      { id: 'icicle', every: 5, damagePct: 7 },
    ];
    expect(compileBuild(makeStats(), rules, ICE_FAN).signature.fan).toEqual({
      icicleEvery: 3,
      icicleDamagePct: 3,
      prism: { perPierce: 0.1, maxBonus: 1 },
    });
  });

  it.each([ICICLE, PRISM])(
    "makes $id in a run of another signature a compile error naming that signature's id",
    (rule) => {
      expect(() => compileBuild(makeStats(), [rule])).toThrow(
        `rule '${rule.id}' tunes the iceFan signature, but this run's signature is 'm1Volley'`,
      );
      expect(() => compileBuild(makeStats(), [rule], { id: 'magmaBomb' })).toThrow(
        `rule '${rule.id}' tunes the iceFan signature, but this run's signature is 'magmaBomb'`,
      );
      expect(() => compileBuild(makeStats(), [rule], ICE_FAN)).not.toThrow();
    },
  );

  it("names the run's signature from SignatureParams.id, which compileBuild sets", () => {
    expect(compileBuild(makeStats(), [], ICE_FAN).signature.id).toBe('iceFan');
    // The error names SignatureParams.id: an iceFan run whose fan params a test module nulls
    // names itself.
    const noFan: TestModule = (b, source) => {
      b.signature().fan = null;
      icicle.compile(b, [{ id: 'icicle', every: 4, damagePct: 4 }], source);
    };
    expect(() => compileBuild(makeStats(), [], ICE_FAN, [noFan])).toThrow(
      "rule 'icicle' tunes the iceFan signature, but this run's signature is 'iceFan'",
    );
    const noFanPrism: TestModule = (b, source) => {
      b.signature().fan = null;
      prism.compile(b, [{ id: 'prism', perPierce: 0.2, maxBonus: 2 }], source);
    };
    expect(() => compileBuild(makeStats(), [], ICE_FAN, [noFanPrism])).toThrow(
      "rule 'prism' tunes the iceFan signature, but this run's signature is 'iceFan'",
    );
  });
});
