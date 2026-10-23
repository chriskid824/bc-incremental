/**
 * docs/v3 C7 design §2.2's OWN test 8: without a defence stat or a shield effect,
 * ctx.sys.defence is null and damagePlayer's fast path is M1's life loss. Whole M1 runs whose
 * contact stage is swapped for referenceContacts, contact.ts's resolveContacts as it stood
 * before C7.2 statement for statement, give the same events, tick by tick, and the same result,
 * bit for bit. Contact damages, max life and heals are fractional, so a reordering of the life
 * loss or its tally shows. A v3 run of the same build does too: its enemies' records hold a
 * contactMult of 1 until C7.6 (lead ruling P7).
 */

import { describe, expect, it, vi } from 'vitest';
import { ZERO } from '../../core/num';
import type { TriggerSpec } from '../../data/triggers';
import type { EnemyId, GameData } from '../../data/types';
import { releaseAilments } from '../ailments/apply';
import { hitWithPayload } from '../combat/hit';
import { fire } from '../effects/dispatch';
import { EVENT } from '../effects/types';
import type { EmitterRuntime } from '../emitters/types';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, makeTestData, v3TestData } from '../testing';
import { NO_INPUT } from '../types';
import type { RunConfig } from '../types';
import type * as ContactSystem from './contact';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';

/** The contact stage the simulation runs (null: contact.ts's), and what the runs saw. */
const swap = vi.hoisted(() => ({
  stage: null as ((ctx: RunContext) => void) | null,
  calls: 0,
  defences: 0,
  v3: 0,
}));

vi.mock('./contact', async (importOriginal) => {
  const original = await importOriginal<typeof ContactSystem>();
  return {
    ...original,
    resolveContacts: (ctx: RunContext): void => {
      swap.calls++;
      if (ctx.sys.defence !== null) swap.defences++;
      if (ctx.sys.enemyAi.enabled) swap.v3++;
      (swap.stage ?? original.resolveContacts)(ctx);
    },
  };
});

/** contact.ts's resolveContacts at the C7.1 commit, before damagePlayer. */
function referenceContacts(ctx: RunContext): void {
  const enemies = ctx.enemies;
  const player = ctx.player;
  const thorns = ctx.thornsEmitters;
  const count = enemies.length;
  for (let i = 0; i < count; i++) {
    const enemy = enemies[i] as Enemy;
    if (enemy.dist <= enemy.contactDist && player.life > 0) {
      for (let t = 0; t < thorns.length && enemy.alive; t++) {
        const p = (thorns[t] as EmitterRuntime).payload;
        hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, 0, -1);
      }
      if (!enemy.alive) {
        fire(ctx, EVENT.contact, 0, -1, enemy, enemy.x, enemy.y, 0, ZERO);
        continue;
      }
      const damageTaken = enemy.def.contactDamage;
      player.life = Math.max(0, player.life - damageTaken);
      const tally = ctx.taken[enemy.type];
      tally.hits++;
      tally.damage += damageTaken;
      if (player.life <= 0) ctx.killedBy = enemy.type;
      enemy.rec.leaked = true;
      removeEnemy(ctx, enemy);
      ctx.events.push({
        type: 'playerHit',
        enemyId: enemy.id,
        damage: damageTaken,
        lifeLeft: player.life,
      });
      fire(ctx, EVENT.heroHit, 0, -1, null, player.x, player.y, 0, ZERO);
      fire(ctx, EVENT.contact, 0, -1, enemy, enemy.x, enemy.y, 0, ZERO);
      releaseAilments(ctx, enemy);
    }
  }
  ctx.evalInput.playerLifeFrac = player.life / player.maxLife;
}

/** Fractional contact damages for M1's types. */
const CONTACT_DAMAGE: Readonly<Record<string, number>> = {
  triangle: 7.3,
  square: 13.7,
  pentagon: 11.9,
  shard: 3.3,
  hexagon: 29.1,
  boss: 97.7,
};
const ENEMIES = Object.fromEntries(
  Object.entries(CONTACT_DAMAGE).map(([id, contactDamage]) => [id, { contactDamage }]),
) as Partial<Record<EnemyId, { contactDamage: number }>>;
/** M1's test data, and its v3 waves, whose every enemy has a record (a v3 run). */
const DATA = makeTestData({ enemies: ENEMIES });
const V3_DATA = v3TestData({ enemies: ENEMIES });

/** Heals on heroHit and contact, so life between hits is fractional too. */
const HEALS: readonly TriggerSpec[] = [
  { on: 'heroHit', do: [{ kind: 'heal', lifePct: 0.0137 }] },
  { on: 'contact', do: [{ kind: 'heal', lifePct: 0.0071 }] },
];

interface Scenario {
  readonly data: GameData;
  readonly config: Partial<RunConfig>;
}

const PLAIN: Partial<RunConfig> = { startWave: 12, stats: makeStats({ maxLife: 61.7 }) };

const SCENARIOS: Record<string, Scenario> = {
  // Heals and thorns, which kill some touchers before they reach the player.
  heals: {
    data: DATA,
    config: {
      startWave: 8,
      stats: makeStats({ damage: 6, maxLife: 97.3, critChance: 0.2, igniteChance: 0.3 }, [], {
        triggers: HEALS.map((spec) => ({ source: 'center', spec })),
        conversions: [],
        emitters: [{ source: 'outer.thorns', grant: { kind: 'thorns' } }],
      }),
    },
  },
  // M1's default build, far ahead of its waves.
  plain: { data: DATA, config: PLAIN },
  // glassCannon's life of 1: the first contact ends the run.
  glass: { data: DATA, config: { startWave: 4, rules: [{ id: 'glassCannon', damageMore: 1 }] } },
  // plain in a v3 run: contact damage × each record's contactMult, 1 (lead ruling P7).
  v3: { data: V3_DATA, config: PLAIN },
};

interface Run {
  readonly ticks: readonly string[];
  readonly result: string;
}

function run(config: RunConfig, data: GameData, stage: ((ctx: RunContext) => void) | null): Run {
  swap.stage = stage;
  const sim = createSimulation(config, data);
  const ticks: string[] = [];
  while (!sim.state.finished) ticks.push(JSON.stringify(sim.step(NO_INPUT)));
  swap.stage = null;
  return { ticks, result: JSON.stringify(sim.result()) };
}

describe("damagePlayer's fast path (OWN test 8)", () => {
  describe.each(Object.entries(SCENARIOS))('%s', (name, { data, config: overrides }) => {
    it.each([1, 2, 3])(
      'gives the events and result of the pre-C7.2 contact stage (seed %i)',
      (seed) => {
        const config = makeConfig({ seed, maxTicks: 2400, ...overrides });
        swap.calls = 0;
        swap.defences = 0;
        swap.v3 = 0;
        const built = run(config, data, null);
        const reference = run(config, data, referenceContacts);
        expect(swap.calls).toBe(built.ticks.length + reference.ticks.length);
        expect(swap.defences).toBe(0);
        expect(swap.v3).toBe(name === 'v3' ? swap.calls : 0);
        // The first tick whose events differ, if any; -1 keeps the failure message short.
        expect(reference.ticks.findIndex((tick, i) => tick !== built.ticks[i])).toBe(-1);
        expect(reference.ticks.length).toBe(built.ticks.length);
        expect(reference.result).toBe(built.result);
        // The runs leak, and die of it: the lethal hit's tally and killedBy are compared too.
        const result = JSON.parse(built.result) as { leaks: number; killedBy: string | null };
        expect(result.leaks).toBeGreaterThan(0);
        expect(result.killedBy).not.toBeNull();
      },
    );
  });
});
