/**
 * The barrage outer's ◆ nodes (docs/v3/game-design-v3.md §4.11), on E10b's rider params
 * (BuildFlags.barrage, src/sim/systems/barrage.ts). Without 副彈's barrage grant they do nothing.
 * - barrageFan (◆扇形): every small shot goes at one target, spread over spreadDeg.
 * - barrageRing (◆環射): every `every`-th attack also fires `directions` shots evenly round.
 * - clusterShot (◆子母彈): a small shot that kills splits into `count` (with `chance`, plus the
 *   barrageSplit stat); the split ones do not split again.
 * - barrageFocus (◆聚焦): while `when` holds (a boss alive, or one enemy left), every small shot
 *   goes at that target at 1 + bonus.
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const barrageFan: RuleModule<Extract<RuleSpec, { id: 'barrageFan' }>> = {
  id: 'barrageFan',
  compile(b, specs) {
    for (const spec of specs) {
      b.flags.barrage.aim = 'fan';
      b.flags.barrage.spreadDeg = spec.spreadDeg;
    }
  },
};

export const barrageRing: RuleModule<Extract<RuleSpec, { id: 'barrageRing' }>> = {
  id: 'barrageRing',
  compile(b, specs) {
    for (const spec of specs) {
      b.flags.barrage.ring = { every: spec.every, directions: spec.directions };
    }
  },
};

export const clusterShot: RuleModule<Extract<RuleSpec, { id: 'clusterShot' }>> = {
  id: 'clusterShot',
  compile(b, specs) {
    for (const spec of specs) {
      b.flags.barrage.split = { count: spec.count, chance: spec.chance };
    }
  },
};

export const barrageFocus: RuleModule<Extract<RuleSpec, { id: 'barrageFocus' }>> = {
  id: 'barrageFocus',
  compile(b, specs) {
    for (const spec of specs) {
      b.flags.barrage.focus = { bonus: spec.bonus, when: spec.when };
    }
  },
};
