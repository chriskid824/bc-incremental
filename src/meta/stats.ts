/**
 * Compiles the talent web into the StatBlock and rules handed to the simulation
 * (docs/ARCHITECTURE.md §3, §4.4).
 */

import type { RuleSpec } from '../data/rules';
import { sourceOfNode } from '../data/sources';
import { BASE_STATS, isScopedStat, STAT_IDS } from '../data/stats';
import type { Modifier, SourcedTrigger, StatBlock, StatExtras, StatId } from '../data/stats';
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

/**
 * Triggers of the start node and every allocated node, repeated per rank like modifiers, each
 * with its node's source (sourceOfNode), in data order; and their conversions, none yet.
 */
export function collectExtras(meta: Readonly<MetaState>, data: GameData): StatExtras {
  const triggers: SourcedTrigger[] = [];
  for (const node of data.talents) {
    const rank = nodeRank(meta, node);
    if (rank === 0 || node.triggers.length === 0) continue;
    const source = sourceOfNode(node.id);
    for (let r = 0; r < rank; r++) {
      for (const spec of node.triggers) triggers.push({ source, spec });
    }
  }
  return { triggers, conversions: [] };
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
 * without conditions or a scaling of every stat except damage, whose `values` entry keeps only
 * base + Σflat. Every modifier of a scoped stat (SCOPED_STATS) also goes to `scoped`, in data
 * order; tagged, scoped, conditional and scaling ones go only there, and the simulation folds
 * them per damage instance (src/sim/build/modTable.ts). An empty list counts as none. Throws on
 * tags, notTags, a scope, conditions or a scaling outside scoped stats or on flat damage, which
 * data validation should prevent. The extras (triggers, conversions) pass through.
 */
export function computeStatBlock(modifiers: readonly Modifier[], extras: StatExtras): StatBlock {
  const acc = {} as Record<StatId, Accumulator>;
  for (const stat of STAT_IDS) acc[stat] = { flat: 0, increased: 0, more: 1 };
  const scoped: Modifier[] = [];

  for (const mod of modifiers) {
    // Tags, a scope, conditions or a scaling make the value depend on the damage instance.
    const perInstance =
      (mod.tags?.length ?? 0) > 0 ||
      (mod.notTags?.length ?? 0) > 0 ||
      mod.scope !== undefined ||
      (mod.when?.length ?? 0) > 0 ||
      mod.scaling !== undefined;
    const isScoped = isScopedStat(mod.stat);
    if (perInstance && (!isScoped || (mod.stat === 'damage' && mod.kind === 'flat'))) {
      throw new Error(
        'Tags, scopes, conditions and scalings are only allowed on scoped stats, not flat ' +
          `damage: ${JSON.stringify(mod)}`,
      );
    }
    if (isScoped) scoped.push(mod);
    // Damage increased/more apply per damage instance too.
    if (perInstance || (mod.stat === 'damage' && mod.kind !== 'flat')) continue;
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
  return computeStatBlock(collectModifiers(meta, data), collectExtras(meta, data));
}
