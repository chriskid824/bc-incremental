/**
 * Wave control (docs/v3/implementation-plan-v3.md §2.15, docs/GDD.md §2.1): starts waves,
 * shuffling each wave's enemies into its spawn queue, and records cleared waves.
 */

import { ZERO } from '../../core/num';
import { composeWave } from '../../data/compose';
import { shardsPerStdEnemy, stdHp } from '../../data/curve';
import type { EnemyDef } from '../../data/types';
import { fire } from '../effects/dispatch';
import { EVENT } from '../effects/types';
import type { RunContext, WaveRecord } from './context';

/** Starts wave `wave`: its spawn queue, its record, and the waveStart triggers at the player. */
export function startWave(ctx: RunContext, wave: number): void {
  const queue: EnemyDef[] = [];
  for (const entry of composeWave(wave, ctx.data.waves)) {
    const def = ctx.data.enemies[entry.enemy];
    for (let i = 0; i < entry.count; i++) queue.push(def);
  }
  for (let i = queue.length - 1; i > 0; i--) {
    const j = ctx.spawnRng.int(i + 1);
    const swap = queue[i] as EnemyDef;
    queue[i] = queue[j] as EnemyDef;
    queue[j] = swap;
  }
  const rec: WaveRecord = {
    wave,
    queue,
    released: 0,
    delayed: 0,
    startTick: ctx.now,
    alive: 0,
    cleared: false,
    leaked: false,
    stdHp: stdHp(wave),
    shardsPerStd: shardsPerStdEnemy(wave),
  };
  ctx.open.push(rec);
  ctx.current = rec;
  if (wave === ctx.startWaveNumber) ctx.startRec = rec;
  const state = ctx.state;
  state.wave = wave;
  state.highestWaveReached = wave;
  ctx.events.push({ type: 'waveStarted', wave });
  const player = ctx.player;
  fire(ctx, EVENT.waveStart, 0, -1, null, player.x, player.y, 0, ZERO);
}

/**
 * Starts the first wave, or the next one once the field is clear (every started wave is
 * cleared, docs/GDD.md §2.1) or the current wave has run for waveTimerSec.
 */
export function startDueWave(ctx: RunContext): void {
  const current = ctx.current;
  if (current === null) {
    startWave(ctx, ctx.startWaveNumber);
  } else if (
    current.wave < ctx.waveCap &&
    (ctx.open.length === 0 || ctx.now - current.startTick >= ctx.waveTimerTicks)
  ) {
    startWave(ctx, current.wave + 1);
  }
}

export function updateClears(ctx: RunContext): void {
  const open = ctx.open;
  const state = ctx.state;
  let kept = 0;
  for (let r = 0; r < open.length; r++) {
    const rec = open[r] as WaveRecord;
    if (rec.alive === 0 && rec.released === rec.queue.length) {
      rec.cleared = true;
      if (rec.wave > state.highestWaveCleared) state.highestWaveCleared = rec.wave;
      ctx.events.push({ type: 'waveCleared', wave: rec.wave });
    } else {
      open[kept++] = rec;
    }
  }
  open.length = kept;
}
