/**
 * The fusion overrides (docs/v3 C6 design D12, §3.5; implementation-plan-v3 impl:343-344): one
 * map keyed by fusion, which src/data/fusion/generate.ts applies over the generated core. Each of
 * the 12 hand pairs (a character with another archetype's outer) needs its rule here (V11), with
 * HAND_RANKS unless it gives its own; a template pair may replace its core's trigger, add
 * triggers (火毒's 瘟疫爆彈), replace or drop its bonus, add modifiers, replace its ranks and merge
 * its skin, and only the pairs of TEMPLATE_RULE_OVERRIDES may add rules.
 */

import type { FusionKey, FusionOverride } from '../web/types';

export const OVERRIDES: Readonly<Partial<Record<FusionKey, FusionOverride>>> = {
  // 火毒「瘟爆」 (gd:597): v2's 瘟疫爆彈, a poisoned enemy burned to death passes its poison
  // stacks to the enemies within 90.
  'fire.poison': {
    addTriggers: [
      {
        on: 'diedWithAilment',
        when: [{ victimHas: 'poison' }, { killedBy: 'burn' }],
        do: [{ kind: 'spreadAilment', ailment: 'poison', radius: 90, effect: 0.9 }],
      },
    ],
  },
  // 火冰「霜焰」 (gd §5.2): explosions add 30% chill; an enemy holding frost carries 3 more burn
  // stacks; the fire zones turn to frost-fire zones that slow by 30%.
  'fire.ice': { rule: { id: 'frostflame', frostPct: 0.3, burnCapBonus: 3, zoneSlow: 0.3 } },
  // 火靈「爆靈」 (gd:525): every 4th bomb spawns a 4 s fire spirit that rushes the nearest enemy,
  // explodes and ignites 3 stacks, at most 6 at once. Its hit's share is B1's initial value.
  'fire.summon': {
    rule: {
      id: 'blastSpirit',
      every: 4,
      lifeSec: 4,
      damagePct: 1,
      burnStacks: 3,
      burnDamagePct: 1,
      maxLive: 6,
    },
  },
  // 火召喚「焰蜂」 (gd §5.2): drone impacts ignite 2 stacks; a burning enemy a drone kills explodes
  // (radius 60). The explosion's hit is B2's initial value.
  'summon.fire': {
    rule: { id: 'flameBee', burnStacks: 2, blastRadius: 60, blastDamagePct: 1 },
  },
  // 冰召喚「霜蜂」 (gd §5.2): drone impacts add 12% chill; an impact on a frozen enemy (no boss)
  // shatters it.
  'summon.ice': { rule: { id: 'frostBee', frostPct: 0.12 } },
  // 冰火「熱震」 (gd §5.2): a freeze ignites the target 2 stacks; a frozen enemy that is ignited
  // takes one 200% hit (the thaw waits on the engine, src/sim/rules/frostFusions.ts).
  'ice.fire': { rule: { id: 'thermalShock', burnStacks: 2, hitPct: 2 } },
  // 冰雷「超導」 (gd §5.2): a freeze arcs to the 3 nearest enemies, each arc +20% chill; a shocked
  // enemy's chill builds ×1.5. The arcs' hit (50%) is B3's initial value.
  'ice.lightning': {
    rule: { id: 'superconduct', arcs: 3, arcDamagePct: 0.5, frostPct: 0.2, shockFrostMore: 0.5 },
  },
  // 冰靈「冰晶哨」 (gd §5.2): a shatter leaves, 25% of the time, a 5 s ice sentry that shoots
  // cones, at most 4. Its cones (5 shots of 40%) are B3's initial values.
  'ice.summon': {
    rule: {
      id: 'frostSentry',
      chance: 0.25,
      lifeSec: 5,
      maxLive: 4,
      everySec: 0.5,
      range: 300,
      count: 3,
      spreadDeg: 30,
      damagePct: 0.3,
    },
  },
  // 火雷「電漿」 (gd §5.2): each explosion arcs from every burning enemy in it at the nearest enemy,
  // at most 3 a bomb; shocked enemies take +30% burn damage. The arc's hit (50%) is B3's.
  'fire.lightning': {
    rule: { id: 'plasma', arcsPerBlast: 3, arcDamagePct: 0.5, shockBurnMore: 0.3 },
  },
  // 雷召喚「雷網蜂」 (gd §5.2): every 0.5 s each drone links to its nearest other drone; every
  // 0.25 s each enemy on a link takes a 10% hit and a shock stack.
  'summon.lightning': {
    rule: { id: 'stormWeb', damagePct: 0.1, periodSec: 0.25, pairPeriodSec: 0.5 },
  },
};

/** Fusions accepted outside the band, each with the reason the batch PR quotes (F21). */
export const ACCEPTED_FAILS: Readonly<Partial<Record<FusionKey, string>>> = {
  // B1: 熔核's probe investment (8 center nodes at rank 1 + 6 outer) reaches only wave ~4, where
  // the bombs' coverage holds the frontier and every enemy a bomb reaches dies to its hit; what a
  // payload adds after the hit cannot move it. 前線節奏 passes at 10, 20 and 40 min without it.
  'fire.crit':
    'B1: spread at coef 0.436 (median 1.15, seeds 1.03–1.28); the probe sits at wave ~4, where 熔核 is held by bomb coverage, not damage',
  'fire.poison':
    'B1: insensitive at the probe (wave ~4): every enemy a bomb reaches dies to its hit, so poison and 瘟爆 have nothing left to kill there',
  'fire.summon':
    'B1: no coef search: at the probe (wave ~4) a run gets a few spirits, and 8 seeds read 0.99–2.79 at gd numbers (median 1.53); a lower hit share did not lower the median, so 爆靈 keeps coef 1',
  'fire.ice':
    'B1: weak at the probe (median 1.17 at the top of its range): at wave ~4 the burn cap and the frost-fire slow matter little; 霜焰 keeps the gd numbers',
  // B2: 蜂巢's probe (8 center nodes at rank 1 + 6 outer) dies to leaks at wave ~4 (fire) to ~7
  // (ice): every drone impact there kills its target outright, so what an impact puts on the
  // target (burn, chill, poison, a crit's bleed) has no one left to act on. The frontier is held
  // by how many enemies the few drones reach, not by damage per target.
  'summon.fire':
    'B2: insensitive at the probe (wave ~4): every drone impact kills its target, so 焰蜂 never finds a burning target; it keeps the gd numbers',
  'summon.ice':
    'B2: insensitive at the probe (wave ~7): every drone impact kills its target before the chill can freeze it; 霜蜂 keeps the gd numbers',
  'summon.poison':
    'B2: insensitive at the probe: drone impacts kill their targets, so 毒泡 has nothing left to poison; the template keeps coef 1',
  'summon.crit':
    'B2: insensitive at the probe (median 1.01): the probe is held by leaks, not damage per target, so 刃翼 cannot move it; the template keeps coef 1',
  // B3: the probes (8 center nodes at rank 1 + 6 outer) sit at waves ~4-10 as B1's and B2's do.
  // 霜晶's freeze needs about 10 cone hits on one enemy, and at waves 4-7 most enemies die to the
  // cones before they freeze, so the freeze payloads have few freezes to ride; 熔核's and 蜂巢's
  // targets die to the bomb or the impact before a bleed or an arc can matter.
  'ice.fire':
    'B3: spread at coef 2.09 (median 1.20, seeds 1.03–1.74): at the probe (wave ~5) few enemies live to freeze, so a seed reads 0 or several 熱震 hits',
  'ice.lightning':
    'B3: insensitive at the probe (wave ~5): few freezes, and the arcs land on enemies the cones kill anyway; 超導 keeps the gd numbers',
  'ice.summon':
    'B3: insensitive at the probe (wave ~9): a shatter needs a kill while frozen, which the probe barely makes; 冰晶哨 keeps the gd numbers',
  'ice.poison':
    'B3: spread at coef 4.18 (median 1.07): few freezes at the probe (wave ~5), so poison on freeze reads mostly nothing',
  'ice.bleed':
    'B3: spread at coef 2.35 (median 1.26, seeds 1.02–1.68): few freezes at the probe (wave ~5); the seeds that freeze early read high',
  'ice.crit':
    'B3: spread at coef 5.55 (median 1.19, seeds 1.00–1.38): few freezes at the probe (wave ~5), so the slash fires rarely',
  'ice.barrage':
    'B3: insensitive at the probe (wave ~6): few freezes, and 4 small projectiles at 25% kill nothing the cones do not',
  'fire.lightning':
    'B3: insensitive at the probe (wave ~4): every enemy a bomb reaches dies to its hit, so 電漿 finds no burning target left',
  'fire.bleed':
    'B3: insensitive at the probe (wave ~4): every enemy a bomb reaches dies to its hit before a bleed ticks',
  'fire.barrage':
    'B3: spread at coef 1.04 (median 1.12, seeds 0.95–1.73): at the probe (wave ~4) the bombs hold the frontier by coverage, and the radial bullets reach the few that slip by',
  'summon.lightning':
    'B3: insensitive at the probe (wave ~10): with 3 drones the web links few enemies, and the impacts kill them anyway; 雷網蜂 keeps the gd numbers',
  'summon.bleed':
    'B3: insensitive at the probe (wave ~4): drone impacts kill their targets, so 血蛭 has nothing left to bleed; the template keeps coef 1',
  'summon.barrage':
    'B3: weak at coef 10 (median 1.07): the probe is held by leaks, not damage per target; the bullets help a little at any coef',
};

/**
 * The template pairs whose override may add rules (F12): 冰光's 永凍 and 雷光's 雷暴環, which
 * cannot be data (impl:344, AMB25).
 */
export const TEMPLATE_RULE_OVERRIDES: readonly FusionKey[] = ['ice.aura', 'lightning.aura'];
