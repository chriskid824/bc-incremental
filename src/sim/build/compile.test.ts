import { describe, expect, it, vi } from 'vitest';
import { createRng } from '../../core/rng';
import { THORNS_DAMAGE_PCT } from '../../data/emitters';
import type { EmitterGrant } from '../../data/emitters';
import { CHARACTER_SIGNATURE, M1_SIGNATURE } from '../../data/rules';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type * as RulesModule from '../../data/rules';
import { CHARACTER_IDS } from '../../data/sources';
import type { CharacterId } from '../../data/sources';
import { SCOPED_STATS } from '../../data/stats';
import type { Modifier, SourcedRule, StatBlock } from '../../data/stats';
import { jumpMask, TAG } from '../../data/tags';
import { AILMENT_KINDS } from '../../data/triggers';
import type { TriggerSpec } from '../../data/triggers';
import { SHATTER_TRIGGER, shatterTrigger } from '../effects/types';
import {
  emitterPayload,
  SLOT_HIT,
  SLOT_HIT_CRIT,
  SLOT_JUMP,
  SLOT_JUMP_CRIT,
  slotRow,
  turretPayload,
} from '../emitters/types';
import type { DroneSpec, EmitterRuntime, EmitterSpec, Payload } from '../emitters/types';
import { RULE_MODULES, SIGNATURES } from '../rules';
import type { BuildCompiler, TestModule } from '../rules';
import { createRunContext } from '../systems/context';
import {
  damageRow,
  makeConfig,
  makeStats,
  makeTestData,
  maskProbeMods,
  placedEnemies,
} from '../testing';
import type { CharacterRun } from '../types';
import { centerDamage, centerStat, compileBuild, keyedStat, signatureRows } from './compile';
import type { CompiledBuild } from './compile';
import { modTableFor, SCOPED_INDEX } from './modTable';
import {
  AILMENT_ORDINAL,
  CENTER,
  createAttribution,
  jumpCredit,
  M1_CENTER_AILMENTS,
  rowKey,
} from './sources';

// RULE_COEF_FIELDS is empty until the hand modules land (docs/v3 C6 design D9, C-1): the
// character-run tests fill this copy.
const rules = vi.hoisted(() => ({
  coefFields: {} as Record<string, Record<string, string>>,
}));
vi.mock('../../data/rules', async (importOriginal) => {
  const actual = await importOriginal<typeof RulesModule>();
  return { ...actual, RULE_COEF_FIELDS: rules.coefFields };
});

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
      swarm: null,
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
  const SWARM: SignatureSpec = { id: 'swarm' };
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

  it('keys swarm impacts hit, minion and area, its jumps hit, chain and minion (F18)', () => {
    expect(signatureRows(compileBuild(makeStats(), [], SWARM))).toEqual({
      hit: rowKey(HIT | TAG.minion | AREA, CENTER),
      hitCrit: rowKey(HIT | TAG.minion | AREA | CRIT, CENTER),
      jump: rowKey(HIT | CHAIN | TAG.minion, CENTER),
      jumpCrit: rowKey(HIT | CHAIN | TAG.minion | CRIT, CENTER),
    });
  });

  it('are the rows the swarm payload reads in a run, a drone grant after it or not', () => {
    const granted = makeStats({}, [], {
      triggers: [],
      conversions: [],
      emitters: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 1 } }],
    });
    for (const stats of [makeStats(), granted]) {
      const ctx = placedEnemies([], { stats, signature: SWARM });
      const payload = (ctx.emitters[0] as EmitterRuntime).payload;
      // The payload's rows first: a wrong key would then add a row of its own.
      const slots = [SLOT_HIT, SLOT_HIT_CRIT, SLOT_JUMP, SLOT_JUMP_CRIT].map((slot) =>
        slotRow(ctx.build, payload, slot),
      );
      const rows = signatureRows(ctx.build);
      const keys = [rows.hit, rows.hitCrit, rows.jump, rows.jumpCrit];
      expect(keys.map((key) => ctx.build.table.row(key))).toEqual(slots);
      expect(new Set(slots).size).toBe(4);
      expect(signatureRows(ctx.build)).toEqual(signatureRows(compileBuild(makeStats(), [], SWARM)));
    }
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

/** A character run of `id` with these sourced rules. */
const run = (id: CharacterId, ...sourced: SourcedRule[]): CharacterRun => ({ id, rules: sourced });

/** compileBuild of a character run: its character's signature, no M1 rules. */
const compileRun = (
  stats: StatBlock,
  character: CharacterRun,
  ...modules: TestModule[]
): CompiledBuild =>
  compileBuild(stats, [], { id: CHARACTER_SIGNATURE[character.id] }, modules, character);

/** A test module at `source` (the center when omitted) that writes the chain policy. */
const policyAt = (source?: string): TestModule =>
  Object.assign((b: BuildCompiler) => void b.chainPolicy(), source === undefined ? {} : { source });

/** A trigger that poisons every hit. */
const POISON_ON_HIT: TriggerSpec = {
  on: 'hit',
  do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 1 }],
};

describe('compileBuild on a character run (docs/v3 C6 design D7–D10, §5.2)', () => {
  it('compiles a data trigger at its coef, 1 without one: its COEF fields and its chance × coef, the chance capped at 1', () => {
    const explode: TriggerSpec = {
      on: 'kill',
      when: [{ chance: 0.3 }],
      do: [{ kind: 'explode', radius: 60, damagePct: 0.5 }],
    };
    const poison: TriggerSpec = {
      on: 'hit',
      when: [{ chance: 0.7 }],
      do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }],
    };
    const jump: TriggerSpec = {
      on: 'chainJump',
      do: [{ kind: 'applyAilment', ailment: 'poison' }],
    };
    const stats = makeStats({}, [], {
      triggers: [
        { source: 'fusion.fire.poison', spec: explode, coef: 2 },
        { source: 'fusion.fire.poison', spec: poison, coef: 2 },
        { source: 'fusion.lightning.poison', spec: jump, coef: 2 },
        { source: 'center', spec: explode },
      ],
      conversions: [],
      emitters: [],
    });
    const build = compileBuild(stats, []);
    // chainJump's fixed chance (CHAIN_JUMP_CHANCE, 0.3) scales as a chance condition does.
    expect(build.triggers.slice(1).map((t) => [t.chance, t.coef])).toEqual([
      [0.6, 2],
      [1, 2],
      [0.6, 2],
      [0.3, 1],
    ]);
    // A COEF field left out counts as 1; radius and stacks never scale.
    expect(build.effects.map((fx) => fx.spec)).toEqual([
      { kind: 'explode', radius: 60, damagePct: 1 },
      { kind: 'applyAilment', ailment: 'poison', stacks: 2, damagePct: 2 },
      { kind: 'applyAilment', ailment: 'poison', damagePct: 2 },
      { kind: 'explode', radius: 60, damagePct: 0.5 },
    ]);
  });

  it('numbers outer.lightning right after the data triggers on 熔核, 霜晶 and 蜂巢, whatever rule groups and test modules follow (F37)', () => {
    const later: TestModule = Object.assign((b: BuildCompiler) => void b.source('outer.greed'), {
      source: 'outer.crit',
    });
    for (const id of CHARACTER_IDS) {
      const fusion = `fusion.${id}.poison`;
      const stats = makeStats({}, [], {
        triggers: [
          { source: fusion, spec: POISON_ON_HIT, coef: 1.5 },
          { source: 'outer.bleed', spec: POISON_ON_HIT },
        ],
        conversions: [],
        emitters: [],
      });
      const sourced = run(
        id,
        { source: 'hub', spec: { id: 'glassCannon', damageMore: 1 }, coef: 1 },
        { source: 'asc', spec: { id: 'eternalFlame', durationMore: 0.5 }, coef: 1 },
      );
      const build = compileRun(stats, sourced, later);
      // 雷塔's jumps stay the center's, so nothing numbers it there.
      const jumps = id === 'lightning' ? [] : ['outer.lightning'];
      expect(build.sources.names, id).toEqual([
        'center',
        fusion,
        'outer.bleed',
        ...jumps,
        'hub',
        'asc',
        'outer.crit',
        'outer.greed',
      ]);
      expect(build.attribution.jumpSource, id).toBe(id === 'lightning' ? -1 : 3);
    }
    // Nor on an M1 run.
    const m1 = compileBuild(
      makeStats({}, [], {
        triggers: [{ source: 'outer.bleed', spec: POISON_ON_HIT }],
        conversions: [],
        emitters: [],
      }),
      [{ id: 'glassCannon', damageMore: 1 }],
      undefined,
      [later],
    );
    expect(m1.sources.names).toEqual(['center', 'outer.bleed', 'outer.crit', 'outer.greed']);
    expect(m1.attribution.jumpSource).toBe(-1);
  });

  it('numbers outer.lightning before the signature compiles', () => {
    const signature = SIGNATURES.magmaBomb;
    const compile = signature.compile;
    const spy = vi.spyOn(signature, 'compile').mockImplementation((b, spec, source) => {
      b.source('outer.fire');
      compile?.call(signature, b, spec, source);
    });
    try {
      const build = compileRun(makeStats(), run('fire'));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(build.sources.names).toEqual(['center', 'outer.lightning', 'outer.fire']);
      expect(build.attribution.jumpSource).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("credits a character's own ailments to the center, and the center's jumps to outer.lightning off 雷塔 (D8)", () => {
    const bits = (kinds: readonly (typeof AILMENT_KINDS)[number][]): number =>
      kinds.reduce((sum, kind) => sum | (1 << AILMENT_ORDINAL[kind]), 0);
    const credits = Object.fromEntries(
      CHARACTER_IDS.map((id) => {
        const { attribution, sources } = compileRun(makeStats(), run(id));
        const jumps = attribution.jumpSource < 0 ? 'center' : sources.names[attribution.jumpSource];
        return [id, [attribution.centerAilments, jumps, [...attribution.outerSource]]];
      }),
    );
    const none = AILMENT_KINDS.map(() => -1);
    expect(credits).toEqual({
      fire: [bits(['burn']), 'outer.lightning', none],
      ice: [bits(['frost']), 'outer.lightning', none],
      lightning: [bits(['shock']), 'center', none],
      summon: [0, 'outer.lightning', none],
    });
    // M1: every kind the center's own, and its jumps too.
    const m1 = compileBuild(makeStats(), []).attribution;
    expect([m1.centerAilments, m1.jumpSource]).toEqual([bits(M1_CENTER_AILMENTS), -1]);
    expect(m1.centerAilments).toBe(2 ** AILMENT_KINDS.length - 1);
  });

  it('compiles each rule id once, in the order the ids first appear, at its board’s source, from the specs its coef scaled (D9, D10)', () => {
    rules.coefFields.glassCannon = { damageMore: 'pct' };
    rules.coefFields.overload = { chainCountMultiplier: 'mult', retentionPenalty: 'chance' };
    const glass = vi.spyOn(RULE_MODULES.glassCannon, 'compile');
    const overload = vi.spyOn(RULE_MODULES.overload, 'compile');
    try {
      const build = compileRun(
        makeStats({ chainCount: 1 }),
        run(
          'fire',
          { source: 'fusion.fire.summon', spec: { id: 'glassCannon', damageMore: 1 }, coef: 2 },
          {
            source: 'asc',
            spec: { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.6 },
            coef: 2,
          },
          { source: 'fusion.fire.summon', spec: { id: 'glassCannon', damageMore: 0.5 }, coef: 2 },
        ),
      );
      const { names } = build.sources;
      expect(names).toEqual(['center', 'outer.lightning', 'fusion.fire.summon', 'asc']);
      // glassCannon first, both its instances together, though overload precedes it in RULE_IDS.
      expect(glass.mock.calls.map(([, specs, source]) => [specs, source])).toEqual([
        [
          [
            { id: 'glassCannon', damageMore: 2 },
            { id: 'glassCannon', damageMore: 1 },
          ],
          names.indexOf('fusion.fire.summon'),
        ],
      ]);
      // A chance field scales up to 1 at most.
      expect(overload.mock.calls.map(([, specs, source]) => [specs, source])).toEqual([
        [[{ id: 'overload', chainCountMultiplier: 4, retentionPenalty: 1 }], names.indexOf('asc')],
      ]);
      expect(glass.mock.invocationCallOrder[0]).toBeLessThan(
        overload.mock.invocationCallOrder[0] as number,
      );
      // The modules compiled the scaled numbers: glassCannon's two mores after magmaBomb's
      // igniteAlways.
      expect(build.mods.map((mod) => mod.value)).toEqual([1, 2, 1]);
      expect(build.values.chainCount).toBe(4);
    } finally {
      glass.mockRestore();
      overload.mockRestore();
      delete rules.coefFields.glassCannon;
      delete rules.coefFields.overload;
    }
  });

  it('takes a group’s source and coef from its first rule; validateConfig keeps them one', () => {
    rules.coefFields.glassCannon = { damageMore: 'pct' };
    const glass = vi.spyOn(RULE_MODULES.glassCannon, 'compile');
    try {
      const build = compileRun(
        makeStats(),
        run(
          'summon',
          { source: 'hub', spec: { id: 'glassCannon', damageMore: 1 }, coef: 3 },
          { source: 'asc', spec: { id: 'glassCannon', damageMore: 0.5 }, coef: 0.5 },
        ),
      );
      expect(build.sources.names).toEqual(['center', 'outer.lightning', 'hub']);
      expect(glass.mock.calls.map(([, specs, source]) => [specs, source])).toEqual([
        [
          [
            { id: 'glassCannon', damageMore: 3 },
            { id: 'glassCannon', damageMore: 1.5 },
          ],
          2,
        ],
      ]);
    } finally {
      glass.mockRestore();
      delete rules.coefFields.glassCannon;
    }
  });

  it('tells the instance being compiled its source through credit(): its index and its id', () => {
    const credits: unknown[] = [];
    const record = (source?: string): TestModule =>
      Object.assign(
        (b: BuildCompiler) => void credits.push(b.credit()),
        source === undefined ? {} : { source },
      );
    const glass = vi
      .spyOn(RULE_MODULES.glassCannon, 'compile')
      .mockImplementation((b) => void credits.push(b.credit()));
    try {
      compileRun(
        makeStats(),
        run('ice', { source: 'asc', spec: { id: 'glassCannon', damageMore: 1 }, coef: 1 }),
        record(),
        record('hub'),
        record('fusion.ice.crit'),
        record('asc'),
      );
      expect(credits).toEqual([
        { source: 2, name: 'asc' },
        { source: CENTER, name: 'center' },
        { source: 3, name: 'hub' },
        { source: 4, name: 'fusion.ice.crit' },
        { source: 2, name: 'asc' },
      ]);
    } finally {
      glass.mockRestore();
    }
  });
});

describe('the chain-policy assert (docs/v3 C6 design D8, C-1, F38)', () => {
  it('throws on 熔核, 霜晶 and 蜂巢 for a module at the center, not for one at outer.lightning, nor on 雷塔 or M1', () => {
    for (const id of ['fire', 'ice', 'summon'] as const) {
      expect(() => compileRun(makeStats(), run(id), policyAt()), id).toThrow(
        `chainPolicy() from source 'center' on a ${id} run: ` +
          "the center's chain jumps are credited to 'outer.lightning'",
      );
      expect(compileRun(makeStats(), run(id), policyAt('outer.lightning')).chainPolicy, id).toEqual(
        expect.objectContaining({ decay: [] }),
      );
    }
    expect(compileRun(makeStats(), run('lightning'), policyAt()).chainPolicy).not.toBeNull();
    const m1 = compileBuild(makeStats(), [], undefined, [policyAt(), policyAt('hub')]);
    expect(m1.chainPolicy).not.toBeNull();
  });

  it('on 雷塔, admits a module at an ascendancy node and refuses one at the hub (gd:575)', () => {
    expect(compileRun(makeStats(), run('lightning'), policyAt('asc')).chainPolicy).not.toBeNull();
    expect(() => compileRun(makeStats(), run('lightning'), policyAt('hub'))).toThrow(
      "chainPolicy() from source 'hub' on a lightning run: " +
        "the center's chain jumps are credited to 'center'",
    );
    // Off 雷塔 an ascendancy node is no exception.
    expect(() => compileRun(makeStats(), run('fire'), policyAt('asc'))).toThrow(
      "chainPolicy() from source 'asc' on a fire run",
    );
  });
});

describe('jumpCredit (docs/v3 C6 design D8)', () => {
  it("credits a center payload's jumps to the policy's jumpSource, any other payload's to its own source", () => {
    const fire = createAttribution(['burn'], 3);
    expect(jumpCredit(fire, CENTER)).toBe(3);
    expect([1, 2, 3, 4, 63].map((source) => jumpCredit(fire, source))).toEqual([1, 2, 3, 4, 63]);
    // −1, the default: every payload's jumps its own source's, the center's too.
    const own = createAttribution(['shock']);
    expect([0, 1, 5].map((source) => jumpCredit(own, source))).toEqual([0, 1, 5]);
  });

  it('gives emitter and turret payloads their jump credit: outer.lightning for the center’s on 熔核, 霜晶 and 蜂巢', () => {
    const granted = makeStats({}, [], {
      triggers: [],
      conversions: [],
      emitters: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 1, turrets: 1 } }],
    });
    const sourcesOf = (payload: Payload): number[] => [payload.source, payload.jumpSource];
    for (const id of CHARACTER_IDS) {
      const build = compileRun(granted, run(id));
      const [signature, grant] = build.emitters as [EmitterSpec, DroneSpec];
      // A grant's source is numbered by its first payload; numbered here first.
      const summon = build.sources.index('outer.summon');
      const centerJumps =
        id === 'lightning' ? CENTER : build.sources.names.indexOf('outer.lightning');
      expect(centerJumps, id).toBe(id === 'lightning' ? CENTER : 1);
      expect(sourcesOf(emitterPayload(build, signature, createRng(1), null)), id).toEqual([
        CENTER,
        centerJumps,
      ]);
      // A payload of another source keeps its jumps.
      expect(sourcesOf(emitterPayload(build, grant, createRng(1), null)), id).toEqual([
        summon,
        summon,
      ]);
      expect(sourcesOf(turretPayload(build, grant, 0.4, createRng(1), null)), id).toEqual([
        summon,
        summon,
      ]);
    }
    // The swarm's turrets are the center's: their jumps outer.lightning's on 蜂巢.
    const hive = compileRun(makeStats(), run('summon'));
    const swarm = hive.emitters[0] as DroneSpec;
    expect(sourcesOf(turretPayload(hive, swarm, 0.4, createRng(1), null))).toEqual([CENTER, 1]);
    // M1's stay the center's.
    const m1 = compileBuild(makeStats(), [], { id: 'swarm' });
    const m1Swarm = m1.emitters[0] as DroneSpec;
    expect(sourcesOf(turretPayload(m1, m1Swarm, 0.4, createRng(1), null))).toEqual([
      CENTER,
      CENTER,
    ]);
    expect(sourcesOf(emitterPayload(m1, m1Swarm, createRng(1), null))).toEqual([CENTER, CENTER]);
  });

  it('gives every center emitter the jump credit, not only the signature: a center grant’s payloads and its turrets’', () => {
    const granted = makeStats({}, [], {
      triggers: [],
      conversions: [],
      emitters: [{ source: 'center', grant: { kind: 'drone', drones: 1, turrets: 1 } }],
    });
    const sourcesOf = (payload: Payload): number[] => [payload.source, payload.jumpSource];
    for (const id of CHARACTER_IDS) {
      const build = compileRun(granted, run(id));
      const grant = build.emitters[1] as DroneSpec;
      const centerJumps = id === 'lightning' ? CENTER : 1;
      expect(sourcesOf(emitterPayload(build, grant, createRng(1), null)), id).toEqual([
        CENTER,
        centerJumps,
      ]);
      expect(sourcesOf(turretPayload(build, grant, 0.4, createRng(1), null)), id).toEqual([
        CENTER,
        centerJumps,
      ]);
    }
  });

  it('leaves the jumps of a lob’s zone payload at its own source', () => {
    const build = compileRun(makeStats(), run('fire'));
    const payload = emitterPayload(build, build.emitters[0] as EmitterSpec, createRng(1), null);
    const zone = payload.zoneVariant as Payload;
    expect([payload.jumpSource, zone.source, zone.jumpSource]).toEqual([1, CENTER, CENTER]);
  });
});

describe('signatureRows on a character run (docs/v3 C6 design D8)', () => {
  it('keys the jump rows with the jump credit: outer.lightning on 熔核, 霜晶 and 蜂巢, the center on 雷塔', () => {
    for (const id of CHARACTER_IDS) {
      const build = compileRun(makeStats(), run(id));
      const spec = build.emitters[0] as EmitterSpec;
      const jumps = id === 'lightning' ? CENTER : 1;
      expect(build.sources.names[jumps], id).toBe(
        id === 'lightning' ? 'center' : 'outer.lightning',
      );
      expect(signatureRows(build), id).toEqual({
        hit: rowKey(spec.tags, CENTER),
        hitCrit: rowKey(spec.tags | TAG.crit, CENTER),
        jump: rowKey(jumpMask(spec.tags), jumps),
        jumpCrit: rowKey(jumpMask(spec.tags) | TAG.crit, jumps),
      });
    }
  });

  it('are the rows the signature payload reads in a character run', () => {
    for (const id of CHARACTER_IDS) {
      const ctx = createRunContext(
        makeConfig({ signature: { id: CHARACTER_SIGNATURE[id] }, character: run(id) }),
        makeTestData(),
      );
      const payload = (ctx.emitters[0] as EmitterRuntime).payload;
      expect(payload.jumpSource, id).toBe(id === 'lightning' ? CENTER : 1);
      // The payload's rows first: a wrong key would then add a row of its own.
      const slots = [SLOT_HIT, SLOT_HIT_CRIT, SLOT_JUMP, SLOT_JUMP_CRIT].map((slot) =>
        slotRow(ctx.build, payload, slot),
      );
      const rows = signatureRows(ctx.build);
      const keys = [rows.hit, rows.hitCrit, rows.jump, rows.jumpCrit];
      expect(
        keys.map((key) => ctx.build.table.row(key)),
        id,
      ).toEqual(slots);
      // 雷塔's hits and jumps share their rows (A32).
      expect(new Set(slots).size, id).toBe(id === 'lightning' ? 2 : 4);
    }
  });
});
