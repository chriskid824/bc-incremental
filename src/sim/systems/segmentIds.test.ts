/**
 * V1c: SegmentLinesState's endpoint ids and pool. Each link's id1 and id2 name the endpoints
 * whose positions (x1, y1) and (x2, y2) hold: a shocked enemy's id for a shocked segment, a drone
 * pool row's id (DroneViewState.id) for a 'drones' or 'summons' segment, at a pairing and at a
 * reuse of the held pairs; they grow with the coordinates; `pool` names the pool by the emitter's
 * endpoints. Both C5.8 shapes (the fence and the drone web) are checked over whole runs. Nothing
 * in the sim reads the ids: viewParity.test.ts shows the runs unchanged.
 */

import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import type { EmitterGrant, SegmentGrant, SourcedEmitter } from '../../data/emitters';
import type { SignatureSpec } from '../../data/rules';
import type { StatBlock } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import { addShock } from '../ailments/shock';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, makeTestData, placedEnemies } from '../testing';
import type { PlacedEnemy } from '../testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_KIND_DRONE,
  DRONE_KIND_SPIRIT,
  DRONE_KIND_TURRET,
  NO_INPUT,
} from '../types';
import type { DroneViewState, EnemyState, SegmentLinesState, SimState } from '../types';
import type { Enemy, RunContext } from './context';
import { spawnRows, stepDrones } from './drones';
import { rebuildGrid } from './grid';
import { stepSegments } from './segments';

/** Where these tests' enemies and rows stand: 400 right of the player. */
const C = { x: ARENA_WIDTH / 2 + 400, y: ARENA_HEIGHT / 2 };
const at = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: C.x + dx,
  y: C.y + dy,
  ...extra,
});

const on = (source: string, grant: EmitterGrant): SourcedEmitter => ({ source, grant });
const web = (fields: Partial<SegmentGrant> = {}): SourcedEmitter =>
  on('outer.lightning', { kind: 'segment', endpoints: 'shocked', ...fields } as SegmentGrant);
const seg = (endpoints: SegmentGrant['endpoints'], fields: Partial<SegmentGrant> = {}) =>
  on('outer.summon', { kind: 'segment', endpoints, ...fields } as SegmentGrant);
const summons = (drones: number, turrets = 0): SourcedEmitter =>
  on('outer.summon', { kind: 'drone', drones, turrets });
/** A heroHit trigger, which never fires here, holding a spawnDrone: the build can add spirits. */
const HOLDER: TriggerSpec = {
  on: 'heroHit',
  do: [{ kind: 'spawnDrone', lifeSec: 4, damagePct: 1 }],
};

/** Stats of damage 1 and no crit, at attack speed 0 (no row moves), with these grants. */
const statsOf = (grants: readonly SourcedEmitter[]): StatBlock =>
  makeStats({ damage: 1, critChance: 0, critMultiplier: 2, attackSpeed: 0 }, [], {
    triggers: [{ source: 'outer.summon', spec: HOLDER }],
    conversions: [],
    emitters: grants,
  });

function ctxOf(
  placed: readonly PlacedEnemy[],
  grants: readonly SourcedEmitter[],
  modules: readonly TestModule[] = [],
): RunContext {
  return placedEnemies(placed, { stats: statsOf(grants), modules });
}

/** Runs the segment stage with segment emitter `i` due and none of the others. */
function judgeNow(ctx: RunContext, i = 0): void {
  ctx.sys.segments.emitters.forEach((em, k) => {
    em.timer = k === i ? em.interval - 1 : -Infinity;
  });
  ctx.events.length = 0;
  stepSegments(ctx);
}

/** The next tick's grid and drone stage, as a tick runs them before the segment stage. */
function droneTick(ctx: RunContext): void {
  ctx.now = ++ctx.state.tick;
  rebuildGrid(ctx);
  ctx.events.length = 0;
  stepDrones(ctx);
}

/** Appends `n` spirits at C + (dx, dy) that leave `life` ticks from now. */
function addSpirits(ctx: RunContext, n: number, dx = 0, dy = 0, life = 240): void {
  const f = ctx.build.effects.findIndex((fx) => fx.kind === 'spawnDrone');
  spawnRows(ctx, f, n, life, C.x + dx, C.y + dy, 1, -1);
}

/** The slot of row `id` in the pool's first droneCount slots, by a scan; −1 when gone. */
function slotOfRow(ds: DroneViewState, count: number, id: number): number {
  for (let s = 0; s < count; s++) if (ds.id[s] === id) return s;
  return -1;
}

/** A link as its ids and the positions it holds: [id1, x1, y1, id2, x2, y2]. */
function linksOf(ln: SegmentLinesState): number[][] {
  return Array.from({ length: ln.count }, (_, i) => [
    ln.id1[i] as number,
    ln.x1[i] as number,
    ln.y1[i] as number,
    ln.id2[i] as number,
    ln.x2[i] as number,
    ln.y2[i] as number,
  ]);
}

/**
 * Each link of `ln` with each end's id looked up in its pool: [id, x, y] of that endpoint where
 * it stands in `state` (null when it is not there), per end.
 */
function endpointsOf(
  state: Readonly<SimState>,
  ln: SegmentLinesState,
): ([number, number, number] | null)[][] {
  const find = (id: number): [number, number, number] | null => {
    if (ln.pool === 'enemies') {
      const e = state.enemies.find((enemy: EnemyState) => enemy.id === id);
      return e === undefined ? null : [id, e.x, e.y];
    }
    const s = slotOfRow(state.drones, state.droneCount, id);
    return s < 0 ? null : [id, state.drones.x[s] as number, state.drones.y[s] as number];
  };
  return linksOf(ln).map(([id1, , , id2]) => [find(id1 as number), find(id2 as number)]);
}

/** What every link of `ln` should read: each end's id with that endpoint's position. */
const expectedOf = (state: Readonly<SimState>, ln: SegmentLinesState): number[][] =>
  endpointsOf(state, ln).map(([a, b]) => [...(a ?? [NaN, NaN, NaN]), ...(b ?? [NaN, NaN, NaN])]);

describe('the ids of a shocked segment’s links (V1c)', () => {
  it('hold each link’s two shocked enemies, (x1, y1)’s in id1 and (x2, y2)’s in id2, over random fields', () => {
    const rng = createRng(77);
    let links = 0;
    let unequal = 0;
    for (let trial = 0; trial < 40; trial++) {
      const n = 4 + Math.floor(rng.next() * 30);
      const placed = Array.from({ length: n }, () =>
        at(Math.round(rng.next() * 500 - 250), Math.round(rng.next() * 500 - 250)),
      );
      const ctx = ctxOf(placed, [web({ links: trial % 2 === 0 ? 2 : 1 })]);
      // A random two-thirds hold shock; the others are no endpoints.
      const shocked = ctx.enemies.filter(() => rng.next() < 0.67);
      for (const enemy of shocked) addShock(ctx, enemy, 1, 0);
      judgeNow(ctx);
      const ln = ctx.state.segments.lines[0] as SegmentLinesState;
      expect(ln.pool).toBe('enemies');
      const shockedIds = new Set(shocked.map((enemy) => enemy.id));
      expect(linksOf(ln), `trial ${trial}`).toEqual(expectedOf(ctx.state, ln));
      for (const [id1, x1, y1, id2, x2, y2] of linksOf(ln)) {
        expect(shockedIds.has(id1 as number) && shockedIds.has(id2 as number)).toBe(true);
        expect(id1).not.toBe(id2);
        if (x1 !== x2 || y1 !== y2) unequal++;
      }
      links += ln.count;
    }
    expect(links).toBeGreaterThan(300);
    // Swapped ids would read the other end's position: the ends stand apart nearly always.
    expect(unequal).toBe(links);
  });

  it('grow with the coordinates past the first 128 links', () => {
    // A lattice of 15 × 12 shocked enemies 30 apart: 2 links each, well past 2 × 64.
    const placed: PlacedEnemy[] = [];
    for (let i = 0; i < 15; i++)
      for (let j = 0; j < 12; j++) placed.push(at(i * 30 - 210, j * 30 - 165));
    const ctx = ctxOf(placed, [web()]);
    for (const enemy of ctx.enemies) addShock(ctx, enemy, 1, 0);
    judgeNow(ctx);
    const ln = ctx.state.segments.lines[0] as SegmentLinesState;
    expect(ln.count).toBeGreaterThan(200);
    expect([ln.id1.length, ln.id2.length]).toEqual([ln.x1.length, ln.x1.length]);
    expect(linksOf(ln)).toEqual(expectedOf(ctx.state, ln));
  });

  it('keep the id of an endpoint the judgement’s own hit kills, at the coordinate it stood at', () => {
    const ctx = ctxOf([at(0, 0, { hp: 0.05 }), at(100, 0), at(300, 0)], [web({ links: 1 })]);
    for (const enemy of ctx.enemies) addShock(ctx, enemy, 1, 0);
    judgeNow(ctx);
    const ln = ctx.state.segments.lines[0] as SegmentLinesState;
    expect((ctx.enemies[0] as Enemy).alive).toBe(false);
    expect(linksOf(ln)).toEqual([
      [1, C.x, C.y, 2, C.x + 100, C.y],
      [3, C.x + 300, C.y, 2, C.x + 100, C.y],
    ]);
  });
});

describe('the ids of a pool segment’s links (V1c)', () => {
  it('hold the drone rows of a drones segment and every row of a summons segment, pool drones for both', () => {
    for (const endpoints of ['drones', 'summons'] as const) {
      const ctx = ctxOf([], [summons(4, 2), seg(endpoints, { links: 2 })]);
      addSpirits(ctx, 3, 40, 40);
      const ds = ctx.sys.drones;
      // Rows 1–4 drones, 5–6 turrets, 7–9 spirits, spread over a 3 × 3 grid.
      for (let s = 0; s < ds.count; s++) {
        ds.x[s] = C.x + (s % 3) * 70 + s;
        ds.y[s] = C.y + Math.floor(s / 3) * 70;
      }
      judgeNow(ctx);
      const ln = ctx.state.segments.lines[0] as SegmentLinesState;
      expect(ln.pool).toBe('drones');
      expect(ln.count).toBeGreaterThan(3);
      expect(linksOf(ln)).toEqual(expectedOf(ctx.state, ln));
      const kinds = new Set(
        linksOf(ln).flatMap(([id1, , , id2]) =>
          [id1, id2].map((id) => ds.kind[slotOfRow(ds, ds.count, id as number)]),
        ),
      );
      expect([...kinds].sort()).toEqual(
        endpoints === 'drones'
          ? [DRONE_KIND_DRONE]
          : [DRONE_KIND_DRONE, DRONE_KIND_TURRET, DRONE_KIND_SPIRIT].sort(),
      );
    }
  });

  it('follow the held pairs through a reuse: the same ids, where their rows stand now, a pair that lost a row dropped', () => {
    const ctx = ctxOf([], [summons(0, 0), seg('summons', { links: 1, pairPeriodSec: 0.5 })]);
    addSpirits(ctx, 4, 0, 0, 40);
    addSpirits(ctx, 2, 0, 0, 400);
    const ds = ctx.sys.drones;
    // Rows 1–6 in pairs: 1–2, 3–4, 5–6 near each other, the pairs far apart.
    const place = (offsets: readonly (readonly [number, number])[]): void => {
      offsets.forEach(([dx, dy], s) => {
        ds.x[s] = C.x + dx;
        ds.y[s] = C.y + dy;
      });
    };
    place([
      [0, 0],
      [30, 0],
      [0, 150],
      [30, 150],
      [0, 300],
      [30, 300],
    ]);
    judgeNow(ctx);
    const ln = ctx.state.segments.lines[0] as SegmentLinesState;
    const pairs = (): number[][] => linksOf(ln).map(([a, , , b]) => [a as number, b as number]);
    expect(pairs()).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    // Moved apart past the range, swapped across: a reuse keeps the pairs by id where they are.
    place([
      [500, 0],
      [-500, 0],
      [0, 450],
      [30, 150],
      [0, -300],
      [-30, 300],
    ]);
    judgeNow(ctx);
    expect(pairs()).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(linksOf(ln)).toEqual(expectedOf(ctx.state, ln));
    // Rows 1–4's time is up: the drone stage drops them and compacts 5–6 into slots 0–1.
    for (let t = 0; t < 40; t++) droneTick(ctx);
    expect(Array.from(ds.id.subarray(0, ds.count))).toEqual([5, 6]);
    ds.x[0] = C.x + 7;
    ds.y[0] = C.y + 9;
    const em = ctx.sys.segments.emitters[0];
    if (em !== undefined) em.pairTimer = 0;
    judgeNow(ctx);
    expect(linksOf(ln)).toEqual([[5, C.x + 7, C.y + 9, 6, ds.x[1] as number, ds.y[1] as number]]);
  });

  it('name the pool by each emitter’s endpoints, in emitter order', () => {
    const ctx = ctxOf([], [web(), summons(2), seg('drones'), seg('summons', { links: 1 })]);
    expect(ctx.state.segments.lines.map((ln) => ln.pool)).toEqual(['enemies', 'drones', 'drones']);
  });
});

/**
 * Over a whole run: after every tick a segment emitter judged (its pulse event), each of its
 * links' ids name endpoints that stand at the link's coordinates, every drone row present; an
 * enemy killed since the judgement is gone, so its end is not looked up. Returns the links and
 * the ends checked.
 */
function runChecked(
  stats: StatBlock,
  signature: SignatureSpec | undefined,
  seed: number,
): { links: number; ends: number; kinds: Set<number> } {
  const sim = createSimulation(
    makeConfig({
      seed,
      stats,
      ...(signature === undefined ? {} : { signature }),
      startWave: 12,
      maxTicks: 1500,
    }),
    makeTestData(),
  );
  let links = 0;
  let ends = 0;
  const kinds = new Set<number>();
  while (!sim.state.finished) {
    const events = sim.step(NO_INPUT);
    const state = sim.state;
    for (const event of events) {
      if (event.type !== 'pulse' || event.kind !== 'segment') continue;
      for (const ln of state.segments.lines) {
        const found = endpointsOf(state, ln);
        linksOf(ln).forEach(([id1, x1, y1, id2, x2, y2], i) => {
          const [a, b] = found[i] as ([number, number, number] | null)[];
          if (ln.pool === 'drones') {
            expect([a, b], `tick ${state.tick} link ${i}`).toEqual([
              [id1, x1, y1],
              [id2, x2, y2],
            ]);
            for (const id of [id1, id2]) {
              kinds.add(
                state.drones.kind[
                  slotOfRow(state.drones, state.droneCount, id as number)
                ] as number,
              );
            }
            ends += 2;
          } else {
            if (a !== null) expect(a).toEqual([id1, x1, y1]);
            if (b !== null) expect(b).toEqual([id2, x2, y2]);
            ends += (a === null ? 0 : 1) + (b === null ? 0 : 1);
          }
        });
        links += ln.count;
      }
    }
  }
  return { links, ends, kinds };
}

describe('the ids over whole runs (V1c, C5.8’s shapes)', () => {
  it('hold the fence’s rows: drones, the turret and spirits, every judgement', () => {
    const stats = makeStats(
      {
        damage: 8,
        maxLife: 1e6,
        critChance: 0.2,
        critMultiplier: 2,
        attackSpeed: 6,
        projectileCount: 2,
      },
      [],
      {
        triggers: [
          {
            source: 'outer.fire',
            spec: {
              on: 'nthAttack',
              every: 2,
              target: { pick: 'player' },
              do: [{ kind: 'spawnDrone', lifeSec: 2, damagePct: 0.5, aim: 'outer' }],
            },
          },
        ],
        conversions: [],
        emitters: [summons(2, 1), seg('summons', { links: 1 })],
      },
    );
    const { links, ends, kinds } = runChecked(stats, { id: 'magmaBomb' }, 1);
    expect(links).toBeGreaterThan(60);
    expect(ends).toBe(2 * links);
    expect([...kinds].sort()).toEqual(
      [DRONE_KIND_DRONE, DRONE_KIND_TURRET, DRONE_KIND_SPIRIT].sort(),
    );
  });

  it('hold the drone web’s drones through its held pairs, never the turret', () => {
    const stats = makeStats({ damage: 5, maxLife: 1e6, critChance: 0.2, critMultiplier: 2 }, [], {
      triggers: [],
      conversions: [],
      emitters: [
        on('outer.lightning', {
          kind: 'segment',
          endpoints: 'drones',
          links: 1,
          pairPeriodSec: 0.5,
        }),
      ],
    });
    const { links, kinds } = runChecked(stats, { id: 'swarm' }, 2);
    expect(links).toBeGreaterThan(40);
    expect([...kinds]).toEqual([DRONE_KIND_DRONE]);
  });

  it('hold 雷網’s shocked enemies, every one still alive standing at its end', () => {
    const stats = makeStats(
      {
        damage: 5,
        maxLife: 1e6,
        critChance: 0.2,
        critMultiplier: 2,
        shockChance: 0.5,
        chainCount: 1,
      },
      [],
      { triggers: [], conversions: [], emitters: [web()] },
    );
    const { links, ends } = runChecked(stats, undefined, 3);
    expect(links).toBeGreaterThan(100);
    expect(ends).toBeGreaterThan(links);
  });
});

describe('the id arrays beside the coordinates (review)', () => {
  it('are as long as the coordinates from the start and through a growth by doubling, every link’s ids held', () => {
    // 11 × 11 enemies 30 apart. The first judgement shocks 60 of them: more than 64 links in the
    // first 128. The second 70: a growth past 128, by doubling to 256. The third all 121: more
    // links than 2 × 70 in those 256.
    const placed: PlacedEnemy[] = [];
    for (let i = 0; i < 11; i++)
      for (let j = 0; j < 11; j++) placed.push(at(i * 30 - 150, j * 30 - 150));
    const ctx = ctxOf(placed, [web()]);
    const ln = ctx.state.segments.lines[0] as SegmentLinesState;
    const lengths = (): number[] => [ln.id1.length, ln.id2.length];
    expect(lengths()).toEqual([ln.x1.length, ln.x1.length]);
    const counts: number[] = [];
    const sizes: number[] = [];
    for (const n of [60, 70, 121]) {
      for (const enemy of ctx.enemies.slice(0, n)) addShock(ctx, enemy, 1, 0);
      judgeNow(ctx);
      expect(lengths(), `${n} shocked`).toEqual([ln.x1.length, ln.x1.length]);
      expect(linksOf(ln), `${n} shocked`).toEqual(expectedOf(ctx.state, ln));
      counts.push(ln.count);
      sizes.push(ln.x1.length);
    }
    expect(sizes).toEqual([128, 256, 256]);
    expect(counts[0]).toBeGreaterThan(64);
    expect(counts[2]).toBeGreaterThan(140);
  });
});
