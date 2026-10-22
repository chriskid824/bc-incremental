import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import { assembleWeb } from '../../data/web/assemble';
import { FULL_SCOPE } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import { GATED_KINDS } from './counts';
import { unlockInvestment } from './invest';
import { buyPath, planPath } from './path';
import { DEFAULT_WEB_ECONOMY } from './price';
import { buy, canBuy, CHALLENGE_RULES, emptyProgress } from './rules';
import type { AccountProgress, CharacterProgress, Wallet } from './types';

const fire = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);
const account: AccountProgress = { singularityBeaten: false };
const RICH: Wallet = { shards: num(1e12), cores: 1000, resonance: 1000 };

const start = (extra: Partial<CharacterProgress> = {}): CharacterProgress => ({
  ...emptyProgress('fire'),
  wallet: RICH,
  bestWave: 30,
  prestiges: 1,
  ...extra,
});
const bought = (ids: readonly string[], from = start()): CharacterProgress =>
  ids.reduce((progress, id) => buy(fire, progress, account, id), from);
const relative = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);
const steps = (k: number): number => (180 * (1.31 ** k - 1)) / 0.31;

const C = 'fire.center';
const ROUTE_C1 = [
  `${C}.alpha.r1`,
  `${C}.alpha.r2`,
  `${C}.alpha.alpha-one`,
  `${C}.alpha.r3`,
  `${C}.main.c1`,
];

describe('planPath (gd:807)', () => {
  it('takes the shortest route, ties in web order, with its summed price', () => {
    // Via c1 and hub.defense.r1, not the route of the same length via c6 and hub.echo.r4.
    const plan = planPath(fire, start(), account, 'hub.might.might');
    expect(plan).toMatchObject({
      ok: true,
      ids: [...ROUTE_C1, 'hub.defense.r1', 'hub.might.might'],
      price: { cores: 1, resonance: 0 },
    });
    if (!plan.ok) return;
    expect(relative(toNumber(plan.price.shards), steps(6) + 300)).toBeLessThan(1e-12);
  });

  it('never passes through a threshold, core, ★ or ascendancy node', () => {
    // Beside star-one and the threshold, the route goes round by the hub.
    expect(planPath(fire, bought(ROUTE_C1), account, `${C}.main.c2`)).toMatchObject({
      ok: true,
      ids: ['hub.defense.r1', 'hub.defense.r2', 'hub.defense.r3', `${C}.main.c2`],
    });
    const c3 = bought([
      `${C}.beta.r1`,
      `${C}.beta.r2`,
      `${C}.beta.beta-one`,
      `${C}.beta.r3`,
      `${C}.main.c3`,
    ]);
    expect(planPath(fire, c3, account, `${C}.main.c4`)).toMatchObject({
      ok: true,
      ids: ['hub.economy.r1', 'hub.economy.r2', 'hub.economy.r3', `${C}.main.c4`],
    });
    // Behind a core or an ascendancy node: no route, so the target's own check answers.
    const might = bought([...ROUTE_C1, 'hub.defense.r1', 'hub.might.might']);
    expect(planPath(fire, might, account, 'fusion.fire.poison.r1')).toEqual({
      ok: false,
      at: 'fusion.fire.poison.r1',
      reason: 'notAdjacent',
    });
    expect(planPath(fire, might, account, 'fire.asc.path-one.final')).toEqual({
      ok: false,
      at: 'fire.asc.path-one.final',
      reason: 'notAdjacent',
    });
  });

  it('breaks a tie by web order at each step back from the target', () => {
    // star-two sits between c5 and c6, each five steps out: c5 comes first in web order.
    expect(planPath(fire, start(), account, `${C}.main.star-two`)).toMatchObject({
      ok: true,
      ids: [
        `${C}.gamma.r1`,
        `${C}.gamma.r2`,
        `${C}.gamma.gamma-one`,
        `${C}.gamma.r3`,
        `${C}.main.c5`,
        `${C}.main.star-two`,
      ],
    });
    // hub.defense.r4 sits between hub.defense.r3 and hub.economy.r1: the defense ring comes first.
    expect(planPath(fire, start(), account, 'hub.defense.r4')).toMatchObject({
      ok: true,
      ids: [
        `${C}.beta.r1`,
        `${C}.beta.r2`,
        `${C}.beta.beta-one`,
        `${C}.beta.r5`,
        `${C}.main.c2`,
        'hub.defense.r3',
        'hub.defense.r4',
      ],
    });
  });

  it('starts from every owned node, a gated one included', () => {
    // An owned core leads on to its fusion's nodes; an owned threshold to c4.
    const invested = { ...unlockInvestment(fire, account, 'poison'), wallet: RICH };
    const fused = buy(fire, invested, account, 'fusion.fire.poison.core');
    expect(planPath(fire, fused, account, 'fusion.fire.poison.r2')).toMatchObject({
      ok: true,
      ids: ['fusion.fire.poison.r1', 'fusion.fire.poison.r2'],
    });
    const gated = bought([
      `${C}.beta.r1`,
      `${C}.beta.r2`,
      `${C}.beta.beta-one`,
      `${C}.beta.r3`,
      `${C}.main.c3`,
      ...ROUTE_C1,
      `${C}.alpha.r4`,
      `${C}.gamma.r1`,
      `${C}.main.threshold`,
    ]);
    expect(planPath(fire, gated, account, `${C}.main.c4`)).toMatchObject({
      ok: true,
      ids: [`${C}.main.c4`],
    });
  });

  it('passes no gated kind on any route but at its target', () => {
    let planned = 0;
    for (const node of fire.nodes) {
      const plan = planPath(fire, start(), account, node.id);
      if (!plan.ok) continue;
      planned += 1;
      const kinds = plan.ids.slice(0, -1).map((id) => fire.byId.get(id)?.kind);
      expect(
        kinds.filter((kind) => kind !== undefined && GATED_KINDS.has(kind)),
        node.id,
      ).toEqual([]);
      expect(plan.ids.at(-1)).toBe(node.id);
    }
    // Every node but those behind a gate (fusion nodes past their core, ascendancy n2 and finals)
    // and the gates themselves while unmet.
    expect(planned).toBeGreaterThan(200);
  });

  it('ends at a gated target', () => {
    const plan = planPath(fire, start(), account, `${C}.main.star-one`);
    expect(plan).toMatchObject({
      ok: true,
      ids: [...ROUTE_C1, `${C}.main.star-one`],
      price: { cores: 4 },
    });
    expect(planPath(fire, start(), account, 'fire.asc.path-one.n1')).toMatchObject({
      ok: true,
      ids: [...ROUTE_C1, 'hub.defense.r1', 'hub.might.might', 'fire.asc.path-one.n1'],
      price: { resonance: 1 },
    });
  });

  it('buys ranked nodes one rank each, and an owned target one rank more', () => {
    const after = buyPath(fire, start(), account, 'hub.might.might');
    expect(Object.values(after.ranks)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(planPath(fire, after, account, `${C}.alpha.r1`)).toMatchObject({
      ok: true,
      ids: [`${C}.alpha.r1`],
    });
    expect(buyPath(fire, after, account, `${C}.alpha.r1`).ranks[`${C}.alpha.r1`]).toBe(2);
  });

  it('returns the first failing step and its reason', () => {
    // A wallet for three steps: the fourth fails.
    const three = start({
      wallet: { shards: num(180 + 180 * 1.31 + 180 * 1.31 ** 2 + 50), cores: 1, resonance: 0 },
    });
    expect(planPath(fire, three, account, 'hub.might.might')).toEqual({
      ok: false,
      at: `${C}.alpha.r3`,
      reason: 'notEnoughShards',
    });
    expect(planPath(fire, start({ bestWave: 0 }), account, 'outer.poison.alpha.r1')).toEqual({
      ok: false,
      at: 'outer.poison.main.entry',
      reason: 'hidden',
    });
    expect(planPath(fire, start(), account, `${C}.main.threshold`)).toEqual({
      ok: false,
      at: `${C}.main.threshold`,
      reason: 'centerGate',
    });
    expect(planPath(fire, start(), account, 'nope')).toEqual({
      ok: false,
      at: 'nope',
      reason: 'unknown',
    });
  });

  it('passes the economy and the challenge to every check', () => {
    const cheap = { ...DEFAULT_WEB_ECONOMY, step: { base: 1, growth: 2 } };
    expect(planPath(fire, start(), account, `${C}.alpha.r2`, cheap)).toMatchObject({
      ok: true,
      price: { shards: 3 },
    });
    expect(
      planPath(fire, start(), account, `${C}.main.star-one`, undefined, CHALLENGE_RULES),
    ).toEqual({
      ok: false,
      at: `${C}.main.star-one`,
      reason: 'challengeKeystone',
    });
  });
});

describe('buyPath', () => {
  it('equals buying the plan', () => {
    const from = bought([`${C}.beta.r1`]);
    for (const target of [
      'hub.might.might',
      'outer.poison.alpha.alpha-one',
      `${C}.main.star-two`,
    ]) {
      const plan = planPath(fire, from, account, target);
      expect(plan.ok, target).toBe(true);
      if (!plan.ok) continue;
      const one = plan.ids.reduce((progress, id) => {
        expect(canBuy(fire, progress, account, id).ok).toBe(true);
        return buy(fire, progress, account, id);
      }, from);
      expect(buyPath(fire, from, account, target)).toEqual(one);
    }
  });

  it('throws as buy does when the plan fails', () => {
    expect(() => buyPath(fire, start({ bestWave: 0 }), account, 'outer.poison.alpha.r1')).toThrow(
      "buyPath 'outer.poison.alpha.r1' (character 'fire', scope 'full'): hidden at 'outer.poison.main.entry'",
    );
  });
});
