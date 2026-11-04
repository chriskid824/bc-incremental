/**
 * 暴擊 (crit, clock 5; gd §4.6): crit chance × crit multiplier, from M1's 5% and 150%. Every
 * number is an initial value for the balance simulator.
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

export const CRIT = defineOuter({
  id: 'crit',
  // 要害: crit chance +5%.
  entry: entry({ modifiers: [flat('critChance', 0.05)] }),
  branches: [
    // 精準: crit chance, and crit chance against elites and bosses.
    outerBranch('precision', {
      r1: ranked('critChance', 0.02, 4, 'flat'),
      r2: ranked('critChance', 0.05, 4, 'flat', { when: [{ targetKind: 'boss' }] }),
      // 鎖定: crit chance +25% against the alive enemy with the most life left.
      a: notable('lock-on', {
        modifiers: [flat('critChance', 0.25, { when: [{ targetIs: 'highestHp' }] })],
      }),
      r3: ranked('critChance', 0.02, 3, 'flat'),
      r4: ranked('critChance', 0.05, 3, 'flat', { when: [{ targetKind: 'elite' }] }),
      // 見血: a crit on a bleeding enemy deals its remaining bleed at once.
      b: notable('first-blood', {
        triggers: [
          {
            on: 'crit',
            when: [{ targetHas: 'bleed' }],
            do: [{ kind: 'detonate', ailment: 'bleed' }],
          },
        ],
      }),
      mastery: mastery(),
    }),
    // 重擊: crit multiplier and hit damage.
    outerBranch('heavy', {
      r1: ranked('critMultiplier', 0.1, 4, 'flat'),
      r2: ranked('damage', 0.08, 4, 'increased', { tags: ['hit'] }),
      // 處決: enemies under 30% life always take crits (答案：再生者).
      a: answers(
        notable('execute', {
          modifiers: [flat('critAlways', 1, { when: [{ targetHpBelow: 0.3 }] })],
        }),
        'regenerator',
      ),
      r3: ranked('critMultiplier', 0.1, 3, 'flat'),
      r4: ranked('damage', 0.08, 3, 'increased', { tags: ['hit'] }),
      // 破甲: crits ignore armour.
      b: notable('armour-break', { modifiers: [flat('ignoreArmour', 1, { tags: ['crit'] })] }),
      mastery: mastery(),
    }),
  ],
  // 碎裂暴擊: a crit explodes at its target, radius 80, 20% damage (答案：三角).
  answer: answers(
    notable('shatter-crit', {
      triggers: [{ on: 'crit', do: [{ kind: 'explode', radius: 80, damagePct: 0.2 }] }],
    }),
    'triangle',
  ),
  // 冷靜狙擊 (M1): every 3rd attack always crits, crit multiplier ×1.5, crit damage +120% and
  // attack speed +25% (all more); no random crits.
  keystone: keystone('steady-aim', {
    modifiers: [more('damage', 1.2, { tags: ['crit'] }), more('attackSpeed', 0.25)],
    rules: [{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'attack' }],
  }),
  // 斬首線: a crit draws a white slash from its target along the attack, 200 long and 24 wide,
  // 50% damage to what it crosses.
  threshold: threshold({
    triggers: [
      {
        on: 'crit',
        do: [
          {
            kind: 'slashLine',
            length: 200,
            width: 24,
            damagePct: 0.5,
            toward: 'outward',
            from: 'target',
          },
        ],
      },
    ],
  }),
  payload: {
    type: 'placement',
    // A slash that always crits, 300 long and 24 wide, 100% damage; +10% per 10% crit chance.
    effects: [
      { kind: 'slashLine', length: 300, width: 24, damagePct: 1, alwaysCrit: true, critScale: 1 },
    ],
    bonus: { form: 'inPayload' },
    ranks: [
      fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3),
      fusionRank([flat('critMultiplier', 0.1, { scope: 'fusion' })], 3),
      fusionRank([flat('critChance', 0.02)], 3),
    ],
  },
  skin: { accent: 0xfff4d6, shape: 'slash' },
  covers: {
    triangle: 'answer',
    square: 'helps',
    shielder: 'helps',
    regenerator: 'answer',
    treasure: 'helps',
    boss: 'helps',
  },
});
