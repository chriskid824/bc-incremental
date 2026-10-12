/**
 * Compiles the talent web into the StatBlock and rules handed to the simulation
 * (docs/ARCHITECTURE.md §3, §4.4).
 */

import type { RuleSpec } from '../data/rules';
import { BASE_STATS, DAMAGE_TAG_MASK_COUNT, STAT_IDS, tagMask } from '../data/stats';
import type { Modifier, StatBlock, StatId } from '../data/stats';
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
 * final = (base + Σflat) × (1 + Σincreased) × Π(1 + more) for every stat except damage.
 * Damage keeps only base + Σflat in `values`; its increased/more modifiers go into
 * `damageMult`, where a modifier counts toward mask m when its tags are a subset of m
 * (untagged modifiers count toward every mask). An empty tag list is untagged.
 * Throws on tags outside increased/more damage, which data validation should prevent.
 */
export function computeStatBlock(modifiers: readonly Modifier[]): StatBlock {
  const acc = {} as Record<StatId, Accumulator>;
  for (const stat of STAT_IDS) acc[stat] = { flat: 0, increased: 0, more: 1 };
  const damageIncreased = new Array<number>(DAMAGE_TAG_MASK_COUNT).fill(0);
  const damageMore = new Array<number>(DAMAGE_TAG_MASK_COUNT).fill(1);

  for (const mod of modifiers) {
    const mask = mod.tags ? tagMask(mod.tags) : 0;
    const scaling = mod.stat === 'damage' && mod.kind !== 'flat';
    if (mask !== 0 && !scaling) {
      throw new Error(`Tags are only allowed on increased/more damage: ${JSON.stringify(mod)}`);
    }
    if (scaling) {
      for (let m = 0; m < DAMAGE_TAG_MASK_COUNT; m++) {
        if ((mask & m) !== mask) continue;
        if (mod.kind === 'increased') {
          damageIncreased[m] = (damageIncreased[m] as number) + mod.value;
        } else {
          damageMore[m] = (damageMore[m] as number) * (1 + mod.value);
        }
      }
      continue;
    }
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
  const damageMult = damageIncreased.map((inc, m) => (1 + inc) * (damageMore[m] as number));
  return { values, damageMult };
}

/** StatBlock of the current talent allocation. */
export function statBlockFor(meta: Readonly<MetaState>, data: GameData): StatBlock {
  return computeStatBlock(collectModifiers(meta, data));
}
