/**
 * The per-tick run variables (docs/v3 C6 design §7.4 C6b.3, H19, H20; lead ruling G2): the
 * shards held, the alive enemies in the aura and the live timed rows of the drone pool (C5.9's
 * minionCount, gd:572), which a modifier's scaling reads as shardsHeld, enemiesInAura and
 * minionCount (src/data/triggers.ts), and the alive enemy with the most hp, which the targetIs
 * 'highestHp' condition reads (C4 design §11's B1 row, F16; lead ruling H2), written into the
 * run's EvalInput once a tick, right after the grid is rebuilt and before the contact step
 * (src/sim/simulation.ts). Only stage 2b's C7b hooks (荊棘纏繞's rounds, 反射's arrivals) and the
 * enemy AI's regeneration hit or read before it, and they read the previous tick's values (0 on
 * tick 1, when no enemy is the highest). Every later hit of a tick reads the values the step
 * wrote: a kill's shards show from the next tick, as does an enemy pushed into the aura after
 * the step. So too the highest-hp enemy: one that dies after the step leaves no enemy matching
 * until the next tick (an id is never reused in a run, so no later enemy takes its id), and an
 * enemy spawned or split after the step, or whose hp changes during the tick, is judged by the
 * step's snapshot until the next tick. So too the timed rows: the drone stage (6b) spawns none
 * (the effects do, in stage 11) and drops those that left at its end, so the count holds for the
 * whole tick, and a row spawned in stage 11 counts from the next tick on. Only a run whose
 * BuildFlags.shardsHeld, BuildFlags.enemiesInAura, BuildFlags.highestHp or
 * BuildFlags.minionCount is set calls the step; the others pay one test a tick, and their runs
 * stay the same bit for bit. The combo stacks are not here: they are written wherever they change
 * (src/sim/systems/combo.ts).
 *
 * Nothing here draws from a stream, and the step reads only the run's state, so it is
 * deterministic.
 */

import { add, gt, toNumber } from '../../core/num';
import type { Num } from '../../core/num';
import { enemiesInAura } from '../emitters/aura';
import { DRONE_KIND_SPIRIT } from '../types';
import type { Enemy, RunContext } from './context';

/**
 * The id of the alive enemy with the most hp, bosses included, by one scan of ctx.enemies with a
 * strict `>`, so the first of equals wins, as the selector's highestHp pick does
 * (src/sim/effects/select.ts); 0 when none is alive.
 */
export function highestHpId(ctx: RunContext): number {
  const enemies = ctx.enemies;
  let best: Enemy | null = null;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i] as Enemy;
    if (e.alive && (best === null || gt(e.hp, best.hp))) best = e;
  }
  return best === null ? 0 : best.id;
}

/**
 * The live timed rows of the drone pool (minionCount): its spirits (DRONE_KIND_SPIRIT, which only
 * spawnRows appends) whose time is not up, DronePool.until being the first tick a row is gone; its
 * fixed drones and turrets never count. One pass over the pool's rows, at most its summon cap.
 */
export function minionCount(ctx: RunContext): number {
  const ds = ctx.sys.drones;
  const now = ctx.now;
  const kind = ds.kind;
  const until = ds.until;
  let n = 0;
  for (let s = 0; s < ds.count; s++) {
    if (kind[s] === DRONE_KIND_SPIRIT && (until[s] as number) > now) n++;
  }
  return n;
}

/**
 * Writes this tick's shardsHeld, the wallet's `wallet` (RunConfig.walletShards) plus the run's
 * shards, when `held`; its enemiesInAura (aura.ts's pulse reach) when `inAura`, which is set
 * only on a run with an aura emitter; its highestHpId when `top`; and its minionCount when
 * `minions` (`top` and `minions` false when left out).
 */
export function stepGlobals(
  ctx: RunContext,
  wallet: Num,
  held: boolean,
  inAura: boolean,
  top = false,
  minions = false,
): void {
  const ev = ctx.evalInput;
  if (held) ev.shardsHeld = toNumber(add(wallet, ctx.state.shards));
  if (inAura) ev.enemiesInAura = enemiesInAura(ctx);
  if (top) ev.highestHpId = highestHpId(ctx);
  if (minions) ev.minionCount = minionCount(ctx);
}
