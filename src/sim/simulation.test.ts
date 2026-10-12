import { describe, expect, it } from 'vitest';
import { shardsPerStdEnemy, stdHp } from '../data/curve';
import { BASE_STATS } from '../data/stats';
import type { StatBlock } from '../data/stats';
import type { EnemyId, GameData, WaveTable } from '../data/types';
import { BURN_TICK_INTERVAL, createSimulation } from './simulation';
import {
  makeConfig,
  makeStats,
  makeTestData,
  recordRun,
  TEST_ENEMIES,
  TEST_WAVES,
} from './testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, NO_INPUT, TICK_RATE } from './types';
import type { RunConfig, RunResult, SimEvent, Simulation } from './types';

type Ticks = readonly (readonly SimEvent[])[];
type EventOf<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
type TickedEvent<T extends SimEvent['type']> = EventOf<T> & { readonly tick: number };

/** Events of one type, each tagged with the tick it happened on. */
function eventsOf<T extends SimEvent['type']>(ticks: Ticks, type: T): TickedEvent<T>[] {
  const found: TickedEvent<T>[] = [];
  ticks.forEach((events, i) => {
    for (const event of events) {
      if (event.type === type) found.push({ ...(event as EventOf<T>), tick: i + 1 });
    }
  });
  return found;
}

function expectClose(actual: number, expected: number, relative = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * relative + 1e-12);
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Overwhelming damage and life: every hit kills, nothing ever kills the player. */
const STRONG = makeStats({
  damage: 1e6,
  attackSpeed: 20,
  chainCount: 10,
  chainRange: 5000,
  maxLife: 1e9,
});
const WEAK = makeStats({ damage: 1e-6 });

/** Waves without elites or bosses, built only from the given rules. */
function onlyRules(rules: WaveTable['rules'], waves: Partial<WaveTable> = {}): Partial<WaveTable> {
  return { rules, eliteEvery: 1000, bossEvery: 1000, ...waves };
}

/** One wave of `count` immortal, stationary squares; the next wave never comes. */
function dummyData(count: number, waves: Partial<WaveTable> = {}): GameData {
  return makeTestData({
    enemies: { square: { hpMult: 1e12, speed: 0 } },
    waves: onlyRules([{ enemy: 'square', fromWave: 1, base: count, perWave: 0, maxCount: count }], {
      waveTimerSec: 1000,
      ...waves,
    }),
  });
}

/** Steps to the end, calling `inspect` after every step. */
function runWith(
  config: RunConfig,
  data: GameData,
  inspect: (sim: Simulation, events: readonly SimEvent[]) => void,
): { ticks: Ticks; result: RunResult } {
  const sim = createSimulation(config, data);
  const ticks: SimEvent[][] = [];
  while (!sim.state.finished) {
    const events = sim.step(NO_INPUT).slice();
    ticks.push(events);
    inspect(sim, events);
  }
  return { ticks, result: sim.result() };
}

/** Kills any early enemy in one hit, never dies, no chains. */
const ONE_SHOT_VALUES = { damage: 1e6, attackSpeed: 20, critChance: 0, maxLife: 1e9 };
const ONE_SHOT = makeStats(ONE_SHOT_VALUES);

/** 40 slow squares a second, more than ONE_SHOT can kill: targets never run out. */
const PLENTIFUL_DATA = makeTestData({
  waves: onlyRules([{ enemy: 'square', fromWave: 1, base: 40, perWave: 0, maxCount: 40 }], {
    spawnDurationSec: 1,
    waveTimerSec: 1,
  }),
});

interface ProjectileTrack {
  readonly result: RunResult;
  readonly attacks: number;
  readonly primaryHits: number;
  readonly primaryTargets: readonly number[];
  /** Projectiles gone without a primary hit. */
  readonly fizzles: number;
  /** Fizzles on ticks that ended with enemies still alive. */
  readonly fizzlesWithEnemiesLeft: number;
  /** Projectiles seen homing on a new target after their previous one died. */
  readonly retargets: number;
  /** Projectiles still flying when the run ended. */
  readonly inFlight: number;
}

/** Runs to the end and accounts for every projectile through events and state. */
function trackProjectiles(config: RunConfig, data: GameData = PLENTIFUL_DATA): ProjectileTrack {
  let attacks = 0;
  let fizzles = 0;
  let fizzlesWithEnemiesLeft = 0;
  let retargets = 0;
  const primaryTargets: number[] = [];
  let targets = new Map<number, number>();
  const { result } = runWith(config, data, (sim, events) => {
    let fired = 0;
    let hits = 0;
    for (const event of events) {
      if (event.type === 'attack') fired++;
      if (event.type === 'hit' && event.chainIndex === 0) {
        hits++;
        primaryTargets.push(event.targetId);
      }
    }
    attacks += fired;
    const { enemies, projectiles } = sim.state;
    const fizzled = targets.size + fired - projectiles.length - hits;
    fizzles += fizzled;
    if (enemies.length > 0) fizzlesWithEnemiesLeft += fizzled;
    const alive = new Set(enemies.map((enemy) => enemy.id));
    const next = new Map<number, number>();
    for (const projectile of projectiles) {
      const before = targets.get(projectile.id);
      if (before !== undefined && before !== projectile.targetId) {
        retargets++;
        expect(alive.has(before)).toBe(false);
      }
      next.set(projectile.id, projectile.targetId);
    }
    targets = next;
  });
  return {
    result,
    attacks,
    primaryHits: primaryTargets.length,
    primaryTargets,
    fizzles,
    fizzlesWithEnemiesLeft,
    retargets,
    inFlight: targets.size,
  };
}

describe('createSimulation', () => {
  const data = makeTestData();

  it('rejects control modes other than auto', () => {
    const config = { ...makeConfig(), mode: 'cursorZone' } as unknown as RunConfig;
    expect(() => createSimulation(config, data)).toThrow(/only 'auto'/);
  });

  it('validates the run config', () => {
    expect(() => createSimulation(makeConfig({ startWave: 0 }), data)).toThrow(RangeError);
    expect(() => createSimulation(makeConfig({ startWave: 1.5 }), data)).toThrow(RangeError);
    expect(() => createSimulation(makeConfig({ startWave: 5, waveCap: 4 }), data)).toThrow(
      RangeError,
    );
    expect(() => createSimulation(makeConfig({ maxTicks: 0 }), data)).toThrow(RangeError);
    const shortMults: StatBlock = { ...makeStats(), damageMult: [1, 1] };
    expect(() => createSimulation(makeConfig({ stats: shortMults }), data)).toThrow(RangeError);
    expect(() =>
      createSimulation(makeConfig({ stats: makeStats({ damage: Number.NaN }) }), data),
    ).toThrow(RangeError);
  });

  it('starts with the player at the arena center at full life', () => {
    const sim = createSimulation(makeConfig({ stats: makeStats({ maxLife: 250 }) }), data);
    expect(sim.state.player).toMatchObject({
      x: ARENA_WIDTH / 2,
      y: ARENA_HEIGHT / 2,
      life: 250,
      maxLife: 250,
    });
    expect(sim.state.tick).toBe(0);
    expect(sim.state.enemies).toHaveLength(0);
    expect(sim.state.finished).toBe(false);
    expect(() => sim.result()).toThrow();
  });
});

describe('determinism', () => {
  const data = makeTestData();
  const config = makeConfig({
    seed: 42,
    stats: makeStats({
      damage: 30,
      attackSpeed: 3,
      critChance: 0.3,
      igniteChance: 0.5,
      chainCount: 1.5,
      maxLife: 300,
    }),
    maxTicks: 60 * TICK_RATE,
  });

  it('replays the same events and result for the same seed', () => {
    const first = recordRun(config, data);
    const second = recordRun(config, data);
    expect(second.ticks).toEqual(first.ticks);
    expect(second.result).toEqual(first.result);
    // The run exercised every system.
    for (const type of ['hit', 'ignite', 'burnTick', 'enemyKilled', 'playerHit'] as const) {
      expect(eventsOf(first.ticks, type).length).toBeGreaterThan(0);
    }
    expect(eventsOf(first.ticks, 'hit').some((hit) => hit.chainIndex > 0)).toBe(true);
  });

  it('diverges for a different seed', () => {
    const first = recordRun(config, data);
    const other = recordRun({ ...config, seed: 43 }, data);
    expect(other.ticks).not.toEqual(first.ticks);
  });

  it('spawns the same waves whatever the combat stats; only split children differ', () => {
    interface Spawn {
      readonly wave: number;
      readonly type: string;
      readonly x: number;
      readonly y: number;
    }
    /** Wave enemies in spawn order, and the ticks split children spawned on. */
    const spawnsWith = (damage: number): { spawns: Spawn[]; children: number[] } => {
      const spawns: Spawn[] = [];
      const children: number[] = [];
      const stats = makeStats({ damage, attackSpeed: 3, critChance: 0, maxLife: 1e9 });
      const run = makeConfig({ seed: 5, startWave: 8, stats, maxTicks: 60 * TICK_RATE });
      runWith(run, data, (sim, events) => {
        for (const event of events) {
          if (event.type !== 'enemySpawned') continue;
          if (event.enemy === 'shard') {
            children.push(sim.state.tick);
            continue;
          }
          // Wave enemies cannot die on their spawn tick; prev holds the spawn position.
          const enemy = sim.state.enemies.find((e) => e.id === event.enemyId);
          expect(enemy).toBeDefined();
          if (enemy !== undefined) {
            spawns.push({ wave: enemy.wave, type: enemy.type, x: enemy.prevX, y: enemy.prevY });
          }
        }
      });
      return { spawns, children };
    };
    for (const [weak, strong] of [
      [60, 90],
      [200, 260],
      [1000, 1300],
    ] as const) {
      const a = spawnsWith(weak);
      const b = spawnsWith(strong);
      // Pentagons split at times that depend on damage.
      expect(a.children.length).toBeGreaterThan(0);
      expect(b.children).not.toEqual(a.children);
      const shared = Math.min(a.spawns.length, b.spawns.length);
      expect(shared).toBeGreaterThan(100);
      expect(b.spawns.slice(0, shared)).toEqual(a.spawns.slice(0, shared));
    }
  });

  it('reports damage totals that match the events', () => {
    const { ticks, result } = recordRun(config, data);
    const hits = eventsOf(ticks, 'hit');
    const burns = eventsOf(ticks, 'burnTick');
    expectClose(result.damage.crit, sum(hits.filter((h) => h.crit).map((h) => h.amount)));
    expectClose(
      result.damage.chain,
      sum(hits.filter((h) => !h.crit && h.chainIndex > 0).map((h) => h.amount)),
    );
    expectClose(
      result.damage.hit,
      sum(hits.filter((h) => !h.crit && h.chainIndex === 0).map((h) => h.amount)),
    );
    expectClose(result.damage.burn, sum(burns.map((b) => b.amount)));
    expect(result.maxHit).toBe(
      Math.max(...hits.map((h) => h.amount), ...burns.map((b) => b.amount)),
    );
    expect(result.kills).toBe(eventsOf(ticks, 'enemyKilled').length);
  });
});

describe('run end', () => {
  const data = makeTestData();

  it('times out with strong stats, pushing past the start wave in overkill', () => {
    const { ticks, result } = recordRun(makeConfig({ stats: STRONG, maxTicks: 600 }), data);
    expect(result.endReason).toBe('timeout');
    expect(result.ticks).toBe(600);
    expect(ticks).toHaveLength(600);
    expect(result.highestWaveReached).toBeGreaterThan(result.startWave);
    expect(result.clearedStartWave).toBe(true);
    // Every wave this early is far below a tenth of a 1e6 hit.
    expect(result.overkillSeconds).toBeCloseTo(10, 9);
    expect(eventsOf(ticks, 'playerHit')).toHaveLength(0);
  });

  it('dies with weak stats; life only goes down', () => {
    let life = Infinity;
    const { ticks } = runWith(makeConfig({ stats: WEAK }), data, (sim) => {
      expect(sim.state.player.life).toBeLessThanOrEqual(life);
      life = sim.state.player.life;
    });
    const hits = eventsOf(ticks, 'playerHit');
    expect(hits.length).toBeGreaterThan(0);
    expect(life).toBe(0);
    let expected = 100;
    for (const hit of hits) {
      expected = Math.max(0, expected - hit.damage);
      expect(hit.lifeLeft).toBe(expected);
    }
    const last = ticks[ticks.length - 1] as readonly SimEvent[];
    expect(last[last.length - 1]).toEqual({ type: 'runEnded', reason: 'death' });
    expect(last.some((event) => event.type === 'playerHit')).toBe(true);
    expect(eventsOf(ticks, 'runEnded')).toHaveLength(1);
  });

  it('contact removes the enemy without a drop', () => {
    const { ticks, result } = recordRun(makeConfig({ stats: WEAK }), data);
    const contacts = eventsOf(ticks, 'playerHit');
    const typeOf = new Map(eventsOf(ticks, 'enemySpawned').map((e) => [e.enemyId, e.enemy]));
    expect(contacts.length).toBeGreaterThan(0);
    expect(eventsOf(ticks, 'enemyKilled')).toHaveLength(0);
    for (const contact of contacts) {
      const type = typeOf.get(contact.enemyId) as EnemyId;
      expect(contact.damage).toBe(TEST_ENEMIES[type].contactDamage);
    }
    expect(result.endReason).toBe('death');
    expect(result.overkillSeconds).toBe(0);
  });

  it('is a no-op once finished', () => {
    const sim = createSimulation(makeConfig({ stats: STRONG, maxTicks: 30 }), data);
    while (!sim.state.finished) sim.step(NO_INPUT);
    const result = sim.result();
    expect(sim.step(NO_INPUT)).toEqual([]);
    expect(sim.state.tick).toBe(30);
    expect(sim.result()).toBe(result);
  });

  it('ends at the wave cap once every wave up to it is cleared', () => {
    const { ticks, result } = recordRun(makeConfig({ stats: STRONG, waveCap: 3 }), data);
    expect(result.endReason).toBe('waveCap');
    expect(result.highestWaveCleared).toBe(3);
    expect(result.highestWaveReached).toBe(3);
    expect(eventsOf(ticks, 'waveStarted').map((event) => event.wave)).toEqual([1, 2, 3]);
    expect(eventsOf(ticks, 'waveCleared').map((event) => event.wave)).toEqual([1, 2, 3]);
  });

  it('starts at the requested wave and reports whether it was cleared', () => {
    const strong = recordRun(makeConfig({ stats: STRONG, startWave: 5, waveCap: 6 }), data);
    expect(eventsOf(strong.ticks, 'waveStarted')[0]?.wave).toBe(5);
    expect(strong.result.startWave).toBe(5);
    expect(strong.result.clearedStartWave).toBe(true);

    const weak = makeStats({ damage: 1e-6, maxLife: 1 });
    const dead = recordRun(makeConfig({ stats: weak, startWave: 5 }), data);
    expect(eventsOf(dead.ticks, 'waveStarted')[0]?.wave).toBe(5);
    expect(dead.result.endReason).toBe('death');
    expect(dead.result.clearedStartWave).toBe(false);
    expect(dead.result.highestWaveCleared).toBe(0);
  });
});

describe('start wave clear', () => {
  it('needs every start-wave enemy killed; reaching the player still clears the wave', () => {
    // Wave 1 is six triangles. A slow attacker kills some and survives the rest.
    const slow = makeStats({ damage: 1e6, attackSpeed: 0.5, maxLife: 1000 });
    const leaky = recordRun(makeConfig({ stats: slow, waveCap: 1 }), makeTestData());
    expect(eventsOf(leaky.ticks, 'enemyKilled').length).toBeGreaterThan(0);
    expect(eventsOf(leaky.ticks, 'playerHit').length).toBeGreaterThan(0);
    expect(eventsOf(leaky.ticks, 'waveCleared').map((event) => event.wave)).toEqual([1]);
    expect(leaky.result).toMatchObject({
      endReason: 'waveCap',
      highestWaveCleared: 1,
      clearedStartWave: false,
    });

    const strong = recordRun(makeConfig({ stats: ONE_SHOT, waveCap: 1 }), makeTestData());
    expect(eventsOf(strong.ticks, 'playerHit')).toHaveLength(0);
    expect(strong.result).toMatchObject({
      endReason: 'waveCap',
      highestWaveCleared: 1,
      clearedStartWave: true,
    });
  });

  describe('with split children', () => {
    // Wave 1: two triangles. Later waves: one pentagon whose shards reach the player on the
    // tick after they split off, unless a chain kills them at once.
    const data = makeTestData({
      enemies: { shard: { speed: 1e5 } },
      waves: onlyRules([
        { enemy: 'triangle', fromWave: 1, base: 2, perWave: -2, maxCount: 2 },
        { enemy: 'pentagon', fromWave: 2, base: 1, perWave: 0, maxCount: 1 },
      ]),
    });
    const chained = makeStats({ ...ONE_SHOT_VALUES, chainCount: 3, chainRange: 5000 });

    it('does not count a start wave whose children reached the player', () => {
      const { ticks, result } = recordRun(
        makeConfig({ stats: ONE_SHOT, startWave: 2, waveCap: 2 }),
        data,
      );
      expect(eventsOf(ticks, 'enemyKilled').map((event) => event.enemy)).toEqual(['pentagon']);
      expect(eventsOf(ticks, 'playerHit')).toHaveLength(3);
      expect(result).toMatchObject({
        endReason: 'waveCap',
        highestWaveCleared: 2,
        clearedStartWave: false,
      });
    });

    it('counts it when the children are killed too', () => {
      const { ticks, result } = recordRun(
        makeConfig({ stats: chained, startWave: 2, waveCap: 2 }),
        data,
      );
      const kills = eventsOf(ticks, 'enemyKilled').map((event) => event.enemy);
      expect(kills).toEqual(['pentagon', 'shard', 'shard', 'shard']);
      expect(eventsOf(ticks, 'playerHit')).toHaveLength(0);
      expect(result.clearedStartWave).toBe(true);
    });

    it('ignores enemies of later waves reaching the player', () => {
      const { ticks, result } = recordRun(makeConfig({ stats: ONE_SHOT, waveCap: 2 }), data);
      expect(eventsOf(ticks, 'playerHit')).toHaveLength(3);
      expect(result).toMatchObject({
        endReason: 'waveCap',
        highestWaveCleared: 2,
        clearedStartWave: true,
      });
    });
  });
});

describe('waves and spawning', () => {
  it('releases a wave evenly over the spawn duration', () => {
    const { ticks } = recordRun(
      makeConfig({ stats: WEAK, maxTicks: 120 }),
      makeTestData({ enemies: { triangle: { speed: 0 } } }),
    );
    const spawned = eventsOf(ticks, 'enemySpawned');
    expect(spawned.map((event) => event.tick)).toEqual([1, 11, 21, 31, 41, 51]);
    expect(spawned.map((event) => event.enemyId)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('spawns just outside the arena and walks straight at the player', () => {
    const data = makeTestData();
    const sim = createSimulation(makeConfig({ stats: WEAK, seed: 9 }), data);
    const cx = ARENA_WIDTH / 2;
    const cy = ARENA_HEIGHT / 2;
    for (let tick = 0; tick < 60; tick++) {
      const spawnedIds = sim
        .step(NO_INPUT)
        .flatMap((event) => (event.type === 'enemySpawned' ? [event.enemyId] : []));
      for (const enemy of sim.state.enemies.filter((e) => spawnedIds.includes(e.id))) {
        // prev holds the spawn position, on the arena rectangle grown by the enemy radius.
        const outsideX = Math.abs(enemy.prevX - cx) - (cx + enemy.radius);
        const outsideY = Math.abs(enemy.prevY - cy) - (cy + enemy.radius);
        expect(Math.max(outsideX, outsideY)).toBeCloseTo(0, 6);
        const before = Math.hypot(enemy.prevX - cx, enemy.prevY - cy);
        const after = Math.hypot(enemy.x - cx, enemy.y - cy);
        expectClose(before - after, TEST_ENEMIES.triangle.speed * DT, 1e-6);
        // Moving along the line through the player.
        const cross = (enemy.prevX - cx) * (enemy.y - cy) - (enemy.prevY - cy) * (enemy.x - cx);
        expect(Math.abs(cross)).toBeLessThan(1e-6 * before * after);
      }
    }
  });

  it('updates prevX/prevY to the previous position every tick', () => {
    type Moving = { id: number; x: number; y: number; prevX: number; prevY: number };
    const lastEnemies = new Map<number, { x: number; y: number }>();
    const lastProjectiles = new Map<number, { x: number; y: number }>();
    let compared = 0;
    const check = (list: readonly Moving[], last: Map<number, { x: number; y: number }>) => {
      for (const entity of list) {
        const before = last.get(entity.id);
        if (before === undefined) continue;
        expect({ x: entity.prevX, y: entity.prevY }).toEqual(before);
        compared++;
      }
      last.clear();
      for (const entity of list) last.set(entity.id, { x: entity.x, y: entity.y });
    };
    runWith(
      makeConfig({ stats: makeStats({ damage: 20, attackSpeed: 4 }), maxTicks: 900 }),
      makeTestData(),
      (sim) => {
        check(sim.state.enemies, lastEnemies);
        check(sim.state.projectiles, lastProjectiles);
      },
    );
    expect(compared).toBeGreaterThan(1000);
  });

  it('keeps only alive entities, ordered by id', () => {
    runWith(
      makeConfig({ stats: makeStats({ damage: 40, attackSpeed: 8, chainCount: 2 }) }),
      makeTestData(),
      (sim) => {
        for (const list of [sim.state.enemies, sim.state.projectiles]) {
          list.forEach((entity, i) => {
            expect(entity.alive).toBe(true);
            if (i > 0) expect(entity.id).toBeGreaterThan((list[i - 1] as { id: number }).id);
          });
        }
      },
    );
  });

  it('starts the next wave after waveTimerSec while the current one is not cleared', () => {
    const { ticks } = recordRun(
      makeConfig({ stats: WEAK, maxTicks: 1500 }),
      makeTestData({ enemies: { triangle: { speed: 0 } } }),
    );
    const started = eventsOf(ticks, 'waveStarted');
    expect(started.map((event) => [event.wave, event.tick])).toEqual([
      [1, 1],
      [2, 1 + 8 * TICK_RATE],
      [3, 1 + 16 * TICK_RATE],
      [4, 1 + 24 * TICK_RATE],
    ]);
  });

  it('starts the next wave on the tick after the current one is cleared', () => {
    const { ticks } = recordRun(makeConfig({ stats: STRONG, waveCap: 12 }), makeTestData());
    const startedAt = new Map(eventsOf(ticks, 'waveStarted').map((e) => [e.wave, e.tick]));
    const cleared = eventsOf(ticks, 'waveCleared');
    expect(cleared.map((event) => event.wave)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const event of cleared) {
      if (event.wave < 12) expect(startedAt.get(event.wave + 1)).toBe(event.tick + 1);
    }
  });

  it('clears waves in any order and tracks the highest cleared one', () => {
    // Wave 1 alone holds an immortal, stationary square, so it never clears.
    const data = makeTestData({
      enemies: { square: { hpMult: 1e12, speed: 0 } },
      waves: onlyRules(
        [
          { enemy: 'triangle', fromWave: 1, base: 2, perWave: 0, maxCount: 2 },
          { enemy: 'square', fromWave: 1, base: 1, perWave: -1, maxCount: 1 },
        ],
        { waveTimerSec: 2 },
      ),
    });
    const config = makeConfig({ stats: makeStats({ damage: 1e4, attackSpeed: 6 }) });
    const { ticks, result } = recordRun({ ...config, maxTicks: 20 * TICK_RATE }, data);
    const cleared = eventsOf(ticks, 'waveCleared');
    expect(cleared.map((event) => event.wave)).not.toContain(1);
    expect(cleared.length).toBeGreaterThan(2);
    expect(result.highestWaveCleared).toBe(Math.max(...cleared.map((event) => event.wave)));
    expect(result.clearedStartWave).toBe(false);
    expect(result.endReason).toBe('timeout');

    // The field is never clear, so each wave starts on the timer of the one before, even
    // when that one was cleared long before.
    const started = eventsOf(ticks, 'waveStarted');
    expect(started.map((event) => event.tick)).toEqual(
      started.map((_, i) => 1 + i * 2 * TICK_RATE),
    );
    const startedAt = new Map(started.map((event) => [event.wave, event.tick]));
    const early = cleared.filter((event) => {
      const next = startedAt.get(event.wave + 1);
      return next !== undefined && event.tick + 1 < next;
    });
    expect(early.length).toBeGreaterThan(2);
  });

  it('starts the next wave once the field is clear or the current wave times out', () => {
    // Elites and bosses outlive later waves now and then, so several waves are often open.
    const timerTicks = TEST_WAVES.waveTimerSec * TICK_RATE;
    let starts = 0;
    for (const [seed, startWave, damage] of [
      [1, 5, 20],
      [2, 5, 30],
      [3, 8, 20],
      [2, 5, 50],
    ] as const) {
      const stats = makeStats({ damage, attackSpeed: 6, maxLife: 1e9 });
      const { ticks } = recordRun(
        makeConfig({ seed, startWave, stats, maxTicks: 60 * TICK_RATE }),
        makeTestData(),
      );
      const startedAt = new Map(eventsOf(ticks, 'waveStarted').map((e) => [e.wave, e.tick]));
      const clearedAt = new Map(eventsOf(ticks, 'waveCleared').map((e) => [e.wave, e.tick]));
      for (const [wave, tick] of startedAt) {
        if (wave === startWave) continue;
        // The tick after the last earlier wave clears, if every earlier wave clears.
        let fieldClear = 0;
        for (let earlier = startWave; earlier < wave; earlier++) {
          fieldClear = Math.max(fieldClear, (clearedAt.get(earlier) ?? Infinity) + 1);
        }
        const timedOut = (startedAt.get(wave - 1) as number) + timerTicks;
        expect(tick, `wave ${wave}, seed ${seed}`).toBe(Math.min(fieldClear, timedOut));
        starts++;
      }
    }
    expect(starts).toBeGreaterThan(20);
  });

  it('splits a pentagon into shards of the same wave; the wave clears after them', () => {
    const data = makeTestData({
      waves: onlyRules([{ enemy: 'pentagon', fromWave: 1, base: 1, perWave: 0, maxCount: 1 }]),
    });
    const stats = makeStats({ damage: 25, attackSpeed: 4, critChance: 0 });
    const shardIds: number[] = [];
    const { ticks } = runWith(makeConfig({ stats, waveCap: 1 }), data, (sim, events) => {
      const kill = events.find((e) => e.type === 'enemyKilled' && e.enemy === 'pentagon');
      if (kill === undefined || kill.type !== 'enemyKilled') return;
      for (const shard of sim.state.enemies) {
        shardIds.push(shard.id);
        expect(shard).toMatchObject({ type: 'shard', wave: 1, alive: true });
        expect(shard.maxHp).toBe(TEST_ENEMIES.shard.hpMult * stdHp(1));
        const fromParent = Math.hypot(shard.prevX - kill.x, shard.prevY - kill.y);
        expect(fromParent).toBeCloseTo(TEST_ENEMIES.pentagon.radius, 6);
      }
    });
    expect(shardIds).toEqual([2, 3, 4]);
    const killTick = eventsOf(ticks, 'enemyKilled').find((e) => e.enemy === 'pentagon')?.tick;
    const spawned = eventsOf(ticks, 'enemySpawned').filter((e) => e.enemy === 'shard');
    expect(spawned.map((e) => [e.enemyId, e.tick])).toEqual(shardIds.map((id) => [id, killTick]));

    const removedAt = [
      ...eventsOf(ticks, 'enemyKilled').filter((e) => e.enemy === 'shard'),
      ...eventsOf(ticks, 'playerHit'),
    ].map((e) => e.tick);
    expect(removedAt).toHaveLength(3);
    const clears = eventsOf(ticks, 'waveCleared');
    expect(clears).toHaveLength(1);
    expect(clears[0]?.tick).toBe(Math.max(...removedAt));
    expect(ticks).toHaveLength(Math.max(...removedAt));
  });
});

describe('attacks', () => {
  it('fires on the tick a target appears without banking attacks', () => {
    // Two triangles per wave, four seconds apart; the first dies to the first hit.
    const data = makeTestData({
      waves: onlyRules([{ enemy: 'triangle', fromWave: 1, base: 2, perWave: 0, maxCount: 2 }], {
        spawnDurationSec: 4,
      }),
    });
    const stats = makeStats({ damage: 1e6, attackSpeed: 6, maxLife: 1e9 });
    const { ticks } = recordRun(makeConfig({ stats, maxTicks: 135 }), data);
    const firstDeath = eventsOf(ticks, 'enemyKilled')[0]?.tick ?? Infinity;
    expect(firstDeath).toBeLessThan(110);
    const attacks = eventsOf(ticks, 'attack').filter((attack) => attack.tick > firstDeath);
    expect(attacks.map((attack) => [attack.tick, attack.targetId])).toEqual([
      [121, 2],
      [131, 2],
    ]);
  });

  it('lands nearly every one-shot attack when enemies are plentiful', () => {
    const track = trackProjectiles(makeConfig({ stats: ONE_SHOT, maxTicks: 20 * TICK_RATE }));
    expect(track.attacks).toBeGreaterThan(350);
    expect(track.primaryHits).toBeGreaterThanOrEqual(0.9 * track.attacks);
    // Nothing fizzles: every attack hit or is still in flight.
    expect(track.fizzles).toBe(0);
    expect(track.primaryHits + track.inFlight).toBe(track.attacks);
    // Each enemy takes exactly one primary hit, the one that kills it.
    expect(new Set(track.primaryTargets).size).toBe(track.primaryTargets.length);
    expect(track.result.kills).toBe(track.primaryHits);
  });

  it('aims at the nearest enemy that projectiles in flight will not kill', () => {
    const sim = createSimulation(
      makeConfig({ stats: ONE_SHOT, maxTicks: 5 * TICK_RATE }),
      PLENTIFUL_DATA,
    );
    const { player } = sim.state;
    const distOf = (enemy: { x: number; y: number }): number =>
      Math.hypot(enemy.x - player.x, enemy.y - player.y);
    let checked = 0;
    while (!sim.state.finished) {
      // One-shot damage: an enemy is covered once any projectile flies at it.
      const covered = new Set(sim.state.projectiles.map((projectile) => projectile.targetId));
      const events = sim.step(NO_INPUT);
      // Enemies do not move after attacking, and squares do not split, so every enemy alive
      // now stood at this position when the attack picked its target.
      const enemies = sim.state.enemies;
      for (const event of events) {
        if (event.type !== 'attack') continue;
        expect(covered.has(event.targetId)).toBe(false);
        const target = enemies.find((enemy) => enemy.id === event.targetId);
        if (target !== undefined) {
          for (const other of enemies) {
            if (covered.has(other.id)) continue;
            expect(distOf(other)).toBeGreaterThanOrEqual(distOf(target) - 1e-9);
          }
          checked++;
        }
        covered.add(event.targetId);
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('retargets projectiles whose target died first; they fizzle only with no enemy left', () => {
    // Chains kill enemies that other projectiles are flying at, and sometimes every enemy.
    const stats = makeStats({ ...ONE_SHOT_VALUES, chainCount: 3, chainRange: 5000 });
    const track = trackProjectiles(makeConfig({ stats, maxTicks: 20 * TICK_RATE }));
    expect(track.retargets).toBeGreaterThan(20);
    expect(track.fizzles).toBeGreaterThan(0);
    expect(track.fizzlesWithEnemiesLeft).toBe(0);

    // Early waves, where one chained hit clears the whole wave.
    const strong = trackProjectiles(makeConfig({ stats: STRONG, maxTicks: 600 }), makeTestData());
    expect(strong.fizzles).toBeGreaterThan(0);
    expect(strong.fizzlesWithEnemiesLeft).toBe(0);
    expect(new Set(strong.primaryTargets).size).toBe(strong.primaryTargets.length);
  });
});

describe('hits and crits', () => {
  const data = dummyData(4, { spawnDurationSec: 0 });
  /** A distinct multiplier per tag mask, to check which mask each instance uses. */
  const byMask = (mask: number): number => 1 + mask / 10;

  it('crits every hit at critChance 1, with the crit masks', () => {
    const stats = makeStats(
      {
        damage: 7,
        critChance: 1,
        critMultiplier: 2.5,
        chainCount: 1,
        chainRetention: 0.5,
        chainRange: 5000,
      },
      byMask,
    );
    const { ticks, result } = recordRun(makeConfig({ stats, maxTicks: 300 }), data);
    const hits = eventsOf(ticks, 'hit');
    expect(hits.length).toBeGreaterThan(4);
    expect(hits.some((hit) => hit.chainIndex === 1)).toBe(true);
    for (const hit of hits) {
      expect(hit.crit).toBe(true);
      if (hit.chainIndex === 0) expectClose(hit.amount, 7 * 2.5 * byMask(1 | 2));
      else expectClose(hit.amount, 7 * 2.5 * 0.5 * byMask(1 | 2 | 8));
    }
    expect(result.damage.hit).toBe(0);
    expect(result.damage.chain).toBe(0);
    expect(result.damage.crit).toBeGreaterThan(0);
  });

  it('never crits at critChance 0', () => {
    const stats = makeStats({ damage: 7, critChance: 0 }, byMask);
    const { ticks, result } = recordRun(makeConfig({ stats, maxTicks: 300 }), data);
    const hits = eventsOf(ticks, 'hit');
    expect(hits.length).toBeGreaterThan(4);
    for (const hit of hits) {
      expect(hit.crit).toBe(false);
      expectClose(hit.amount, 7 * byMask(1));
    }
    expect(result.damage.crit).toBe(0);
  });

  it('counts overkill from the average hit, crits with their own multiplier', () => {
    // The wave never clears, so wave 1 stays current for the whole run.
    const average = 0.5 * byMask(1) + 0.5 * 2 * byMask(1 | 2);
    const threshold = (stdHp(1) * 10) / average;
    const overkillSeconds = (damage: number): number => {
      const stats = makeStats({ damage, critChance: 0.5, critMultiplier: 2 }, byMask);
      return recordRun(makeConfig({ stats, maxTicks: 120 }), data).result.overkillSeconds;
    };
    expect(overkillSeconds(threshold * 1.01)).toBe(2);
    expect(overkillSeconds(threshold * 0.99)).toBe(0);
  });
});

describe('chains', () => {
  it('jumps to the nearest unhit enemy, keeping chainRetention per jump', () => {
    const data = dummyData(8, { spawnDurationSec: 0 });
    const stats = makeStats({
      damage: 10,
      attackSpeed: 2,
      critChance: 0,
      chainCount: 2,
      chainRetention: 0.5,
      chainRange: 5000,
    });
    const sim = createSimulation(makeConfig({ stats, maxTicks: 600 }), data);
    const ticks: SimEvent[][] = [];
    while (!sim.state.finished) ticks.push(sim.step(NO_INPUT).slice());
    // Stationary, immortal enemies: final positions are the positions at every hit.
    const positions = new Map(sim.state.enemies.map((e) => [e.id, { x: e.x, y: e.y }]));
    expect(positions.size).toBe(8);

    const hits = eventsOf(ticks, 'hit');
    expect(hits.length % 3).toBe(0);
    expect(hits.length).toBeGreaterThan(6);
    for (let i = 0; i < hits.length; i += 3) {
      const group = hits.slice(i, i + 3);
      expect(group.map((hit) => hit.chainIndex)).toEqual([0, 1, 2]);
      expect(new Set(group.map((hit) => hit.targetId)).size).toBe(3);
      const [primary, first, second] = group as [
        TickedEvent<'hit'>,
        TickedEvent<'hit'>,
        TickedEvent<'hit'>,
      ];
      expect(primary.amount).toBe(10);
      expect(first.amount / primary.amount).toBeCloseTo(0.5, 12);
      expect(second.amount / first.amount).toBeCloseTo(0.5, 12);
      expect([primary.fromX, primary.fromY]).toEqual([null, null]);
      for (const [from, to] of [
        [primary, first],
        [first, second],
      ] as const) {
        expect([to.fromX, to.fromY]).toEqual([from.x, from.y]);
        const hitSoFar = new Set(group.slice(0, to.chainIndex).map((hit) => hit.targetId));
        let nearest = -1;
        let nearestDist = Infinity;
        for (const [id, pos] of positions) {
          const dist = Math.hypot(pos.x - from.x, pos.y - from.y);
          if (!hitSoFar.has(id) && dist < nearestDist) {
            nearest = id;
            nearestDist = dist;
          }
        }
        expect(to.targetId).toBe(nearest);
      }
    }
    const chainDamage = sum(hits.filter((hit) => hit.chainIndex > 0).map((hit) => hit.amount));
    expectClose(sim.result().damage.chain, chainDamage);
  });

  it('stops when no enemy is within chain range', () => {
    const data = dummyData(8, { spawnDurationSec: 0 });
    const stats = makeStats({ damage: 10, attackSpeed: 2, chainCount: 3, chainRange: 1 });
    const { ticks } = recordRun(makeConfig({ stats, maxTicks: 300 }), data);
    const hits = eventsOf(ticks, 'hit');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.chainIndex === 0)).toBe(true);
  });

  it('uses the fractional chain count as the chance of one more jump', () => {
    const data = dummyData(4, { spawnDurationSec: 0 });
    const stats = makeStats({ attackSpeed: 10, chainCount: 0.5, chainRange: 5000 });
    const { ticks } = recordRun(makeConfig({ stats, maxTicks: 1200 }), data);
    const hits = eventsOf(ticks, 'hit');
    const primaries = hits.filter((hit) => hit.chainIndex === 0).length;
    const jumps = hits.filter((hit) => hit.chainIndex === 1).length;
    expect(hits.every((hit) => hit.chainIndex <= 1)).toBe(true);
    expect(jumps / primaries).toBeGreaterThan(0.35);
    expect(jumps / primaries).toBeLessThan(0.65);
  });
});

describe('burning', () => {
  const byMask = (mask: number): number => 1 + mask / 10;

  it.each([
    { crit: false, mask: 4 },
    { crit: true, mask: 4 | 2 },
  ])('deals dps × duration over aligned burn ticks (crit: $crit)', ({ crit, mask }) => {
    // One stationary dummy, one attack at tick 120, one 1 s stack.
    const stats = makeStats(
      {
        damage: 10,
        attackSpeed: 0.5,
        critChance: crit ? 1 : 0,
        critMultiplier: 2,
        igniteChance: 1,
        burnDamage: 0.5,
        burnDuration: 1,
      },
      byMask,
    );
    const sim = createSimulation(makeConfig({ stats, maxTicks: 239 }), dummyData(1));
    const ticks: SimEvent[][] = [];
    while (!sim.state.finished) ticks.push(sim.step(NO_INPUT).slice());

    const ignites = eventsOf(ticks, 'ignite');
    expect(ignites).toHaveLength(1);
    expect(ignites[0]?.stacks).toBe(1);
    const dps = 10 * (crit ? 2 : 1) * 0.5 * byMask(mask);
    const burnTicks = eventsOf(ticks, 'burnTick');
    expect(burnTicks.length).toBeGreaterThanOrEqual(4);
    for (const burn of burnTicks) {
      expect(burn.tick % BURN_TICK_INTERVAL).toBe(0);
      expect(burn.amount).toBeLessThanOrEqual(dps * BURN_TICK_INTERVAL * DT + 1e-9);
    }
    expectClose(sum(burnTicks.map((burn) => burn.amount)), dps * 1, 1e-12);
    expectClose(sim.result().damage.burn, dps * 1, 1e-12);
    expect(sim.state.enemies[0]?.burnStacks).toBe(0);
  });

  it('never exceeds the stack cap', () => {
    const stats = makeStats({
      damage: 10,
      attackSpeed: 10,
      igniteChance: 1,
      burnMaxStacks: 3.7,
      chainCount: 2,
      chainRange: 5000,
    });
    let maxStacks = 0;
    const { ticks } = runWith(
      makeConfig({ stats, maxTicks: 900 }),
      dummyData(3, { spawnDurationSec: 0 }),
      (sim) => {
        for (const enemy of sim.state.enemies) maxStacks = Math.max(maxStacks, enemy.burnStacks);
      },
    );
    const ignites = eventsOf(ticks, 'ignite');
    expect(ignites.length).toBeGreaterThan(30);
    expect(Math.max(...ignites.map((ignite) => ignite.stacks))).toBe(3);
    expect(maxStacks).toBe(3);
    expect(eventsOf(ticks, 'burnTick').length).toBeGreaterThan(0);
  });

  it('keeps burning continuously when a capped stack is refreshed', () => {
    // Cap 1, a new stack every 6 ticks: each burn tick after the first carries exactly
    // one stack's worth of damage, with nothing lost or counted twice on replacement.
    const stats = makeStats({
      damage: 10,
      attackSpeed: 10,
      critChance: 0,
      igniteChance: 1,
      burnMaxStacks: 1,
    });
    const { ticks } = recordRun(makeConfig({ stats, maxTicks: 900 }), dummyData(1));
    const burnTicks = eventsOf(ticks, 'burnTick');
    const dps = 10 * BASE_STATS.burnDamage;
    expect(burnTicks.length).toBeGreaterThan(40);
    for (const burn of burnTicks.slice(1)) expectClose(burn.amount, dps * 0.25, 1e-9);
  });

  it('replaces the stack with the least remaining damage at the cap', () => {
    // Crits make stacks of different strength, so the replacement choice changes the total.
    const stats = makeStats({
      damage: 10,
      attackSpeed: 3,
      critChance: 0.5,
      critMultiplier: 4,
      igniteChance: 1,
      burnDamage: 0.4,
      burnDuration: 2,
      burnMaxStacks: 2,
    });
    const { ticks, result } = recordRun(makeConfig({ stats, maxTicks: 600 }), dummyData(1));

    // Reference model driven by the hit → ignite event pairs.
    type Stack = { dps: number; start: number; end: number };
    const stacks: Stack[] = [];
    const dealt = (stack: Stack, until: number): number =>
      stack.dps * (Math.min(stack.end, until) - stack.start) * DT;
    let expected = 0;
    let replaced = 0;
    ticks.forEach((events, i) => {
      const now = i + 1;
      events.forEach((event, j) => {
        if (event.type !== 'ignite') return;
        const hit = events[j - 1];
        if (hit?.type !== 'hit') throw new Error('ignite must follow its hit');
        for (let k = stacks.length - 1; k >= 0; k--) {
          const stack = stacks[k] as Stack;
          if (stack.end > now) continue;
          expected += dealt(stack, stack.end);
          stacks.splice(k, 1);
        }
        const stack = { dps: 10 * (hit.crit ? 4 : 1) * 0.4, start: now, end: now + 2 * TICK_RATE };
        if (stacks.length < 2) {
          stacks.push(stack);
          return;
        }
        const left = (s: Stack): number => s.dps * (s.end - now);
        const weakest = left(stacks[1] as Stack) < left(stacks[0] as Stack) ? 1 : 0;
        expected += dealt(stacks[weakest] as Stack, now);
        stacks[weakest] = stack;
        replaced++;
      });
    });
    for (const stack of stacks) expected += dealt(stack, 600);
    expect(replaced).toBeGreaterThan(10);
    expectClose(result.damage.burn, expected, 1e-9);
  });
});

describe('drops', () => {
  it('awards shards per kill and whole cores, matching the run totals', () => {
    const stats = makeStats({
      damage: 1e6,
      attackSpeed: 20,
      chainCount: 10,
      chainRange: 5000,
      maxLife: 1e9,
      shardGain: 2,
      coreGain: 1.5,
    });
    const waveOf = new Map<number, number>();
    const { ticks, result } = runWith(makeConfig({ stats, waveCap: 20 }), makeTestData(), (sim) => {
      for (const enemy of sim.state.enemies) waveOf.set(enemy.id, enemy.wave);
    });

    const kills = eventsOf(ticks, 'enemyKilled');
    expect(result.endReason).toBe('waveCap');
    expect(kills.length).toBe(result.kills);
    expectClose(result.shards, sum(kills.map((kill) => kill.shards)), 1e-12);
    expect(result.cores).toBe(sum(kills.map((kill) => kill.cores)));

    const coreRange: Partial<Record<EnemyId, readonly [number, number]>> = {
      hexagon: [1, 2],
      boss: [4, 5],
    };
    let checked = 0;
    for (const kill of kills) {
      expect(Number.isInteger(kill.cores)).toBe(true);
      const [low, high] = coreRange[kill.enemy] ?? [0, 0];
      expect(kill.cores).toBeGreaterThanOrEqual(low);
      expect(kill.cores).toBeLessThanOrEqual(high);
      const wave = waveOf.get(kill.enemyId);
      if (wave === undefined) continue;
      const expected = TEST_ENEMIES[kill.enemy].dropMult * shardsPerStdEnemy(wave) * 2;
      expectClose(kill.shards, expected);
      checked++;
    }
    expect(checked).toBeGreaterThan(kills.length / 2);
    expect(kills.some((kill) => kill.enemy === 'boss')).toBe(true);
    expect(kills.some((kill) => kill.enemy === 'shard')).toBe(true);
  });
});
