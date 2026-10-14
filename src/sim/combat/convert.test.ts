import { describe, expect, it } from 'vitest';
import { add, mul, num, toNumber } from '../../core/num';
import type { Num } from '../../core/num';
import type { Modifier, StatBlock, StatExtras } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { DamageTag } from '../../data/tags';
import type { ConversionSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { addShock } from '../ailments/shock';
import { modTableFor } from '../build/modTable';
import type { ModTable } from '../build/modTable';
import { createSourceTable, rowKey } from '../build/sources';
import { createPayload, SLOT_BURN, SLOT_BURN_CRIT, slotRow } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { createRunContext } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
import { releaseEnemies } from '../systems/spawn';
import { startDueWave } from '../systems/waves';
import { eventsOf, makeConfig, makeStats, makeTestData, stationarySquares } from '../testing';
import { NO_INPUT } from '../types';
import type { RunConfig, SimEvent } from '../types';
import { chainAttack } from './chain';
import { hitWithPayload } from './hit';

const { hit: HIT, projectile: PROJECTILE, crit: CRIT, chain: CHAIN, minion: MINION } = TAG;
const { poison: POISON, bleed: BLEED, cold: COLD, burn: BURN } = TAG;

/** Stat extras with these conversions, credited to the center as an M1 node's would be. */
const converting = (...specs: ConversionSpec[]): StatExtras => ({
  triggers: [],
  conversions: specs.map((spec) => ({ source: 'center', spec })),
});

const more = (value: number, ...tags: DamageTag[]): Modifier => ({
  stat: 'damage',
  kind: 'more',
  value,
  ...(tags.length === 0 ? {} : { tags }),
});

/** The conversion parts of `row`: share, row key and the row looked up so far. */
function partsOf(table: ModTable, row: number) {
  const start = table.convStart[row] as number;
  return Array.from({ length: table.convCount[row] as number }, (_, i) => ({
    share: table.convShare[start + i] as number,
    key: table.convKey[start + i] as number,
    row: table.convRow[start + i] as number,
  }));
}

/** A run context on `count` immortal stationary squares, spawned and gridded for tick 1. */
function contextOn(stats: StatBlock, count = 2, modules: readonly TestModule[] = []): RunContext {
  const ctx = createRunContext(makeConfig({ stats }), stationarySquares(count), modules);
  ctx.now = 1;
  startDueWave(ctx);
  releaseEnemies(ctx);
  rebuildGrid(ctx);
  return ctx;
}

const signaturePayload = (ctx: RunContext): Payload => (ctx.emitters[0] as EmitterRuntime).payload;

const hitsOf = (events: readonly SimEvent[]) =>
  events.flatMap((event) => (event.type === 'hit' ? [event] : []));

/** One primary hit of `p` on the first enemy, with no forced crit and no chain retention. */
function hitOnce(ctx: RunContext, p: Payload = signaturePayload(ctx)): Enemy {
  const enemy = ctx.enemies[0] as Enemy;
  hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, 0, -1);
  return enemy;
}

/** The run's damage tallies by kind, as numbers. */
const tallies = (ctx: RunContext) => ({
  hit: toNumber(ctx.damageHit),
  crit: toNumber(ctx.damageCrit),
  chain: toNumber(ctx.damageChain),
  burn: toNumber(ctx.damageBurn),
  poison: toNumber(ctx.damagePoison),
  bleed: toNumber(ctx.damageBleed),
});

const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 } as const;

describe('conversion parts of a ModTable row', () => {
  it('lists the share left as a hit on the row itself, then each conversion on its converted tags', () => {
    const stats = makeStats(
      {},
      [],
      converting(
        { to: 'poison', fraction: 0.3 },
        { tags: ['projectile'], to: 'cold', fraction: 0.2 },
      ),
    );
    const sources = createSourceTable();
    const fusion = sources.index('fusion.fire.poison');
    const table = modTableFor(stats, sources);
    const key = rowKey(HIT | PROJECTILE | CRIT, fusion);
    const row = table.row(key);
    // Delivery tags, crit and the source stay; poison replaces the kind, cold joins the hit.
    expect(partsOf(table, row)).toEqual([
      { share: 0.5, key, row },
      { share: 0.3, key: rowKey(POISON | PROJECTILE | CRIT, fusion), row: -1 },
      { share: 0.2, key: rowKey(HIT | PROJECTILE | CRIT | COLD, fusion), row: -1 },
    ]);
    // A part's row is looked up on first use and kept.
    const start = table.convStart[row] as number;
    const poisonRow = table.partRow(start + 1);
    expect(poisonRow).toBe(table.row(rowKey(POISON | PROJECTILE | CRIT, fusion)));
    expect(table.convRow[start + 1]).toBe(poisonRow);
    // A jump has no projectile tag: only the untagged conversion takes it.
    const jumpRow = table.row(rowKey(HIT | CHAIN, 0));
    expect(partsOf(table, jumpRow)).toEqual([
      { share: 0.7, key: rowKey(HIT | CHAIN, 0), row: jumpRow },
      { share: 0.3, key: rowKey(POISON | CHAIN, 0), row: -1 },
    ]);
    // Only hits convert.
    for (const tags of [BURN, POISON | PROJECTILE, BLEED | CRIT, PROJECTILE]) {
      expect(table.convCount[table.row(rowKey(tags, 0))], `tags ${tags}`).toBe(0);
    }
  });

  it('scales shares adding up to more than 1 down to the whole hit, keeping nothing a hit', () => {
    const stats = makeStats(
      {},
      [],
      converting({ to: 'poison', fraction: 0.6 }, { to: 'bleed', fraction: 0.9 }),
    );
    const table = modTableFor(stats);
    const row = table.row(rowKey(HIT, 0));
    const parts = partsOf(table, row);
    expect(parts.map((part) => part.key)).toEqual([rowKey(POISON, 0), rowKey(BLEED, 0)]);
    expect(parts[0]?.share).toBeCloseTo(0.4, 15);
    expect(parts[1]?.share).toBeCloseTo(0.6, 15);
  });

  it('lists no parts without conversions', () => {
    const table = modTableFor(makeStats());
    expect(table.convCount[table.row(rowKey(HIT | PROJECTILE, 0))]).toBe(0);
  });
});

describe('converted hits', () => {
  it('splits 30% hit → poison into 0.7 [hit|projectile] and 0.3 [poison|projectile] of one source', () => {
    // [projectile] ×4 reaches both parts, [poison] ×2 the poison part only.
    const stats = makeStats(
      NO_ROLLS,
      [more(3, 'projectile'), more(1, 'poison')],
      converting({ to: 'poison', fraction: 0.3 }),
    );
    const ctx = contextOn(stats);
    const enemy = hitOnce(ctx);
    const [hit] = hitsOf(ctx.events);
    // One hit: one event with the hit's tags and the whole amount.
    expect(hitsOf(ctx.events)).toHaveLength(1);
    expect(hit).toMatchObject({ tags: HIT | PROJECTILE, source: 0, crit: false });
    const t = tallies(ctx);
    expect(t.hit).toBeCloseTo(10 * 0.7 * 4, 12);
    expect(t.poison).toBeCloseTo(10 * 0.3 * 4 * 2, 12);
    expect([t.crit, t.chain, t.burn, t.bleed]).toEqual([0, 0, 0, 0]);
    expect(toNumber(hit?.amount as Num)).toBe(t.hit + t.poison);
    expect(ctx.bySource[0]).toBe(hit?.amount);
    // The poison part is dealt at once: it applies no poison.
    expect(enemy.poisonStacks).toBe(0);
    expect(enemy.dotRings).toBe(0);
    expect(ctx.events.some((event) => event.type === 'ailmentApplied')).toBe(false);
  });

  it('keeps a minion tag on the converted part, so [minion] bonuses still reach it', () => {
    const stats = makeStats(
      NO_ROLLS,
      [more(1, 'minion')],
      converting({ to: 'poison', fraction: 0.3 }),
    );
    const ctx = contextOn(stats);
    const drone = createPayload({ ...signaturePayload(ctx), tags: HIT | MINION });
    hitOnce(ctx, drone);
    expect(hitsOf(ctx.events)).toMatchObject([{ tags: HIT | MINION }]);
    expect(tallies(ctx).hit).toBeCloseTo(10 * 0.7 * 2, 12);
    expect(tallies(ctx).poison).toBeCloseTo(10 * 0.3 * 2, 12);
    const start = ctx.table.convStart[slotRow(ctx.build, drone, 0)] as number;
    expect((ctx.table.convKey[start + 1] as number) & (POISON | MINION | HIT)).toBe(
      POISON | MINION,
    );
  });

  it('keeps crit on the converted part: [crit] bonuses reach both parts, tallied crit and poison', () => {
    const stats = makeStats(
      { ...NO_ROLLS, critChance: 1, critMultiplier: 2 },
      [more(1, 'crit')],
      converting({ to: 'poison', fraction: 0.3 }),
    );
    const ctx = contextOn(stats);
    hitOnce(ctx);
    expect(hitsOf(ctx.events)).toMatchObject([{ crit: true, tags: HIT | PROJECTILE | CRIT }]);
    const t = tallies(ctx);
    expect(t.hit).toBe(0);
    expect(t.crit).toBeCloseTo(10 * 2 * 0.7 * 2, 12);
    expect(t.poison).toBeCloseTo(10 * 2 * 0.3 * 2, 12);
  });

  it('keeps an element part a hit: it takes [cold] bonuses and is tallied as a hit', () => {
    const stats = makeStats(
      NO_ROLLS,
      [more(1, 'hit'), more(1, 'cold')],
      converting({ to: 'cold', fraction: 0.5 }),
    );
    const ctx = contextOn(stats);
    hitOnce(ctx);
    const t = tallies(ctx);
    expect(t.hit).toBeCloseTo(10 * 0.5 * 2 + 10 * 0.5 * 4, 12);
    expect(t.poison + t.bleed + t.burn).toBe(0);
  });

  it('splits a hit whose conversions add up to more than 1 in proportion, keeping no hit part', () => {
    const stats = makeStats(
      NO_ROLLS,
      [],
      converting({ to: 'poison', fraction: 0.6 }, { to: 'bleed', fraction: 0.9 }),
    );
    const ctx = contextOn(stats);
    const enemy = hitOnce(ctx);
    const t = tallies(ctx);
    expect(t.hit).toBe(0);
    expect(t.poison).toBeCloseTo(4, 12);
    expect(t.bleed).toBeCloseTo(6, 12);
    expect(enemy.bleedUntil).toBe(0);
  });

  it('converts only the hits that carry the conversion tags, and credits jumps to their source', () => {
    const stats = makeStats(
      { ...NO_ROLLS, chainCount: 1, chainRange: 5000, chainRetention: 1 },
      [{ ...more(1, 'poison'), scope: 'fusion' }],
      converting({ tags: ['chain'], to: 'poison', fraction: 0.5 }),
    );
    const ctx = contextOn(stats);
    const fusion = ctx.sources.index('fusion.fire.poison');
    const p = createPayload({ ...signaturePayload(ctx), jumpSource: fusion });
    chainAttack(ctx, p, ctx.enemies[0] as Enemy, 1, false, 0, -1);
    const [primary, jump] = hitsOf(ctx.events);
    expect(primary).toMatchObject({ chainIndex: 0, source: 0, amount: 10 });
    // The jump's poison part keeps the jump's source, so the fusion-scoped bonus reaches it.
    expect(jump).toMatchObject({ chainIndex: 1, source: fusion, tags: HIT | CHAIN });
    expect(toNumber(jump?.amount as Num)).toBeCloseTo(10 * 0.5 + 10 * 0.5 * 2, 12);
    expect(ctx.bySource[0]).toBe(10);
    expect(toNumber(ctx.bySource[fusion] as Num)).toBeCloseTo(15, 12);
    expect(tallies(ctx)).toMatchObject({ hit: 10, poison: 10 });
    expect(tallies(ctx).chain).toBeCloseTo(5, 12);
  });

  it('scales the parts alike through takenMult and the modifyDamage hooks', () => {
    const doubled: TestModule = (b) =>
      b.hook('modifyDamage', (_ctx, _hit, amount) => mul(amount, 2));
    const stats = makeStats(
      { ...NO_ROLLS, shockEffect: 0.5 },
      [],
      converting({ to: 'poison', fraction: 0.25 }),
    );
    const ctx = contextOn(stats, 2, [doubled]);
    addShock(ctx, ctx.enemies[0] as Enemy, 1, 0);
    hitOnce(ctx);
    const [hit] = hitsOf(ctx.events);
    // 10 × 1.5 (one shock stack) × 2 (the hook), three quarters a hit and a quarter poison.
    expect(hit?.amount).toBe(30);
    expect(tallies(ctx)).toMatchObject({ hit: 22.5, poison: 7.5 });
  });

  it('tallies damage a hook adds to a converted hit of 0 on its first part, not as NaN', () => {
    const flat: TestModule = (b) =>
      b.hook('modifyDamage', (_ctx, _hit, amount) => add(amount, num(5)));
    const stats = makeStats(
      { ...NO_ROLLS, damage: 0 },
      [],
      converting({ to: 'poison', fraction: 0.25 }),
    );
    const ctx = contextOn(stats, 2, [flat]);
    hitOnce(ctx);
    expect(hitsOf(ctx.events)[0]?.amount).toBe(5);
    expect(tallies(ctx)).toMatchObject({ hit: 5, poison: 0 });
  });

  it('leaves ailments to the hit: its burns and their rows are those of the unconverted hit', () => {
    const values = { damage: 10, attackSpeed: 4, critChance: 0.3, igniteChance: 0.6 };
    const run = (extras?: StatExtras) =>
      recorded(makeConfig({ stats: makeStats(values, [], extras), maxTicks: 600 }));
    const plain = run();
    const converted = run(converting({ to: 'bleed', fraction: 0.4 }));
    expect(eventsOf(converted.ticks, 'ignite')).toEqual(eventsOf(plain.ticks, 'ignite'));
    expect(eventsOf(converted.ticks, 'burnTick')).toEqual(eventsOf(plain.ticks, 'burnTick'));
    expect(eventsOf(plain.ticks, 'burnTick').length).toBeGreaterThan(10);
    // Hit damage is the same, part of it now tallied as bleed (no bleed row bonus here).
    const hitAmounts = (ticks: readonly (readonly SimEvent[])[]) =>
      eventsOf(ticks, 'hit').map((hit) => toNumber(hit.amount));
    const before = hitAmounts(plain.ticks);
    hitAmounts(converted.ticks).forEach((amount, i) => {
      expect(amount).toBeCloseTo(before[i] as number, 9);
    });
    expect(converted.result.damage.bleed).toBeGreaterThan(0);
    expect(eventsOf(converted.ticks, 'dotTick')).toEqual([]);
    const ctx = contextOn(makeStats(values, [], converting({ to: 'bleed', fraction: 0.4 })));
    const p = signaturePayload(ctx);
    for (const slot of [SLOT_BURN, SLOT_BURN_CRIT]) {
      expect(ctx.table.convCount[slotRow(ctx.build, p, slot)]).toBe(0);
    }
  });
});

/** Runs to the end, keeping each tick's events (index i holds tick i + 1's). */
function recorded(config: RunConfig, data: GameData = stationarySquares(4)) {
  const sim = createSimulation(config, data);
  const ticks: SimEvent[][] = [];
  while (!sim.state.finished) ticks.push(sim.step(NO_INPUT).slice());
  return { ticks, result: sim.result() };
}

describe('determinism with conversion', () => {
  const config = (seed: number): RunConfig =>
    makeConfig({
      seed,
      stats: makeStats(
        {
          damage: 6,
          attackSpeed: 4,
          critChance: 0.3,
          igniteChance: 0.4,
          chainCount: 1.5,
          maxLife: 1e6,
        },
        [more(1, 'poison'), more(0.5, 'chain', 'cold')],
        converting({ to: 'poison', fraction: 0.3 }, { tags: ['chain'], to: 'cold', fraction: 0.4 }),
      ),
      startWave: 6,
      maxTicks: 1500,
    });

  it('gives the same events for the same seed and other ones for another seed', () => {
    const a = recorded(config(1), makeTestData());
    const b = recorded(config(1), makeTestData());
    const c = recorded(config(2), makeTestData());
    expect(a.result.kills).toBeGreaterThan(20);
    expect(a.result.damage.poison).toBeGreaterThan(0);
    expect(b.ticks).toEqual(a.ticks);
    expect(b.result).toEqual(a.result);
    expect(c.ticks).not.toEqual(a.ticks);
  });
});
