/**
 * V1e: V1's view members (ShotPoolState.launched, ZonePoolState.record and slow,
 * SegmentLinesState.id1, id2 and pool) change nothing a run does. A zone build, a lob build and
 * a segment build run here at two seeds, hashing every tick's events and the members each view
 * had before V1, listed by name (not every member, so the new ones do not move it), then the
 * result; the digests were recorded by this same file on V1's parent, 13bbb2e.
 */

import { describe, expect, it } from 'vitest';
import { toNumber } from '../core/num';
import type { SourcedEmitter } from '../data/emitters';
import type { RuleSpec, SignatureSpec } from '../data/rules';
import type { StatBlock } from '../data/stats';
import type { TriggerSpec } from '../data/triggers';
import type { TestModule } from './rules';
import { createSimulation } from './simulation';
import { createRunHash, makeConfig, makeStats, makeTestData, projectResult } from './testing';
import { NO_INPUT } from './types';
import type { SimState } from './types';

/** The members each pool view had before V1, by name. */
const SHOT_MEMBERS = ['id', 'motion', 'x', 'y', 'vx', 'vy', 'until', 'form'] as const;
const ZONE_MEMBERS = ['id', 'x', 'y', 'radiusSq', 'created', 'expiresAt', 'signature'] as const;
const LINE_MEMBERS = ['x1', 'y1', 'x2', 'y2'] as const;
const DRONE_MEMBERS = [
  'id',
  'kind',
  'mode',
  'x',
  'y',
  'prevX',
  'prevY',
  'targetId',
  'owner',
  'seat',
] as const;

type Rows = Readonly<Record<string, ArrayLike<number>>>;

/** The first `n` slots of each of `members` of `pool`, as lists. */
const slotsOf = (pool: unknown, members: readonly string[], n: number): number[][] =>
  members.map((m) => Array.from({ length: n }, (_, s) => (pool as Rows)[m]?.[s] as number));

/** The state's pre-V1 view, as JSON. */
function viewOf(state: Readonly<SimState>): string {
  return JSON.stringify([
    state.tick,
    state.wave,
    state.highestWaveCleared,
    state.player.life,
    state.player.shield,
    toNumber(state.shards),
    state.cores,
    state.enemies.map((e) => [e.id, e.x, e.y, e.prevX, e.prevY, toNumber(e.hp), e.alive]),
    state.shotCount,
    slotsOf(state.shots, SHOT_MEMBERS, state.shotCount),
    state.zoneCount,
    slotsOf(state.zones, ZONE_MEMBERS, state.zoneCount),
    state.segments.lines.map((ln) => [ln.count, slotsOf(ln, LINE_MEMBERS, ln.count)]),
    state.droneCount,
    slotsOf(state.drones, DRONE_MEMBERS, state.droneCount),
  ]);
}

interface ParityBuild {
  readonly stats: StatBlock;
  readonly rules?: readonly RuleSpec[];
  readonly signature?: SignatureSpec;
  readonly modules?: () => TestModule[];
}

/** A test module that gives the lob's fire zones a 35% slow (LobParams.zone). */
const slowFire = (): TestModule[] => [
  (b) => {
    const lob = b.signature().lob;
    if (lob !== null) lob.zone.slow = 0.35;
  },
];

const center = (triggers: readonly TriggerSpec[], emitters: readonly SourcedEmitter[] = []) => ({
  triggers: triggers.map((spec) => ({ source: 'center', spec })),
  conversions: [],
  emitters,
});

const BUILDS: Readonly<Record<string, ParityBuild>> = {
  // Effect zones with and without a slow, a burning one among them, on M1's volley.
  zones: {
    stats: makeStats(
      { damage: 6, maxLife: 1e6, critChance: 0.2, critMultiplier: 2, attackSpeed: 6 },
      [],
      center([
        {
          on: 'hit',
          when: [{ chance: 0.3 }],
          do: [
            { kind: 'groundZone', radius: 70, durationSec: 1.5, damagePctPerSec: 0.5, slow: 0.4 },
          ],
        },
        {
          on: 'kill',
          do: [
            {
              kind: 'groundZone',
              radius: 50,
              durationSec: 2,
              damagePctPerSec: 0,
              ailment: 'burn',
              ailmentStacks: 2,
            },
          ],
        },
      ]),
    ),
  },
  // The magma bombs: lobbed shots, their fire zones slowing, steadyAim, and effect shots.
  lob: {
    stats: makeStats(
      {
        damage: 8,
        maxLife: 1e6,
        critChance: 0.2,
        critMultiplier: 2,
        igniteChance: 0.2,
        chainCount: 1,
        attackSpeed: 6,
        projectileCount: 3,
      },
      [],
      center([
        {
          on: 'hit',
          when: [{ chance: 0.2 }],
          do: [{ kind: 'projectiles', count: 2, aim: 'radial', damagePct: 0.2 }],
        },
      ]),
    ),
    rules: [{ id: 'steadyAim', everyNth: 4, critMultiplierMore: 0.5, counts: 'shot' }],
    signature: { id: 'magmaBomb' },
    modules: slowFire,
  },
  // 雷網 on shocked enemies, a fence between every row and a web between the drones that
  // pairs every 0.5 s, on the swarm with a granted turret and spirits.
  segments: {
    stats: makeStats(
      { damage: 5, maxLife: 1e6, critChance: 0.2, critMultiplier: 2, shockChance: 0.4 },
      [],
      {
        triggers: [
          {
            source: 'outer.summon',
            spec: {
              on: 'nthAttack',
              every: 3,
              target: { pick: 'player' },
              do: [{ kind: 'spawnDrone', lifeSec: 2, damagePct: 0.5, aim: 'outer' }],
            },
          },
        ],
        conversions: [],
        emitters: [
          { source: 'outer.lightning', grant: { kind: 'segment', endpoints: 'shocked' } },
          { source: 'outer.summon', grant: { kind: 'drone', drones: 2, turrets: 1 } },
          { source: 'outer.summon', grant: { kind: 'segment', endpoints: 'summons', links: 1 } },
          {
            source: 'outer.ice',
            grant: { kind: 'segment', endpoints: 'drones', links: 2, pairPeriodSec: 0.5 },
          },
        ],
      },
    ),
    signature: { id: 'swarm' },
  },
};

/**
 * The digests V1's parent (13bbb2e) gives, seeds 1 and 2, with E10a's barrageCapped among the
 * hashed counters (0 in all of them): without that key they are the parent's own, 1af237b4…,
 * 0e2128d2…; c446ec63…, cc06f126…; 5ca3a307…, 18c81616….
 */
const EXPECTED: Readonly<Record<string, readonly [string, string]>> = {
  zones: ['257ffd41430675ac', '8c3d9eac497b8861'],
  lob: ['e83d21d09747f416', '2548af5c45d01275'],
  segments: ['d3a7aa474b282060', 'eddf5907eb30dae7'],
};

const TICKS = 1200;

function digestOf(build: ParityBuild, seed: number): string {
  const sim = createSimulation(
    makeConfig({
      seed,
      stats: build.stats,
      rules: build.rules ?? [],
      ...(build.signature === undefined ? {} : { signature: build.signature }),
      startWave: 12,
      maxTicks: TICKS,
    }),
    makeTestData(),
    build.modules?.() ?? [],
  );
  const hash = createRunHash();
  while (!sim.state.finished) {
    hash.update(JSON.stringify(sim.step(NO_INPUT)));
    hash.update(viewOf(sim.state));
  }
  const result = sim.result();
  hash.update(JSON.stringify([projectResult(result), result.damageBySource, result.counters]));
  return hash.digest();
}

describe('a run with and without V1 (V1e)', () => {
  it('runs builds that reach what V1 adds to: zones, lobs and links of every kind of endpoint', () => {
    const counts = (build: ParityBuild): Record<string, number> => {
      const sim = createSimulation(
        makeConfig({
          seed: 1,
          stats: build.stats,
          rules: build.rules ?? [],
          ...(build.signature === undefined ? {} : { signature: build.signature }),
          startWave: 12,
          maxTicks: TICKS,
        }),
        makeTestData(),
        build.modules?.() ?? [],
      );
      const n: Record<string, number> = {};
      const add = (key: string, by = 1): void => {
        n[key] = (n[key] ?? 0) + by;
      };
      while (!sim.state.finished) {
        for (const event of sim.step(NO_INPUT)) {
          if (event.type === 'zone') add(event.signature ? 'signatureZones' : 'effectZones');
          if (event.type === 'lob') add('lobs');
          if (event.type === 'zoneEnd' && event.evicted) add('evicted');
          if (event.type === 'pulse' && event.kind === 'segment') {
            const i = event.id;
            add(`judgements${i}`);
          }
        }
        sim.state.segments.lines.forEach((ln, i) => add(`linkTicks${i}`, ln.count));
        add('shotTicks', sim.state.shotCount);
      }
      return n;
    };
    const zones = counts(BUILDS.zones as ParityBuild);
    expect(zones.effectZones).toBeGreaterThan(100);
    const lob = counts(BUILDS.lob as ParityBuild);
    expect(lob.lobs).toBeGreaterThan(50);
    expect(lob.signatureZones).toBeGreaterThan(30);
    const seg = counts(BUILDS.segments as ParityBuild);
    for (const i of [0, 1, 2]) expect(seg[`linkTicks${i}`], `emitter ${i}`).toBeGreaterThan(200);
  });

  it.each(Object.keys(BUILDS))(
    '%s: the same events and view at seeds 1 and 2 as on the parent',
    (name) => {
      const build = BUILDS[name] as ParityBuild;
      expect([digestOf(build, 1), digestOf(build, 2)]).toEqual(EXPECTED[name]);
    },
  );
});
