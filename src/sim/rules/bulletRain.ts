/**
 * bulletRain (彈雨, the barrage outer's threshold; docs/v3/game-design-v3.md §4.11, Q12 A): for
 * the last durationSec of every periodSec of the run, each counted attack sends countMult times
 * the barrage entry's small projectiles: countMult − 1 more volleys of them (an onAttack hook
 * queueing the volley, enqueueModuleEffect), each as the entry's: barrageCount homing shots of
 * damagePct from the player at the nearest enemies (aim 'distinct', countStat). Of several
 * instances, each adds its own.
 *
 * TODO(engine B3, E10a/E10b): once the barrage rider core lands, this module sets its params'
 * `rain` window instead, so the window multiplies every shot of the barrage outer (lead ruling
 * A25), not only the entry's volley.
 */

import type { RuleSpec } from '../../data/rules';
import { TICK_RATE } from '../types';
import { enqueueModuleEffect } from './api';
import type { RuleModule } from './module';

export const bulletRain: RuleModule<Extract<RuleSpec, { id: 'bulletRain' }>> = {
  id: 'bulletRain',
  compile(b, specs) {
    const { name } = b.credit();
    for (const spec of specs) {
      const volley = b.addEffect(name, {
        kind: 'projectiles',
        count: 2,
        damagePct: spec.damagePct,
        aim: 'distinct',
        from: 'player',
        countStat: 'barrageCount',
      });
      const period = Math.round(spec.periodSec * TICK_RATE);
      const from = period - Math.round(spec.durationSec * TICK_RATE);
      const extra = spec.countMult - 1;
      const trigger = b.hook('onAttack', (ctx) => {
        if (ctx.now % period < from) return;
        const { x, y } = ctx.player;
        for (let i = 0; i < extra; i++) {
          enqueueModuleEffect(ctx, trigger, volley, { depth: 0, origin: -1, x, y, flags: 0 });
        }
      });
    }
  },
};
