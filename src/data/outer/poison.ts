/**
 * 毒 (poison, clock 1; gd §4.2): stacks without a cap, each 20% of the hit a second for 4 s.
 * Every number is an initial value for the balance simulator.
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

export const POISON = defineOuter({
  id: 'poison',
  // 淬毒: hits poison 15% of the time.
  entry: entry({ modifiers: [flat('poisonChance', 0.15)] }),
  branches: [
    // 劇毒: poison chance and damage per stack.
    outerBranch('virulence', {
      r1: ranked('poisonChance', 0.03, 4, 'flat'),
      r2: ranked('poisonDamage', 0.15, 4),
      // 雙重劑量: every poisoning adds a second stack.
      a: notable('double-dose', {
        triggers: [
          {
            on: 'ailmentApplied',
            when: [{ ailment: 'poison' }],
            do: [{ kind: 'applyAilment', ailment: 'poison' }],
          },
        ],
      }),
      r3: ranked('poisonChance', 0.03, 3, 'flat'),
      r4: ranked('poisonDamage', 0.15, 3),
      // 滲透: a hit a shield blocks still poisons (答案：盾兵).
      b: answers(
        notable('seep', { modifiers: [flat('ailmentOnBlock', 1, { tags: ['poison'] })] }),
        'shielder',
      ),
      mastery: mastery(),
    }),
    // 傳染: duration and spread.
    outerBranch('contagion', {
      r1: ranked('poisonDuration', 0.5, 4, 'flat'),
      r2: ranked('poisonDamage', 0.15, 4),
      // 毒雲: a poisoned enemy that dies leaves a 2 s poison cloud (答案：三角).
      a: answers(
        notable('toxic-cloud', {
          triggers: [
            {
              on: 'kill',
              when: [{ victimHas: 'poison' }],
              do: [
                {
                  kind: 'groundZone',
                  radius: 60,
                  durationSec: 2,
                  damagePctPerSec: 0,
                  ailment: 'poison',
                  ailmentStacks: 1,
                },
              ],
            },
          ],
        }),
        'triangle',
      ),
      r3: ranked('poisonDuration', 0.5, 3, 'flat'),
      r4: ranked('poisonDamage', 0.15, 3),
      // 傳染: a poisoned enemy that dies passes half its stacks to the 2 nearest; a pentagon's
      // shards inherit its stacks (答案：五角).
      b: answers(
        notable('contagion', {
          triggers: [
            {
              on: 'kill',
              when: [{ victimHas: 'poison' }],
              do: [
                {
                  kind: 'spreadAilment',
                  ailment: 'poison',
                  radius: 150,
                  effect: 0.5,
                  stacks: 0.5,
                  maxTargets: 2,
                  order: 'nearest',
                  toSplitChildren: 1,
                },
              ],
            },
          ],
        }),
        'pentagon',
      ),
      mastery: mastery(),
    }),
  ],
  // 神經毒: every 5 poison stacks slow the enemy 2%, at most 40% (答案：衝刺者).
  answer: answers(
    notable('neurotoxin', { rules: [{ id: 'poisonSlow', stacksPer: 5, slowPer: 0.02, max: 0.4 }] }),
    'dasher',
  ),
  // 致死毒素: poison damage +10% more per 10 stacks on the target (at most +300%); hits −50%.
  keystone: keystone('lethal-toxin', {
    modifiers: [
      more('damage', 0.1, {
        tags: ['poison'],
        scaling: { per: 'targetPoisonStacks', every: 10, cap: 3 },
      }),
      more('damage', -0.5, { tags: ['hit'] }),
    ],
  }),
  // 毒爆: every 8 s the most poisoned enemy bursts: a quarter of its poison at once, and its
  // stacks passed at half strength to up to 5 enemies within 150.
  threshold: threshold({
    triggers: [
      {
        on: 'periodic',
        every: 8,
        target: { pick: 'mostStacks', ailment: 'poison' },
        do: [
          { kind: 'detonate', ailment: 'poison', fraction: 0.25 },
          {
            kind: 'spreadAilment',
            ailment: 'poison',
            radius: 150,
            effect: 0.5,
            stacks: 0.5,
            maxTargets: 5,
            order: 'nearest',
          },
        ],
      },
    ],
  }),
  payload: {
    type: 'status',
    effects: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }], // 毒 2 層 (gd:570)
    bonus: { form: 'status', ailment: 'poison', value: 0.2 },
    ranks: [
      fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3),
      fusionRank([flat('poisonDuration', 0.5)], 3),
      fusionRank([inc('damage', 0.04, { scope: 'center', when: [{ targetHas: 'poison' }] })], 3),
    ],
  },
  skin: { accent: 0x3fd08a, shape: 'bubble' },
  covers: {
    triangle: 'answer',
    square: 'helps',
    pentagon: 'answer',
    shielder: 'answer',
    dasher: 'answer',
    shooter: 'helps',
    summoner: 'helps',
    boss: 'helps',
  },
});
