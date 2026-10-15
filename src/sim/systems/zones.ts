/**
 * Ground zones (docs/v3 C4 design D17, §4.10): areas that pulse every PULSE_TICKS for a whole
 * number of pulses, in the zone pool (ZonePool, RunContext.sys.zones, also SimState.zones). A
 * groundZone effect adds an effect zone (src/sim/effects/execute.ts); the signature attack's
 * own zones come later in C4 and have a pool share of their own.
 *
 * Pulses (C8): a zone of id `id` created at tick c with n pulses pulses on the ticks t of
 * (c, c + PULSE_TICKS × n] with t ≡ id (mod PULSE_TICKS), exactly n of them, whichever stage of
 * its tick created it, so zones made together pulse on different ticks. It is released at the
 * first zone stage at or past its last tick. Each pulse hits every alive enemy within the zone
 * with its payload at its scale (none at scale 0), then applies the zone's own terms to each
 * enemy it did not kill: its ailment stacks, its frost, its slow and, for a source an inZone
 * condition names, the inZone mark. A pulse's hits raise no hit events: they add to the pulse's
 * tally (PulseAcc), and the pulse raises one pulse event (Payload.aggregate).
 *
 * Caps (K5): a source keeps at most ZONE_SOURCE_CAP effect zones, the pool ZONE_CAP of them and
 * SIGNATURE_ZONE_CAP signature zones. A new effect zone of a source at its cap evicts that
 * source's oldest; otherwise a new effect zone at ZONE_CAP evicts the oldest effect zone of any
 * source; a new signature zone at its cap evicts the oldest signature zone. Each eviction counts
 * in zonesEvicted and raises zoneEnd with `evicted`.
 *
 * Slots 0 .. count − 1 hold the live zones in id order, kept in order as zones end. A zone's
 * other arrays stay at its record (ZonePool.record) from its creation to its end, so closing a
 * slot moves only the slot arrays. The zone stage runs after the projectiles and before the
 * ailments; nothing it reaches adds a zone (kills and freezes only queue effects), so no slot
 * moves under a pulse.
 */

import { assertFinite, mul, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import { TAG } from '../../data/tags';
import { APPLIED_AILMENTS } from '../../data/triggers';
import type { AppliedAilment, GroundZoneSpec } from '../../data/triggers';
import { takenMult } from '../ailments/shock';
import { pctMaxHpFactor, statAt } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { PULSE_TICKS, SIGNATURE_ZONE_CAP, ZONE_CAP, ZONE_SOURCE_CAP } from '../caps';
import { convertHit } from '../combat/convert';
import { applyHitDamage, dispatchHit, modifyDamage } from '../combat/hit';
import { applyStacks, durationOf, frostOne } from '../effects/execute';
import { CRIT_HIT, HIT_EVENT, SIGNATURE } from '../effects/flags';
import { EVENT, MAX_DEPTH } from '../effects/types';
import { PRESCALED, ROWS, SLOT_HIT, SLOT_HIT_CRIT, slotRow } from '../emitters/types';
import type { CompiledTrigger } from '../effects/types';
import type { Payload } from '../emitters/types';
import { TICK_RATE } from '../types';
import { clamp01 } from './context';
import type { Enemy, RunContext } from './context';
import type { PulseAcc, ZonePool } from './systemState';

const CRIT = TAG.crit;

const DAMAGE = SCOPED_INDEX.damage;
const CRIT_CHANCE = SCOPED_INDEX.critChance;
const CRIT_MULTIPLIER = SCOPED_INDEX.critMultiplier;
const CRIT_ALWAYS = SCOPED_INDEX.critAlways;
const EV_HIT = EVENT.hit;
const EV_CRIT = EVENT.crit;

/** Pulses a second: a groundZone's durationSec and per-second terms count them. */
export const PULSES_PER_SECOND = TICK_RATE / PULSE_TICKS;
/**
 * Ticks a pulse's slow and inZone mark hold on an enemy: one pulse period and a tick, so an enemy
 * that stays in a zone keeps them from pulse to pulse.
 */
const ZONE_HOLD_TICKS = PULSE_TICKS + 1;

/**
 * Adds a zone at (x, y) of `radius` that pulses `pulses` times from the next tick on: a
 * signature zone, or an effect zone of groundZone effect `effect`, whose terms it takes. Its hits
 * deal payload `p` at `scale` (0: none), credited to `source` like its terms, at `depth` from
 * trigger `origin`. At its cap it first evicts the oldest zone the cap counts (K5).
 */
export function addZone(
  ctx: RunContext,
  signature: boolean,
  x: number,
  y: number,
  radius: number,
  pulses: number,
  p: Payload,
  scale: number,
  source: number,
  effect: number,
  depth: number,
  origin: number,
): void {
  const z = ctx.sys.zones;
  if (signature) {
    if (z.liveSignature >= SIGNATURE_ZONE_CAP) evict(ctx, z, oldest(z, 1, -1));
  } else if ((z.perSource[source] as number) >= ZONE_SOURCE_CAP) {
    evict(ctx, z, oldest(z, 0, source));
  } else if (z.live >= ZONE_CAP) {
    evict(ctx, z, oldest(z, 0, -1));
  }
  // Ids only grow, so appending keeps the pool in id order.
  const slot = z.count++;
  // Its record, where its terms stay while its slot moves: the free record on top.
  const i = z.free[--z.freeCount] as number;
  const id = ++z.nextId;
  const now = ctx.now;
  const expiresAt = now + PULSE_TICKS * pulses;
  z.record[slot] = i;
  z.id[slot] = id;
  z.x[slot] = x;
  z.y[slot] = y;
  z.radiusSq[slot] = radius * radius;
  z.created[slot] = now;
  z.expiresAt[slot] = expiresAt;
  z.signature[slot] = signature ? 1 : 0;
  z.scale[i] = scale;
  z.payload[i] = p;
  z.source[i] = source;
  z.depth[i] = depth;
  z.origin[i] = origin;
  z.stamp[i] = z.stampSources[source] as number;
  if (effect >= 0) {
    const spec = ctx.build.effects[effect]?.spec as GroundZoneSpec;
    z.ailment[i] = spec.ailment === undefined ? -1 : APPLIED_AILMENTS.indexOf(spec.ailment);
    z.stacks[i] = spec.ailmentStacks ?? 1;
    z.ailmentPct[i] = spec.ailmentDamagePct ?? 1;
    z.frost[i] = (spec.addFrostPerSec ?? 0) / PULSES_PER_SECOND;
    z.slow[i] = spec.slow ?? 0;
  } else {
    // A signature zone's only term is its slow, which the signature's parameters set once they
    // exist (C4.7); none until then.
    z.ailment[i] = -1;
    z.stacks[i] = 0;
    z.ailmentPct[i] = 0;
    z.frost[i] = 0;
    z.slow[i] = 0;
  }
  if (signature) z.liveSignature++;
  else {
    z.live++;
    z.perSource[source] = (z.perSource[source] as number) + 1;
  }
  ctx.state.zoneCount = z.count;
  ctx.events.push({ type: 'zone', id, x, y, radius, expiresAt, source, signature });
}

/**
 * The slot of the oldest live zone with signature flag `signature` and, unless −1, of `source`:
 * the first in slot order, which is id order.
 */
function oldest(z: ZonePool, signature: number, source: number): number {
  for (let s = 0; s < z.count; s++) {
    if (
      z.signature[s] === signature &&
      (source < 0 || z.source[z.record[s] as number] === source)
    ) {
      return s;
    }
  }
  throw new Error('No zone to evict');
}

/** Evicts the zone in slot `s`: counted, announced, and its slot closed up in order. */
function evict(ctx: RunContext, z: ZonePool, s: number): void {
  ctx.counters.zonesEvicted++;
  ctx.events.push({ type: 'zoneEnd', id: z.id[s] as number, evicted: true });
  release(z, s);
  const n = z.count;
  // The slots past it move down one, a block copy of each slot array (records stay put).
  const from = s + 1;
  z.record.copyWithin(s, from, n);
  z.id.copyWithin(s, from, n);
  z.x.copyWithin(s, from, n);
  z.y.copyWithin(s, from, n);
  z.radiusSq.copyWithin(s, from, n);
  z.created.copyWithin(s, from, n);
  z.expiresAt.copyWithin(s, from, n);
  z.signature.copyWithin(s, from, n);
  z.count = n - 1;
}

/** Takes the zone in slot `s` out of the live counts and frees its record. */
function release(z: ZonePool, s: number): void {
  const r = z.record[s] as number;
  if (z.signature[s] === 1) z.liveSignature--;
  else {
    z.live--;
    const source = z.source[r] as number;
    z.perSource[source] = (z.perSource[source] as number) - 1;
  }
  z.free[z.freeCount++] = r;
}

/** The zone stage: each zone due pulses, in id order; zones past their last tick are released. */
export function stepZones(ctx: RunContext): void {
  const sys = ctx.sys;
  const z = sys.zones;
  const n = z.count;
  if (n === 0) return;
  const acc = sys.pulse;
  const now = ctx.now;
  const phase = now % PULSE_TICKS;
  let kept = 0;
  for (let s = 0; s < n; s++) {
    const expiresAt = z.expiresAt[s] as number;
    if (
      (z.created[s] as number) < now &&
      now <= expiresAt &&
      (z.id[s] as number) % PULSE_TICKS === phase
    ) {
      pulse(ctx, z, acc, s);
    }
    if (now >= expiresAt) {
      ctx.events.push({ type: 'zoneEnd', id: z.id[s] as number, evicted: false });
      release(z, s);
      continue;
    }
    if (kept !== s) moveSlot(z, s, kept);
    kept++;
  }
  z.count = kept;
  ctx.state.zoneCount = kept;
}

/**
 * One pulse of the zone in slot `s`: its hit, then its terms, on each alive enemy within it, in
 * id order; then its pulse event, when it hit anything.
 */
function pulse(ctx: RunContext, z: ZonePool, acc: PulseAcc, s: number): void {
  const targets = z.targets;
  const n = ctx.grid.within(z.x[s] as number, z.y[s] as number, z.radiusSq[s] as number, targets);
  const i = z.record[s] as number;
  const p = z.payload[i] as Payload;
  const scale = z.scale[i] as number;
  acc.hits = 0;
  acc.total = ZERO;
  acc.critCount = 0;
  if (scale > 0) hoistPulseRows(ctx, acc, p);
  // A build without the ailment's duration skips the term, as applyAilment does.
  const a = z.ailment[i] as number;
  const ailment = APPLIED_AILMENTS[Math.max(0, a)] as AppliedAilment;
  const ails = a >= 0 && durationOf(ctx, ailment) > 0;
  const base: Num = ails ? mul(p.baseDamage, z.ailmentPct[i] as number) : ZERO;
  const depth = z.depth[i] as number;
  const origin = z.origin[i] as number;
  const source = z.source[i] as number;
  const stacks = z.stacks[i] as number;
  const frost = z.frost[i] as number;
  const slow = z.slow[i] as number;
  const stamp = z.stamp[i] === 1;
  const now = ctx.now;
  const until = now + ZONE_HOLD_TICKS;
  for (let j = 0; j < n; j++) {
    const enemy = targets[j] as Enemy;
    if (!enemy.alive) continue;
    if (scale > 0) hitPulse(ctx, acc, enemy, p, scale, depth, origin);
    if (!enemy.alive) continue;
    if (ails) applyStacks(ctx, ailment, enemy, p, base, stacks, depth, origin);
    if (frost > 0) frostOne(ctx, enemy, frost, source, depth, origin);
    if (slow > 0) {
      const live = enemy.zoneSlowUntil > now ? enemy.zoneSlow : 0;
      enemy.zoneSlow = Math.max(live, slow);
      enemy.zoneSlowUntil = until;
      z.slowApplied = true;
    }
    if (stamp) {
      enemy.zoneSource = source;
      enemy.zoneUntil = until;
    }
  }
  if (acc.hits > 0) {
    ctx.events.push({
      type: 'pulse',
      kind: 'zone',
      id: z.id[s] as number,
      hits: acc.hits,
      total: acc.total,
      crits: acc.crits.slice(0, acc.critCount),
    });
  }
}

/**
 * The hit rows of pulse payload `p`, without and with crit, into acc, once per pulse; and
 * whether its hits are quiet: something listens to hits (RunContext.hitListeners), but no hit
 * or crit trigger can pass on them, because every one takes only signature hits and `p`'s are
 * not, and no onHit hook listens.
 */
export function hoistPulseRows(ctx: RunContext, acc: PulseAcc, p: Payload): void {
  const build = ctx.build;
  acc.row = slotRow(build, p, SLOT_HIT);
  acc.critRow = slotRow(build, p, SLOT_HIT_CRIT);
  acc.quiet =
    ctx.hitListeners &&
    (p.flags & SIGNATURE) === 0 &&
    build.hooks.onHit.length === 0 &&
    signatureOnly(ctx, build.triggersOn[EV_HIT] as Int32Array) &&
    signatureOnly(ctx, build.triggersOn[EV_CRIT] as Int32Array);
}

/** Every trigger of `list` takes only signature hits. */
function signatureOnly(ctx: RunContext, list: Int32Array): boolean {
  const triggers = ctx.build.triggers;
  for (let n = 0; n < list.length; n++) {
    if (!(triggers[list[n] as number] as CompiledTrigger).signatureOnly) return false;
  }
  return true;
}

/**
 * What dispatchHit leaves of a quiet hit at `depth` (hoistPulseRows): fire counts the event of
 * each listened list in triggerDepthCapped at MAX_DEPTH or deeper, and its triggers pass nothing.
 */
function quietDispatch(ctx: RunContext, crit: boolean, depth: number): void {
  if (depth < MAX_DEPTH) return;
  const on = ctx.build.triggersOn;
  if ((on[EV_HIT] as Int32Array).length !== 0) ctx.counters.triggerDepthCapped++;
  if (crit && (on[EV_CRIT] as Int32Array).length !== 0) ctx.counters.triggerDepthCapped++;
}

/**
 * A pulse's hit of payload `p` on `enemy` at `scale`, added to the pulse's tally `acc`: what
 * hitWithPayload (src/sim/combat/hit.ts) does for a primary hit that is not forced to crit,
 * with no caller flags and a payload that rolls no ailments, reading the rows hoistPulseRows put
 * in `acc`; a quiet pulse's hit leaves dispatchHit to quietDispatch, which keeps only its
 * counts. The differential tests in zones.test.ts hold them equal.
 */
export function hitPulse(
  ctx: RunContext,
  acc: PulseAcc,
  enemy: Enemy,
  p: Payload,
  scale: number,
  depth: number,
  origin: number,
): void {
  const build = ctx.build;
  const table = ctx.table;
  const ev = ctx.evalInput;
  ev.now = ctx.now;
  ev.target = enemy;
  ev.chainJump = 0;
  const plainRow = acc.row;
  const chance =
    build.flags.randomCrits && p.canCrit ? clamp01(statAt(table, plainRow, CRIT_CHANCE, ev)) : 0;
  const crit = p.canCrit && (p.rng.chance(chance) || statAt(table, plainRow, CRIT_ALWAYS, ev) > 0);
  const row = crit ? acc.critRow : plainRow;
  const critMultiplier = crit ? statAt(table, row, CRIT_MULTIPLIER, ev) : 1;
  const base = mul(p.baseDamage, critMultiplier * scale);
  const mask = crit ? p.tags | CRIT : p.tags;
  const source = p.source;
  const flags = p.flags | HIT_EVENT | (crit ? CRIT_HIT : 0);
  const converted = ctx.converts && p.damageMode === ROWS && table.convCount[row] !== 0;
  let amount = converted
    ? convertHit(ctx, row, base, ev)
    : p.damageMode === ROWS
      ? mul(base, statAt(table, row, DAMAGE, ev))
      : p.damageMode === PRESCALED
        ? base
        : mul(base, pctMaxHpFactor(table, row, ev, build.flags.shatterMult));
  if ((enemy.shockStacks !== 0 && enemy.shockUntil > ctx.now) || enemy.frozenUntil > ctx.now) {
    amount = mul(amount, takenMult(ctx, enemy));
  }
  if (build.hooks.modifyDamage.length !== 0) {
    amount = modifyDamage(ctx, enemy, amount, mask, source, crit, 0, depth, origin, flags);
  }
  applyHitDamage(
    ctx,
    enemy,
    assertFinite(amount, 'hit damage'),
    mask,
    source,
    crit,
    0,
    depth,
    origin,
    flags,
    null,
    null,
    converted,
    acc,
  );
  if (!enemy.alive) return;
  if (ctx.hitListeners) {
    if (acc.quiet) quietDispatch(ctx, crit, depth);
    else dispatchHit(ctx, enemy, amount, mask, source, crit, 0, depth, origin, flags);
  }
}

/** Moves the zone in slot `from` to slot `to` (to < from); its record stays put. */
function moveSlot(z: ZonePool, from: number, to: number): void {
  z.record[to] = z.record[from] as number;
  z.id[to] = z.id[from] as number;
  z.x[to] = z.x[from] as number;
  z.y[to] = z.y[from] as number;
  z.radiusSq[to] = z.radiusSq[from] as number;
  z.created[to] = z.created[from] as number;
  z.expiresAt[to] = z.expiresAt[from] as number;
  z.signature[to] = z.signature[from] as number;
}
