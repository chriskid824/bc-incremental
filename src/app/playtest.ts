/**
 * Playtest events (docs/ARCHITECTURE.md §9) built from game state, and the playtest services
 * of the web build. The M1 gate reads total play time per player; the rest says where players
 * go and why they stop: runs, waves, points per archetype, keystones and the exit screen.
 */

import { add, div, toNumber } from '../core/num';
import type { GameData, TalentNode } from '../data';
import { nodeRank } from '../meta';
import type { MetaState } from '../meta';
import type { EventFields, FirestoreConfig } from '../platform/analytics';
import { TICK_RATE } from '../sim';
import type { RunReport } from './session';

/**
 * Firestore project for the web playtest, or null to keep events in the local log only. The
 * web API key and project id ship in every Firebase web app and are not secrets; Firestore
 * accepts only what firestore.rules allows (create in `playtest`, size-limited, no reads).
 */
export const FIREBASE: FirestoreConfig | null = null;

/**
 * Prefilled Google Form link for the in-game survey, or '' for no survey button. The literal
 * INSTALL_ID in it becomes the player's anonymous install id, so answers join the events.
 */
export const FEEDBACK_URL: string = '';

/** Play time before the result screen also offers the survey. */
export const FEEDBACK_AFTER_SECONDS = 15 * 60;

/** Where the player is; the last one before the page closes is the exit point. */
export type Screen = 'intro' | 'running' | 'results' | 'talents';

type Archetype = TalentNode['archetype'];

const ARCHETYPES: readonly Archetype[] = ['crit', 'dot', 'chain', 'hybrid', 'none'];

/**
 * The Firestore project playtest events go to, or null to keep them in the local log only: none
 * from the dev server, whose sessions would pollute the playtest data, and none under `?hive`,
 * a dev prototype whose runs are not M1's (docs/v3 C5 design D21).
 */
export function playtestFirestore(
  config: FirestoreConfig | null,
  dev: boolean,
  hive: boolean,
): FirestoreConfig | null {
  return dev || hive ? null : config;
}

/** The survey link for this install, or null when there is no survey. */
export function feedbackLink(installId: string, url: string = FEEDBACK_URL): string | null {
  if (url === '') return null;
  return url.replaceAll('INSTALL_ID', encodeURIComponent(installId));
}

/** Allocated nodes per archetype; repeatable ranks (Might) are counted apart. */
export function archetypePoints(
  meta: Readonly<MetaState>,
  data: GameData,
): Record<Archetype, number> {
  const points = Object.fromEntries(ARCHETYPES.map((a) => [a, 0])) as Record<Archetype, number>;
  for (const node of data.talents) {
    if (node.kind === 'start' || node.kind === 'repeatable') continue;
    if (nodeRank(meta, node) > 0) points[node.archetype]++;
  }
  return points;
}

/** Repeatable ranks by node id (M1: Might only). */
function repeatableRanks(meta: Readonly<MetaState>): Record<string, number> {
  return Object.fromEntries(meta.ranks);
}

export function allocatedKeystones(meta: Readonly<MetaState>, data: GameData): string[] {
  return data.talents
    .filter((node) => node.kind === 'keystone' && nodeRank(meta, node) > 0)
    .map((node) => node.id);
}

/** What the talents look like: points per archetype, keystones and repeatable ranks. */
export function buildFields(meta: Readonly<MetaState>, data: GameData): EventFields {
  return {
    points: archetypePoints(meta, data),
    keystones: allocatedKeystones(meta, data),
    ranks: repeatableRanks(meta),
  };
}

export function sessionStartFields(
  meta: Readonly<MetaState>,
  data: GameData,
  playSeconds: number,
  viewport: { readonly width: number; readonly height: number },
): EventFields {
  return {
    runs: meta.runs,
    maxWave: meta.maxWave,
    play: Math.round(playSeconds),
    width: viewport.width,
    height: viewport.height,
    ...buildFields(meta, data),
  };
}

/** One finished run, with the talents it was played with. */
export function runEndFields(
  report: RunReport,
  meta: Readonly<MetaState>,
  data: GameData,
  playSeconds: number,
): EventFields {
  const { result, settlement, run } = report;
  const seconds = result.ticks / TICK_RATE;
  const { hit, crit, burn, chain, poison, bleed } = result.damage;
  const dealt = add(add(add(hit, crit), add(burn, chain)), add(poison, bleed));
  return {
    run: run.number,
    startWave: result.startWave,
    wave: result.highestWaveReached,
    cleared: result.clearedStartWave,
    seconds: Math.round(seconds * 10) / 10,
    end: result.endReason,
    killedBy: result.killedBy,
    kills: result.kills,
    leaks: result.leaks,
    dps: seconds > 0 ? toNumber(div(dealt, seconds)) : 0,
    maxHit: toNumber(result.maxHit),
    shards: toNumber(settlement.shardsFromRun),
    skipShards: toNumber(settlement.skipShards),
    bank: toNumber(report.bankShards),
    play: Math.round(playSeconds),
    ...buildFields(meta, data),
  };
}

export function sessionEndFields(
  screen: Screen,
  runNumber: number | null,
  wave: number | null,
  playSeconds: number,
): EventFields {
  return { screen, run: runNumber, wave, play: Math.round(playSeconds) };
}
