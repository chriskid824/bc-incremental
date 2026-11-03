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
    'B1: spread at the probe (median 1.15 at coef 0.631, seeds 1.02–1.87): at wave ~4 a run gets only a few spirits, so whether one meets a crowd decides the seed',
  'fire.ice':
    'B1: weak at the probe (median 1.17 at the top of its range): at wave ~4 the burn cap and the frost-fire slow matter little; 霜焰 keeps the gd numbers',
};

/**
 * The template pairs whose override may add rules (F12): 冰光's 永凍 and 雷光's 雷暴環, which
 * cannot be data (impl:344, AMB25).
 */
export const TEMPLATE_RULE_OVERRIDES: readonly FusionKey[] = ['ice.aura', 'lightning.aura'];
