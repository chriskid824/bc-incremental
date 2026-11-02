/**
 * The per-tick run variables (docs/v3 C6 design §7.4 C6b.3, H19, H20; lead ruling G2): the
 * shards held and the alive enemies in the aura, which a modifier's scaling reads as shardsHeld
 * and enemiesInAura (src/data/triggers.ts), written into the run's EvalInput once a tick, right
 * after the grid is rebuilt and before the contact step, the first stage that can hit
 * (src/sim/simulation.ts). Every hit of a tick reads the values the step wrote: a kill's shards
 * show from the next tick, as does an enemy pushed into the aura after the step. Only a run
 * whose BuildFlags.shardsHeld or BuildFlags.enemiesInAura is set calls the step; the others pay
 * one test a tick, and their runs stay the same bit for bit. The combo stacks are not here: they
 * are written wherever they change (src/sim/systems/combo.ts).
 *
 * Nothing here draws from a stream, and the step reads only the run's state, so it is
 * deterministic.
 */

import { add, toNumber } from '../../core/num';
import type { Num } from '../../core/num';
import { enemiesInAura } from '../emitters/aura';
import type { RunContext } from './context';

/**
 * Writes this tick's shardsHeld, the wallet's `wallet` (RunConfig.walletShards) plus the run's
 * shards, when `held`; and its enemiesInAura (aura.ts's pulse reach) when `inAura`, which is
 * set only on a run with an aura emitter.
 */
export function stepGlobals(ctx: RunContext, wallet: Num, held: boolean, inAura: boolean): void {
  const ev = ctx.evalInput;
  if (held) ev.shardsHeld = toNumber(add(wallet, ctx.state.shards));
  if (inAura) ev.enemiesInAura = enemiesInAura(ctx);
}
