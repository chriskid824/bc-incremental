/**
 * B3's rule modules: 霜晶's hand cores (frostFusions.ts), 火雷 and 雷召喚 (lightningFusions.ts) and
 * 大出血 (hemorrhage.ts), compiled and run on squares.
 */

import { describe, expect, it } from 'vitest';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import { BLEED_RING_MAX_STACKS } from '../ailments/rings';
import { compileBuild } from '../build/compile';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, makeTestData } from '../testing';
import { NO_INPUT } from '../types';
import type { SimEvent } from '../types';

const ICE: SignatureSpec = { id: 'iceFan' };
const MAGMA: SignatureSpec = { id: 'magmaBomb' };
const SWARM: SignatureSpec = { id: 'swarm' };

const THERMAL: RuleSpec = { id: 'thermalShock', burnStacks: 2, hitPct: 2 };
const SUPER: RuleSpec = {
  id: 'superconduct',
  arcs: 3,
  arcDamagePct: 0.5,
  frostPct: 0.2,
  shockFrostMore: 0.5,
};
const SENTRY: RuleSpec = {
  id: 'frostSentry',
  chance: 1,
  lifeSec: 5,
  maxLive: 4,
  everySec: 0.5,
  range: 300,
  count: 3,
  spreadDeg: 30,
  damagePct: 0.3,
};
const PLASMA: RuleSpec = { id: 'plasma', arcsPerBlast: 3, arcDamagePct: 0.5, shockBurnMore: 0.3 };
const WEB: RuleSpec = { id: 'stormWeb', damagePct: 0.1, periodSec: 0.25, pairPeriodSec: 0.5 };

/** `n` squares a wave that walk in, with hp × hpMult. */
function squares(n: number, hpMult: number) {
  return makeTestData({
    enemies: { square: { hpMult } },
    waves: {
      rules: [{ enemy: 'square', fromWave: 1, base: n, perWave: 0, maxCount: n }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
    },
  });
}

const TOUGH = squares(8, 1e12);

/** The events of a run of `rules` on `signature`, `ticks` long. */
function run(
  signature: SignatureSpec,
  rules: readonly RuleSpec[],
  ticks: number,
  stats: Partial<Record<StatId, number>> = {},
  data = TOUGH,
): SimEvent[] {
  const sim = createSimulation(
    makeConfig({
      stats: makeStats({ maxLife: 1e12, ...stats }),
      signature,
      rules,
      maxTicks: ticks,
    }),
    data,
  );
  const events: SimEvent[] = [];
  while (!sim.state.finished) events.push(...sim.step(NO_INPUT));
  return events;
}

const count = (events: readonly SimEvent[], type: SimEvent['type']): number =>
  events.filter((e) => e.type === type).length;
/** Hits carrying every tag of `mask`. */
const hitsWith = (events: readonly SimEvent[], mask: number): number =>
  events.filter((e) => e.type === 'hit' && (e.tags & mask) === mask).length;

describe('thermalShock (冰火「熱震」)', () => {
  it('compiles a freeze burn and an ignited-while-frozen hit', () => {
    const specs = compileBuild(makeStats(), [THERMAL], ICE).effects.map((fx) => fx.spec);
    expect(specs).toContainEqual(
      expect.objectContaining({ kind: 'applyAilment', ailment: 'burn', stacks: 2 }),
    );
    expect(specs).toContainEqual(
      expect.objectContaining({
        kind: 'explode',
        radius: 1,
        maxTargets: 1,
        order: 'nearest',
        damagePct: 2,
      }),
    );
    expect(specs).toContainEqual({ kind: 'thaw' });
  });

  it('ignites the enemies it freezes and hits them while they are frozen', () => {
    const stats = { frostOnHit: 0.4, igniteChance: 0 };
    const plain = run(ICE, [], 900, stats);
    const shock = run(ICE, [THERMAL], 900, stats);
    expect(count(plain, 'freeze')).toBeGreaterThan(0);
    expect(count(plain, 'ignite')).toBe(0);
    expect(count(shock, 'ignite')).toBeGreaterThan(0);
    expect(hitsWith(shock, TAG.trigger | TAG.area)).toBeGreaterThan(0);
  });

  it('is a compile error in a run of another signature', () => {
    expect(() => compileBuild(makeStats(), [THERMAL], MAGMA)).toThrow(
      "rule 'thermalShock' needs the iceFan signature, but this run's signature is 'magmaBomb'",
    );
  });
});

describe('superconduct (冰雷「超導」)', () => {
  it('compiles 3 freeze bolts to the nearest other enemies, their chill and the shocked frost', () => {
    const build = compileBuild(makeStats(), [SUPER], ICE);
    const specs = build.effects.map((fx) => fx.spec);
    expect(specs).toContainEqual(
      expect.objectContaining({
        kind: 'chainBolt',
        from: 'nearestOther',
        bolts: 3,
        jumps: 0,
        arc: true,
        damagePct: 0.5,
        shockStacks: 1,
      }),
    );
    expect(specs).toContainEqual(
      expect.objectContaining({ kind: 'addFrost', amount: 0.2, maxTargets: 3 }),
    );
    expect(build.flags.frostGainShocked).toBe(0.5);
  });

  it('arcs from each freeze', () => {
    const stats = { frostOnHit: 0.4 };
    const plain = run(ICE, [], 900, stats);
    const arcs = run(ICE, [SUPER], 900, stats);
    expect(hitsWith(plain, TAG.trigger)).toBe(0);
    expect(hitsWith(arcs, TAG.trigger)).toBeGreaterThan(0);
  });
});

describe('shatterChain and frozenNoSplit (◆連鎖碎裂, ◆粉碎)', () => {
  it('set their build flags', () => {
    const plain = compileBuild(makeStats(), [], ICE).flags;
    expect(plain.shatterChain).toBe(false);
    expect(plain.frozenNoSplit).toBe(false);
    const flags = compileBuild(
      makeStats(),
      [{ id: 'shatterChain' }, { id: 'frozenNoSplit' }],
      ICE,
    ).flags;
    expect(flags.shatterChain).toBe(true);
    expect(flags.frozenNoSplit).toBe(true);
  });
});

describe('frostSentry (冰靈「冰晶哨」)', () => {
  it('compiles a shatter-chance seated sentry that fires a cold fan', () => {
    const specs = compileBuild(makeStats(), [SENTRY], ICE).effects.map((fx) => fx.spec);
    expect(specs).toContainEqual(
      expect.objectContaining({
        kind: 'spawnDrone',
        lifeSec: 5,
        damagePct: 0,
        maxLive: 4,
        seat: true,
        element: 'cold',
        fires: {
          everySec: 0.5,
          range: 300,
          do: { kind: 'projectiles', count: 3, aim: 'fan', spreadDeg: 30, damagePct: 0.3 },
        },
      }),
    );
  });

  it('leaves sentries where frozen enemies shatter', () => {
    const data = squares(20, 1);
    const stats = { frostOnHit: 1 };
    const plain = run(ICE, [], 900, stats, data);
    const sentry = run(ICE, [SENTRY], 900, stats, data);
    expect(count(plain, 'shatter')).toBeGreaterThan(0);
    expect(hitsWith(plain, TAG.minion | TAG.projectile)).toBe(0);
    // Seated: no dash, so no impacts; its cones are minion projectiles.
    expect(count(sentry, 'impact')).toBe(0);
    expect(hitsWith(sentry, TAG.minion | TAG.projectile | TAG.cold)).toBeGreaterThan(0);
  });
});

describe('plasma (火雷「電漿」)', () => {
  it('compiles a bolt to the nearest other enemy and the shocked burn more', () => {
    const build = compileBuild(makeStats(), [PLASMA], MAGMA);
    expect(build.effects.map((fx) => fx.spec)).toContainEqual(
      expect.objectContaining({
        kind: 'chainBolt',
        from: 'nearestOther',
        jumps: 0,
        arc: true,
        damagePct: 0.5,
        shockStacks: 1,
      }),
    );
  });

  it('arcs from the burning enemies an explosion hits', () => {
    const bolts = (events: readonly SimEvent[]): number =>
      hitsWith(events, TAG.trigger | TAG.chain | TAG.lightning);
    expect(bolts(run(MAGMA, [], 900, { igniteChance: 1 }))).toBe(0);
    expect(bolts(run(MAGMA, [PLASMA], 900, { igniteChance: 1 }))).toBeGreaterThan(0);
  });

  it('is a compile error in a run of another signature', () => {
    expect(() => compileBuild(makeStats(), [PLASMA], ICE)).toThrow(
      "rule 'plasma' tunes the magmaBomb signature, but this run's signature is 'iceFan'",
    );
  });
});

describe('stormWeb (雷召喚「雷網蜂」)', () => {
  it('grants a drone segment emitter', () => {
    const plain = compileBuild(makeStats(), [], SWARM);
    const build = compileBuild(makeStats(), [WEB], SWARM);
    expect(build.emitters).toHaveLength(plain.emitters.length + 1);
    expect(build.emitters.at(-1)).toMatchObject({ kind: 'segment', endpoints: 'drones' });
  });

  it('judges its links as pulses, which shock the enemies under them', () => {
    const plain = run(SWARM, [], 1800);
    const web = run(SWARM, [WEB], 1800);
    expect(count(web, 'pulse')).toBeGreaterThan(count(plain, 'pulse'));
  });

  it('is a compile error in a run of another signature', () => {
    expect(() => compileBuild(makeStats(), [WEB], ICE)).toThrow(
      "rule 'stormWeb' tunes the swarm signature, but this run's signature is 'iceFan'",
    );
  });
});

describe('hemorrhage (大出血)', () => {
  it('stacks bleeds in rings and drops the moving ×3', () => {
    const plain = compileBuild(makeStats(), []);
    const build = compileBuild(makeStats(), [{ id: 'hemorrhage', maxStacks: 8 }]);
    expect([plain.flags.bleedRings, plain.flags.bleedMoveMult]).toEqual([false, 3]);
    expect(build.flags).toMatchObject({
      bleedRings: true,
      bleedMaxStacks: BLEED_RING_MAX_STACKS,
      bleedMoveMult: 1,
    });
  });
});

describe('bulletRain (彈雨)', () => {
  const RAIN: RuleSpec = {
    id: 'bulletRain',
    periodSec: 10,
    durationSec: 2,
    countMult: 3,
    damagePct: 0.25,
  };

  it('compiles the entry volley it repeats', () => {
    const specs = compileBuild(makeStats(), [RAIN], ICE).effects.map((fx) => fx.spec);
    expect(specs).toContainEqual(
      expect.objectContaining({ kind: 'projectiles', aim: 'distinct', countStat: 'barrageCount' }),
    );
  });

  it('sends small projectiles only in the last 2 s of every 10', () => {
    const stats = { barrageCount: 2 };
    const bullets = (events: readonly SimEvent[]): number =>
      hitsWith(events, TAG.trigger | TAG.projectile);
    // 7.5 s: before the first window; 10 s: through it.
    expect(bullets(run(ICE, [RAIN], 450, stats))).toBe(0);
    expect(bullets(run(ICE, [RAIN], 600, stats))).toBeGreaterThan(0);
    expect(bullets(run(ICE, [], 600, stats))).toBe(0);
  });
});
