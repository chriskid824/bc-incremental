import { describe, expect, it } from 'vitest';
import type { RuleSpec } from './rules';
import {
  CHARACTER_SIGNATURE,
  POLICY_RULES,
  RULE_COEF_FIELDS,
  scaleRuleSpec,
  SIGNATURE_EVENT,
  SIGNATURE_FORMS,
} from './rules';

describe('signature tables', () => {
  it('gives each character its signature', () => {
    expect(CHARACTER_SIGNATURE).toEqual({
      fire: 'magmaBomb',
      ice: 'iceFan',
      lightning: 'triphaseArc',
      summon: 'swarm',
    });
  });

  it('gives each character signature its center event', () => {
    expect(SIGNATURE_EVENT).toEqual({
      magmaBomb: 'explode',
      iceFan: 'freeze',
      triphaseArc: 'chainJump',
      swarm: 'droneImpact',
    });
  });

  it('gives each signature its forms', () => {
    expect(SIGNATURE_FORMS).toEqual({
      m1Volley: [],
      magmaBomb: ['farThrow', 'volcano', 'chainBlast'],
      iceFan: ['icicle', 'prism'],
      triphaseArc: ['sixCoils'],
      swarm: [],
    });
  });
});

describe('scaleRuleSpec', () => {
  /** A test map: one field of each kind, and an optional field. */
  const FIELDS: typeof RULE_COEF_FIELDS = {
    chainBlast: { damagePct: 'pct', radius: 'mult' },
    prism: { perPierce: 'chance' },
    overload: { chainMore: 'mult' },
  };
  const BLAST: RuleSpec = { id: 'chainBlast', radius: 40, damagePct: 0.5, perBomb: 2 };

  it('scales pct and mult fields by coef, and only the fields its entry lists', () => {
    const scaled = scaleRuleSpec(BLAST, 2, FIELDS);
    expect(scaled).toStrictEqual({ id: 'chainBlast', radius: 80, damagePct: 1, perBomb: 2 });
    expect(scaleRuleSpec(BLAST, 0.5, FIELDS)).toStrictEqual({
      id: 'chainBlast',
      radius: 20,
      damagePct: 0.25,
      perBomb: 2,
    });
  });

  it('clamps a chance field at 1', () => {
    const prism: RuleSpec = { id: 'prism', perPierce: 0.4, maxBonus: 2 };
    expect(scaleRuleSpec(prism, 2, FIELDS)).toStrictEqual({
      id: 'prism',
      perPierce: 0.8,
      maxBonus: 2,
    });
    expect(scaleRuleSpec(prism, 3, FIELDS)).toStrictEqual({
      id: 'prism',
      perPierce: 1,
      maxBonus: 2,
    });
    expect(scaleRuleSpec(prism, 0.5, FIELDS)).toStrictEqual({
      id: 'prism',
      perPierce: 0.2,
      maxBonus: 2,
    });
  });

  it('clamps neither a pct nor a mult field', () => {
    expect(scaleRuleSpec(BLAST, 3, FIELDS)).toStrictEqual({
      id: 'chainBlast',
      radius: 120,
      damagePct: 1.5,
      perBomb: 2,
    });
  });

  it('leaves an optional field the spec leaves out absent', () => {
    const bare: RuleSpec = { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.15 };
    const scaled = scaleRuleSpec(bare, 2, FIELDS);
    expect(scaled).toStrictEqual(bare);
    expect(Object.keys(scaled)).toEqual(['id', 'chainCountMultiplier', 'retentionPenalty']);
    const full: RuleSpec = { ...bare, chainMore: 0.5 };
    expect(scaleRuleSpec(full, 2, FIELDS)).toStrictEqual({ ...bare, chainMore: 1 });
  });

  it('returns the spec itself at coef 1 and for an id with no entry', () => {
    expect(scaleRuleSpec(BLAST, 1, FIELDS)).toBe(BLAST);
    const cannon: RuleSpec = { id: 'glassCannon', damageMore: 1 };
    expect(scaleRuleSpec(cannon, 2, FIELDS)).toBe(cannon);
    // RULE_COEF_FIELDS, the default, has no entry until a hand module brings its own.
    expect(scaleRuleSpec(BLAST, 2)).toBe(BLAST);
  });

  it('copies a spec it scales and leaves the spec as it was', () => {
    const spec: RuleSpec = { ...BLAST };
    const scaled = scaleRuleSpec(spec, 2, FIELDS);
    expect(scaled).not.toBe(spec);
    expect(spec).toStrictEqual(BLAST);
  });
});

describe('tables the rule modules fill', () => {
  // Empty in C6.2 (docs/v3 C6 design §3.7, §4.2): each hand module adds its RULE_COEF_FIELDS
  // entry, and each chain-policy module its POLICY_RULES id, when it lands, and updates this pin.
  it('starts empty', () => {
    expect(RULE_COEF_FIELDS).toEqual({});
    expect(POLICY_RULES).toEqual([]);
  });
});
