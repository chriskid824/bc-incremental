/**
 * 彈幕 (barrage, clock 10; gd §4.11): small projectiles that fly with your attacks, each a small
 * hit. 副彈's barrage grant (E10a) makes every counted signature attack send floor(barrageCount)
 * small shots straight at the nearest distinct enemies; 副彈 gives 2, and every two count ranks
 * one more (only the whole part counts). The barrage payload's projectiles grow with it too
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

/**
 * The small projectiles' hits: every hit this outer's board is credited with (the rider's shots,
 * which are plain projectile hits, and its notables' triggered projectiles).
 */
const BULLETS = { scope: 'outer.barrage' } as const;

export const BARRAGE = defineOuter({
  id: 'barrage',
  // 副彈: each attack sends 2 small projectiles of 25% at different enemies.
  entry: entry({ modifiers: [flat('barrageCount', 2)], emitters: [{ kind: 'barrage' }] }),
  branches: [
    // 齊射: projectile count and projectile damage.
    outerBranch('volley', {
      r1: ranked('barrageCount', 0.5, 4, 'flat'),
      r2: ranked('damage', 0.1, 4, 'increased', BULLETS),
      // 扇形: the small projectiles fan out (30°) at one target.
      a: notable('fan', { rules: [{ id: 'barrageFan', spreadDeg: 30 }] }),
      r3: ranked('barrageCount', 0.5, 3, 'flat'),
      r4: ranked('damage', 0.1, 3, 'increased', BULLETS),
      // 環射: every 6th attack fires small projectiles in 12 directions.
      b: notable('ring-shot', { rules: [{ id: 'barrageRing', every: 6, directions: 12 }] }),
      mastery: mastery(),
    }),
    // 分裂: pierce and split. Pierce is the rider's dearest knob (E10a), so two ranks a pierce.
    outerBranch('split', {
      r1: ranked('damage', 0.08, 4, 'increased', BULLETS),
      r2: ranked('barragePierce', 0.5, 4, 'flat'),
      // 子母彈: a small projectile that kills splits into 3 (the split ones do not split again).
      a: notable('cluster', { rules: [{ id: 'clusterShot', count: 3, chance: 1 }] }),
      r3: ranked('damage', 0.08, 3, 'increased', BULLETS),
      // 分裂's split chance (A19 (a), E10b's barrageSplit): base 0, so 'flat'. Without ◆子母彈 a
      // kill splits into 3 at this chance (EB); with it, the chance adds to ◆'s.
      r4: ranked('barrageSplit', 0.15, 3, 'flat'),
      // 聚焦: while a boss is alive every small projectile goes at it, +20% (答案：Boss; A20 (b)).
      b: answers(
        notable('focus', { rules: [{ id: 'barrageFocus', bonus: 0.2, when: 'boss' }] }),
        'boss',
      ),
      mastery: mastery(),
    }),
  ],
  // 集火: the hits on one enemy within 0.2 s are summed against its shield (答案：盾兵).
  answer: answers(notable('focus-fire', { modifiers: [flat('shieldPoolSec', 0.2)] }), 'shielder'),
  // 子彈地獄: ×2 small projectiles, each −40% damage; they bounce off the arena's edge (twice).
  keystone: keystone('bullet-hell', {
    modifiers: [more('damage', -0.4, BULLETS)],
    rules: [{ id: 'bulletHell' }],
  }),
  // 彈雨: for 2 s in every 10, ×3 small projectiles (its own rule module, Q12 A).
  threshold: threshold({
    rules: [{ id: 'bulletRain', periodSec: 10, durationSec: 2, countMult: 3 }],
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
