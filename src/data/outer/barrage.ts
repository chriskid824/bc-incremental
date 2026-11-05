/**
 * 彈幕 (barrage, clock 10; gd §4.11): small projectiles that fly with your attacks, each a small
 * hit. The barrage count (barrageCount) is how many an attack sends: 副彈 gives 2, and each rank
 * of 齊射 one more; the attack trigger's projectiles and the barrage payload's grow with it
 * (countStat). Every number is an initial value for the balance simulator.
 */

import {
  answers,
  defineOuter,
  entry,
  flat,
  fusionRank,
  inc,
  keystone,
  mastery,
  more,
  notable,
  outerBranch,
  ranked,
  threshold,
} from '../templates';

/** The small projectiles' hits: trigger projectiles (every effect projectile's). */
const BULLETS = { tags: ['projectile', 'trigger'] } as const;

export const BARRAGE = defineOuter({
  id: 'barrage',
  // 副彈: each attack sends 2 small projectiles of 25% at different enemies.
  entry: entry({
    modifiers: [flat('barrageCount', 2)],
    triggers: [
      {
        on: 'nthAttack',
        every: 1,
        do: [
          {
            kind: 'projectiles',
            count: 2,
            damagePct: 0.25,
            aim: 'distinct',
            from: 'player',
            countStat: 'barrageCount',
          },
        ],
      },
    ],
  }),
  branches: [
    // 齊射: projectile count and projectile damage.
    outerBranch('volley', {
      r1: ranked('barrageCount', 0.5, 4, 'flat'),
      r2: ranked('damage', 0.1, 4, 'increased', BULLETS),
      // 扇形: the small projectiles fan out at one target.
      // TODO(engine B3): interim data until a ◆ can turn the entry's aim to a fan; until then the
      // small projectiles hit harder.
      a: notable('fan', { modifiers: [inc('damage', 0.25, BULLETS)] }),
      r3: ranked('barrageCount', 0.5, 3, 'flat'),
      r4: ranked('damage', 0.1, 3, 'increased', BULLETS),
      // 環射: every 6th attack fires small projectiles in 12 directions.
      b: notable('ring-shot', {
        triggers: [
          {
            on: 'nthAttack',
            every: 6,
            do: [
              { kind: 'projectiles', count: 12, damagePct: 0.25, aim: 'radial', from: 'player' },
            ],
          },
        ],
      }),
      mastery: mastery(),
    }),
    // 分裂: pierce and split.
    outerBranch('split', {
      r1: ranked('damage', 0.08, 4, 'increased', BULLETS),
      r2: ranked('barrageCount', 0.5, 4, 'flat'),
      // 子母彈: a small projectile that kills splits into 3 (the split ones do not split again).
      // TODO(engine B3): interim data until a kill can tell a small projectile's; until then a
      // kill by a hit splits 3 small projectiles a third of the time.
      a: notable('cluster', {
        triggers: [
          {
            on: 'kill',
            when: [{ killedBy: 'hit' }, { chance: 0.33 }],
            do: [{ kind: 'projectiles', count: 3, damagePct: 0.25, aim: 'radial' }],
          },
        ],
      }),
      r3: ranked('damage', 0.08, 3, 'increased', BULLETS),
      r4: ranked('barrageCount', 0.5, 3, 'flat'),
      // 聚焦: with one target left every small projectile goes at it, +20% (答案：Boss).
      // TODO(engine B3): interim data until a one-enemy-left condition lands; until then the
      // small projectiles deal +20% to bosses.
      b: answers(
        notable('focus', {
          modifiers: [inc('damage', 0.2, { ...BULLETS, when: [{ targetKind: 'boss' }] })],
        }),
        'boss',
      ),
      mastery: mastery(),
    }),
  ],
  // 集火: the hits on one enemy within 0.2 s are summed against its shield (答案：盾兵).
  answer: answers(notable('focus-fire', { modifiers: [flat('shieldPoolSec', 0.2)] }), 'shielder'),
  // 子彈地獄: ×2 small projectiles, each −40% damage; they bounce off the arena's edge (twice).
  // TODO(engine B3): the bounce off the edge waits on a barrage bounce stat; the count and the
  // cost are here.
  keystone: keystone('bullet-hell', {
    modifiers: [more('barrageCount', 1), more('damage', -0.4, BULLETS)],
  }),
  // 彈雨: for 2 s in every 10, ×3 small projectiles.
  // TODO(B3): interim data until 彈雨's own rule module (Q12 A); until then a burst of 12 small
  // projectiles every 10 s.
  threshold: threshold({
    triggers: [
      {
        on: 'periodic',
        every: 10,
        target: { pick: 'nearest' },
        do: [
          {
            kind: 'projectiles',
            count: 12,
            damagePct: 0.25,
            aim: 'distinct',
            from: 'player',
            countStat: 'barrageCount',
          },
        ],
      },
    ],
  }),
  payload: {
    type: 'placement',
    // 4 small projectiles of 25%, one more for each the barrage outer adds (its inPayload bonus).
    effects: [
      { kind: 'projectiles', count: 4, damagePct: 0.25, aim: 'radial', countStat: 'barrageCount' },
    ],
    bonus: { form: 'inPayload' },
    ranks: [
      fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3), // r1: payload strength
      fusionRank([flat('barrageCount', 0.5)], 3), // r2: more projectiles
      fusionRank([inc('damage', 0.05, { scope: 'fusion' })], 3), // r3
    ],
  },
  skin: { accent: 0xffb627, shape: 'bullet' },
  covers: {
    triangle: 'helps',
    pentagon: 'helps',
    shielder: 'answer',
    dasher: 'helps',
    boss: 'answer',
  },
});
