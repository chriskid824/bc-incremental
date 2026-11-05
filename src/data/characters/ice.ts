/**
 * 霜晶 (ice): its select card from gd (colour and difficulty gd:31, reveal sets gd:304-305, enemy
 * row gd:736) and its center board (gd §1.3), B3's. Its ascendancies are B5's; until then they
 * are null. Every number is an initial value for the balance simulator (CLAUDE.md).
 *
 * The fan's cones hit for 40% tagged hit, projectile and cold (src/sim/rules/iceFan.ts); a
 * shatter hits for its share of the victim's max life (src/sim/ailments/frost.ts). 寒霜 builds the
 * chill and the slow, 碎裂 the shatter and the cones' damage, 冰壁 your life.
 */

import {
  answers,
  centerBranch,
  defineCharacter,
  flat,
  inc,
  keystone,
  mastery,
  notable,
  ranked,
  signatureNode,
  threshold,
} from '../templates';

/** `id` repeated `n` times: n ranks of it in a purchase order. */
const ranks = (id: string, n: number): string[] => Array.from({ length: n }, () => id);
const C = 'ice.center.';

/** The center's cone damage (碎裂's damage ranks): the fan's and its chains'. */
const CONES = { scope: 'center' } as const;

/**
 * 預設 build (V25): a default player's purchase order, ranks by repetition. Cone damage and the
 * chill first (the early waves die to the cones, the later ones to the shatters), then the hub,
 * the fire and crit outers with their fusions (冰火, 冰暴), 暴風雪 and the poison outer.
 */
const DEFAULT_ORDER: readonly string[] = [
  ...ranks(`${C}shatter.r1`, 2),
  ...ranks(`${C}frost.r1`, 2),
  ...ranks(`${C}shatter.r2`, 2),
  ...ranks(`${C}shatter.r1`, 2),
  ...ranks(`${C}frost.r1`, 2),
  ...ranks(`${C}shatter.r2`, 2),
  ...ranks(`${C}frost.r2`, 2),
  ...ranks(`${C}wall.r1`, 2),
  ...ranks(`${C}frost.r2`, 2),
  // A core comes about once a run from the elite every 5 waves: each ◆ is followed by ranks that
  // cost shards only, so a visit waiting for a core still spends its shards.
  `${C}shatter.chain-shatter`,
  ...ranks(`${C}shatter.r3`, 3),
  ...ranks(`${C}main.c3`, 3),
  ...ranks(`${C}shatter.r4`, 3),
  ...ranks('hub.economy.r1', 5),
  `${C}frost.glacier`,
  ...ranks(`${C}frost.r3`, 3),
  ...ranks(`${C}main.c1`, 3),
  ...ranks('hub.defense.r1', 5),
  ...ranks('hub.might.might', 4),
  ...ranks(`${C}frost.r4`, 3),
  `${C}frost.brittle`,
  ...ranks(`${C}shatter.r5`, 3),
  ...ranks('hub.might.might', 2),
  ...ranks(`${C}shatter.r6`, 3),
  `${C}shatter.icicle`,
  ...ranks('hub.might.might', 4),
  'outer.crit.main.entry',
  ...ranks('outer.crit.precision.r1', 4),
  ...ranks('hub.might.might', 2),
  ...ranks('outer.crit.heavy.r1', 4),
  ...ranks('hub.might.might', 2),
  ...ranks('outer.crit.precision.r2', 2),
  ...ranks('outer.crit.heavy.r2', 2),
  ...ranks(`${C}frost.r5`, 3),
  ...ranks(`${C}frost.r6`, 3),
  `${C}frost.permafrost`,
  ...ranks('hub.might.might', 2),
  'outer.crit.heavy.execute',
  ...ranks('hub.might.might', 2),
  'fusion.ice.crit.core',
  ...ranks('hub.might.might', 2),
  ...ranks('fusion.ice.crit.r1', 3),
  ...ranks('hub.might.might', 2),
  ...ranks(`${C}wall.r2`, 2),
  `${C}shatter.pulverize`,
  ...ranks('hub.might.might', 2),
  ...ranks('hub.defense.r2', 3),
  'hub.defense.wave-shield',
  ...ranks('hub.might.might', 2),
  'outer.fire.main.entry',
  ...ranks('outer.fire.blaze.r1', 4),
  ...ranks('outer.fire.blaze.r2', 4),
  'outer.fire.blaze.fuel',
  ...ranks('outer.fire.blaze.r3', 2),
  ...ranks('outer.fire.blaze.r4', 2),
  'fusion.ice.fire.core',
  ...ranks('hub.might.might', 2),
  ...ranks('fusion.ice.fire.r1', 3),
  ...ranks('hub.might.might', 2),
  `${C}main.threshold`,
  ...ranks('hub.might.might', 2),
  `${C}wall.frost-nova`,
  ...ranks(`${C}wall.r3`, 3),
  ...ranks('hub.might.might', 2),
  ...ranks('hub.might.might', 20),
];

export const ICE = defineCharacter({
  id: 'ice',
  color: 0x8fe3ff,
  center: {
    signature: signatureNode(),
    branches: [
      // 寒霜: the fan's rate, chill build-up and slow. The fan's rate is what holds the early
      // waves (balance sim, B3): a round covers one target's 30°, so more rounds reach more.
      centerBranch('frost', {
        r1: ranked('attackSpeed', 0.1, 4, 'more', CONES),
        r2: ranked('frostSlowCap', 0.03, 4, 'flat'),
        // 冰河: the slow cap +15%.
        a: notable('glacier', { modifiers: [flat('frostSlowCap', 0.15)] }),
        r3: ranked('frostOnHit', 0.02, 3, 'flat'),
        r4: ranked('freezeDuration', 0.1, 3, 'flat'),
        // 冰脆: every 10% chill, +6% damage taken, bosses too (答案：Boss).
        b: answers(
          notable('brittle', {
            modifiers: [inc('damage', 0.06, { scaling: { per: 'targetFrost', every: 0.1 } })],
          }),
          'boss',
        ),
        r5: ranked('attackSpeed', 0.1, 3, 'more', CONES),
        r6: ranked('frostSlowCap', 0.03, 3, 'flat'),
        // 凍土: a freeze leaves 2 s of frost ground (radius 60) that chills what stands in it by
        // 20% a second.
        c: notable('permafrost', {
          triggers: [
            {
              on: 'freeze',
              do: [
                {
                  kind: 'groundZone',
                  radius: 60,
                  durationSec: 2,
                  damagePctPerSec: 0,
                  addFrostPerSec: 0.2,
                  element: 'cold',
                },
              ],
            },
          ],
        }),
        mastery: mastery(),
      }),
      // 碎裂: shatter damage and radius, and the cones' damage.
      centerBranch('shatter', {
        r1: ranked('damage', 0.3, 4, 'increased', CONES),
        r2: ranked('shatterDamage', 0.15, 4),
        // 連鎖碎裂: an enemy a shatter kills shatters too.
        // TODO(engine B3): interim data until the shatter chain lands (an enemy killed by a
        // shatter does not shatter, src/data/triggers.ts); until then a wider shatter.
        a: notable('chain-shatter', { modifiers: [inc('shatterRadius', 0.3)] }),
        r3: ranked('damage', 0.3, 3, 'increased', CONES),
        r4: ranked('shatterRadius', 0.08, 3),
        // 粉碎: a pentagon that dies frozen does not split.
        // TODO(engine B3): interim data until the no-split-when-frozen hook lands; until then
        // harder shatters.
        b: notable('pulverize', { modifiers: [inc('shatterDamage', 0.3)] }),
        r5: ranked('damage', 0.3, 3, 'increased', CONES),
        r6: ranked('shatterDamage', 0.15, 3),
        // 冰柱: every 4th round fires one cone of 400% instead (答案：盾兵).
        c: answers(
          notable('icicle', { rules: [{ id: 'icicle', every: 4, damagePct: 4 }] }),
          'shielder',
        ),
        mastery: mastery(),
      }),
      // 冰壁: max life and regeneration.
      centerBranch('wall', {
        r1: ranked('maxLife', 0.1, 4),
        r2: ranked('lifeRegen', 0.003, 4, 'flat'),
        // 冰霜新星: an enemy within 120 sets off a frost nova (4 s cooldown): a presence poll
        // every 0.25 s (lead ruling A5), the nova at you, damage and chill (Hoshi's A5 default).
        a: notable('frost-nova', {
          triggers: [
            {
              on: 'periodic',
              every: 0.25,
              when: [{ cooldownSec: 4 }],
              target: { pick: 'nearest', from: 'player', range: 120 },
              do: [
                { kind: 'nova', radius: 120, damagePct: 0.5, element: 'cold', at: 'player' },
                { kind: 'addFrost', amount: 0.3, radius: 120, maxTargets: 64 },
              ],
            },
          ],
        }),
        r3: ranked('maxLife', 0.1, 3),
        r4: ranked('lifeRegen', 0.003, 3, 'flat'),
        // 凍結生機: chilled enemies regenerate 80% less (答案：再生者).
        b: answers(
          notable('preserve', {
            modifiers: [inc('enemyRegen', -0.8, { when: [{ targetHas: 'frost' }] })],
          }),
          'regenerator',
        ),
        r5: ranked('maxLife', 0.1, 3),
        r6: ranked('lifeRegen', 0.003, 3, 'flat'),
        // 霜甲: every freeze event shields you for 2% of max life, at most 30%.
        c: notable('frost-armour', {
          triggers: [{ on: 'freeze', do: [{ kind: 'shield', lifePct: 0.02, capPct: 0.3 }] }],
        }),
        mastery: mastery(),
      }),
    ],
    keystones: [
      // 絕對零度 (shared with the ice outer): every enemy always slowed 30%, no freeze immunity, a
      // boss's freeze events at least 1 s apart; attack speed −25%.
      keystone('absolute-zero', {
        rules: [{ id: 'absoluteZero', globalSlow: 0.3, bossGapSec: 1, attackSpeedMore: -0.25 }],
      }),
      // 稜鏡: one cone only, piercing every enemy, +20% damage per enemy pierced (at most +200%).
      keystone('prism', { rules: [{ id: 'prism', perPierce: 0.2, maxBonus: 2 }] }),
    ],
    // 暴風雪: every 10 s a blizzard at the densest spot (radius 200, 2 s): every 0.25 s it adds
    // 10% chill and hits for 15%.
    threshold: threshold({
      triggers: [
        {
          on: 'periodic',
          every: 10,
          target: { pick: 'densest' },
          do: [
            {
              kind: 'groundZone',
              radius: 200,
              durationSec: 2,
              damagePctPerSec: 0.6,
              addFrostPerSec: 0.4,
              element: 'cold',
            },
          ],
        },
      ],
    }),
    connectors: [
      ranked('attackSpeed', 0.05, 3),
      ranked('damage', 0.08, 3),
      ranked('maxLife', 0.1, 3),
      ranked('damage', 0.08, 3),
      ranked('attackSpeed', 0.05, 3),
      ranked('maxLife', 0.1, 3),
    ],
  },
  ascendancies: null,
  recommendedOuter: ['fire', 'poison', 'crit'],
  revealAt15: ['lightning', 'bleed', 'summon'],
  enemyRow: {
    triangle: 'strong',
    square: 'even',
    pentagon: 'strong',
    shielder: 'weak',
    regenerator: 'weak',
    dasher: 'strong',
    shooter: 'even',
    summoner: 'even',
    treasure: 'strong',
    boss: 'weak',
  },
  difficulty: 2,
  construct: 'frostCrystal',
  defaultOrder: DEFAULT_ORDER,
});
