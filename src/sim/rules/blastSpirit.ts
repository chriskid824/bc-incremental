/**
 * blastSpirit (爆靈, 熔核's 火靈 hand core; docs/v3/game-design-v3.md:525): 「每第 4 發熔岩彈生出
 * 1 隻 4 秒的火靈，衝向最近的敵人爆炸並點燃 3 層（最多 6 隻）」. Each instance compiles one
 * spawnDrone effect (a timed row of the drone pool, src/sim/systems/drones.ts) and an
 * onCenterEvent hook that counts the signature bombs' explosions in a closure, so a run starts
 * its count at 0, and queues the effect at every `every`-th one, at the explosion
 * (enqueueModuleEffect). The spirit dashes at the nearest enemy, impacts once for damagePct of
 * the damage stat and ignites burnStacks burn stacks (each of burnDamagePct) on the enemies in
 * its splash; maxLive of the instance's spirits live at once, the run's summon cap over all. A
 * compile error in a run of another signature.
 */

import type { RuleSpec } from '../../data/rules';
import { CENTER_EVENTS } from '../../data/triggers';
import { enqueueModuleEffect } from './api';
import { lobParams } from './lobForms';
import type { RuleModule } from './module';

const EXPLODE = CENTER_EVENTS.indexOf('explode');

export const blastSpirit: RuleModule<Extract<RuleSpec, { id: 'blastSpirit' }>> = {
  id: 'blastSpirit',
  compile(b, specs) {
    lobParams(b, 'blastSpirit');
    const { name } = b.credit();
    for (const spec of specs) {
      const effect = b.addEffect(name, {
        kind: 'spawnDrone',
        lifeSec: spec.lifeSec,
        damagePct: spec.damagePct,
        maxLive: spec.maxLive,
        ailment: 'burn',
        ailmentStacks: spec.burnStacks,
        ailmentDamagePct: spec.burnDamagePct,
        // A trigger's hits, as the other trigger effects': drone-only modifiers leave them out.
        tags: ['trigger'],
      });
      let bombs = 0;
      const trigger = b.hook('onCenterEvent', (ctx, ev) => {
        if (ev.event !== EXPLODE) return;
        bombs++;
        if (bombs % spec.every === 0) enqueueModuleEffect(ctx, trigger, effect, ev);
      });
    }
  },
};
