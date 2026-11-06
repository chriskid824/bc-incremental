/**
 * 利息's ranks (B4's lead ruling 23a; gd:501 「利息（利率）」): a ranked node's ranks raise
 * interestRate and its interest trigger pays once a wave. A trigger that runs at the clear
 * (runsAtClear: a waveCleared trigger of interest effects alone) goes into the build once per
 * owned node whatever its rank, in its first rank's place, in webBuild and in M1's
 * collectExtras; every other trigger still goes in once a rank, as the base's own code path put
 * it (runsAtClear never true, `never.on` below). Each test's comment names the planted bug it
 * kills.
 */

import { describe, expect, it, vi } from 'vitest';
import { add, mul, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import type { SourcedTrigger } from '../../data/stats';
import { flat } from '../../data/templates';
import { INTEREST_RATE_MAX, INTEREST_RATE_STEP } from '../../data/triggers';
import type { TriggerSpec } from '../../data/triggers';
import type * as Triggers from '../../data/triggers';
import type { GameData } from '../../data/types';
import { assembleWeb } from '../../data/web/assemble';
import { FULL_SCOPE } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import type { AssembledWeb, NodeEffects, Ranks, WebNode } from '../../data/web/types';
import { createSimulation } from '../../sim/simulation';
import { makeConfig, makeTestData } from '../../sim/testing';
import { NO_INPUT } from '../../sim/types';
import type { SimEvent } from '../../sim/types';
import { createMetaState } from '../state';
import { collectExtras } from '../stats';
import { FIXTURE_TALENTS, fixtureData, talent } from '../testing';
import { webBuild } from './build';
import type { WebRun } from './build';
import { emptyProgress } from './rules';
import type { CharacterProgress } from './types';

// The base's own code path: under `never.on`, runsAtClear is never true, so every trigger goes in
// once a rank, as before the ruling.
const never = vi.hoisted(() => ({ on: false }));
vi.mock('../../data/triggers', async (importOriginal) => {
  const actual = await importOriginal<typeof Triggers>();
  return {
    ...actual,
    runsAtClear: (trigger: Parameters<typeof actual.runsAtClear>[0]): boolean =>
      !never.on && actual.runsAtClear(trigger),
  };
});

const fire = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);
/** A fixture ranked node of the greed outer, which the tests give 4 ranks. */
const ID = 'outer.greed.alpha.r1';
/** A center ranked node, which the run test gives the damage to clear its waves. */
const R1 = 'fire.center.alpha.r1';
const PAY: TriggerSpec = { on: 'waveCleared', do: [{ kind: 'interest' }] };
const HEAL: TriggerSpec = { on: 'kill', do: [{ kind: 'heal', lifePct: 0.01 }] };
const BURST: TriggerSpec = { on: 'hit', do: [{ kind: 'explode', radius: 60, damagePct: 0.5 }] };
/** 利息's ranks: +0.5% interestRate a rank, flat (ranked()'s default, increased, adds nothing). */
const RATE = flat('interestRate', INTEREST_RATE_STEP);

/** `web` with node `id` at `ranks` ranks holding `part`, its other lists empty. */
function withNode(
  web: AssembledWeb,
  id: string,
  ranks: Ranks,
  part: Partial<NodeEffects>,
): AssembledWeb {
  const effects: NodeEffects = {
    modifiers: [],
    triggers: [],
    conversions: [],
    emitters: [],
    rules: [],
    ...part,
  };
  const nodes = web.nodes.map((node): WebNode =>
    node.id === id ? { ...node, ranks, effects } : node,
  );
  return { ...web, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
}

const owning = (ranks: Readonly<Record<string, number>>): CharacterProgress => ({
  ...emptyProgress('fire'),
  ranks,
});

/** webBuild on the base's own code path, where every trigger goes in once a rank. */
function baseBuild(web: AssembledWeb, progress: CharacterProgress): WebRun {
  never.on = true;
  try {
    return webBuild(web, progress);
  } finally {
    never.on = false;
  }
}

/** `triggers` with every copy of `spec` past its first left out. */
function firstOnly(triggers: readonly SourcedTrigger[], spec: TriggerSpec): SourcedTrigger[] {
  let seen = false;
  return triggers.filter((trigger) => {
    if (trigger.spec !== spec) return true;
    if (seen) return false;
    seen = true;
    return true;
  });
}

describe('利息’s interest trigger on a ranked node (B4’s lead ruling 23a)', () => {
  it('puts it in once at rank 3, in its first rank’s place, and the node’s ordinary trigger three times', () => {
    // Planted bugs: the interest trigger put in once a rank again; every trigger put in once;
    // the interest trigger put in at the last rank's place.
    const web = withNode(fire, ID, 4, { modifiers: [RATE], triggers: [PAY, HEAL] });
    const run = webBuild(web, owning({ [ID]: 3 }));
    const pay = { source: 'outer.greed', spec: PAY };
    const heal = { source: 'outer.greed', spec: HEAL };
    expect(run.stats.triggers).toEqual([pay, heal, heal, heal]);
    // The ranks raise the starting rate: 3 × 0.5%.
    expect(run.stats.values.interestRate).toBe(3 * INTEREST_RATE_STEP);
  });

  it('puts every other trigger in once a rank as the base’s own code path does, at ranks 1 to 4, with and without an interest trigger beside them', () => {
    // Planted bug: every trigger put in once, or an ordinary trigger skipped past rank 1.
    const plain = withNode(
      withNode(fire, ID, 4, { modifiers: [RATE], triggers: [HEAL, BURST] }),
      R1,
      3,
      {
        triggers: [BURST],
      },
    );
    const paying = withNode(plain, ID, 4, { modifiers: [RATE], triggers: [HEAL, PAY, BURST] });
    for (const rank of [1, 2, 3, 4]) {
      const progress = owning({ [ID]: rank, [R1]: 2 });
      expect(webBuild(plain, progress), `${rank}`).toEqual(baseBuild(plain, progress));
      const all = baseBuild(paying, progress).stats.triggers;
      expect(
        all.filter((t) => t.spec === PAY),
        `${rank}`,
      ).toHaveLength(rank);
      expect(webBuild(paying, progress).stats.triggers, `${rank}`).toEqual(firstOnly(all, PAY));
    }
  });

  it('puts it in once in M1’s collectExtras at rank 3, the node’s other trigger three times, as the base’s own code path does for that one', () => {
    // Planted bugs: collectExtras putting the interest trigger in once a rank, or every trigger
    // once.
    const shards: TriggerSpec = { on: 'kill', do: [{ kind: 'gainShards', fraction: 0.2 }] };
    const data = fixtureData({
      talents: [
        ...FIXTURE_TALENTS,
        talent('hub.interest', 'repeatable', ['start'], {
          repeat: { baseShards: 10, growth: 2 },
          triggers: [PAY, shards],
        }),
      ],
    });
    const meta = createMetaState();
    meta.ranks.set('hub.interest', 3);
    const pay = { source: 'hub', spec: PAY };
    const shard = { source: 'hub', spec: shards };
    const extras = collectExtras(meta, data);
    expect(extras.triggers).toEqual([pay, shard, shard, shard]);
    never.on = true;
    try {
      const all = collectExtras(meta, data).triggers;
      expect(all).toEqual([pay, shard, pay, shard, pay, shard]);
      expect(extras.triggers).toEqual(firstOnly(all, PAY));
    } finally {
      never.on = false;
    }
  });

  it('pays one interest a wave at rank 3, from the rank-3 starting rate, n rising by 1 a wave and not 3', () => {
    // Planted bug: the interest trigger put in once a rank, so three payouts a wave, the rate
    // rising 1.5 points a wave.
    let web = withNode(fire, ID, 4, { modifiers: [RATE], triggers: [PAY] });
    web = withNode(web, R1, 3, { modifiers: [flat('damage', 1e3), flat('maxLife', 1e6)] });
    const run = webBuild(web, owning({ [ID]: 3, [R1]: 1 }));
    const start = run.stats.values.interestRate;
    expect(start).toBe(3 * INTEREST_RATE_STEP);
    const data: GameData = makeTestData({
      waves: {
        rules: [{ enemy: 'triangle', fromWave: 1, base: 2, perWave: 0, maxCount: 2 }],
        eliteEvery: 1000,
        bossEvery: 1000,
        spawnDurationSec: 0,
        waveTimerSec: 0.5,
      },
    });
    const sim = createSimulation(
      makeConfig({ stats: run.stats, waveCap: 15, maxTicks: 6000 }),
      data,
    );
    // Each tick's clears pay on the shards at the tick's end, which no stage after them changes.
    let pool: Num = ZERO;
    let n = 0;
    const cleared: number[] = [];
    const firsts: Num[] = [];
    while (!sim.state.finished) {
      const events: readonly SimEvent[] = sim.step(NO_INPUT);
      for (const event of events) {
        if (event.type !== 'waveCleared') continue;
        const rate = Math.min(INTEREST_RATE_MAX, start + n * INTEREST_RATE_STEP);
        const paid = mul(sim.state.shards, rate);
        if (n === 0) firsts.push(paid, mul(sim.state.shards, 3 * INTEREST_RATE_STEP));
        pool = add(pool, paid);
        n++;
        cleared.push(event.wave);
      }
      expect(sim.state.interestShards, `${sim.state.tick}`).toEqual(pool);
      expect(sim.state.interestPayouts).toBe(n);
    }
    expect(cleared).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(sim.state.interestPayouts).toBe(15);
    expect(firsts[0]).toEqual(firsts[1]);
    expect(firsts[0]).not.toEqual(ZERO);
    expect(sim.result().interestShards).toEqual(pool);
  });
});

describe('a waveCleared trigger that is not interest alone', () => {
  it('goes in once a rank in webBuild and in collectExtras: ruling 23a tests runsAtClear, not the event', () => {
    // Planted bug: webBuild or collectExtras putting every waveCleared trigger in once.
    const waveHeal: TriggerSpec = { on: 'waveCleared', do: [{ kind: 'heal', lifePct: 0.01 }] };
    const web = withNode(fire, ID, 4, { modifiers: [RATE], triggers: [PAY, waveHeal] });
    const heal = { source: 'outer.greed', spec: waveHeal };
    expect(webBuild(web, owning({ [ID]: 3 })).stats.triggers).toEqual([
      { source: 'outer.greed', spec: PAY },
      heal,
      heal,
      heal,
    ]);
    const data = fixtureData({
      talents: [
        ...FIXTURE_TALENTS,
        talent('hub.interest', 'repeatable', ['start'], {
          repeat: { baseShards: 10, growth: 2 },
          triggers: [PAY, waveHeal],
        }),
      ],
    });
    const meta = createMetaState();
    meta.ranks.set('hub.interest', 3);
    const hubHeal = { source: 'hub', spec: waveHeal };
    expect(collectExtras(meta, data).triggers).toEqual([
      { source: 'hub', spec: PAY },
      hubHeal,
      hubHeal,
      hubHeal,
    ]);
  });
});
