/**
 * 雷 (lightning, clock 3; gd §4.4): the archetype outer of 雷塔, lighter than its center: no
 * three-phase arc, forks, bounces, charge, shield-breaking arcs, strikes or nets; one more chain
 * only. Chains are M1's (each jump keeps 70%, at most 32 hits an attack). Every number is an
 * initial value for the balance simulator.
 */

import {
  answers,
  defineOuter,
  entry,
  flat,
  inc,
  keystone,
  mastery,
  notable,
  outerBranch,
  ranked,
  threshold,
} from '../templates';

/** The hits a chain jump delivers. */
const CHAIN = { tags: ['chain'] } as const;

export const LIGHTNING = defineOuter({
  id: 'lightning',
  // 導電: each attack chains once more from its primary target.
  entry: entry({ modifiers: [flat('chainCount', 1)] }),
  branches: [
    // 電弧: chain range and retention.
    outerBranch('arc', {
      r1: ranked('chainRange', 0.08, 4),
      r2: ranked('chainRetention', 0.02, 4, 'flat'),
      // 跳電: each jump has a 20% chance of one more (at most +2 an attack).
      // TODO(engine B3): interim data until an outer may write the chain policy's extra-jump
      // chance (a center-only credit today, D8); until then one more jump's worth of retention.
      a: notable('leap', { modifiers: [flat('chainRetention', 0.06)] }),
      r3: ranked('chainRange', 0.08, 3),
      r4: ranked('chainRetention', 0.02, 3, 'flat'),
      // 電荷: the first jump does not decay.
      // TODO(engine B3): interim data until an outer may write the chain policy's decay; until
      // then the jumps hit harder.
      b: notable('charge', { modifiers: [inc('damage', 0.2, CHAIN)] }),
      mastery: mastery(),
    }),
    // 靜電: shock effect and chain damage.
    outerBranch('static', {
      r1: ranked('shockEffect', 0.1, 4),
      r2: ranked('damage', 0.1, 4, 'increased', CHAIN),
      // 帶電: chain hits shock (+10% damage taken a stack for 2 s, at most 3).
      a: notable('charged', { modifiers: [flat('shockAlways', 1, CHAIN)] }),
      r3: ranked('shockEffect', 0.1, 3),
      r4: ranked('damage', 0.1, 3, 'increased', CHAIN),
      // 放電: a shocked enemy that dies sends a bolt at the nearest enemy.
      b: notable('discharge', {
        triggers: [
          {
            on: 'diedWithAilment',
            when: [{ victimHas: 'shock' }],
            do: [{ kind: 'chainBolt', jumps: 0, damagePct: 0.5, from: 'nearestToPoint' }],
          },
        ],
      }),
      mastery: mastery(),
    }),
  ],
  // 遠雷: chain range +100%; the last jump goes to the farthest enemy (答案：召喚者).
  // TODO(engine B3): the last jump to the farthest is the chain policy's lastFarthest, a
  // center-only credit today (D8); until then the range alone.
  answer: answers(notable('far-thunder', { modifiers: [inc('chainRange', 1)] }), 'summoner'),
  // 過載 (M1, shared with 雷塔): chains ×2, chain damage +350% (more); retention −20 points.
  keystone: keystone('overload', {
    rules: [{ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2, chainMore: 3.5 }],
  }),
  // 雷鳴: every 8 s a bolt strikes the densest spot and chains on 4 times from it.
  threshold: threshold({
    emitters: [
      {
        kind: 'strike',
        name: 'thunder',
        periodSec: 8,
        target: { pick: 'densest' },
        damagePct: 1,
        element: 'lightning',
        chainJumps: 4,
        shockStacks: 1,
      },
    ],
  }),
  payload: null,
  skin: { accent: 0xb48cff, shape: 'arc' },
  covers: {
    triangle: 'helps',
    pentagon: 'helps',
    dasher: 'helps',
    shooter: 'helps',
    summoner: 'answer',
  },
});
