/**
 * The first-appearance banner (docs/v3 C7 design §2.9 with the lead's rulings L7 and P5): once per
 * type per profile, the profile's seen set its caller's; every new sighting reported to the caller;
 * one line, closing BANNER_MS of wall-clock time after the frame that shows it; several new types
 * of one tick queued in sighting order; and never pausing the loop: the `?enemies` grid's ticks go
 * on while a line shows.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { EnemyGrid } from '../app/enemies/grid';
import { GameLoop, TICK_MS } from '../app/loop';
import { characterGameData, loadGameData } from '../data';
import type { EnemyDef, EnemyId } from '../data/types';
import { LOCALES, setLocale } from '../i18n';
import type { SimEvent } from '../sim';
import { BANNER_GAP_MS, BANNER_KEYS, BANNER_MS, bannerText, EnemyBanner } from './banner';
import type { BannerView } from './banner';

const data = characterGameData();

/** What the banner did on the page: each line shown, each hide. */
class Lines implements BannerView {
  readonly log: string[] = [];

  show(text: string): void {
    this.log.push(`show ${text}`);
  }

  hide(): void {
    this.log.push('hide');
  }
}

const shown = (...ids: EnemyId[]): string[] =>
  ids.map((id) => `show ${bannerText(data.enemies[id]) ?? ''}`);

/** One tick's events: an enemySpawned of each of `ids`, in order. */
const spawned = (...ids: EnemyId[]): SimEvent[] =>
  ids.map((enemy, n) => ({ type: 'enemySpawned', enemyId: n + 1, enemy }));

/** A banner over `seen`, its sightings recorded in `sightings`, its lines in `lines`. */
function bannerOf(seen: Iterable<EnemyId> = []) {
  const lines = new Lines();
  const sightings: EnemyId[] = [];
  const banner = new EnemyBanner(data.enemies, seen, lines, (id) => sightings.push(id));
  return { banner, lines, sightings };
}

describe('EnemyBanner (§2.9 with the lead’s rulings L7 and P5)', () => {
  afterEach(() => setLocale('en'));

  it('slides a line in for the first enemySpawned of a type its caller has not seen', () => {
    const { banner, lines, sightings } = bannerOf(['shielder']);
    banner.events(spawned('shielder'));
    expect([lines.log, sightings, banner.showing]).toEqual([[], [], null]);
    banner.events(spawned('dasher', 'dasher'));
    banner.events(spawned('dasher'));
    expect(lines.log).toEqual(shown('dasher'));
    expect(sightings).toEqual(['dasher']);
    expect(banner.showing).toBe('dasher');
  });

  it('shows once per type per profile (L7): a later run, given the profile’s set, stays quiet', () => {
    // The profile's seen set, which the caller records each sighting into (recordSeenEnemies).
    const profile = new Set<EnemyId>();
    const record = (id: EnemyId): void => void profile.add(id);
    const first = new Lines();
    const run1 = new EnemyBanner(data.enemies, profile, first, record);
    run1.events(spawned('dasher'));
    run1.events(spawned('dasher'));
    expect(first.log).toEqual(shown('dasher'));
    expect([...profile]).toEqual(['dasher']);
    // The next run's banner: the profile has seen 衝刺者, not 射手.
    const second = new Lines();
    const run2 = new EnemyBanner(data.enemies, profile, second, record);
    run2.events(spawned('dasher'));
    expect(second.log).toEqual([]);
    run2.events(spawned('shooter', 'dasher'));
    expect(second.log).toEqual(shown('shooter'));
    expect([...profile]).toEqual(['dasher', 'shooter']);
    // A fresh profile (`?enemies`' fresh set per load) sees 衝刺者 anew.
    const fresh = bannerOf();
    fresh.banner.events(spawned('dasher'));
    expect(fresh.lines.log).toEqual(shown('dasher'));
  });

  it('copies its caller’s seen set: a sighting reaches the caller through onSighting alone (L7)', () => {
    // The caller records each sighting (B1's recordSeenEnemies); the banner never writes its set.
    const profile = new Set<EnemyId>(['dasher']);
    const sightings: EnemyId[] = [];
    const banner = new EnemyBanner(data.enemies, profile, new Lines(), (id) => {
      expect(profile.has(id)).toBe(false);
      sightings.push(id);
    });
    banner.events(spawned('dasher', 'shooter'));
    banner.events(spawned('summoner'));
    expect(sightings).toEqual(['shooter', 'summoner']);
    expect([...profile]).toEqual(['dasher']);
  });

  it('reports every new type to its caller once, in sighting order, the M1 types too', () => {
    const { banner, lines, sightings } = bannerOf();
    banner.events(spawned('triangle', 'shielder', 'triangle', 'hexagon'));
    banner.events(spawned('shielder', 'boss', 'onion'));
    expect(sightings).toEqual(['triangle', 'shielder', 'hexagon', 'boss', 'onion']);
    // Only the v3 types the waves bring have a line: an M1 type is recorded, never shown.
    expect(lines.log).toEqual(shown('shielder'));
    expect(banner.showing).toBe('shielder');
  });

  it('closes BANNER_MS = 2.5 s of wall-clock time after it shows, however many ticks pass', () => {
    expect(BANNER_MS).toBe(2500);
    const { banner, lines } = bannerOf();
    banner.events(spawned('regenerator'));
    // Ticks alone never close it: 2.5 s is wall-clock frame time, from the frame after the one
    // that shows it.
    for (let tick = 0; tick < 1000; tick++) banner.events([]);
    banner.update(16);
    banner.update(BANNER_MS - 1);
    expect(banner.showing).toBe('regenerator');
    expect(lines.log).toEqual(shown('regenerator'));
    banner.update(1);
    expect(banner.showing).toBeNull();
    expect(lines.log).toEqual([...shown('regenerator'), 'hide']);
    banner.update(BANNER_MS * 4);
    expect(lines.log).toEqual([...shown('regenerator'), 'hide']);
  });

  it('never closes a line in the frame that shows it, however long (a tab back from hiding)', () => {
    const { banner, lines } = bannerOf();
    // A 5 s frame's ticks bring 衝刺者: that frame's update must not close the line unseen, which
    // would lose it for good once the caller has recorded the sighting.
    banner.events(spawned('dasher'));
    banner.update(5000);
    expect(banner.showing).toBe('dasher');
    expect(lines.log).toEqual(shown('dasher'));
    // Its 2.5 s start with the next frame.
    banner.update(BANNER_MS - 1);
    expect(banner.showing).toBe('dasher');
    banner.update(1);
    expect(lines.log).toEqual([...shown('dasher'), 'hide']);
  });

  it('queues several new types of one tick in sighting order and shows them one at a time', () => {
    const { banner, lines, sightings } = bannerOf();
    banner.events(spawned('summoner', 'treasure', 'onion'));
    expect(sightings).toEqual(['summoner', 'treasure', 'onion']);
    expect(lines.log).toEqual(shown('summoner'));
    banner.update(16);
    banner.update(BANNER_MS);
    expect(lines.log).toEqual([...shown('summoner'), 'hide']);
    // The gap: the line slides out before the next slides in.
    banner.update(BANNER_GAP_MS - 1);
    expect(banner.showing).toBeNull();
    banner.update(1);
    expect(banner.showing).toBe('treasure');
    // A type first seen while a line shows waits its turn behind the queue.
    banner.events(spawned('shooter'));
    banner.update(BANNER_MS);
    banner.update(BANNER_GAP_MS);
    banner.update(BANNER_MS);
    banner.update(BANNER_GAP_MS);
    expect(lines.log).toEqual([
      ...shown('summoner'),
      'hide',
      ...shown('treasure'),
      'hide',
      ...shown('onion'),
      'hide',
      ...shown('shooter'),
    ]);
  });

  it('never pauses the loop: the ?enemies grid’s ticks go on while a line shows', () => {
    const { banner, lines, sightings } = bannerOf();
    const frames: number[] = [];
    const grid = new EnemyGrid(
      {
        start: () => undefined,
        events: () => undefined,
        frame: (state) => frames.push(state.tick),
      },
      banner,
    );
    const loop = new GameLoop(grid);
    loop.tick(TICK_MS);
    // The first tick stands every v3 type: 盾兵's line shows, the six others queue.
    expect(banner.showing).toBe('shielder');
    const first = grid.state.tick;
    for (let f = 0; f < 60; f++) loop.tick(TICK_MS);
    expect(banner.showing).toBe('shielder');
    expect(grid.state.tick).toBe(first + 60);
    expect(frames).toHaveLength(61);
    // Through every line and past the run's restart: the next run is no new sighting.
    const told = [...sightings];
    expect(told).toEqual([
      'shielder',
      'regenerator',
      'dasher',
      'shooter',
      'summoner',
      'treasure',
      'onion',
      'hexagon',
    ]);
    while (grid.started < 2) loop.tick(TICK_MS);
    for (let f = 0; f < 60; f++) loop.tick(TICK_MS);
    expect(sightings).toEqual([...told, 'triangle']);
    expect(lines.log.filter((line) => line !== 'hide')).toEqual(
      shown('shielder', 'regenerator', 'dasher', 'shooter', 'summoner', 'treasure', 'onion'),
    );
  });

  it('fills each line with its type’s numbers, from the def, in both locales', () => {
    for (const locale of LOCALES) {
      setLocale(locale);
      for (const id of Object.keys(BANNER_KEYS) as EnemyId[]) {
        const text = bannerText(data.enemies[id]);
        expect(text, `${locale} ${id}`).toMatch(/\S/);
        expect(text, `${locale} ${id}`).not.toMatch(/[{}]/);
      }
    }
    setLocale('zh-TW');
    // gd:1015's own example, word for word.
    expect(bannerText(data.enemies.shielder)).toBe(
      '新敵人：盾兵　擋下小於其最大生命 15% 的擊中。燃燒可以繞過。',
    );
    setLocale('en');
    const shielder = data.enemies.shielder;
    const tuned: EnemyDef = {
      ...shielder,
      behaviour: { kind: 'shield', blockBelowPct: 0.2 },
    };
    expect(bannerText(shielder)).toContain('below 15% of');
    expect(bannerText(tuned)).toContain('below 20% of');
    expect(bannerText(data.enemies.dasher)).toContain('red for 0.6 s, then dashes in at 4×');
    expect(bannerText(loadGameData().enemies.triangle)).toBeNull();
  });

  it('is wired into ?enemies only: no other page makes a banner (the lead’s rulings P2 and P5)', () => {
    const src = new URL('../', import.meta.url);
    const made = (readdirSync(src, { recursive: true, encoding: 'utf8' }) as string[])
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) =>
        /new (EnemyBanner|BannerLine)\(/.test(readFileSync(new URL(file, src), 'utf8')),
      )
      .map((file) => file.replaceAll('\\', '/'));
    expect(made).toEqual(['app/enemies/route.ts']);
  });
});
