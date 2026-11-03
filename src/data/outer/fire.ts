/**
 * 火 (fire, clock 12; gd §4.1): the archetype outer of 熔核, lighter than its center: no bombs,
 * fire zones, 白熱, 熱浪, 火山 or 火環, and 長燃's +0.6 s against the center's 悶燒 +2 s. Burn is
 * M1's (150% of the hit a second for 1.2 s, 5 stacks). Every number is an initial value for the
 * balance simulator.
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
  notable,
  outerBranch,
  ranked,
  threshold,
} from '../templates';

export const FIRE = defineOuter({
  id: 'fire',
  // 火種: hits ignite 10% of the time.
  entry: entry({ modifiers: [flat('igniteChance', 0.1)] }),
  branches: [
    // 火勢: ignite chance and burn damage.
    outerBranch('blaze', {
      r1: ranked('igniteChance', 0.03, 4, 'flat'),
      r2: ranked('burnDamage', 0.15, 4),
      // 火上加油: burning enemies take +10% hit damage.
      a: notable('fuel', {
        modifiers: [inc('damage', 0.1, { tags: ['hit'], when: [{ targetHas: 'burn' }] })],
      }),
      r3: ranked('igniteChance', 0.03, 3, 'flat'),
      r4: ranked('burnDamage', 0.15, 3),
      // 長燃: burns last 0.6 s longer and stack 2 higher.
      b: notable('long-burn', {
        modifiers: [flat('burnDuration', 0.6), flat('burnMaxStacks', 2)],
      }),
      mastery: mastery(),
    }),
    // 野火: spread distance and burn damage.
    outerBranch('wildfire', {
      r1: ranked('spreadRadius', 0.1, 4),
      r2: ranked('burnDamage', 0.15, 4),
      // 火星: a burning enemy that dies ignites the 2 nearest within 90 (答案：三角).
      a: answers(
        notable('sparks', {
          triggers: [
            {
              on: 'diedWithAilment',
              when: [{ victimHas: 'burn' }],
              do: [
                {
                  kind: 'applyAilment',
                  ailment: 'burn',
                  radius: 90,
                  maxTargets: 2,
                  order: 'nearest',
                  spread: true,
                },
              ],
            },
          ],
        }),
        'triangle',
      ),
      r3: ranked('spreadRadius', 0.1, 3),
      r4: ranked('burnDamage', 0.15, 3),
      // 焦痕: a burning enemy that dies leaves a 1 s small fire zone (radius 40, 20% a second).
      b: notable('scorch', {
        triggers: [
          {
            on: 'kill',
            when: [{ victimHas: 'burn' }],
            do: [{ kind: 'groundZone', radius: 40, durationSec: 1, damagePctPerSec: 0.2 }],
          },
        ],
      }),
      mastery: mastery(),
    }),
  ],
  // 灼熱地帶: the enemies within 200 of you are slowed 30% (答案：衝刺者): a 1 s zone on you, laid
  // again every second.
  answer: answers(
    notable('searing-ground', {
      triggers: [
        {
          on: 'periodic',
          every: 1,
          target: { pick: 'player' },
          do: [{ kind: 'groundZone', radius: 200, durationSec: 1, damagePctPerSec: 0, slow: 0.3 }],
        },
      ],
    }),
    'dasher',
  ),
  // 無盡烈焰 (shared with 熔核): no burn stack cap; burn duration −50%.
  keystone: keystone('eternal-flame', { rules: [{ id: 'eternalFlame', durationMore: -0.5 }] }),
  // 燎原: every second each burning enemy passes a burn stack to the nearest enemy within 60.
  threshold: threshold({
    triggers: [
      {
        on: 'ailmentTick',
        every: 1,
        when: [{ ailment: 'burn' }],
        target: { pick: 'nearest', range: 60, excludeEventTarget: true, spread: true },
        do: [{ kind: 'applyAilment', ailment: 'burn' }],
      },
    ],
  }),
  payload: {
    type: 'status',
    effects: [{ kind: 'applyAilment', ailment: 'burn', stacks: 2 }], // 燃燒 2 層 (gd:569)
    bonus: { form: 'status', ailment: 'burn', value: 0.2 },
    ranks: [
      fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3), // r1: payload strength
      fusionRank([flat('burnDuration', 0.2)], 3), // r2
      fusionRank([inc('damage', 0.04, { scope: 'center', when: [{ targetHas: 'burn' }] })], 3), // r3: the bonus
    ],
  },
  skin: { accent: 0xff7a2f, shape: 'flame' },
  covers: {
    triangle: 'answer',
    square: 'helps',
    shielder: 'helps',
    regenerator: 'helps',
    dasher: 'answer',
    boss: 'helps',
  },
});
