/**
 * Which player hits flash the core (C7.2's hand-off to C7.8, the lead's ruling P4): a contact or a
 * bullet the shield took whole does not; one that reached life does, and on an M1 run, which has
 * no shield, every contact does, as before. The sequences are the sim's own (damagePlayer through
 * resolveContacts); the Renderer needs a canvas, so its one core.hit() is read from its source.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TriggerSpec } from '../data/triggers';
import type { SimEvent } from '../sim';
import { resolveContacts } from '../sim/systems/contact';
import type { Enemy } from '../sim/systems/context';
import { centerTriggers, makeStats, placedEnemies } from '../sim/testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../sim/types';
import { CoreHitFilter } from './playerHits';

/** The middle of the arena, where the player stands. */
const AT = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** ◆波次護盾 as contact.test.ts gives it: a shield effect, so the run has defences. */
const WAVE_SHIELD: TriggerSpec = {
  on: 'waveStart',
  do: [{ kind: 'shield', lifePct: 0.2, capPct: 0.2 }],
};

/** The player hits of `events` that flash the core, as `[type, damage]`, in order. */
function flashed(events: readonly SimEvent[], filter = new CoreHitFilter()): [string, number][] {
  const out: [string, number][] = [];
  for (const event of events) {
    if (!filter.flashes(event)) continue;
    if (event.type !== 'playerHit' && event.type !== 'bulletHit') throw new Error(event.type);
    out.push([event.type, event.damage]);
  }
  return out;
}

const absorbed = (amount: number, shieldLeft = 0): SimEvent => ({
  type: 'shieldAbsorbed',
  amount,
  shieldLeft,
});
const contact = (damage: number, enemyId = 1): SimEvent => ({
  type: 'playerHit',
  enemyId,
  damage,
  lifeLeft: 100 - damage,
});
const bullet = (damage: number, enemyId = 1): SimEvent => ({
  type: 'bulletHit',
  bulletId: 1,
  enemyId,
  enemy: 'shooter',
  damage,
  lifeLeft: 100 - damage,
});

describe('CoreHitFilter (C7.2’s hand-off, the lead’s ruling P4)', () => {
  it('does not flash the core on a contact the shield takes whole, and does on what reaches life', () => {
    // Three squares (15 contact damage each) on a shield of 20, as the sim resolves them.
    const stats = makeStats({ maxLife: 100 }, [], centerTriggers([WAVE_SHIELD]));
    const ctx = placedEnemies([AT, AT, AT], { stats });
    const [first, second, third] = ctx.enemies as [Enemy, Enemy, Enemy];
    ctx.player.shield = 20;
    resolveContacts(ctx);
    const hits = ctx.events.filter((event) => event.type === 'playerHit');
    expect(hits.map((hit) => [hit.enemyId, hit.damage])).toEqual([
      [first.id, 0],
      [second.id, 10],
      [third.id, 15],
    ]);
    expect(flashed(ctx.events)).toEqual([
      ['playerHit', 10],
      ['playerHit', 15],
    ]);
  });

  it('flashes the core on every M1 contact: no shield, so nothing is absorbed', () => {
    const ctx = placedEnemies([AT, AT], { stats: makeStats({ maxLife: 100 }) });
    resolveContacts(ctx);
    expect(ctx.events.some((event) => event.type === 'shieldAbsorbed')).toBe(false);
    expect(flashed(ctx.events)).toEqual([
      ['playerHit', 15],
      ['playerHit', 15],
    ]);
    // A contact of damage 0 with no shieldAbsorbed before it still flashes, as M1's did.
    expect(flashed([contact(0)])).toEqual([['playerHit', 0]]);
  });

  it('reads a bullet as a contact: no flash when the shield took it whole', () => {
    expect(flashed([absorbed(3), bullet(0), absorbed(2), bullet(1), bullet(3)])).toEqual([
      ['bulletHit', 1],
      ['bulletHit', 3],
    ]);
  });

  it('never flashes on the shieldAbsorbed itself, and takes it for the next hit only', () => {
    const filter = new CoreHitFilter();
    expect(filter.flashes(absorbed(15))).toBe(false);
    expect(filter.flashes({ type: 'enemyKilled' } as unknown as SimEvent)).toBe(false);
    expect(filter.flashes(contact(0))).toBe(false);
    // The next contact of damage 0 had no shieldAbsorbed of its own.
    expect(filter.flashes(contact(0))).toBe(true);
    expect(filter.flashes(absorbed(5))).toBe(false);
    filter.reset();
    expect(filter.flashes(contact(0))).toBe(true);
  });

  it('is the only way the renderer flashes the core, for contacts, bullets and the shield', () => {
    const source = readFileSync(new URL('renderer.ts', import.meta.url), 'utf8');
    const calls = source.match(/\bcore\.hit\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(source).toMatch(
      /case 'playerHit':\s*case 'bulletHit':\s*if \(this\.coreHits\.flashes\(event\)\) this\.core\.hit\(\);\s*break;/,
    );
    expect(source).toMatch(/case 'shieldAbsorbed':\s*this\.coreHits\.flashes\(event\);/);
    // A new run forgets a shieldAbsorbed left over.
    expect(source).toMatch(/beginRun\([^)]*\): void \{[\s\S]*?this\.coreHits\.reset\(\);/);
  });
});
