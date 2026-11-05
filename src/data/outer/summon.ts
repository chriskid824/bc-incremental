/**
 * 召喚 (summon, clock 9; gd §4.10): drones and a turret that help, not carry: 1–2 drones and 1
 * turret, the hive's rules (§1.5, §1.6), your hit modifiers and the outers' effects on them. A
 * drone's impacts are tagged hit, minion and area, a turret's shots hit, minion and projectile
 * (src/data/emitters.ts DroneGrant), which is how its ranks tell them apart. Every number is an
 * initial value for the balance simulator.
 *
 * A drone's modifiers leave out projectile hits (a turret's shots carry area too once 加農砲
 * splashes) and trigger hits (火靈's spirits); the policy ◆ and ★ are C5.9's flags, set by the
 * rule modules of src/sim/rules/summonPolicies.ts.
 */

import {
  answers,
  defineOuter,
  entry,
  inc,
  keystone,
  mastery,
  more,
  notable,
  outerBranch,
  ranked,
  rankedMods,
  threshold,
} from '../templates';

/** A drone's impacts and a turret's shots, by their tags. */
const DRONE = { tags: ['minion', 'area'], notTags: ['projectile', 'trigger'] } as const;
const TURRET = { tags: ['minion', 'projectile'] } as const;
/** A turret's shots alone: a seated row's fire (E8's sentries) carries 'trigger' too (A12). */
const TURRET_SHOTS = { tags: ['minion', 'projectile'], notTags: ['trigger'] } as const;
const SUMMONS = { tags: ['minion'] } as const;

export const SUMMON = defineOuter({
  id: 'summon',
  // 僚機: +1 drone, impacts at 80% with a radius-40 splash (the hive's DRONE_DEFAULTS).
  entry: entry({ emitters: [{ kind: 'drone', drones: 1, damagePct: 0.8, name: 'wingman' }] }),
  branches: [
    // 砲座: turret damage and attack speed; its first rank places the turret.
    outerBranch('emplacement', {
      r1: rankedMods([inc('damage', 0.15, TURRET)], 4, {
        emitters: [{ kind: 'drone', turrets: 1, turretDamagePct: 0.4, name: 'turret' }],
      }),
      r2: ranked('attackSpeed', 0.06, 4, 'more', TURRET),
      // 加農砲: turrets fire a third as often for ×4 damage, each shot blasting radius 60
      // (答案：盾兵). Its ×4 reaches the turrets' shots only, not a sentry's (A12).
      a: answers(
        notable('cannon', {
          modifiers: [more('damage', 3, TURRET_SHOTS)],
          rules: [{ id: 'cannon', rateMult: 1 / 3, splash: 60 }],
        }),
        'shielder',
      ),
      r3: ranked('damage', 0.15, 3, 'increased', TURRET),
      r4: ranked('attackSpeed', 0.06, 3, 'more', TURRET),
      // 特斯拉塔: turret attacks chain 2 times.
      b: notable('tesla-tower', { rules: [{ id: 'teslaTower', chains: 2 }] }),
      mastery: mastery(),
    }),
    // 機隊: drone damage and speed.
    outerBranch('fleet', {
      r1: ranked('damage', 0.15, 4, 'increased', DRONE),
      r2: ranked('droneSpeed', 0.1, 4),
      // 雙機: +1 drone, each drone −15% damage.
      a: notable('twin-drones', {
        modifiers: [more('damage', -0.15, DRONE)],
        emitters: [{ kind: 'drone', drones: 1, damagePct: 0.8, name: 'twin' }],
      }),
      r3: ranked('damage', 0.15, 3, 'increased', DRONE),
      r4: ranked('droneSpeed', 0.1, 3),
      // 超頻: every 10 s all summons attack ×3 as often for 2 s.
      b: notable('overclock', {
        triggers: [
          {
            on: 'periodic',
            every: 10,
            do: [{ kind: 'buff', stat: 'attackSpeed', more: 2, durationSec: 2, tags: ['minion'] }],
          },
        ],
      }),
      mastery: mastery(),
    }),
  ],
  // 鎖定信標: summons take elites and bosses first and deal +30% to them (答案：Boss).
  answer: answers(
    notable('lock-beacon', {
      rules: [{ id: 'lockBeacon' }],
      modifiers: [
        inc('damage', 0.3, { ...SUMMONS, when: [{ targetKind: 'boss' }] }),
        inc('damage', 0.3, { ...SUMMONS, when: [{ targetKind: 'elite' }] }),
      ],
    }),
    'boss',
  ),
  // 蟲海 (shared with 蜂巢): drones ×2, each −45% damage, never flying home.
  keystone: keystone('bug-sea', {
    modifiers: [more('damage', -0.45, DRONE)],
    rules: [{ id: 'bugSea', countMult: 2 }],
  }),
  // 雷射柵欄: a laser from each summon to its nearest other; every 0.25 s each enemy on a line
  // takes 10% hit damage and a shock stack (the segment's defaults, range 200).
  threshold: threshold({ emitters: [{ kind: 'segment', endpoints: 'summons', links: 1 }] }),
  payload: null,
  skin: { accent: 0x9bf25c, shape: 'drone' },
  covers: {
    triangle: 'helps',
    pentagon: 'helps',
    shielder: 'answer',
    shooter: 'helps',
    summoner: 'helps',
    treasure: 'helps',
    boss: 'answer',
  },
});
