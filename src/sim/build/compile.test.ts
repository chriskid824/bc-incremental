import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import { THORNS_DAMAGE_PCT } from '../../data/emitters';
import type { EmitterGrant } from '../../data/emitters';
import { M1_SIGNATURE } from '../../data/rules';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import { SCOPED_STATS } from '../../data/stats';
import type { Modifier } from '../../data/stats';
import { TAG } from '../../data/tags';
import { SHATTER_TRIGGER, shatterTrigger } from '../effects/types';
import {
  emitterPayload,
  SLOT_HIT,
  SLOT_HIT_CRIT,
  SLOT_JUMP,
  SLOT_JUMP_CRIT,
  slotRow,
} from '../emitters/types';
import type { EmitterRuntime, EmitterSpec } from '../emitters/types';
import type { TestModule } from '../rules';
import { damageRow, makeStats, maskProbeMods, placedEnemies } from '../testing';
import { centerDamage, centerStat, compileBuild, keyedStat, signatureRows } from './compile';
import type { CompiledBuild } from './compile';
import { modTableFor, SCOPED_INDEX } from './modTable';
import { CENTER, rowKey } from './sources';

const S = SCOPED_STATS.length;
const { critChance: CRIT_CHANCE, critMultiplier: CRIT_MULTIPLIER, damage: DAMAGE } = SCOPED_INDEX;

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
      frostImmuneTicks: 180,
      bossLockTicks: 252,
      bossMinGapTicks: 0,
      globalSlow: 0,
      shatterMult: 1,
    });
    expect(build.signature).toEqual({
      forceCritEvery: 0,
      counts: 'shot',
      id: 'm1Volley',
      lob: null,
      fan: null,
      arc: null,
    });
    expect(build.hooks).toEqual({
      tick: [],
      onKill: [],
      onAttack: [],
      onHit: [],
      modifyDamage: [],
      onCenterEvent: [],
    });
    // Only the shatter's entry, which cannot freeze and so listens to nothing.
    expect(build.triggers).toEqual([shatterTrigger(false, 0)]);
    expect(build.triggers[SHATTER_TRIGGER]?.on).toBe(-1);
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

  it('puts the emitter grants after the signature, the first of each kind, source and key', () => {
    const thorns = (damagePct?: number): EmitterGrant =>
      damagePct === undefined ? { kind: 'thorns' } : { kind: 'thorns', damagePct };
    const stats = makeStats({}, [], {
      triggers: [],
      conversions: [],
      emitters: [
        { source: 'outer.thorns', grant: thorns(2) },
        { source: 'center', grant: thorns() },
        { source: 'outer.thorns', grant: thorns(5) },
      ],
    });
    const build = compileWith(stats, (b) => {
      b.addEmitter('hub', thorns(7));
      b.addEmitter('center', thorns(9));
    });
    expect(build.emitters.map((em) => [em.kind, em.source, em.damagePct])).toEqual([
      ['volley', 'center', 1],
      ['thorns', 'outer.thorns', 2],
      ['thorns', 'center', THORNS_DAMAGE_PCT],
      ['thorns', 'hub', 7],
    ]);
    expect(build.emitters[0]?.signature).toBe(true);
    for (const em of build.emitters.slice(1)) {
      expect(em).toMatchObject({
        signature: false,
        tags: TAG.hit | TAG.thorns,
        chains: false,
        rollsAilments: true,
        canCrit: true,
      });
    }
    // Without grants, the signature alone.
    expect(compileBuild(makeStats(), []).emitters.map((em) => em.kind)).toEqual(['volley']);
  });
});

describe('signatureRows', () => {
  const MAGMA_BOMB: SignatureSpec = { id: 'magmaBomb' };
  const ICE_FAN: SignatureSpec = { id: 'iceFan' };
  const TRIPHASE_ARC: SignatureSpec = { id: 'triphaseArc' };
  const {
    hit: HIT,
    crit: CRIT,
    chain: CHAIN,
    area: AREA,
    projectile: PROJECTILE,
    cold: COLD,
    lightning: LIGHTNING,
  } = TAG;

  it('keys m1Volley hits hit and projectile, its jumps hit and chain, at the center', () => {
    expect(signatureRows(compileBuild(makeStats(), []))).toEqual({
      hit: rowKey(HIT | PROJECTILE, CENTER),
      hitCrit: rowKey(HIT | PROJECTILE | CRIT, CENTER),
      jump: rowKey(HIT | CHAIN, CENTER),
      jumpCrit: rowKey(HIT | CHAIN | CRIT, CENTER),
    });
  });

  it('keys magmaBomb hits hit, area and projectile, its jumps hit and chain (Q3 (B))', () => {
    expect(signatureRows(compileBuild(makeStats(), [], MAGMA_BOMB))).toEqual({
      hit: rowKey(HIT | AREA | PROJECTILE, CENTER),
      hitCrit: rowKey(HIT | AREA | PROJECTILE | CRIT, CENTER),
      jump: rowKey(HIT | CHAIN, CENTER),
      jumpCrit: rowKey(HIT | CHAIN | CRIT, CENTER),
    });
  });

  it('keys iceFan hits hit, projectile and cold, its jumps hit, chain and cold (F15)', () => {
    expect(signatureRows(compileBuild(makeStats(), [], ICE_FAN))).toEqual({
      hit: rowKey(HIT | PROJECTILE | COLD, CENTER),
      hitCrit: rowKey(HIT | PROJECTILE | COLD | CRIT, CENTER),
      jump: rowKey(HIT | CHAIN | COLD, CENTER),
      jumpCrit: rowKey(HIT | CHAIN | COLD | CRIT, CENTER),
    });
  });

  it('keys triphaseArc hits and jumps alike hit, chain and lightning (A32, F15)', () => {
    expect(signatureRows(compileBuild(makeStats(), [], TRIPHASE_ARC))).toEqual({
      hit: rowKey(HIT | CHAIN | LIGHTNING, CENTER),
      hitCrit: rowKey(HIT | CHAIN | LIGHTNING | CRIT, CENTER),
      jump: rowKey(HIT | CHAIN | LIGHTNING, CENTER),
      jumpCrit: rowKey(HIT | CHAIN | LIGHTNING | CRIT, CENTER),
    });
  });

  it('are the rows the triphaseArc payload reads in a run, its hit and jump slots one row', () => {
    const ctx = placedEnemies([], { signature: TRIPHASE_ARC });
    const payload = (ctx.emitters[0] as EmitterRuntime).payload;
    const slots = [SLOT_HIT, SLOT_HIT_CRIT, SLOT_JUMP, SLOT_JUMP_CRIT].map((slot) =>
      slotRow(ctx.build, payload, slot),
    );
    const rows = signatureRows(ctx.build);
    const keys = [rows.hit, rows.hitCrit, rows.jump, rows.jumpCrit];
    expect(keys.map((key) => ctx.build.table.row(key))).toEqual(slots);
    expect([slots[0] === slots[2], slots[1] === slots[3], new Set(slots).size]).toEqual([
      true,
      true,
      2,
    ]);
  });

  it('★過載 on triphaseArc: its jump row ×4.5, and its primary row, the same row (A32), too; M1’s ×1', () => {
    // gd's ★過載: the chain more on [chain, hit].
    const OVERLOAD: RuleSpec = {
      id: 'overload',
      chainCountMultiplier: 2,
      retentionPenalty: 0.2,
      chainMore: 3.5,
    };
    const arc = compileBuild(makeStats(), [OVERLOAD], TRIPHASE_ARC);
    const rows = signatureRows(arc);
    expect(keyedStat(arc, rows.jump, DAMAGE, 1)).toBeCloseTo(4.5, 12);
    expect(keyedStat(arc, rows.jumpCrit, DAMAGE, 1)).toBeCloseTo(4.5, 12);
    // Every arc hit is a chain hit, its primary hits too: one row.
    expect(rows.hit).toBe(rows.jump);
    expect(keyedStat(arc, rows.hit, DAMAGE)).toBeCloseTo(4.5, 12);
    expect(keyedStat(compileBuild(makeStats(), [], TRIPHASE_ARC), rows.hit, DAMAGE)).toBe(1);
    // A volley's primary hit is no chain hit: ×1 there.
    const m1 = compileBuild(makeStats(), [OVERLOAD]);
    const m1Rows = signatureRows(m1);
    expect(keyedStat(m1, m1Rows.hit, DAMAGE)).toBe(1);
    expect(keyedStat(m1, m1Rows.jump, DAMAGE, 1)).toBeCloseTo(4.5, 12);
  });

  it('are the rows the signature payload reads in a run', () => {
    for (const signature of [M1_SIGNATURE, MAGMA_BOMB, ICE_FAN]) {
      const ctx = placedEnemies([], { signature });
      const payload = (ctx.emitters[0] as EmitterRuntime).payload;
      // The payload's rows first: a wrong key would then add a row of its own.
      const slots = [SLOT_HIT, SLOT_HIT_CRIT, SLOT_JUMP, SLOT_JUMP_CRIT].map((slot) =>
        slotRow(ctx.build, payload, slot),
      );
      const rows = signatureRows(ctx.build);
      const keys = [rows.hit, rows.hitCrit, rows.jump, rows.jumpCrit];
      expect(keys.map((key) => ctx.build.table.row(key))).toEqual(slots);
      expect(new Set(slots).size).toBe(4);
    }
  });

  it("credits every row to the signature emitter's source", () => {
    const build = compileBuild(makeStats(), []);
    const spec = build.emitters[0] as EmitterSpec;
    const moved: CompiledBuild = { ...build, emitters: [{ ...spec, source: 'outer.fire' }] };
    const rows = signatureRows(moved);
    const source = build.sources.index('outer.fire');
    expect(source).not.toBe(CENTER);
    expect(rows).toEqual({
      hit: rowKey(HIT | PROJECTILE, source),
      hitCrit: rowKey(HIT | PROJECTILE | CRIT, source),
      jump: rowKey(HIT | CHAIN, source),
      jumpCrit: rowKey(HIT | CHAIN | CRIT, source),
    });
  });

  it('reads the signature at emitters[0], not the grants after it', () => {
    // A thorns grant (at the center or at its outer source) and a segment grant.
    const grants = (source: string) =>
      makeStats({}, [], {
        triggers: [],
        conversions: [],
        emitters: [
          { source, grant: { kind: 'thorns' } },
          { source: 'outer.lightning', grant: { kind: 'segment', endpoints: 'shocked' } },
        ],
      });
    for (const signature of [M1_SIGNATURE, MAGMA_BOMB, ICE_FAN, TRIPHASE_ARC]) {
      const alone = signatureRows(compileBuild(makeStats(), [], signature));
      for (const source of ['center', 'outer.thorns']) {
        const build = compileBuild(grants(source), [], signature);
        expect(build.emitters.map((em) => em.kind).slice(1)).toEqual(['thorns', 'segment']);
        expect(signatureRows(build)).toEqual(alone);
      }
    }
  });

  it("are the rows an emitter payload of the signature's spec reads, any tags and source", () => {
    // An element and an owner tag, which a chain jump keeps (jumpMask), at an outer source.
    const build = compileBuild(makeStats(), []);
    const spec = build.emitters[0] as EmitterSpec;
    const tags = spec.tags | TAG.cold | TAG.minion;
    const moved: CompiledBuild = { ...build, emitters: [{ ...spec, tags, source: 'outer.ice' }] };
    const payload = emitterPayload(moved, moved.emitters[0] as EmitterSpec, createRng(1), null);
    // The payload's rows first: a wrong key would then add a row of its own.
    const slots = [SLOT_HIT, SLOT_HIT_CRIT, SLOT_JUMP, SLOT_JUMP_CRIT].map((slot) =>
      slotRow(moved, payload, slot),
    );
    const rows = signatureRows(moved);
    const keys = [rows.hit, rows.hitCrit, rows.jump, rows.jumpCrit];
    expect(keys.map((key) => moved.table.row(key))).toEqual(slots);
    expect(new Set(slots).size).toBe(4);
    const source = build.sources.index('outer.ice');
    expect(rows.jump).toBe(rowKey(HIT | CHAIN | TAG.cold | TAG.minion, source));
    expect(rows.jumpCrit).toBe(rowKey(HIT | CHAIN | TAG.cold | TAG.minion | CRIT, source));
  });

  it('reads a key with keyedStat, which centerStat is at the center', () => {
    // ×3 on projectile hits, +0.25 crit chance on the second jump of a chain and later.
    const stats = makeStats({}, [
      { stat: 'damage', kind: 'more', value: 2, tags: ['projectile'] },
      {
        stat: 'critChance',
        kind: 'flat',
        value: 0.25,
        tags: ['chain'],
        scaling: { per: 'chainJump' },
      },
    ]);
    const build = compileBuild(stats, []);
    const rows = signatureRows(build);
    expect(keyedStat(build, rows.hit, DAMAGE)).toBe(3);
    expect(keyedStat(build, rowKey(HIT, CENTER), DAMAGE)).toBe(1);
    for (const jump of [0, 1, 2]) {
      expect(keyedStat(build, rows.jump, CRIT_CHANCE, jump)).toBe(
        centerStat(build, HIT | CHAIN, CRIT_CHANCE, jump),
      );
    }
    expect(keyedStat(build, rows.jump, CRIT_CHANCE, 2)).toBe(stats.values.critChance + 0.5);
  });
});
