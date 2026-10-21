/**
 * The fusion overrides (docs/v3 C6 design D12, §3.5; implementation-plan-v3 impl:343-344): one
 * map keyed by fusion, which src/data/fusion/generate.ts applies over the generated core. Each of
 * the 12 hand pairs (a character with another archetype's outer) needs its rule here (V11), with
 * HAND_RANKS unless it gives its own; a template pair may replace its core's trigger, add
 * triggers (火毒's 瘟疫爆彈), replace or drop its bonus, add modifiers, replace its ranks and merge
 * its skin, and only the pairs of TEMPLATE_RULE_OVERRIDES may add rules. Empty until B1.
 */

import type { FusionKey, FusionOverride } from '../web/types';

export const OVERRIDES: Readonly<Partial<Record<FusionKey, FusionOverride>>> = {};

/** Fusions accepted outside the band, each with the reason the batch PR quotes (F21). */
export const ACCEPTED_FAILS: Readonly<Partial<Record<FusionKey, string>>> = {};

/**
 * The template pairs whose override may add rules (F12): 冰光's 永凍 and 雷光's 雷暴環, which
 * cannot be data (impl:344, AMB25).
 */
export const TEMPLATE_RULE_OVERRIDES: readonly FusionKey[] = ['ice.aura', 'lightning.aura'];
