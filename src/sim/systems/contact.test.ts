import { describe, expect, it } from 'vitest';
import { toNumber, ZERO } from '../../core/num';
import type { EmitterGrant } from '../../data/emitters';
import { BASE_STATS } from '../../data/stats';
import type { Modifier, StatExtras, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { runEffectQueue } from '../effects/execute';
import { enqueue } from '../effects/queue';
import type { EmitterRuntime } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  v3TestData,
} from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, NO_INPUT } from '../types';
import type { SimEvent } from '../types';
import { damagePlayer, resolveContacts, REVIVE_LIFE_FRAC } from './contact';
import { createRunContext } from './context';
import type { Enemy, RunContext } from './context';
import { compact } from './death';
import { runEmitters } from './emitters';
import type { EnemyV3 } from './enemyRecord';
import { checkRunEnd } from './runEnd';
import { addEnemy } from './spawn';
import { createPlayerDefence } from './systemState';

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

describe('player defences (docs/v3 C7 design §2.2)', () => {
  /** ◆波次護盾 as B1 writes it (lead ruling L3): a shield effect, so ctx.sys.defence exists. */
  const WAVE_SHIELD: TriggerSpec = {
    on: 'waveStart',
    do: [{ kind: 'shield', lifePct: 0.2, capPct: 0.2 }],
  };

  /** Max life 100, no rolls, `values` on top, and the wave shield unless `triggers` says. */
  const defended = (
    values: Partial<Record<StatId, number>> = {},
    triggers: readonly TriggerSpec[] = [WAVE_SHIELD],
  ) => makeStats({ ...NO_ROLLS, maxLife: 100, ...values }, [], granting([], triggers));

  /** The defence events and playerHits of the tick so far, in order. */
  const defenceEvents = (ctx: RunContext): SimEvent[] =>
    ctx.events.filter(
      (event) =>
        event.type === 'playerHit' || event.type === 'shieldAbsorbed' || event.type === 'revive',
    );

  it('takes contact damage from the shield before life, and leaks a contact it takes whole', () => {
    // Three squares (15 contact damage each) on a shield of 20.
    const ctx = placedEnemies([AT, AT, AT], { stats: defended() });
    const [first, second, third] = ctx.enemies as [Enemy, Enemy, Enemy];
    ctx.player.shield = 20;
    resolveContacts(ctx);
    expect(defenceEvents(ctx)).toEqual([
      { type: 'shieldAbsorbed', amount: 15, shieldLeft: 5 },
      { type: 'playerHit', enemyId: first.id, damage: 0, lifeLeft: 100 },
      { type: 'shieldAbsorbed', amount: 5, shieldLeft: 0 },
      { type: 'playerHit', enemyId: second.id, damage: 10, lifeLeft: 90 },
      { type: 'playerHit', enemyId: third.id, damage: 15, lifeLeft: 75 },
    ]);
    expect([ctx.player.shield, ctx.player.life]).toEqual([0, 75]);
    // Every one leaked, the one the shield took whole too; the tally holds what life lost.
    expect(ctx.enemies.map((enemy) => enemy.alive)).toEqual([false, false, false]);
    expect(first.rec.leaked).toBe(true);
    expect(ctx.taken.square).toEqual({ hits: 3, damage: 25 });
    expect(ctx.killedBy).toBeNull();
  });

  it('gives 20% of max life at each wave start, and with capPct 20% refreshes to it', () => {
    // Waves without enemies: each clears on its start tick, so a wave starts every tick.
    const data = makeTestData({
      waves: {
        rules: [{ enemy: 'triangle', fromWave: 1, base: 0, perWave: 0, maxCount: 0 }],
        eliteEvery: 1000,
        bossEvery: 1000,
      },
    });
    const shields = (shield: EffectSpec): number[] => {
      const stats = makeStats(
        { maxLife: 50 },
        [],
        granting([], [{ on: 'waveStart', do: [shield] }]),
      );
      const sim = createSimulation(makeConfig({ stats, maxTicks: 3 }), data);
      const seen: number[] = [];
      while (!sim.state.finished) {
        const waves = eventsOf([sim.step(NO_INPUT)], 'waveStarted').length;
        seen.push(waves, sim.state.player.shield);
      }
      return seen;
    };
    // C3D:1758's own test, and its two waves: 0.2 × 50 at each start, without a limit.
    expect(shields({ kind: 'shield', lifePct: 0.2 })).toEqual([1, 10, 1, 20, 1, 30]);
    expect(shields({ kind: 'shield', lifePct: 0.2, capPct: 0.2 })).toEqual([1, 10, 1, 10, 1, 10]);
  });

  it("lands a wave start's shield in the effect stage: that tick's contacts meet none", () => {
    // placedEnemies started wave 1, which queued the shield; the contact stage comes first.
    const ctx = placedEnemies([AT], { stats: defended() });
    resolveContacts(ctx);
    expect(defenceEvents(ctx).map((event) => event.type)).toEqual(['playerHit']);
    expect(ctx.player.life).toBe(85);
    runEffectQueue(ctx);
    expect(ctx.player.shield).toBe(20);
  });

  it('revives at REVIVE_LIFE_FRAC of max life with killedBy still null, then dies for good', () => {
    // Two hexagons (30 contact damage) against 20 of life and one extra life; the second waits
    // out of reach until the first has touched.
    const ctx = placedEnemies(
      [
        { ...AT, type: 'hexagon' },
        { x: 100, y: 100, type: 'hexagon' },
      ],
      { stats: defended({ maxLife: 20, extraLives: 1 }, []) },
    );
    const [first, second] = ctx.enemies as [Enemy, Enemy];
    resolveContacts(ctx);
    expect(defenceEvents(ctx)).toEqual([
      { type: 'playerHit', enemyId: first.id, damage: 30, lifeLeft: 0 },
      { type: 'revive', lifeLeft: 10, livesLeft: 0 },
    ]);
    checkRunEnd(ctx);
    expect(REVIVE_LIFE_FRAC).toBe(0.5);
    expect(ctx.player.life).toBe(10);
    expect(ctx.killedBy).toBeNull();
    expect(ctx.state.finished).toBe(false);
    expect(ctx.sys.defence?.livesLeft).toBe(0);
    // The second death ends the run, with its killer.
    ctx.events.length = 0;
    compact(ctx);
    second.dist = 0;
    resolveContacts(ctx);
    checkRunEnd(ctx);
    expect(defenceEvents(ctx)).toEqual([
      { type: 'playerHit', enemyId: second.id, damage: 30, lifeLeft: 0 },
    ]);
    expect(ctx.state.finished).toBe(true);
    expect(ctx.runResult?.endReason).toBe('death');
    expect(ctx.runResult?.killedBy).toBe('hexagon');
    expect(ctx.runResult?.damageTakenBy.hexagon).toEqual({ hits: 2, damage: 60 });
  });

  it('halves contact damage with contactDamageTaken 0.5, before the shield', () => {
    const ctx = placedEnemies([AT], { stats: defended({ contactDamageTaken: 0.5 }) });
    const [square] = ctx.enemies as [Enemy];
    ctx.player.shield = 5;
    resolveContacts(ctx);
    // 15 × 0.5 = 7.5: the shield takes 5, life 2.5.
    expect(defenceEvents(ctx)).toEqual([
      { type: 'shieldAbsorbed', amount: 5, shieldLeft: 0 },
      { type: 'playerHit', enemyId: square.id, damage: 2.5, lifeLeft: 97.5 },
    ]);
    expect(ctx.taken.square).toEqual({ hits: 1, damage: 2.5 });
  });

  it("multiplies a v3 enemy's contact damage by its record's contactMult, before the defences", () => {
    /** The record every enemy of a v3 run has. */
    const recordOf = (enemy: Enemy): EnemyV3 => {
      if (enemy.v3 === null) throw new Error(`enemy ${enemy.id} has no v3 record`);
      return enemy.v3;
    };
    // Lead ruling P7: the record's 1 until C7.6, whose 狂暴 makes it 2. No defence: the fast path.
    const plain = placedEnemies([AT, AT], {
      data: v3TestData(),
      stats: makeStats({ ...NO_ROLLS, maxLife: 100 }),
    });
    expect(plain.sys.defence).toBeNull();
    const [first, second] = plain.enemies as [Enemy, Enemy];
    expect(recordOf(first).contactMult).toBe(1);
    recordOf(second).contactMult = 2;
    resolveContacts(plain);
    expect(defenceEvents(plain)).toEqual([
      { type: 'playerHit', enemyId: first.id, damage: 15, lifeLeft: 85 },
      { type: 'playerHit', enemyId: second.id, damage: 30, lifeLeft: 55 },
    ]);
    expect(plain.taken.square).toEqual({ hits: 2, damage: 45 });
    // With defences, contactDamageTaken and then the shield take the multiplied damage.
    const guarded = placedEnemies([AT], {
      data: v3TestData(),
      stats: defended({ contactDamageTaken: 0.5 }),
    });
    const [square] = guarded.enemies as [Enemy];
    recordOf(square).contactMult = 2;
    guarded.player.shield = 5;
    resolveContacts(guarded);
    // 15 × 2 × 0.5 = 15: the shield takes 5, life 10.
    expect(defenceEvents(guarded)).toEqual([
      { type: 'shieldAbsorbed', amount: 5, shieldLeft: 0 },
      { type: 'playerHit', enemyId: square.id, damage: 10, lifeLeft: 90 },
    ]);
  });

  it('regenerates once after the contacts, only while alive, up to max life', () => {
    const values = { maxLife: 60, lifeRegen: 0.5 };
    const regen = 0.5 * 60 * DT;
    // Two squares: life 60 → 45 → 30, then one tick's regeneration, which the fraction reads.
    const two = placedEnemies([AT, AT], { stats: defended(values, []) });
    resolveContacts(two);
    expect(defenceEvents(two).map((event) => event.type === 'playerHit' && event.lifeLeft)).toEqual(
      [45, 30],
    );
    expect(two.sys.defence?.regenPerTick).toBe(regen);
    expect(two.player.life).toBe(30 + regen);
    expect(two.evalInput.playerLifeFrac).toBe((30 + regen) / 60);
    // No contact, just below max life: capped at it.
    const full = placedEnemies([], { stats: defended(values, []) });
    full.player.life = 60 - regen / 2;
    resolveContacts(full);
    expect(full.player.life).toBe(60);
    // A lethal contact without an extra life: life stays 0 and the run ends.
    const lethal = placedEnemies([AT], { stats: defended(values, []) });
    lethal.player.life = 15;
    resolveContacts(lethal);
    expect(lethal.player.life).toBe(0);
    expect(lethal.killedBy).toBe('square');
    checkRunEnd(lethal);
    expect(lethal.runResult?.endReason).toBe('death');
  });

  it("pushes the lethal contact's playerHit, at 0 of life, then revive", () => {
    const ctx = placedEnemies([AT], { stats: defended({ maxLife: 10, extraLives: 1 }, []) });
    const [square] = ctx.enemies as [Enemy];
    resolveContacts(ctx);
    expect(ctx.events).toEqual([
      { type: 'playerHit', enemyId: square.id, damage: 15, lifeLeft: 0 },
      { type: 'revive', lifeLeft: 5, livesLeft: 0 },
    ]);
    expect(ctx.player.life).toBe(5);
  });

  it('counts the whole part of extraLives: 1.5 revives once, 0.5 never', () => {
    const lives = (extraLives: number): SimEvent['type'][] => {
      const ctx = placedEnemies([AT, AT, AT], { stats: defended({ maxLife: 10, extraLives }, []) });
      resolveContacts(ctx);
      return defenceEvents(ctx).map((event) => event.type);
    };
    // 10 → revive at 5 → 0: the second square ends it, and the third never touches.
    expect(lives(1.5)).toEqual(['playerHit', 'revive', 'playerHit']);
    expect(lives(0.5)).toEqual(['playerHit']);
  });

  it('has no defence exactly when no defence stat moved and no shield effect exists', () => {
    const values = { ...BASE_STATS };
    expect(createPlayerDefence(values, 100, false)).toBeNull();
    expect(createPlayerDefence(values, 100, true)).toEqual({
      contactTaken: 1,
      regenPerTick: 0,
      livesLeft: 0,
    });
    expect(createPlayerDefence({ ...values, contactDamageTaken: 0.8 }, 100, false)).toEqual({
      contactTaken: 0.8,
      regenPerTick: 0,
      livesLeft: 0,
    });
    expect(createPlayerDefence({ ...values, lifeRegen: 0.03 }, 40, false)).toEqual({
      contactTaken: 1,
      regenPerTick: 0.03 * 40 * DT,
      livesLeft: 0,
    });
    expect(createPlayerDefence({ ...values, extraLives: 1.5 }, 100, false)?.livesLeft).toBe(1);
    expect(createPlayerDefence({ ...values, extraLives: 0.5 }, 100, false)?.livesLeft).toBe(0);
    // Through the run: an M1 build has none; a shield anywhere in the compiled build gives one.
    const defenceOf = (stats = makeStats(), modules: readonly TestModule[] = []) =>
      createRunContext(makeConfig({ stats }), makeTestData(), modules).sys.defence;
    expect(defenceOf()).toBeNull();
    const second: TriggerSpec[] = [
      { on: 'kill', do: [{ kind: 'heal', lifePct: 0.01 }] },
      {
        on: 'kill',
        do: [
          { kind: 'gainShards', fraction: 0.1 },
          { kind: 'shield', lifePct: 0.05 },
        ],
      },
    ];
    expect(defenceOf(makeStats({}, [], granting([], second)))).not.toBeNull();
    const added: TestModule = (b) => {
      b.addEffect('center', { kind: 'shield', lifePct: 0.1 });
    };
    expect(defenceOf(makeStats(), [added])).not.toBeNull();
    // Regeneration reads the player's max life, after glassCannon's 1.
    const glass = createRunContext(
      makeConfig({
        stats: makeStats({ lifeRegen: 0.6 }),
        rules: [{ id: 'glassCannon', damageMore: 1 }],
      }),
      makeTestData(),
    );
    expect(glass.player.maxLife).toBe(1);
    expect(glass.sys.defence?.regenPerTick).toBe(0.6 * DT);
  });

  it("has a defence for a contactDamageTaken above 1 too: only exactly 1 is M1's", () => {
    // §2.2's null condition is contactDamageTaken === 1, not "no reduction": a build that takes
    // more contact damage takes the full path, and its ×.
    expect(createPlayerDefence({ ...BASE_STATS, contactDamageTaken: 1.25 }, 100, false)).toEqual({
      contactTaken: 1.25,
      regenPerTick: 0,
      livesLeft: 0,
    });
    const ctx = placedEnemies([AT], { stats: defended({ contactDamageTaken: 1.25 }, []) });
    const [square] = ctx.enemies as [Enemy];
    resolveContacts(ctx);
    // 15 × 1.25 = 18.75.
    expect(defenceEvents(ctx)).toEqual([
      { type: 'playerHit', enemyId: square.id, damage: 18.75, lifeLeft: 81.25 },
    ]);
  });

  it('raises the shield by lifePct up to capPct of max life in all, never lowering it', () => {
    const fx: number[] = [];
    const module: TestModule = (b) => {
      fx.push(b.addEffect('center', { kind: 'shield', lifePct: 0.2, capPct: 0.3 }));
      fx.push(b.addEffect('center', { kind: 'shield', lifePct: 0.05, capPct: 0.2 }));
      fx.push(b.addEffect('center', { kind: 'shield', lifePct: 0.25 }));
    };
    const ctx = placedEnemies([], { stats: makeStats({ maxLife: 100 }), modules: [module] });
    // Below max life, so a gain read from life instead of max life shows.
    ctx.player.life = 50;
    const [capped, small, open] = fx as [number, number, number];
    const shieldAfter = (effect: number, shield: number): number => {
      ctx.player.shield = shield;
      enqueue(ctx, effect, 1, -1, 0, null, 0, 0, ZERO, 0);
      runEffectQueue(ctx);
      return ctx.player.shield;
    };
    // The cap is on the shield's total, not on the gain.
    expect(shieldAfter(capped, 0)).toBe(20);
    expect(shieldAfter(capped, 20)).toBe(30);
    expect(shieldAfter(capped, 25)).toBe(30);
    // A shield above the cap keeps what it has.
    expect(shieldAfter(small, 30)).toBe(30);
    // No capPct: no limit.
    expect(shieldAfter(open, 75)).toBe(100);
    expect(shieldAfter(open, 100)).toBe(125);
    // The shield leaves life alone.
    expect(ctx.player.life).toBe(50);
  });

  it('runs M1 statements alone without a defence: no defence event, the lethal hit sets killedBy', () => {
    const ctx = placedEnemies([AT, AT], { stats: makeStats({ ...NO_ROLLS, maxLife: 20 }) });
    expect(ctx.sys.defence).toBeNull();
    const [first, second] = ctx.enemies as [Enemy, Enemy];
    damagePlayer(ctx, first.id, 'square', 15);
    damagePlayer(ctx, second.id, 'square', 15);
    expect(ctx.events).toEqual([
      { type: 'playerHit', enemyId: first.id, damage: 15, lifeLeft: 5 },
      { type: 'playerHit', enemyId: second.id, damage: 15, lifeLeft: 0 },
    ]);
    expect(ctx.taken.square).toEqual({ hits: 2, damage: 30 });
    expect(ctx.killedBy).toBe('square');
  });
});
