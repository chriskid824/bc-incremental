import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import type { EmitterGrant } from '../data/emitters';
import { BASE_STATS, isScopedStat, NO_EXTRAS, SCOPED_STATS, STAT_IDS } from '../data/stats';
import { ModifierSchema } from '../data/schema';
import type { Modifier, StatBlock } from '../data/stats';
import { tagMask } from '../data/tags';
import type { ConversionSpec, TriggerSpec } from '../data/triggers';
import { compileBuild } from '../sim/build/compile';
import { damageRow } from '../sim/testing';
import { createMetaState } from './state';
import {
  collectExtras,
  collectModifiers,
  collectRules,
  computeStatBlock,
  statBlockFor,
} from './stats';
import { FIXTURE_TALENTS, fixtureData, talent } from './testing';

/** The tag masks of M1's four tags (hit, crit, burn, chain). */
const ALL_MASKS = Array.from({ length: 16 }, (_, m) => m);

const block = (modifiers: readonly Modifier[]): StatBlock => computeStatBlock(modifiers, NO_EXTRAS);
const rows = (stats: StatBlock): number[] => ALL_MASKS.map((mask) => damageRow(stats, mask));

describe('computeStatBlock', () => {
  it('returns base stats and unit damage rows with no modifiers', () => {
    const stats = block([]);
    for (const stat of STAT_IDS) expect(stats.values[stat]).toBe(BASE_STATS[stat]);
    expect(stats.base).toBe(BASE_STATS);
    expect(stats.scoped).toEqual([]);
    expect(rows(stats)).toEqual(ALL_MASKS.map(() => 1));
  });

  it('applies flat before multipliers, adds increased and multiplies more', () => {
    const stats = block([
      { stat: 'attackSpeed', kind: 'flat', value: 0.5 },
      { stat: 'attackSpeed', kind: 'increased', value: 0.2 },
      { stat: 'attackSpeed', kind: 'increased', value: 0.3 },
      { stat: 'attackSpeed', kind: 'more', value: 0.5 },
      { stat: 'attackSpeed', kind: 'more', value: 0.1 },
    ]);
    // (base + 0.5) × (1 + 0.2 + 0.3) × 1.5 × 1.1
    expect(stats.values.attackSpeed).toBeCloseTo(
      (BASE_STATS.attackSpeed + 0.5) * 1.5 * 1.5 * 1.1,
      12,
    );
    expect(stats.values.critChance).toBe(BASE_STATS.critChance);
    expect(stats.scoped).toEqual([]);
  });

  it('supports negative more (penalties) and leaves other stats untouched', () => {
    const stats = block([{ stat: 'burnDuration', kind: 'more', value: -0.5 }]);
    expect(stats.values.burnDuration).toBe(BASE_STATS.burnDuration / 2);
    expect(stats.values.maxLife).toBe(100);
  });

  it('keeps only base + flat in values.damage and every damage modifier in scoped', () => {
    const modifiers: Modifier[] = [
      { stat: 'damage', kind: 'flat', value: 5 },
      { stat: 'attackSpeed', kind: 'flat', value: 1 },
      { stat: 'damage', kind: 'increased', value: 0.5 },
      { stat: 'damage', kind: 'more', value: 1, tags: ['burn'] },
      { stat: 'damage', kind: 'more', value: 1 },
    ];
    const stats = block(modifiers);
    expect(stats.values.damage).toBe(15);
    expect(stats.scoped).toEqual([modifiers[0], modifiers[2], modifiers[3], modifiers[4]]);
    // Untagged scaling reaches every mask: (1 + 0.5) × 2, and × 2 again with burn.
    expect(rows(stats)).toEqual(ALL_MASKS.map((m) => (m & tagMask(['burn']) ? 6 : 3)));
  });

  it('applies tagged damage modifiers only to masks containing all their tags', () => {
    const stats = block([
      { stat: 'damage', kind: 'increased', value: 0.5 },
      { stat: 'damage', kind: 'increased', value: 1, tags: ['burn'] },
      { stat: 'damage', kind: 'more', value: 1, tags: ['crit', 'chain'] },
    ]);
    const burn = tagMask(['burn']);
    const critChain = tagMask(['crit', 'chain']);
    for (const m of ALL_MASKS) {
      const increased = 1 + 0.5 + ((m & burn) === burn ? 1 : 0);
      const more = (m & critChain) === critChain ? 2 : 1;
      expect(damageRow(stats, m), `mask ${m}`).toBeCloseTo(increased * more, 12);
    }
    // Spot checks: untagged only, burn only, crit alone, crit+chain, everything.
    expect(damageRow(stats, 0)).toBe(1.5);
    expect(damageRow(stats, tagMask(['burn']))).toBe(2.5);
    expect(damageRow(stats, tagMask(['crit']))).toBe(1.5);
    expect(damageRow(stats, tagMask(['crit', 'chain']))).toBe(3);
    expect(damageRow(stats, tagMask(['hit', 'crit', 'burn', 'chain']))).toBe(5);
  });

  it('applies a damage modifier with notTags only to masks without them', () => {
    const stats = block([{ stat: 'damage', kind: 'more', value: -0.5, notTags: ['crit'] }]);
    expect(damageRow(stats, tagMask(['hit']))).toBe(0.5);
    expect(damageRow(stats, tagMask(['hit', 'chain']))).toBe(0.5);
    expect(damageRow(stats, tagMask(['hit', 'crit']))).toBe(1);
    expect(damageRow(stats, tagMask(['burn', 'crit']))).toBe(1);
  });

  it('treats an empty tag list as untagged', () => {
    const stats = block([
      { stat: 'damage', kind: 'increased', value: 0.25, tags: [] },
      { stat: 'critChance', kind: 'flat', value: 0.1, tags: [] },
    ]);
    expect(rows(stats)).toEqual(ALL_MASKS.map(() => 1.25));
    expect(stats.values.critChance).toBeCloseTo(0.15, 12);
  });

  it('keeps scoped damage modifiers out of values and applies them to center rows', () => {
    const modifiers: Modifier[] = [
      { stat: 'damage', kind: 'more', value: 1, scope: 'center' },
      { stat: 'damage', kind: 'increased', value: 0.5, scope: 'outer.poison' },
      { stat: 'damage', kind: 'flat', value: 2 },
    ];
    const stats = block(modifiers);
    expect(stats.values.damage).toBe(BASE_STATS.damage + 2);
    expect(stats.scoped).toEqual(modifiers);
    // damageRow reads center rows: the center scope applies, the outer one does not.
    expect(rows(stats)).toEqual(ALL_MASKS.map(() => 2));
  });

  it('keeps conditional modifiers out of values', () => {
    const modifiers: Modifier[] = [
      { stat: 'critChance', kind: 'flat', value: 0.2, when: [{ targetHpBelow: 0.5 }] },
      { stat: 'damage', kind: 'more', value: 1, when: [{ targetHas: 'burn' }] },
    ];
    const stats = block(modifiers);
    expect(stats.values.critChance).toBe(BASE_STATS.critChance);
    expect(stats.scoped).toEqual(modifiers);
    // Estimates have no target, so the condition never holds there.
    expect(rows(stats)).toEqual(ALL_MASKS.map(() => 1));
  });

  it('keeps chance modifiers in scoped and only the plain ones in values', () => {
    const modifiers: Modifier[] = [
      { stat: 'critChance', kind: 'flat', value: 0.1 },
      { stat: 'critChance', kind: 'flat', value: 0.1, scaling: { per: 'chainJump' } },
      { stat: 'igniteChance', kind: 'flat', value: 0.3, tags: ['crit'] },
      { stat: 'attackSpeed', kind: 'flat', value: 1 },
      { stat: 'igniteAlways', kind: 'flat', value: 1, tags: ['crit'] },
      { stat: 'critMultiplier', kind: 'flat', value: 0.5 },
    ];
    const stats = block(modifiers);
    expect(stats.values.critChance).toBe(BASE_STATS.critChance + 0.1);
    expect(stats.values.igniteChance).toBe(BASE_STATS.igniteChance);
    expect(stats.values.igniteAlways).toBe(0);
    expect(stats.values.critMultiplier).toBe(BASE_STATS.critMultiplier + 0.5);
    expect(stats.scoped).toEqual(modifiers.filter((mod) => mod.stat !== 'attackSpeed'));
  });

  it('throws on tags, notTags, a scope, conditions or a scaling outside scoped stats and on flat damage', () => {
    const rejected: Modifier[] = [
      { stat: 'projectileCount', kind: 'increased', value: 1, tags: ['crit'] },
      { stat: 'damage', kind: 'flat', value: 5, tags: ['burn'] },
      { stat: 'chainCount', kind: 'flat', value: 0.1, notTags: ['chain'] },
      { stat: 'damage', kind: 'flat', value: 5, notTags: ['burn'] },
      { stat: 'burnDamage', kind: 'flat', value: 0.1, scope: 'outer.crit' },
      { stat: 'damage', kind: 'flat', value: 5, scope: 'center' },
      { stat: 'chainCount', kind: 'flat', value: 0.1, scaling: { per: 'chainJump' } },
      { stat: 'damage', kind: 'flat', value: 5, scaling: { per: 'chainJump' } },
      { stat: 'projectileCount', kind: 'increased', value: 1, when: [{ targetHas: 'burn' }] },
      { stat: 'damage', kind: 'flat', value: 5, when: [{ targetKind: 'boss' }] },
    ];
    for (const mod of rejected) expect(() => block([mod]), JSON.stringify(mod)).toThrow(/Tags/);
  });

  it("appends C6b.1's barrageCount: base 0, unscoped, its flat values summed", () => {
    expect(STAT_IDS.slice(55, 57)).toEqual(['treasureRate', 'barrageCount']);
    expect(BASE_STATS.barrageCount).toBe(0);
    expect(isScopedStat('barrageCount')).toBe(false);
    expect(SCOPED_STATS).toHaveLength(18);
    const stats = block([
      { stat: 'barrageCount', kind: 'flat', value: 2 },
      { stat: 'barrageCount', kind: 'flat', value: 1.5 },
    ]);
    expect(stats.values.barrageCount).toBe(3.5);
    expect(stats.scoped).toEqual([]);
    const tagged = { stat: 'barrageCount', kind: 'flat', value: 1, tags: ['projectile'] } as const;
    expect(() => block([tagged])).toThrow(/Tags/);
  });

  it("appends E1's areaSize and bombRadius after barrageCount: base 1, unscoped multipliers that increased raises and more multiplies", () => {
    expect(STAT_IDS.slice(56, 59)).toEqual(['barrageCount', 'areaSize', 'bombRadius']);
    expect(SCOPED_STATS).toHaveLength(18);
    for (const stat of ['areaSize', 'bombRadius'] as const) {
      expect(BASE_STATS[stat], stat).toBe(1);
      expect(isScopedStat(stat), stat).toBe(false);
      expect(block([]).values[stat], stat).toBe(1);
      // (1 + 0.2 + 0.3) × 1.5: the 範圍 and 爆炸半徑 ranks are increased, a ★ may be more.
      const stats = block([
        { stat, kind: 'increased', value: 0.2 },
        { stat, kind: 'increased', value: 0.3 },
        { stat, kind: 'more', value: 0.5 },
      ]);
      expect(stats.values[stat], stat).toBeCloseTo(2.25, 12);
      expect(stats.scoped).toEqual([]);
      const tagged = { stat, kind: 'increased', value: 0.2, tags: ['area'] } as const;
      expect(() => block([tagged]), stat).toThrow(/Tags/);
      const scoped = { stat, kind: 'increased', value: 0.2, scope: 'hub' } as const;
      expect(() => block([scoped]), stat).toThrow(/Tags/);
    }
  });

  it("appends E3's spreadRadius after bombRadius: base 1, an unscoped multiplier that increased raises and more multiplies", () => {
    expect(STAT_IDS.slice(58, 60)).toEqual(['bombRadius', 'spreadRadius']);
    expect(SCOPED_STATS).toHaveLength(18);
    expect(BASE_STATS.spreadRadius).toBe(1);
    expect(isScopedStat('spreadRadius')).toBe(false);
    expect(block([]).values.spreadRadius).toBe(1);
    // (1 + 0.2 + 0.3) × 1.5: the 擴散距離 ranks are increased, a ★ may be more.
    const stats = block([
      { stat: 'spreadRadius', kind: 'increased', value: 0.2 },
      { stat: 'spreadRadius', kind: 'increased', value: 0.3 },
      { stat: 'spreadRadius', kind: 'more', value: 0.5 },
    ]);
    expect(stats.values.spreadRadius).toBeCloseTo(2.25, 12);
    expect(stats.scoped).toEqual([]);
    const tagged = { stat: 'spreadRadius', kind: 'increased', value: 0.2, tags: ['area'] } as const;
    expect(() => block([tagged])).toThrow(/Tags/);
    const scoped = { stat: 'spreadRadius', kind: 'increased', value: 0.2, scope: 'hub' } as const;
    expect(() => block([scoped])).toThrow(/Tags/);
  });

  it("appends C5.9's droneSpeed after spreadRadius: base 1, an unscoped multiplier that increased raises and more multiplies", () => {
    expect(STAT_IDS.slice(59, 61)).toEqual(['spreadRadius', 'droneSpeed']);
    expect(SCOPED_STATS).toHaveLength(18);
    expect(BASE_STATS.droneSpeed).toBe(1);
    expect(isScopedStat('droneSpeed')).toBe(false);
    expect(block([]).values.droneSpeed).toBe(1);
    // (1 + 0.25 + 0.25) × 1.2: 機隊's 「無人機傷害、速度」 ranks are increased, a ★ may be more.
    const stats = block([
      { stat: 'droneSpeed', kind: 'increased', value: 0.25 },
      { stat: 'droneSpeed', kind: 'increased', value: 0.25 },
      { stat: 'droneSpeed', kind: 'more', value: 0.2 },
    ]);
    expect(stats.values.droneSpeed).toBeCloseTo(1.8, 12);
    expect(stats.scoped).toEqual([]);
    // A penalty may take it below 0; the drone pool's fill clamps it there (drone.ts).
    expect(
      block([{ stat: 'droneSpeed', kind: 'increased', value: -1.5 }]).values.droneSpeed,
    ).toBeCloseTo(-0.5, 12);
    const tagged = { stat: 'droneSpeed', kind: 'increased', value: 0.2, tags: ['minion'] } as const;
    expect(() => block([tagged])).toThrow(/Tags/);
    const scoped = { stat: 'droneSpeed', kind: 'increased', value: 0.2, scope: 'hub' } as const;
    expect(() => block([scoped])).toThrow(/Tags/);
    const when = {
      stat: 'droneSpeed',
      kind: 'increased',
      value: 0.2,
      when: [{ targetKind: 'elite' }],
    } as const;
    expect(() => block([when])).toThrow(/Tags/);
  });

  it("appends E4's summonDuration: 62nd, base 1, an unscoped multiplier that increased raises and more multiplies", () => {
    expect(STAT_IDS.indexOf('summonDuration')).toBe(61);
    expect(STAT_IDS.slice(60, 62)).toEqual(['droneSpeed', 'summonDuration']);
    expect(SCOPED_STATS).toHaveLength(18);
    expect(BASE_STATS.summonDuration).toBe(1);
    expect(isScopedStat('summonDuration')).toBe(false);
    expect(block([]).values.summonDuration).toBe(1);
    // (1 + 0.25 + 0.25) × 1.2: ◆蜂王漿's +50% is increased, and other sources may be more.
    const stats = block([
      { stat: 'summonDuration', kind: 'increased', value: 0.25 },
      { stat: 'summonDuration', kind: 'increased', value: 0.25 },
      { stat: 'summonDuration', kind: 'more', value: 0.2 },
    ]);
    expect(stats.values.summonDuration).toBeCloseTo(1.8, 12);
    expect(stats.scoped).toEqual([]);
    // A penalty may take it below 0; the spawn specs' fill clamps it there (drone.ts).
    expect(
      block([{ stat: 'summonDuration', kind: 'increased', value: -1.5 }]).values.summonDuration,
    ).toBeCloseTo(-0.5, 12);
    const tagged = {
      stat: 'summonDuration',
      kind: 'increased',
      value: 0.2,
      tags: ['minion'],
    } as const;
    expect(() => block([tagged])).toThrow(/Tags/);
    const scoped = { stat: 'summonDuration', kind: 'increased', value: 0.2, scope: 'hub' } as const;
    expect(() => block([scoped])).toThrow(/Tags/);
    const when = {
      stat: 'summonDuration',
      kind: 'increased',
      value: 0.2,
      when: [{ targetKind: 'elite' }],
    } as const;
    expect(() => block([when])).toThrow(/Tags/);
  });

  it("appends E10a's barragePierce: the 63rd, base 0, an unscoped count that flat adds to", () => {
    expect(STAT_IDS.slice(61, 63)).toEqual(['summonDuration', 'barragePierce']);
    expect(SCOPED_STATS).toHaveLength(18);
    expect(BASE_STATS.barragePierce).toBe(0);
    expect(isScopedStat('barragePierce')).toBe(false);
    expect(block([]).values.barragePierce).toBe(0);
    // 分裂's ranks: flat pierce, whose whole part the rider reads (compileBarrage).
    const stats = block([
      { stat: 'barragePierce', kind: 'flat', value: 1 },
      { stat: 'barragePierce', kind: 'flat', value: 1.5 },
    ]);
    expect(stats.values.barragePierce).toBe(2.5);
    expect(stats.scoped).toEqual([]);
    const tagged = {
      stat: 'barragePierce',
      kind: 'flat',
      value: 1,
      tags: ['projectile'],
    } as const;
    expect(() => block([tagged])).toThrow(/Tags/);
    const scoped = {
      stat: 'barragePierce',
      kind: 'flat',
      value: 1,
      scope: 'outer.barrage',
    } as const;
    expect(() => block([scoped])).toThrow(/Tags/);
  });

  it("appends E10b's barrageSplit: the 64th, base 0, an unscoped chance that flat adds to", () => {
    expect(STAT_IDS.slice(62, 64)).toEqual(['barragePierce', 'barrageSplit']);
    expect(SCOPED_STATS).toHaveLength(18);
    expect(BASE_STATS.barrageSplit).toBe(0);
    expect(isScopedStat('barrageSplit')).toBe(false);
    expect(block([]).values.barrageSplit).toBe(0);
    // 分裂's ranks under A19 (a): flat chance, which compileBarrage adds to the split's own.
    const stats = block([
      { stat: 'barrageSplit', kind: 'flat', value: 0.1 },
      { stat: 'barrageSplit', kind: 'flat', value: 0.15 },
    ]);
    expect(stats.values.barrageSplit).toBeCloseTo(0.25, 12);
    expect(stats.scoped).toEqual([]);
    const tagged = {
      stat: 'barrageSplit',
      kind: 'flat',
      value: 0.1,
      tags: ['projectile'],
    } as const;
    expect(() => block([tagged])).toThrow(/Tags/);
    const scoped = {
      stat: 'barrageSplit',
      kind: 'flat',
      value: 0.1,
      scope: 'outer.barrage',
    } as const;
    expect(() => block([scoped])).toThrow(/Tags/);
    // And at load: the modifier schema refuses either, and takes the plain flat chance.
    expect(ModifierSchema.safeParse(tagged).success).toBe(false);
    expect(ModifierSchema.safeParse(scoped).success).toBe(false);
    const flat = { stat: 'barrageSplit', kind: 'flat', value: 0.1 };
    expect(ModifierSchema.safeParse(flat).success).toBe(true);
  });

  it("appends E14's comboCap: the 65th, base 20, an unscoped count that flat adds to", () => {
    expect(STAT_IDS.slice(63, 65)).toEqual(['barrageSplit', 'comboCap']);
    expect(SCOPED_STATS).toHaveLength(18);
    expect(BASE_STATS.comboCap).toBe(20);
    expect(isScopedStat('comboCap')).toBe(false);
    expect(block([]).values.comboCap).toBe(20);
    // 動能's 層數上限 ranks: flat stacks on the base 20, which compileBuild folds into the cap.
    const stats = block([
      { stat: 'comboCap', kind: 'flat', value: 2 },
      { stat: 'comboCap', kind: 'flat', value: 3 },
    ]);
    expect(stats.values.comboCap).toBe(25);
    expect(stats.scoped).toEqual([]);
    expect(compileBuild(stats, []).flags.comboCap).toBe(25);
    // Plants comboCap's tags, notTags or scope taken: refused by computeStatBlock, and at load
    // by the modifier schema, on their fields, as barrageSplit's are.
    const bad = [
      { stat: 'comboCap', kind: 'flat', value: 2, tags: ['hit'] },
      { stat: 'comboCap', kind: 'flat', value: 2, notTags: ['crit'] },
      { stat: 'comboCap', kind: 'flat', value: 2, scope: 'outer.combo' },
    ] as const satisfies readonly Modifier[];
    for (const mod of bad) {
      expect(() => block([mod])).toThrow(
        'Tags, scopes, conditions and scalings are only allowed on scoped stats, not flat ' +
          `damage: ${JSON.stringify(mod)}`,
      );
    }
    expect(
      bad.map((mod) => ModifierSchema.safeParse(mod).error?.issues.map((i) => i.message)),
    ).toEqual([
      ['tags are only allowed on scoped stats, and not on flat damage'],
      ['notTags are only allowed on scoped stats, and not on flat damage'],
      ['scope is only allowed on scoped stats, and not on flat damage'],
    ]);
    expect(ModifierSchema.safeParse({ stat: 'comboCap', kind: 'flat', value: 2 }).success).toBe(
      true,
    );
    // And a module's addModifier, which takes scoped stats alone.
    expect(() =>
      compileBuild(block([]), [], undefined, [
        (b) => {
          b.addModifier({ stat: 'comboCap', kind: 'flat', value: 2, tags: ['hit'] });
        },
      ]),
    ).toThrow('is not a scoped stat; use scaleStat or offsetStat');
  });

  it("appends E15's orbitSpeed: the 66th, base 1, an unscoped multiplier that increased adds to", () => {
    expect(STAT_IDS.slice(64, 66)).toEqual(['comboCap', 'orbitSpeed']);
    expect(SCOPED_STATS).toHaveLength(18);
    expect(BASE_STATS.orbitSpeed).toBe(1);
    expect(isScopedStat('orbitSpeed')).toBe(false);
    expect(block([]).values.orbitSpeed).toBe(1);
    // 環繞's 轉速 ranks: increased on the base 1, which compileBuild folds into every orbit's
    // revPerSec (src/sim/emitters/orbit.test.ts pins the fold and its clamp).
    const stats = block([
      { stat: 'orbitSpeed', kind: 'increased', value: 0.15 },
      { stat: 'orbitSpeed', kind: 'increased', value: 0.3 },
    ]);
    expect(stats.values.orbitSpeed).toBeCloseTo(1.45, 12);
    expect(stats.scoped).toEqual([]);
    // Plants orbitSpeed's tags, notTags or scope taken: refused by computeStatBlock, and at load
    // by the modifier schema, on their fields, as comboCap's are.
    const bad = [
      { stat: 'orbitSpeed', kind: 'increased', value: 0.15, tags: ['orbit'] },
      { stat: 'orbitSpeed', kind: 'increased', value: 0.15, notTags: ['aura'] },
      { stat: 'orbitSpeed', kind: 'increased', value: 0.15, scope: 'outer.aura' },
    ] as const satisfies readonly Modifier[];
    for (const mod of bad) {
      expect(() => block([mod])).toThrow(
        'Tags, scopes, conditions and scalings are only allowed on scoped stats, not flat ' +
          `damage: ${JSON.stringify(mod)}`,
      );
    }
    expect(
      bad.map((mod) => ModifierSchema.safeParse(mod).error?.issues.map((i) => i.message)),
    ).toEqual([
      ['tags are only allowed on scoped stats, and not on flat damage'],
      ['notTags are only allowed on scoped stats, and not on flat damage'],
      ['scope is only allowed on scoped stats, and not on flat damage'],
    ]);
    expect(
      ModifierSchema.safeParse({ stat: 'orbitSpeed', kind: 'increased', value: 0.15 }).success,
    ).toBe(true);
    // And a module's addModifier, which takes scoped stats alone.
    expect(() =>
      compileBuild(block([]), [], undefined, [
        (b) => {
          b.addModifier({ stat: 'orbitSpeed', kind: 'increased', value: 0.15, tags: ['orbit'] });
        },
      ]),
    ).toThrow('is not a scoped stat; use scaleStat or offsetStat');
  });

  it("appends E16's thornsArea: the 67th, base 1, an unscoped multiplier that increased adds to", () => {
    expect(STAT_IDS.slice(65, 67)).toEqual(['orbitSpeed', 'thornsArea']);
    expect(SCOPED_STATS).toHaveLength(18);
    expect(BASE_STATS.thornsArea).toBe(1);
    expect(isScopedStat('thornsArea')).toBe(false);
    expect(block([]).values.thornsArea).toBe(1);
    // 尖刺's 荊棘範圍 ranks: increased on the base 1, which compileBuild reads into
    // BuildFlags.thornsFactor (src/sim/build/thornsArea.test.ts pins what it reaches).
    const stats = block([
      { stat: 'thornsArea', kind: 'increased', value: 0.15 },
      { stat: 'thornsArea', kind: 'increased', value: 0.15 },
    ]);
    expect(stats.values.thornsArea).toBeCloseTo(1.3, 12);
    expect(stats.scoped).toEqual([]);
    // Plants thornsArea's tags, notTags or scope taken: refused by computeStatBlock, and at load
    // by the modifier schema, on their fields, as orbitSpeed's are.
    const bad = [
      { stat: 'thornsArea', kind: 'increased', value: 0.15, tags: ['thorns'] },
      { stat: 'thornsArea', kind: 'increased', value: 0.15, notTags: ['strike'] },
      { stat: 'thornsArea', kind: 'increased', value: 0.15, scope: 'outer.thorns' },
    ] as const satisfies readonly Modifier[];
    for (const mod of bad) {
      expect(() => block([mod])).toThrow(
        'Tags, scopes, conditions and scalings are only allowed on scoped stats, not flat ' +
          `damage: ${JSON.stringify(mod)}`,
      );
    }
    expect(
      bad.map((mod) => ModifierSchema.safeParse(mod).error?.issues.map((i) => i.message)),
    ).toEqual([
      ['tags are only allowed on scoped stats, and not on flat damage'],
      ['notTags are only allowed on scoped stats, and not on flat damage'],
      ['scope is only allowed on scoped stats, and not on flat damage'],
    ]);
    expect(
      ModifierSchema.safeParse({ stat: 'thornsArea', kind: 'increased', value: 0.15 }).success,
    ).toBe(true);
    // And a module's addModifier, which takes scoped stats alone.
    expect(() =>
      compileBuild(block([]), [], undefined, [
        (b) => {
          b.addModifier({ stat: 'thornsArea', kind: 'increased', value: 0.3, tags: ['thorns'] });
        },
      ]),
    ).toThrow('is not a scoped stat; use scaleStat or offsetStat');
  });

  it("appends E17's walletWeight: the 68th, base 1, an unscoped weight that flat adds to", () => {
    expect(STAT_IDS.slice(66, 68)).toEqual(['thornsArea', 'walletWeight']);
    expect(SCOPED_STATS).toHaveLength(18);
    expect(BASE_STATS.walletWeight).toBe(1);
    expect(isScopedStat('walletWeight')).toBe(false);
    expect(block([]).values.walletWeight).toBe(1);
    // ◆金庫's 「錢包碎片算 1.5 倍」: flat 0.5 on the base 1, which the run reads once
    // (weighWallet, src/sim/systems/walletWeight.test.ts pins the read).
    const stats = block([{ stat: 'walletWeight', kind: 'flat', value: 0.5 }]);
    expect(stats.values.walletWeight).toBe(1.5);
    expect(stats.scoped).toEqual([]);
    expect(compileBuild(stats, []).values.walletWeight).toBe(1.5);
    // Plants walletWeight's tags, notTags or scope taken: refused by computeStatBlock, and at
    // load by the modifier schema, on their fields, as orbitSpeed's are.
    const bad = [
      { stat: 'walletWeight', kind: 'flat', value: 0.5, tags: ['hit'] },
      { stat: 'walletWeight', kind: 'flat', value: 0.5, notTags: ['crit'] },
      { stat: 'walletWeight', kind: 'flat', value: 0.5, scope: 'outer.greed' },
    ] as const satisfies readonly Modifier[];
    for (const mod of bad) {
      expect(() => block([mod])).toThrow(
        'Tags, scopes, conditions and scalings are only allowed on scoped stats, not flat ' +
          `damage: ${JSON.stringify(mod)}`,
      );
    }
    expect(
      bad.map((mod) => ModifierSchema.safeParse(mod).error?.issues.map((i) => i.message)),
    ).toEqual([
      ['tags are only allowed on scoped stats, and not on flat damage'],
      ['notTags are only allowed on scoped stats, and not on flat damage'],
      ['scope is only allowed on scoped stats, and not on flat damage'],
    ]);
    expect(
      ModifierSchema.safeParse({ stat: 'walletWeight', kind: 'flat', value: 0.5 }).success,
    ).toBe(true);
    // And a module's addModifier, which takes scoped stats alone.
    expect(() =>
      compileBuild(block([]), [], undefined, [
        (b) => {
          b.addModifier({ stat: 'walletWeight', kind: 'flat', value: 0.5, scope: 'outer.greed' });
        },
      ]),
    ).toThrow('is not a scoped stat; use scaleStat or offsetStat');
  });

  it("appends E17's interestRate and bonusWaveInterest: the 69th and 70th, bases 0 and 1, unscoped, flat adds to them", () => {
    expect(STAT_IDS.slice(68, 70)).toEqual(['interestRate', 'bonusWaveInterest']);
    expect(SCOPED_STATS).toHaveLength(18);
    expect(BASE_STATS.interestRate).toBe(0);
    expect(BASE_STATS.bonusWaveInterest).toBe(1);
    expect(isScopedStat('interestRate')).toBe(false);
    expect(isScopedStat('bonusWaveInterest')).toBe(false);
    expect(block([]).values.interestRate).toBe(0);
    expect(block([]).values.bonusWaveInterest).toBe(1);
    // 利率 1% and ◆獎勵波's 「×3」: flat 0.01 on 0 and flat 2 on 1, which the payout reads from the
    // compile's values (src/sim/effects/interest.test.ts pins the read).
    const stats = block([
      { stat: 'interestRate', kind: 'flat', value: 0.01 },
      { stat: 'bonusWaveInterest', kind: 'flat', value: 2 },
    ]);
    expect(stats.values.interestRate).toBe(0.01);
    expect(stats.values.bonusWaveInterest).toBe(3);
    expect(stats.scoped).toEqual([]);
    expect(compileBuild(stats, []).values.interestRate).toBe(0.01);
    expect(compileBuild(stats, []).values.bonusWaveInterest).toBe(3);
    // Plants either stat's tags, notTags, scope, conditions or scaling taken: refused by
    // computeStatBlock (and so at compile, which takes its block), and at load by the modifier
    // schema, on their fields, as walletWeight's are.
    for (const stat of ['interestRate', 'bonusWaveInterest'] as const) {
      const bad = [
        { stat, kind: 'flat', value: 0.5, tags: ['hit'] },
        { stat, kind: 'flat', value: 0.5, notTags: ['crit'] },
        { stat, kind: 'flat', value: 0.5, scope: 'outer.greed' },
        { stat, kind: 'flat', value: 0.5, when: [{ targetKind: 'boss' }] },
        { stat, kind: 'flat', value: 0.5, scaling: { per: 'shardsHeld', curve: 'log10' } },
      ] as const satisfies readonly Modifier[];
      for (const mod of bad) {
        expect(() => block([mod])).toThrow(
          'Tags, scopes, conditions and scalings are only allowed on scoped stats, not flat ' +
            `damage: ${JSON.stringify(mod)}`,
        );
      }
      expect(
        bad.map((mod) => ModifierSchema.safeParse(mod).error?.issues.map((i) => i.message)),
      ).toEqual([
        ['tags are only allowed on scoped stats, and not on flat damage'],
        ['notTags are only allowed on scoped stats, and not on flat damage'],
        ['scope is only allowed on scoped stats, and not on flat damage'],
        ['conditions are only allowed on scoped stats, and not on flat damage'],
        ['scaling is only allowed on scoped stats, and not on flat damage'],
      ]);
      expect(ModifierSchema.safeParse({ stat, kind: 'flat', value: 0.5 }).success).toBe(true);
      // And a module's addModifier, which takes scoped stats alone.
      const added = { stat, kind: 'flat', value: 0.5, scope: 'outer.greed' } as const;
      expect(() =>
        compileBuild(block([]), [], undefined, [
          (b) => {
            b.addModifier(added);
          },
        ]),
      ).toThrow(
        `addModifier: ${JSON.stringify(added)} is not a scoped stat; use scaleStat or offsetStat`,
      );
    }
  });

  it("appends E17's shardExponent: last of 71, base 1, an unscoped factor that more multiplies", () => {
    expect(STAT_IDS).toHaveLength(71);
    expect(STAT_IDS.slice(-2)).toEqual(['bonusWaveInterest', 'shardExponent']);
    expect(SCOPED_STATS).toHaveLength(18);
    expect(BASE_STATS.shardExponent).toBe(1);
    expect(isScopedStat('shardExponent')).toBe(false);
    expect(block([]).values.shardExponent).toBe(1);
    // ★守財奴's 「持有碎片加成的指數 ×1.5」: more 0.5 on the base 1, which compileBuild reads once
    // (src/sim/build/shardExponent.test.ts pins what it reaches).
    const stats = block([{ stat: 'shardExponent', kind: 'more', value: 0.5 }]);
    expect(stats.values.shardExponent).toBe(1.5);
    expect(stats.scoped).toEqual([]);
    expect(compileBuild(stats, []).values.shardExponent).toBe(1.5);
    // Plants the factor read from StatBlock.base, BASE_STATS's 1 in a block meta builds: 錢包's
    // 0.06 compiles to 0.09 beside ★守財奴's more.
    const held: Modifier = {
      stat: 'damage',
      kind: 'more',
      value: 1,
      scaling: { per: 'shardsHeld', curve: 'powFactor', exponent: 0.06 },
    };
    const miser = block([held, { stat: 'shardExponent', kind: 'more', value: 0.5 }]);
    expect(miser.base.shardExponent).toBe(1);
    expect(compileBuild(miser, []).mods.map((mod) => mod.scale?.exponent)).toEqual([0.09]);
    expect(compileBuild(block([held]), []).mods.map((mod) => mod.scale?.exponent)).toEqual([0.06]);
    // Plants shardExponent's tags, notTags, scope, conditions or scaling taken: refused by
    // computeStatBlock, at load by the modifier schema on their fields, and by compileBuild,
    // whose rows take scoped stats alone.
    const bad = [
      { stat: 'shardExponent', kind: 'more', value: 0.5, tags: ['hit'] },
      { stat: 'shardExponent', kind: 'more', value: 0.5, notTags: ['crit'] },
      { stat: 'shardExponent', kind: 'more', value: 0.5, scope: 'outer.greed' },
      { stat: 'shardExponent', kind: 'more', value: 0.5, when: [{ targetKind: 'boss' }] },
      { stat: 'shardExponent', kind: 'more', value: 0.5, scaling: { per: 'shardsHeld' } },
    ] as const satisfies readonly Modifier[];
    for (const mod of bad) {
      expect(() => block([mod])).toThrow(
        'Tags, scopes, conditions and scalings are only allowed on scoped stats, not flat ' +
          `damage: ${JSON.stringify(mod)}`,
      );
      expect(() => compileBuild({ ...block([]), scoped: [mod] }, [])).toThrow(
        `Not a scoped stat: ${JSON.stringify(mod)}`,
      );
    }
    expect(
      bad.map((mod) => ModifierSchema.safeParse(mod).error?.issues.map((i) => i.message)),
    ).toEqual([
      ['tags are only allowed on scoped stats, and not on flat damage'],
      ['notTags are only allowed on scoped stats, and not on flat damage'],
      ['scope is only allowed on scoped stats, and not on flat damage'],
      ['conditions are only allowed on scoped stats, and not on flat damage'],
      ['scaling is only allowed on scoped stats, and not on flat damage'],
    ]);
    expect(
      ModifierSchema.safeParse({ stat: 'shardExponent', kind: 'more', value: 0.5 }).success,
    ).toBe(true);
    // And a module's addModifier, which takes scoped stats alone, with a scaling as without.
    for (const mod of [bad[0], bad[4]]) {
      expect(() =>
        compileBuild(block([]), [], undefined, [
          (b) => {
            b.addModifier(mod);
          },
        ]),
      ).toThrow('is not a scoped stat; use scaleStat or offsetStat');
    }
  });

  it('passes the triggers and conversions through', () => {
    const stats = computeStatBlock([], NO_EXTRAS);
    expect(stats.triggers).toBe(NO_EXTRAS.triggers);
    expect(stats.conversions).toBe(NO_EXTRAS.conversions);
  });
});

describe('collectModifiers / collectRules', () => {
  const data = fixtureData();

  it('includes only the start node on a fresh profile', () => {
    const meta = createMetaState();
    expect(collectModifiers(meta, data)).toEqual([{ stat: 'maxLife', kind: 'flat', value: 20 }]);
    expect(collectRules(meta, data)).toEqual([]);
    expect(statBlockFor(meta, data).values.maxLife).toBe(120);
  });

  it('includes allocated nodes once and their rules', () => {
    const meta = createMetaState();
    for (const id of ['a', 'a2', 'k']) meta.allocated.add(id);
    expect(collectModifiers(meta, data)).toEqual([
      { stat: 'maxLife', kind: 'flat', value: 20 },
      { stat: 'damage', kind: 'increased', value: 0.1 },
      { stat: 'critChance', kind: 'flat', value: 0.05 },
    ]);
    expect(collectRules(meta, data)).toEqual([{ id: 'glassCannon', damageMore: 1 }]);
  });

  it('repeats repeatable modifiers per rank so more multipliers stack', () => {
    const meta = createMetaState();
    meta.allocated.add('r');
    meta.ranks.set('r', 3);
    const repeated = collectModifiers(meta, data).filter((m) => m.stat === 'damage');
    expect(repeated).toHaveLength(3);
    const stats = statBlockFor(meta, data);
    expect(stats.scoped).toEqual(repeated);
    for (const m of ALL_MASKS) expect(damageRow(stats, m)).toBeCloseTo(1.1 ** 3, 12);
  });

  it('keeps the scoped modifiers in data order, ranks repeated, apart from the values', () => {
    const meta = createMetaState();
    for (const id of ['r', 'far', 'a']) meta.allocated.add(id);
    meta.ranks.set('r', 2);
    const stats = statBlockFor(meta, data);
    expect(stats.scoped).toEqual([
      { stat: 'damage', kind: 'increased', value: 0.1 },
      { stat: 'damage', kind: 'flat', value: 3 },
      { stat: 'damage', kind: 'more', value: 0.1 },
      { stat: 'damage', kind: 'more', value: 0.1 },
    ]);
    expect(stats.values.damage).toBe(BASE_STATS.damage + 3);
    expect(stats.values.maxLife).toBe(120);
    expect(damageRow(stats, 0)).toBe(1.1 * 1.1 * 1.1);
  });

  it('does not depend on allocation order', () => {
    const first = createMetaState();
    const second = createMetaState();
    for (const id of ['a', 'b', 'a2']) first.allocated.add(id);
    for (const id of ['a2', 'b', 'a']) second.allocated.add(id);
    expect(collectModifiers(first, data)).toEqual(collectModifiers(second, data));
  });
});

describe('collectExtras', () => {
  const explode: TriggerSpec = {
    on: 'kill',
    do: [{ kind: 'explode', radius: 90, damagePct: 0.5 }],
  };
  const heal: TriggerSpec = { on: 'waveStart', do: [{ kind: 'heal', lifePct: 0.1 }] };
  const shards: TriggerSpec = { on: 'kill', do: [{ kind: 'gainShards', fraction: 0.2 }] };
  const toPoison: ConversionSpec = { to: 'poison', fraction: 0.3 };
  const dronesToBleed: ConversionSpec = { tags: ['minion'], to: 'bleed', fraction: 0.1 };
  const data = fixtureData({
    talents: [
      ...FIXTURE_TALENTS,
      talent('outer.fire.burst', 'small', ['start'], { triggers: [explode, heal] }),
      talent('hub.loot', 'repeatable', ['start'], {
        repeat: { baseShards: 10, growth: 2 },
        triggers: [shards],
        conversions: [dronesToBleed],
      }),
      talent('outer.poison.venom', 'notable', ['start'], { conversions: [toPoison] }),
      talent('unbought', 'small', ['start'], { triggers: [heal], conversions: [toPoison] }),
    ],
  });

  it('has no triggers on a fresh profile', () => {
    expect(collectExtras(createMetaState(), data)).toEqual({
      triggers: [],
      conversions: [],
      emitters: [],
    });
  });

  it('lists the triggers in data order, ranks repeated, with their node source', () => {
    const meta = createMetaState();
    for (const id of ['hub.loot', 'outer.fire.burst', 'a']) meta.allocated.add(id);
    meta.ranks.set('hub.loot', 2);
    const extras = collectExtras(meta, data);
    expect(extras.triggers).toEqual([
      { source: 'outer.fire', spec: explode },
      { source: 'outer.fire', spec: heal },
      { source: 'hub', spec: shards },
      { source: 'hub', spec: shards },
    ]);
    expect(extras.conversions).toEqual([
      { source: 'hub', spec: dronesToBleed },
      { source: 'hub', spec: dronesToBleed },
    ]);
  });

  it('lists the conversions in data order, ranks repeated, with their node source', () => {
    const meta = createMetaState();
    for (const id of ['outer.poison.venom', 'hub.loot']) meta.allocated.add(id);
    meta.ranks.set('hub.loot', 3);
    const extras = collectExtras(meta, data);
    expect(extras.conversions).toEqual([
      { source: 'hub', spec: dronesToBleed },
      { source: 'hub', spec: dronesToBleed },
      { source: 'hub', spec: dronesToBleed },
      { source: 'outer.poison', spec: toPoison },
    ]);
    expect(extras.triggers).toEqual([
      { source: 'hub', spec: shards },
      { source: 'hub', spec: shards },
      { source: 'hub', spec: shards },
    ]);
  });

  it('reaches the stat block and leaves the values unchanged', () => {
    const meta = createMetaState();
    meta.allocated.add('outer.fire.burst');
    meta.allocated.add('outer.poison.venom');
    const stats = statBlockFor(meta, data);
    expect(stats.triggers).toEqual([
      { source: 'outer.fire', spec: explode },
      { source: 'outer.fire', spec: heal },
    ]);
    expect(stats.conversions).toEqual([{ source: 'outer.poison', spec: toPoison }]);
    expect(stats.values).toEqual(statBlockFor(createMetaState(), data).values);
    expect(stats.scoped).toEqual([]);
  });
});

describe('emitter grants', () => {
  const spikes: EmitterGrant = { kind: 'thorns' };
  const spines: EmitterGrant = { kind: 'thorns', damagePct: 2 };
  const shards: TriggerSpec = { on: 'kill', do: [{ kind: 'gainShards', fraction: 0.2 }] };
  const data = fixtureData({
    talents: [
      ...FIXTURE_TALENTS,
      talent('outer.thorns.spikes', 'small', ['start'], { emitters: [spikes] }),
      talent('hub.spines', 'repeatable', ['start'], {
        repeat: { baseShards: 10, growth: 2 },
        triggers: [shards],
        emitters: [spines],
      }),
      talent('unbought', 'small', ['start'], { emitters: [spikes] }),
    ],
  });

  it("lists each allocated node's grants once, whatever its rank, in data order", () => {
    const meta = createMetaState();
    for (const id of ['hub.spines', 'outer.thorns.spikes']) meta.allocated.add(id);
    meta.ranks.set('hub.spines', 3);
    const extras = collectExtras(meta, data);
    expect(extras.emitters).toEqual([
      { source: 'outer.thorns', grant: spikes },
      { source: 'hub', grant: spines },
    ]);
    // The node's triggers still repeat per rank.
    expect(extras.triggers).toHaveLength(3);
  });

  it('carries a grant-only node into the stat block and the build (R6)', () => {
    const meta = createMetaState();
    meta.allocated.add('outer.thorns.spikes');
    const stats = statBlockFor(meta, data);
    expect(stats.emitters).toEqual([{ source: 'outer.thorns', grant: spikes }]);
    expect(stats.triggers).toEqual([]);
    expect(stats.conversions).toEqual([]);
    expect(stats.values).toEqual(statBlockFor(createMetaState(), data).values);
    const emitters = compileBuild(stats, []).emitters;
    expect(emitters.map((em) => [em.kind, em.source, em.damagePct])).toEqual([
      ['volley', 'center', 1],
      ['thorns', 'outer.thorns', 3],
    ]);
  });

  it('finds none in the M1 content, so its builds and saves are unchanged', () => {
    const content = loadGameData();
    expect(content.talents.filter((node) => node.emitters.length > 0)).toEqual([]);
    const meta = createMetaState();
    for (const node of content.talents) meta.allocated.add(node.id);
    expect(statBlockFor(meta, content).emitters).toEqual([]);
  });
});
