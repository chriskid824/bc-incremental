import { describe, expect, it } from 'vitest';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import { compileBuild } from '../build/compile';
import { makeStats } from '../testing';
import type { TestModule } from './module';
import { sixCoils } from './sixCoils';

const TRIPHASE_ARC: SignatureSpec = { id: 'triphaseArc' };
const SIX_COILS: RuleSpec = { id: 'sixCoils', coils: 6, targets: 2, damageMult: 0.55 };

describe('sixCoils (六線圈)', () => {
  it('leaves the arc params neutral without the form, and sets all three with it', () => {
    expect(compileBuild(makeStats(), [], TRIPHASE_ARC).signature.arc).toEqual({
      coils: 3,
      targets: 1,
      damageMult: 1,
    });
    expect(compileBuild(makeStats(), [SIX_COILS], TRIPHASE_ARC).signature.arc).toEqual({
      coils: 6,
      targets: 2,
      damageMult: 0.55,
    });
  });

  it('takes the first instance', () => {
    const rules: RuleSpec[] = [
      { id: 'sixCoils', coils: 4, targets: 1, damageMult: 0.8 },
      SIX_COILS,
      { id: 'sixCoils', coils: 2, targets: 2, damageMult: 2 },
    ];
    expect(compileBuild(makeStats(), rules, TRIPHASE_ARC).signature.arc).toEqual({
      coils: 4,
      targets: 1,
      damageMult: 0.8,
    });
  });

  it("makes the form in a run of another signature a compile error naming that signature's id", () => {
    for (const id of ['m1Volley', 'magmaBomb', 'iceFan'] as const) {
      const signature: SignatureSpec | undefined = id === 'm1Volley' ? undefined : { id };
      expect(() => compileBuild(makeStats(), [SIX_COILS], signature)).toThrow(
        `rule 'sixCoils' tunes the triphaseArc signature, but this run's signature is '${id}'`,
      );
    }
    expect(() => compileBuild(makeStats(), [SIX_COILS], TRIPHASE_ARC)).not.toThrow();
  });

  it("names the run's signature from SignatureParams.id, and does nothing without an instance", () => {
    // A triphaseArc run whose arc params a test module nulls names itself.
    const noArc: TestModule = (b, source) => {
      b.signature().arc = null;
      sixCoils.compile(b, [{ id: 'sixCoils', coils: 6, targets: 2, damageMult: 0.55 }], source);
    };
    expect(() => compileBuild(makeStats(), [], TRIPHASE_ARC, [noArc])).toThrow(
      "rule 'sixCoils' tunes the triphaseArc signature, but this run's signature is 'triphaseArc'",
    );
    const none: TestModule = (b, source) => sixCoils.compile(b, [], source);
    expect(compileBuild(makeStats(), [], TRIPHASE_ARC, [none]).signature.arc).toEqual({
      coils: 3,
      targets: 1,
      damageMult: 1,
    });
  });
});
