/**
 * Compiles the talent web into the StatBlock and rules handed to the simulation
 * (docs/ARCHITECTURE.md §3, §4.4).
 */

import type { RuleSpec } from '../data/rules';
import { BASE_STATS, isScopedStat, NO_EXTRAS, STAT_IDS } from '../data/stats';
import type { Modifier, StatBlock, StatExtras, StatId } from '../data/stats';
import type { GameData } from '../data/types';
import { nodeRank } from './talents';
import type { MetaState } from './types';

/**
 * Modifiers of the start node and every allocated node, repeated per rank for repeatable
 * nodes. Iterates in data order so the result does not depend on purchase order.
 */
export function collectModifiers(meta: Readonly<MetaState>, data: GameData): Modifier[] {
  const modifiers: Modifier[] = [];
  for (const node of data.talents) {
    const rank = nodeRank(meta, node);
    for (let r = 0; r < rank; r++) modifiers.push(...node.modifiers);
  }
  return modifiers;
}

/** Rules of the start node and every allocated node, once each. */
export function collectRules(meta: Readonly<MetaState>, data: GameData): RuleSpec[] {
  const rules: RuleSpec[] = [];
  for (const node of data.talents) {
    if (nodeRank(meta, node) > 0) rules.push(...node.rules);
  }
  return rules;
}

interface Accumulator {
  flat: number;
  increased: number;
  more: number;
}

/**
 * final = (base + Σflat) × (1 + Σincreased) × Π(1 + more) over the untagged, unscoped modifiers
 * of every stat except damage, whose `values` entry keeps only base + Σflat. Every modifier of a
 * scoped stat (SCOPED_STATS) also goes to `scoped`, in data order; tagged and scoped ones go only
 * there, and the simulation folds them per damage instance (src/sim/build/modTable.ts). An empty
 * tag list is untagged. Throws on tags, notTags or a scope outside scoped stats or on flat
 * damage, which data validation should prevent.
 */
export function computeStatBlock(modifiers: readonly Modifier[], extras: StatExtras): StatBlock {
  const acc = {} as Record<StatId, Accumulator>;
  for (const stat of STAT_IDS) acc[stat] = { flat: 0, increased: 0, more: 1 };
  const scoped: Modifier[] = [];

  for (const mod of modifiers) {
    const tagged =
      (mod.tags?.length ?? 0) > 0 || (mod.notTags?.length ?? 0) > 0 || mod.scope !== undefined;
    const isScoped = isScopedStat(mod.stat);
    if (tagged && (!isScoped || (mod.stat === 'damage' && mod.kind === 'flat'))) {
      throw new Error(
        `Tags and scopes are only allowed on scoped stats, not flat damage: ${JSON.stringify(mod)}`,
      );
    }
    if (isScoped) scoped.push(mod);
    // Damage increased/more apply per damage instance, like tagged modifiers.
    if (tagged || (mod.stat === 'damage' && mod.kind !== 'flat')) continue;
    const a = acc[mod.stat];
    if (mod.kind === 'flat') a.flat += mod.value;
    else if (mod.kind === 'increased') a.increased += mod.value;
    else a.more *= 1 + mod.value;
  }

  const values = {} as Record<StatId, number>;
  for (const stat of STAT_IDS) {
    const a = acc[stat];
    values[stat] = (BASE_STATS[stat] + a.flat) * (1 + a.increased) * a.more;
  }
  return {
    base: BASE_STATS,
    values,
    scoped,
    triggers: extras.triggers,
    conversions: extras.conversions,
  };
}

/** StatBlock of the current talent allocation. */
export function statBlockFor(meta: Readonly<MetaState>, data: GameData): StatBlock {
  return computeStatBlock(collectModifiers(meta, data), NO_EXTRAS);
}
