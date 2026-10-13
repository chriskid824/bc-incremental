/**
 * Run end (docs/v3/implementation-plan-v3.md §2.15): overkill tracking, the end checks
 * (death, wave cap, timeout) and the RunResult.
 */

import type { EnemyId } from '../../data/types';
import { ENEMY_IDS } from '../../data/types';
import { TICK_RATE } from '../types';
import type { ContactTally, EndReason } from '../types';
import type { RunContext } from './context';

/**
 * Counts ticks whose current wave's standard enemy hp is at most 1/10 of the average primary
 * hit (RunResult.overkillSeconds, docs/GDD.md §2.2).
 */
export function trackOverkill(ctx: RunContext): void {
  const wave = ctx.current;
  if (wave !== null && wave.stdHp * 10 <= ctx.expectedHit) ctx.overkillTicks++;
}

/** Ends the run on death, once the cap wave is cleared, or at maxTicks, in that order. */
export function checkRunEnd(ctx: RunContext): void {
  const wave = ctx.current;
  if (ctx.player.life <= 0) end(ctx, 'death');
  else if (wave !== null && wave.wave === ctx.waveCap && ctx.open.length === 0) end(ctx, 'waveCap');
  else if (ctx.now >= ctx.maxTicks) end(ctx, 'timeout');
}

function end(ctx: RunContext, reason: EndReason): void {
  const state = ctx.state;
  state.finished = true;
  ctx.events.push({ type: 'runEnded', reason });
  const takenBy = {} as Record<EnemyId, ContactTally>;
  let leaks = 0;
  let damageTaken = 0;
  for (const id of ENEMY_IDS) {
    const tally = ctx.taken[id];
    takenBy[id] = { hits: tally.hits, damage: tally.damage };
    leaks += tally.hits;
    damageTaken += tally.damage;
  }
  const startRec = ctx.startRec;
  ctx.runResult = {
    startWave: ctx.startWaveNumber,
    highestWaveReached: state.highestWaveReached,
    highestWaveCleared: state.highestWaveCleared,
    clearedStartWave: startRec !== null && startRec.cleared && !startRec.leaked,
    endReason: reason,
    ticks: state.tick,
    shards: state.shards,
    cores: state.cores,
    kills: ctx.kills,
    damage: {
      hit: ctx.damageHit,
      crit: ctx.damageCrit,
      burn: ctx.damageBurn,
      chain: ctx.damageChain,
    },
    maxHit: ctx.maxHit,
    overkillSeconds: ctx.overkillTicks / TICK_RATE,
    leaks,
    damageTaken,
    damageTakenBy: takenBy,
    killedBy: ctx.killedBy,
  };
}
