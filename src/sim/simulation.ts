/**
 * Deterministic run simulation (docs/ARCHITECTURE.md §4, docs/GDD.md §2–3, §7).
 *
 * createSimulation validates the config, builds the run context once
 * (src/sim/systems/context.ts) and each step() advances one fixed tick, running the systems
 * in src/sim/systems/ in a fixed order (see step() and docs/v3/implementation-plan-v3.md
 * §2.15).
 * Randomness comes only from the seeded spawn, split, combat and drops streams, and entity
 * arrays stay ordered by increasing id, so a seed fully determines the run.
 * Projectiles spread over enemies that projectiles already in flight will not kill, focus
 * elites and bosses that come close, and retarget when their target dies first
 * (src/sim/targeting.ts). Target queries read a spatial grid rebuilt every tick
 * (src/sim/grid.ts), with exactly the results of a linear scan.
 * The build's stats and keystone rules (config.rules) compile once per run
 * (src/sim/build/compile.ts): each rule is a module (src/sim/rules/) that changes stats, flags
 * and modifiers and may hook into the tick. The scoped stats (damage multiplier, crit and ignite
 * chances, crit multiplier) per tag mask and damage source fill a ModTable on first use
 * (src/sim/build/modTable.ts, src/sim/build/sources.ts).
 */

import { STAT_IDS } from '../data/stats';
import type { GameData } from '../data/types';
import { updateBurns } from './systems/ailments';
import { resolveContacts } from './systems/contact';
import { createRunContext } from './systems/context';
import type { TestModule } from './rules';
import { compact } from './systems/death';
import { attack, runTickHooks } from './systems/emitters';
import { rebuildGrid } from './systems/grid';
import { moveEnemies } from './systems/movement';
import { moveProjectiles } from './systems/projectiles';
import { checkRunEnd, trackOverkill } from './systems/runEnd';
import { releaseEnemies } from './systems/spawn';
import { startDueWave, updateClears } from './systems/waves';
import type { InputFrame, RunConfig, RunResult, SimEvent, Simulation } from './types';

export { BURN_TICK_INTERVAL, UNCAPPED_BURN_STACKS } from './systems/burn';

function validateConfig(config: RunConfig): void {
  if ((config.mode as string) !== 'auto') {
    throw new Error(`Unknown control mode '${config.mode}'; only 'auto' exists.`);
  }
  if (!Number.isInteger(config.startWave) || config.startWave < 1) {
    throw new RangeError(`startWave must be an integer >= 1, got ${config.startWave}`);
  }
  if (
    config.waveCap !== undefined &&
    (!Number.isInteger(config.waveCap) || config.waveCap < config.startWave)
  ) {
    throw new RangeError(`waveCap must be an integer >= startWave, got ${config.waveCap}`);
  }
  if (
    config.maxTicks !== undefined &&
    (!Number.isInteger(config.maxTicks) || config.maxTicks < 1)
  ) {
    throw new RangeError(`maxTicks must be an integer >= 1, got ${config.maxTicks}`);
  }
  const { base, values, scoped } = config.stats;
  for (const id of STAT_IDS) {
    if (!Number.isFinite(values[id])) throw new RangeError(`Stat ${id} is not finite`);
    if (!Number.isFinite(base[id])) throw new RangeError(`Base stat ${id} is not finite`);
  }
  if (values.maxLife <= 0) throw new RangeError('maxLife must be positive');
  if (values.projectileSpeed <= 0) throw new RangeError('projectileSpeed must be positive');
  for (const mod of scoped) {
    if (!Number.isFinite(mod.value)) throw new RangeError(`A ${mod.stat} modifier is not finite`);
  }
}

/**
 * A run of `config` on `data`. testModules are for tests only: rule modules without a RuleSpec
 * (src/sim/rules/module.ts).
 */
export function createSimulation(
  config: RunConfig,
  data: GameData,
  testModules: readonly TestModule[] = [],
): Simulation {
  validateConfig(config);
  const ctx = createRunContext(config, data, testModules);
  const { state, events } = ctx;

  /**
   * Advances one tick. The systems run in the tick order of
   * docs/v3/implementation-plan-v3.md §2.15, as far as they exist yet:
   *
   * 1. input: ignored; the only control mode is 'auto'.
   * 2. spawn: start the due wave (waveControl's wave start, waves.ts), then release queued
   *    enemies (spawn.ts), so a new wave's first enemy appears on its start tick.
   * 3. movement: every enemy walks towards the player (movement.ts).
   * 4. grid: sort the enemies into the spatial grid for this tick's target queries (grid.ts).
   * 5. contact: enemies that reached the player hit it and leak (contact.ts).
   * 6. emitters: due attacks fire projectiles, then the rule modules' tick hooks run
   *    (emitters.ts).
   * 7. projectiles: move, retarget, and hit on arrival (projectiles.ts). Hits and chains
   *    (hits.ts) and kills with their onKill hooks, drops and splits (death.ts) resolve
   *    inline.
   * 8. ailments: burn stacks expire; burn damage every BURN_TICK_INTERVAL (ailments.ts).
   * 9. death: compact dead enemies and projectiles (death.ts), after the last grid query.
   * 10. waveControl: record cleared waves (waves.ts).
   * 11. runEnd: overkill tracking, then the end checks (runEnd.ts).
   *
   * Steps 6–8 run only while the player is alive.
   */
  function step(_input: InputFrame): readonly SimEvent[] {
    events.length = 0;
    if (state.finished) return events;
    ctx.now = ++state.tick;

    startDueWave(ctx);
    releaseEnemies(ctx);
    moveEnemies(ctx);
    rebuildGrid(ctx);
    resolveContacts(ctx);
    if (ctx.player.life > 0) {
      attack(ctx);
      runTickHooks(ctx);
      moveProjectiles(ctx);
      updateBurns(ctx);
    }
    compact(ctx);
    updateClears(ctx);
    trackOverkill(ctx);
    checkRunEnd(ctx);
    return events;
  }

  return {
    state,
    step,
    result(): RunResult {
      const runResult = ctx.runResult;
      if (runResult === null) throw new Error('result() is available once the run has finished');
      return runResult;
    },
  };
}
