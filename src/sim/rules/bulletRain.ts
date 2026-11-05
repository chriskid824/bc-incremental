/**
 * bulletRain (彈雨, the barrage outer's threshold; docs/v3/game-design-v3.md §4.11, Q12 A): for
 * the first durationSec of every periodSec of the run, the barrage rider's shots, ring and
 * children are ×countMult (E10b's rain param, BuildFlags.barrage.rain, lead ruling A25).
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const bulletRain: RuleModule<Extract<RuleSpec, { id: 'bulletRain' }>> = {
  id: 'bulletRain',
  compile(b, specs) {
    for (const spec of specs) {
      b.flags.barrage.rain = {
        periodSec: spec.periodSec,
        activeSec: spec.durationSec,
        countMult: spec.countMult,
      };
    }
  },
};
