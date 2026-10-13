import { afterEach, describe, expect, it } from 'vitest';
import type { RuleSpec } from '../data/rules';
import { BASE_STATS, DAMAGE_TAG_BIT } from '../data/stats';
import { setLocale, t } from '../i18n';
import { makeStats } from '../sim/testing';
import { describeBuild, describeModifier } from './describe';

/** describeBuild as a label → value record. */
function build(rules: readonly RuleSpec[] = [], stats = makeStats()): Record<string, string> {
  return Object.fromEntries(describeBuild(stats, rules).map((line) => [line.label, line.value]));
}

describe('describeBuild', () => {
  afterEach(() => setLocale('en'));

  it('shows the plain stats without rules', () => {
    expect(build()).toEqual({
      [t('stat.damage.hit')]: '10',
      [t('stat.attackSpeed')]: `${BASE_STATS.attackSpeed}/s`,
      [t('stat.projectileCount')]: String(BASE_STATS.projectileCount),
      [t('stat.critChance')]: '5%',
      [t('stat.critMultiplier')]: '150%',
      [t('build.critHit')]: '15',
      [t('stat.igniteChance')]: '10%',
      [t('build.burnPerStack')]: '15/s',
      [t('stat.burnDuration')]: '1.2',
      [t('stat.burnMaxStacks')]: '5',
      [t('stat.chainCount')]: '0',
      [t('build.chainJump')]: '7',
      [t('stat.maxLife')]: '100',
    });
  });

  it('shows what crit, burn and chain damage nodes do, each on its own line', () => {
    const { crit, burn, chain } = DAMAGE_TAG_BIT;
    // ×2 on every crit mask, ×3 on every burn mask, ×5 on every chain mask.
    const mult = (mask: number): number =>
      (mask & crit ? 2 : 1) * (mask & burn ? 3 : 1) * (mask & chain ? 5 : 1);
    const lines = build([], makeStats({}, mult));
    expect(lines[t('stat.damage.hit')]).toBe('10');
    expect(lines[t('build.critHit')]).toBe('30');
    expect(lines[t('build.burnPerStack')]).toBe('45/s');
    expect(lines[t('build.chainJump')]).toBe('35');
  });

  it('applies the overload retention penalty to the first chain jump', () => {
    const lines = build(
      [{ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2 }],
      makeStats({ chainCount: 1.5, chainRetention: 0.7 }),
    );
    expect(lines[t('stat.chainCount')]).toBe('3');
    expect(lines[t('build.chainJump')]).toBe('5');
  });

  it('shows the steadyAim rhythm instead of a crit chance, with its crit multiplier', () => {
    const lines = build(
      [{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5 }],
      makeStats({ critChance: 0.17 }),
    );
    expect(lines[t('stat.critChance')]).toBe('Every 3 shots');
    expect(lines[t('stat.critMultiplier')]).toBe('225%');
    setLocale('zh-TW');
    expect(
      build([{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5 }])[t('stat.critChance')],
    ).toBe('每 3 發一次');
  });

  it('applies glassCannon, pandemic and overload', () => {
    const glass = build([{ id: 'glassCannon', damageMore: 1 }]);
    expect(glass[t('stat.damage.hit')]).toBe('20');
    expect(glass[t('stat.maxLife')]).toBe('1');
    expect(
      build([{ id: 'pandemic', spreadRadius: 250, spreadEffect: 0.8, hitMore: -0.3 }])[
        t('stat.damage.hit')
      ],
    ).toBe('7');
    const overload = build(
      [{ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.15 }],
      makeStats({ chainCount: 1.5 }),
    );
    expect(overload[t('stat.chainCount')]).toBe('3');
  });

  it('shows the non-crit hit under searingCrits', () => {
    const lines = build([{ id: 'critsAlwaysIgnite', nonCritHitMore: -0.5 }]);
    expect(lines[t('stat.damage.hit')]).toBe('5');
  });
});

describe('describeModifier', () => {
  it('formats flat, increased and more modifiers', () => {
    expect(describeModifier({ stat: 'critChance', kind: 'flat', value: 0.03 })).toBe(
      '+3% Crit chance',
    );
    expect(
      describeModifier({ stat: 'damage', kind: 'increased', value: 0.2, tags: ['burn'] }),
    ).toBe('20% increased Burn damage');
    expect(describeModifier({ stat: 'damage', kind: 'more', value: 0.1 })).toBe('10% more Damage');
  });
});
