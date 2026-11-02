/**
 * The per-tick run variables (docs/v3 C6 design §7.4 C6b.3, H19, H20; lead ruling G2): the
 * shards held and the alive enemies in the aura, which a modifier's scaling reads as shardsHeld
 * and enemiesInAura (src/data/triggers.ts), and the alive enemy with the most hp, which the
 * targetIs 'highestHp' condition reads (C4 design §11's B1 row, F16; lead ruling H2), written into
 * the run's EvalInput once a tick, right after the grid is rebuilt and before the contact step
 * (src/sim/simulation.ts). Only stage 2b's C7b hooks (荊棘纏繞's rounds, 反射's arrivals) and the
 * enemy AI's regeneration hit or read before it, and they read the previous tick's values (0 on
 * tick 1, when no enemy is the highest). Every later hit of a tick reads the values the step
 * wrote: a kill's shards show from the next tick, as does an enemy pushed into the aura after
 * the step. So too the highest-hp enemy: one that dies after the step leaves no enemy matching
 * until the next tick (an id is never reused in a run, so no later enemy takes its id), and an
 * enemy spawned or split after the step, or whose hp changes during the tick, is judged by the
 * step's snapshot until the next tick. Only a run whose BuildFlags.shardsHeld,
 * BuildFlags.enemiesInAura or BuildFlags.highestHp is set calls the step; the others pay one test
 * a tick, and their runs stay the same bit for bit. The combo stacks are not here: they are
 * written wherever they change (src/sim/systems/combo.ts).
 *
 * Nothing here draws from a stream, and the step reads only the run's state, so it is
 * deterministic.
 */

import { add, gt, toNumber } from '../../core/num';
import type { Num } from '../../core/num';
import { enemiesInAura } from '../emitters/aura';
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
 * Writes this tick's shardsHeld, the wallet's `wallet` (RunConfig.walletShards) plus the run's
 * shards, when `held`; its enemiesInAura (aura.ts's pulse reach) when `inAura`, which is set
 * only on a run with an aura emitter; and its highestHpId when `top` (false when left out).
 */
export function stepGlobals(
  ctx: RunContext,
  wallet: Num,
  held: boolean,
  inAura: boolean,
  top = false,
): void {
  const ev = ctx.evalInput;
  if (held) ev.shardsHeld = toNumber(add(wallet, ctx.state.shards));
  if (inAura) ev.enemiesInAura = enemiesInAura(ctx);
  if (top) ev.highestHpId = highestHpId(ctx);
}
