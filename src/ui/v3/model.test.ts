import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import { assembleWeb, FULL_SCOPE, layoutWeb, loadContent } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import { buy, canBuy, emptyProgress, planPath, unlockInvestment } from '../../meta/web';
import type { AccountProgress, CharacterProgress } from '../../meta/web';
import { fixtureLookups } from '../web/testing';
import {
  nodeState,
  nodeTip,
  outerStates,
  planClick,
  priceText,
  refusalText,
  slotBar,
  spokeText,
  webModel,
} from './model';

const web = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);
const layout = layoutWeb(web);
const account: AccountProgress = { singularityBeaten: false };
const lookups = fixtureLookups();
const en = lookups.en;
const zh = lookups['zh-TW'];
const RICH = { shards: num(1e15), cores: 1000, resonance: 0 };

const start = (bestWave = 0): CharacterProgress => ({
  ...emptyProgress('fire'),
  wallet: RICH,
  bestWave,
});
/** The fusion gate of fire.crit met (center 8, crit 6), the core not bought. */
const critGate = (): CharacterProgress => ({
  ...unlockInvestment(web, account, 'crit'),
  wallet: RICH,
});
const CRIT_CORE = 'fusion.fire.crit.core';

describe('nodeState', () => {
  it('reads owned, maxed, buyable, blocked and far off the rank and canBuy', () => {
    const price = { shards: num(1), cores: 0, resonance: 0 };
    expect(nodeState(1, { ok: true, price })).toBe('owned');
    expect(nodeState(3, { ok: false, reason: 'maxRank', gate: null })).toBe('maxed');
    expect(nodeState(1, { ok: false, reason: 'owned', gate: null })).toBe('maxed');
    expect(nodeState(2, { ok: false, reason: 'notEnoughShards', gate: null })).toBe('owned');
    expect(nodeState(0, { ok: true, price })).toBe('buyable');
    expect(nodeState(0, { ok: false, reason: 'fusionGate', gate: null })).toBe('blocked');
    expect(nodeState(0, { ok: false, reason: 'notEnoughShards', gate: null })).toBe('blocked');
    expect(nodeState(0, { ok: false, reason: 'notAdjacent', gate: null })).toBe('far');
  });
});

describe('outerStates (gd §2.4)', () => {
  it('reveals the 3 recommended outers first, collapsed, the rest 「？」', () => {
    const states = outerStates(web, start(0), new Set());
    expect(states.has('fire')).toBe(false);
    expect([...states].filter(([, s]) => s === 'collapsed').map(([o]) => o)).toEqual([
      'crit',
      'ice',
      'summon',
    ]);
    expect([...states.values()].filter((s) => s === 'hidden')).toHaveLength(8);
  });

  it('reveals revealAt15 at wave 15 and all 11 at wave 30', () => {
    const at15 = outerStates(web, start(15), new Set());
    expect(at15.get('poison')).toBe('collapsed');
    expect(at15.get('greed')).toBe('hidden');
    const at30 = outerStates(web, start(30), new Set());
    expect([...at30.values()].every((s) => s === 'collapsed')).toBe(true);
  });

  it('opens an outer that holds a node or that a click expanded', () => {
    expect(outerStates(web, start(0), new Set(['crit'])).get('crit')).toBe('open');
    expect(outerStates(web, critGate(), new Set()).get('crit')).toBe('open');
    // Expanding a hidden outer does not reveal it.
    expect(outerStates(web, start(0), new Set(['greed'])).get('greed')).toBe('hidden');
  });

  it('marks the outers the registered content has not written as absent', () => {
    const fire = assembleWeb(loadContent(), 'fire', FULL_SCOPE);
    const states = outerStates(fire, start(15), new Set());
    expect(states.get('crit')).toBe('collapsed');
    expect(states.get('poison')).toBe('collapsed');
    expect(states.get('ice')).toBe('absent');
    expect(states.get('greed')).toBe('hidden');
  });
});

describe('webModel', () => {
  it('draws the root owned, its neighbours buyable, the rest far', () => {
    const model = webModel(web, layout, start(0), account);
    const byId = new Map(model.nodes.map((node) => [node.id, node]));
    expect(byId.get(web.root)).toMatchObject({ rank: 1, state: 'maxed' });
    for (const id of web.neighbours.get(web.root) ?? []) {
      expect(byId.get(id)?.state, id).toBe('buyable');
    }
    expect(byId.get('fire.center.alpha.r2')?.state).toBe('far');
  });

  it('hides the nodes of hidden and collapsed outers, keeps a collapsed outer’s fusion', () => {
    const model = webModel(web, layout, start(0), account);
    const ids = new Set(model.nodes.map((node) => node.id));
    expect([...ids].some((id) => id.startsWith('outer.'))).toBe(false);
    expect(ids.has(CRIT_CORE)).toBe(true);
    expect(ids.has('fusion.fire.poison.core')).toBe(false);
    // The hub's edge into crit's entry ends at its collapsed circle.
    const circle = layout.boards['outer.crit']?.collapsed;
    expect(model.edges.some((e) => e.to.x === circle?.x && e.to.y === circle?.y)).toBe(true);
    const crit = model.outers.find((o) => o.outer === 'crit');
    expect(crit).toMatchObject({ state: 'collapsed', invested: 0 });
    expect(model.outers.find((o) => o.outer === 'greed')).toMatchObject({
      state: 'hidden',
      icon: null,
      answers: [],
    });
  });

  it('draws an expanded outer’s nodes, and spokes only for revealed outers', () => {
    const model = webModel(web, layout, start(0), account, new Set(['crit']));
    expect(model.nodes.some((node) => node.board === 'outer.crit')).toBe(true);
    expect(model.spokes.map((spoke) => spoke.outer).sort()).toEqual(['crit', 'ice', 'summon']);
    expect(model.branches.some((b) => b.key === 'web.branch.fire.center.alpha')).toBe(true);
  });

  it('lights the edges between owned nodes', () => {
    const first = (web.neighbours.get(web.root) ?? [])[0] as string;
    const progress = buy(web, start(0), account, first);
    const model = webModel(web, layout, progress, account);
    const edge = model.edges.find(
      (e) => (e.a === web.root && e.b === first) || (e.b === web.root && e.a === first),
    );
    expect(edge?.lit).toBe(true);
    expect(model.edges.some((e) => e.open)).toBe(true);
  });
});

describe('planClick and the path preview (gd §8 item 5)', () => {
  it('buys a node next to an owned one at canBuy’s price', () => {
    const id = (web.neighbours.get(web.root) ?? [])[0] as string;
    const plan = planClick(web, start(0), account, id);
    const check = canBuy(web, start(0), account, id);
    expect(plan.kind).toBe('buy');
    if (plan.kind === 'buy' && check.ok) expect(plan.price).toEqual(check.price);
  });

  it('plans the shortest path to a far node with its total price', () => {
    const target = 'fire.center.alpha.alpha-one';
    const plan = planClick(web, start(0), account, target);
    const path = planPath(web, start(0), account, target);
    expect(plan.kind).toBe('path');
    if (plan.kind !== 'path' || !path.ok) return;
    expect(plan.ids).toEqual(path.ids);
    expect(plan.ids[plan.ids.length - 1]).toBe(target);
    expect(plan.price).toEqual(path.price);
    expect(plan.ids.length).toBeGreaterThan(1);
  });

  it('refuses a fusion core below its gate, with the gate’s counts in the text', () => {
    const plan = planClick(web, start(0), account, CRIT_CORE);
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') return;
    expect(plan.reason).toBe('fusionGate');
    // The counts as the planned path meets the core: the center nodes on the way count.
    expect(refusalText(plan, zh)).toMatch(/^融合解鎖：中心 [1-7]\/8・外盤 0\/6$/);
  });

  it('names the step a path stops at when the wallet runs out on the way', () => {
    const poor = { ...start(0), wallet: { shards: num(200), cores: 0, resonance: 0 } };
    const plan = planClick(web, poor, account, 'fire.center.alpha.alpha-one');
    expect(plan).toMatchObject({ kind: 'refused', reason: 'notEnoughShards' });
    if (plan.kind === 'refused') expect(plan.at).not.toBe(plan.id);
  });
});

describe('priceText', () => {
  it('writes shards and cores, or 免費', () => {
    expect(priceText({ shards: num(1500), cores: 1, resonance: 0 }, en)).toBe(
      '1.50K shards + 1 cores',
    );
    expect(priceText({ shards: num(180), cores: 0, resonance: 0 }, zh)).toBe('180 碎片');
    expect(priceText({ shards: num(0), cores: 0, resonance: 0 }, zh)).toBe('免費');
    expect(priceText({ shards: num(0), cores: 0, resonance: 1 }, en)).toBe('1 resonance');
  });
});

describe('nodeTip (gd §8 item 1)', () => {
  it('gives a buyable node’s name, text, price and action', () => {
    const id = (web.neighbours.get(web.root) ?? [])[0] as string;
    const tip = nodeTip(web, start(0), account, id, zh);
    expect(tip.name).not.toBe('');
    expect(tip.lines.length).toBeGreaterThan(0);
    expect(tip.price).toMatch(/^價格：/);
    expect(tip.action).toBe('點一下購買');
    expect(tip.refund).toBeNull();
  });

  it('gives an owned ranked node its rank and a refund line', () => {
    const id = 'fire.center.alpha.r1';
    const progress = buy(web, start(0), account, id);
    const tip = nodeTip(web, progress, account, id, en);
    expect(tip.rank).toMatch(/^Rank 1\/\d$/);
    expect(tip.action).toBe('Click to buy the next rank');
    expect(tip.refund).toMatch(/^Right-click to refund /);
  });

  it('offers the path for a far node', () => {
    const tip = nodeTip(web, start(0), account, 'fire.center.alpha.alpha-one', en);
    expect(tip.price).toBeNull();
    expect(tip.action).toMatch(/^Not connected yet: click to plan the path, \d+ nodes for /);
  });

  it('says why a gated node cannot be bought', () => {
    const tip = nodeTip(web, start(0), account, CRIT_CORE, en);
    expect(tip.action).toBe(refusalText(planClick(web, start(0), account, CRIT_CORE) as never, en));
  });
});

describe('slotBar (gd §2.3, §8 item 11)', () => {
  it('shows 2 empty fusion slots, 3 after 奇點, and 2 keystone slots', () => {
    const bar = slotBar(web, start(0), account, en);
    expect(bar.fusions).toHaveLength(2);
    expect(bar.keystones).toHaveLength(2);
    expect(bar.fusions.every((slot) => slot.id === null && slot.refund === null)).toBe(true);
    expect(slotBar(web, start(0), { singularityBeaten: true }, en).fusions).toHaveLength(3);
  });

  it('fills a slot with an owned core, whose click refunds it and its branch', () => {
    const gate = critGate();
    const withCore = buy(web, gate, account, CRIT_CORE);
    const withRank = buy(web, withCore, account, 'fusion.fire.crit.r1');
    const bar = slotBar(web, withRank, account, zh);
    const slot = bar.fusions[0];
    expect(slot?.id).toBe(CRIT_CORE);
    expect(slot?.name).toMatch(/「.+」$/);
    expect(slot?.refund?.dropped).toEqual([CRIT_CORE, 'fusion.fire.crit.r1']);
    expect(toNumber(slot?.refund?.refund.shards ?? num(0))).toBeGreaterThan(0);
    expect(bar.fusions[1]?.id).toBeNull();
  });
});

describe('spokeText (gd §2.3)', () => {
  it('writes 「中心 8/8・暴擊 6/6」, and the fusion’s name once its core is owned', () => {
    const gate = critGate();
    const model = webModel(web, layout, gate, account);
    const spoke = model.spokes.find((s) => s.outer === 'crit');
    expect(spoke?.gate.unlocked).toBe(true);
    if (spoke === undefined) return;
    expect(spokeText(web, spoke, zh)).toBe(
      `中心 ${spoke.gate.center}/8・暴擊 ${spoke.gate.outer}/6`,
    );
    const owned = webModel(web, layout, buy(web, gate, account, CRIT_CORE), account);
    const done = owned.spokes.find((s) => s.outer === 'crit');
    expect(done?.owned).toBe(true);
    if (done !== undefined) expect(spokeText(web, done, en)).toBe('Fire Crit');
  });
});
