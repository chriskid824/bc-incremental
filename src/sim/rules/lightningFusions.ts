/**
 * The hand fusion cores of 熔核 and 蜂巢 with the lightning outer (docs/v3/game-design-v3.md §5.2;
 * B3), each from a spec the fusion's coefficient already scaled (RULE_COEF_FIELDS).
 * - plasma (火雷「電漿」): each signature bomb's explosion sends, from each burning enemy of its
 *   list (the first LIST_MAX it hit, alive), a one-jump chain bolt at the nearest enemy, at most
 *   arcsPerBlast a bomb (an onCenterEvent hook queueing the bolt at each such enemy,
 *   enqueueModuleEffect); a shocked enemy takes shockBurnMore more burn damage. A compile error in
 *   a run of another signature.
 * - stormWeb (雷召喚「雷網蜂」): a segment emitter between the drones (endpoints 'drones', one link
 *   each, paired every pairPeriodSec and judged every periodSec): every enemy on a link takes a
 *   hit of damagePct of the damage stat and one shock stack, once a judgement
 *   (src/sim/systems/segments.ts). A compile error in a run of another signature.
 */

import type { RuleSpec } from '../../data/rules';
import { CENTER_EVENTS } from '../../data/triggers';
import { holdsBurn } from '../ailments/records';
import { enqueueModuleEffect } from './api';
import { swarmParams } from './hive';
import { lobParams } from './lobForms';
import type { RuleModule } from './module';

const EXPLODE = CENTER_EVENTS.indexOf('explode');

export const plasma: RuleModule<Extract<RuleSpec, { id: 'plasma' }>> = {
  id: 'plasma',
  compile(b, specs) {
    lobParams(b, 'plasma');
    const { name } = b.credit();
    let more = 0;
    for (const spec of specs) {
      const bolt = b.addEffect(name, {
        kind: 'chainBolt',
        jumps: 1,
        damagePct: spec.arcDamagePct,
        shockStacks: 1,
      });
      const cap = spec.arcsPerBlast;
      const trigger = b.hook('onCenterEvent', (ctx, ev) => {
        if (ev.event !== EXPLODE) return;
        let sent = 0;
        for (let i = 0; i < ev.listCount && sent < cap; i++) {
          const enemy = ev.list[i];
          if (enemy === undefined || !enemy.alive || !holdsBurn(enemy, ctx.now)) continue;
          enqueueModuleEffect(ctx, trigger, bolt, {
            depth: ev.depth,
            origin: ev.origin,
            target: enemy,
            x: enemy.x,
            y: enemy.y,
            flags: ev.flags,
          });
          sent++;
        }
      });
      more += spec.shockBurnMore;
    }
    if (more > 0) {
      b.addModifier({
        stat: 'damage',
        kind: 'more',
        value: more,
        tags: ['burn'],
        when: [{ targetHas: 'shock' }],
      });
    }
  },
};

export const stormWeb: RuleModule<Extract<RuleSpec, { id: 'stormWeb' }>> = {
  id: 'stormWeb',
  compile(b, specs) {
    swarmParams(b, 'stormWeb');
    const { name } = b.credit();
    for (const spec of specs) {
      b.addEmitter(name, {
        kind: 'segment',
        endpoints: 'drones',
        links: 1,
        damagePct: spec.damagePct,
        shockStacks: 1,
        periodSec: spec.periodSec,
        pairPeriodSec: spec.pairPeriodSec,
      });
    }
  },
};
