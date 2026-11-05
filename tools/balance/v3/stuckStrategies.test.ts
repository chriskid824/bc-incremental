/**
 * The strategies a balance review of 06c7d67 found stuck at waves 3–7 for whole sessions with
 * shards banked (greedy, 熔核's balanced, might-only, every focus:<o>): each plays a short seeded
 * session on the registered content past the best wave any of the review's 20 sessions of 120
 * minutes reached, and ends every visit with no node canBuy accepts left unbought but for its
 * rule's reason (unexplained).
 */

import { describe, expect, it } from 'vitest';
import type { CharacterId } from '../../../src/data';
import type { AssembledWeb, WebNode } from '../../../src/data/web';
import { DEFAULT_WEB_ECONOMY } from '../../../src/meta/web';
import type { CharacterProgress } from '../../../src/meta/web';
import { GATED_KINDS, storedRank } from '../../../src/meta/web/counts';
import { shortestRoute } from '../../../src/meta/web/path';
import { runCharacterSession } from './session';
import type { CharacterSessionConfig } from './session';
import {
  createStrategy,
  focusOuter,
  isRulesKeystone,
  openNodes,
  savesForShards,
} from './strategies';
import type { GreedyEvaluation, WebStrategy, WebStrategyId } from './strategies';
import type { Visit } from './visit';

/** The nodes canBuy accepts at the end of a visit. */
const accepted = (v: Visit): WebNode[] =>
  openNodes(v.web, v.progress()).filter((node) => v.check(node.id).ok);

/** The route to the nearest might, as might-only plans it. */
function mightRoute(v: Visit): readonly string[] | null {
  let route: readonly string[] | null = null;
  for (const might of v.web.nodes.filter((node) => node.kind === 'might')) {
    const found = shortestRoute(v.web, v.progress(), might.id, (n) => !GATED_KINDS.has(n.kind));
    if (found !== null && (route === null || found.length < route.length)) route = found;
  }
  return route;
}

/**
 * The accepted nodes a visit of `id` from `start` left unbought that its rule does not explain;
 * `probed` is the greedy readings the visit made. greedy: none it probed with a gain at the rank
 * it still holds (greedy buys one rank of each, no re-probe). balanced: none but the hub's 規則 ★.
 * might-only: no might once one is owned; before, none when the route's next step waits on shards
 * (saving), none costing no cores when it waits on a core. focus: after greedy's rule, as greedy;
 * a visit that stopped before it must have saved, so some open node is short of shards alone
 * (savesForShards).
 */
function unexplained(
  id: WebStrategyId,
  v: Visit,
  start: CharacterProgress,
  probed: readonly GreedyEvaluation[],
): string[] {
  const left = accepted(v);
  const gained = new Set(
    probed
      .filter((e) => e.gain > 0 && storedRank(v.progress(), e.node) === storedRank(start, e.node))
      .map((e) => e.node),
  );
  const ids = (nodes: readonly WebNode[]): string[] => nodes.map((node) => node.id);
  if (id === 'greedy') return ids(left.filter((node) => gained.has(node.id)));
  if (id === 'balanced') return ids(left.filter((node) => !isRulesKeystone(node)));
  if (id === 'might-only') {
    const progress = v.progress();
    const mights = v.web.nodes.filter((node) => node.kind === 'might');
    if (mights.some((might) => storedRank(progress, might.id) > 0)) {
      return ids(left.filter((node) => node.kind === 'might'));
    }
    const step = mightRoute(v)?.[0];
    if (step === undefined) return [];
    const check = v.check(step);
    if (check.ok) return [step];
    if (check.reason !== 'notEnoughCores') return [];
    return ids(left.filter((node) => v.economy.cores[node.kind] === 0));
  }
  if (focusOuter(id) !== null) {
    if (probed.length > 0) return ids(left.filter((node) => gained.has(node.id)));
    const saved = openNodes(v.web, v.progress()).some((node) => {
      const check = v.check(node.id);
      return !check.ok && savesForShards(v, node.id, check.reason);
    });
    return saved ? [] : ids(left);
  }
  throw new Error(`no rule for ${id}`);
}

/** createStrategy, each visit's unexplained nodes pushed to `problems`. */
const audited =
  (problems: string[]) =>
  (id: WebStrategyId, web: AssembledWeb): WebStrategy => {
    const inner = createStrategy(id, web);
    return {
      id,
      evaluations: inner.evaluations,
      visit(v) {
        const start = v.progress();
        const before = inner.evaluations.length;
        inner.visit(v);
        const left = unexplained(id, v, start, inner.evaluations.slice(before));
        if (left.length > 0) problems.push(`${v.minutes.toFixed(2)} min: ${left.join(' ')}`);
      },
    };
  };

const config = (
  character: CharacterId,
  strategy: WebStrategyId,
  minutes: number,
): CharacterSessionConfig => ({
  character,
  strategy,
  session: 0,
  seed: 1,
  minutes,
  startWave: { kind: 'max' },
  economy: DEFAULT_WEB_ECONOMY,
  menuSeconds: 20,
  content: 'registered',
  scope: 'full',
});

/**
 * [character, strategy, minutes, the best wave of the review's 20 sessions × 120 min]
 * (/mnt/project-files/balance-review-1104/balance/full/runs.csv).
 */
const STUCK: readonly (readonly [CharacterId, WebStrategyId, number, number])[] = [
  ['fire', 'greedy', 30, 10],
  ['summon', 'greedy', 20, 4],
  ['fire', 'balanced', 30, 9],
  ['fire', 'might-only', 10, 4],
  ['summon', 'might-only', 10, 4],
  ['fire', 'focus:poison', 10, 5],
  ['fire', 'focus:crit', 10, 5],
  ['fire', 'focus:ice', 10, 5],
  ['fire', 'focus:summon', 10, 5],
  ['summon', 'focus:fire', 10, 5],
  ['summon', 'focus:poison', 10, 5],
  ['summon', 'focus:crit', 10, 5],
  ['summon', 'focus:ice', 10, 5],
];

describe('the strategies the review found stuck', () => {
  it.each(STUCK)(
    '%s %s: in %d min past wave %d, every visit spending as its rule says',
    (character, strategy, minutes, reviewBest) => {
      const problems: string[] = [];
      const result = runCharacterSession(config(character, strategy, minutes), {
        strategy: audited(problems),
      });
      expect(problems).toEqual([]);
      expect(result.rows.at(-1)?.bestWave).toBeGreaterThan(reviewBest);
    },
    60_000,
  );
});
