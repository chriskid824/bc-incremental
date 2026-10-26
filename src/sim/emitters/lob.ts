/**
 * The lob emitter (magmaBomb, src/sim/rules/magmaBomb.ts; docs/v3 C4 design §4.5, §4.6). Each due
 * firing is counted once (countAttack) and throws projectileCount bombs (its fraction the chance
 * of one more, rolled on the payload's stream after the firing is counted). Their candidates are
 * the alive enemies of the densest block of grid cells, each counted once per firing: the first
 * bomb aims at the candidate with the most alive enemies within the explosion's radius of it,
 * each later one at the best candidate at least SALVO_SEPARATION radii from every enemy this
 * firing aimed at, else at the best one no dense bomb of it aimed at yet; a bomb with no
 * candidate left is not thrown. A bomb flies to where its enemy will be when it lands.
 *
 * A bomb is a lobbed shot of the shot pool (src/sim/systems/shots.ts) that flies flightTicks to a
 * fixed point and lands there in the projectile stage (land), as one attack of its own
 * (beginAttack, src/sim/combat/chain.ts): its explosion hits every enemy within its radius in id
 * order, the one nearest the landing point taking the primary hit; that hit's chain follows and
 * passes over the explosion's victims. Then the explode center event at the landing point, with
 * the first LIST_MAX enemies of the blast as its list (src/sim/effects/centerEvents.ts), and the
 * bomb's fire zone (火地), in the signature's share of the zone pool (src/sim/systems/zones.ts).
 * Aiming and landing draw nothing; ties go to the first in source (id) order.
 *
 * Its forms (LobParams, src/sim/rules/lobForms.ts) change that: under 遠投 every Nth bomb counted
 * (em.shots) aims at the farthest enemy in the arena that the firing has not aimed at (aimFar),
 * one its later dense bombs keep SALVO_SEPARATION radii from but, as it is not marked aimed, may
 * aim at again once no candidate that far is left (Q3/F15); under 火山 the lob fires on a period
 * of its own (emitterInterval) and its bombs are giant ones, of radiusMult × the radius (their
 * aim, separation and fire zone too) and damageMult × the damage of their explosion hits, not of
 * their chains or fire zones; under 連環爆 an enemy a bomb's explosion kills explodes in turn, an
 * effect queued for the form (enqueueModuleEffect), at most perBomb of them a bomb.
 *
 * A repeat of the attack (fireLobRepeat; repeatAttack, src/sim/effects/execute.ts) is a firing
 * that counts as no attack: projectileCount bombs of the repeat's payload, its fraction rolled on
 * that payload's stream, each aimed dense as a firing's are, none far, steady or counted as a
 * shot. Under 火山 they are giant bombs, the period untouched; their landings queue no 連環爆
 * and raise no explode, and their fire zones are the repeat's (Payload.zoneVariant), whose hits
 * repeat nothing either (REPEAT). The repeats waiting for a firing are thrown right after it
 * (drainRepeatCharges).
 */

import { enemySlow } from '../ailments/frost';
import type { LobParams } from '../build/compile';
import { sizeOf } from '../build/size';
import { LIST_MAX } from '../caps';
import { beginAttack, chainFrom, endAttack } from '../combat/chain';
import { hitWithPayload } from '../combat/hit';
import { emitCenterEvent } from '../effects/centerEvents';
import { drainRepeatCharges } from '../effects/execute';
import { PRIMARY, REPEAT } from '../effects/flags';
import { EVENT } from '../effects/types';
import { enqueueModuleEffect } from '../rules/api';
import { rollCount } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { ORBITING, orbitTurn } from '../systems/enemyRecord';
import { MOTION_LOB, spawnShot } from '../systems/shots';
import { addZone, PULSES_PER_SECOND } from '../systems/zones';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import { nextShotSteady } from './types';
import type { EmitterRuntime, LobSpec, Payload } from './types';
import { countAttack } from './volley';

const EXPLODE = EVENT.explode;

/** A bomb's form (ShotPoolState.form, the lob event's form): a normal bomb, */
export const LOB_NORMAL = 0;
/** a giant bomb of 火山 (LobParams.volcano), far or not, */
export const LOB_VOLCANO = 1;
/** and a normal bomb thrown far (遠投, LobParams.farThrowEvery). */
export const LOB_FAR = 2;

/**
 * How far apart a firing's bombs aim, in explosion radii: a later bomb aims at least this far
 * from every enemy the firing aimed at while a candidate that far is left. An initial value, not
 * a cap.
 */
export const SALVO_SEPARATION = 2;

/**
 * Whether the bomb that will be counted shot `s` of the lob (em.shots after it) is thrown far:
 * every farThrowEvery-th, none when 0.
 */
export function isFar(lob: LobParams, s: number): boolean {
  return lob.farThrowEvery > 0 && s % lob.farThrowEvery === 0;
}

/**
 * Fires every due firing of `em`, a lob, each followed by the repeats waiting for it. The
 * accumulator gains the emitter's cadence per tick; a firing is due each time it reaches the
 * emitter's interval. With no enemy alive the emitter stays ready without banking firings, as
 * the volley does (runVolley): it fires on the tick an enemy appears.
 */
export function runLob(ctx: RunContext, em: EmitterRuntime): void {
  const lob = ctx.build.signature.lob as LobParams;
  const giant = lob.volcano !== null;
  const interval = em.interval;
  em.acc += em.cadence;
  while (em.acc >= interval) {
    beginAim(ctx, em);
    // Each bomb aims far or dense by the shot it will be counted as.
    let far = isFar(lob, em.shots + 1);
    const target = far ? aimFar(ctx, em) : aimDense(ctx, em);
    if (target === null) {
      em.acc = interval - em.cadence;
      return;
    }
    em.acc -= interval;
    // One attack per firing, at the first bomb's enemy; then its bombs, as many as the volley's
    // projectiles, rolled in the same place of its order.
    countAttack(ctx, em, target);
    const rng = em.payload.rng;
    const bombs = rollCount(ctx.projectileCount, (c) => rng.chance(c));
    for (let b = 0; b < bombs; b++) {
      // The first bomb's point is aimed already; a later bomb without an enemy is lost.
      if (b > 0) {
        far = isFar(lob, em.shots + 1);
        if ((far ? aimFar(ctx, em) : aimDense(ctx, em)) === null) break;
      }
      const form = giant ? LOB_VOLCANO : far ? LOB_FAR : LOB_NORMAL;
      launch(ctx, em, em.payload, form, nextShotSteady(ctx, em), 0, -1);
    }
    drainRepeatCharges(ctx, em);
  }
}

/**
 * A repeat of the lob (REPEAT_STEPS, src/sim/effects/execute.ts): a firing of `em` with payload
 * `p` that counts as no attack, its hits at `depth` from trigger `origin`. It throws
 * projectileCount bombs, the fraction the chance of one more rolled on p's stream once the
 * first is aimed, each aimed dense afresh (aimDense), never far: 遠投 is per attack. Its bombs
 * are never steady and count as no shot; under 火山 they are giant bombs, and the lob's period
 * is left alone. A bomb with no candidate left is not thrown.
 */
export function fireLobRepeat(
  ctx: RunContext,
  em: EmitterRuntime,
  p: Payload,
  depth: number,
  origin: number,
): void {
  const form = (ctx.build.signature.lob as LobParams).volcano !== null ? LOB_VOLCANO : LOB_NORMAL;
  beginAim(ctx, em);
  if (aimDense(ctx, em) === null) return;
  const rng = p.rng;
  const bombs = rollCount(ctx.projectileCount, (c) => rng.chance(c));
  for (let b = 0; b < bombs; b++) {
    if (b > 0 && aimDense(ctx, em) === null) break;
    launch(ctx, em, p, form, false, depth, origin);
  }
}

/**
 * Starts the aim of a firing of `em`: its radii (火山's giant ones under LobParams.volcano), no
 * dense scan yet, no enemy aimed at.
 */
export function beginAim(ctx: RunContext, em: EmitterRuntime): void {
  const ls = ctx.sys.lob;
  const volcano = (ctx.build.signature.lob as LobParams).volcano;
  const radius =
    sizeOf(ctx.build, (em.spec as LobSpec).radius) * (volcano === null ? 1 : volcano.radiusMult);
  const separation = SALVO_SEPARATION * radius;
  ls.radiusSq = radius * radius;
  ls.sepSq = separation * separation;
  ls.m = -1;
  ls.picks = 0;
}

/**
 * Aims the next bomb of the current firing of `em`, a lob: of the firing's candidates no dense
 * bomb of it aimed at yet, the one with the most alive enemies within the explosion's radius of
 * it that is at least SALVO_SEPARATION radii from every enemy the firing aimed at, else the one
 * with the most; the first in source order on ties. A far bomb's enemy (aimFar) counts for the
 * distance but is not marked aimed, so the fallback may aim at it again and two bombs of one
 * firing can land on it (Q3/F15). The firing's first aim scans the densest 3 × 3 block of
 * grid cells (grid.densest, its own point in ctx.sys.lob.dense) and counts each candidate; the
 * later aims read only those copies. Writes the landing point to ctx.sys.lob (lead) and returns
 * the enemy; null when no candidate is left. Draws nothing.
 */
export function aimDense(ctx: RunContext, em: EmitterRuntime): Enemy | null {
  const ls = ctx.sys.lob;
  const block = ls.block;
  const counts = ls.counts;
  const aimed = ls.aimed;
  const picked = ls.picked;
  if (ls.m < 0) {
    const grid = ctx.grid;
    if (grid.densest(ls.dense) === 0) {
      ls.m = 0;
      return null;
    }
    // Right after densest(): blockItems() reads the block the grid's last densest() found.
    const m = grid.blockItems(block);
    const radiusSq = ls.radiusSq;
    for (let i = 0; i < m; i++) {
      const enemy = block[i] as Enemy;
      counts[i] = grid.countWithin(enemy.x, enemy.y, radiusSq);
      aimed[i] = 0;
    }
    ls.m = m;
  }
  const m = ls.m;
  const picks = ls.picks;
  const sepSq = ls.sepSq;
  let pick = -1;
  let best = -1;
  for (let i = 0; i < m; i++) {
    const count = counts[i] as number;
    if (aimed[i] === 1 || count <= best) continue;
    const enemy = block[i] as Enemy;
    let apart = true;
    for (let j = 0; j < picks; j++) {
      const other = picked[j] as Enemy;
      const dx = enemy.x - other.x;
      const dy = enemy.y - other.y;
      if (dx * dx + dy * dy < sepSq) {
        apart = false;
        break;
      }
    }
    if (!apart) continue;
    best = count;
    pick = i;
  }
  if (pick < 0) {
    // None that far apart: the best no dense bomb aimed at yet, a far bomb's enemy included.
    for (let i = 0; i < m; i++) {
      const count = counts[i] as number;
      if (aimed[i] === 0 && count > best) {
        best = count;
        pick = i;
      }
    }
  }
  if (pick < 0) return null;
  aimed[pick] = 1;
  const target = block[pick] as Enemy;
  picked[ls.picks++] = target;
  lead(ctx, em.spec as LobSpec, target);
  return target;
}

/**
 * Aims the next bomb of the current firing of `em`, a lob, far (遠投): at the alive enemy
 * farthest from the player whose center is inside the arena, of those no bomb of this firing
 * aimed at; the first in id order on ties. Writes the landing point to ctx.sys.lob (lead) and
 * returns the enemy; null when there is none. Draws nothing. It adds the enemy to picked but
 * not to aimed, so a later dense bomb may aim at it again (aimDense, Q3/F15).
 */
export function aimFar(ctx: RunContext, em: EmitterRuntime): Enemy | null {
  const ls = ctx.sys.lob;
  const picked = ls.picked;
  const picks = ls.picks;
  const enemies = ctx.enemies;
  let target: Enemy | null = null;
  let best = -1;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Enemy;
    if (!enemy.alive || enemy.dist <= best) continue;
    const x = enemy.x;
    const y = enemy.y;
    if (x < 0 || x > ARENA_WIDTH || y < 0 || y > ARENA_HEIGHT) continue;
    let aimed = false;
    for (let j = 0; j < picks; j++) {
      if (picked[j] === enemy) {
        aimed = true;
        break;
      }
    }
    if (aimed) continue;
    best = enemy.dist;
    target = enemy;
  }
  if (target === null) return null;
  picked[ls.picks++] = target;
  lead(ctx, em.spec as LobSpec, target);
  return target;
}

/**
 * The landing point of a bomb aimed at `target`, into ctx.sys.lob: where the enemy will be when
 * the bomb lands if it keeps going at its current slow. An orbiting treasure standing at its orbit
 * (src/sim/systems/enemyAi.ts) keeps its distance and turns its bearing by flightTicks of its turn
 * (orbitTurn); an orbit that ends during the flight is not modelled. Any other enemy keeps walking
 * along its line, flightTicks of its steps closer to the player (further out for one that flees),
 * but no closer than its contact distance; one that stands (a step of 0) is aimed where it stands.
 */
function lead(ctx: RunContext, spec: LobSpec, target: Enemy): void {
  const slow = enemySlow(ctx, target, ctx.now);
  const player = ctx.player;
  const ls = ctx.sys.lob;
  const v3 = target.v3;
  if (v3 !== null && v3.state === ORBITING && target.stepDist === 0) {
    const angle = spec.flightTicks * orbitTurn(target, slow);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    ls.x = player.x + (target.ux * cos - target.uy * sin) * target.dist;
    ls.y = player.y + (target.ux * sin + target.uy * cos) * target.dist;
    return;
  }
  const walked = spec.flightTicks * target.stepDist * (1 - slow);
  const dist = Math.max(target.contactDist, target.dist - walked);
  ls.x = player.x + target.ux * dist;
  ls.y = player.y + target.uy * dist;
}

/**
 * Launches a bomb of `em`, a lob, of payload `p` from the player to ctx.sys.lob's point, where
 * it lands flightTicks later; `form` is its ShotPoolState.form (a LOB_VOLCANO bomb's scale is
 * 火山's damageMult, any other's 1), `steady` makes every hit of it crit, and `depth` and
 * `origin` are its hits' (0 and −1 for the emitter's own bombs). PROJECTILE_CAP may refuse it
 * (spawnShot).
 */
export function launch(
  ctx: RunContext,
  em: EmitterRuntime,
  p: Payload,
  form: number,
  steady: boolean,
  depth: number,
  origin: number,
): void {
  const spec = em.spec as LobSpec;
  const ls = ctx.sys.lob;
  const player = ctx.player;
  const x = ls.x;
  const y = ls.y;
  const landAt = ctx.now + spec.flightTicks;
  const volcano = (ctx.build.signature.lob as LobParams).volcano;
  const scale = form === LOB_VOLCANO && volcano !== null ? volcano.damageMult : 1;
  const s = spawnShot(
    ctx,
    MOTION_LOB,
    x,
    y,
    player.x,
    player.y,
    landAt,
    p,
    scale,
    0,
    0,
    depth,
    origin,
    steady,
    -1,
    em.index,
    null,
  );
  if (s < 0) return;
  const shots = ctx.shots;
  shots.form[s] = form;
  const id = shots.id[s] as number;
  ctx.events.push({ type: 'lob', id, fromX: player.x, fromY: player.y, x, y, landAt, form });
}

/**
 * The bomb in slot `s` of the shot pool lands, a bomb of a lob of `spec` (the projectile stage,
 * at its landing tick), as one attack. Its explosion hits the enemies alive within its radius of
 * the landing point, in id order, at the bomb's scale: the one nearest the point, the first in
 * id order on ties, takes the primary hit (PRIMARY), the only one that counts in the attack's
 * chain budget, and its chain follows. Under 連環爆 each enemy an explosion hit kills, up to
 * perBomb of them, queues the form's explosion at its point as it dies; a repeat's bomb (REPEAT)
 * queues none. Then the explosion event; the explode center event at the point, on the primary
 * (null when the bomb hit nothing), its list the first LIST_MAX enemies of the blast by id, the
 * dead kept; and the bomb's fire zone (Payload.zoneVariant). A giant bomb (LOB_VOLCANO) has
 * radiusMult × the radius and the fire zone's radius; its chain and its fire zone keep the
 * payload's damage. The caller ends the shot.
 */
export function land(ctx: RunContext, s: number, spec: LobSpec): void {
  const shots = ctx.shots;
  const p = shots.payload[s] as Payload;
  const x = shots.x[s] as number;
  const y = shots.y[s] as number;
  const scale = shots.scale[s] as number;
  const steady = shots.steady[s] === 1;
  const depth = shots.depth[s] as number;
  const origin = shots.origin[s] as number;
  const build = ctx.build;
  const lob = build.signature.lob as LobParams;
  const volcano = lob.volcano;
  const grow = shots.form[s] === LOB_VOLCANO && volcano !== null ? volcano.radiusMult : 1;
  const radius = sizeOf(build, spec.radius) * grow;
  beginAttack(ctx);
  const ls = ctx.sys.lob;
  const blast = ls.blast;
  const budget = ctx.chainBudget;
  // within() returns alive enemies only, so the primary is the nearest alive one.
  const n = ctx.grid.within(x, y, radius * radius, blast);
  let primary: Enemy | null = null;
  let bestDistSq = Infinity;
  for (let i = 0; i < n; i++) {
    const enemy = blast[i] as Enemy;
    const dx = enemy.x - x;
    const dy = enemy.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      primary = enemy;
    }
  }
  // 連環爆: this explosion's own kills, in hit order; not its chain's, nor a repeat bomb's.
  const chainBlast = (p.flags & REPEAT) === 0 ? lob.chainBlast : null;
  let blasts = 0;
  for (let i = 0; i < n; i++) {
    const enemy = blast[i] as Enemy;
    if (!enemy.alive) continue;
    const isPrimary = enemy === primary;
    if (isPrimary) budget.hits++;
    hitWithPayload(
      ctx,
      enemy,
      p,
      0,
      scale,
      null,
      null,
      steady,
      depth,
      origin,
      isPrimary ? PRIMARY : 0,
    );
    if (chainBlast !== null && !enemy.alive && blasts < chainBlast.perBomb) {
      // At the victim's point, which is dead: no target. The queue copies the event's fields.
      const ev = ls.event;
      ev.x = enemy.x;
      ev.y = enemy.y;
      ev.depth = depth;
      ev.origin = origin;
      enqueueModuleEffect(ctx, chainBlast.trigger, chainBlast.effect, ev);
      blasts++;
    }
  }
  // Its victims carry the attack's serial, so the chain passes over them.
  if (primary !== null && p.chains) {
    chainFrom(ctx, p, primary, ctx.chainCount, steady, depth, origin);
  }
  const primaryId = primary === null ? -1 : primary.id;
  ctx.events.push({ type: 'explosion', x, y, radius, primaryId, count: n });
  // The list is written for every bomb, listened to or not: emitCenterEvent never clears it, and
  // an explode trigger fans out over whatever it holds. Taken after every hit, which may have
  // written it (a freeze's list).
  const scratch = ctx.centerScratch;
  const list = scratch.list;
  const listCount = n < LIST_MAX ? n : LIST_MAX;
  for (let i = 0; i < listCount; i++) list[i] = blast[i] as Enemy;
  scratch.listCount = listCount;
  scratch.radius = radius;
  emitCenterEvent(ctx, EXPLODE, depth, origin, primary, x, y, p.flags);
  const zonePayload = p.zoneVariant;
  if (zonePayload !== null) {
    const zone = spec.zone;
    addZone(
      ctx,
      true,
      x,
      y,
      sizeOf(build, zone.radius) * grow,
      Math.max(1, Math.round(zone.durationSec * PULSES_PER_SECOND)),
      zonePayload,
      zone.damagePctPerSec / PULSES_PER_SECOND,
      p.source,
      -1,
      depth,
      origin,
    );
  }
  endAttack(ctx);
}
