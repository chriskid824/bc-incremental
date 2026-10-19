/**
 * The general chain path (docs/GDD.md §2–3): a chain run level by level, breadth first, for a
 * payload with a chain policy (Payload.policy, src/sim/systems/systemState.ts ChainPolicy) or
 * whose chain hits do more than hit (Payload.general). Level k holds the enemies jumped to from
 * level k − 1, the chain's roots at level 0; each jumps to as many of the nearest enemies the
 * attack has not hit as the policy's branch says, the last level to the farthest under 遠雷, and
 * every hit of a level keeps the level's share of the damage (ChainPolicy.scale). Jumps the
 * rules add, extra jumps (跳電) and bounces (回彈), are hits of the payload's extraJumpPayload and
 * count against EXTRA_JUMP_CAP; every hit counts against CHAIN_HIT_CAP (src/sim/caps.ts). Each
 * jump hit of a payload that shocks on hit (Payload.shockOnHit, a chainBolt's) then shocks its
 * enemy if it is alive. With the run's table without a policy (RunContext.sys.chain.noPolicy)
 * it deals what the linear path does (chainFrom, src/sim/combat/chain.ts), hit for hit.
 */

import { addShock } from '../ailments/shock';
import { CHAIN_HIT_CAP, EXTRA_JUMP_CAP } from '../caps';
import type { Payload } from '../emitters/types';
import type { Enemy, RunContext } from '../systems/context';
import { nearestChainTarget } from './chain';
import { hitWithPayload } from './hit';

/**
 * The current attack's chain of payload `p` from the nRoots enemies roots[0 .. nRoots) (level
 * 0, ctx.sys.chain.frontier), `jumps` levels deep at most. Each enemy of a level jumps up to the
 * policy's branch times, and once one finds no enemy in range its siblings stop too; an enemy
 * that finds none at its first jump re-hits itself instead while the policy has bounces left
 * and it is alive. Every jump hit rolls once on the payload's stream for an extra jump, which
 * runs after the last level from the last enemy hit, the levels continuing. A jump the attack's
 * CHAIN_HIT_CAP refuses counts in chainHitCapped, and when it leaves a level empty, so do the
 * levels left under it; an extra-jump roll or a bounce past EXTRA_JUMP_CAP counts in
 * extraJumpsCapped, with no roll drawn. `steady`, `depth` and `origin` as in chainAttack.
 */
export function chainGeneral(
  ctx: RunContext,
  p: Payload,
  roots: readonly Enemy[],
  nRoots: number,
  jumps: number,
  steady: boolean,
  depth: number,
  origin: number,
): void {
  const chain = ctx.sys.chain;
  const pol = p.policy ?? chain.noPolicy;
  const budget = ctx.chainBudget;
  const counters = ctx.counters;
  const branch = pol.branch;
  const scale = pol.scale;
  const lastBranch = branch.length - 1;
  const lastLevel = scale.length - 1;
  // Level k − 1 is read from frontier while level k is written to next, and the two level
  // buffers take turns: roots, when it is chain.frontier, is written only once level 1 read it.
  let frontier = roots;
  let next = chain.next;
  let spare = chain.frontier;
  let fn = nRoots;
  let last = roots[nRoots - 1] as Enemy;
  let extra = 0;
  let bounced = 0;
  let kDone = 0;
  let capped = 0;
  for (let k = 1; k <= jumps; k++) {
    const r = scale[Math.min(k, lastLevel)] as number;
    const br = branch[Math.min(k, lastBranch)] as number;
    const farthest = pol.lastFarthest && k === jumps;
    let nn = 0;
    let refused = 0;
    for (let i = 0; i < fn; i++) {
      const node = frontier[i] as Enemy;
      for (let j = 0; j < br; j++) {
        if (budget.hits >= CHAIN_HIT_CAP) {
          refused++;
          continue;
        }
        const nxt = farthest
          ? farthestChainTarget(ctx, node.x, node.y)
          : nearestChainTarget(ctx, node.x, node.y);
        if (nxt === null) {
          // 回彈: the enemy re-hits itself, a jump the rules add.
          if (j === 0 && bounced < pol.bounces && node.alive) {
            if (budget.extraJumps < EXTRA_JUMP_CAP) {
              bounced++;
              budget.extraJumps++;
              budget.hits++;
              jumpHit(ctx, p.extraJumpPayload, node, k, r, node.x, node.y, steady, depth, origin);
              next[nn++] = node;
            } else counters.extraJumpsCapped++;
          }
          // Its siblings would find none either.
          break;
        }
        budget.hits++;
        jumpHit(ctx, p, nxt, k, r, node.x, node.y, steady, depth, origin);
        next[nn++] = nxt;
        last = nxt;
        // 跳電: one roll per jump hit, none once the attack has its extra jumps.
        if (pol.extraJumpChance > 0) {
          if (budget.extraJumps < EXTRA_JUMP_CAP) {
            if (p.rng.chance(pol.extraJumpChance)) {
              budget.extraJumps++;
              extra++;
            }
          } else counters.extraJumpsCapped++;
        }
      }
    }
    capped += refused;
    kDone = k;
    if (nn === 0) {
      // The levels left would be refused too.
      if (refused > 0) capped += refused * (jumps - k);
      break;
    }
    const filled = next;
    next = spare;
    spare = filled;
    frontier = filled;
    fn = nn;
  }
  for (let e = 0; e < extra; e++) {
    if (budget.hits >= CHAIN_HIT_CAP) {
      capped += extra - e;
      break;
    }
    const nxt = nearestChainTarget(ctx, last.x, last.y);
    if (nxt === null) break;
    const k = kDone + 1 + e;
    const r = scale[Math.min(k, lastLevel)] as number;
    budget.hits++;
    jumpHit(ctx, p.extraJumpPayload, nxt, k, r, last.x, last.y, steady, depth, origin);
    last = nxt;
  }
  counters.chainHitCapped += capped;
}

/**
 * Jump hit `k` of payload `q` on `enemy` at `scale` from (fromX, fromY), as hitWithPayload, then
 * q's shockOnHit stacks of shock on the enemy if the hit left it alive, at `depth`.
 */
function jumpHit(
  ctx: RunContext,
  q: Payload,
  enemy: Enemy,
  k: number,
  scale: number,
  fromX: number,
  fromY: number,
  steady: boolean,
  depth: number,
  origin: number,
): void {
  hitWithPayload(ctx, enemy, q, k, scale, fromX, fromY, steady, depth, origin);
  if (q.shockOnHit > 0 && enemy.alive) addShock(ctx, enemy, q.shockOnHit, depth);
}

/**
 * Alive enemy farthest from (x, y) within chain range (inclusive) not hit by the current attack;
 * the lower id on ties (遠雷). Its within() output is ctx.sys.chain.far.
 */
export function farthestChainTarget(ctx: RunContext, x: number, y: number): Enemy | null {
  const far = ctx.sys.chain.far;
  const n = ctx.grid.within(x, y, ctx.chainRangeSq, far);
  const attackSerial = ctx.attackSerial;
  let best: Enemy | null = null;
  let bestDistSq = -1;
  for (let i = 0; i < n; i++) {
    const enemy = far[i] as Enemy;
    if (enemy.hitMark === attackSerial) continue;
    const dx = enemy.x - x;
    const dy = enemy.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq > bestDistSq) {
      best = enemy;
      bestDistSq = distSq;
    }
  }
  return best;
}
