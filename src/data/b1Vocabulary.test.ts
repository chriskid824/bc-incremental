/**
 * The engine vocabulary 熔核's content batch B1 asked for (C4 design §11's B1 row, F16, I7; lead
 * rulings H1, H3): the targetIs condition (TARGET_IS_PICKS) in the schemas and where validation
 * takes it, and the poisonSlow RuleSpec's schema, ranges and quoted numbers.
 */

import { describe, expect, it } from 'vitest';
import { quotedNumbers } from './ruleNumbers';
import type { RuleSpec } from './rules';
import { RULE_IDS } from './rules';
import {
  ConditionSchema,
  ModifierSchema,
  RuleSpecSchema,
  TargetConditionSchema,
  TriggerSpecSchema,
} from './schema';
import type { Modifier } from './stats';
import { CONDITION_CONTEXTS, TARGET_IS_PICKS, TRIGGER_EVENTS } from './triggers';
import type { TriggerSpec } from './triggers';
import { nodeEffectIssues } from './validate';

const AT = "node 'x'";
const heal = { kind: 'heal', lifePct: 0.01 } as const;
/** nodeEffectIssues of a node holding only these. */
const issuesOf = (
  modifiers: readonly Modifier[],
  triggers: readonly TriggerSpec[] = [],
  rules: readonly RuleSpec[] = [],
): string[] => nodeEffectIssues(AT, { modifiers, triggers, conversions: [], emitters: [], rules });

describe('targetIs (lead ruling H1)', () => {
  const LOCK: Modifier = {
    stat: 'critChance',
    kind: 'flat',
    value: 0.25,
    when: [{ targetIs: 'highestHp' }],
  };

  it('picks highestHp, a list later picks append to', () => {
    expect(TARGET_IS_PICKS).toEqual(['highestHp']);
  });

  it('parses on a modifier and a trigger, and rejects an unknown pick or another shape', () => {
    expect(TargetConditionSchema.parse({ targetIs: 'highestHp' })).toEqual({
      targetIs: 'highestHp',
    });
    expect(ConditionSchema.parse({ targetIs: 'highestHp' })).toEqual({ targetIs: 'highestHp' });
    expect(ModifierSchema.parse(LOCK)).toEqual(LOCK);
    const trigger: TriggerSpec = { on: 'hit', when: [{ targetIs: 'highestHp' }], do: [heal] };
    expect(TriggerSpecSchema.parse(trigger)).toEqual(trigger);
    for (const bad of [
      { targetIs: 'lowestHp' },
      { targetIs: 'nearest' },
      { targetIs: 'highestHp', range: 300 },
      { targetIs: ['highestHp'] },
      { targetIs: true },
    ]) {
      expect(TargetConditionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(ConditionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(ModifierSchema.safeParse({ ...LOCK, when: [bad] }).success).toBe(false);
      expect(TriggerSpecSchema.safeParse({ on: 'hit', when: [bad], do: [heal] }).success).toBe(
        false,
      );
    }
  });

  it('is allowed where the other target conditions are: modifiers and events with a target', () => {
    // Planted bug: targetIs left out of CONDITION_CONTEXTS' targeted events.
    expect(CONDITION_CONTEXTS.targetIs).toEqual(CONDITION_CONTEXTS.targetHpBelow);
    expect(issuesOf([LOCK])).toEqual([]);
    const on = (event: TriggerSpec['on']): TriggerSpec => ({
      on: event,
      ...(event === 'periodic' ? { every: 1 } : {}),
      when: [{ targetIs: 'highestHp' }],
      do: [heal],
    });
    for (const event of ['hit', 'crit', 'explode', 'contact', 'freeze', 'nthAttack'] as const) {
      expect(issuesOf([], [on(event)]), event).toEqual([]);
    }
    for (const event of ['kill', 'waveStart', 'periodic', 'heroHit', 'shatter'] as const) {
      expect(issuesOf([], [on(event)])).toEqual([
        `${AT}: triggers[0] when[0] targetIs does not apply to '${event}' events`,
      ]);
    }
    const targeted = TRIGGER_EVENTS.filter((event) => CONDITION_CONTEXTS.targetIs.includes(event));
    expect(targeted).toEqual(
      TRIGGER_EVENTS.filter((event) => CONDITION_CONTEXTS.targetHas.includes(event)),
    );
  });
});

describe('poisonSlow (lead ruling H3)', () => {
  const NEURO: RuleSpec = { id: 'poisonSlow', stacksPer: 5, slowPer: 0.02, max: 0.4 };

  it('is a rule id with its schema', () => {
    expect(RULE_IDS.at(-1)).toBe('poisonSlow');
    expect(RuleSpecSchema.parse(NEURO)).toEqual(NEURO);
    for (const bad of [
      { id: 'poisonSlow', stacksPer: 5, slowPer: 0.02 },
      { id: 'poisonSlow', stacksPer: 5, slowPer: 0.02, max: 0.4, every: 5 },
      { id: 'poisonSlow', stacksPer: '5', slowPer: 0.02, max: 0.4 },
      { id: 'poisonSlow', stacksPer: 5, slowPer: Infinity, max: 0.4 },
    ]) {
      expect(RuleSpecSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('takes stacksPer an integer of at least 1, and slowPer and max in (0, 1]', () => {
    // Planted bugs: a stacksPer of 0 (a division by 0) or 2.5 let through; a slow above 1 or of 0.
    expect(issuesOf([], [], [NEURO])).toEqual([]);
    expect(issuesOf([], [], [{ ...NEURO, stacksPer: 1, slowPer: 1, max: 1 }])).toEqual([]);
    const rule = `${AT}: rule 'poisonSlow'`;
    expect(issuesOf([], [], [{ ...NEURO, stacksPer: 0, slowPer: 0, max: 1.5 }])).toEqual([
      `${rule} poisonSlow.stacksPer must be a positive integer (got 0)`,
      `${rule} poisonSlow.slowPer must be in (0, 1] (got 0)`,
      `${rule} poisonSlow.max must be in (0, 1] (got 1.5)`,
    ]);
    expect(issuesOf([], [], [{ ...NEURO, stacksPer: 2.5, slowPer: -0.1, max: 0 }])).toEqual([
      `${rule} poisonSlow.stacksPer must be a positive integer (got 2.5)`,
      `${rule} poisonSlow.slowPer must be in (0, 1] (got -0.1)`,
      `${rule} poisonSlow.max must be in (0, 1] (got 0)`,
    ]);
    expect(issuesOf([], [], [{ ...NEURO, slowPer: 1.01, max: Number.NaN }])).toEqual([
      `${rule} poisonSlow.slowPer must be in (0, 1] (got 1.01)`,
      `${rule} poisonSlow.max must be in (0, 1] (got NaN)`,
    ]);
    // A node holds it once.
    expect(issuesOf([], [], [NEURO, NEURO])).toEqual([`${AT}: duplicate rule 'poisonSlow'`]);
  });

  it('quotes gd:389’s three numbers', () => {
    expect(quotedNumbers(NEURO)).toEqual([['5'], ['2%'], ['40%']]);
  });
});
