/**
 * 蜂巢 (summon): its select card from gd (colour and difficulty gd:33, reveal sets gd:304-305,
 * enemy row gd:738), its center board (gd §1.5) and its ascendancies 機械師 and 女王 (gd §1.5,
 * §1.7), B2's. Every number is an initial value for the balance simulator (CLAUDE.md).
 *
 * The swarm's drones impact for 200% tagged hit, minion and area; its turret shoots for 80% tagged
 * hit, minion and projectile (src/sim/rules/swarm.ts), which is how the branches tell them apart.
 * The ◆ that need the drone pool's per-drone work (自爆協議, 蜂后, 重錘, 集火指令's pick, 前哨,
 * 攔截守衛, 蜂潮) carry interim data until the engine lands it; each comment says what it waits on.
 */

import {
  answers,
  ascendancy,
  ascFinal,
  ascNode,
  centerBranch,
  defineCharacter,
  flat,
  inc,
  keystone,
  mastery,
  more,
  notable,
  ranked,
  signatureNode,
  threshold,
} from '../templates';

/** A drone's impacts (the swarm's and the timed drones'), by their tags. */
const DRONE = { tags: ['minion', 'area'], notTags: ['projectile', 'trigger'] } as const;
/** A turret's shots. */
const TURRET = { tags: ['minion', 'projectile'] } as const;
/** Every summon's hits. */
const SUMMONS = { tags: ['minion'] } as const;

/** `id` repeated `n` times: n ranks of it in a purchase order. */
const ranks = (id: string, n: number): string[] => Array.from({ length: n }, () => id);
const C = 'summon.center.';

/**
 * 預設 build (V25): a default player's purchase order, ranks by repetition. Drone damage and
 * speed first (the drones carry the early waves), the turrets next, then the hub, the fire and
 * crit outers and their fusions, the ice outer and 霜蜂, 巨像's alternative left out.
 */
const DEFAULT_ORDER: readonly string[] = [
  ...ranks(`${C}swarm.r1`, 2),
  ...ranks(`${C}swarm.r2`, 2),
  ...ranks(`${C}swarm.r1`, 2),
  ...ranks(`${C}engineer.r1`, 2),
  ...ranks(`${C}swarm.r2`, 2),
  ...ranks(`${C}engineer.r2`, 2),
  ...ranks(`${C}engineer.r1`, 2),
  ...ranks(`${C}guard.r1`, 2),
  ...ranks(`${C}guard.r2`, 2),
  // A core comes about once a run from the elite every 5 waves: each ◆ is followed by ranks that
  // cost shards only, so a visit waiting for a core still spends its shards.
  `${C}swarm.split`,
  ...ranks(`${C}swarm.r3`, 3),
  ...ranks(`${C}main.c1`, 3),
  ...ranks('hub.defense.r1', 5),
  `${C}engineer.mass-production`,
  ...ranks(`${C}engineer.r3`, 3),
  ...ranks(`${C}main.c3`, 3),
  ...ranks('hub.economy.r1', 5),
  ...ranks('hub.might.might', 2),
  'outer.fire.main.entry',
  ...ranks('outer.fire.blaze.r1', 4),
  ...ranks('outer.fire.blaze.r2', 4),
  'outer.fire.blaze.fuel',
  ...ranks('outer.fire.blaze.r3', 2),
  ...ranks('outer.fire.blaze.r4', 2),
  ...ranks(`${C}swarm.r4`, 3),
  `${C}guard.interceptor`,
  ...ranks(`${C}guard.r5`, 2),
  ...ranks(`${C}guard.r6`, 2),
  `${C}guard.recycle`,
  ...ranks(`${C}engineer.r4`, 3),
  ...ranks(`${C}guard.r3`, 3),
  'fusion.summon.fire.core',
  ...ranks('hub.defense.r2', 3),
  ...ranks(`${C}swarm.r5`, 3),
  `${C}swarm.self-destruct`,
  ...ranks('hub.might.might', 3),
  'outer.crit.main.entry',
  ...ranks('outer.crit.precision.r1', 4),
  ...ranks('outer.crit.heavy.r1', 4),
  ...ranks('outer.crit.precision.r2', 2),
  ...ranks('outer.crit.heavy.r2', 2),
  'outer.crit.heavy.execute',
  'fusion.summon.crit.core',
  ...ranks('fusion.summon.fire.r1', 3),
  'hub.defense.wave-shield',
  ...ranks(`${C}engineer.r5`, 3),
  ...ranks(`${C}engineer.r6`, 2),
  `${C}engineer.focus-fire`,
  ...ranks('fusion.summon.crit.r1', 3),
  ...ranks(`${C}swarm.r6`, 3),
  `${C}swarm.queen`,
  `${C}main.threshold`,
  ...ranks('hub.might.might', 3),
];

export const SUMMON = defineCharacter({
  id: 'summon',
  color: 0x9bf25c,
  center: {
    signature: signatureNode(),
    branches: [
      // 蜂群: drone damage and speed.
      centerBranch('swarm', {
        r1: ranked('damage', 0.15, 4, 'increased', DRONE),
        r2: ranked('droneSpeed', 0.1, 4),
        // 分巢: every 5 kills spawn a temporary drone for 6 s.
        a: notable('split', {
          rules: [{ id: 'hiveSplit', every: 5, lifeSec: 6, damagePct: 2, maxLive: 8 }],
        }),
        r3: ranked('damage', 0.15, 3, 'increased', DRONE),
        r4: ranked('droneSpeed', 0.1, 3),
        // 自爆協議: a drone's last impact before it flies home explodes (radius 80, 150%).
        // Interim until the engine's lastImpact (P1): a third of the impacts explode.
        b: notable('self-destruct', {
          triggers: [
            {
              on: 'droneImpact',
              when: [{ chance: 1 / 3 }],
              do: [{ kind: 'explode', radius: 80, damagePct: 1.5 }],
            },
          ],
        }),
        r5: ranked('damage', 0.15, 3, 'increased', DRONE),
        r6: ranked('droneSpeed', 0.1, 3),
        // 蜂后: one drone becomes the queen (×1.5 size, ×2 damage); the others deal +20% to its
        // target. Interim until the engine's per-drone roles (P2): the swarm's average, +40%.
        c: notable('queen', { modifiers: [more('damage', 0.4, DRONE)] }),
        mastery: mastery(),
      }),
      // 工兵: turret damage and attack speed.
      centerBranch('engineer', {
        r1: ranked('damage', 0.15, 4, 'increased', TURRET),
        r2: ranked('attackSpeed', 0.06, 4, 'more', TURRET),
        // 量產: +2 turrets, each −20% damage.
        a: notable('mass-production', {
          modifiers: [more('damage', -0.2, TURRET)],
          rules: [{ id: 'swarmTune', turrets: 2, dockSecMult: 1 }],
        }),
        r3: ranked('damage', 0.15, 3, 'increased', TURRET),
        r4: ranked('attackSpeed', 0.06, 3, 'more', TURRET),
        // 前哨: the turrets sit at radius 220, reaching farther. Interim until the engine's turret
        // radius (P4): +25% turret damage.
        b: notable('outpost', { modifiers: [inc('damage', 0.25, TURRET)] }),
        r5: ranked('damage', 0.15, 3, 'increased', TURRET),
        r6: ranked('attackSpeed', 0.06, 3, 'more', TURRET),
        // 集火指令: every summon goes for the enemy with the most hp, +25% damage (答案：Boss).
        // Interim until the engine's highest-hp pick (P3): elites and bosses first (鎖定信標's
        // policy), and the +25% on the highest-hp enemy.
        c: answers(
          notable('focus-fire', {
            rules: [{ id: 'lockBeacon' }],
            modifiers: [inc('damage', 0.25, { ...SUMMONS, when: [{ targetIs: 'highestHp' }] })],
          }),
          'boss',
        ),
        mastery: mastery(),
      }),
      // 守衛: max life and impact range.
      centerBranch('guard', {
        r1: ranked('maxLife', 0.1, 4),
        r2: ranked('areaSize', 0.08, 4),
        // 攔截守衛: 2 drones circle at 120 and ram dashers charging up (答案：衝刺者). Interim
        // until the engine's guard mode (P5): summons deal +60% to enemies standing still
        // (a dasher charging its dash).
        a: answers(
          notable('interceptor', {
            modifiers: [inc('damage', 0.6, { ...SUMMONS, when: [{ targetState: 'stopped' }] })],
          }),
          'dasher',
        ),
        r3: ranked('maxLife', 0.1, 3),
        r4: ranked('areaSize', 0.08, 3),
        // 重錘: one drone ×5 damage, ×0.4 speed (答案：盾兵). Interim until the engine's per-drone
        // roles (P2): the drones' impacts pass shields.
        b: answers(notable('hammer', { modifiers: [flat('ignoreShield', 1, DRONE)] }), 'shielder'),
        r5: ranked('maxLife', 0.1, 3),
        r6: ranked('areaSize', 0.08, 3),
        // 回收: drones fly out again as soon as they are home, never resting on the dock ring.
        c: notable('recycle', { rules: [{ id: 'swarmTune', turrets: 0, dockSecMult: 0 }] }),
        mastery: mastery(),
      }),
    ],
    keystones: [
      // 巨像: one drone only; for each drone fewer it deals +50% damage (and grows).
      keystone('colossus', { rules: [{ id: 'colossus', damagePerMissing: 0.5 }] }),
      // 蟲海 (shared with the summon outer): drones ×2, each −45% damage, never flying home.
      keystone('bug-sea', {
        modifiers: [more('damage', -0.45, DRONE)],
        rules: [{ id: 'bugSea', countMult: 2 }],
      }),
    ],
    // 蜂潮: every 8 s every drone dives at the densest spot together, ×2 damage. Interim until the
    // engine's surge (P6): every 8 s the summons attack ×3 as often for 1.5 s.
    threshold: threshold({
      triggers: [
        {
          on: 'periodic',
          every: 8,
          do: [{ kind: 'buff', stat: 'attackSpeed', more: 2, durationSec: 1.5, tags: ['minion'] }],
        },
      ],
    }),
    connectors: [
      ranked('damage', 0.08, 3),
      ranked('attackSpeed', 0.05, 3),
      ranked('maxLife', 0.1, 3),
      ranked('damage', 0.08, 3),
      ranked('attackSpeed', 0.05, 3),
      ranked('maxLife', 0.1, 3),
    ],
  },
  ascendancies: [
    // 機械師: more turrets, and turrets that launch drones.
    ascendancy('mechanic', {
      // 增建: +2 turrets.
      n1: ascNode({ rules: [{ id: 'hiveBuild', turrets: 2 }] }),
      // 聯動砲: turret shots splash in radius 40.
      n2: ascNode({ rules: [{ id: 'cannon', rateMult: 1, splash: 40 }] }),
      // 母艦工廠: every 6 s each turret launches a temporary drone for 4 s.
      final: ascFinal({
        rules: [{ id: 'motherFactory', periodSec: 6, lifeSec: 4, damagePct: 2 }],
      }),
    }),
    // 女王: more drones, and kills that hatch new ones.
    ascendancy('queen', {
      // 擴巢: +3 drones.
      n1: ascNode({ rules: [{ id: 'hiveExpand', drones: 3 }] }),
      // 蜂王漿: temporary drones live 50% longer.
      n2: ascNode({ rules: [{ id: 'royalJelly', lifeMult: 1.5 }] }),
      // 繁衍: a kill has a 20% chance to hatch a temporary drone for 6 s.
      final: ascFinal({
        rules: [{ id: 'breed', chance: 0.2, lifeSec: 6, damagePct: 2, maxLive: 12 }],
      }),
    }),
  ],
  recommendedOuter: ['fire', 'ice', 'crit'],
  revealAt15: ['poison', 'lightning', 'thorns'],
  enemyRow: {
    triangle: 'even',
    square: 'even',
    pentagon: 'even',
    shielder: 'weak',
    regenerator: 'even',
    dasher: 'weak',
    shooter: 'strong',
    summoner: 'strong',
    treasure: 'strong',
    boss: 'even',
  },
  difficulty: 2,
  construct: 'hive',
  defaultOrder: DEFAULT_ORDER,
});
