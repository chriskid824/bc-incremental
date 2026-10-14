/**
 * Golden runs: every GOLDEN_BUILDS build for 1,200 ticks at two seeds and start waves, hashed
 * tick by tick (events projected to their M1 keys, see projectEvent) together with the result.
 * A refactor of the simulation must keep every hash; a behaviour change records new ones and
 * says why in its commit.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GameData } from '../data/types';
import { createSimulation } from './simulation';
import {
  GOLDEN_BUILDS,
  M1_EVENT_KEYS,
  makeConfig,
  makeTestData,
  projectEvent,
  projectResult,
} from './testing';
import { NO_INPUT } from './types';
import type { RunConfig } from './types';

const GOLDEN_TICKS = 1200;
/**
 * [seed, start wave]: from wave 8, through the wave-10 boss; from wave 15, an elite wave where
 * enemies reach the player and the weaker builds die early.
 */
const GOLDEN_STARTS = [
  [1, 8],
  [2, 15],
] as const;

const EXPECTED: Readonly<Record<string, string>> = {
  'plain/s1/w8': 'af568e9f22a08b1a',
  'plain/s2/w15': '0c63ad3dfa7ecf1d',
  'crit/s1/w8': '1d3134bd6cc08797',
  'crit/s2/w15': '809537572c82dcb3',
  'burn/s1/w8': '6c8ec26aef32f61a',
  'burn/s2/w15': '9999aa18a483783f',
  'chain/s1/w8': '81af5a48b489fbde',
  'chain/s2/w15': '1ef91dfddff34e17',
  'volley/s1/w8': '00db97f28b753352',
  'volley/s2/w15': 'd32ae28fbe918de9',
  'steady/s1/w8': '92f9fd2df6386f78',
  'steady/s2/w15': '2c89074834e4b95e',
  // Re-recorded in C3.7b: a capped burn stack that a spread replaces after this tick's burn
  // step is no longer paid twice (was c23112de799a04d3 and 26b754e051e18cf6).
  'pandemic/s1/w8': '035884c0c8646cb4',
  'pandemic/s2/w15': '608ef1f480a3d791',
  'eternalPandemic/s1/w8': '076de6ecb082bb31',
  'eternalPandemic/s2/w15': '20e0c10296976322',
  'overload/s1/w8': 'f90ba816bd509835',
  'overload/s2/w15': '7ba5605f005b2670',
  'glass/s1/w8': 'f93535ad6a6715bb',
  'glass/s2/w15': '7c03ce259474edf0',
  'searing/s1/w8': '705c34ef8ef72f5c',
  'searing/s2/w15': '6d84d560cf5a9caa',
  'bridges/s1/w8': '6cd5fac928210d1d',
  'bridges/s2/w15': 'cdfdae7fea95c3ad',
};

interface GoldenRun {
  /** First 16 hex digits of the SHA-256 of every tick's projected events and the result. */
  readonly hash: string;
  /** Event types seen, plus 'critHit' and 'chainJump' for those kinds of hit. */
  readonly seen: ReadonlySet<string>;
}

function goldenRun(config: RunConfig, data: GameData): GoldenRun {
  const sim = createSimulation(config, data);
  const hash = createHash('sha256');
  const seen = new Set<string>();
  while (!sim.state.finished) {
    const events = sim.step(NO_INPUT);
    for (const event of events) {
      seen.add(event.type);
      if (event.type === 'hit' && event.crit) seen.add('critHit');
      if (event.type === 'hit' && event.chainIndex > 0) seen.add('chainJump');
    }
    hash.update(JSON.stringify(events.map(projectEvent)));
  }
  hash.update(JSON.stringify(projectResult(sim.result())));
  return { hash: hash.digest('hex').slice(0, 16), seen };
}

describe('golden runs', () => {
  const data = makeTestData();
  const runs = Object.entries(GOLDEN_BUILDS).flatMap(([name, build]) =>
    GOLDEN_STARTS.map(([seed, startWave]) => {
      const config = makeConfig({ seed, startWave, ...build, maxTicks: GOLDEN_TICKS });
      return { id: `${name}/s${seed}/w${startWave}`, ...goldenRun(config, data) };
    }),
  );

  it('runs 24 cases that between them raise every M1 event and hit kind', () => {
    expect(runs).toHaveLength(24);
    expect(Object.keys(EXPECTED).sort()).toEqual(runs.map((run) => run.id).sort());
    const seen = new Set(runs.flatMap((run) => [...run.seen]));
    for (const kind of [...Object.keys(M1_EVENT_KEYS), 'critHit', 'chainJump']) {
      expect(seen, kind).toContain(kind);
    }
  });

  it.each(runs)('$id', ({ id, hash }) => {
    expect(hash).toBe(EXPECTED[id]);
  });
});
