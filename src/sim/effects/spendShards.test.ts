/**
 * The spendShards effect (E17, lead ruling 27; ◆撒幣's 「每枚花本局碎片 0.1%」, gd:500, and
 * ◆買斷's 「每次花本局碎片 0.2%」, gd:502): spent = SimState.shards × fraction off the run's
 * shards, into SimState.shardsSpent, in Num and unrounded; never the wallet, which is not the
 * run's; no target, no RNG, no event, and a fusion's coefficient never scales it. Effects run in
 * their `do` order, so a coin after a spend in one firing hits once the spend is made, and reads
 * the shardsHeld the tick's globals step (4b) wrote before it: the spend reaches shardsHeld from
 * the next tick's step. Without liveTarget a spend is paid on every firing; with it (lead ruling
 * G5), only while the event's enemy is alive when the spend runs. Each test's comment names the
 * planted bug it kills.
 */

import { describe, expect, it } from 'vitest';
import { add, mul, num, sub, toNumber, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import type { Modifier, SourcedTrigger, StatId } from '../../data/stats';
import { COEF_FIELDS } from '../../data/triggers';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { compileBuild } from '../build/compile';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { makeConfig, makeStats, makeTestData, placedEnemies, rngPositions } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import type { RunConfig } from '../types';
import { raiseFreeze } from './centerEvents';
import { fireOne } from './dispatch';
import { runEffectQueue } from './execute';
import { SHATTER_TRIGGER } from './types';

/** The player's position (createRunContext puts it at the arena's center). */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

const spend = (fraction: number, liveTarget?: true): EffectSpec => ({
  kind: 'spendShards',
  fraction,
  ...(liveTarget === undefined ? {} : { liveTarget }),
});
const COIN: EffectSpec = { kind: 'coinHit', multiplier: 10, ignoreShield: true };

/** A damage more of × (held shards)^exponent: the 錢包 factor (H17), on every hit. */
const held = (exponent: number): Modifier => ({
  stat: 'damage',
  kind: 'more',
  value: 1,
  scaling: { per: 'shardsHeld', curve: 'powFactor', exponent },
});

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly scoped?: readonly Modifier[];
  readonly modules?: readonly TestModule[];
  readonly coef?: number;
}

/** One enemy 100 to the player's right under one `on` trigger doing `effects`. */
function field(effects: readonly EffectSpec[], on: TriggerSpec['on'] = 'hit', o: Options = {}) {
  const trigger: SourcedTrigger = {
    source: 'center',
    spec: { on, do: effects },
    ...(o.coef === undefined ? {} : { coef: o.coef }),
  };
  return placedEnemies([{ x: P.x + 100, y: P.y }], {
    stats: makeStats({ critChance: 0, ...o.values }, o.scoped ?? [], {
      triggers: [trigger],
      conversions: [],
      emitters: [],
    }),
    ...(o.modules === undefined ? {} : { modules: o.modules }),
  });
}

/** Fires the first data trigger on the enemy, then runs the effect phase. */
function fire(ctx: RunContext): void {
  const target = ctx.enemies[0] as Enemy;
  fireOne(ctx, FIRST, 0, -1, target, target.x, target.y, 0, ZERO, -1);
  runEffectQueue(ctx);
}

/** The run's shards and the shards spent, as numbers. */
const purse = (ctx: RunContext): [number, number] => [
  toNumber(ctx.state.shards),
  toNumber(ctx.state.shardsSpent),
];

describe('the spendShards executor (lead ruling 27)', () => {
  it('takes exactly 0.001 of SimState.shards in Num, unrounded, and adds that to shardsSpent', () => {
    // Planted bugs: the spend taken from shardsHeld (which holds the wallet) rather than the
    // run's shards; shardsSpent left alone, or counting the fraction; the share rounded.
    const ctx = field([spend(0.001)]);
    const shards = num(12345.678);
    ctx.state.shards = shards;
    ctx.evalInput.shardsHeld = 1e9;
    fire(ctx);
    const spent = mul(shards, 0.001);
    expect(ctx.state.shards).toBe(sub(shards, spent));
    expect(ctx.state.shardsSpent).toBe(spent);
    expect(spent).not.toBe(Math.round(spent));
    // A second spend takes its share of what is left, and the counter sums both.
    fire(ctx);
    const again = mul(sub(shards, spent), 0.001);
    expect(ctx.state.shards).toBe(sub(sub(shards, spent), again));
    expect(ctx.state.shardsSpent).toBe(add(spent, again));
    expect(ctx.evalInput.shardsHeld).toBe(1e9);
  });

  it('leaves 0 at fraction 1 and counts the whole', () => {
    // Planted bug: shardsSpent counting the fraction (1) rather than the shards (777.25).
    const ctx = field([spend(1)]);
    ctx.state.shards = num(777.25);
    fire(ctx);
    expect(Object.is(ctx.state.shards, 0)).toBe(true);
    expect(ctx.state.shardsSpent).toBe(777.25);
  });

  it('changes nothing at 0 shards', () => {
    // Planted bugs: a spend floored at a minimum, or one that writes −0.
    const ctx = field([spend(0.5)]);
    fire(ctx);
    expect(Object.is(ctx.state.shards, 0)).toBe(true);
    expect(Object.is(ctx.state.shardsSpent, 0)).toBe(true);
  });

  it('compounds two spends in one do: the second takes its share of what the first left', () => {
    // Planted bug: each spend of one firing on the shards the firing started with.
    const ctx = field([spend(0.25), spend(0.5)]);
    ctx.state.shards = num(1000);
    fire(ctx);
    expect(purse(ctx)).toEqual([375, 625]);
  });

  it('draws no RNG and raises no event, with liveTarget or without', () => {
    // Planted bugs: a spend that draws from a stream or pushes an event.
    const ctx = field([spend(0.5), spend(0.5, true)], 'kill');
    ctx.state.shards = num(64);
    const before = rngPositions(ctx);
    ctx.events.length = 0;
    fire(ctx);
    expect(rngPositions(ctx)).toEqual(before);
    expect(ctx.events).toEqual([]);
    expect(purse(ctx)).toEqual([16, 48]);
  });

  it('spends once a freeze, not once for each enemy of its list', () => {
    // Planted bug: spendShards compiled with fanout, so a freeze's list of 3 spends 3 times.
    const ctx = placedEnemies(
      [
        { x: P.x + 100, y: P.y },
        { x: P.x + 110, y: P.y },
        { x: P.x + 100, y: P.y + 10 },
      ],
      {
        stats: makeStats({}, [], {
          triggers: [
            { source: 'center', spec: { on: 'freeze', do: [spend(0.5)] } },
            // A status effect, so the freeze takes its list.
            {
              source: 'center',
              spec: { on: 'freeze', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 1 }] },
            },
          ],
          conversions: [],
          emitters: [],
        }),
      },
    );
    ctx.state.shards = num(1000);
    raiseFreeze(ctx, ctx.enemies[0] as Enemy, 0, -1, 0);
    runEffectQueue(ctx);
    expect(ctx.centerScratch.listCount).toBe(3);
    expect(purse(ctx)).toEqual([500, 500]);
  });

  it('keeps its fraction under a fusion’s coefficient, which never scales a cost', () => {
    // Planted bug: spendShards in COEF_FIELDS, so a coefficient of 2 spends 0.2 % for 0.1 %.
    expect(COEF_FIELDS.spendShards).toEqual([]);
    const ctx = field([spend(0.001)], 'hit', { coef: 2 });
    expect(ctx.build.effects.find((e) => e.kind === 'spendShards')?.spec).toEqual(spend(0.001));
    ctx.state.shards = num(1e4);
    fire(ctx);
    expect(purse(ctx)).toEqual([sub(num(1e4), mul(num(1e4), 0.001)), mul(num(1e4), 0.001)]);
  });

  it('refuses a module’s fraction of 0, −0.1, 1.5 or NaN at compile, and takes 1', () => {
    // Planted bug: a fraction above 1 compiled from a module, taking the shards below 0.
    const compile = (fraction: number) => () =>
      compileBuild(makeStats(), [], undefined, [
        (b) => b.addTrigger('center', { on: 'hit', do: [spend(fraction)] }),
      ]);
    for (const bad of [0, -0.1, 1.5, Number.NaN]) {
      expect(compile(bad)).toThrow(
        `A spendShards effect ${JSON.stringify(spend(bad))}: ` +
          `fraction must be finite and in (0, 1] (got ${bad})`,
      );
    }
    expect(compile(1)).not.toThrow();
  });
});

describe('when a spend is paid (lead ruling G5)', () => {
  /**
   * The purse and the coins after one firing of [spend 0.5, coin] on each of: the live enemy;
   * the same enemy, dead after its event and before the effect phase, as on a hit that was
   * itself lethal; and no enemy (a null target). The trigger listens to `on`.
   */
  function firings(liveTarget?: true, on: TriggerSpec['on'] = 'hit') {
    const ctx = field([spend(0.5, liveTarget), COIN], on, { values: { damage: 1 } });
    const target = ctx.enemies[0] as Enemy;
    const out: { purse: [number, number]; coins: number }[] = [];
    const once = (on: Enemy | null, dies: boolean): void => {
      ctx.state.shards = num(64);
      ctx.state.shardsSpent = ZERO;
      ctx.events.length = 0;
      target.alive = true;
      fireOne(ctx, FIRST, 0, -1, on, target.x, target.y, 0, ZERO, -1);
      if (dies) target.alive = false;
      runEffectQueue(ctx);
      out.push({ purse: purse(ctx), coins: ctx.events.filter((e) => e.type === 'coin').length });
    };
    once(target, false);
    once(target, true);
    once(null, false);
    return out;
  }

  it('pays without liveTarget on a live target, one dead by the effect phase and none alike, whatever the coin after it finds', () => {
    // Planted bug: a flagless spend skipped where its target is dead or absent, as the enemy
    // effects are (the verifier's O10).
    expect(firings()).toEqual([
      { purse: [32, 32], coins: 1 },
      { purse: [32, 32], coins: 0 },
      { purse: [32, 32], coins: 0 },
    ]);
  });

  it('pays with liveTarget only on a target alive at the effect phase: not on one dead by then, nor on none', () => {
    // Planted bugs: liveTarget ignored; inverted; or read when the trigger fires (the target
    // still alive then) rather than in the executor.
    expect(firings(true)).toEqual([
      { purse: [32, 32], coins: 1 },
      { purse: [64, 0], coins: 0 },
      { purse: [64, 0], coins: 0 },
    ]);
  });

  it.each(['nthAttack', 'crit'] as const)(
    'pays a liveTarget spend on %s as on hit: only on a target alive at the effect phase',
    (on) => {
      // Planted bug: liveTarget honoured on hit events alone, so ◆撒幣's nthAttack spend
      // (gd:500) is paid on an attack whose first target died before the effect phase.
      expect(firings(true, on)).toEqual([
        { purse: [32, 32], coins: 1 },
        { purse: [64, 0], coins: 0 },
        { purse: [64, 0], coins: 0 },
      ]);
      expect(firings(undefined, on).map((f) => f.purse)).toEqual([
        [32, 32],
        [32, 32],
        [32, 32],
      ]);
    },
  );

  it('reads liveTarget off a selector’s pick, not the event’s enemy', () => {
    // Planted bug: liveTarget read off the event's enemy where a selector picked another one.
    const ctx = placedEnemies(
      [
        { x: P.x + 100, y: P.y },
        { x: P.x + 300, y: P.y },
      ],
      {
        stats: makeStats({ critChance: 0, damage: 1 }, [], {
          triggers: [
            {
              source: 'center',
              spec: {
                on: 'crit',
                target: { pick: 'nearest', excludeEventTarget: true },
                do: [spend(0.5, true), COIN],
              },
            },
          ],
          conversions: [],
          emitters: [],
        }),
      },
    );
    const [near, far] = ctx.enemies as [Enemy, Enemy];
    const once = (dies: Enemy): [number, number, number[]] => {
      ctx.state.shards = num(64);
      ctx.state.shardsSpent = ZERO;
      ctx.events.length = 0;
      near.alive = true;
      far.alive = true;
      fireOne(ctx, FIRST, 0, -1, far, far.x, far.y, 0, ZERO, -1);
      dies.alive = false;
      runEffectQueue(ctx);
      const coins = ctx.events.flatMap((e) => (e.type === 'coin' ? [e.targetId] : []));
      return [...purse(ctx), coins];
    };
    // The pick (the near one) dead by the effect phase, the event's enemy alive: no spend, no
    // coin.
    expect(once(near)).toEqual([64, 0, []]);
    // The event's enemy dead and the pick alive: paid, and the coin lands on the pick.
    expect(once(far)).toEqual([32, 32, [near.id]]);
  });
});

describe('a spend and a coin in one do (the globals step rule)', () => {
  /** The coin's damage on the enemy under `effects`, the step having written `heldAt4b`. */
  function coin(effects: readonly EffectSpec[], heldAt4b: number) {
    const hits: { amount: number; shards: number }[] = [];
    const watch: TestModule = (b) => {
      b.hook('modifyDamage', (ctx, _hit, amount) => {
        hits.push({ amount: toNumber(amount), shards: toNumber(ctx.state.shards) });
        return amount;
      });
    };
    const ctx = field(effects, 'hit', {
      values: { damage: 3 },
      scoped: [held(0.5)],
      modules: [watch],
    });
    ctx.state.shards = num(1e4);
    ctx.evalInput.shardsHeld = heldAt4b;
    fire(ctx);
    return { hits, purse: purse(ctx) };
  }

  it('spends before the coin hits, and the coin reads the shardsHeld of the tick’s step', () => {
    // Planted bugs: the effects of one firing run out of `do` order; a spend that writes
    // shardsHeld at once, so a coin after it reads the spent shards.
    const spendFirst = coin([spend(0.5), COIN], 1e4);
    expect(spendFirst.purse).toEqual([5000, 5000]);
    expect(spendFirst.hits.map((h) => h.shards)).toEqual([5000]);
    // The coin alone, at the same step's value: the same damage, 10 × 3 × (1e4)^0.5.
    const alone = coin([COIN], 1e4);
    expect(spendFirst.hits.map((h) => h.amount)).toEqual(alone.hits.map((h) => h.amount));
    expect(alone.hits[0]?.amount).toBeCloseTo(10 * 3 * 100, 9);
    // What a coin would read had the spend reached the step: not what it read.
    const spentRead = coin([COIN], 5000);
    expect(spentRead.hits[0]?.amount).toBeCloseTo(10 * 3 * Math.sqrt(5000), 9);
    expect(spentRead.hits[0]?.amount).not.toBe(spendFirst.hits[0]?.amount);
    // The coin first: it hits before the spend, at the same damage.
    const coinFirst = coin([COIN, spend(0.5)], 1e4);
    expect(coinFirst.hits).toEqual([{ amount: alone.hits[0]?.amount, shards: 1e4 }]);
    expect(coinFirst.purse).toEqual([5000, 5000]);
  });
});

describe('spends in a run', () => {
  /** The running effect's target when it writes: alive, dead or none (EffectEntry.target). */
  type Target = 'live' | 'dead' | 'none';
  interface Write {
    readonly field: 'shards' | 'shardsSpent';
    readonly tick: number;
    readonly origin: number;
    readonly target: Target;
    readonly from: Num;
    readonly to: Num;
  }
  interface Spend {
    readonly tick: number;
    readonly origin: number;
    readonly target: Target;
    /** The run's shards before and after the spend's write of them. */
    readonly before: Num;
    readonly after: Num;
    /** shardsSpent before and after. */
    readonly from: Num;
    readonly to: Num;
  }
  /**
   * A 900-tick run of the fixture's waves from wave 10 under `triggers` (indices FIRST on, in
   * order), at `damage`, the build reading shardsHeld: every write of SimState.shards and
   * shardsSpent (by accessors, credited to the running effect's trigger), each spend with the
   * write of the shards next to it, the shardsHeld each tick's step wrote (the tick hook's, read
   * after the step), what the coins read, and the drops.
   */
  function run(triggers: readonly TriggerSpec[], config: Partial<RunConfig> = {}, damage = 12) {
    const writes: Write[] = [];
    const stepHeld = new Map<number, number>();
    const coinReads: { tick: number; held: number }[] = [];
    let installed = false;
    const watch: TestModule = (b) => {
      b.hook('tick', (ctx) => {
        stepHeld.set(ctx.now, ctx.evalInput.shardsHeld);
        if (installed) return;
        installed = true;
        const state = ctx.state;
        const values = { shards: state.shards, shardsSpent: state.shardsSpent };
        for (const field of ['shards', 'shardsSpent'] as const) {
          Object.defineProperty(state, field, {
            get: () => values[field],
            set: (value: Num) => {
              const { origin, target: on } = ctx.effectEntry;
              const target = on === null ? 'none' : on.alive ? 'live' : 'dead';
              writes.push({ field, tick: ctx.now, origin, target, from: values[field], to: value });
              values[field] = value;
            },
          });
        }
      });
      b.hook('modifyDamage', (ctx, hit, amount) => {
        if (hit.origin >= FIRST) coinReads.push({ tick: ctx.now, held: ctx.evalInput.shardsHeld });
        return amount;
      });
    };
    const stats = makeStats({ damage, maxLife: 1e6, critChance: 0 }, [held(0.12)], {
      triggers: triggers.map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: [],
    });
    const sim = createSimulation(
      makeConfig({ stats, startWave: 10, maxTicks: 900, ...config }),
      makeTestData(),
      [watch],
    );
    let dropped = ZERO;
    const ends = [0];
    while (!sim.state.finished) {
      for (const event of sim.step(NO_INPUT)) {
        if (event.type === 'enemyKilled') dropped = add(dropped, event.shards);
      }
      ends.push(toNumber(sim.state.shards));
    }
    // Each spend's write of the counter, with the write of the shards beside it.
    const spends: Spend[] = [];
    writes.forEach((w, i) => {
      if (w.field !== 'shardsSpent') return;
      const pair = [writes[i - 1], writes[i + 1]].find((x) => x?.field === 'shards') as Write;
      expect(pair.tick).toBe(w.tick);
      spends.push({
        tick: w.tick,
        origin: w.origin,
        target: w.target,
        before: pair.from,
        after: pair.to,
        from: w.from,
        to: w.to,
      });
    });
    const shardWrites = writes.filter((w) => w.field === 'shards').map((w) => toNumber(w.to));
    return { sim, spends, shardWrites, stepHeld, coinReads, dropped, ends };
  }

  it('spends on hit, kill, nthAttack, periodic and waveStart, each its share of the run’s shards', () => {
    // Planted bugs: a spend dropped on a targetless event (kill, periodic, waveStart); one that
    // lets the shards go below 0; shardsSpent counting other than what left the shards.
    const triggers: TriggerSpec[] = [
      { on: 'hit', do: [spend(0.001)] },
      { on: 'kill', do: [spend(0.002)] },
      { on: 'nthAttack', every: 4, do: [spend(0.01)] },
      { on: 'periodic', every: 0.5, do: [spend(0.05)] },
      { on: 'waveStart', do: [spend(0.2)] },
    ];
    const fractions = triggers.map((t) => (t.do[0] as { fraction: number }).fraction);
    const { sim, spends, shardWrites, dropped } = run(triggers);
    const origins = [...new Set(spends.filter((s) => s.before > 0).map((s) => s.origin))].sort();
    expect(origins).toEqual(triggers.map((_, i) => FIRST + i));
    let total = ZERO;
    for (const s of spends) {
      const spent = mul(s.before, fractions[s.origin - FIRST] as number);
      expect([s.after, s.to], `${s.tick}`).toEqual([sub(s.before, spent), add(s.from, spent)]);
      total = add(total, spent);
    }
    expect(shardWrites.every((x) => x >= 0)).toBe(true);
    expect(sim.state.shardsSpent).toBe(total);
    expect(toNumber(add(sim.state.shards, sim.state.shardsSpent))).toBeCloseTo(
      toNumber(dropped),
      6,
    );
    expect(toNumber(sim.state.shardsSpent)).toBeGreaterThan(0);
  });

  it('skips a liveTarget spend on a lethal hit, whose enemy is dead when the effects run, and pays a flagless one there (G5)', () => {
    // Planted bugs: liveTarget ignored, or read when the hit fires (before its kill), so 買斷
    // pays on the lethal hits its execute finds dead.
    const triggers: TriggerSpec[] = [
      { on: 'hit', do: [spend(0.01, true)] },
      { on: 'hit', do: [spend(0.01)] },
    ];
    const count = (spends: readonly Spend[]) => {
      const out: Record<string, number> = {};
      for (const s of spends) {
        const key = `${s.origin === FIRST ? 'live' : 'any'} on ${s.target}`;
        out[key] = (out[key] ?? 0) + 1;
      }
      return out;
    };
    // Every hit lethal: the flagged spend is never paid, the flagless one on every hit.
    const lethal = run(triggers, {}, 1e9);
    const lethalCount = count(lethal.spends);
    expect(Object.keys(lethalCount)).toEqual(['any on dead']);
    expect(lethalCount['any on dead']).toBeGreaterThan(10);
    // Hits that leave their enemy alive pay both; the lethal ones only the flagless.
    const struck = count(run(triggers, {}, 12).spends);
    expect(Object.keys(struck).sort()).toEqual(['any on dead', 'any on live', 'live on live']);
    expect(struck['live on live']).toBe(struck['any on live']);
  });

  it('never spends the wallet: shardsHeld is the wallet plus the shards left, from the next tick', () => {
    // Planted bugs: a spend taken from the wallet or the shards held; the spend shown in
    // shardsHeld before the next tick's step; the config's wallet changed.
    const walletShards = num(1e4);
    const config = { walletShards };
    const { sim, spends, stepHeld, coinReads, ends } = run(
      [{ on: 'nthAttack', every: 3, do: [spend(0.5), COIN] }],
      config,
    );
    expect(spends.length).toBeGreaterThan(10);
    let total = ZERO;
    for (const s of spends) {
      const spent = mul(s.before, 0.5);
      expect([s.after, s.to], `${s.tick}`).toEqual([sub(s.before, spent), add(s.from, spent)]);
      total = add(total, spent);
    }
    // Every tick's step: the wallet whole, plus the run's shards at the last tick's end.
    for (const [tick, value] of stepHeld) {
      expect(value, `${tick}`).toBe(toNumber(add(walletShards, num(ends[tick - 1] as number))));
    }
    // The coins read the step of their own tick, the spend before them not in it.
    expect(coinReads.length).toBeGreaterThan(10);
    for (const read of coinReads) expect(read.held).toBe(stepHeld.get(read.tick));
    expect(config.walletShards).toBe(walletShards);
    expect(sim.state.shardsSpent).toBe(total);
  });
});
