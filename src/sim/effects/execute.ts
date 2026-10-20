/**
 * The effect phase (docs/v3/implementation-plan-v3.md §2.6, §2.15): due periodic triggers fire,
 * then up to EFFECTS_PER_TICK queued effects run in queue order; effects queued meanwhile join
 * the tail. Each effect kind has its executor in EFFECTS, typed over EffectKind, so a kind added
 * to the vocabulary does not compile without one. An effect on its event's enemy does nothing
 * once that enemy is dead; area effects start at the event's position. A trigger's selector
 * (select.ts) puts the enemy it picked in the entry's target, and area effects center on that
 * enemy instead, or on the player for a 'player' pick (CompiledEffect.atTarget, atPlayer). An
 * area capped by maxTargets reaches the first enemies in id order, or the nearest with order
 * 'nearest' (orderNearest).
 *
 * Effect hits go through hitWithPayload like any hit, with the effect's payload (its tags and
 * source, the effects stream, no flags) at the entry's depth and origin, so their kills and
 * triggers follow the same rules. A shatter's hits (SHATTER_TRIGGER) take the payload of the
 * source its entry is credited to, and deal their share of the victim's max life. Area queries
 * write to ctx.effectTargets, which nothing an executor's hits reach writes while it walks them:
 * effects never nest, transfers at a kill use ctx.spreadTargets, and a freeze takes its list
 * from ctx.centerEvents.freezeTargets into the center-event scratch, whose triggers and hooks
 * only queue (src/sim/effects/centerEvents.ts).
 *
 * A repeatAttack makes the signature attack again (REPEAT_STEPS), as no attack of its own, on
 * its effect's repeat payload (RunContext.sys.repeat: the signature's, flagged SIGNATURE and
 * REPEAT, on the effects stream): at once, or, with timing 'nextAttack', right after the
 * attack's next own firing (drainRepeatCharges), at most REPEAT_CHARGE_CAP waiting. An entry
 * whose event came from a repeat's hit (REPEAT) repeats nothing (rule 7).
 *
 * A detonate takes its share of the damage an ailment has left on its live target
 * (src/sim/ailments/remaining.ts) and deals it at once, as it is (PRESCALED); on a kill trigger,
 * whose target is dead, it deals that share of what the victim had left, its entry's value
 * (recordPendingKills, dispatch.ts), and consumes nothing.
 *
 * A projectiles effect spawns its small projectiles in the shot pool (src/sim/systems/shots.ts),
 * through spawnShot and PROJECTILE_CAP, from the event's point or the player: homing at its
 * live target or at the nearest enemies, or straight out around its start or in a fan at its
 * target. They carry the entry's depth and origin and are no attack: round −1 (never a fan
 * round's primary) and owner −1. They count nothing in Enemy.inbound.
 *
 * A slashLine cuts a line `length` long from the event's point, or from its live target, away
 * from the player, at the alive enemy nearest to its start (but one right on it), at the live
 * target, or on along a chain jump, at the angle its chainJump event carries as its value;
 * without a direction it does nothing. Its slash event comes before its hits. It hits
 * once each, in id order, the enemies within half its width and their radius of the line: those
 * whose centre lies in the line's box grown by half the width and ctx.shotPad
 * (grid.inSegmentBox), then the tough ones outside the box, whose radius is larger than the pad,
 * from the grid's marked list (as a straight shot's path, shots.ts). With alwaysCrit its hits
 * crit whatever their roll, which is drawn all the same. A coinHit hits its live target once,
 * after its coin event; its payload carries the bypass bits (Payload.bypass).
 *
 * A chainBolt is an attack of its own (beginAttack, src/sim/combat/chain.ts) on its live target,
 * or on the alive enemy nearest the event's point within the chain range: its first hit, which
 * counts 1 in its chain budget, then exactly `jumps` jumps on the general chain path
 * (chainGeneral, src/sim/combat/policy.ts) without a policy. Its payload shocks each enemy a
 * jump leaves alive (Payload.shockOnHit), and the executor its first one alike.
 */

import type { Num } from '../../core/num';
import { add, gt, mul, num, toNumber, ZERO } from '../../core/num';
import type { SignatureId } from '../../data/rules';
import type { AppliedAilment } from '../../data/triggers';
import {
  ailmentDps,
  applyBurn,
  applyPoison,
  creditOf,
  spreadBurn,
  spreadPoison,
} from '../ailments/apply';
import { addBleed } from '../ailments/bleed';
import { addFrost } from '../ailments/frost';
import { consumeAilment, remainingOf } from '../ailments/remaining';
import { addShock } from '../ailments/shock';
import { sizeOf } from '../build/size';
import { REPEAT_CHARGE_CAP, SMALL_PROJECTILE_TICKS } from '../caps';
import { beginAttack, endAttack } from '../combat/chain';
import { hitWithPayload } from '../combat/hit';
import { chainGeneral } from '../combat/policy';
import { fireArcRepeat } from '../emitters/arc';
import { fireFanRepeat } from '../emitters/fan';
import { fireLobRepeat } from '../emitters/lob';
import { createPayload, PCT_MAX_HP, SLOT_BLEED, SLOT_BURN, SLOT_POISON } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import { fireVolleyRepeat } from '../emitters/volley';
import type { Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
import { MOTION_HOMING, MOTION_STRAIGHT, spawnShot } from '../systems/shots';
import { addZone, PULSES_PER_SECOND } from '../systems/zones';
import { raiseFreeze } from './centerEvents';
import { fireApplied, fireOne } from './dispatch';
import { REPEAT } from './flags';
import { dequeue } from './queue';
import type { EffectEntry } from './queue';
import { orderNearest } from './select';
import { EFFECTS_PER_TICK, EVENT } from './types';
import type {
  CompiledEffect,
  CompiledEffectKind,
  CompiledEffectSpec,
  CompiledTrigger,
} from './types';

type Executor<K extends CompiledEffectKind> = (
  ctx: RunContext,
  spec: Extract<CompiledEffectSpec, { kind: K }>,
  fx: CompiledEffect,
  entry: Readonly<EffectEntry>,
) => void;

/** The event's enemy, if it is still alive. */
const liveTarget = (entry: Readonly<EffectEntry>): Enemy | null =>
  entry.target !== null && entry.target.alive ? entry.target : null;

/** Writes the alive enemies within the effect's radius of (x, y) to ctx.effectTargets. */
const within = (ctx: RunContext, fx: CompiledEffect, x: number, y: number): number =>
  ctx.grid.within(x, y, fx.radiusSq, ctx.effectTargets);

/**
 * within, then at most `max` of them: the first in id order, or with `nearest` the nearest to
 * (x, y), nearest first. Returns how many ctx.effectTargets holds.
 */
function inArea(
  ctx: RunContext,
  fx: CompiledEffect,
  x: number,
  y: number,
  max: number,
  nearest: boolean,
): number {
  const count = within(ctx, fx, x, y);
  if (count <= max) return count;
  return nearest ? orderNearest(ctx.effectTargets, count, max, x, y) : max;
}

/**
 * Where an area effect centers: on the enemy its trigger's selector picked (atTarget), where it
 * is now or was when it died; on the player for a 'player' pick; else at the event's point.
 */
const centerX = (ctx: RunContext, fx: CompiledEffect, entry: Readonly<EffectEntry>): number =>
  fx.atTarget && entry.target !== null ? entry.target.x : fx.atPlayer ? ctx.player.x : entry.x;
const centerY = (ctx: RunContext, fx: CompiledEffect, entry: Readonly<EffectEntry>): number =>
  fx.atTarget && entry.target !== null ? entry.target.y : fx.atPlayer ? ctx.player.y : entry.y;

/**
 * `stacks` stacks of `ailment` from payload `p` on `enemy`, each as a hit of damage `base` would
 * apply it, through p's rows and credit (bleed keeps the strongest, so more stacks add nothing),
 * then its ailmentApplied event, at `depth` from trigger `origin`. The applyAilment executor
 * passes its payload's base damage; a zone's poison, bleed or shock term, its payload's base ×
 * ailmentDamagePct (src/sim/systems/zones.ts, whose burn term takes applyBurnTerm instead).
 */
export function applyStacks(
  ctx: RunContext,
  ailment: AppliedAilment,
  enemy: Enemy,
  p: Payload,
  base: Num,
  stacks: number,
  depth: number,
  origin: number,
): void {
  const now = ctx.now;
  let applied = true;
  switch (ailment) {
    case 'burn': {
      const dps = ailmentDps(ctx, enemy, p, SLOT_BURN, base, ctx.burnDamage);
      applyBurn(ctx, enemy, dps, now + ctx.burnTicks, depth, creditOf(ctx, 'burn', p), stacks);
      break;
    }
    case 'poison': {
      const dps = ailmentDps(ctx, enemy, p, SLOT_POISON, base, ctx.poisonDamage);
      applyPoison(
        ctx,
        enemy,
        dps,
        now + ctx.poisonTicks,
        depth,
        creditOf(ctx, 'poison', p),
        stacks,
      );
      break;
    }
    case 'bleed': {
      const dps = ailmentDps(ctx, enemy, p, SLOT_BLEED, base, ctx.bleedDamage);
      const source = creditOf(ctx, 'bleed', p);
      applied = addBleed(ctx, enemy, dps, now + ctx.bleedTicks, depth, source);
      if (applied) {
        ctx.events.push({ type: 'ailmentApplied', targetId: enemy.id, ailment, stacks: 1 });
      }
      break;
    }
    case 'shock':
      applied = addShock(ctx, enemy, stacks, depth);
      if (applied) {
        const shock = enemy.shockStacks;
        ctx.events.push({ type: 'ailmentApplied', targetId: enemy.id, ailment, stacks: shock });
      }
      break;
  }
  if (applied && ctx.appliedListeners) fireApplied(ctx, enemy, ailment, depth, origin, 0);
}

/** Ticks the ailment lasts once applied; nothing is applied without any. */
export const durationOf = (ctx: RunContext, ailment: AppliedAilment): number =>
  ailment === 'burn'
    ? ctx.burnTicks
    : ailment === 'poison'
      ? ctx.poisonTicks
      : ailment === 'bleed'
        ? ctx.bleedTicks
        : ctx.shockTicks;

/**
 * Every alive enemy within the effect's radius of (x, y), at most `max` (inArea), is hit, in id
 * order or with `nearest` nearest first.
 */
function hitArea(
  ctx: RunContext,
  fx: CompiledEffect,
  entry: Readonly<EffectEntry>,
  x: number,
  y: number,
  max: number,
  nearest: boolean,
): void {
  const p = ctx.effectPayloads[entry.effect] as Payload;
  const targets = ctx.effectTargets;
  const count = inArea(ctx, fx, x, y, max, nearest);
  for (let i = 0; i < count; i++) {
    const enemy = targets[i] as Enemy;
    if (enemy.alive) {
      hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, entry.depth, entry.origin);
    }
  }
}

/**
 * `amount` of frost credited to `source` on `enemy`, which may freeze it; the freeze is raised
 * at `depth` from trigger `origin`.
 */
export function frostOne(
  ctx: RunContext,
  enemy: Enemy,
  amount: number,
  source: number,
  depth: number,
  origin: number,
): void {
  if (addFrost(ctx, enemy, amount, source)) raiseFreeze(ctx, enemy, depth, origin, 0);
}

/**
 * The payload of shatter hits credited to `source`, from the shatter effect `fx`: no crit, no
 * ailments, no flags; filled on first use (RunContext.shatterPayloads).
 */
function shatterPayload(ctx: RunContext, fx: CompiledEffect, source: number): Payload {
  const cached = ctx.shatterPayloads[source];
  if (cached !== undefined && cached !== null) return cached;
  const payload = createPayload({
    baseDamage: fx.baseDamage,
    tags: fx.tags,
    source,
    flags: 0,
    rng: ctx.effectsRng,
    chains: false,
    rollsAilments: false,
    canCrit: false,
    damageMode: PCT_MAX_HP,
  });
  ctx.shatterPayloads[source] = payload;
  return payload;
}

/**
 * The alive enemies nearest to (x, y), at most `max`, nearest first, ties to the lower id, into
 * ctx.shots.distinct; returns how many it holds.
 */
function nearestAlive(ctx: RunContext, max: number, x: number, y: number): number {
  const out = ctx.shots.distinct;
  const enemies = ctx.enemies;
  let n = 0;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Enemy;
    if (enemy.alive) out[n++] = enemy;
  }
  return orderNearest(out, n, max, x, y);
}

/**
 * Enemies within this squared distance of a slash's start give it no direction: 'nearest' runs
 * at the nearest one farther out, so a slash from the event's enemy never aims at that enemy.
 */
const SLASH_START_SQ = 1;

/**
 * The alive enemy nearest to (x, y) farther than SLASH_START_SQ from it, ties to the lower id
 * (ctx.enemies is in id order); null for none.
 */
function nearestFrom(ctx: RunContext, x: number, y: number): Enemy | null {
  const enemies = ctx.enemies;
  let best: Enemy | null = null;
  let bestSq = Infinity;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Enemy;
    if (!enemy.alive) continue;
    const dx = enemy.x - x;
    const dy = enemy.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq > SLASH_START_SQ && distSq < bestSq) {
      best = enemy;
      bestSq = distSq;
    }
  }
  return best;
}

/**
 * The alive enemies a slash from (ax, ay) to (bx, by) may reach, into ctx.effectTargets in id
 * order; returns how many. Those whose centre lies in the line's bounding box grown by `pad`
 * (grid.inSegmentBox), then the tough ones whose centre lies outside it (grid.marked): their
 * radius can be larger than the pad, so no enemy within reach is left out, and none is listed
 * twice.
 */
function slashTargets(
  ctx: RunContext,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  pad: number,
): number {
  const grid = ctx.grid;
  const out = ctx.effectTargets;
  let count = grid.inSegmentBox(ax, ay, bx, by, pad, out);
  // The box of inSegmentBox, bound for bound.
  const minX = Math.min(ax, bx) - pad;
  const maxX = Math.max(ax, bx) + pad;
  const minY = Math.min(ay, by) - pad;
  const maxY = Math.max(ay, by) + pad;
  const marked = grid.markedCount();
  for (let k = 0; k < marked; k++) {
    const enemy = grid.marked(k);
    if (!enemy.tough || !enemy.alive) continue;
    const x = enemy.x;
    const y = enemy.y;
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue;
    out[count++] = enemy;
  }
  // Two runs, each in id order: an insertion sort merges them.
  for (let i = 1; i < count; i++) {
    const enemy = out[i] as Enemy;
    let j = i - 1;
    while (j >= 0 && (out[j] as Enemy).id > enemy.id) {
      out[j + 1] = out[j] as Enemy;
      j--;
    }
    out[j + 1] = enemy;
  }
  return count;
}

/**
 * Squared distance from (px, py) to the segment from (ax, ay) to (bx, by), ends included: to
 * the nearer end when the point lies beyond it, else to the line (the cross product over the
 * length). The segment stage's links share it (src/sim/systems/segments.ts).
 */
export function segDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const toAx = px - ax;
  const toAy = py - ay;
  if (dx * toAx + dy * toAy <= 0) return toAx * toAx + toAy * toAy;
  const toBx = px - bx;
  const toBy = py - by;
  if (dx * toBx + dy * toBy >= 0) return toBx * toBx + toBy * toBy;
  const cross = dx * toAy - dy * toAx;
  return (cross * cross) / (dx * dx + dy * dy);
}

/**
 * A repeat of the signature attack: emitter `em`'s attack again with payload `p`, as no attack
 * of its own, its hits at `depth` from trigger `origin`.
 */
type RepeatStep = (
  ctx: RunContext,
  em: EmitterRuntime,
  p: Payload,
  depth: number,
  origin: number,
) => void;

/**
 * Each signature's repeat, typed over the signature ids, so a new signature needs its entry
 * here. Read at this module's top level, inside the import cycle it shares with the emitters:
 * every entry must be a function declaration (docs/v3 C4 design §0.7).
 */
export const REPEAT_STEPS: { readonly [K in SignatureId]: RepeatStep } = {
  m1Volley: fireVolleyRepeat,
  magmaBomb: fireLobRepeat,
  iceFan: fireFanRepeat,
  triphaseArc: fireArcRepeat,
};

/**
 * Fires the repeats waiting for the signature attack's next own firing, oldest first, each with
 * its own payload, depth and origin: right after each counted attack of `em`, the signature
 * (runVolley, runLob, runFan, runArc).
 */
export function drainRepeatCharges(ctx: RunContext, em: EmitterRuntime): void {
  const charges = ctx.sys.repeat.charges;
  if (charges.count === 0) return;
  const step = REPEAT_STEPS[ctx.build.signature.id];
  while (charges.count > 0) {
    const at = charges.head;
    const p = charges.payload[at] as Payload;
    const depth = charges.depth[at] as number;
    const origin = charges.origin[at] as number;
    charges.payload[at] = null;
    charges.head = (at + 1) % REPEAT_CHARGE_CAP;
    charges.count--;
    step(ctx, em, p, depth, origin);
  }
}

const EFFECTS: { readonly [K in CompiledEffectKind]: Executor<K> } = {
  applyAilment(ctx, spec, fx, entry) {
    const ailment = spec.ailment;
    if (durationOf(ctx, ailment) <= 0) return;
    const p = ctx.effectPayloads[entry.effect] as Payload;
    const stacks = spec.stacks ?? 1;
    if (spec.radius === undefined) {
      const target = liveTarget(entry);
      if (target !== null) {
        applyStacks(ctx, ailment, target, p, p.baseDamage, stacks, entry.depth, entry.origin);
      }
      return;
    }
    const targets = ctx.effectTargets;
    const max = spec.maxTargets ?? Infinity;
    const nearest = spec.order === 'nearest';
    const count = inArea(ctx, fx, centerX(ctx, fx, entry), centerY(ctx, fx, entry), max, nearest);
    const { depth, origin } = entry;
    for (let i = 0; i < count; i++) {
      applyStacks(ctx, ailment, targets[i] as Enemy, p, p.baseDamage, stacks, depth, origin);
    }
  },
  spreadAilment(ctx, spec, fx, entry) {
    const target = liveTarget(entry);
    if (target === null || fx.spread === null) return;
    if (spec.ailment === 'burn') spreadBurn(ctx, target, fx.spread, entry.depth);
    else {
      const sf = spec.stacks ?? 1;
      const max = spec.maxTargets ?? Infinity;
      spreadPoison(ctx, target, fx.spread, sf, max, entry.depth, spec.order === 'nearest');
    }
  },
  explode(ctx, spec, fx, entry) {
    const max = spec.maxTargets ?? Infinity;
    const nearest = spec.order === 'nearest';
    const x = centerX(ctx, fx, entry);
    const y = centerY(ctx, fx, entry);
    ctx.events.push({ type: 'burst', kind: 'explode', x, y, radius: spec.radius });
    hitArea(ctx, fx, entry, x, y, max, nearest);
  },
  nova(ctx, spec, fx, entry) {
    const atEvent = spec.at === 'event';
    const player = ctx.player;
    const x = atEvent ? centerX(ctx, fx, entry) : player.x;
    const y = atEvent ? centerY(ctx, fx, entry) : player.y;
    ctx.events.push({ type: 'burst', kind: 'nova', x, y, radius: spec.radius });
    hitArea(ctx, fx, entry, x, y, Infinity, false);
  },
  push(ctx, spec, fx, entry) {
    const player = ctx.player;
    const targets = ctx.effectTargets;
    const count = within(ctx, fx, centerX(ctx, fx, entry), centerY(ctx, fx, entry));
    if (count === 0) return;
    for (let i = 0; i < count; i++) {
      const enemy = targets[i] as Enemy;
      enemy.dist += spec.distance;
      enemy.x = player.x + enemy.ux * enemy.dist;
      enemy.y = player.y + enemy.uy * enemy.dist;
    }
    // The grid's cells hold the old positions. Rebuilt here, mid-phase, so the effects after
    // this one this tick query the pushed positions.
    rebuildGrid(ctx);
  },
  addFrost(ctx, spec, fx, entry) {
    if (spec.radius === undefined) {
      const target = liveTarget(entry);
      if (target !== null) {
        frostOne(ctx, target, spec.amount, entry.source, entry.depth, entry.origin);
      }
      return;
    }
    const targets = ctx.effectTargets;
    const max = spec.maxTargets ?? Infinity;
    const nearest = spec.order === 'nearest';
    const count = inArea(ctx, fx, centerX(ctx, fx, entry), centerY(ctx, fx, entry), max, nearest);
    const { source, depth, origin } = entry;
    for (let i = 0; i < count; i++) {
      frostOne(ctx, targets[i] as Enemy, spec.amount, source, depth, origin);
    }
  },
  heal(ctx, spec) {
    const player = ctx.player;
    player.life = Math.min(player.maxLife, player.life + spec.lifePct * player.maxLife);
  },
  gainShards(ctx, spec, _fx, entry) {
    const state = ctx.state;
    state.shards = add(state.shards, mul(num(entry.value), spec.fraction));
  },
  // A zone at the event's point, or on the enemy or player its trigger's selector picked, its
  // pulses scaled from the effect's payload (src/sim/systems/zones.ts).
  groundZone(ctx, spec, fx, entry) {
    addZone(
      ctx,
      false,
      centerX(ctx, fx, entry),
      centerY(ctx, fx, entry),
      sizeOf(ctx.build, spec.radius),
      Math.max(1, Math.round(spec.durationSec * PULSES_PER_SECOND)),
      ctx.effectPayloads[entry.effect] as Payload,
      spec.damagePctPerSec / PULSES_PER_SECOND,
      entry.source,
      entry.effect,
      entry.depth,
      entry.origin,
    );
  },
  // The victim (dead and gone) at the entry's position: shatterDamage of its max life (the
  // entry's value) to every alive enemy within shatterRadius, credited to the entry's source.
  shatter(ctx, _spec, fx, entry) {
    const radius = ctx.shatterRadius;
    ctx.events.push({ type: 'shatter', x: entry.x, y: entry.y, radius });
    const p = shatterPayload(ctx, fx, entry.source);
    const scale = toNumber(mul(num(entry.value), ctx.shatterDamage));
    const targets = ctx.effectTargets;
    const count = within(ctx, fx, entry.x, entry.y);
    for (let i = 0; i < count; i++) {
      const enemy = targets[i] as Enemy;
      if (enemy.alive) {
        hitWithPayload(ctx, enemy, p, 0, scale, null, null, false, entry.depth, entry.origin);
      }
    }
  },
  // `count` repeats of the signature attack at the entry's depth and origin, on the effect's
  // repeat payload: now, or queued for the attack's next own firing, the rest dropped at the
  // cap. Never from a repeat's hit (rule 7): a repeat never repeats in turn.
  repeatAttack(ctx, spec, _fx, entry) {
    if ((entry.flags & REPEAT) !== 0) return;
    const rs = ctx.sys.repeat;
    const p = rs.payloads[entry.effect] as Payload;
    const count = spec.count;
    const { depth, origin } = entry;
    if (spec.timing === 'nextAttack') {
      const charges = rs.charges;
      for (let c = 0; c < count; c++) {
        if (charges.count === REPEAT_CHARGE_CAP) {
          ctx.counters.repeatChargesDropped++;
          continue;
        }
        const at = (charges.head + charges.count) % REPEAT_CHARGE_CAP;
        charges.payload[at] = p;
        charges.depth[at] = depth;
        charges.origin[at] = origin;
        charges.count++;
      }
      return;
    }
    const em = ctx.emitters[0] as EmitterRuntime;
    const step = REPEAT_STEPS[ctx.build.signature.id];
    for (let c = 0; c < count; c++) step(ctx, em, p, depth, origin);
  },
  // `fraction` of what the ailment has left on the live target, consumed from it, or of a dead
  // victim's (the entry's value), × `damage`: to the target, or to each alive enemy within the
  // radius (at most maxTargets, in `order`), every one taking the whole amount.
  detonate(ctx, spec, fx, entry) {
    const live = liveTarget(entry);
    const left = live !== null ? remainingOf(ctx, live, spec.ailment) : num(entry.value);
    if (!gt(left, ZERO)) return;
    const fraction = spec.fraction ?? 1;
    const dealt =
      live !== null ? consumeAilment(ctx, live, spec.ailment, fraction) : mul(left, fraction);
    const amount = toNumber(mul(dealt, spec.damage ?? 1));
    const p = ctx.effectPayloads[entry.effect] as Payload;
    const { depth, origin } = entry;
    if (fx.radiusSq === 0) {
      if (live !== null) hitWithPayload(ctx, live, p, 0, amount, null, null, false, depth, origin);
      return;
    }
    const max = spec.maxTargets ?? Infinity;
    const nearest = spec.order === 'nearest';
    const targets = ctx.effectTargets;
    const count = inArea(ctx, fx, centerX(ctx, fx, entry), centerY(ctx, fx, entry), max, nearest);
    for (let i = 0; i < count; i++) {
      const enemy = targets[i] as Enemy;
      if (enemy.alive) hitWithPayload(ctx, enemy, p, 0, amount, null, null, false, depth, origin);
    }
  },
  // `count` small projectiles from the event's point, or the player with from 'player', each
  // through spawnShot and the cap (a refused one is counted and the rest still try): homing at
  // the live target ('target') or one at each of the nearest alive enemies ('distinct'), or
  // straight, evenly spaced from the outward angle, player to start ('radial'; +x when the two
  // coincide), or over spreadDeg at the live target ('fan'). Pierce 0 is one hit, −1 every
  // enemy on the line.
  projectiles(ctx, spec, _fx, entry) {
    const aim = spec.aim;
    const player = ctx.player;
    const fromPlayer = spec.from === 'player';
    const x = fromPlayer ? player.x : entry.x;
    const y = fromPlayer ? player.y : entry.y;
    const n = spec.count;
    const homing = aim === 'target' || aim === 'distinct';
    let target: Enemy | null = null;
    let shots = n;
    // The straight ones: the first one's angle, and a fan's half spread.
    let first = 0;
    let half = 0;
    if (aim === 'distinct') {
      shots = nearestAlive(ctx, n, x, y);
    } else if (aim === 'radial') {
      const dx = x - player.x;
      const dy = y - player.y;
      first = dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx);
    } else {
      target = liveTarget(entry);
      if (target === null) return;
      if (aim === 'fan') {
        half = ((spec.spreadDeg ?? 30) * Math.PI) / 360;
        first = Math.atan2(target.y - y, target.x - x) - (n === 1 ? 0 : half);
        target = null;
      }
    }
    const p = ctx.effectPayloads[entry.effect] as Payload;
    const pierce = spec.pierce ?? 0;
    const hits = pierce < 0 ? -1 : pierce + 1;
    const bounce = spec.bounce ?? 0;
    const until = ctx.now + SMALL_PROJECTILE_TICKS;
    const { depth, origin } = entry;
    const motion = homing ? MOTION_HOMING : MOTION_STRAIGHT;
    const step = ctx.projectileStep;
    const distinct = ctx.shots.distinct;
    const gap = aim === 'radial' ? (2 * Math.PI) / n : n === 1 ? 0 : (2 * half) / (n - 1);
    for (let i = 0; i < shots; i++) {
      let vx = 0;
      let vy = 0;
      if (aim === 'distinct') {
        target = distinct[i] as Enemy;
      } else if (!homing) {
        const a = first + gap * i;
        vx = Math.cos(a) * step;
        vy = Math.sin(a) * step;
      }
      spawnShot(
        ctx,
        motion,
        x,
        y,
        vx,
        vy,
        until,
        p,
        1,
        hits,
        bounce,
        depth,
        origin,
        false,
        -1,
        -1,
        target,
      );
    }
  },
  // A line from the event's point, or from the live target with from 'target', `length` long:
  // away from the player ('outward'), at the alive enemy nearest to its start ('nearest'), at
  // the live target ('eventTarget'), or on along the chain jump whose angle is the event's value
  // ('along'); nothing without a direction. Each enemy within half its width and its own radius
  // of the line is hit once, in id order, on the effect's payload (its critScale already in the
  // base), forced to crit with alwaysCrit.
  slashLine(ctx, spec, _fx, entry) {
    const target = liveTarget(entry);
    let ax = entry.x;
    let ay = entry.y;
    if (spec.from === 'target') {
      if (target === null) return;
      ax = target.x;
      ay = target.y;
    }
    let dx: number;
    let dy: number;
    if (spec.toward === 'outward') {
      dx = ax - ctx.player.x;
      dy = ay - ctx.player.y;
    } else if (spec.toward === 'along') {
      dx = Math.cos(entry.value);
      dy = Math.sin(entry.value);
    } else {
      const to = spec.toward === 'nearest' ? nearestFrom(ctx, ax, ay) : target;
      if (to === null) return;
      dx = to.x - ax;
      dy = to.y - ay;
    }
    if (dx === 0 && dy === 0) return;
    const norm = Math.sqrt(dx * dx + dy * dy);
    const length = spec.length;
    const bx = ax + (dx / norm) * length;
    const by = ay + (dy / norm) * length;
    const half = spec.width / 2;
    ctx.events.push({ type: 'slash', x1: ax, y1: ay, x2: bx, y2: by, width: spec.width });
    const targets = ctx.effectTargets;
    const count = slashTargets(ctx, ax, ay, bx, by, half + ctx.shotPad);
    const p = ctx.effectPayloads[entry.effect] as Payload;
    const forced = spec.alwaysCrit === true;
    const { depth, origin } = entry;
    for (let i = 0; i < count; i++) {
      const enemy = targets[i] as Enemy;
      // An enemy that died earlier in this slash is passed over.
      if (!enemy.alive) continue;
      const reach = half + enemy.radius;
      if (segDistSq(enemy.x, enemy.y, ax, ay, bx, by) <= reach * reach) {
        hitWithPayload(ctx, enemy, p, 0, 1, null, null, forced, depth, origin);
      }
    }
  },
  // One hit on the live target, at multiplier × the damage stat (its payload's base), whose
  // payload carries its bypass bits.
  coinHit(ctx, _spec, _fx, entry) {
    const target = liveTarget(entry);
    if (target === null) return;
    ctx.events.push({ type: 'coin', x: target.x, y: target.y, targetId: target.id });
    const p = ctx.effectPayloads[entry.effect] as Payload;
    hitWithPayload(ctx, target, p, 0, 1, null, null, false, entry.depth, entry.origin);
  },
  // An attack of its own on the live target, or on the alive enemy nearest the event's point
  // within the chain range ('nearestToPoint'): its first hit, counted in its budget, and
  // shockStacks on it if the hit left it alive; then exactly `jumps` jumps, no roll, each
  // shocking its enemy alike (Payload.shockOnHit).
  chainBolt(ctx, spec, _fx, entry) {
    const first =
      spec.from === 'nearestToPoint'
        ? ctx.grid.nearest(entry.x, entry.y, ctx.chainRangeSq)
        : liveTarget(entry);
    if (first === null) return;
    const p = ctx.effectPayloads[entry.effect] as Payload;
    const { depth, origin } = entry;
    beginAttack(ctx);
    ctx.chainBudget.hits++;
    hitWithPayload(ctx, first, p, 0, 1, null, null, false, depth, origin);
    const stacks = spec.shockStacks ?? 0;
    if (stacks > 0 && first.alive) addShock(ctx, first, stacks, depth);
    const roots = ctx.sys.chain.frontier;
    roots[0] = first;
    chainGeneral(ctx, p, roots, 1, spec.jumps, false, depth, origin);
    endAttack(ctx);
  },
};

type AnyExecutor = (
  ctx: RunContext,
  spec: CompiledEffectSpec,
  fx: CompiledEffect,
  entry: Readonly<EffectEntry>,
) => void;

/** Runs the effect of `entry`. */
export function runEffect(ctx: RunContext, entry: Readonly<EffectEntry>): void {
  const fx = ctx.build.effects[entry.effect] as CompiledEffect;
  (EFFECTS[fx.kind] as AnyExecutor)(ctx, fx.spec, fx, entry);
}

/**
 * Due periodic triggers, each at the player without a target, staggered by trigger index
 * (RunContext.triggerState.nextPeriodic).
 */
function firePeriodic(ctx: RunContext, list: Int32Array): void {
  const state = ctx.triggerState;
  const player = ctx.player;
  for (let n = 0; n < list.length; n++) {
    const i = list[n] as number;
    if (ctx.now < (state.nextPeriodic[i] as number)) continue;
    const t = ctx.build.triggers[i] as CompiledTrigger;
    state.nextPeriodic[i] = (state.nextPeriodic[i] as number) + t.periodTicks;
    fireOne(ctx, i, 0, -1, null, player.x, player.y, 0, ZERO, -1);
  }
}

/**
 * The tick's effect phase: due periodic triggers, then up to EFFECTS_PER_TICK queued effects.
 * Entries left past the budget wait for the next tick and are counted.
 */
export function runEffectQueue(ctx: RunContext): void {
  const periodic = ctx.build.triggersOn[EVENT.periodic] as Int32Array;
  if (periodic.length !== 0) firePeriodic(ctx, periodic);
  const queue = ctx.effectQueue;
  if (queue.size === 0) {
    ctx.budgetStreak = 0;
    return;
  }
  const entry = ctx.effectEntry;
  let run = 0;
  while (queue.size > 0 && run < EFFECTS_PER_TICK) {
    dequeue(queue, entry);
    runEffect(ctx, entry);
    run++;
  }
  entry.target = null;
  const counters = ctx.counters;
  counters.effectsRun += run;
  if (queue.size > 0) {
    counters.effectBudgetTicks++;
    counters.effectsDeferred += queue.size;
    ctx.budgetStreak++;
    if (ctx.budgetStreak > counters.effectBudgetStreakMax) {
      counters.effectBudgetStreakMax = ctx.budgetStreak;
    }
  } else {
    ctx.budgetStreak = 0;
  }
}
