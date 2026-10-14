/**
 * Trigger target selectors (TriggerSpec.target): the enemy a firing's effects act on in place of
 * its event's, picked once per firing in dispatch.ts's gates, after the conditions and before
 * the chance roll. A selector accepts the alive enemies within its range of its `from` point,
 * but the event's own enemy with excludeEventTarget and bosses with excludeBoss; each pick then
 * takes one of them, ties to the lower id:
 * - nearest: SpatialGrid.nearest from `from`;
 * - farthest, outermost, highestHp, mostStacks: one scan of ctx.enemies in id order with a
 *   strict `>`, so the first of equals wins;
 * - densest: SpatialGrid.densest, then the accepted enemy nearest the center of its cell;
 * - player: no enemy; the effects center on the player (CompiledEffect.atPlayer).
 * The grid queries take ctx.selAccept, one predicate bound in createRunContext that reads what
 * select() leaves in ctx.selection, so a selection allocates nothing.
 *
 * orderNearest() is the 'nearest' order (TARGET_ORDERS) of the effects capped by maxTargets.
 */

import { gt } from '../../core/num';
import { STACK_AILMENTS, TARGET_PICKS, TARGETLESS_EVENTS } from '../../data/triggers';
import type { TargetPick, TargetSelector, TriggerEventId } from '../../data/triggers';
import { liveStacks } from '../build/eval';
import type { GridPoint } from '../grid';
import type { Enemy, RunContext } from '../systems/context';

/** TARGET_PICKS ordinal of each pick: CompiledSelector.pick. */
const PICK = Object.fromEntries(TARGET_PICKS.map((pick, index) => [pick, index])) as {
  readonly [K in TargetPick]: number;
};

export interface CompiledSelector {
  /** TARGET_PICKS ordinal. */
  readonly pick: number;
  /** mostStacks: the STACK_AILMENTS ordinal it counts; −1 for the other picks. */
  readonly ailment: number;
  /** It measures from the player: from 'player', or an event without a point of its own. */
  readonly fromPlayer: boolean;
  /** Its range squared; Infinity without one. */
  readonly rangeSq: number;
  readonly excludeEventTarget: boolean;
  readonly excludeBoss: boolean;
}

/**
 * The selection in progress (RunContext.selection), set by select() for each pick and read by
 * ctx.selAccept. One object rather than RunContext fields: V8 shares an object literal's hidden
 * class between runs only below 128 properties.
 */
export interface SelectionScratch {
  /** The event's enemy it leaves out; null for none. */
  eventTarget: Enemy | null;
  /** It leaves out bosses. */
  noBoss: boolean;
  /** The point it measures from, and its range squared. */
  x: number;
  y: number;
  rangeSq: number;
  /** The densest pick's grid point (SpatialGrid.densest). */
  readonly dense: GridPoint;
}

/** A selection scratch for createRunContext. */
export const createSelectionScratch = (): SelectionScratch => ({
  eventTarget: null,
  noBoss: false,
  x: 0,
  y: 0,
  rangeSq: Infinity,
  dense: { x: 0, y: 0 },
});

/**
 * Compiles the selector of a trigger on events `on`. Throws on a mostStacks pick without its
 * ailment, which validation rejects.
 */
export function compileSelector(spec: TargetSelector, on: TriggerEventId): CompiledSelector {
  if (spec.pick === 'mostStacks' && spec.ailment === undefined) {
    throw new Error("A target selector's mostStacks pick needs its ailment");
  }
  return {
    pick: PICK[spec.pick],
    ailment: spec.ailment === undefined ? -1 : STACK_AILMENTS.indexOf(spec.ailment),
    fromPlayer: spec.from === 'player' || TARGETLESS_EVENTS.has(on),
    rangeSq: spec.range === undefined ? Infinity : spec.range ** 2,
    excludeEventTarget: spec.excludeEventTarget === true,
    excludeBoss: spec.excludeBoss === true,
  };
}

/**
 * Whether the current selection (ctx.selection) accepts the alive `enemy`: within its range of
 * its point, not the event's enemy it excludes, not a boss when it excludes them. Squared
 * distances as the grid computes them, so a range check and a grid query agree.
 */
export function selectable(ctx: RunContext, enemy: Enemy): boolean {
  const sel = ctx.selection;
  if (enemy === sel.eventTarget || (sel.noBoss && enemy.boss)) return false;
  const dx = enemy.x - sel.x;
  const dy = enemy.y - sel.y;
  return dx * dx + dy * dy <= sel.rangeSq;
}

/**
 * Runs selector `s` for an event on `eventTarget` (null for none) at (x, y): writes the picked
 * enemy to ctx.selected (null for 'player') and returns whether there was one to pick.
 */
export function select(
  ctx: RunContext,
  s: CompiledSelector,
  eventTarget: Enemy | null,
  x: number,
  y: number,
): boolean {
  const pick = s.pick;
  if (pick === PICK.player) {
    ctx.selected = null;
    return true;
  }
  const player = ctx.player;
  const fx = s.fromPlayer ? player.x : x;
  const fy = s.fromPlayer ? player.y : y;
  const sel = ctx.selection;
  sel.eventTarget = s.excludeEventTarget ? eventTarget : null;
  sel.noBoss = s.excludeBoss;
  sel.x = fx;
  sel.y = fy;
  sel.rangeSq = s.rangeSq;
  let picked: Enemy | null;
  if (pick === PICK.nearest) {
    picked = ctx.grid.nearest(fx, fy, s.rangeSq, ctx.selAccept);
  } else if (pick === PICK.densest) {
    const point = sel.dense;
    picked =
      ctx.grid.densest(point) === 0
        ? null
        : ctx.grid.nearest(point.x, point.y, Infinity, ctx.selAccept);
  } else {
    picked = scan(ctx, s, fx, fy);
  }
  sel.eventTarget = null;
  ctx.selected = picked;
  return picked !== null;
}

/**
 * The O(n) picks (farthest, outermost, highestHp, mostStacks): the accepted alive enemy that
 * scores highest, in id order with a strict `>`; mostStacks needs at least one stack.
 */
function scan(ctx: RunContext, s: CompiledSelector, fx: number, fy: number): Enemy | null {
  const enemies = ctx.enemies;
  const pick = s.pick;
  let best: Enemy | null = null;
  if (pick === PICK.highestHp) {
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i] as Enemy;
      if (e.alive && (best === null || gt(e.hp, best.hp)) && selectable(ctx, e)) best = e;
    }
    return best;
  }
  const now = ctx.now;
  let bestScore = pick === PICK.mostStacks ? 0 : -1;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i] as Enemy;
    if (!e.alive) continue;
    let score: number;
    if (pick === PICK.farthest) {
      const dx = e.x - fx;
      const dy = e.y - fy;
      score = dx * dx + dy * dy;
    } else if (pick === PICK.outermost) {
      score = e.dist;
    } else {
      score = liveStacks(e, s.ailment, now);
    }
    if (score > bestScore && selectable(ctx, e)) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

/** (distSq, id) of `a` from (x, y) is below `b`'s. */
function closer(a: Enemy, b: Enemy, x: number, y: number): boolean {
  const ax = a.x - x;
  const ay = a.y - y;
  const bx = b.x - x;
  const by = b.y - y;
  const da = ax * ax + ay * ay;
  const db = bx * bx + by * by;
  return da < db || (da === db && a.id < b.id);
}

/**
 * The 'nearest' order of an area capped at `m` enemies: of out[0 .. count) (a grid query's
 * result) but `skip`, keeps the m nearest to (x, y) in out[0 ..), nearest first, ties to the
 * lower id, by insertion into the same list; returns how many it kept.
 */
export function orderNearest(
  out: Enemy[],
  count: number,
  m: number,
  x: number,
  y: number,
  skip: Enemy | null = null,
): number {
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const e = out[i] as Enemy;
    if (e === skip) continue;
    // kept <= i throughout, so the slots written below have been read already.
    let at: number;
    if (kept < m) {
      at = kept++;
    } else if (closer(e, out[m - 1] as Enemy, x, y)) {
      at = m - 1;
    } else {
      continue;
    }
    while (at > 0 && closer(e, out[at - 1] as Enemy, x, y)) {
      out[at] = out[at - 1] as Enemy;
      at--;
    }
    out[at] = e;
  }
  return kept;
}
