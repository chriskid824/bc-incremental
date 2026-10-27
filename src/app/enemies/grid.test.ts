/**
 * The `?enemies` grid (docs/v3 C7 design §2.9, the lead's ruling P7): every v3 type and every
 * affix on characterGameData(), each standing where its spot says with the record the views read,
 * and each behaviour the page is there to show coming round within a run, which starts again every
 * GRID_LOOP_SECONDS.
 */

import { describe, expect, it } from 'vitest';
import { AFFIX_IDS } from '../../data/affixes';
import { V3_ENEMIES } from '../../data/enemiesV3';
import { ENEMY_IDS } from '../../data/types';
import { TICK_RATE } from '../../sim';
import type { SimEvent } from '../../sim';
import { MULTIPLY_RADIUS } from '../../sim/systems/affixes';
import { CHARGING, FLEEING, ORBITING, WARDED } from '../../sim/systems/enemyRecord';
import { EnemyBanner } from '../../ui/banner';
import { EnemyGrid, GRID_LOOP_SECONDS, gridData, gridSpots } from './grid';

const bit = (id: (typeof AFFIX_IDS)[number]): number => 1 << AFFIX_IDS.indexOf(id);

/** A grid drawing into nothing, with each tick's events and each start recorded. */
function recorded() {
  const ticks: SimEvent[][] = [];
  let starts = 0;
  const data = gridData();
  const banner = new EnemyBanner(data.enemies, [], {
    show: () => undefined,
    hide: () => undefined,
  });
  const grid = new EnemyGrid(
    {
      start: () => void starts++,
      events: (events) => void ticks.push([...events]),
      frame: () => undefined,
    },
    banner,
    data,
  );
  return { grid, ticks, starts: () => starts };
}

describe('the ?enemies grid (§2.9, the lead’s ruling P7)', () => {
  it('stands every v3 type in roster order and an elite of each affix, all standing still', () => {
    const data = gridData();
    const spots = gridSpots(data);
    const types = ENEMY_IDS.filter((id) => Object.hasOwn(V3_ENEMIES, id));
    expect(types).toEqual([
      'shielder',
      'regenerator',
      'dasher',
      'shooter',
      'summoner',
      'treasure',
      'onion',
    ]);
    expect(spots.slice(0, types.length).map((spot) => spot.def.id)).toEqual(types);
    const elites = spots.slice(types.length, types.length + AFFIX_IDS.length);
    expect(elites.map((spot) => [spot.label, spot.def.id, spot.origin.affixes])).toEqual(
      AFFIX_IDS.map((id, i) => [id, 'hexagon', 1 << i]),
    );
    expect(spots.slice(types.length + AFFIX_IDS.length).map((spot) => spot.label)).toEqual([
      'onion, 2 left',
      'onion, 1 left',
      'multiply child',
      'multiply child',
      'swift + armoured + ward',
    ]);
    expect(spots.every((spot) => spot.def.speed === 0)).toBe(true);
    // Every spot its own place.
    expect(new Set(spots.map((spot) => `${spot.dx},${spot.dy}`)).size).toBe(spots.length);
  });

  it('places them on its first tick, each with the record the views read', () => {
    const { grid } = recorded();
    grid.step();
    const state = grid.state;
    const spots = grid.spots;
    const placed = state.enemies.slice(0, spots.length);
    spots.forEach((spot, i) => {
      const enemy = placed[i];
      expect(enemy?.type, spot.label).toBe(spot.def.id);
      expect(enemy?.x, spot.label).toBeCloseTo(state.player.x + spot.dx, 6);
      expect(enemy?.y, spot.label).toBeCloseTo(state.player.y + spot.dy, 6);
      expect(enemy?.v3?.affixes, spot.label).toBe(spot.origin.affixes);
    });
    const at = (label: string) => placed.filter((_, i) => spots[i]?.label === label);
    expect(at('onion, 2 left').map((enemy) => enemy.v3?.layersLeft)).toEqual([2]);
    expect(at('onion, 1 left').map((enemy) => enemy.v3?.layersLeft)).toEqual([1]);
    const hexagon = gridData().enemies.hexagon.radius;
    for (const child of at('multiply child')) {
      expect(child.radius).toBeCloseTo(hexagon * MULTIPLY_RADIUS, 9);
    }
    for (const label of ['ward', 'swift + armoured + ward']) {
      expect(at(label).map((enemy) => (enemy.v3?.defence ?? 0) & WARDED)).toEqual([WARDED]);
    }
    expect(at('swift + armoured + ward')[0]?.v3?.affixes).toBe(
      bit('swift') | bit('armoured') | bit('ward'),
    );
  });

  it('brings every behaviour round within a run: the charge, bullets, orbit, flight, shield', () => {
    const { grid, ticks } = recorded();
    const seen = new Set<string>();
    for (let tick = 0; tick < GRID_LOOP_SECONDS * TICK_RATE; tick++) {
      grid.step();
      const state = grid.state;
      for (const enemy of state.enemies) {
        const flags = enemy.v3?.state ?? 0;
        if (enemy.type === 'dasher' && (flags & CHARGING) !== 0) seen.add('charging');
        if (enemy.type === 'treasure' && (flags & ORBITING) !== 0) seen.add('orbiting');
        if (enemy.type === 'treasure' && (flags & FLEEING) !== 0 && seen.has('orbiting')) {
          seen.add('fleeing after orbiting');
        }
      }
      if (state.bulletCount > 0) seen.add('bullets');
      if (state.player.shield > 0) seen.add('shield');
    }
    const events = ticks.flat();
    if (events.some((event) => event.type === 'shieldAbsorbed')) seen.add('shieldAbsorbed');
    if (events.some((event) => event.type === 'enemySpawned' && event.enemy === 'triangle')) {
      seen.add('summoned');
    }
    expect([...seen].sort()).toEqual([
      'bullets',
      'charging',
      'fleeing after orbiting',
      'orbiting',
      'shield',
      'shieldAbsorbed',
      'summoned',
    ]);
    // Immortal: none of the grid's own died.
    expect(events.filter((event) => event.type === 'enemyKilled' && event.enemyId <= 25)).toEqual(
      [],
    );
  });

  it('starts again every GRID_LOOP_SECONDS, and the view starts a run each time', () => {
    const { grid, starts } = recorded();
    expect([grid.started, starts()]).toEqual([1, 1]);
    for (let tick = 0; tick < GRID_LOOP_SECONDS * TICK_RATE; tick++) grid.step();
    expect(grid.state.tick).toBe(GRID_LOOP_SECONDS * TICK_RATE);
    expect([grid.started, starts()]).toEqual([1, 1]);
    grid.step();
    expect([grid.started, starts(), grid.state.tick]).toEqual([2, 2, 1]);
    expect(grid.isRunning()).toBe(true);
  });
});
