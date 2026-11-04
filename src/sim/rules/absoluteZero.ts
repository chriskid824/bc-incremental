/**
 * absoluteZero (絕對零度, the ice outer's ★ and 霜晶's; docs/v3/game-design-v3.md §4.7): every
 * enemy always carries globalSlow (BuildFlags.globalSlow, the largest instance's), a freeze leaves
 * no immunity after it (frostImmuneTicks 0), a boss's filled meter locks for no longer than
 * bossGapSec (its freeze events stay at least that far apart), and the attack speed takes the
 * product of the instances' (1 + attackSpeedMore).
 */

import type { RuleSpec } from '../../data/rules';
import { TICK_RATE } from '../types';
import type { RuleModule } from './module';

export const absoluteZero: RuleModule<Extract<RuleSpec, { id: 'absoluteZero' }>> = {
  id: 'absoluteZero',
  compile(b, specs) {
    let slow = 0;
    let gap = 0;
    let speed = 1;
    for (const spec of specs) {
      slow = Math.max(slow, spec.globalSlow);
      gap = Math.max(gap, spec.bossGapSec);
      speed *= 1 + spec.attackSpeedMore;
    }
    b.flags.globalSlow = Math.max(b.flags.globalSlow, slow);
    b.flags.frostImmuneTicks = 0;
    b.flags.bossLockTicks = 0;
    b.flags.bossMinGapTicks = Math.max(b.flags.bossMinGapTicks, Math.round(gap * TICK_RATE));
    b.scaleStat('attackSpeed', speed);
  },
};
