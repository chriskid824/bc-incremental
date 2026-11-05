import { describe, expect, it } from 'vitest';
import { mul, num } from '../../core/num';
import { SCOPED_STATS } from '../../data/stats';
import type { SourcedEmitter } from '../../data/emitters';
import type { Modifier, StatBlock, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { Condition, ScalingSpec } from '../../data/triggers';
import type { GameData, WaveTable } from '../../data/types';
import { computeStatBlock } from '../../meta/stats';
import { addBurn } from '../ailments/records';
import { CHAIN_JUMP, CRIT_HIT, heldFlag, HIT_EVENT, killKindFlag, PRIMARY } from '../effects/flags';
import { enemiesInAura } from '../emitters/aura';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { createRunContext } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { CHARGING, DASHING, FLEEING, ORBITING, STOPPED } from '../systems/enemyRecord';
import type { EnemyV3 } from '../systems/enemyRecord';
import { rebuildGrid } from '../systems/grid';
import { releaseEnemies } from '../systems/spawn';
import { startDueWave } from '../systems/waves';
import {
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  stationarySquares,
  v3TestData,
} from '../testing';
import { NO_INPUT } from '../types';
import {
  compileCondition,
  compileScaling,
  conditionsMet,
  pctMaxHpFactor,
  scaledValue,
  statAt,
  staticInput,
} from './eval';
import type { CompiledCondition, EvalInput } from './eval';
import { compileMods, ModTable, modTableFor, SCOPED_INDEX } from './modTable';
import { auraReachSq } from './size';
import { CENTER, createSourceTable, rowKey } from './sources';

const S = SCOPED_STATS.length;
const {
  damage: DAMAGE,
  critChance: CRIT_CHANCE,
  critMultiplier: CRIT_MULTIPLIER,
  igniteChance: IGNITE_CHANCE,
} = SCOPED_INDEX;

const g = (spec: Omit<ScalingSpec, 'per'>, value: number, x: number): number =>
  scaledValue(value, compileScaling({ per: 'chainJump', ...spec }), x);

const perJump = (
  stat: Modifier['stat'],
  kind: Modifier['kind'],
  value: number,
  scaling: Omit<ScalingSpec, 'per'> = {},
  extra: Partial<Modifier> = {},
): Modifier => ({ stat, kind, value, scaling: { per: 'chainJump', ...scaling }, ...extra });

describe('scaledValue', () => {
  it('scales linearly by default, in whole steps with every', () => {
    expect(g({}, 0.1, 0)).toBe(0);
    expect(g({}, 0.1, 3)).toBe(0.1 * 3);
    expect(g({ every: 2 }, 0.5, 0)).toBe(0);
    expect(g({ every: 2 }, 0.5, 1)).toBe(0);
    expect(g({ every: 2 }, 0.5, 2)).toBe(0.5);
    expect(g({ every: 2 }, 0.5, 5)).toBe(1);
  });

  it('follows the log10 and pow curves, after the steps', () => {
    expect(g({ curve: 'log10' }, 2, 9)).toBe(2);
    expect(g({ curve: 'log10' }, 2, 0)).toBe(0);
    expect(g({ curve: 'pow', exponent: 2 }, 0.5, 3)).toBe(4.5);
    expect(g({ curve: 'pow', exponent: 0.5 }, 1, 0)).toBe(0);
    expect(g({ curve: 'pow', exponent: 2, every: 2 }, 1, 5)).toBe(4);
    expect(g({ curve: 'log10', every: 3 }, 1, 29)).toBe(1);
  });

  it('caps the contribution, not the variable', () => {
    expect(g({ cap: 0.25 }, 0.1, 2)).toBe(0.2);
    expect(g({ cap: 0.25 }, 0.1, 3)).toBe(0.25);
    expect(g({ cap: 0.25 }, 0.1, 30)).toBe(0.25);
  });

  it('caps the log10 and pow contributions at the cap itself, as linear', () => {
    expect(g({ curve: 'log10', cap: 0.5 }, 1, 9)).toBe(0.5);
    expect(g({ curve: 'log10', cap: 2 }, 1, 9)).toBe(1);
    expect(g({ curve: 'pow', exponent: 2, cap: 3 }, 1, 2)).toBe(3);
    expect(g({ curve: 'pow', exponent: 2, cap: 3 }, 1, 1)).toBe(1);
    expect(compileScaling({ per: 'chainJump', curve: 'pow', exponent: 2, cap: 3 }).cap).toBe(3);
  });

  it('gives powFactor the contribution max(1, x)^exponent − 1, its cap stored − 1', () => {
    const spec = { per: 'chainJump', curve: 'powFactor', exponent: 0.12 } as const;
    expect(compileScaling({ ...spec, cap: 2 })).toMatchObject({
      curve: 3,
      exponent: 0.12,
      cap: 1,
      every: 0,
    });
    expect(compileScaling(spec).cap).toBe(Infinity);
    expect(g({ curve: 'powFactor', exponent: 0.12 }, 1, 1e4)).toBe(1e4 ** 0.12 - 1);
    expect(g({ curve: 'powFactor', exponent: 0.12 }, 1, 1)).toBe(0);
    expect(g({ curve: 'powFactor', exponent: 0.12 }, 1, 0.5)).toBe(0);
    expect(g({ curve: 'powFactor', exponent: 0.12, cap: 2 }, 1, 1e8)).toBe(1);
  });

  it('compiles every curve to an object of the same members in the same order', () => {
    const keys = (['linear', 'log10', 'pow', 'powFactor'] as const).map((curve) =>
      Object.keys(
        compileScaling({
          per: 'chainJump',
          curve,
          ...(curve === 'pow' || curve === 'powFactor' ? { exponent: 2 } : {}),
        }),
      ),
    );
    for (const k of keys) expect(k).toEqual(['read', 'every', 'curve', 'exponent', 'cap']);
  });
});

describe('statAt', () => {
  it('reads the folded value of a row without dynamic entries', () => {
    const table = modTableFor(
      makeStats({ critChance: 0.2 }, [
        { stat: 'critChance', kind: 'flat', value: 0.1, tags: ['chain'] },
        { stat: 'damage', kind: 'more', value: 1 },
      ]),
    );
    const row = table.row(TAG.hit | TAG.chain);
    expect(table.dynCount[row * S + CRIT_CHANCE]).toBe(0);
    for (const jump of [0, 1, 5]) {
      expect(statAt(table, row, CRIT_CHANCE, staticInput(jump))).toBe(0.2 + 0.1);
      expect(statAt(table, row, DAMAGE, staticInput(jump))).toBe(2);
    }
  });

  it('adds Static Focus per jump after the static parts: G + 0.1 × jump, bit for bit', () => {
    const table = modTableFor(
      makeStats({ critChance: 0.35 }, [perJump('critChance', 'flat', 0.1)]),
    );
    for (const mask of [TAG.hit, TAG.hit | TAG.chain, TAG.hit | TAG.crit | TAG.chain]) {
      const row = table.row(mask);
      for (let jump = 0; jump < 8; jump++) {
        expect(statAt(table, row, CRIT_CHANCE, staticInput(jump))).toBe(0.35 + 0.1 * jump);
      }
    }
    // The scaling stays out of the static parts.
    expect(table.final[table.row(TAG.hit) * S + CRIT_CHANCE]).toBe(0.35);
  });

  it('folds flat, increased and more entries into the formula in data order', () => {
    const modifiers: Modifier[] = [
      { stat: 'igniteChance', kind: 'flat', value: 0.1 },
      perJump('igniteChance', 'flat', 0.05),
      perJump('igniteChance', 'increased', 0.5, { every: 2 }),
      { stat: 'igniteChance', kind: 'increased', value: 0.2, tags: ['chain'] },
      perJump('igniteChance', 'more', 0.1, { cap: 0.25 }),
      { stat: 'igniteChance', kind: 'more', value: 1 },
    ];
    const table = modTableFor(makeStats({ igniteChance: 0.2 }, modifiers));
    const row = table.row(TAG.hit | TAG.chain);
    for (let jump = 0; jump < 6; jump++) {
      const flat = 0.2 + 0.1 + 0.05 * jump;
      const inc = 0.2 + 0.5 * Math.floor(jump / 2);
      const more = 2 * (1 + Math.min(0.25, 0.1 * jump));
      expect(statAt(table, row, IGNITE_CHANCE, staticInput(jump)), `jump ${jump}`).toBe(
        flat * (1 + inc) * more,
      );
    }
  });

  it('keeps a damage row to (1 + Σincreased) × Π(1 + more) with dynamic entries', () => {
    const table = modTableFor(
      makeStats({ damage: 40 }, [
        { stat: 'damage', kind: 'increased', value: 0.5 },
        perJump('damage', 'more', 0.25, {}, { tags: ['chain'] }),
        perJump('damage', 'increased', 0.1, { curve: 'pow', exponent: 2 }),
      ]),
    );
    const chain = table.row(TAG.hit | TAG.chain);
    expect(statAt(table, chain, DAMAGE, staticInput(0))).toBe(1.5);
    expect(statAt(table, chain, DAMAGE, staticInput(2))).toBe(
      (1 + (0.5 + 0.1 * 4)) * (1 + 0.25 * 2),
    );
    // The more entry needs the chain tag: the primary hit row lists only the increased one.
    const hit = table.row(TAG.hit);
    expect(table.dynCount[hit * S + DAMAGE]).toBe(1);
    expect(table.dynCount[chain * S + DAMAGE]).toBe(2);
    expect(statAt(table, hit, DAMAGE, staticInput(2))).toBe(1 + (0.5 + 0.1 * 4));
    // damage(key) reads a primary hit: chain jump 0.
    expect(table.damage(TAG.hit | TAG.chain)).toBe(1.5);
  });

  it('lists the dynamic entries a row matches by tags, notTags and scope', () => {
    const sources = createSourceTable();
    const outer = sources.index('outer.lightning');
    const modifiers: Modifier[] = [
      perJump('critChance', 'flat', 0.01, {}, { tags: ['chain'] }),
      perJump('critChance', 'flat', 0.02, {}, { notTags: ['crit'] }),
      perJump('critChance', 'flat', 0.04, {}, { scope: 'outer' }),
    ];
    const table = modTableFor(makeStats({ critChance: 0 }, modifiers), sources);
    const at = (mask: number, source: number): number =>
      statAt(table, table.row(rowKey(mask, source)), CRIT_CHANCE, staticInput(1));
    expect(at(TAG.hit, 0)).toBe(0.02);
    expect(at(TAG.hit | TAG.chain, 0)).toBe(0.01 + 0.02);
    expect(at(TAG.hit | TAG.chain | TAG.crit, 0)).toBe(0.01);
    expect(at(TAG.hit | TAG.chain, outer)).toBe(0.01 + 0.02 + 0.04);
  });

  it("keeps every row's dynamic entries as the table grows", () => {
    const modifiers: Modifier[] = [
      perJump('critChance', 'flat', 0.1, {}, { tags: ['chain'] }),
      perJump('critChance', 'flat', 0.2, {}, { notTags: ['burn'] }),
      perJump('damage', 'more', 1, {}, { tags: ['hit'] }),
    ];
    const table = modTableFor(makeStats({ critChance: 0 }, modifiers));
    const keys = Array.from({ length: 600 }, (_, i) => (i * 37) & ((1 << 17) - 1));
    const rows = keys.map((key) => table.row(key));
    keys.forEach((key, i) => {
      const row = rows[i] as number;
      const chain = (key & TAG.chain) !== 0 ? 0.1 * 3 : 0;
      const notBurn = (key & TAG.burn) === 0 ? 0.2 * 3 : 0;
      expect(statAt(table, row, CRIT_CHANCE, staticInput(3)), `key ${key}`).toBe(
        0 + chain + notBurn,
      );
      expect(statAt(table, row, DAMAGE, staticInput(3)), `key ${key}`).toBe(
        (key & TAG.hit) !== 0 ? 4 : 1,
      );
    });
  });

  it('applies postScale, then postOffset, to dynamic entries as to static ones', () => {
    const stats = makeStats({ critMultiplier: 2, critChance: 0.1 }, [
      perJump('critMultiplier', 'flat', 1),
      perJump('critChance', 'increased', 0.5),
      perJump('damage', 'more', 1),
    ]);
    const sources = createSourceTable();
    const mods = compileMods(stats.scoped, sources);
    const base = Float64Array.from(SCOPED_STATS, (stat) => stats.base[stat]);
    base[DAMAGE] = 1;
    const postScale = new Float64Array(S).fill(1);
    const postOffset = new Float64Array(S);
    postScale[CRIT_MULTIPLIER] = 1.5;
    postScale[CRIT_CHANCE] = 2;
    postOffset[CRIT_CHANCE] = 0.25;
    postScale[DAMAGE] = 7;
    postOffset[DAMAGE] = 5;
    const table = new ModTable(mods, base, postScale, postOffset);
    const row = table.row(TAG.hit | TAG.chain);
    for (const jump of [0, 1, 3]) {
      expect(statAt(table, row, CRIT_MULTIPLIER, staticInput(jump))).toBe((2 + jump) * 1.5);
      expect(statAt(table, row, CRIT_CHANCE, staticInput(jump))).toBe(
        0.1 * (1 + 0.5 * jump) * 2 + 0.25,
      );
      // Damage rows ignore both arrays.
      expect(statAt(table, row, DAMAGE, staticInput(jump))).toBe(1 + jump);
    }
  });
});

describe('the powFactor curve (H17)', () => {
  /** A powFactor damage more of value 1, scoped to the center, so a shatter takes it too. */
  const factorMod = (exponent: number, scaling: Omit<ScalingSpec, 'per'> = {}): Modifier =>
    perJump('damage', 'more', 1, { curve: 'powFactor', exponent, ...scaling }, { scope: 'center' });

  /**
   * The damage factor of `modifiers` at x = `x`, read through statAt (evalDynamic) and through
   * pctMaxHpFactor at a shatter mult of 1, on a center hit's row.
   */
  function factors(modifiers: Modifier[], x: number): [number, number] {
    const table = modTableFor(makeStats({}, modifiers));
    const row = table.row(rowKey(TAG.hit, CENTER));
    expect(table.dynCount[row * S + DAMAGE]).toBe(modifiers.length);
    return [
      statAt(table, row, DAMAGE, staticInput(x)),
      pctMaxHpFactor(table, row, staticInput(x), 1),
    ];
  }

  it("multiplies by x^exponent with no 1 +: H17's 3.020, 1.738 and 9.120", () => {
    const cases = [
      [0.12, 1e4, 3.02],
      [0.06, 1e4, 1.738],
      [0.12, 1e8, 9.12],
    ] as const;
    for (const [exponent, x, factor] of cases) {
      for (const read of factors([factorMod(exponent)], x)) {
        expect(read, `${x}^${exponent}`).toBeCloseTo(factor, 3);
        expect(read, `${x}^${exponent}`).toBeCloseTo(x ** exponent, 12);
      }
    }
  });

  it('gives a factor of 1 at x = 0 and x = 0.5, and from x = 1 on grows', () => {
    for (const x of [0, 0.5, 1]) expect(factors([factorMod(0.12)], x)).toEqual([1, 1]);
    for (const read of factors([factorMod(0.12)], 2)) expect(read).toBeCloseTo(2 ** 0.12, 12);
  });

  it('holds a cap of 2 on the factor, and leaves a factor below it alone', () => {
    expect(factors([factorMod(0.12, { cap: 2 })], 1e8)).toEqual([2, 2]);
    expect(factors([factorMod(0.12, { cap: 2 })], 1e4)).toEqual([2, 2]);
    for (const read of factors([factorMod(0.12, { cap: 2 })], 100)) {
      expect(read).toBeCloseTo(100 ** 0.12, 12);
    }
    expect(factors([factorMod(0.12, { cap: 1 })], 1e8)).toEqual([1, 1]);
  });

  it('multiplies two 0.03 modifiers to one 0.06', () => {
    const [one] = factors([factorMod(0.06)], 1e4);
    for (const read of factors([factorMod(0.03), factorMod(0.03)], 1e4)) {
      expect(read).toBeCloseTo(one, 12);
      expect(read).toBeCloseTo(1.738, 3);
    }
  });

  it('counts whole steps of every before the power', () => {
    for (const read of factors([factorMod(0.12, { every: 10 })], 1e4)) {
      expect(read).toBeCloseTo(1000 ** 0.12, 12);
    }
    expect(factors([factorMod(0.12, { every: 10 })], 15)).toEqual([1, 1]);
    expect(factors([factorMod(0.12, { every: 10 })], 9)).toEqual([1, 1]);
  });

  it('folds after the static parts, and a shatter takes it times its mult', () => {
    const table = modTableFor(
      makeStats({}, [
        factorMod(0.12),
        { stat: 'damage', kind: 'increased', value: 0.5 },
        { stat: 'damage', kind: 'more', value: 1 },
      ]),
    );
    const row = table.row(rowKey(TAG.hit, CENTER));
    expect(statAt(table, row, DAMAGE, staticInput(1e4))).toBeCloseTo(1.5 * 2 * 1e4 ** 0.12, 12);
    // A shatter leaves the static parts out (pctMaxHpFactor), and multiplies by its mult.
    expect(pctMaxHpFactor(table, row, staticInput(1e4), 2)).toBeCloseTo(2 * 1e4 ** 0.12, 12);
  });
});

/** A run context on the first wave of `data`, spawned and gridded for tick 1. */
function spawned(data: GameData, stats: StatBlock = makeStats()): RunContext {
  const ctx = createRunContext(makeConfig({ stats }), data);
  ctx.now = 1;
  startDueWave(ctx);
  releaseEnemies(ctx);
  rebuildGrid(ctx);
  return ctx;
}

/** The input of a damage instance on `target` at the context's tick. */
const on = (ctx: RunContext, target: Enemy | null): EvalInput => ({
  now: ctx.now,
  target,
  chainJump: 0,
  playerLifeFrac: 1,
  comboStacks: 0,
  shardsHeld: 0,
  enemiesInAura: 0,
  highestHpId: 0,
  minionCount: 0,
  ctx: null,
});

const holds = (condition: Condition, target: Enemy | null, now: number): boolean =>
  conditionsMet([compileCondition(condition)], target, now, 0);

describe('scaling variables', () => {
  it('reads targetBurnStacks as the live burn stacks of the target, 0 without one', () => {
    const ctx = spawned(stationarySquares(1), makeStats({ burnDuration: 4 }));
    const target = ctx.enemies[0] as Enemy;
    const read = compileScaling({ per: 'targetBurnStacks' }).read;
    expect(read(on(ctx, target))).toBe(0);
    addBurn(ctx, target, num(1), ctx.now + 60, 0, CENTER);
    addBurn(ctx, target, num(1), ctx.now + 60, 0, CENTER);
    addBurn(ctx, target, num(1), ctx.now + 120, 0, CENTER);
    expect(read(on(ctx, target))).toBe(3);
    // A stack that ended no longer counts, before anything expires it.
    ctx.now += 60;
    expect(target.burns).toHaveLength(3);
    expect(read(on(ctx, target))).toBe(1);
    expect(read(on(ctx, null))).toBe(0);
  });

  it('reads targetDistance as the distance from the player, 0 without a target', () => {
    const ctx = spawned(stationarySquares(4));
    const scaling = compileScaling({ per: 'targetDistance', every: 100 });
    for (const enemy of ctx.enemies) {
      expect(enemy.dist).toBeGreaterThan(100);
      expect(scaling.read(on(ctx, enemy))).toBe(enemy.dist);
      expect(scaledValue(0.1, scaling, enemy.dist)).toBe(0.1 * Math.floor(enemy.dist / 100));
    }
    expect(scaling.read(on(ctx, null))).toBe(0);
  });

  it('reads lifeLostPct from the life the contact step leaves, 1 − life / max life', () => {
    const read = compileScaling({ per: 'lifeLostPct' }).read;
    const seen: { lost: number; life: number; maxLife: number; hits: number }[] = [];
    const module: TestModule = (b) =>
      b.hook('tick', (ctx) => {
        const hits = ctx.events.filter((event) => event.type === 'playerHit').length;
        const { life, maxLife } = ctx.player;
        seen.push({ lost: read(ctx.evalInput), life, maxLife, hits });
      });
    // Too weak to kill: the triangles reach the player and hurt it.
    const stats = makeStats({ damage: 1e-9, maxLife: 1000 });
    const sim = createSimulation(makeConfig({ stats, maxTicks: 600 }), makeTestData(), [module]);
    while (!sim.state.finished) sim.step(NO_INPUT);
    const first = seen.findIndex((tick) => tick.hits > 0);
    expect(first).toBeGreaterThan(0);
    for (const tick of seen.slice(0, first)) expect(tick.lost).toBe(0);
    for (const tick of seen.slice(first)) expect(tick.lost).toBe(1 - tick.life / tick.maxLife);
    expect(seen[first]?.lost).toBeGreaterThan(0);
  });

  it('reads shardsHeld and enemiesInAura from EvalInput, and 0 outside a run (C6b.3, G1)', () => {
    // Planted bugs: the readers swapped, or an estimate reading a held shard or an aura enemy.
    const table = modTableFor(
      makeStats({}, [
        {
          stat: 'damage',
          kind: 'more',
          value: 1,
          scaling: { per: 'shardsHeld', curve: 'powFactor', exponent: 0.12 },
        },
        { stat: 'damage', kind: 'increased', value: 0.02, scaling: { per: 'enemiesInAura' } },
      ]),
    );
    const row = table.row(rowKey(TAG.hit, CENTER));
    // No target needed: a run variable.
    const inRun: EvalInput = { ...staticInput(), shardsHeld: 1e4, enemiesInAura: 3 };
    expect(statAt(table, row, DAMAGE, inRun)).toBeCloseTo(1.06 * 1e4 ** 0.12, 12);
    expect(statAt(table, row, DAMAGE, { ...inRun, shardsHeld: 0 })).toBeCloseTo(1.06, 12);
    // Outside a run (estimates, describe, the DPS preview): × 1 and + 0.
    expect([staticInput().shardsHeld, staticInput().enemiesInAura]).toEqual([0, 0]);
    expect(statAt(table, row, DAMAGE, staticInput())).toBe(1);
  });
});

describe('conditions', () => {
  it('tells a triangle, a hexagon and a boss apart by targetKind', () => {
    // One triangle, with a hexagon (an elite wave) or a boss (a boss wave).
    const rules: WaveTable['rules'] = [
      { enemy: 'triangle', fromWave: 1, base: 1, perWave: 0, maxCount: 1 },
    ];
    const wave = (eliteEvery: number, bossEvery: number): GameData =>
      makeTestData({ waves: { rules, eliteEvery, bossEvery, spawnDurationSec: 0 } });
    const elite = spawned(wave(1, 1000));
    const boss = spawned(wave(1000, 1));
    const kinds = [...elite.enemies, ...boss.enemies].map((enemy) => [
      enemy.type,
      (['normal', 'elite', 'boss'] as const).filter((kind) =>
        holds({ targetKind: kind }, enemy, 1),
      ),
    ]);
    expect(kinds.sort()).toEqual(
      [
        ['boss', ['boss']],
        ['hexagon', ['elite']],
        ['triangle', ['normal']],
        ['triangle', ['normal']],
      ].sort(),
    );
    expect(holds({ targetKind: 'normal' }, null, 1)).toBe(false);
  });

  it('reads targetHas, stacksAtLeast and targetHpBelow on the target', () => {
    const ctx = spawned(stationarySquares(1, 1));
    const target = ctx.enemies[0] as Enemy;
    expect(holds({ targetHas: 'burn' }, target, ctx.now)).toBe(false);
    addBurn(ctx, target, num(1), ctx.now + 30, 0, CENTER);
    addBurn(ctx, target, num(1), ctx.now + 60, 0, CENTER);
    expect(holds({ targetHas: 'burn' }, target, ctx.now)).toBe(true);
    const two = { stacksAtLeast: { ailment: 'burn', stacks: 2 } } as const;
    expect(holds(two, target, ctx.now)).toBe(true);
    expect(holds(two, target, ctx.now + 30)).toBe(false);
    expect(holds({ targetHas: 'burn' }, target, ctx.now + 59)).toBe(true);
    expect(holds({ targetHas: 'burn' }, target, ctx.now + 60)).toBe(false);
    expect(holds({ targetHpBelow: 0.5 }, target, ctx.now)).toBe(false);
    target.hp = mul(target.maxHp, 0.49);
    expect(holds({ targetHpBelow: 0.5 }, target, ctx.now)).toBe(true);
    for (const condition of [
      { targetHas: 'burn' },
      two,
      { targetHpBelow: 1 },
    ] as const satisfies readonly Condition[]) {
      expect(holds(condition, null, ctx.now)).toBe(false);
    }
  });

  it("reads stacksAtLeast 'max' against the run's cap, never without a run", () => {
    const ctx = spawned(stationarySquares(1, 1), makeStats({ burnMaxStacks: 2 }));
    const target = ctx.enemies[0] as Enemy;
    const max = [compileCondition({ stacksAtLeast: { ailment: 'burn', stacks: 'max' } })];
    expect(max[0]?.b).toBe(0);
    addBurn(ctx, target, num(1), ctx.now + 30, 0, CENTER);
    expect(conditionsMet(max, target, ctx.now, 0, ctx)).toBe(false);
    addBurn(ctx, target, num(1), ctx.now + 60, 0, CENTER);
    expect(conditionsMet(max, target, ctx.now, 0, ctx)).toBe(true);
    // Live stacks only: one has ended at +30.
    expect(conditionsMet(max, target, ctx.now + 30, 0, ctx)).toBe(false);
    // No run, no cap: not met, whatever the stacks; no target, not met either.
    expect(conditionsMet(max, target, ctx.now, 0)).toBe(false);
    expect(conditionsMet(max, target, ctx.now, 0, null)).toBe(false);
    expect(conditionsMet(max, null, ctx.now, 0, ctx)).toBe(false);
    // An estimate's input has no run.
    expect(staticInput().ctx).toBeNull();
    expect(() => compileCondition({ stacksAtLeast: { ailment: 'poison', stacks: 'max' } })).toThrow(
      "stacksAtLeast 'max' needs a stack cap, which poison has not",
    );
  });

  it('reads hitIs, victimHas and killedBy from the flags, without a target', () => {
    const crit = HIT_EVENT | CRIT_HIT;
    const jump = HIT_EVENT | CHAIN_JUMP;
    const flagged = (condition: Condition, flags: number): boolean =>
      conditionsMet([compileCondition(condition)], null, 0, flags);
    expect([0, HIT_EVENT, crit, jump].map((f) => flagged({ hitIs: 'crit' }, f))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect([0, HIT_EVENT, crit, jump].map((f) => flagged({ hitIs: 'nonCrit' }, f))).toEqual([
      false,
      true,
      false,
      true,
    ]);
    // An attack's primary hit carries PRIMARY; an effect's hit (HIT alone) is not primary.
    const primary = HIT_EVENT | PRIMARY;
    expect(
      [0, HIT_EVENT, primary, primary | CRIT_HIT, jump, jump | PRIMARY].map((f) =>
        flagged({ hitIs: 'primary' }, f),
      ),
    ).toEqual([false, false, true, true, false, false]);
    expect([0, HIT_EVENT, crit, jump].map((f) => flagged({ hitIs: 'chainJump' }, f))).toEqual([
      false,
      false,
      false,
      true,
    ]);
    const burning = heldFlag('burn');
    expect(flagged({ victimHas: 'burn' }, burning | killKindFlag('hit'))).toBe(true);
    expect(flagged({ victimHas: 'burn' }, killKindFlag('hit'))).toBe(false);
    expect(flagged({ killedBy: 'burn' }, burning | killKindFlag('burn'))).toBe(true);
    expect(flagged({ killedBy: 'burn' }, burning | killKindFlag('hit'))).toBe(false);
    expect(flagged({ killedBy: 'hit' }, crit | killKindFlag('hit'))).toBe(true);
  });

  it('reads targetState on the target’s record, which no M1 enemy has, and targetFrostAtLeast on its chill meter, a frozen one’s full (docs/v3 C7 design §2.5)', () => {
    const dashing = { targetState: 'dashing' } as const;
    const stopped = { targetState: 'stopped' } as const;
    const third = { targetFrostAtLeast: 0.3 } as const;
    expect([dashing, stopped, third].map((condition) => compileCondition(condition))).toEqual([
      { code: 7, a: DASHING, b: 0 },
      { code: 7, a: STOPPED, b: 0 },
      { code: 8, a: 0.3, b: 0 },
    ]);
    const ctx = placedEnemies(
      [
        { x: 1300, y: 540, type: 'dasher' },
        { x: 1300, y: 540, type: 'boss' },
      ],
      { data: v3TestData() },
    );
    const [dasher, boss] = ctx.enemies as [Enemy, Enemy];
    const record = dasher.v3 as EnemyV3;
    const states = (): boolean[] => [holds(dashing, dasher, 1), holds(stopped, dasher, 1)];
    const seen = [0, CHARGING | STOPPED, DASHING, ORBITING, FLEEING].map((state) => {
      record.state = state;
      return states();
    });
    expect(seen).toEqual([
      [false, false],
      [false, true],
      [true, false],
      [false, false],
      [false, false],
    ]);
    const m1 = placedEnemies([{ x: 1300, y: 540, type: 'square' }]);
    const square = m1.enemies[0] as Enemy;
    expect(square.v3).toBeNull();
    expect([holds(dashing, square, 1), holds(stopped, square, 1)]).toEqual([false, false]);
    // The chill meter: at least 0.3, a frozen enemy's full; a boss never freezes.
    expect([0.29, 0.3, 1].map((frost) => holds(third, { ...dasher, frost }, 1))).toEqual([
      false,
      true,
      true,
    ]);
    dasher.frost = 0;
    dasher.frozenUntil = 10;
    expect([holds(third, dasher, 9), holds(third, dasher, 10)]).toEqual([true, false]);
    boss.frost = 0.2;
    boss.frozenUntil = 10;
    expect(holds(third, boss, 9)).toBe(false);
    for (const condition of [dashing, stopped, third])
      expect(holds(condition, null, 1)).toBe(false);
  });

  it('throws on the properties of a trigger itself', () => {
    for (const condition of [
      { chance: 0.5 },
      { cooldownSec: 1 },
      { hitIs: 'signature' },
    ] as const satisfies readonly Condition[]) {
      expect(() => compileCondition(condition)).toThrow(/per-event/);
    }
  });
});

describe('statAt with conditions (Modifier.when)', () => {
  it('applies a when targetHas entry only to instances on a burning target', () => {
    const ctx = spawned(stationarySquares(2));
    const [burning, clean] = ctx.enemies as [Enemy, Enemy];
    const table = modTableFor(
      makeStats({ critChance: 0.1 }, [
        { stat: 'damage', kind: 'more', value: 1, when: [{ targetHas: 'burn' }] },
        { stat: 'critChance', kind: 'flat', value: 0.2, when: [{ targetHas: 'burn' }] },
        { stat: 'damage', kind: 'increased', value: 0.5 },
      ]),
    );
    const row = table.row(TAG.hit);
    // Dynamic entries, out of the folded values and the estimates.
    expect(table.dynCount[row * S + DAMAGE]).toBe(1);
    expect(table.final[row * S + CRIT_CHANCE]).toBe(0.1);
    expect(table.damage(TAG.hit)).toBe(1.5);
    expect(statAt(table, row, DAMAGE, staticInput())).toBe(1.5);
    addBurn(ctx, burning, num(1), ctx.now + 30, 0, CENTER);
    expect(statAt(table, row, DAMAGE, on(ctx, burning))).toBe(1.5 * 2);
    expect(statAt(table, row, CRIT_CHANCE, on(ctx, burning))).toBe(0.1 + 0.2);
    expect(statAt(table, row, DAMAGE, on(ctx, clean))).toBe(1.5);
    expect(statAt(table, row, CRIT_CHANCE, on(ctx, clean))).toBe(0.1);
    // Once the burn has ended, the target no longer holds it.
    ctx.now += 30;
    expect(statAt(table, row, DAMAGE, on(ctx, burning))).toBe(1.5);
  });

  it('applies a scaling entry with conditions only when they hold', () => {
    const ctx = spawned(stationarySquares(1, 1));
    const target = ctx.enemies[0] as Enemy;
    const table = modTableFor(
      makeStats({}, [
        {
          stat: 'damage',
          kind: 'increased',
          value: 0.1,
          scaling: { per: 'targetBurnStacks' },
          when: [{ targetHpBelow: 0.5 }],
        },
      ]),
    );
    const row = table.row(TAG.hit);
    for (let s = 0; s < 3; s++) addBurn(ctx, target, num(1), ctx.now + 30, 0, CENTER);
    expect(statAt(table, row, DAMAGE, on(ctx, target))).toBe(1);
    target.hp = mul(target.maxHp, 0.25);
    expect(statAt(table, row, DAMAGE, on(ctx, target))).toBe(1 + 0.1 * 3);
  });
});

describe('comboAtLeast (E14, lead ruling Z3)', () => {
  /** comboAtLeast compiled as a trigger's condition, which it alone can be. */
  const combo = (stacks: number | 'full'): CompiledCondition[] => [
    compileCondition({ comboAtLeast: stacks }, 'nthAttack'),
  ];
  /** A run with one enemy and its stacks at `stacks` (the combo system's own state). */
  const run = (stacks: number, options: { stats?: StatBlock; modules?: TestModule[] } = {}) => {
    const ctx = placedEnemies([{ x: 1300, y: 540 }], options);
    ctx.sys.combo.stacks = stacks;
    return ctx;
  };
  const holdsIn = (ctx: RunContext, conds: CompiledCondition[], withTarget = true): boolean =>
    conditionsMet(conds, withTarget ? (ctx.enemies[0] as Enemy) : null, ctx.now, 0, ctx);

  it('compiles a count to code 10, after targetIs’ 9, with the count as a, and full to a = −1', () => {
    expect(combo(1)).toEqual([{ code: 10, a: 1, b: 0 }]);
    expect(combo(15)).toEqual([{ code: 10, a: 15, b: 0 }]);
    expect(combo('full')).toEqual([{ code: 10, a: -1, b: 0 }]);
    expect(compileCondition({ targetIs: 'highestHp' }).code).toBe(9);
  });

  it('holds at n stacks and above, never below: n − 1, n and n + 1 for n = 1, 5 and 20', () => {
    // Plants `>` for `>=`: it would fail at n itself.
    for (const n of [1, 5, 20]) {
      const seen = [n - 1, n, n + 1].map((stacks) => holdsIn(run(stacks), combo(n)));
      expect(seen, `n = ${n}`).toEqual([false, true, true]);
    }
  });

  it('reads full as BuildFlags.comboFull: 25 with the comboCap stat at 25, 20 under a module’s Infinity cap', () => {
    // Plants 'full' read as comboCap: under ★無盡連擊's Infinity it would never hold, and at 25
    // it would read the same 25 (so the Infinity case kills it).
    const stat = (stacks: number) => run(stacks, { stats: makeStats({ comboCap: 25 }) });
    expect(stat(0).build.flags.comboFull).toBe(25);
    expect([24, 25, 26].map((stacks) => holdsIn(stat(stacks), combo('full')))).toEqual([
      false,
      true,
      true,
    ]);
    const endless: TestModule = (b) => {
      b.flags.comboCap = Infinity;
    };
    const lifted = (stacks: number) =>
      run(stacks, { stats: makeStats({ comboCap: 30 }), modules: [endless] });
    expect([lifted(0).build.flags.comboCap, lifted(0).build.flags.comboFull]).toEqual([
      Infinity,
      20,
    ]);
    expect([19, 20, 45].map((stacks) => holdsIn(lifted(stacks), combo('full')))).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('needs no target: it holds on an event without an enemy as on one with an enemy', () => {
    // Plants the condition checked after the target-null return: without a target it would
    // never hold (a periodic or waveStart trigger never fires).
    for (const conds of [combo(3), combo('full')]) {
      expect([holdsIn(run(20), conds, false), holdsIn(run(20), conds, true)]).toEqual([true, true]);
      expect([holdsIn(run(2), conds, false), holdsIn(run(2), conds, true)]).toEqual([false, false]);
    }
    // Beside a target condition, which still needs the target.
    const both = [...combo(3), compileCondition({ targetKind: 'normal' })];
    expect([holdsIn(run(5), both, false), holdsIn(run(5), both, true)]).toEqual([false, true]);
    // And beside a flags condition, which does not.
    const flagged = [compileCondition({ hitIs: 'crit' }, 'hit'), ...combo(3)];
    const ctx = run(5);
    expect(conditionsMet(flagged, null, ctx.now, HIT_EVENT | CRIT_HIT, ctx)).toBe(true);
    expect(conditionsMet(flagged, null, ctx.now, HIT_EVENT, ctx)).toBe(false);
  });

  it('never holds outside a run (ctx null), whatever the stacks, with or without a target', () => {
    // Plants the condition met with ctx null: the estimates (staticInput, ctx null) would meet it.
    const ctx = run(20);
    const target = ctx.enemies[0] as Enemy;
    for (const conds of [combo(1), combo('full')]) {
      expect(conditionsMet(conds, target, ctx.now, 0, null)).toBe(false);
      expect(conditionsMet(conds, null, ctx.now, 0, null)).toBe(false);
      expect(conditionsMet(conds, target, ctx.now, 0)).toBe(false);
      expect(conditionsMet(conds, target, ctx.now, 0, ctx)).toBe(true);
    }
    expect(staticInput().ctx).toBeNull();
  });

  it('refuses at compile a modifier’s comboAtLeast and a count that is not a whole number of at least 1', () => {
    // Plants the condition taken on a modifier (compileMods passes no event), and a count of 0.
    expect(() => compileCondition({ comboAtLeast: 5 })).toThrow(
      "comboAtLeast is a trigger's condition, not a modifier's (got 5)",
    );
    expect(() => compileCondition({ comboAtLeast: 'full' })).toThrow(/not a modifier's/);
    const sources = createSourceTable();
    const mod = {
      stat: 'damage',
      kind: 'more',
      value: 1,
      when: [{ comboAtLeast: 5 }],
    } as unknown as Modifier;
    expect(() => compileMods([mod], sources)).toThrow(/not a modifier's/);
    for (const [stacks, shown] of [
      [0, '0'],
      [1.5, '1.5'],
      [-1, '-1'],
      [Number.NaN, 'NaN'],
      [Infinity, 'Infinity'],
    ] as const) {
      expect(() => compileCondition({ comboAtLeast: stacks }, 'periodic')).toThrow(
        `comboAtLeast: ${shown} must be a whole number >= 1 or 'full'`,
      );
    }
  });
});

describe('inAura (E15, lead rulings 19 and W2)', () => {
  const IN_AURA: CompiledCondition[] = [compileCondition({ inAura: true })];
  /** An outer.aura grant (微光's), and the stats of a build with one and these values and mods. */
  const AURA = { source: 'outer.aura', grant: { kind: 'aura' } } as const;
  const auraStats = (
    values: Partial<Record<StatId, number>> = {},
    emitters: readonly SourcedEmitter[] = [AURA],
  ): StatBlock => makeStats(values, [], { triggers: [], conversions: [], emitters });
  /** The stats the talent screen folds from `mods` (computeStatBlock), with 微光's aura. */
  const folded = (mods: Modifier[]): StatBlock =>
    computeStatBlock(mods, { triggers: [], conversions: [], emitters: [AURA] });
  /** A run of `stats` with one enemy at each offset from the player, standing still. */
  const run = (
    offsets: readonly (readonly [number, number])[],
    stats: StatBlock = auraStats(),
    modules: TestModule[] = [],
  ): RunContext => {
    const centre = placedEnemies([], { stats });
    const { x, y } = centre.player;
    return placedEnemies(
      offsets.map(([dx, dy]) => ({ x: x + dx, y: y + dy })),
      { stats, modules },
    );
  };
  /** inAura on each enemy of `ctx`, in id order. */
  const inside = (ctx: RunContext, conds: CompiledCondition[] = IN_AURA): boolean[] =>
    ctx.enemies.map((e) => conditionsMet(conds, e, ctx.now, 0, ctx));
  /** r − ε, r and r + ε along x, then r along a diagonal (0.6r, 0.8r), ε = 1/1024: exact squares. */
  const EPS = 1 / 1024;
  const around = (r: number): [number, number][] => [
    [r - EPS, 0],
    [r, 0],
    [r + EPS, 0],
    [0, -(r + EPS)],
    [-0.6 * r, 0.8 * r],
  ];

  it('compiles to code 11, after comboAtLeast’s 10, with no operands, and refuses false', () => {
    expect(IN_AURA).toEqual([{ code: 11, a: 0, b: 0 }]);
    expect(compileCondition({ comboAtLeast: 1 }, 'hit').code).toBe(10);
    // On a trigger's event as on a modifier's.
    expect(compileCondition({ inAura: true }, 'hit')).toEqual({ code: 11, a: 0, b: 0 });
    // A module's addModifier passes no validation (plants false read as true).
    expect(() => compileCondition({ inAura: false } as unknown as Condition)).toThrow(
      'inAura: false must be true',
    );
  });

  it('holds at r − ε and r, not at r + ε, on the pulse’s reach: auraRadius 160 (exact squares)', () => {
    // Plants `<` for `<=` (r itself would fail) and a test on x alone (0, r + ε would pass).
    const ctx = run(around(160));
    expect([160 - EPS, 160, 160 + EPS].map((d) => d * d)).toEqual([
      25599.6875 + EPS * EPS,
      25600,
      25600.3125 + EPS * EPS,
    ]);
    expect(0.6 * 160 * (0.6 * 160) + 0.8 * 160 * (0.8 * 160)).toBe(25600);
    expect(inside(ctx)).toEqual([true, true, false, false, true]);
    expect(auraReachSq(ctx.build)).toBe(25600);
    // The pulse's own reach: what a pulse would hit, the grid's count of the same test.
    rebuildGrid(ctx);
    expect(enemiesInAura(ctx)).toBe(3);
  });

  it('reads the auraRadius stat as the build folds it, a modifier’s 25% making it 200', () => {
    // Plants the base stat read in place of the build's value.
    const stats = folded([{ stat: 'auraRadius', kind: 'increased', value: 0.25 }]);
    const ctx = run([...around(200), [180, 0]], stats);
    expect(ctx.build.values.auraRadius).toBe(200);
    expect(inside(ctx)).toEqual([true, true, false, false, true, true]);
  });

  it('reads the reach as the build sizes it: areaSize 1.5 makes 160 a reach of 240', () => {
    // Plants the unsized auraRadius: 220 would be outside 160.
    const ctx = run([...around(240), [220, 0]], auraStats({ areaSize: 1.5 }));
    expect([ctx.build.flags.areaFactor, ctx.build.values.auraRadius]).toEqual([1.5, 160]);
    expect(inside(ctx)).toEqual([true, true, false, false, true, true]);
    // And with both, folded: 200 × 1.5 = 300.
    const both = run(
      around(300),
      folded([
        { stat: 'auraRadius', kind: 'increased', value: 0.25 },
        { stat: 'areaSize', kind: 'flat', value: 0.5 },
      ]),
    );
    expect([both.build.flags.areaFactor, both.build.values.auraRadius]).toEqual([1.5, 200]);
    expect(inside(both)).toEqual([true, true, false, false, true]);
  });

  it('reads the reach through 巨大化’s sizeFactor too: × 1.25 makes 160 a reach of 200, as the pulse’s', () => {
    // Plants a private reach of auraRadius × areaSize, which drops a module's sizeFactor.
    const giant: TestModule = (b) => {
      b.flags.sizeFactor = 1.25;
    };
    const ctx = run(around(200), auraStats(), [giant]);
    expect([ctx.build.flags.areaFactor, auraReachSq(ctx.build)]).toEqual([1.25, 40000]);
    expect(inside(ctx)).toEqual([true, true, false, false, true]);
    rebuildGrid(ctx);
    expect(enemiesInAura(ctx)).toBe(3);
  });

  it('never holds outside a run (ctx null) or without a target, even at the player’s centre', () => {
    // Plants the condition met with ctx null: the estimates and describe would meet it.
    const ctx = run([[0, 0]]);
    const target = ctx.enemies[0] as Enemy;
    expect(conditionsMet(IN_AURA, target, ctx.now, 0, ctx)).toBe(true);
    expect(conditionsMet(IN_AURA, target, ctx.now, 0, null)).toBe(false);
    expect(conditionsMet(IN_AURA, target, ctx.now, 0)).toBe(false);
    expect(conditionsMet(IN_AURA, null, ctx.now, 0, ctx)).toBe(false);
    expect(staticInput().ctx).toBeNull();
  });

  it('never holds in a run without an aura emitter, whatever auraRadius, and holds with a module’s', () => {
    // Plants the emitter check dropped, or read from the nodes' grants alone.
    const none = run([[0, 0]], auraStats({ auraRadius: 1e6 }, []));
    expect([none.build.flags.hasAura, inside(none)[0]]).toEqual([false, false]);
    // Other grants are no aura.
    const thorns = run(
      [[0, 0]],
      auraStats({}, [{ source: 'outer.thorns', grant: { kind: 'thorns' } }]),
    );
    expect(inside(thorns)).toEqual([false]);
    // A module's addEmitter grants one, of any source.
    const granted: TestModule = (b) => b.addEmitter('hub', { kind: 'aura' });
    const moduled = run([[0, 0]], auraStats({}, []), [granted]);
    expect([moduled.build.flags.hasAura, inside(moduled)[0]]).toEqual([true, true]);
    // A module's own write to the flag gives no aura: compileBuild sets it from the emitters.
    const forged: TestModule = (b) => {
      b.flags.hasAura = true;
    };
    const lied = run([[0, 0]], auraStats({}, []), [forged]);
    expect([lied.build.flags.hasAura, inside(lied)[0]]).toEqual([false, false]);
    // Every source's aura counts: hub's alone.
    const hub = run([[100, 0]], auraStats({}, [{ source: 'hub', grant: { kind: 'aura' } }]));
    expect([hub.build.flags.hasAura, inside(hub)[0]]).toEqual([true, true]);
  });

  it('reads the target as it stands when checked, beside the other target conditions', () => {
    const ctx = run([[100, 0]]);
    const target = ctx.enemies[0] as Enemy;
    expect(inside(ctx)).toEqual([true]);
    target.x += 61;
    expect(inside(ctx)).toEqual([false]);
    target.x -= 1;
    expect(inside(ctx)).toEqual([true]);
    const both = [...IN_AURA, compileCondition({ targetKind: 'elite' })];
    expect(inside(ctx, both)).toEqual([false]);
    expect(inside(ctx, [...IN_AURA, compileCondition({ targetKind: 'normal' })])).toEqual([true]);
  });
});
