import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import { AURA_DEFAULTS } from '../../data/emitters';
import type { AuraGrant, SourcedEmitter } from '../../data/emitters';
import type { Modifier, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import { CHAIN_JUMP, PRIMARY, REPEAT, SIGNATURE } from '../effects/flags';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { EMITTER_STEPS, runEmitters } from '../systems/emitters';
import { rebuildGrid } from '../systems/grid';
import {
  eventsOf,
  makeConfig,
  makeStats,
  placedEnemies,
  rngPositions,
  stationarySquares,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import type { SimEvent } from '../types';
import { runAura } from './aura';
import { grantEmitter, periodTicks, PHASE_TICKS, shotsInFlight } from './types';
import type { AuraSpec, EmitterRuntime, Payload } from './types';

type PulseEvent = Extract<SimEvent, { type: 'pulse' }>;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y + dy,
  ...more,
});

/** The tags of an aura's hits. */
const AURA_TAGS = TAG.hit | TAG.aura;

const aura = (fields: Omit<AuraGrant, 'kind'> = {}): AuraGrant => ({ kind: 'aura', ...fields });
const on = (source: string, grant: SourcedEmitter['grant']): SourcedEmitter => ({ source, grant });

/** Damage 10 and no crits or ignites unless `values` say so: a default pulse hit deals 2.5. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };
/** Every roll a hit can draw at 0.5, crits at × 2. */
const HALF = {
  critChance: 0.5,
  critMultiplier: 2,
  igniteChance: 0.5,
  poisonChance: 0.5,
  bleedChance: 0.5,
  shockChance: 0.5,
};

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly mods?: readonly Modifier[];
  readonly grants?: readonly SourcedEmitter[];
  readonly modules?: readonly TestModule[];
}

/** placedEnemies with these grants (a default aura on outer.aura) over NO_ROLLS. */
function fixture(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, options.mods ?? [], {
      triggers: [],
      conversions: [],
      emitters: options.grants ?? [on('outer.aura', aura())],
    }),
    ...(options.modules === undefined ? {} : { modules: options.modules }),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const emitter = (ctx: RunContext, i = 1): EmitterRuntime => ctx.emitters[i] as EmitterRuntime;
const hp = (e: Enemy): number => toNumber(e.hp);
/** The enemies a hit has reached, by id: all start at 1e12 hp. */
const struck = (ctx: RunContext): number[] =>
  ctx.enemies.filter((e) => hp(e) < 1e12).map((e) => e.id);

/** The phase of the emitter at index `i`: it pulses on the ticks of this remainder by 15. */
const phase = (i: number): number => (3 + 4 * i) % PHASE_TICKS;
/** The tick of pulse `n` (1, 2, …) of the aura at index `i`, counting from tick 1. */
const pulseTick = (n: number, i = 1): number => (phase(i) || PHASE_TICKS) + PHASE_TICKS * (n - 1);

/** Runs aura emitter `i` on tick `tick`, its events alone in ctx.events. */
function auraAt(ctx: RunContext, tick: number, i = 1): void {
  ctx.now = tick;
  ctx.events.length = 0;
  runAura(ctx, emitter(ctx, i));
}

const pulses = (ctx: RunContext): PulseEvent[] => eventsOf([ctx.events], 'pulse');
/** [tick, hits, total] of each pulse event of aura `i` over ticks 1 to `ticks`, run every tick. */
function pulsesOver(ctx: RunContext, ticks: number, i = 1): [number, number, number][] {
  const seen: [number, number, number][] = [];
  for (let tick = 1; tick <= ticks; tick++) {
    auraAt(ctx, tick, i);
    for (const p of pulses(ctx)) seen.push([tick, p.hits, toNumber(p.total)]);
  }
  return seen;
}

/** A module that records [target id, tags, source, flags, depth, origin, amount] of each hit. */
function recorder(): { seen: number[][]; module: TestModule } {
  const seen: number[][] = [];
  const module: TestModule = (b) =>
    b.hook('onHit', (_ctx, hit) => {
      seen.push([
        hit.target.id,
        hit.mask,
        hit.source,
        hit.flags,
        hit.depth,
        hit.origin,
        toNumber(hit.amount),
      ]);
    });
  return { seen, module };
}

describe('aura: its emitter', () => {
  it('is granted with its defaults: tags hit and aura, crits and ailments, no everyNth and no corona', () => {
    expect(grantEmitter('outer.aura', { kind: 'aura' })).toEqual({
      kind: 'aura',
      signature: false,
      source: 'outer.aura',
      damagePct: AURA_DEFAULTS.damagePct,
      tags: AURA_TAGS,
      chains: false,
      rollsAilments: true,
      canCrit: true,
      everyNth: null,
      corona: null,
    });
    expect(AURA_DEFAULTS.damagePct).toBe(0.25);
    const full = aura({
      damagePct: 0.4,
      everyNth: { n: 4, mult: 4 },
      corona: { periodSec: 8, damagePct: 1 },
    });
    expect(grantEmitter('hub', full)).toMatchObject({
      source: 'hub',
      damagePct: 0.4,
      everyNth: { n: 4, mult: 4 },
      corona: { periodSec: 8, damagePct: 1 },
    });
    // It hits where it is: nothing in flight to count for targeting.
    expect(shotsInFlight(grantEmitter('outer.aura', aura()))).toBe(false);
  });

  it('takes PHASE_TICKS as interval at any attack speed, its own buffer, a pulse payload, and its corona payload as alt', () => {
    const ctx = fixture([], {
      values: { attackSpeed: 40 },
      grants: [
        on('outer.aura', aura({ corona: { periodSec: 8, damagePct: 2 } })),
        on('outer.thorns', { kind: 'thorns' }),
        on('hub', aura({ damagePct: 0.5 })),
      ],
    });
    const [volley, first, , second] = ctx.emitters as EmitterRuntime[];
    expect(ctx.emitters.map((em) => em.spec.kind)).toEqual(['volley', 'aura', 'thorns', 'aura']);
    expect(PHASE_TICKS).toBe(15);
    for (const em of [first, second] as EmitterRuntime[]) {
      expect([em.interval, em.timer, em.attacks]).toEqual([PHASE_TICKS, 0, 0]);
      expect(em.targets).toEqual([]);
      expect(em.payload.rng).toBe(ctx.combatRng);
      const p = em.payload;
      expect([p.aggregate, p.rollsAilments, p.canCrit, p.chains, p.flags, p.tags]).toEqual([
        true,
        true,
        true,
        false,
        0,
        AURA_TAGS,
      ]);
      expect([em.selector, em.chainPayload, em.orbs]).toEqual([null, null, null]);
    }
    expect(first?.targets).not.toBe(second?.targets);
    expect(toNumber((first as EmitterRuntime).payload.baseDamage)).toBe(2.5);
    expect(toNumber((second as EmitterRuntime).payload.baseDamage)).toBe(5);
    // The corona's: 25% × 2 of the damage stat, a pulse's payload like the aura's, its rows.
    const p = (first as EmitterRuntime).payload;
    const alt = first?.alt as Payload;
    expect(toNumber(alt.baseDamage)).toBe(5);
    expect(alt?.rows).toBe(p.rows);
    expect(alt?.rng).toBe(ctx.combatRng);
    expect([alt?.tags, alt?.source, alt?.flags, alt?.aggregate, alt?.rollsAilments]).toEqual([
      p.tags,
      p.source,
      0,
      true,
      true,
    ]);
    expect([alt?.canCrit, alt?.chains, alt?.damageMode]).toEqual([true, false, p.damageMode]);
    expect(second?.alt).toBeNull();
    // One shape for every kind.
    const keys = Object.keys(volley as EmitterRuntime);
    for (const em of ctx.emitters) expect(Object.keys(em)).toEqual(keys);
  });
});

describe('aura: one a source', () => {
  it('is one emitter per source, the first grant of it', () => {
    const ctx = fixture([at(50, 0)], {
      grants: [
        on('outer.aura', aura()),
        on('outer.aura', aura({ damagePct: 1, everyNth: { n: 2, mult: 2 } })),
        on('hub', aura({ damagePct: 0.5 })),
      ],
    });
    expect(
      ctx.emitters.map((em) => [em.spec.kind, em.spec.source, toNumber(em.payload.baseDamage)]),
    ).toEqual([
      ['volley', 'center', 10],
      ['aura', 'outer.aura', 2.5],
      ['aura', 'hub', 5],
    ]);
    expect((emitter(ctx).spec as AuraSpec).everyNth).toBeNull();
  });
});

describe('aura: its pulses', () => {
  it('pulses 4 times a second on its phase, (3 + 4 × its index) % 15, and counts its pulses', () => {
    const ctx = fixture([at(50, 0)], {
      grants: [on('outer.aura', aura()), on('outer.thorns', { kind: 'thorns' }), on('hub', aura())],
    });
    // Emitters: the volley, the aura at index 1 (phase 7), thorns, the aura at index 3 (phase 0).
    expect([phase(1), phase(3)]).toEqual([7, 0]);
    const pulsed = new Map<number, number[]>([
      [1, []],
      [3, []],
    ]);
    for (let tick = 1; tick <= 120; tick++) {
      ctx.now = tick;
      ctx.events.length = 0;
      runAura(ctx, emitter(ctx, 1));
      runAura(ctx, emitter(ctx, 3));
      for (const p of pulses(ctx)) pulsed.get(p.id)?.push(tick);
    }
    expect([...pulsed]).toEqual([
      [1, [7, 22, 37, 52, 67, 82, 97, 112]],
      [3, [15, 30, 45, 60, 75, 90, 105, 120]],
    ]);
    expect([emitter(ctx, 1).attacks, emitter(ctx, 3).attacks]).toEqual([8, 8]);
    expect(pulseTick(1)).toBe(7);
    expect(pulseTick(2, 3)).toBe(30);
  });

  it('hits every alive enemy within the auraRadius stat of the player once a pulse, in id order', () => {
    // 1 and 2 well inside; 3 on the edge, 160 away; 4 at 160.5; 5 dead, next to the player; 6 a
    // hexagon whose centre is 170 away (its radius does not count); 7 inside again.
    const placed = [
      at(100, 0),
      at(0, -159),
      at(-160, 0),
      at(0, 160.5),
      at(30, 0),
      at(0, 170, { type: 'hexagon' }),
      at(-60, 60),
    ];
    const run = (values: Partial<Record<StatId, number>> = {}) => {
      const ctx = fixture(placed, { values });
      enemy(ctx, 5).alive = false;
      rebuildGrid(ctx);
      auraAt(ctx, pulseTick(1));
      const em = emitter(ctx);
      return {
        struck: struck(ctx),
        hits: pulses(ctx).map((p) => p.hits),
        // Its within() output is the emitter's own buffer.
        targets: em.targets?.map((e) => e.id),
      };
    };
    expect(run()).toEqual({ struck: [1, 2, 3, 7], hits: [4], targets: [1, 2, 3, 7] });
    expect(run({ auraRadius: 200 })).toEqual({
      struck: [1, 2, 3, 4, 6, 7],
      hits: [6],
      targets: [1, 2, 3, 4, 6, 7],
    });
    expect(run({ auraRadius: 100 })).toEqual({ struck: [1, 7], hits: [2], targets: [1, 7] });
  });

  it('deals damagePct of the damage stat, tagged hit and aura, at depth 0 from origin −1, as one pulse event and no hit events', () => {
    const { seen, module } = recorder();
    const ctx = fixture([at(100, 0), at(0, 50), at(-120, 0)], {
      grants: [on('outer.aura', aura({ damagePct: 0.4 }))],
      modules: [module],
    });
    const source = ctx.sources.index('outer.aura');
    const serial = ctx.attackSerial;
    auraAt(ctx, pulseTick(1));
    expect(ctx.events.map((event) => event.type)).toEqual(['pulse']);
    const [pulse] = pulses(ctx);
    expect({ ...pulse, total: toNumber((pulse as PulseEvent).total) }).toEqual({
      type: 'pulse',
      kind: 'aura',
      id: 1,
      hits: 3,
      total: 12,
      crits: [],
    });
    // Not an attack: no SIGNATURE, PRIMARY, REPEAT or CHAIN_JUMP on its hits.
    const bits = SIGNATURE | PRIMARY | REPEAT | CHAIN_JUMP;
    expect(
      seen.map(([id, mask, src, flags, depth, origin, amount]) => [
        id,
        mask,
        src,
        (flags as number) & bits,
        depth,
        origin,
        amount,
      ]),
    ).toEqual([
      [1, AURA_TAGS, source, 0, 0, -1, 4],
      [2, AURA_TAGS, source, 0, 0, -1, 4],
      [3, AURA_TAGS, source, 0, 0, -1, 4],
    ]);
    expect(ctx.attackSerial).toBe(serial);
    // Its damage rows: an aura-tagged more applies, a projectile-tagged one does not.
    const moreAura = fixture([at(100, 0)], {
      mods: [
        { stat: 'damage', kind: 'more', value: 1, tags: ['aura'] },
        { stat: 'damage', kind: 'more', value: 4, tags: ['projectile'] },
      ],
    });
    auraAt(moreAura, pulseTick(1));
    expect(pulses(moreAura).map((p) => toNumber(p.total))).toEqual([5]);
  });

  it('raises no pulse event for a pulse that hit nothing, and still counts it', () => {
    const ctx = fixture([at(300, 0), at(0, 50)]);
    enemy(ctx, 2).alive = false;
    rebuildGrid(ctx);
    auraAt(ctx, pulseTick(1));
    expect(ctx.events).toEqual([]);
    expect(emitter(ctx).attacks).toBe(1);
  });

  it("hits none of the children its hits' kills split into in the same pulse", () => {
    // 1, a pentagon of 1 hp, dies to the pulse's first hit and splits next to the player; its
    // shards were not in the pulse's list, so only 2 is hit after it.
    const ctx = fixture([at(40, 0, { type: 'pentagon', hp: 1 }), at(-40, 0)]);
    auraAt(ctx, pulseTick(1));
    const children = ctx.enemies.slice(2);
    expect(children.length).toBeGreaterThan(0);
    expect(pulses(ctx).map((p) => p.hits)).toEqual([2]);
    expect(children.map(hp)).toEqual(children.map((child) => toNumber(child.maxHp)));
    // The next pulse hits them.
    auraAt(ctx, pulseTick(2));
    expect(pulses(ctx).map((p) => p.hits)).toEqual([1 + children.length]);
  });
});

describe('aura: its rolls (Q4 (B))', () => {
  it('rolls crit, ignite, poison, bleed and shock per enemy in within order, on the combat stream', () => {
    // Ids 1 to 5 at 100, 20, 60, 140 and 40 from the player: id order, not distance order.
    const placed = [100, 20, 60, 140, 40].map((d) => at(d, 0));
    const ctx = fixture(placed, { values: HALF });
    const twin = fixture(placed, { values: HALF });
    expect(ctx.rollsDots).toBe(true);
    const before = rngPositions(ctx);
    auraAt(ctx, pulseTick(1));
    const [pulse] = pulses(ctx);
    expect(pulse?.hits).toBe(5);
    // The twin replays the pulse's draws: per enemy, its crit, ignite, poison, bleed and shock.
    const rolls = Array.from({ length: 25 }, () => twin.combatRng.chance(0.5));
    expect(rngPositions(ctx)).toEqual(rngPositions(twin));
    expect(rngPositions(ctx).combat).not.toEqual(before.combat);
    expect(new Set(rolls)).toEqual(new Set([true, false]));
    ctx.enemies.forEach((e, k) => {
      const [crit, ignite, poison, bleed, shock] = rolls.slice(5 * k, 5 * k + 5);
      expect(pulse?.crits.includes(e.id), `enemy ${e.id}`).toBe(crit);
      expect(1e12 - hp(e), `enemy ${e.id}`).toBe(crit ? 5 : 2.5);
      expect([e.burnStacks, e.poisonStacks, e.bleedUntil > 0, e.shockStacks]).toEqual([
        ignite ? 1 : 0,
        poison ? 1 : 0,
        bleed,
        shock ? 1 : 0,
      ]);
    });
  });

  it('lists in each pulse event the enemies that pulse or corona crit, and none of an earlier one (§4.13)', () => {
    // Every hit crits (a chance of 1 draws nothing): pulses on ticks 7, 22 and 37, coronas on 15,
    // 30 and 45, each hitting the three, so each event lists the three once.
    const placed = [at(30, 0), at(0, 60), at(-90, 0)];
    const ctx = fixture(placed, {
      values: { critChance: 1, critMultiplier: 2 },
      grants: [on('outer.aura', aura({ corona: { periodSec: 0.25, damagePct: 1 } }))],
    });
    const seen: [number, number, number[]][] = [];
    for (let tick = 1; tick <= 45; tick++) {
      auraAt(ctx, tick);
      for (const p of pulses(ctx)) seen.push([tick, p.hits, [...p.crits]]);
    }
    expect(seen).toEqual(
      [7, 15, 22, 30, 37, 45].map((tick) => [tick, 3, [1, 2, 3]] as [number, number, number[]]),
    );
  });
});

describe('aura: 聚能脈衝 (everyNth, F6)', () => {
  it('does nothing on pulses 1–3, no query, hit, event or draw; pulse 4 hits × 4 with one roll set per enemy', () => {
    const values = { critChance: 0.5, critMultiplier: 2, igniteChance: 0.5 };
    const placed = [at(100, 0), at(0, 50), at(-30, -30)];
    const grants = [on('outer.aura', aura({ everyNth: { n: 4, mult: 4 } }))];
    const ctx = fixture(placed, { values, grants });
    const twin = fixture(placed, { values, grants });
    const em = emitter(ctx);
    const before = rngPositions(ctx);
    for (let n = 1; n <= 3; n++) {
      auraAt(ctx, pulseTick(n));
      expect(ctx.events, `pulse ${n}`).toEqual([]);
      expect(em.attacks).toBe(n);
    }
    expect(rngPositions(ctx)).toEqual(before);
    expect(struck(ctx)).toEqual([]);
    // No query either: its buffer was never filled.
    expect(em.targets).toEqual([]);
    auraAt(ctx, pulseTick(4));
    const [pulse] = pulses(ctx);
    expect(pulse?.hits).toBe(3);
    // One roll set per enemy, its crit and ignite.
    const rolls = Array.from({ length: 6 }, () => twin.combatRng.chance(0.5));
    expect(rngPositions(ctx)).toEqual(rngPositions(twin));
    ctx.enemies.forEach((e, k) => {
      const [crit, ignite] = rolls.slice(2 * k, 2 * k + 2);
      // × 4: 2.5 × 4 a hit, × 2 on a crit.
      expect(1e12 - hp(e), `enemy ${e.id}`).toBe(crit ? 20 : 10);
      expect(pulse?.crits.includes(e.id)).toBe(crit);
      expect(e.burnStacks).toBe(ignite ? 1 : 0);
    });
    // Pulses 5–7 do nothing again, and the 8th hits.
    for (let n = 5; n <= 7; n++) {
      auraAt(ctx, pulseTick(n));
      expect(ctx.events, `pulse ${n}`).toEqual([]);
    }
    auraAt(ctx, pulseTick(8));
    expect(pulses(ctx).map((p) => p.hits)).toEqual([3]);
    expect(em.attacks).toBe(8);
  });

  it('deals in 4 merged pulses what 4 plain pulses deal, and in n pulses × mult for any n', () => {
    const placed = [at(100, 0), at(0, 50), at(-30, -30)];
    const dealt = (grant: AuraGrant, count: number): { total: number; events: number } => {
      const ctx = fixture(placed, { grants: [on('outer.aura', grant)] });
      let total = 0;
      let events = 0;
      for (let n = 1; n <= count; n++) {
        auraAt(ctx, pulseTick(n));
        for (const p of pulses(ctx)) {
          total += toNumber(p.total);
          events++;
        }
      }
      return { total, events };
    };
    // A plain pulse deals 3 × 2.5.
    expect(dealt(aura(), 4)).toEqual({ total: 30, events: 4 });
    expect(dealt(aura({ everyNth: { n: 4, mult: 4 } }), 4)).toEqual({ total: 30, events: 1 });
    expect(dealt(aura({ everyNth: { n: 4, mult: 4 } }), 12)).toEqual({ total: 90, events: 3 });
    // mult need not be n: 3 pulses merged at × 2 deal what 2 plain pulses do.
    expect(dealt(aura({ everyNth: { n: 3, mult: 2 } }), 9)).toEqual({ total: 45, events: 3 });
    expect(dealt(aura({ everyNth: { n: 2, mult: 2 } }), 3)).toEqual({ total: 15, events: 1 });
  });
});

describe('aura: 日冕 (corona, F7)', () => {
  it('hits every alive enemy of the run every periodSec at aura.damagePct × corona.damagePct, wherever it is', () => {
    // 1 within the aura's radius of 50; 2 far outside it; 3 dead.
    const ctx = fixture([at(30, 0), at(600, 300), at(-40, 0)], {
      values: { auraRadius: 50 },
      grants: [on('outer.aura', aura({ corona: { periodSec: 1, damagePct: 2 } }))],
    });
    enemy(ctx, 3).alive = false;
    rebuildGrid(ctx);
    const em = emitter(ctx);
    expect(periodTicks(1 / 1)).toBe(60);
    // Pulses on its phase hit 1 alone for 2.5; the coronas at 60 and 120 hit 1 and 2 for
    // 10 × 0.25 × 2 = 5 each.
    expect(pulsesOver(ctx, 130)).toEqual([
      [7, 1, 2.5],
      [22, 1, 2.5],
      [37, 1, 2.5],
      [52, 1, 2.5],
      [60, 2, 10],
      [67, 1, 2.5],
      [82, 1, 2.5],
      [97, 1, 2.5],
      [112, 1, 2.5],
      [120, 2, 10],
      [127, 1, 2.5],
    ]);
    expect([em.attacks, em.timer]).toEqual([9, 10]);
    expect(hp(enemy(ctx, 3))).toBe(1e12);
    // 日冕's 8 s: its first corona on tick 480.
    const slow = fixture([at(600, 300)], {
      grants: [on('outer.aura', aura({ corona: { periodSec: 8, damagePct: 1 } }))],
    });
    expect(pulsesOver(slow, 500)).toEqual([[480, 1, 2.5]]);
  });

  it('neither reads nor advances the pulse count', () => {
    const ctx = fixture([at(30, 0), at(600, 300)], {
      values: { auraRadius: 50 },
      grants: [
        on(
          'outer.aura',
          aura({ everyNth: { n: 4, mult: 4 }, corona: { periodSec: 0.25, damagePct: 1 } }),
        ),
      ],
    });
    expect(periodTicks(1 / 0.25)).toBe(15);
    // Coronas every 15 ticks hit both for 2.5; the merged pulse, the 4th, hits 1 for 10.
    expect(pulsesOver(ctx, 60)).toEqual([
      [15, 2, 5],
      [30, 2, 5],
      [45, 2, 5],
      [52, 1, 10],
      [60, 2, 5],
    ]);
    expect(emitter(ctx).attacks).toBe(4);
  });

  it('rolls its hits as a pulse’s, on the combat stream', () => {
    const values = { critChance: 0.5, critMultiplier: 2, igniteChance: 0.5 };
    // All outside the aura's 160: only the corona reaches them.
    const placed = [at(400, 0), at(-400, 0), at(0, 300), at(0, -300)];
    const grants = [on('outer.aura', aura({ corona: { periodSec: 1, damagePct: 1 } }))];
    const ctx = fixture(placed, { values, grants });
    const twin = fixture(placed, { values, grants });
    for (let tick = 1; tick < 60; tick++) auraAt(ctx, tick);
    expect(rngPositions(ctx)).toEqual(rngPositions(twin));
    auraAt(ctx, 60);
    const [corona] = pulses(ctx);
    expect(corona?.hits).toBe(4);
    const rolls = Array.from({ length: 8 }, () => twin.combatRng.chance(0.5));
    expect(rngPositions(ctx)).toEqual(rngPositions(twin));
    expect(new Set(rolls)).toEqual(new Set([true, false]));
    ctx.enemies.forEach((e, k) => {
      const [crit, ignite] = rolls.slice(2 * k, 2 * k + 2);
      expect(corona?.crits.includes(e.id), `enemy ${e.id}`).toBe(crit);
      expect(1e12 - hp(e), `enemy ${e.id}`).toBe(crit ? 5 : 2.5);
      expect(e.burnStacks).toBe(ignite ? 1 : 0);
    });
  });

  it('comes after the pulse of its tick, in a pulse event of its own, and hits no enemy a hit of it adds', () => {
    const ctx = fixture([at(30, 0), at(600, 300, { type: 'pentagon', hp: 1 })], {
      values: { auraRadius: 50 },
      grants: [on('outer.aura', aura({ corona: { periodSec: 1, damagePct: 2 } }))],
    });
    const em = emitter(ctx);
    em.timer = 59;
    auraAt(ctx, pulseTick(1));
    expect(pulses(ctx).map((p) => [p.kind, p.id, p.hits, toNumber(p.total)])).toEqual([
      ['aura', 1, 1, 2.5],
      ['aura', 1, 2, 10],
    ]);
    expect([em.timer, em.attacks]).toEqual([0, 1]);
    // 2 died and split; its shards came after the corona counted the enemies.
    const children = ctx.enemies.slice(2);
    expect(children.length).toBeGreaterThan(0);
    expect(children.map(hp)).toEqual(children.map((child) => toNumber(child.maxHp)));
    // A corona that hits nothing raises nothing.
    const empty = fixture([], {
      grants: [on('outer.aura', aura({ corona: { periodSec: 1, damagePct: 2 } }))],
    });
    expect(pulsesOver(empty, 60)).toEqual([]);
    expect(emitter(empty).timer).toBe(0);
  });

  it('carries the part of a tick its period leaves over: 0.375 s fires 23 and 22 ticks apart', () => {
    // periodTicks(1 / 0.375) is 22.5 ticks: the timer keeps what is left after each corona, as a
    // strike's and a segment's do. The enemy stands beyond the pulses' radius, so only the
    // coronas raise events.
    const ctx = fixture([at(500, 0)], {
      grants: [on('outer.aura', aura({ corona: { periodSec: 0.375, damagePct: 1 } }))],
    });
    expect(periodTicks(1 / 0.375)).toBe(22.5);
    expect(pulsesOver(ctx, 120).map(([tick]) => tick)).toEqual([23, 45, 68, 90, 113]);
  });
});

describe('aura: the emitter stage', () => {
  it('is stepped after the signature, in emitter order, and pulses on its phase in a run at any attack speed', () => {
    expect(EMITTER_STEPS.aura).toBe(runAura);
    const ctx = fixture([at(50, 0)], { values: { projectileCount: 1 } });
    const [signature, em] = ctx.emitters as EmitterRuntime[];
    // Both due on this tick.
    (signature as EmitterRuntime).acc = (signature as EmitterRuntime).interval - 1;
    ctx.now = pulseTick(1);
    ctx.events.length = 0;
    runEmitters(ctx);
    expect(ctx.events.map((event) => event.type)).toEqual(['attack', 'pulse']);
    expect(em?.attacks).toBe(1);

    const pulseTicks = (attackSpeed: number): number[] => {
      const stats = makeStats({ ...NO_ROLLS, attackSpeed, auraRadius: 5000 }, [], {
        triggers: [],
        conversions: [],
        emitters: [on('outer.aura', aura())],
      });
      const sim = createSimulation(makeConfig({ stats, maxTicks: 70 }), stationarySquares(3));
      const ticks: number[] = [];
      while (!sim.state.finished) {
        for (const event of sim.step(NO_INPUT)) {
          if (event.type === 'pulse' && event.kind === 'aura') ticks.push(sim.state.tick);
        }
      }
      return ticks;
    };
    expect(pulseTicks(1)).toEqual([7, 22, 37, 52, 67]);
    expect(pulseTicks(20)).toEqual([7, 22, 37, 52, 67]);
  });
});
