/**
 * Strikes (docs/v3 C4 design D21, §4.13): the strike grants, 落雷, 雷鳴 and 刺蝟 among them. A
 * strike emitter strikes every em.interval ticks (periodSec), whatever the attack speed, counted
 * from 0 (EmitterRuntime.timer). Each strike is an attack of its own (beginAttack): its target
 * selector picks an enemy from the player, as a periodic trigger's does; with none to pick the
 * strike is lost. The target takes the strike's hit, counted in the attack's budget, then
 * shockStacks shock stacks if the hit landed (its defences did not block it in full: lead ruling
 * R1) and left it alive; then every other alive enemy within `radius` of it takes a hit, in id
 * order, counted in no budget; then the strike chains chainJumps jumps from the target, on the
 * general path (chainGeneral), each jump hit shocking its enemy alike
 * (EmitterRuntime.chainPayload). Nothing is drawn but the hits' own rolls, on the combat stream.
 * A strike is not the signature attack: its hits carry no PRIMARY, raise no center events and
 * repeat nothing.
 *
 * A strike of `targets` n above 1 (刺蝟's six spikes, E16) picks up to n distinct enemies with
 * its selector (selectMany), all before any is hit, in the pick's order, the first the one a
 * strike of one target picks. Then each picked target still alive at its turn takes the strike
 * as the one target does, in pick order: its hit (each counted in the budget), its shock, and
 * the area around it, the other picked targets included; one an earlier target's hit or area
 * killed is passed over. Then one chain from the targets struck, roots in pick order (one its own
 * hit killed among them), as 六線圈's discharge chains from its two (src/sim/emitters/arc.ts).
 * It is one attack and draws nothing more; with fewer enemies it strikes those there are. A
 * strike of one target runs the path above, which reads no field of these.
 *
 * A thorns-tagged strike (StrikeGrant.tags, 刺蝟's) reaches its range × BuildFlags.thornsFactor
 * (strikeSelector, at createRunContext) and its area radius × it too, after the area factor
 * (strikeRadius; lead ruling 21 of B4).
 */

import { TAG } from '../../data/tags';
import { addShock } from '../ailments/shock';
import type { CompiledBuild } from '../build/compile';
import { sizeOf } from '../build/size';
import { beginAttack, endAttack } from '../combat/chain';
import { hitWithPayload } from '../combat/hit';
import { chainGeneral } from '../combat/policy';
import { select, selectMany } from '../effects/select';
import type { CompiledSelector } from '../effects/select';
import type { Enemy, RunContext } from '../systems/context';
import type { EmitterRuntime, Payload, StrikeSpec } from './types';

/** Strikes once with strike emitter `em` when its timer reaches its interval. */
export function runStrike(ctx: RunContext, em: EmitterRuntime): void {
  em.timer += 1;
  if (em.timer < em.interval) return;
  em.timer -= em.interval;
  const spec = em.spec as StrikeSpec;
  if (spec.targets > 1) {
    strikeTargets(ctx, em, spec);
    return;
  }
  const player = ctx.player;
  if (!select(ctx, em.selector as CompiledSelector, null, player.x, player.y)) return;
  // Never null: validation rejects a strike's 'player' pick.
  const target = ctx.selected as Enemy;
  const p = em.payload;
  beginAttack(ctx);
  ctx.chainBudget.hits++;
  const landed = hitWithPayload(ctx, target, p, 0, 1, null, null, false, 0, -1);
  const stacks = spec.shockStacks;
  if (landed && stacks > 0 && target.alive) addShock(ctx, target, stacks, 0);
  if (spec.radius > 0) {
    const targets = em.targets as Enemy[];
    const r = strikeRadius(ctx.build, spec);
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

/**
 * A strike of `em` at up to spec.targets enemies (E16): all picked first into the run's one
 * scratch (SelectionScratch.picks), then each struck in pick order while alive; the struck ones
 * are compacted to the front of the picks, in order, and are the chain's roots, which
 * chainGeneral only reads. Nothing when the selector finds none.
 */
function strikeTargets(ctx: RunContext, em: EmitterRuntime, spec: StrikeSpec): void {
  const player = ctx.player;
  const picks = ctx.selection.picks;
  const picked = selectMany(
    ctx,
    em.selector as CompiledSelector,
    null,
    player.x,
    player.y,
    spec.targets,
    picks,
  );
  if (picked === 0) return;
  const p = em.payload;
  const stacks = spec.shockStacks;
  const area = spec.radius > 0;
  const r = area ? strikeRadius(ctx.build, spec) : 0;
  const targets = em.targets as Enemy[];
  beginAttack(ctx);
  let struck = 0;
  for (let k = 0; k < picked; k++) {
    const target = picks[k] as Enemy;
    // Killed by an earlier target's hit or area: no hit, no shock, no area, no root.
    if (!target.alive) continue;
    ctx.chainBudget.hits++;
    const landed = hitWithPayload(ctx, target, p, 0, 1, null, null, false, 0, -1);
    if (landed && stacks > 0 && target.alive) addShock(ctx, target, stacks, 0);
    if (area) {
      const n = ctx.grid.within(target.x, target.y, r * r, targets);
      for (let j = 0; j < n; j++) {
        const enemy = targets[j] as Enemy;
        if (enemy !== target && enemy.alive) {
          hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, 0, -1);
        }
      }
    }
    // struck <= k: the slot is one already read.
    picks[struck++] = target;
  }
  if (spec.chainJumps > 0) {
    chainGeneral(ctx, em.chainPayload as Payload, picks, struck, spec.chainJumps, false, 0, -1);
  }
  endAttack(ctx);
}

/**
 * A strike's area radius as the build sizes it: sizeOf(radius), × BuildFlags.thornsFactor after
 * it for a thorns-tagged strike (lead ruling 21 of B4).
 */
function strikeRadius(build: CompiledBuild, spec: StrikeSpec): number {
  const r = sizeOf(build, spec.radius);
  return (spec.tags & TAG.thorns) === 0 ? r : r * build.flags.thornsFactor;
}
