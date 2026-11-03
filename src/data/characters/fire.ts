/**
 * 熔核 (fire): its select card from gd (colour and difficulty gd:30, reveal sets gd:304-305, enemy
 * row gd:735) and its center board (gd §1.2), B1's; its ascendancies 焚化者 and 煉獄 (gd §1.2,
 * §1.7), B2's. Every number is an initial value for the balance simulator (CLAUDE.md).
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

/** 爆炸半徑 (擴散) ranks: the bomb's radius and its 火地's (E1's bombRadius). */
const blast = (perRank: number, ranks: 3 | 4) => ranked('bombRadius', perRank, ranks);

/** `id` repeated `n` times: n ranks of it in a purchase order. */
const ranks = (id: string, n: number): string[] => Array.from({ length: n }, () => id);
const C = 'fire.center.';

/**
 * 預設 build (V25): a default player's purchase order, ranks by repetition. Bombs and burns
 * first, 瘟疫 for the triangles, then the hub through 擴散's connector to the crit outer and
 * 火暴, 無盡烈焰, the poison outer and 火毒, and the 火環 threshold.
 */
const DEFAULT_ORDER: readonly string[] = [
  // The bombs' reach first: early waves die to one bomb, so coverage is what holds them back.
  ...ranks(`${C}spread.r1`, 2),
  ...ranks(`${C}furnace.r1`, 2),
  ...ranks(`${C}spread.r1`, 2),
  ...ranks(`${C}stoke.r1`, 2),
  ...ranks(`${C}furnace.r1`, 2),
  ...ranks(`${C}spread.r2`, 2),
  `${C}stoke.r2`,
  ...ranks(`${C}furnace.r2`, 2),
  ...ranks(`${C}stoke.r1`, 2),
  `${C}stoke.r2`,
  ...ranks(`${C}spread.r2`, 2),
  // A core comes about once a run from the elite every 5 waves: each ◆ is followed by ranks that
  // cost shards only, so a visit waiting for a core still spends its shards.
  `${C}spread.pandemic`,
  ...ranks(`${C}spread.r3`, 3),
  ...ranks(`${C}main.c3`, 3),
  ...ranks('hub.economy.r1', 5),
  `${C}stoke.kindle`,
  ...ranks(`${C}stoke.r3`, 3),
  ...ranks(`${C}main.c1`, 3),
  ...ranks('hub.defense.r1', 5),
  'outer.crit.main.entry',
  ...ranks('outer.crit.precision.r1', 4),
  ...ranks('outer.crit.heavy.r1', 4),
  ...ranks('outer.crit.precision.r2', 2),
  ...ranks('outer.crit.heavy.r2', 2),
  `${C}furnace.heatwave`,
  ...ranks(`${C}furnace.r3`, 3),
  ...ranks(`${C}spread.r4`, 3),
  'outer.crit.heavy.execute',
  ...ranks(`${C}stoke.r4`, 3),
  'fusion.fire.crit.core',
  ...ranks('hub.defense.r2', 3),
  ...ranks(`${C}furnace.r4`, 3),
  `${C}stoke.smoulder`,
  ...ranks('hub.might.might', 3),
  'hub.defense.wave-shield',
  ...ranks('fusion.fire.crit.r1', 3),
  `${C}main.eternal-flame`,
  ...ranks('hub.might.might', 3),
  'outer.poison.main.entry',
  ...ranks('outer.poison.virulence.r1', 4),
  ...ranks('outer.poison.virulence.r2', 4),
  'outer.poison.virulence.double-dose',
  ...ranks('outer.poison.contagion.r1', 4),
  ...ranks('outer.poison.contagion.r2', 4),
  'fusion.fire.poison.core',
  ...ranks('fusion.fire.poison.r1', 3),
  `${C}main.threshold`,
  ...ranks('hub.might.might', 3),
];

export const FIRE = defineCharacter({
  id: 'fire',
  color: 0xff7a2f,
  center: {
    signature: signatureNode(),
    branches: [
      // 疊焰: burn damage and stack cap.
      centerBranch('stoke', {
        r1: ranked('burnDamage', 0.15, 4),
        r2: ranked('burnMaxStacks', 1, 3, 'flat'),
        // 引火: burning enemies take +15% hit damage.
        a: notable('kindle', {
          modifiers: [inc('damage', 0.15, { tags: ['hit'], when: [{ targetHas: 'burn' }] })],
        }),
        r3: ranked('burnDamage', 0.15, 3),
        r4: ranked('burnDuration', 0.1, 3),
        // 悶燒: burns last 2 s longer and stack 3 higher.
        b: notable('smoulder', {
          modifiers: [flat('burnDuration', 2), flat('burnMaxStacks', 3)],
        }),
        r5: ranked('burnDamage', 0.15, 3),
        r6: ranked('burnDuration', 0.1, 3),
        // 白熱: the bombs hit an enemy at 5 burn stacks ×2.
        c: notable('white-heat', {
          modifiers: [
            more('damage', 1, {
              scope: 'center',
              tags: ['hit'],
              when: [{ stacksAtLeast: { ailment: 'burn', stacks: 5 } }],
            }),
          ],
        }),
        mastery: mastery(),
      }),
      // 擴散: blast radius (r1, r3, r5) and spread distance (r2, r4, r6; E3's spreadRadius).
      centerBranch('spread', {
        r1: blast(0.1, 4),
        r2: ranked('spreadRadius', 0.1, 4),
        // 瘟疫: a burning enemy that dies spreads 40% of its burns within 250 (答案：三角).
        a: answers(
          notable('pandemic', {
            triggers: [
              {
                on: 'diedWithAilment',
                when: [{ victimHas: 'burn' }],
                do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 250, effect: 0.4 }],
              },
            ],
          }),
          'triangle',
        ),
        r3: blast(0.08, 3),
        r4: ranked('spreadRadius', 0.1, 3),
        // 餘燼彈: a burning enemy that dies throws a small fireball at the nearest enemy.
        b: notable('ember-shot', {
          triggers: [
            {
              on: 'kill',
              when: [{ victimHas: 'burn' }],
              target: { pick: 'nearest' },
              do: [{ kind: 'projectiles', count: 1, aim: 'target', damagePct: 0.5 }],
            },
          ],
        }),
        r5: blast(0.08, 3),
        r6: ranked('spreadRadius', 0.1, 3),
        // 連環爆: an enemy a bomb kills explodes again (radius 40, 50%), twice a bomb at most.
        c: notable('chain-blast', {
          rules: [{ id: 'chainBlast', radius: 40, damagePct: 0.5, perBomb: 2 }],
        }),
        mastery: mastery(),
      }),
      // 爐心: bomb rate and damage.
      centerBranch('furnace', {
        r1: ranked('attackSpeed', 0.06, 4),
        r2: ranked('damage', 0.12, 4, 'increased', { scope: 'center' }),
        // 熱浪: every 5 s the enemies within 200 are pushed back 80 (答案：衝刺者).
        a: answers(
          notable('heatwave', {
            triggers: [
              { on: 'periodic', every: 5, do: [{ kind: 'push', distance: 80, radius: 200 }] },
            ],
          }),
          'dasher',
        ),
        r3: ranked('attackSpeed', 0.06, 3),
        r4: ranked('damage', 0.12, 3, 'increased', { scope: 'center' }),
        // 遠投: every 4th bomb is thrown at the farthest enemy (答案：召喚者).
        b: answers(notable('far-throw', { rules: [{ id: 'farThrow', every: 4 }] }), 'summoner'),
        r5: ranked('attackSpeed', 0.06, 3),
        r6: ranked('damage', 0.12, 3, 'increased', { scope: 'center' }),
        // 引爆: a burn that fills the stacks detonates the burn's remaining damage at once.
        c: notable('detonate', {
          triggers: [
            {
              on: 'ailmentApplied',
              when: [{ ailment: 'burn' }, { stacksAtLeast: { ailment: 'burn', stacks: 'max' } }],
              do: [{ kind: 'detonate', ailment: 'burn' }],
            },
          ],
        }),
        mastery: mastery(),
      }),
    ],
    keystones: [
      // 無盡烈焰 (M1): no burn stack cap; burn duration −50%.
      keystone('eternal-flame', { rules: [{ id: 'eternalFlame', durationMore: -0.5 }] }),
      // 火山: a giant bomb every 3 s, radius ×3 and damage ×5; no other attacks.
      keystone('volcano', {
        rules: [{ id: 'volcano', periodSec: 3, radiusMult: 3, damageMult: 5 }],
      }),
    ],
    // 火環: every 6 s a nova of radius 300 from the player, 50% damage, igniting what it hits.
    threshold: threshold({
      triggers: [
        {
          on: 'periodic',
          every: 6,
          do: [
            { kind: 'nova', radius: 300, damagePct: 0.5 },
            { kind: 'applyAilment', ailment: 'burn', radius: 300, maxTargets: 64 },
          ],
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
    // 焚化者: burned to death, they blow up, and the blasts chain.
    ascendancy('incinerator', {
      // 焚屍: a burning enemy that dies explodes with the burn it had left (M1's ascendancy rule).
      n1: ascNode({
        triggers: [
          {
            on: 'kill',
            when: [{ victimHas: 'burn' }],
            do: [{ kind: 'detonate', ailment: 'burn', radius: 60 }],
          },
        ],
      }),
      // 助燃: 焚屍's explosion ignites 2 stacks.
      n2: ascNode({
        triggers: [
          {
            on: 'kill',
            when: [{ victimHas: 'burn' }],
            do: [{ kind: 'applyAilment', ailment: 'burn', stacks: 2, radius: 60 }],
          },
        ],
      }),
      // 連環焚燒: enemies 焚屍's explosion kills set off 焚屍 too, 3 links deep at most.
      final: ascFinal({ rules: [{ id: 'pyreChain', depth: 3 }] }),
    }),
    // 煉獄: fire zones that last, hurt and join into a sea of fire.
    ascendancy('inferno', {
      // 熔流: fire zones last ×2 as long.
      n1: ascNode({ rules: [{ id: 'zoneTune', durationMult: 2, damageMult: 1, radiusMult: 1 }] }),
      // 灼地: fire zones deal 50% a second instead of 30%.
      n2: ascNode({
        rules: [{ id: 'zoneTune', durationMult: 1, damageMult: 5 / 3, radiusMult: 1 }],
      }),
      // 火海: fire zones grow and run together, ×2 damage (初始值: radius ×1.25; the joining is
      // how the wider zones look, not a rule of its own).
      final: ascFinal({
        rules: [{ id: 'zoneTune', durationMult: 1, damageMult: 2, radiusMult: 1.25 }],
      }),
    }),
  ],
  recommendedOuter: ['ice', 'crit', 'summon'],
  revealAt15: ['poison', 'lightning', 'thorns'],
  enemyRow: {
    triangle: 'even',
    square: 'strong',
    pentagon: 'even',
    shielder: 'strong',
    regenerator: 'strong',
    dasher: 'weak',
    shooter: 'even',
    summoner: 'weak',
    treasure: 'weak',
    boss: 'strong',
  },
  difficulty: 1,
  construct: 'magmaCore',
  defaultOrder: DEFAULT_ORDER,
});
