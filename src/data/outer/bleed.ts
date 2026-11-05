/**
 * 流血 (bleed, clock 2; gd §4.3): 40% of the hit a second for 4 s, an enemy keeping only its
 * strongest; a moving enemy bleeds ×3, and the enemies keep walking in, so most of the time it
 * is ×3 (BuildFlags.bleedMoveMult). Every number is an initial value for the balance simulator.
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

/** 追獵's damage against the far enemies: +x% every 100 units away from you. */
const FAR = { scaling: { per: 'targetDistance', every: 100 } } as const;

export const BLEED = defineOuter({
  id: 'bleed',
  // 放血: hits bleed 10% of the time.
  entry: entry({ modifiers: [flat('bleedChance', 0.1)] }),
  branches: [
    // 深創: bleed chance and bleed damage.
    outerBranch('deep-wound', {
      r1: ranked('bleedChance', 0.03, 4, 'flat'),
      r2: ranked('bleedDamage', 0.15, 4),
      // 深傷: bleeds last 2 s longer.
      a: notable('lacerate', { modifiers: [flat('bleedDuration', 2)] }),
      r3: ranked('bleedChance', 0.03, 3, 'flat'),
      r4: ranked('bleedDamage', 0.15, 3),
      // 割裂: bleeds pass shields, and a blocked hit still bleeds (答案：盾兵).
      b: answers(
        notable('rend', {
          modifiers: [flat('ignoreShield', 1, { tags: ['bleed'] }), flat('ailmentOnBlock', 1)],
        }),
        'shielder',
      ),
      mastery: mastery(),
    }),
    // 追獵: damage against far enemies and bleed damage.
    outerBranch('hunt', {
      r1: ranked('damage', 0.02, 4, 'increased', FAR),
      r2: ranked('bleedDamage', 0.15, 4),
      // 傷口撕裂: an enemy standing still bleeds ×2 (答案：射手、召喚者).
      a: answers(
        notable('wound-tear', { modifiers: [flat('bleedStationaryMult', 1)] }),
        'shooter',
        'summoner',
      ),
      r3: ranked('damage', 0.02, 3, 'increased', FAR),
      r4: ranked('bleedDamage', 0.15, 3),
      // 撕裂: crits always bleed, the bleed from the crit's damage.
      b: notable('rupture', { modifiers: [flat('bleedAlways', 1, { tags: ['crit'] })] }),
      mastery: mastery(),
    }),
  ],
  // 抗凝: bleeding enemies cannot regenerate (答案：再生者).
  answer: answers(
    notable('anticoagulant', {
      modifiers: [inc('enemyRegen', -1, { when: [{ targetHas: 'bleed' }] })],
    }),
    'regenerator',
  ),
  // 大出血: bleeds stack up to 8, but lose the moving ×3.
  keystone: keystone('hemorrhage', { rules: [{ id: 'hemorrhage', maxStacks: 8 }] }),
  // 血河: every 0.5 s each bleeding enemy copies its bleed to the enemies within 60 behind it
  // (farther from the centre than it is; E9's bleed spread) at 50% (a transfer stays below 1).
  // Copies keep the bleed's credit.
  threshold: threshold({
    triggers: [
      {
        on: 'ailmentTick',
        when: [{ ailment: 'bleed' }],
        every: 0.5,
        do: [{ kind: 'spreadAilment', ailment: 'bleed', radius: 60, effect: 0.5, behind: true }],
      },
    ],
  }),
  payload: {
    type: 'status',
    effects: [{ kind: 'applyAilment', ailment: 'bleed' }], // 流血 4 秒, the base duration (gd:562)
    bonus: { form: 'status', ailment: 'bleed', value: 0.2 },
    ranks: [
      fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3), // r1: payload strength
      fusionRank([flat('bleedDuration', 0.5)], 3), // r2
      fusionRank([inc('damage', 0.04, { scope: 'center', when: [{ targetHas: 'bleed' }] })], 3), // r3: the bonus
    ],
  },
  skin: { accent: 0xd7263d, shape: 'trail' },
  covers: {
    square: 'helps',
    shielder: 'answer',
    regenerator: 'answer',
    dasher: 'helps',
    shooter: 'answer',
    summoner: 'answer',
    treasure: 'helps',
  },
});
