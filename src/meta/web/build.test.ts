import { describe, expect, it } from 'vitest';
import { num, ZERO } from '../../core/num';
import { loadGameData } from '../../data';
import type { RuleSpec } from '../../data/rules';
import type { CharacterId, OuterId } from '../../data/sources';
import { NO_EXTRAS } from '../../data/stats';
import type { Modifier } from '../../data/stats';
import { TAG } from '../../data/tags';
import { ENEMY_IDS } from '../../data/types';
import { assembleWeb } from '../../data/web/assemble';
import { FULL_SCOPE } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import type { AssembledWeb, NodeEffects, WebNode } from '../../data/web/types';
import { applyPoison } from '../../sim/ailments/apply';
import { statAt } from '../../sim/build/eval';
import type { EvalInput } from '../../sim/build/eval';
import { modTableFor, SCOPED_INDEX } from '../../sim/build/modTable';
import { CENTER, rowKey } from '../../sim/build/sources';
import { createSimulation } from '../../sim/simulation';
import type { Enemy } from '../../sim/systems/context';
import { PANDEMIC_TRIGGER, placedEnemies } from '../../sim/testing';
import { COUNTER_IDS, NO_INPUT } from '../../sim/types';
import type { RunResult } from '../../sim/types';
import { settleRun } from '../settle';
import { computeStatBlock } from '../stats';
import { fixtureData } from '../testing';
import { settleWebRun, webBuild, webRunConfig, webStartWave } from './build';
import { unlockInvestment } from './invest';
import { DEFAULT_WEB_ECONOMY } from './price';
import { buy, emptyProgress } from './rules';
import type { CharacterProgress } from './types';

const content = fixtureContent();
/** fire's web with two coefs off 1, so coef shows where it goes. */
const fire = assembleWeb(content, 'fire', FULL_SCOPE, {
  coefs: { 'fire.poison': 0.5, 'fire.ice': 0.75 },
});
const account = { singularityBeaten: false };

const owning = (ranks: Readonly<Record<string, number>>): CharacterProgress => ({
  ...emptyProgress('fire'),
  ranks,
});

/** `web` with `id`'s effects replaced by `effects`. */
function withEffects(web: AssembledWeb, id: string, effects: Partial<NodeEffects>): AssembledWeb {
  const node = web.byId.get(id) as WebNode;
  const changed: WebNode = { ...node, effects: { ...node.effects, ...effects } };
  const nodes = web.nodes.map((other) => (other.id === id ? changed : other));
  return { ...web, nodes, byId: new Map(nodes.map((other) => [other.id, other])) };
}

const relative = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);

const R1 = 'fire.center.alpha.r1';
const ETERNAL_FLAME: RuleSpec = { id: 'eternalFlame', durationMore: -0.5 };
/** fire.ice's rule, which the ice archetype lends its hand cores (F26). */
const STEADY_AIM = (fire.byId.get('fusion.fire.ice.core') as WebNode).effects.rules[0] as RuleSpec;

describe('webBuild (§5.1)', () => {
  it('sets coef only on fusion boards’ triggers and rules', () => {
    let web = withEffects(fire, R1, { triggers: [PANDEMIC_TRIGGER], rules: [ETERNAL_FLAME] });
    web = withEffects(web, 'outer.poison.main.entry', { triggers: [PANDEMIC_TRIGGER] });
    const progress = owning({
      [R1]: 1,
      'outer.poison.main.entry': 1,
      'fusion.fire.poison.core': 1,
      'fusion.fire.ice.core': 1,
    });
    const run = webBuild(web, progress);
    const poisonCore = fire.byId.get('fusion.fire.poison.core') as WebNode;
    expect(poisonCore.effects.triggers).toHaveLength(2);
    expect(run.stats.triggers).toEqual([
      { source: 'center', spec: PANDEMIC_TRIGGER },
      { source: 'outer.poison', spec: PANDEMIC_TRIGGER },
      ...poisonCore.effects.triggers.map((spec) => ({
        source: 'fusion.fire.poison',
        spec,
        coef: 0.5,
      })),
    ]);
    expect(run.stats.triggers.slice(0, 2).every((trigger) => !('coef' in trigger))).toBe(true);
    expect(run.character).toEqual({
      id: 'fire',
      rules: [
        { source: 'center', spec: ETERNAL_FLAME, coef: 1 },
        { source: 'fusion.fire.ice', spec: STEADY_AIM, coef: 0.75 },
      ],
    });
  });

  it('puts a rule in once whatever its node’s rank, with its board’s source', () => {
    let web = withEffects(fire, R1, { rules: [ETERNAL_FLAME] });
    web = withEffects(web, 'hub.defense.r1', { rules: [STEADY_AIM] });
    const run = webBuild(web, owning({ [R1]: 3, 'hub.defense.r1': 2 }));
    expect(run.character.rules).toEqual([
      { source: 'center', spec: ETERNAL_FLAME, coef: 1 },
      { source: 'hub', spec: STEADY_AIM, coef: 1 },
    ]);
  });

  it('gives a rank-3 conditional node one entry per modifier and the damage of three copies (P4)', () => {
    const poisoned: Modifier[] = [
      { stat: 'damage', kind: 'increased', value: 0.1, when: [{ targetHas: 'poison' }] },
      { stat: 'damage', kind: 'more', value: 0.2, when: [{ targetHas: 'poison' }] },
      { stat: 'critChance', kind: 'flat', value: 0.05, when: [{ targetHas: 'poison' }] },
    ];
    const web = withEffects(fire, R1, { modifiers: poisoned });
    const merged = webBuild(web, owning({ [R1]: 3 })).stats;
    const unmerged = computeStatBlock([...poisoned, ...poisoned, ...poisoned], NO_EXTRAS);
    expect(merged.scoped).toHaveLength(3);
    expect(unmerged.scoped).toHaveLength(9);
    const ctx = placedEnemies([{ x: 200, y: 0 }]);
    const enemy = ctx.enemies[0] as Enemy;
    const S = SCOPED_INDEX;
    const ev: EvalInput = {
      now: ctx.now,
      target: enemy,
      chainJump: 0,
      playerLifeFrac: 1,
      ctx: null,
    };
    const tables = [modTableFor(merged), modTableFor(unmerged)] as const;
    const row = tables.map((table) => table.row(rowKey(TAG.hit, CENTER)));
    const read = (i: 0 | 1, stat: number): number => statAt(tables[i], row[i] as number, stat, ev);
    // Without poison the conditions fail and both read the base.
    expect([read(0, S.damage), read(1, S.damage)]).toEqual([1, 1]);
    applyPoison(ctx, enemy, num(1), ctx.now + 60, 0, CENTER, 1);
    for (const stat of [S.damage, S.critChance]) {
      expect(relative(read(0, stat), read(1, stat))).toBeLessThan(1e-12);
    }
    expect(relative(read(0, S.damage), (1 + 0.3) * 1.2 ** 3)).toBeLessThan(1e-12);
  });

  it('repeats a scaled modifier per rank, its cap applying per copy (P4)', () => {
    const scaled: Modifier = {
      stat: 'critChance',
      kind: 'flat',
      value: 0.05,
      scaling: { per: 'chainJump', cap: 0.1 },
    };
    const run = webBuild(withEffects(fire, R1, { modifiers: [scaled] }), owning({ [R1]: 3 }));
    expect(run.stats.scoped).toEqual([scaled, scaled, scaled]);
    expect(run.stats.scoped[0]).toBe(scaled);
  });

  it('merges flat and increased as value × r and compounds more (F54)', () => {
    const mods: Modifier[] = [
      { stat: 'maxLife', kind: 'flat', value: 10 },
      { stat: 'attackSpeed', kind: 'increased', value: 0.1 },
      { stat: 'attackSpeed', kind: 'more', value: 0.5 },
      { stat: 'damage', kind: 'more', value: 0.5 },
    ];
    const web = withEffects(fire, R1, { modifiers: mods });
    const merged = webBuild(web, owning({ [R1]: 3 })).stats;
    const unmerged = computeStatBlock([...mods, ...mods, ...mods], NO_EXTRAS);
    expect(merged.scoped).toEqual([{ stat: 'damage', kind: 'more', value: 1.5 ** 3 - 1 }]);
    expect(merged.values.maxLife).toBe(unmerged.values.maxLife);
    expect(relative(merged.values.attackSpeed, unmerged.values.attackSpeed)).toBeLessThan(1e-12);
    expect(relative(merged.values.attackSpeed, 4 * 1.3 * 1.5 ** 3)).toBeLessThan(1e-12);
    // At rank 1 a modifier goes in as it is written.
    const one = webBuild(web, owning({ [R1]: 1 })).stats;
    expect(one.scoped[0]).toBe(mods[3]);
  });

  it('adds triggers and conversions once per rank and emitter grants once', () => {
    const web = withEffects(fire, R1, {
      triggers: [PANDEMIC_TRIGGER],
      conversions: [{ to: 'poison', fraction: 0.1 }],
      emitters: [{ kind: 'thorns' }],
    });
    const stats = webBuild(web, owning({ [R1]: 3 })).stats;
    expect(stats.triggers).toEqual(Array(3).fill({ source: 'center', spec: PANDEMIC_TRIGGER }));
    expect(stats.conversions).toEqual(
      Array(3).fill({ source: 'center', spec: { to: 'poison', fraction: 0.1 } }),
    );
    expect(stats.emitters).toEqual([{ source: 'center', grant: { kind: 'thorns' } }]);
  });

  it('skips the signature node’s effects', () => {
    const web = withEffects(fire, fire.root, {
      modifiers: [{ stat: 'maxLife', kind: 'flat', value: 10 }],
      triggers: [PANDEMIC_TRIGGER],
      emitters: [{ kind: 'thorns' }],
      rules: [ETERNAL_FLAME],
    });
    const bare = webBuild(fire, owning({}));
    expect(webBuild(web, owning({}))).toEqual(bare);
    expect(webBuild(web, owning({ [fire.root]: 1 }))).toEqual(bare);
    expect(bare.stats.values.maxLife).toBe(100);
    expect(bare.signature).toBe(fire.def.signature);
  });
});

describe('webRunConfig', () => {
  it('makes a character run: no M1 rules, the def’s signature, auto mode', () => {
    const run = webBuild(fire, owning({ [R1]: 2, 'fusion.fire.ice.core': 1 }));
    expect(webRunConfig(run, 7, 3)).toEqual({
      seed: 7,
      stats: run.stats,
      rules: [],
      signature: fire.def.signature,
      character: run.character,
      startWave: 3,
      mode: 'auto',
    });
    expect('waveCap' in webRunConfig(run, 7, 3)).toBe(false);
    expect(webRunConfig(run, 7, 3, 40).waveCap).toBe(40);
  });

  /** A template fusion and a hand fusion of each character: 固定投入, then the core. */
  const BUILDS: readonly (readonly [CharacterId, OuterId, OuterId])[] = [
    ['fire', 'poison', 'ice'],
    ['ice', 'crit', 'fire'],
    ['lightning', 'poison', 'summon'],
    ['summon', 'crit', 'lightning'],
  ];

  it.each(BUILDS)('runs %s’s builds of %s and %s for 600 ticks', (c, template, hand) => {
    const web = assembleWeb(content, c, FULL_SCOPE);
    const data = loadGameData();
    for (const outer of [template, hand]) {
      const invested = unlockInvestment(web, account, outer);
      const id = `fusion.${c}.${outer}.core`;
      const progress = buy(
        web,
        { ...invested, wallet: { shards: num(1e40), cores: 9, resonance: 0 } },
        account,
        id,
      );
      const run = webBuild(web, progress);
      expect(run.character.rules.length, outer).toBe(outer === hand ? 1 : 0);
      const sim = createSimulation(webRunConfig(run, 1, 1), data);
      for (let tick = 0; tick < 600; tick++) sim.step(NO_INPUT);
      expect(sim.state.finished, `${c}.${outer}`).toBe(false);
      expect(sim.state.tick, `${c}.${outer}`).toBe(600);
    }
  });
});

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    startWave: 5,
    highestWaveReached: 18,
    highestWaveCleared: 17,
    clearedStartWave: true,
    endReason: 'death',
    ticks: 3600,
    shards: num(50),
    cores: 2,
    kills: 30,
    damage: { hit: ZERO, crit: ZERO, burn: ZERO, chain: ZERO, poison: ZERO, bleed: ZERO },
    damageBySource: { center: ZERO },
    counters: Object.fromEntries(COUNTER_IDS.map((id) => [id, 0])) as RunResult['counters'],
    maxHit: num(10),
    overkillSeconds: 0,
    leaks: 0,
    damageTaken: 0,
    damageTakenBy: Object.fromEntries(
      ENEMY_IDS.map((id) => [id, { hits: 0, damage: 0 }]),
    ) as RunResult['damageTakenBy'],
    killedBy: null,
    ...overrides,
  };
}

describe('settleWebRun (§5.1, D21)', () => {
  const data = fixtureData();
  const stats = computeStatBlock([{ stat: 'shardGain', kind: 'increased', value: 1 }], NO_EXTRAS);
  const progress: CharacterProgress = {
    ...owning({ [R1]: 1 }),
    wallet: { shards: num(100), cores: 3, resonance: 7 },
    spent: { shards: num(180), cores: 0, resonance: 0 },
    bestWave: 20,
    cycleBest: 12,
    prestiges: 1,
    resonanceEarned: 7,
    ascendancy: 'path-one',
    runs: 5,
  };

  it.each([
    ['below the best wave', 18, 20],
    ['past the best wave', 25, 25],
  ] as const)('equals settleRun on the copied fields, a run %s', (_name, reached, best) => {
    const result = runResult({ highestWaveReached: reached });
    const frozen = Object.freeze(structuredClone(progress));
    const settled = settleWebRun(frozen, result, data, stats);
    const meta = { shards: progress.wallet.shards, cores: 3, maxWave: 12, runs: 5 };
    const settlement = settleRun(meta, result, data, stats, DEFAULT_WEB_ECONOMY);
    expect(settled).toEqual({
      progress: {
        ...progress,
        wallet: { shards: meta.shards, cores: meta.cores, resonance: 7 },
        cycleBest: reached,
        runs: 6,
        bestWave: best,
      },
      settlement,
    });
    expect(settlement.skipShards).not.toBe(ZERO);
    expect(frozen).toEqual(progress);
  });
});

describe('webStartWave', () => {
  it('reads this cycle’s best, not the all-time best (F43)', () => {
    const progress = { ...emptyProgress('fire'), bestWave: 40, cycleBest: 10 };
    expect(webStartWave(progress)).toBe(5);
    expect(webStartWave({ ...progress, cycleBest: 0 })).toBe(1);
    expect(webStartWave(progress, { ...DEFAULT_WEB_ECONOMY, startWaveRatio: 1 })).toBe(10);
  });
});
