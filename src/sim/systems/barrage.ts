/**
 * The barrage rider (副彈, docs/v3/game-design-v3.md §4.11, E10a): 「小彈是跟著你的攻擊一起射出的
 * 小投射物，每發是一次小擊中」. Each counted attack of the signature emitter, once its own
 * projectiles, cones, bombs, discharge, impact hits or turret shots are out, fires the rider's
 * small shots (EmitterRuntime.barrage) from the attack's origin: the player for the volley, the
 * lob (at the throw), the fan and the arc; a swarm drone's position at its impact; a signature
 * turret's seat. Its picks are the `count` nearest distinct alive enemies to the origin, ties to
 * the lower id, at any distance, outside the arena too (nearestAlive: the projectiles effects'
 * 'distinct' aim; lead ruling W16); with fewer enemies, the shots past them are lost. A drone's
 * origin lies inside the enemy it impacted, so its rider skips that enemy in its picks and each
 * shot starts out remembering it (SHOT_MEMORY), passing through it (lead ruling W15): the picks
 * are the nearest others, 「射向不同的敵人」 (gd:488). Each shot flies straight from the origin towards
 * its pick's position at the firing, at the straight projectiles effects' speed
 * (RunContext.projectileStep), for SMALL_PROJECTILE_TICKS: no homing. As any straight shot of the
 * pool (src/sim/systems/shots.ts) it hits the enemies its path touches, `hits` of them at most,
 * and bounces off the arena's edge `bounce` times. Its hits are plain hits of the rider's
 * payload, at depth 0 from origin −1 on the barrage stream: no attack, no PRIMARY, no chain. A
 * shot is refused while SMALL_SHOT_CAP projectiles are in flight, and each refused one counts in
 * barrageCapped, so the rider leaves the pool's last slots to the others. A repeat, a granted
 * emitter, a spirit and a triggered effect carry no rider and fire none.
 */

import { SMALL_PROJECTILE_TICKS, SMALL_SHOT_CAP } from '../caps';
import { nearestAlive } from '../effects/execute';
import type { BarrageRider } from '../emitters/types';
import type { Enemy, RunContext } from './context';
import { liveProjectiles, MOTION_STRAIGHT, remember, spawnShot } from './shots';

/**
 * Fires `rider`'s shots from (x, y), the origin of the attack it follows; `skip`, an impact's
 * target, is no pick and every shot passes through it (null for every other origin). A pick on
 * the origin gives no direction: its shot flies away from the player, as a 'radial' projectiles
 * effect's first one does, +x when the origin is the player too.
 */
export function fireBarrage(
  ctx: RunContext,
  rider: BarrageRider,
  x: number,
  y: number,
  skip: Enemy | null = null,
): void {
  const picks = nearestAlive(ctx, rider.count, x, y, skip);
  const distinct = ctx.shots.distinct;
  const step = ctx.projectileStep;
  const until = ctx.now + SMALL_PROJECTILE_TICKS;
  const { payload, hits, bounce } = rider;
  for (let i = 0; i < picks; i++) {
    if (liveProjectiles(ctx) >= SMALL_SHOT_CAP) {
      // No shot ends within the call, so the rest are refused too.
      ctx.counters.barrageCapped += picks - i;
      return;
    }
    const e = distinct[i] as Enemy;
    let dx = e.x - x;
    let dy = e.y - y;
    if (dx === 0 && dy === 0) {
      dx = x - ctx.player.x;
      dy = y - ctx.player.y;
      if (dx === 0 && dy === 0) dx = 1;
    }
    const k = step / Math.sqrt(dx * dx + dy * dy);
    // Below SMALL_SHOT_CAP, PROJECTILE_CAP never refuses it: its slot is a shot's.
    const slot = spawnShot(
      ctx,
      MOTION_STRAIGHT,
      x,
      y,
      dx * k,
      dy * k,
      until,
      payload,
      1,
      hits,
      bounce,
      0,
      -1,
      false,
      -1,
      -1,
      null,
    );
    if (skip !== null) remember(ctx.shots, slot, skip.id);
  }
}
