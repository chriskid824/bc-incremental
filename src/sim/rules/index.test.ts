import { describe, expect, it } from 'vitest';
import { M1_SIGNATURE, RULE_IDS } from '../../data/rules';
import { TAG } from '../../data/tags';
import { compileBuild } from '../build/compile';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, makeTestData, stationarySquares } from '../testing';
import type { RunConfig, SimEvent } from '../types';
import { NO_INPUT } from '../types';
import { RULE_MODULES, SIGNATURES } from './index';
import type { TestModule } from './index';

/** Steps to the end of the run, keeping each tick's events. */
function runModules(config: RunConfig, data = makeTestData(), modules: TestModule[] = []) {
  const sim = createSimulation(config, data, modules);
  const ticks: SimEvent[][] = [];
  while (!sim.state.finished) ticks.push(sim.step(NO_INPUT).slice());
  return { ticks, result: sim.result() };
}

describe('RULE_MODULES', () => {
  it('has the module of every rule id, under its own id', () => {
    expect(Object.keys(RULE_MODULES).sort()).toEqual([...RULE_IDS].sort());
    for (const id of RULE_IDS) expect(RULE_MODULES[id].id).toBe(id);
  });
});

describe('SIGNATURES', () => {
  it('has the module of every signature id, under its own id', () => {
    expect(Object.keys(SIGNATURES)).toEqual(['m1Volley', 'magmaBomb', 'iceFan']);
    for (const [id, module] of Object.entries(SIGNATURES)) expect(module.id).toBe(id);
  });

  it("puts the signature's emitter first: M1's volley by default", () => {
    const volley = {
      kind: 'volley',
      signature: true,
      source: 'center',
      damagePct: 1,
      tags: TAG.hit | TAG.projectile,
      chains: true,
      rollsAilments: true,
      canCrit: true,
    };
    expect(compileBuild(makeStats(), []).emitters).toEqual([volley]);
    expect(compileBuild(makeStats(), [], M1_SIGNATURE).emitters).toEqual([volley]);
    expect(SIGNATURES.m1Volley.emitter({ id: 'm1Volley' })).toEqual(volley);
  });
});

describe('hook call sites', () => {
  it('runs tick hooks once per tick after the attacks, while the player is alive', () => {
    const calls: { tick: number; attacks: number }[] = [];
    const module: TestModule = (b) =>
      b.hook('tick', (ctx) => {
        const attacks = ctx.events.filter((event) => event.type === 'attack').length;
        calls.push({ tick: ctx.now, attacks });
      });
    // Too weak to kill anything: the enemies reach the player, who dies.
    const stats = makeStats({ damage: 1e-6, attackSpeed: 5, maxLife: 20 });
    const { ticks, result } = runModules(makeConfig({ stats, maxTicks: 3600 }), undefined, [
      module,
    ]);
    expect(result.endReason).toBe('death');
    // Every tick but the last, in which contact killed the player before the attacks.
    expect(calls.map((call) => call.tick)).toEqual(ticks.slice(0, -1).map((_, i) => i + 1));
    expect(ticks.at(-1)?.some((event) => event.type === 'attack')).toBe(false);
    // The hook sees each tick's attacks; none come after it.
    calls.forEach((call, i) => {
      const attacks = (ticks[i] ?? []).filter((event) => event.type === 'attack').length;
      expect(call.attacks, `tick ${call.tick}`).toBe(attacks);
    });
    expect(calls.filter((call) => call.attacks > 0).length).toBeGreaterThan(10);
  });

  it('runs onKill hooks at each kill with origin −1, before the victim is removed', () => {
    const seen: {
      origin: number;
      alive: boolean;
      kills: number;
      reported: boolean;
    }[] = [];
    const module: TestModule = (b) =>
      b.hook('onKill', (ctx, victim, kill) => {
        seen.push({
          origin: kill.origin,
          alive: victim.alive,
          kills: ctx.kills,
          reported: ctx.events.some(
            (event) => event.type === 'enemyKilled' && event.enemyId === victim.id,
          ),
        });
      });
    const stats = makeStats({ damage: 1e6, attackSpeed: 5, igniteChance: 0, critChance: 0 });
    const { result } = runModules(makeConfig({ stats, maxTicks: 600 }), undefined, [module]);
    expect(result.kills).toBeGreaterThan(10);
    expect(seen).toHaveLength(result.kills);
    seen.forEach((kill, i) => {
      expect(kill).toEqual({ origin: -1, alive: true, kills: i, reported: false });
    });
  });

  it('runs onKill hooks for DoT kills too', () => {
    const victims: number[] = [];
    const module: TestModule = (b) =>
      b.hook('onKill', (_ctx, victim, kill) => {
        expect(kill.origin).toBe(-1);
        expect(victim.alive).toBe(true);
        victims.push(victim.id);
      });
    // Hits deal almost nothing; the burns make every kill, split children's included.
    const stats = makeStats({
      damage: 1e-3,
      attackSpeed: 0.5,
      critChance: 0,
      igniteChance: 1,
      burnDamage: 1e9,
      burnDuration: 4,
    });
    const { ticks, result } = runModules(
      makeConfig({ stats, maxTicks: 600 }),
      stationarySquares(3, 1),
      [module],
    );
    const killed = ticks.flat().flatMap((event) => (event.type === 'enemyKilled' ? [event] : []));
    expect(result.kills).toBeGreaterThanOrEqual(3);
    expect(victims).toEqual(killed.map((event) => event.enemyId));
    expect(ticks.flat().some((event) => event.type === 'burnTick')).toBe(true);
  });
});
