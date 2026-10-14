import { describe, expect, it } from 'vitest';
import { mul, num } from '../../core/num';
import { SCOPED_STATS } from '../../data/stats';
import type { Modifier, StatBlock } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { Condition, ScalingSpec } from '../../data/triggers';
import type { GameData, WaveTable } from '../../data/types';
import { addBurn } from '../ailments/records';
import { CHAIN_JUMP, CRIT_HIT, heldFlag, HIT_EVENT, killKindFlag } from '../effects/flags';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { createRunContext } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
import { releaseEnemies } from '../systems/spawn';
import { startDueWave } from '../systems/waves';
import { makeConfig, makeStats, makeTestData, stationarySquares } from '../testing';
import { NO_INPUT } from '../types';
import {
  compileCondition,
  compileScaling,
  conditionsMet,
  scaledValue,
  statAt,
  staticInput,
} from './eval';
import type { EvalInput } from './eval';
import { compileMods, ModTable, modTableFor, SCOPED_INDEX } from './modTable';
import { createSourceTable, rowKey } from './sources';

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
});

const holds = (condition: Condition, target: Enemy | null, now: number): boolean =>
  conditionsMet([compileCondition(condition)], target, now, 0);

describe('scaling variables', () => {
  it('reads targetBurnStacks as the live burn stacks of the target, 0 without one', () => {
    const ctx = spawned(stationarySquares(1), makeStats({ burnDuration: 4 }));
    const target = ctx.enemies[0] as Enemy;
    const read = compileScaling({ per: 'targetBurnStacks' }).read;
    expect(read(on(ctx, target))).toBe(0);
    addBurn(ctx, target, num(1), ctx.now + 60, 0);
    addBurn(ctx, target, num(1), ctx.now + 60, 0);
    addBurn(ctx, target, num(1), ctx.now + 120, 0);
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
    addBurn(ctx, target, num(1), ctx.now + 30, 0);
    addBurn(ctx, target, num(1), ctx.now + 60, 0);
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
    expect([0, HIT_EVENT, crit, jump].map((f) => flagged({ hitIs: 'primary' }, f))).toEqual([
      false,
      true,
      true,
      false,
    ]);
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
    addBurn(ctx, burning, num(1), ctx.now + 30, 0);
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
    for (let s = 0; s < 3; s++) addBurn(ctx, target, num(1), ctx.now + 30, 0);
    expect(statAt(table, row, DAMAGE, on(ctx, target))).toBe(1);
    target.hp = mul(target.maxHp, 0.25);
    expect(statAt(table, row, DAMAGE, on(ctx, target))).toBe(1 + 0.1 * 3);
  });
});
