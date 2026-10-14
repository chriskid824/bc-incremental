import { describe, expect, it } from 'vitest';
import { eventsOf, makeStats, placedEnemies } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { resolveContacts } from './contact';
import type { Enemy } from './context';
import { compact } from './death';
import { addEnemy } from './spawn';

describe('contacts', () => {
  it('resolves the enemies there at its start; one added during it touches the next tick', () => {
    // Two squares on the player, one far off.
    const at = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
    const ctx = placedEnemies([at, at, { x: 100, y: 100 }], {
      stats: makeStats({ maxLife: 1e6 }),
    });
    const [first, second] = ctx.enemies as [Enemy, Enemy, Enemy];
    // The first contact adds a square on the player. No hook runs inside the contact stage
    // before thorns, so the test adds it from the stage's own playerHit event.
    let added: Enemy | null = null;
    const events = ctx.events;
    const push = events.push.bind(events);
    events.push = (...pushed: SimEvent[]): number => {
      if (added === null && pushed[0]?.type === 'playerHit') {
        addEnemy(ctx, first.def, first.rec, 1, 0, 0);
        added = ctx.enemies.at(-1) as Enemy;
      }
      return push(...pushed);
    };
    resolveContacts(ctx);
    expect(added).not.toBeNull();
    const touched = (): number[] => eventsOf([events], 'playerHit').map((hit) => hit.enemyId);
    expect(touched()).toEqual([first.id, second.id]);
    expect((added as unknown as Enemy).alive).toBe(true);
    // The next tick: the touching squares are gone, and the added one touches.
    events.length = 0;
    compact(ctx);
    resolveContacts(ctx);
    expect(touched()).toEqual([(added as unknown as Enemy).id]);
  });
});
