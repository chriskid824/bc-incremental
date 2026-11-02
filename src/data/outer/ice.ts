/**
 * 冰 (ice, clock 6; gd §4.7): the archetype outer of 霜晶, lighter than its center: chill comes
 * only from your hits. Every number is an initial value for the balance simulator.
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

export const ICE = defineOuter({
  id: 'ice',
  // 寒氣: each hit adds 8% chill.
  entry: entry({ modifiers: [flat('frostOnHit', 0.08)] }),
  branches: [
    // 寒流: chill build-up and slow.
    outerBranch('cold-front', {
      r1: ranked('frostOnHit', 0.1, 4),
      r2: ranked('frostSlowCap', 0.03, 4, 'flat'),
      // 霜咬: enemies at 50% chill or more take +15% damage.
      a: notable('frostbite', {
        modifiers: [inc('damage', 0.15, { when: [{ targetFrostAtLeast: 0.5 }] })],
      }),
      r3: ranked('frostOnHit', 0.1, 3),
      r4: ranked('freezeDuration', 0.1, 3, 'flat'),
      // 深凍: freezes last 0.4 s longer.
      b: notable('deep-freeze', { modifiers: [flat('freezeDuration', 0.4)] }),
      mastery: mastery(),
    }),
    // 碎冰: shatter damage and radius.
    outerBranch('shatter', {
      r1: ranked('shatterDamage', 0.15, 4),
      r2: ranked('shatterRadius', 0.08, 4),
      // 寒爆: shatter radius +40%.
      a: notable('cold-snap', { modifiers: [inc('shatterRadius', 0.4)] }),
      r3: ranked('shatterDamage', 0.15, 3),
      r4: ranked('shatterRadius', 0.08, 3),
      // 凍瘡: enemies at 30% chill or more regenerate 60% less (答案：再生者).
      b: answers(
        notable('chilblain', {
          modifiers: [inc('enemyRegen', -0.6, { when: [{ targetFrostAtLeast: 0.3 }] })],
        }),
        'regenerator',
      ),
      mastery: mastery(),
    }),
  ],
  // 霜徑: a dashing enemy gains 25% chill each time it is hit (答案：衝刺者).
  answer: answers(
    notable('frost-path', {
      triggers: [
        { on: 'hit', when: [{ targetState: 'dashing' }], do: [{ kind: 'addFrost', amount: 0.25 }] },
      ],
    }),
    'dasher',
  ),
  // 絕對零度 (shared with 霜晶): its rule module is an engine item not on the branch yet.
  keystone: keystone('absolute-zero', {}),
  // 寒潮: every 8 s a ring of cold from you adds 50% chill to the enemies it reaches.
  threshold: threshold({
    triggers: [
      {
        on: 'periodic',
        every: 8,
        do: [{ kind: 'addFrost', amount: 0.5, radius: 600, maxTargets: 400 }],
      },
    ],
  }),
  payload: null,
  skin: { accent: 0x8fe3ff, shape: 'crystal' },
  covers: {
    triangle: 'helps',
    pentagon: 'helps',
    regenerator: 'answer',
    dasher: 'answer',
    treasure: 'helps',
  },
});
