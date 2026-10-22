/**
 * A character's run from its web (docs/v3 C6 design §5.1, D7, D9, D10, D21, P4, F43, F54): the
 * owned nodes compiled into a StatBlock and sourced rules, the run's config, its start wave and its
 * settlement. B1's run loop calls them; the M1 path (statBlockFor, settleRun's M1 callers) is as it
 * was.
 */

import type { SourcedEmitter } from '../../data/emitters';
import type { SignatureSpec } from '../../data/rules';
import { sourceOfNode } from '../../data/sources';
import type {
  Modifier,
  SourcedConversion,
  SourcedRule,
  SourcedTrigger,
  StatBlock,
} from '../../data/stats';
import type { GameData } from '../../data/types';
import type { AssembledWeb } from '../../data/web/types';
import type { CharacterRun, RunConfig, RunResult } from '../../sim/types';
import { allowedStartWave, settleRun } from '../settle';
import type { SettleTarget } from '../settle';
import { computeStatBlock } from '../stats';
import type { Settlement } from '../types';
import { outerOfBoard, storedRank } from './counts';
import { DEFAULT_WEB_ECONOMY } from './price';
import type { CharacterProgress, WebEconomy } from './types';

export interface WebRun {
  readonly stats: StatBlock;
  readonly signature: SignatureSpec;
  readonly character: CharacterRun;
}

/**
 * A modifier of a rank-r node as one entry (P4, F54): value × r for flat and increased, and
 * (1 + value)^r − 1 for more, which the static fold and evalDynamic multiply in as (1 + value)^r.
 */
function merged(mod: Modifier, rank: number): Modifier {
  const value = mod.kind === 'more' ? Math.pow(1 + mod.value, rank) - 1 : mod.value * rank;
  return { ...mod, value };
}

/**
 * The run of `progress` (§5.1): web.nodes in order, every owned node at rank r but the signature
 * collected as M1's collectModifiers and collectExtras do (src/meta/stats.ts), except that a
 * modifier without a scaling goes in once, merged (P4), while one with a scaling goes in r times,
 * its cap applying per copy; triggers and conversions r times and emitter grants once, each with
 * its node's source; a fusion board's triggers with the fusion's coef. Rules go in once each, as
 * { source, spec, coef }, coef 1 off fusion boards (D9, D10).
 */
export function webBuild(web: AssembledWeb, progress: CharacterProgress): WebRun {
  const modifiers: Modifier[] = [];
  const triggers: SourcedTrigger[] = [];
  const conversions: SourcedConversion[] = [];
  const emitters: SourcedEmitter[] = [];
  const rules: SourcedRule[] = [];
  for (const node of web.nodes) {
    if (node.kind === 'signature') continue;
    const rank = storedRank(progress, node.id);
    if (rank === 0) continue;
    const { effects } = node;
    for (const mod of effects.modifiers) {
      if (mod.scaling !== undefined) for (let r = 0; r < rank; r++) modifiers.push(mod);
      else modifiers.push(rank === 1 ? mod : merged(mod, rank));
    }
    const source = sourceOfNode(node.id);
    const outer = node.board.startsWith('fusion.') ? outerOfBoard(node.board) : null;
    const coef = outer === null ? undefined : web.fusions.get(outer)?.coef;
    for (let r = 0; r < rank; r++) {
      for (const spec of effects.triggers) {
        triggers.push(coef === undefined ? { source, spec } : { source, spec, coef });
      }
      for (const spec of effects.conversions) conversions.push({ source, spec });
    }
    for (const grant of effects.emitters) emitters.push({ source, grant });
    for (const spec of effects.rules) rules.push({ source, spec, coef: coef ?? 1 });
  }
  return {
    stats: computeStatBlock(modifiers, { triggers, conversions, emitters }),
    signature: web.def.signature,
    character: { id: web.def.id, rules },
  };
}

/** The run's config (§5.1): no M1 rules, the character's signature and rules, auto mode. */
export function webRunConfig(
  run: WebRun,
  seed: number,
  startWave: number,
  waveCap?: number,
): RunConfig {
  return {
    seed,
    stats: run.stats,
    rules: [],
    signature: run.signature,
    character: run.character,
    startWave,
    mode: 'auto',
    ...(waveCap === undefined ? {} : { waveCap }),
  };
}

/** The highest start wave allowed: M1's rule on this prestige cycle's best (F43). */
export function webStartWave(
  progress: CharacterProgress,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
): number {
  return allowedStartWave({ maxWave: progress.cycleBest }, economy);
}

/**
 * A finished run credited to `progress` (§5.1, D21): settleRun on a SettleTarget holding the
 * wallet's shards and cores, cycleBest and runs, and the best wave raised to the run's farthest.
 */
export function settleWebRun(
  progress: CharacterProgress,
  result: RunResult,
  data: GameData,
  stats: StatBlock,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
): { readonly progress: CharacterProgress; readonly settlement: Settlement } {
  const target: SettleTarget = {
    shards: progress.wallet.shards,
    cores: progress.wallet.cores,
    maxWave: progress.cycleBest,
    runs: progress.runs,
  };
  const settlement = settleRun(target, result, data, stats, economy);
  return {
    progress: {
      ...progress,
      wallet: { ...progress.wallet, shards: target.shards, cores: target.cores },
      cycleBest: target.maxWave,
      runs: target.runs,
      bestWave: Math.max(progress.bestWave, result.highestWaveReached),
    },
    settlement,
  };
}
