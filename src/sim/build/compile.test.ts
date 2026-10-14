import { describe, expect, it } from 'vitest';
import type { RuleSpec } from '../../data/rules';
import { SCOPED_STATS } from '../../data/stats';
import type { Modifier } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { TestModule } from '../rules';
import { damageRow, makeStats, maskProbeMods } from '../testing';
import { centerDamage, centerStat, compileBuild } from './compile';
import { modTableFor, SCOPED_INDEX } from './modTable';

const S = SCOPED_STATS.length;
const { critChance: CRIT_CHANCE, critMultiplier: CRIT_MULTIPLIER } = SCOPED_INDEX;

/** Masks of the M1 tags, plus a poison minion row no M1 modifier reaches. */
const MASKS = [...Array.from({ length: 16 }, (_, mask) => mask), TAG.poison | TAG.minion];

const compileWith = (stats = makeStats(), ...modules: TestModule[]) =>
  compileBuild(stats, [], undefined, modules);

describe('compileBuild', () => {
  it('is neutral without rules', () => {
    const stats = makeStats({ critChance: 0.3, chainCount: 1.5 }, [
      ...maskProbeMods(),
      { stat: 'critChance', kind: 'flat', value: 0.1, tags: ['chain'] },
      { stat: 'critMultiplier', kind: 'more', value: 0.5, tags: ['crit'] },
    ]);
    const build = compileBuild(stats, []);
    expect(build.values).toEqual(stats.values);
    expect(build.values).not.toBe(stats.values);
    expect(build.mods).toHaveLength(stats.scoped.length);
    expect(build.flags).toEqual({
      randomCrits: true,
      maxLife: null,
      burnRings: false,
      bleedMoveMult: 3,
    });
    expect(build.signature).toEqual({ forceCritEvery: 0, counts: 'shot' });
    expect(build.hooks).toEqual({
      tick: [],
      onKill: [],
      onAttack: [],
      onHit: [],
      modifyDamage: [],
      onCenterEvent: [],
    });
    expect(build.triggers).toEqual([]);
    expect(build.effects).toEqual([]);
    expect(build.triggersOn.every((list) => list.length === 0)).toBe(true);
    expect(build.sources.names).toEqual(['center']);
    const table = modTableFor(stats);
    for (const mask of MASKS) {
      expect(centerDamage(build, mask)).toBe(table.damage(mask));
      for (const stat of [CRIT_CHANCE, CRIT_MULTIPLIER]) {
        expect(centerStat(build, mask, stat)).toBe(table.final[table.row(mask) * S + stat]);
      }
    }
  });

  it('merges the instances of a rule: multipliers multiply, penalties add', () => {
    const rules: RuleSpec[] = [
      { id: 'glassCannon', damageMore: 1 },
      { id: 'glassCannon', damageMore: 0.5 },
      { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.25 },
      { id: 'overload', chainCountMultiplier: 1.5, retentionPenalty: 0.1 },
    ];
    const stats = makeStats({ chainCount: 1, chainRetention: 0.7 });
    const build = compileBuild(stats, rules);
    for (const mask of MASKS) expect(damageRow(stats, mask, rules)).toBe(3);
    expect(build.flags.maxLife).toBe(1);
    expect(build.values.chainCount).toBe(3);
    expect(build.values.chainRetention).toBeCloseTo(0.7 - 0.35, 12);
  });

  it('scales, then offsets, a stat in its value and in every row alike', () => {
    const stats = makeStats({ critChance: 0.2, critMultiplier: 2, attackSpeed: 3 }, [
      { stat: 'critChance', kind: 'flat', value: 0.1, tags: ['chain'] },
      { stat: 'critChance', kind: 'increased', value: 0.5, tags: ['crit'] },
      { stat: 'critMultiplier', kind: 'more', value: 0.5, tags: ['crit'] },
    ]);
    const plain = compileBuild(stats, []);
    const build = compileWith(stats, (b) => {
      b.scaleStat('critMultiplier', 1.5);
      b.offsetStat('critChance', 0.05);
      // A later scale scales the earlier offset too: v × 2 + (0.05 × 2 − 0.125).
      b.scaleStat('critChance', 2);
      b.offsetStat('critChance', -0.125);
      b.scaleStat('attackSpeed', 1.25);
      b.offsetStat('attackSpeed', 0.5);
    });
    expect(build.values).toEqual({
      ...stats.values,
      critChance: 0.2 * 2 + (0.05 * 2 - 0.125),
      critMultiplier: 2 * 1.5,
      attackSpeed: 3 * 1.25 + 0.5,
    });
    for (const mask of MASKS) {
      const chance = centerStat(plain, mask, CRIT_CHANCE);
      expect(centerStat(build, mask, CRIT_CHANCE)).toBe(chance * 2 + (0.05 * 2 - 0.125));
      const multiplier = centerStat(plain, mask, CRIT_MULTIPLIER);
      expect(centerStat(build, mask, CRIT_MULTIPLIER)).toBe(multiplier * 1.5);
      expect(centerDamage(build, mask)).toBe(centerDamage(plain, mask));
    }
    // The untagged row folds to the values exactly.
    expect(centerStat(build, 0, CRIT_CHANCE)).toBe(build.values.critChance);
    expect(centerStat(build, 0, CRIT_MULTIPLIER)).toBe(build.values.critMultiplier);
  });

  it("throws on scaleStat('damage') and offsetStat('damage')", () => {
    expect(() => compileWith(makeStats(), (b) => b.scaleStat('damage', 2))).toThrow(/damage/);
    expect(() => compileWith(makeStats(), (b) => b.offsetStat('damage', 1))).toThrow(/damage/);
  });

  it('adds modifiers after the build modifiers, in order, and rejects what rows cannot hold', () => {
    const stats = makeStats({}, maskProbeMods());
    const first: Modifier = { stat: 'damage', kind: 'more', value: 1, tags: ['burn'] };
    const second: Modifier = { stat: 'critChance', kind: 'flat', value: 0.25, tags: ['chain'] };
    const build = compileWith(stats, (b) => {
      b.addModifier(first);
      b.addModifier(second);
    });
    expect(build.mods).toHaveLength(stats.scoped.length + 2);
    expect(build.mods.at(-2)).toMatchObject({ stat: SCOPED_INDEX.damage, kind: 2, value: 1 });
    expect(build.mods.at(-1)).toMatchObject({ stat: CRIT_CHANCE, kind: 0, value: 0.25 });
    for (const mask of MASKS) {
      const burn = (mask & TAG.burn) !== 0 ? 2 : 1;
      expect(centerDamage(build, mask)).toBe(damageRow(stats, mask) * burn);
    }
    const rejected: Modifier[] = [
      { stat: 'attackSpeed', kind: 'increased', value: 0.5 },
      { stat: 'damage', kind: 'flat', value: 5 },
      { stat: 'critChance', kind: 'flat', value: 0.1 },
      { stat: 'critMultiplier', kind: 'more', value: 0.5 },
    ];
    for (const mod of rejected) {
      expect(() => compileWith(stats, (b) => b.addModifier(mod))).toThrow(/addModifier/);
    }
    // An untagged damage modifier, a scaling one and a scoped one are fine.
    const accepted: Modifier[] = [
      { stat: 'damage', kind: 'more', value: 1 },
      { stat: 'critChance', kind: 'flat', value: 0.1, scaling: { per: 'chainJump' } },
      { stat: 'critChance', kind: 'flat', value: 0.1, scope: 'center' },
    ];
    for (const mod of accepted) {
      expect(compileWith(stats, (b) => b.addModifier(mod)).mods.at(-1)).toBeDefined();
    }
  });

  it('compiles the rules in order of first appearance, then the test modules', () => {
    const seen: (number | null)[] = [];
    const rules: RuleSpec[] = [
      { id: 'glassCannon', damageMore: 0.5 },
      { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.1, chainMore: 1 },
      { id: 'glassCannon', damageMore: 0.25 },
      { id: 'overload', chainCountMultiplier: 1.5, retentionPenalty: 0.1, chainMore: 2 },
    ];
    const onKill = (): void => undefined;
    const build = compileBuild(makeStats({ chainCount: 1 }), rules, undefined, [
      (b, source) => {
        // Every instance of both rules compiled already.
        seen.push(b.values.chainCount, b.flags.maxLife);
        seen.push(source, b.source('center'), b.source('outer.lightning'));
        b.hook('onKill', onKill);
      },
    ]);
    expect(seen).toEqual([3, 1, 0, 0, 1]);
    // Each rule's added modifiers together, the rules in the order they first appear.
    expect(build.mods.map((mod) => mod.value)).toEqual([0.5, 0.25, 1, 2]);
    expect(build.sources.names).toEqual(['center', 'outer.lightning']);
    expect(build.hooks.onKill).toEqual([onKill]);
  });
});
