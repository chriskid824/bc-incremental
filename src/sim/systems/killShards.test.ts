/**
 * Greed's kill shards (docs/v3/game-design-v3.md §4.12 and its payload row, gd:571; docs/v3 C6
 * design §7.4 C6b.3; lead ruling G4): an enemy killed by the damage of a trigger with killShards
 * drops × (1 + killShards) shards, which its kill event, SimState.shards and its pending kills
 * carry (killEnemy, src/sim/systems/death.ts); an emitter hit's kill, a kill by damage over time
 * and another trigger's kill drop as before. Each test names in a comment the planted bug it
 * kills.
 */

import { describe, expect, it } from 'vitest';
import { mul, num, sub } from '../../core/num';
import type { Num } from '../../core/num';
import type { TriggerSpec } from '../../data/triggers';
import { runEffect } from '../effects/execute';
import { KILL_BY_BURN, KILL_BY_HIT } from '../effects/flags';
import { createEffectEntry } from '../effects/queue';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, makeTestData, placedEnemies } from '../testing';
import { NO_INPUT } from '../types';
import type { Enemy, RunContext } from './context';
import { killEnemy } from './death';

const COIN = { kind: 'coinHit', multiplier: 10, ignoreShield: true } as const;
/** greed's fusion trigger as the generator writes it, on a hit (an M1 run raises no explode). */
const GREED: TriggerSpec = {
  on: 'hit',
  when: [{ hitIs: 'signature' }],
  do: [COIN],
  killShards: 0.01,
};
const PLAIN: TriggerSpec = { on: 'hit', when: [{ hitIs: 'signature' }], do: [COIN] };
const GAIN: TriggerSpec = { on: 'kill', do: [{ kind: 'gainShards', fraction: 1 }] };

/** The drop of `enemy` before the kill shards, as killEnemy computes it. */
const dropOf = (ctx: RunContext, enemy: Enemy): Num => {
  const base = mul(mul(num(enemy.def.dropMult), enemy.rec.shardsPerStd), ctx.shardGain);
  return enemy.v3 === null ? base : mul(base, enemy.v3.dropScale);
};

describe('killShards at the kill', () => {
  /** Three squares of 1 hp, with GREED as trigger 1, PLAIN as 2 and GAIN as 3. */
  const field = (): RunContext =>
    placedEnemies(
      [
        { x: 600, y: 300, hp: 1 },
        { x: 650, y: 300, hp: 1 },
        { x: 700, y: 300, hp: 1 },
      ],
      {
        stats: makeStats({ critChance: 0, igniteChance: 0 }, [], {
          triggers: [GREED, PLAIN, GAIN].map((spec) => ({ source: 'outer.greed', spec })),
          conversions: [],
          emitters: [],
        }),
      },
    );
  /** Runs trigger `t`'s coin on `enemy`, as the effect phase does. */
  const coin = (ctx: RunContext, t: number, enemy: Enemy): void => {
    const entry = createEffectEntry();
    entry.effect = (ctx.build.triggers[t] as { effectStart: number }).effectStart;
    entry.origin = t;
    entry.depth = 1;
    entry.source = (ctx.build.triggers[t] as { source: number }).source;
    entry.target = enemy;
    entry.x = enemy.x;
    entry.y = enemy.y;
    runEffect(ctx, entry);
  };
  const killed = (ctx: RunContext): Num[] =>
    ctx.events.flatMap((e) => (e.type === 'enemyKilled' ? [e.shards] : []));

  it('credits a kill by the greed trigger’s coin × 1.01, to its event, SimState.shards and its pending kill', () => {
    // Planted bugs: the bonus applied twice, or after the kill event.
    const ctx = field();
    const victim = ctx.enemies[0] as Enemy;
    const drop = mul(dropOf(ctx, victim), 1.01);
    const before = ctx.state.shards;
    coin(ctx, 1, victim);
    expect(victim.alive).toBe(false);
    expect(killed(ctx)).toEqual([drop]);
    expect(sub(ctx.state.shards, before)).toBe(drop);
    // GAIN's pending kill carries the kill's drop.
    expect(ctx.pendingKills.slice(0, ctx.pendingCount).map((k) => [k.trigger, k.value])).toEqual([
      [3, drop],
    ]);
  });

  it('leaves the cores alone: a kill by the greed trigger’s coin drops the cores another’s does', () => {
    // Planted bug: the bonus applied to the cores as well as the shards.
    const ctx = field();
    const [a, b] = ctx.enemies as [Enemy, Enemy];
    for (const enemy of [a, b]) Object.assign(enemy, { def: { ...enemy.def, cores: 100 } });
    const expected = 100 * ctx.coreGain * (a.v3 === null ? 1 : a.v3.dropScale);
    expect(Number.isInteger(expected) && expected > 0).toBe(true);
    coin(ctx, 1, a);
    coin(ctx, 2, b);
    const cores = ctx.events.flatMap((e) => (e.type === 'enemyKilled' ? [e.cores] : []));
    expect(cores).toEqual([expected, expected]);
  });

  it('credits a kill by another trigger’s coin, by an emitter’s hit and by damage over time their plain drop', () => {
    // Planted bug: the bonus on every kill (whatever its origin), or on a DoT kill.
    const ctx = field();
    const [a, b, c] = ctx.enemies as [Enemy, Enemy, Enemy];
    const drops = [dropOf(ctx, a), dropOf(ctx, b), dropOf(ctx, c)];
    coin(ctx, 2, a);
    // An emitter hit's kill (src/sim/combat/hit.ts) and a burn's (src/sim/systems/ailments.ts),
    // both of origin −1.
    b.killKind = KILL_BY_HIT;
    killEnemy(ctx, b, -1, 0);
    c.killKind = KILL_BY_BURN;
    killEnemy(ctx, c, -1, 0);
    expect(killed(ctx)).toEqual(drops);
  });
});

describe('killShards in a run', () => {
  it('pays × 1.01 on the greed trigger’s kills alone: not the volley’s, the burns’ or another trigger’s', () => {
    // Planted bugs: the bonus on every kill, on DoT kills (killed by a burn its coin lit), twice.
    const explode: TriggerSpec = {
      on: 'crit',
      do: [{ kind: 'explode', radius: 60, damagePct: 0.5 }],
    };
    const stats = makeStats({ damage: 8, critChance: 0.3, igniteChance: 0.4 }, [], {
      triggers: [
        {
          source: 'outer.greed',
          spec: { ...GREED, when: [{ hitIs: 'signature' }, { chance: 0.3 }] },
        },
        { source: 'center', spec: explode },
      ],
      conversions: [],
      emitters: [],
    });
    const credit = new Map<number, Num>();
    const kills: Record<string, number> = {};
    const watch: TestModule = (b) =>
      void b.hook('onKill', (ctx, victim, kill) => {
        const by =
          kill.origin === 1
            ? 'greed'
            : kill.origin === 2
              ? 'explode'
              : victim.killKind === 0
                ? 'volley'
                : 'dot';
        kills[by] = (kills[by] ?? 0) + 1;
        const drop = dropOf(ctx, victim);
        credit.set(victim.id, by === 'greed' ? mul(drop, 1.01) : drop);
      });
    const sim = createSimulation(
      makeConfig({ stats, startWave: 8, maxTicks: 1800 }),
      makeTestData(),
      [watch],
    );
    let paid = 0;
    while (!sim.state.finished) {
      for (const event of sim.step(NO_INPUT)) {
        if (event.type !== 'enemyKilled') continue;
        expect(event.shards, `kill of ${event.enemyId}`).toBe(credit.get(event.enemyId));
        paid++;
      }
    }
    expect(paid).toBe(credit.size);
    expect(Object.keys(kills).sort()).toEqual(['dot', 'explode', 'greed', 'volley']);
  });
});
