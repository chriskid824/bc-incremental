import { describe, expect, it } from 'vitest';
import type { Modifier } from '../../data/stats';
import { TAG } from '../../data/tags';
import { rowKey } from '../build/sources';
import {
  createPayload,
  PRESCALED,
  ROWS,
  SLOT_BLEED,
  SLOT_BURN,
  SLOT_BURN_CRIT,
  SLOT_HIT,
  SLOT_HIT_CRIT,
  SLOT_JUMP,
  SLOT_JUMP_CRIT,
  SLOT_POISON,
  slotRow,
} from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import { createRunContext } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
import { releaseEnemies } from '../systems/spawn';
import { startDueWave } from '../systems/waves';
import { eventsOf, makeConfig, makeStats, recordRun, stationarySquares } from '../testing';
import type { SimEvent } from '../types';
import { chainAttack } from './chain';
import { hitWithPayload } from './hit';

/** A run context on `count` immortal stationary squares, spawned and gridded for tick 1. */
function contextOn(stats = makeStats(), count = 2): RunContext {
  const ctx = createRunContext(makeConfig({ stats }), stationarySquares(count));
  ctx.now = 1;
  startDueWave(ctx);
  releaseEnemies(ctx);
  rebuildGrid(ctx);
  return ctx;
}

const signaturePayload = (ctx: RunContext): Payload => (ctx.emitters[0] as EmitterRuntime).payload;

const hitsOf = (events: readonly SimEvent[]) =>
  events.flatMap((event) => (event.type === 'hit' ? [event] : []));

describe('payload row slots', () => {
  it('maps each slot to the row of its tags and source, filled on first use', () => {
    const ctx = contextOn();
    const p = signaturePayload(ctx);
    expect(p.tags).toBe(TAG.hit | TAG.projectile);
    // The run's estimates read the primary hit rows; every other slot waits for its first use.
    expect(p.rows[SLOT_HIT]).toBeGreaterThanOrEqual(0);
    expect(p.rows[SLOT_HIT_CRIT]).toBeGreaterThanOrEqual(0);
    for (const slot of [SLOT_JUMP, SLOT_JUMP_CRIT, SLOT_BURN, SLOT_BURN_CRIT, SLOT_POISON]) {
      expect(p.rows[slot]).toBe(-1);
    }
    const keys: [number, number][] = [
      [SLOT_HIT, TAG.hit | TAG.projectile],
      [SLOT_HIT_CRIT, TAG.hit | TAG.projectile | TAG.crit],
      [SLOT_JUMP, TAG.hit | TAG.chain],
      [SLOT_JUMP_CRIT, TAG.hit | TAG.chain | TAG.crit],
      [SLOT_BURN, TAG.burn],
      [SLOT_BURN_CRIT, TAG.burn | TAG.crit],
    ];
    for (const [slot, mask] of keys) {
      const row = slotRow(ctx.build, p, slot);
      expect(row, `slot ${slot}`).toBe(ctx.table.row(rowKey(mask, 0)));
      expect(p.rows[slot]).toBe(row);
    }
    expect(p.rows[SLOT_BLEED]).toBe(-1);
  });

  it('fills the jump and burn slots during a run, as the hits use them', () => {
    const stats = makeStats({ igniteChance: 1, critChance: 0, chainCount: 1, chainRange: 5000 });
    const ctx = contextOn(stats);
    const p = signaturePayload(ctx);
    chainAttack(ctx, p, ctx.enemies[0] as Enemy, ctx.chainCount, false, 0, -1);
    expect(hitsOf(ctx.events).map((hit) => hit.chainIndex)).toEqual([0, 1]);
    for (const slot of [SLOT_JUMP, SLOT_BURN]) expect(p.rows[slot]).toBeGreaterThanOrEqual(0);
    for (const slot of [SLOT_JUMP_CRIT, SLOT_BURN_CRIT]) expect(p.rows[slot]).toBe(-1);
  });
});

describe('hitWithPayload', () => {
  it('tags primary hits projectile and jumps chain: a [projectile] bonus reaches primary hits only', () => {
    const values = {
      damage: 10,
      attackSpeed: 6,
      projectileCount: 2,
      critChance: 0.3,
      igniteChance: 0.5,
      chainCount: 1.5,
      chainRange: 5000,
      chainRetention: 0.7,
    };
    const projectileBonus: Modifier = {
      stat: 'damage',
      kind: 'increased',
      value: 1,
      tags: ['projectile'],
    };
    const run = (scoped: readonly Modifier[]) =>
      recordRun(
        makeConfig({ stats: makeStats(values, scoped), maxTicks: 900 }),
        stationarySquares(5),
      ).ticks;
    const plain = run([]);
    const bonus = run([projectileBonus]);
    const hits = eventsOf(plain, 'hit');
    const bonusHits = eventsOf(bonus, 'hit');
    expect(bonusHits.map((hit) => [hit.targetId, hit.chainIndex, hit.crit])).toEqual(
      hits.map((hit) => [hit.targetId, hit.chainIndex, hit.crit]),
    );
    expect(hits.some((hit) => hit.chainIndex > 0)).toBe(true);
    expect(hits.some((hit) => hit.crit)).toBe(true);
    hits.forEach((hit, i) => {
      const other = bonusHits[i]?.amount;
      // (1 + 1) doubles the primary hit's row exactly; jumps drop the projectile tag.
      expect(other).toBe(hit.chainIndex === 0 ? 2 * hit.amount : hit.amount);
    });
    // Burns take the hit before its damage row, and an ailment keeps no geometry tag.
    const burns = eventsOf(plain, 'burnTick').map((tick) => tick.amount);
    expect(burns.length).toBeGreaterThan(10);
    expect(eventsOf(bonus, 'burnTick').map((tick) => tick.amount)).toEqual(burns);
  });

  it('credits chain jumps to jumpSource and their burns from the payload source', () => {
    const stats = makeStats(
      {
        damage: 10,
        critChance: 0,
        igniteChance: 1,
        burnDamage: 1,
        chainCount: 1,
        chainRange: 5000,
        chainRetention: 1,
      },
      [
        { stat: 'damage', kind: 'more', value: 1, tags: ['chain'], scope: 'fusion' },
        { stat: 'damage', kind: 'more', value: 3, tags: ['burn'], scope: 'fusion' },
      ],
    );
    const ctx = contextOn(stats);
    const fusion = ctx.sources.index('fusion.fire.lightning');
    const p = createPayload({ ...signaturePayload(ctx), jumpSource: fusion });
    const [first, second] = ctx.enemies as [Enemy, Enemy];
    chainAttack(ctx, p, first, 1, false, 0, -1);
    const [primary, jump] = hitsOf(ctx.events);
    expect(primary).toMatchObject({ targetId: first.id, source: 0, amount: 10 });
    // The jump's row is keyed on jumpSource, so the fusion-scoped chain bonus reaches it.
    expect(jump).toMatchObject({ targetId: second.id, chainIndex: 1, source: fusion, amount: 20 });
    expect(ctx.bySource[0]).toBe(10);
    expect(ctx.bySource[fusion]).toBe(20);
    // A fusion applier would keep the burn's credit (and its ×4); the applier is p.source.
    expect(first.burns.map((stack) => stack.dps)).toEqual([10]);
    expect(second.burns.map((stack) => stack.dps)).toEqual([10]);
    expect(p.rows[SLOT_BURN]).toBe(ctx.table.row(rowKey(TAG.burn, 0)));
  });

  it('deals exactly baseDamage × scale for a prescaled payload, whatever its rows hold', () => {
    const stats = makeStats({ damage: 10, critChance: 0, igniteChance: 0 }, [
      { stat: 'damage', kind: 'more', value: 1, tags: ['hit'] },
    ]);
    const ctx = contextOn(stats);
    const sig = signaturePayload(ctx);
    const enemy = ctx.enemies[0] as Enemy;
    for (const [damageMode, expected] of [
      [PRESCALED, 30],
      [ROWS, 60],
    ] as const) {
      ctx.events.length = 0;
      hitWithPayload(
        ctx,
        enemy,
        createPayload({ ...sig, damageMode }),
        0,
        3,
        null,
        null,
        false,
        0,
        -1,
      );
      expect(hitsOf(ctx.events).map((hit) => hit.amount)).toEqual([expected]);
    }
  });

  it('skips the whole crit decision for a payload that cannot crit', () => {
    const stats = makeStats({ damage: 10, critChance: 1, critMultiplier: 3, igniteChance: 0 }, [
      { stat: 'critAlways', kind: 'flat', value: 1 },
    ]);
    const ctx = contextOn(stats);
    const p = createPayload({ ...signaturePayload(ctx), canCrit: false });
    const before = p.rng.snapshot();
    hitWithPayload(ctx, ctx.enemies[0] as Enemy, p, 0, 1, null, null, true, 0, -1);
    expect(hitsOf(ctx.events)).toMatchObject([
      { crit: false, amount: 10, tags: TAG.hit | TAG.projectile },
    ]);
    // Neither the crit roll nor the ignite roll (chance 0) drew from the stream.
    expect(p.rng.snapshot()).toEqual(before);
  });
});
