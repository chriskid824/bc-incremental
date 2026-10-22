/**
 * sampleProgress (docs/v3 C6 design D25, §4.9; AMB18): 1,000 draws on the fixture's eight webs
 * are all legal: a recording of buy gives each draw's purchases, every one of which canBuy accepts
 * on the progress the one before it left, from empty, and the draw returns the last of them; the
 * count is reached unless nothing is left. The first purchase is uniform among the nodes canBuy
 * accepts, and so is a later one, an owned node's next rank included; the third fusion slot opens
 * only to a draw whose account has beaten the singularity; a web with nothing left stops the draw,
 * and every draw comes from the rng it is given.
 */

import { describe, expect, it, vi } from 'vitest';
import { num, ZERO } from '../../core/num';
import { createRng, deriveSeed } from '../../core/rng';
import { CHARACTER_IDS } from '../../data/sources';
import { assembleWeb, scopeHolds } from '../../data/web/assemble';
import { FULL_SCOPE, SCOPES } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import type { AssembledWeb } from '../../data/web/types';
import { chainOfBoard } from './counts';
import { boardCounts, canBuy, emptyProgress } from './rules';
import type * as RulesModule from './rules';
import { sampleProgress } from './sample';
import type { SampleOptions } from './sample';
import type { AccountProgress, CharacterProgress, Wallet } from './types';

/** One buy call: its arguments and what it returned. */
interface Purchase {
  readonly before: CharacterProgress;
  readonly account: AccountProgress;
  readonly id: string;
  readonly rest: readonly unknown[];
  readonly after: CharacterProgress;
}

/** Every buy that returned, in order, while `log` is set. */
const recorder = vi.hoisted(() => ({ log: null as Purchase[] | null }));
vi.mock('./rules', async (importOriginal) => {
  const actual = await importOriginal<typeof RulesModule>();
  return {
    ...actual,
    buy: (...args: Parameters<typeof actual.buy>) => {
      const after = actual.buy(...args);
      const [, before, account, id, ...rest] = args;
      recorder.log?.push({ before, account, id, rest, after });
      return after;
    },
  };
});

const UNLIMITED: Wallet = { shards: num(Infinity), cores: Infinity, resonance: Infinity };
const EMPTY: Wallet = { shards: ZERO, cores: 0, resonance: 0 };

const content = fixtureContent();
/** Every fixture character with a center in every scope that holds it: the fuzz's webs. */
const WEBS: readonly AssembledWeb[] = CHARACTER_IDS.flatMap((c) =>
  content.characters[c].center === null
    ? []
    : SCOPES.filter((scope) => scopeHolds(scope.characters, c)).map((scope) =>
        assembleWeb(content, c, scope),
      ),
);

/** A draw and the purchases it made through buy. */
function sampled(
  web: AssembledWeb,
  seed: number,
  options: SampleOptions,
): { readonly progress: CharacterProgress; readonly purchases: readonly Purchase[] } {
  const purchases: Purchase[] = [];
  recorder.log = purchases;
  try {
    return { progress: sampleProgress(web, createRng(seed), options), purchases };
  } finally {
    recorder.log = null;
  }
}

/** Where every draw starts: nothing owned, the options' best wave and prestige, no price limit. */
const startOf = (web: AssembledWeb, options: SampleOptions): CharacterProgress => ({
  ...emptyProgress(web.character),
  wallet: UNLIMITED,
  bestWave: options.bestWave,
  prestiges: options.prestiged ? 1 : 0,
});

/**
 * What is wrong with a draw's purchases, as text: each purchase must be one canBuy accepts on the
 * progress the one before it returned, the first on the empty start, with the draw's account, the
 * default economy and no challenge, and the draw must return the last purchase's progress with an
 * empty wallet. Plain checks, not expect, as they run some 40,000 times.
 */
function faults(
  web: AssembledWeb,
  options: SampleOptions,
  progress: CharacterProgress,
  purchases: readonly Purchase[],
): string[] {
  const found: string[] = [];
  let last: CharacterProgress | null = null;
  for (const [n, purchase] of purchases.entries()) {
    const at = `purchase ${n + 1} '${purchase.id}'`;
    if (last !== null && purchase.before !== last) found.push(`${at}: not on the last progress`);
    if (purchase.account !== options.account) found.push(`${at}: another account`);
    if (purchase.rest.some((arg) => arg !== undefined))
      found.push(`${at}: an economy or challenge`);
    const check = canBuy(web, purchase.before, options.account, purchase.id);
    if (!check.ok) found.push(`${at}: refused, ${check.reason}`);
    last = purchase.after;
  }
  const first = purchases[0]?.before;
  if (first !== undefined) expect(first).toEqual(startOf(web, options));
  expect(progress).toEqual({ ...(last ?? startOf(web, options)), wallet: EMPTY });
  return found;
}

describe('sampleProgress (D25, AMB18)', () => {
  it('draws 1,000 legal builds: each purchase one canBuy accepts, in order, from empty', () => {
    expect(WEBS.map((web) => `${web.character}.${web.scope.name}`)).toEqual([
      'fire.full',
      'fire.demoA',
      'fire.demoB',
      'ice.full',
      'ice.demoB',
      'lightning.full',
      'summon.full',
      'summon.demoA',
    ]);
    const found: string[] = [];
    let made = 0;
    let fused = 0;
    let keystonePairs = 0;
    let ascendancies = 0;
    for (let i = 0; i < 1000; i++) {
      const web = WEBS[i % WEBS.length] as AssembledWeb;
      const pick = createRng(deriveSeed(31, `sampleTest:${i}`));
      const options: SampleOptions = {
        // Most draws stay shallow to keep the test short; every tenth goes deeper, to the fusion
        // cores, the ★ cap and the ascendancy chains.
        purchases: i % 10 === 0 ? 60 + pick.int(41) : pick.int(41),
        account: { singularityBeaten: pick.chance(0.5) },
        bestWave: pick.pick([0, 1, 15, 30, 60]),
        prestiged: pick.chance(0.5),
      };
      const { progress, purchases } = sampled(web, deriveSeed(31, `sample:${i}`), options);
      found.push(...faults(web, options, progress, purchases).map((text) => `draw ${i}: ${text}`));
      const ranks = Object.values(progress.ranks).reduce((sum, rank) => sum + rank, 0);
      expect(ranks).toBe(purchases.length);
      if (purchases.length < options.purchases) {
        // Stopped early: canBuy accepts nothing on what it left.
        const open = web.nodes.filter((node) => canBuy(web, progress, options.account, node.id).ok);
        expect(open.map((node) => node.id)).toEqual([]);
      } else expect(purchases).toHaveLength(options.purchases);
      made += purchases.length;
      const counts = boardCounts(web, progress);
      if (counts.cores > 0) fused += 1;
      if (counts.keystones === 2) keystonePairs += 1;
      if (progress.ascendancy !== null) ascendancies += 1;
    }
    expect(found).toEqual([]);
    expect(made).toBeGreaterThan(20_000);
    // The draws reach a fusion core, the ★ cap and an ascendancy.
    expect(fused).toBeGreaterThan(0);
    expect(keystonePairs).toBeGreaterThan(0);
    expect(ascendancies).toBeGreaterThan(0);
  }, 30_000);

  it('draws the first purchase uniformly among the nodes canBuy accepts', () => {
    const web = WEBS[0] as AssembledWeb;
    const options: SampleOptions = {
      purchases: 1,
      account: { singularityBeaten: false },
      bestWave: 30,
      prestiged: false,
    };
    const start = startOf(web, options);
    const accepted = web.nodes
      .filter((node) => canBuy(web, start, options.account, node.id).ok)
      .map((node) => node.id);
    expect(accepted.length).toBeGreaterThan(1);
    const seen = new Map<string, number>();
    for (let i = 0; i < 400 * accepted.length; i++) {
      const { purchases } = sampled(web, deriveSeed(32, `first:${i}`), options);
      expect(purchases).toHaveLength(1);
      const id = purchases[0]?.id as string;
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual([...accepted].sort());
    for (const [id, count] of seen) {
      expect(count / 400, id).toBeGreaterThan(0.8);
      expect(count / 400, id).toBeLessThan(1.2);
    }
  });

  it("draws a later purchase uniformly among the nodes canBuy accepts, an owned node's next rank included", () => {
    // The draws whose first purchase is one ranked node next to the root: their second is uniform
    // among the nodes canBuy accepts after it, which hold that node's second rank.
    const web = WEBS[0] as AssembledWeb;
    const options: SampleOptions = {
      purchases: 2,
      account: { singularityBeaten: false },
      bestWave: 30,
      prestiged: false,
    };
    const first = web.neighbours.get(web.root)?.[0] as string;
    expect(web.byId.get(first)?.ranks).toBe(3);
    let accepted: string[] | null = null;
    const seen = new Map<string, number>();
    let kept = 0;
    for (let i = 0; accepted === null || kept < 400 * accepted.length; i++) {
      const { purchases } = sampled(web, deriveSeed(33, `second:${i}`), options);
      const [bought, next] = purchases as [Purchase, Purchase];
      if (bought.id !== first) continue;
      accepted ??= web.nodes
        .filter((node) => canBuy(web, bought.after, options.account, node.id).ok)
        .map((node) => node.id);
      kept += 1;
      seen.set(next.id, (seen.get(next.id) ?? 0) + 1);
    }
    expect(accepted).toContain(first);
    expect([...seen.keys()].sort()).toEqual([...accepted].sort());
    for (const [id, count] of seen) {
      expect(count / 400, id).toBeGreaterThan(0.8);
      expect(count / 400, id).toBeLessThan(1.2);
    }
  });

  it('stops when canBuy accepts nothing, and buys nothing for no purchases', () => {
    // fire.full cut down to two ◆ next to the root: two purchases, then nothing is open.
    const web = WEBS[0] as AssembledWeb;
    const notables = web.nodes.filter(
      (node) => node.kind === 'notable' && node.board === 'fire.center',
    );
    const [a, b] = notables.map((node) => node.id) as [string, string];
    const cut: AssembledWeb = {
      ...web,
      neighbours: new Map([
        [web.root, [a, b]],
        [a, [web.root]],
        [b, [web.root]],
      ]),
    };
    const options: SampleOptions = {
      purchases: 10,
      account: { singularityBeaten: false },
      bestWave: 30,
      prestiged: false,
    };
    const { progress, purchases } = sampled(cut, 9, options);
    expect(purchases.map((purchase) => purchase.id).sort()).toEqual([a, b].sort());
    expect(progress.ranks).toEqual({ [a]: 1, [b]: 1 });
    expect(faults(cut, options, progress, purchases)).toEqual([]);
    const none = sampled(web, 5, { ...options, purchases: 0, bestWave: 15, prestiged: true });
    expect(none.purchases).toEqual([]);
    expect(none.progress).toEqual({ ...emptyProgress('fire'), bestWave: 15, prestiges: 1 });
  });

  it('keeps the chain of the first ascendancy node a prestiged draw buys, and only it', () => {
    const web = WEBS[0] as AssembledWeb;
    const options: SampleOptions = {
      purchases: 150,
      account: { singularityBeaten: false },
      bestWave: 30,
      prestiged: true,
    };
    const chains = new Set<string>();
    for (let seed = 0; seed < 40 && chains.size < 2; seed++) {
      const { progress, purchases } = sampled(web, seed, options);
      const bought = purchases
        .map((purchase) => web.byId.get(purchase.id))
        .map((node) => (node === undefined ? null : chainOfBoard(node.board)))
        .filter((chain) => chain !== null);
      if (bought.length === 0) continue;
      expect(new Set(bought)).toEqual(new Set([bought[0]]));
      expect(progress.ascendancy).toBe(bought[0]);
      chains.add(bought[0] as string);
    }
    // Either chain can be the one: the first ascendancy node is a uniform draw like any other.
    expect(chains.size).toBe(2);
  });

  it('opens the third fusion slot only to a draw whose account has beaten the singularity', () => {
    // 600 purchases take fire.full far past every fusion's gate, so the cores bought stop at the
    // slots canBuy allows: three with singularityBeaten (§4.9's quarter of the draws), two without.
    const web = WEBS[0] as AssembledWeb;
    const cores = (singularityBeaten: boolean): number => {
      const options: SampleOptions = {
        purchases: 600,
        account: { singularityBeaten },
        bestWave: 30,
        prestiged: false,
      };
      const { progress, purchases } = sampled(web, 34, options);
      expect(faults(web, options, progress, purchases)).toEqual([]);
      return boardCounts(web, progress).cores;
    };
    expect(cores(true)).toBe(3);
    expect(cores(false)).toBe(2);
  });

  it('reads every draw from the rng it is given', () => {
    const random = vi.spyOn(Math, 'random');
    const options: SampleOptions = {
      purchases: 120,
      account: { singularityBeaten: true },
      bestWave: 30,
      prestiged: true,
    };
    const web = assembleWeb(content, 'summon', FULL_SCOPE);
    const ids = (seed: number): string[] =>
      sampled(web, seed, options).purchases.map((purchase) => purchase.id);
    expect(ids(77)).toEqual(ids(77));
    expect(ids(78)).not.toEqual(ids(77));
    expect(sampled(web, 77, options).progress).toEqual(sampled(web, 77, options).progress);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});
