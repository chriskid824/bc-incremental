import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import type { EmitterGrant } from '../../data/emitters';
import type { Modifier, StatExtras } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { TriggerSpec } from '../../data/triggers';
import { runEffectQueue } from '../effects/execute';
import type { EmitterRuntime } from '../emitters/types';
import { eventsOf, makeStats, placedEnemies } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { resolveContacts } from './contact';
import type { Enemy, RunContext } from './context';
import { compact } from './death';
import { runEmitters } from './emitters';
import { addEnemy } from './spawn';

describe('contacts', () => {
  it('resolves the enemies there at its start; one added during it touches the next tick', () => {
    // Two squares on the player, one far off.
    const at = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
    const ctx = placedEnemies([at, at, { x: 100, y: 100 }], {
      stats: makeStats({ maxLife: 1e6 }),
    });
    const [first, second] = ctx.enemies as [Enemy, Enemy, Enemy];
    // The first contact adds a square on the player. No hook runs inside the contact stage
    // before thorns, so the test adds it from the stage's own playerHit event.
    let added: Enemy | null = null;
    const events = ctx.events;
    const push = events.push.bind(events);
    events.push = (...pushed: SimEvent[]): number => {
      if (added === null && pushed[0]?.type === 'playerHit') {
        addEnemy(ctx, first.def, first.rec, 1, 0, 0);
        added = ctx.enemies.at(-1) as Enemy;
      }
      return push(...pushed);
    };
    resolveContacts(ctx);
    expect(added).not.toBeNull();
    const touched = (): number[] => eventsOf([events], 'playerHit').map((hit) => hit.enemyId);
    expect(touched()).toEqual([first.id, second.id]);
    expect((added as unknown as Enemy).alive).toBe(true);
    // The next tick: the touching squares are gone, and the added one touches.
    events.length = 0;
    compact(ctx);
    resolveContacts(ctx);
    expect(touched()).toEqual([(added as unknown as Enemy).id]);
  });
});

/** The middle of the arena, where the player stands. */
const AT = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

/** No crits and no ailments, so a hit deals exactly its rows. */
const NO_ROLLS = { critChance: 0, igniteChance: 0 } as const;

/** The emitter grants, each with its source, and center triggers, as collectExtras gives them. */
function granting(
  emitters: readonly [string, EmitterGrant][],
  triggers: readonly TriggerSpec[] = [],
): StatExtras {
  return {
    triggers: triggers.map((spec) => ({ source: 'center', spec })),
    conversions: [],
    emitters: emitters.map(([source, grant]) => ({ source, grant })),
  };
}

/** heroHit heals (effect 0), contact heals (effect 1). */
const HEALS: readonly TriggerSpec[] = [
  { on: 'heroHit', do: [{ kind: 'heal', lifePct: 0.01 }] },
  { on: 'contact', do: [{ kind: 'heal', lifePct: 0.02 }] },
];
const HERO_HIT_HEAL = 0;
const CONTACT_HEAL = 1;

/** The queued effects (CompiledBuild.effects indices), oldest first. */
function queuedEffects(ctx: RunContext): number[] {
  const q = ctx.effectQueue;
  return Array.from({ length: q.size }, (_, n) => q.effect[(q.head + n) & q.capMask] as number);
}

const hitsOf = (ctx: RunContext) => eventsOf([ctx.events], 'hit');

describe('thorns', () => {
  const spikes: EmitterGrant = { kind: 'thorns' };

  it('runs in the contact stage, not the emitter stage', () => {
    const ctx = placedEnemies([], {
      stats: makeStats({}, [], granting([['outer.thorns', spikes]])),
    });
    expect(ctx.thornsEmitters.map((em) => [em.index, em.spec.kind, em.interval])).toEqual([
      [1, 'thorns', Infinity],
    ]);
    // The emitter stage steps the volley, whose accumulator gains its cadence (no enemy, so no
    // attack), and passes over the thorns, whose accumulator stays 0.
    const [volley, thorns] = ctx.emitters as [EmitterRuntime, EmitterRuntime];
    runEmitters(ctx);
    expect(volley.acc).toBe(volley.cadence);
    expect(thorns.acc).toBe(0);
  });

  it('kills a toucher before it reaches the player: contact once, no heroHit, no leak (C3)', () => {
    const stats = makeStats(
      { ...NO_ROLLS, maxLife: 100 },
      [],
      granting(
        [
          ['outer.thorns', spikes],
          ['center', spikes],
        ],
        HEALS,
      ),
    );
    const ctx = placedEnemies([{ ...AT, type: 'pentagon', hp: 1 }], { stats });
    const pentagon = ctx.enemies[0] as Enemy;
    const life = ctx.player.life;
    resolveContacts(ctx);
    expect(pentagon.alive).toBe(false);
    expect(ctx.player.life).toBe(life);
    expect(pentagon.rec.leaked).toBe(false);
    expect(ctx.taken.pentagon.hits).toBe(0);
    expect(eventsOf([ctx.events], 'playerHit')).toEqual([]);
    expect(eventsOf([ctx.events], 'enemyKilled').map((kill) => kill.enemyId)).toEqual([
      pentagon.id,
    ]);
    // One hit, the first emitter's: the kill stops the second.
    const thornsSource = ctx.build.sources.names.indexOf('outer.thorns');
    expect(hitsOf(ctx).map((hit) => [hit.targetId, hit.tags, hit.source])).toEqual([
      [pentagon.id, TAG.hit | TAG.thorns, thornsSource],
    ]);
    expect(queuedEffects(ctx)).toEqual([CONTACT_HEAL]);
    // Its split children exist and touch the player, but only from the next tick.
    const children = ctx.enemies.slice(1);
    expect(children.map((child) => [child.type, child.alive])).toEqual([
      ['shard', true],
      ['shard', true],
      ['shard', true],
    ]);
    for (const child of children) expect(child.dist).toBeLessThanOrEqual(child.contactDist);
    ctx.events.length = 0;
    compact(ctx);
    resolveContacts(ctx);
    expect(hitsOf(ctx).map((hit) => hit.targetId)).toEqual(
      expect.arrayContaining(children.map((child) => child.id)),
    );
  });

  it('lets a survivor leak: its hits land, then heroHit and contact as built', () => {
    const stats = makeStats(
      { ...NO_ROLLS, maxLife: 100 },
      [],
      granting(
        [
          ['outer.thorns', spikes],
          ['center', { kind: 'thorns', damagePct: 1 }],
        ],
        HEALS,
      ),
    );
    const ctx = placedEnemies([AT], { stats });
    const square = ctx.enemies[0] as Enemy;
    const life = ctx.player.life;
    resolveContacts(ctx);
    const sources = ctx.build.sources.names;
    expect(hitsOf(ctx).map((hit) => [hit.targetId, hit.tags, sources[hit.source]])).toEqual([
      [square.id, TAG.hit | TAG.thorns, 'outer.thorns'],
      [square.id, TAG.hit | TAG.thorns, 'center'],
    ]);
    const [first, second] = hitsOf(ctx).map((hit) => toNumber(hit.amount));
    expect(first).toBeCloseTo(3 * (second as number), 9);
    expect(ctx.player.life).toBe(life - square.def.contactDamage);
    expect(square.rec.leaked).toBe(true);
    expect(square.alive).toBe(false);
    expect(ctx.taken.square.hits).toBe(1);
    expect(eventsOf([ctx.events], 'playerHit').map((hit) => hit.enemyId)).toEqual([square.id]);
    expect(eventsOf([ctx.events], 'enemyKilled')).toEqual([]);
    expect(queuedEffects(ctx)).toEqual([HERO_HIT_HEAL, CONTACT_HEAL]);
  });

  it('doubles the thorns hit and a thorns nova under a thorns-scoped more, not a plain nova (R42)', () => {
    const novas: TriggerSpec[] = [
      {
        on: 'contact',
        do: [{ kind: 'nova', radius: 100, damagePct: 1, tags: ['thorns'], at: 'event' }],
      },
      { on: 'contact', do: [{ kind: 'nova', radius: 100, damagePct: 1, at: 'event' }] },
    ];
    const ironMaiden: Modifier = { stat: 'damage', kind: 'more', value: 1, tags: ['thorns'] };
    const amounts = (mods: readonly Modifier[]) => {
      const stats = makeStats(NO_ROLLS, mods, granting([['outer.thorns', spikes]], novas));
      // A toucher and a neighbour 60 from it, out of contact reach.
      const ctx = placedEnemies([AT, { x: AT.x + 60, y: AT.y }], { stats });
      const [toucher, neighbour] = ctx.enemies as [Enemy, Enemy];
      resolveContacts(ctx);
      runEffectQueue(ctx);
      const hits = hitsOf(ctx);
      const on = (enemy: Enemy, thorns: boolean): number[] =>
        hits
          .filter((hit) => hit.targetId === enemy.id && ((hit.tags & TAG.thorns) !== 0) === thorns)
          .map((hit) => toNumber(hit.amount));
      return {
        thorns: on(toucher, true),
        thornsNova: on(neighbour, true),
        plainNova: on(neighbour, false),
      };
    };
    const plain = amounts([]);
    const doubled = amounts([ironMaiden]);
    expect(plain.thorns).toHaveLength(1);
    expect(plain.thornsNova).toHaveLength(1);
    expect(plain.plainNova).toHaveLength(1);
    expect(doubled.thorns).toEqual(plain.thorns.map((amount) => amount * 2));
    expect(doubled.thornsNova).toEqual(plain.thornsNova.map((amount) => amount * 2));
    expect(doubled.plainNova).toEqual(plain.plainNova);
  });
});
