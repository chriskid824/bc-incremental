/**
 * 召喚 (summon, clock 9; gd §4.10): drones and a turret that help, not carry: 1–2 drones and 1
 * turret, the hive's rules (§1.5, §1.6), your hit modifiers and the outers' effects on them. A
 * drone's impacts are tagged hit, minion and area, a turret's shots hit, minion and projectile
 * (src/data/emitters.ts DroneGrant), which is how its ranks tell them apart. Every number is an
 * initial value for the balance simulator.
 *
 * Engine items not on the branch yet (C5.9 turret fields, eliteFirst aim,
 * swarm.size and the drone speed stat): until they land, the nodes that need them read as the
 * comment above each says, with gd's numbers where data can carry them.
 */

import {
  answers,
  defineOuter,
  entry,
  flat,
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
const DRONE = { tags: ['minion', 'area'] } as const;
const TURRET = { tags: ['minion', 'projectile'] } as const;
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
      // 加農砲: turret attack speed ÷3, damage ×4 (答案：盾兵). Its area blast is a C5.9 turret
      // field; until it lands its shots ignore shields instead.
      a: answers(
        notable('cannon', {
          modifiers: [
            more('attackSpeed', -2 / 3, TURRET),
            more('damage', 3, TURRET),
            flat('ignoreShield', 1, TURRET),
          ],
        }),
        'shielder',
      ),
      r3: ranked('damage', 0.15, 3, 'increased', TURRET),
      r4: ranked('attackSpeed', 0.06, 3, 'more', TURRET),
      // 特斯拉塔: turret attacks chain 2 times. The chain is a C5.9 turret field; until it lands
      // the turret's shots deal +50% more.
      b: notable('tesla-tower', { modifiers: [more('damage', 0.5, TURRET)] }),
      mastery: mastery(),
    }),
    // 機隊: drone damage and speed.
    outerBranch('fleet', {
      r1: ranked('damage', 0.15, 4, 'increased', DRONE),
      // Drone speed is a C5.9 stat; until it lands the ranks quicken the drones' cadence.
      r2: ranked('attackSpeed', 0.05, 4, 'more', DRONE),
      // 雙機: +1 drone, each drone −15% damage.
      a: notable('twin-drones', {
        modifiers: [more('damage', -0.15, DRONE)],
        emitters: [{ kind: 'drone', drones: 1, damagePct: 0.8, name: 'twin' }],
      }),
      r3: ranked('damage', 0.15, 3, 'increased', DRONE),
      r4: ranked('attackSpeed', 0.05, 3, 'more', DRONE),
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
  // 鎖定信標: summons deal +30% to elites and bosses (答案：Boss). Preferring them is C5.9's
  // eliteFirst aim; until it lands only the damage reads.
  answer: answers(
    notable('lock-beacon', {
      modifiers: [
        inc('damage', 0.3, { ...SUMMONS, when: [{ targetKind: 'boss' }] }),
        inc('damage', 0.3, { ...SUMMONS, when: [{ targetKind: 'elite' }] }),
      ],
    }),
    'boss',
  ),
  // 蟲海 (shared with 蜂巢): drones ×2, each −45% damage, never flying home. swarm.size is C5.9;
  // until it lands the ★ adds 2 drones (the 1–2 an outer has, doubled) at −45% each.
  keystone: keystone('bug-sea', {
    modifiers: [more('damage', -0.45, DRONE)],
    emitters: [{ kind: 'drone', drones: 2, damagePct: 0.8, name: 'swarm' }],
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
