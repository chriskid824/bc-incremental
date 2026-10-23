/**
 * Strikes (docs/v3 C4 design D21, §4.13): the strike grants, 落雷 and 雷鳴 among them. A strike
 * emitter strikes every em.interval ticks (periodSec), whatever the attack speed, counted from
 * 0 (EmitterRuntime.timer). Each strike is an attack of its own (beginAttack): its target selector
 * picks an enemy from the player, as a periodic trigger's does; with none to pick the strike is
 * lost. The target takes the strike's hit, counted in the attack's budget, then shockStacks shock
 * stacks if the hit landed (its defences did not block it in full: lead ruling R1) and left it
 * alive; then every other alive enemy within `radius` of it takes a hit, in id order, counted in no
 * budget; then the strike chains chainJumps jumps from the target, on the general path
 * (chainGeneral), each jump hit shocking its enemy alike (EmitterRuntime.chainPayload). Nothing is
 * drawn but the hits' own rolls, on the combat stream. A strike is not the signature attack: its
 * hits carry no PRIMARY, raise no center events and repeat nothing.
 */

import { addShock } from '../ailments/shock';
import { sizeOf } from '../build/size';
import { beginAttack, endAttack } from '../combat/chain';
import { hitWithPayload } from '../combat/hit';
import { chainGeneral } from '../combat/policy';
import { select } from '../effects/select';
import type { CompiledSelector } from '../effects/select';
import type { Enemy, RunContext } from '../systems/context';
import type { EmitterRuntime, Payload, StrikeSpec } from './types';

/** Strikes once with strike emitter `em` when its timer reaches its interval. */
export function runStrike(ctx: RunContext, em: EmitterRuntime): void {
  em.timer += 1;
  if (em.timer < em.interval) return;
  em.timer -= em.interval;
  const player = ctx.player;
  if (!select(ctx, em.selector as CompiledSelector, null, player.x, player.y)) return;
  // Never null: validation rejects a strike's 'player' pick.
  const target = ctx.selected as Enemy;
  const spec = em.spec as StrikeSpec;
  const p = em.payload;
  beginAttack(ctx);
  ctx.chainBudget.hits++;
  const landed = hitWithPayload(ctx, target, p, 0, 1, null, null, false, 0, -1);
  const stacks = spec.shockStacks;
  if (landed && stacks > 0 && target.alive) addShock(ctx, target, stacks, 0);
  if (spec.radius > 0) {
    const targets = em.targets as Enemy[];
    const r = sizeOf(ctx.build, spec.radius);
    const n = ctx.grid.within(target.x, target.y, r * r, targets);
    for (let j = 0; j < n; j++) {
      const enemy = targets[j] as Enemy;
      // Area hits count in no budget; an enemy killed earlier in this strike is passed over.
      // They add no shock, so a blocked one changes nothing after it (R1).
      if (enemy !== target && enemy.alive) {
        hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, 0, -1);
      }
    }
  }
  if (spec.chainJumps > 0) {
    // From the target's point even if it died, as an M1 chain does.
    const roots = ctx.sys.chain.frontier;
    roots[0] = target;
    chainGeneral(ctx, em.chainPayload as Payload, roots, 1, spec.chainJumps, false, 0, -1);
  }
  endAttack(ctx);
}
