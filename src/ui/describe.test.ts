import { afterEach, describe, expect, it } from 'vitest';
import type { RuleSpec, SignatureSpec } from '../data/rules';
import { BASE_STATS } from '../data/stats';
import { DAMAGE_TAGS } from '../data/tags';
import { TALENTS } from '../data/talents';
import { setLocale, t } from '../i18n';
import { makeStats, PANDEMIC_MODS, SEARING_CRITS_MODS } from '../sim/testing';
import { describeBuild, describeModifier, describeView } from './describe';

/** describeBuild as a label → value record. */
function build(
  rules: readonly RuleSpec[] = [],
  stats = makeStats(),
  signature?: SignatureSpec,
): Record<string, string> {
  return Object.fromEntries(
    describeBuild(stats, rules, signature).map((line) => [line.label, line.value]),
  );
}

const MAGMA_BOMB: SignatureSpec = { id: 'magmaBomb' };
const SWARM: SignatureSpec = { id: 'swarm' };

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
    // ×2 on every crit mask, ×3 on every burn mask, ×5 on every chain mask.
    const stats = makeStats({}, [
      { stat: 'damage', kind: 'more', value: 1, tags: ['crit'] },
      { stat: 'damage', kind: 'more', value: 2, tags: ['burn'] },
      { stat: 'damage', kind: 'more', value: 4, tags: ['chain'] },
    ]);
    const lines = build([], stats);
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
      [{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'shot' }],
      makeStats({ critChance: 0.17 }),
    );
    expect(lines[t('stat.critChance')]).toBe('Every 3 shots');
    expect(lines[t('stat.critMultiplier')]).toBe('225%');
    setLocale('zh-TW');
    expect(
      build([{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'shot' }])[
        t('stat.critChance')
      ],
    ).toBe('每 3 發一次');
  });

  it('shows the steadyAim rhythm in attacks when it counts attacks', () => {
    const steady = {
      id: 'steadyAim',
      everyNth: 3,
      critMultiplierMore: 0.5,
      counts: 'attack',
    } as const;
    expect(build([steady])[t('stat.critChance')]).toBe('Every 3 attacks');
    setLocale('zh-TW');
    expect(build([steady])[t('stat.critChance')]).toBe('每 3 次攻擊');
  });

  it("reads the signature attack's rows: projectile hits for M1, area projectile hits for 熔核", () => {
    // ×2 on projectile hits, ×3 on area hits, ×5 on chain hits; none on M1's base rows.
    const stats = makeStats({ critChance: 0 }, [
      { stat: 'damage', kind: 'more', value: 1, tags: ['projectile'] },
      { stat: 'damage', kind: 'more', value: 2, tags: ['area'] },
      { stat: 'damage', kind: 'more', value: 4, tags: ['chain'] },
    ]);
    const m1 = build([], stats);
    expect(m1[t('stat.damage.hit')]).toBe('20');
    expect(m1[t('build.critHit')]).toBe('30');
    expect(m1[t('build.chainJump')]).toBe('35');
    const magma = build([], stats, MAGMA_BOMB);
    expect(magma[t('stat.damage.hit')]).toBe('60');
    expect(magma[t('build.critHit')]).toBe('90');
    // Its jumps keep no area or projectile tag.
    expect(magma[t('build.chainJump')]).toBe('35');
    // A burn is no projectile or area hit: both read the plain burn row.
    expect(m1[t('build.burnPerStack')]).toBe('15/s');
    expect(magma[t('build.burnPerStack')]).toBe('15/s');
  });

  it('shows the compiled projectile count: one bomb a firing for 熔核 at base (D28)', () => {
    expect(build()[t('stat.projectileCount')]).toBe(String(BASE_STATS.projectileCount));
    expect(build([], makeStats(), MAGMA_BOMB)[t('stat.projectileCount')]).toBe(
      String(BASE_STATS.projectileCount - 1),
    );
    expect(BASE_STATS.projectileCount - 1).toBe(1);
  });

  it('shows 蜂巢’s swarm: minion area impacts, and one projectile, a turret’s firing, at base (F16, F18)', () => {
    expect(build([], makeStats(), SWARM)).toEqual({
      [t('stat.damage.hit')]: '10',
      [t('stat.attackSpeed')]: `${BASE_STATS.attackSpeed}/s`,
      [t('stat.projectileCount')]: '1',
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
    // ×2 on minion hits, ×3 on area hits, ×5 on projectile hits: an impact is a minion area hit.
    const stats = makeStats({ critChance: 0 }, [
      { stat: 'damage', kind: 'more', value: 1, tags: ['minion'] },
      { stat: 'damage', kind: 'more', value: 2, tags: ['area'] },
      { stat: 'damage', kind: 'more', value: 4, tags: ['projectile'] },
    ]);
    const swarm = build([], stats, SWARM);
    expect(swarm[t('stat.damage.hit')]).toBe('60');
    expect(swarm[t('build.critHit')]).toBe('90');
    // Its jumps keep the minion tag (jumpMask), not the area tag.
    expect(swarm[t('build.chainJump')]).toBe('14');
    expect(build([], stats)[t('stat.damage.hit')]).toBe('50');
  });

  it('applies glassCannon, Pandemic’s hit cost and overload', () => {
    const glass = build([{ id: 'glassCannon', damageMore: 1 }]);
    expect(glass[t('stat.damage.hit')]).toBe('20');
    expect(glass[t('stat.maxLife')]).toBe('1');
    expect(build([], makeStats({}, PANDEMIC_MODS))[t('stat.damage.hit')]).toBe('7');
    const overload = build(
      [{ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.15 }],
      makeStats({ chainCount: 1.5 }),
    );
    expect(overload[t('stat.chainCount')]).toBe('3');
  });

  it('shows the non-crit hit under searingCrits', () => {
    const lines = build([], makeStats({}, SEARING_CRITS_MODS));
    expect(lines[t('stat.damage.hit')]).toBe('5');
    expect(lines[t('build.critHit')]).toBe('15');
    expect(lines[t('build.chainJump')]).toBe('3.5');
  });
});

describe('describeView', () => {
  it("describes the talent web's build with the signature its runs play (?hive: the swarm)", () => {
    const stats = makeStats({}, SEARING_CRITS_MODS);
    const rules: RuleSpec[] = [{ id: 'glassCannon', damageMore: 1 }];
    const hive = describeView({ stats, rules, signature: SWARM });
    expect(hive).toEqual(describeBuild(stats, rules, SWARM));
    expect(hive).not.toEqual(describeBuild(stats, rules));
    expect(describeView({ stats, rules })).toEqual(describeBuild(stats, rules));
  });
});

describe('describeModifier', () => {
  afterEach(() => setLocale('en'));

  it('formats flat, increased and more modifiers', () => {
    expect(describeModifier({ stat: 'critChance', kind: 'flat', value: 0.03 })).toBe(
      '+3% Crit chance',
    );
    expect(
      describeModifier({ stat: 'damage', kind: 'increased', value: 0.2, tags: ['burn'] }),
    ).toBe('20% increased Burn damage');
    expect(describeModifier({ stat: 'damage', kind: 'more', value: 0.1 })).toBe('10% more Damage');
  });

  it('shows Pandemic’s hit cost as a line, which its node text leaves out', () => {
    const pandemic = TALENTS.find((node) => node.id === 'pandemic');
    if (pandemic === undefined) throw new Error('missing pandemic');
    expect(pandemic.modifiers.map(describeModifier)).toEqual(['30% less Hit damage']);
    setLocale('zh-TW');
    expect(pandemic.modifiers.map(describeModifier)).toEqual(['擊中傷害總減 30%']);
  });

  it('names the damage of every tag, each differently, in both locales', () => {
    const poison = { stat: 'damage', kind: 'more', value: 0.3, tags: ['poison'] } as const;
    expect(describeModifier(poison)).toBe('30% more Poison damage');
    const texts = (): Set<string | null> =>
      new Set(
        DAMAGE_TAGS.map((tag) =>
          describeModifier({ stat: 'damage', kind: 'increased', value: 0.1, tags: [tag] }),
        ),
      );
    expect(texts().size).toBe(DAMAGE_TAGS.length);
    expect(texts()).not.toContain(null);
    setLocale('zh-TW');
    expect(describeModifier(poison)).toBe('毒傷害總增 30%');
    expect(texts().size).toBe(DAMAGE_TAGS.length);
  });

  it('leaves behaviour modifiers to the node text', () => {
    expect(
      describeModifier({ stat: 'igniteChance', kind: 'flat', value: 0.3, tags: ['crit'] }),
    ).toBeNull();
    expect(
      describeModifier({
        stat: 'damage',
        kind: 'more',
        value: -0.5,
        tags: ['hit'],
        notTags: ['crit'],
      }),
    ).toBeNull();
    expect(
      describeModifier({
        stat: 'critChance',
        kind: 'flat',
        value: 0.1,
        scaling: { per: 'chainJump' },
      }),
    ).toBeNull();
    expect(describeModifier({ stat: 'igniteAlways', kind: 'flat', value: 1 })).toBeNull();
    // Untagged chances and tagged damage stay plain lines.
    expect(describeModifier({ stat: 'igniteChance', kind: 'flat', value: 0.1 })).toBe(
      '+10% Ignite chance',
    );
  });
});
