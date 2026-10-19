import { describe, expect, it } from 'vitest';
import { ZERO } from '../../core/num';
import type { Enemy, RunContext } from '../systems/context';
import { GRID_LINEAR_BELOW } from '../systems/grid';
import { centerTriggers, makeStats, placedEnemies, withinRef } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import { fireOne } from './dispatch';
import { runEffectQueue } from './execute';
import { SHATTER_TRIGGER } from './types';

/** The player's position (createRunContext puts it at the arena's center). */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

/** 200 enemies on a golden-angle spiral from 120 to 518 around the player: none within 100. */
const SPIRAL: readonly PlacedEnemy[] = Array.from({ length: 200 }, (_, i) => {
  const angle = i * 2.399963229728653;
  const r = 120 + 2 * i;
  return { x: P.x + r * Math.cos(angle), y: P.y + r * Math.sin(angle) };
});

interface Push {
  readonly distance: number;
  readonly radius: number;
}

/** SPIRAL with one hit trigger whose effects are `pushes`, in order, each at the event point. */
const withPushes = (...pushes: Push[]): RunContext =>
  placedEnemies(SPIRAL, {
    stats: makeStats(
      {},
      [],
      centerTriggers([{ on: 'hit', do: pushes.map((push) => ({ kind: 'push', ...push })) }]),
    ),
  });

/** Fires the trigger at the player's point, then runs the effect phase: one tick's pushes. */
function firePushes(ctx: RunContext): void {
  fireOne(ctx, FIRST, 0, -1, null, P.x, P.y, 0, ZERO, -1);
  runEffectQueue(ctx);
}

/** Reference: the pushes moved by hand, each over the positions the one before it left. */
function pushedRef(pushes: readonly Push[]): { x: number; y: number }[] {
  const ctx = placedEnemies(SPIRAL);
  const enemies = ctx.enemies.map((e) => ({ ...e }));
  for (const { distance, radius } of pushes) {
    for (const enemy of withinRef(enemies, P.x, P.y, radius * radius)) {
      enemy.dist += distance;
      enemy.x = P.x + enemy.ux * enemy.dist;
      enemy.y = P.y + enemy.uy * enemy.dist;
    }
  }
  return enemies.map(({ x, y }) => ({ x, y }));
}

/** Reference: the alive enemy nearest (x, y), ties to the lower id. */
function nearestRef(enemies: readonly Enemy[], x: number, y: number): Enemy | null {
  let best: Enemy | null = null;
  let bestSq = Infinity;
  for (const enemy of enemies) {
    const dx = enemy.x - x;
    const dy = enemy.y - y;
    const sq = dx * dx + dy * dy;
    if (enemy.alive && sq < bestSq) {
      best = enemy;
      bestSq = sq;
    }
  }
  return best;
}

const ids = (enemies: readonly Enemy[]): number[] => enemies.map((e) => e.id);

describe('push and the grid (same-tick visibility, D27)', () => {
  it('sorts the grid of at least GRID_LINEAR_BELOW enemies', () => {
    expect(SPIRAL.length).toBeGreaterThanOrEqual(GRID_LINEAR_BELOW);
    expect(withinRef(placedEnemies(SPIRAL).enemies, P.x, P.y, 100 * 100)).toEqual([]);
  });

  it('sorts once per query that follows a move: N pushes in a tick cost N sorts, then one', () => {
    const pushes = [
      { distance: 30, radius: 300 },
      { distance: 40, radius: 300 },
      { distance: 50, radius: 300 },
    ];
    const ctx = withPushes(...pushes);
    const before = ctx.grid.sortCount;
    firePushes(ctx);
    // The first push's query follows the tick's movement, each later one the push before it.
    expect(ctx.grid.sortCount - before).toBe(3);
    expect(ctx.enemies.map(({ x, y }) => ({ x, y }))).toEqual(pushedRef(pushes));
    // The first query after the last push sorts; the queries after it share that sort.
    const out: Enemy[] = [];
    ctx.grid.within(P.x, P.y, 400 * 400, out);
    expect(ctx.grid.sortCount - before).toBe(4);
    ctx.grid.nearest(P.x + 300, P.y, Infinity);
    ctx.grid.within(P.x - 200, P.y + 100, 150 * 150, out);
    expect(ctx.grid.countWithin(P.x, P.y, 500 * 500)).toBeGreaterThan(0);
    expect(ctx.grid.sortCount - before).toBe(4);
  });

  it('does not rebuild after a push that moved nothing', () => {
    // Nothing within 100 of the player, before or after the first push.
    const pushes = [
      { distance: 30, radius: 300 },
      { distance: 40, radius: 100 },
      { distance: 50, radius: 100 },
    ];
    const ctx = withPushes(...pushes);
    const before = ctx.grid.sortCount;
    firePushes(ctx);
    // The first push's query and the second's, which follows the first one's move.
    expect(ctx.grid.sortCount - before).toBe(2);
    expect(ctx.enemies.map(({ x, y }) => ({ x, y }))).toEqual(pushedRef(pushes));
    ctx.grid.nearest(P.x, P.y, Infinity);
    expect(ctx.grid.sortCount - before).toBe(2);

    const still = withPushes({ distance: 30, radius: 100 }, { distance: 30, radius: 100 });
    const at = still.grid.sortCount;
    const positions = still.enemies.map(({ x, y }) => ({ x, y }));
    firePushes(still);
    still.grid.within(P.x, P.y, 400 * 400, []);
    expect(still.grid.sortCount - at).toBe(1);
    expect(still.enemies.map(({ x, y }) => ({ x, y }))).toEqual(positions);
  });

  it('rebuilds after a push that moved a single enemy', () => {
    // Only the innermost enemy (120 from the player) is within 121; 200 more carry it two cells out.
    const push = { distance: 200, radius: 121 };
    const ctx = withPushes(push);
    const before = ctx.grid.sortCount;
    const unpushed = ctx.enemies.map(({ x, y }) => ({ x, y }));
    firePushes(ctx);
    const pushed = pushedRef([push]);
    expect(ctx.enemies.map(({ x, y }) => ({ x, y }))).toEqual(pushed);
    const moved = ctx.enemies.filter((e, i) => e.x !== unpushed[i]?.x || e.y !== unpushed[i]?.y);
    expect(moved.length).toBe(1);
    const enemy = moved[0] as Enemy;
    const out: Enemy[] = [];
    const count = ctx.grid.within(enemy.x, enemy.y, 20 * 20, out);
    expect(ids(out.slice(0, count))).toEqual([enemy.id]);
    expect(ctx.grid.nearest(enemy.x, enemy.y, Infinity)).toBe(enemy);
    // The push's own query, then the first query after its move.
    expect(ctx.grid.sortCount - before).toBe(2);
  });

  it('answers the queries after a push as a linear scan over the pushed positions', () => {
    // Far enough that the pushed enemies change cells (GRID_CELL_SIZE 128).
    const ctx = withPushes({ distance: 200, radius: 350 }, { distance: 150, radius: 450 });
    firePushes(ctx);
    const enemies = ctx.enemies;
    expect(enemies.filter((e) => e.dist > 450).length).toBeGreaterThan(100);
    const out: Enemy[] = [];
    let checked = 0;
    for (let x = 0; x <= ARENA_WIDTH; x += 96) {
      for (let y = 0; y <= ARENA_HEIGHT; y += 96) {
        for (const radius of [60, 180]) {
          const count = ctx.grid.within(x, y, radius * radius, out);
          const got = ids(out.slice(0, count)).sort((a, b) => a - b);
          expect(got).toEqual(ids(withinRef(enemies, x, y, radius * radius)));
          checked += count;
        }
        expect(ctx.grid.nearest(x, y, Infinity)).toBe(nearestRef(enemies, x, y));
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
});
