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
 * (src/sim/targeting.ts).
 * Keystone and notable rules (config.rules) are compiled once per run (src/sim/rules.ts).
 */

import { DAMAGE_TAG_MASK_COUNT, STAT_IDS } from '../data/stats';
import type { GameData } from '../data/types';
import { updateBurns } from './systems/ailments';
import { resolveContacts } from './systems/contact';
import { createRunContext } from './systems/context';
import { compact } from './systems/death';
import { attack } from './systems/emitters';
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
  const { values, damageMult } = config.stats;
  for (const id of STAT_IDS) {
    if (!Number.isFinite(values[id])) throw new RangeError(`Stat ${id} is not finite`);
  }
  if (values.maxLife <= 0) throw new RangeError('maxLife must be positive');
  if (values.projectileSpeed <= 0) throw new RangeError('projectileSpeed must be positive');
  if (damageMult.length !== DAMAGE_TAG_MASK_COUNT || !damageMult.every(Number.isFinite)) {
    throw new RangeError(`damageMult must hold ${DAMAGE_TAG_MASK_COUNT} finite numbers`);
  }
}

export function createSimulation(config: RunConfig, data: GameData): Simulation {
  validateConfig(config);
  const ctx = createRunContext(config, data);
  const { state, events } = ctx;

  /**
   * Advances one tick. The systems run in the tick order of
   * docs/v3/implementation-plan-v3.md §2.15, as far as they exist yet:
   *
   * 1. input: ignored; the only control mode is 'auto'.
   * 2. spawn: start the due wave (waveControl's wave start, waves.ts), then release queued
   *    enemies (spawn.ts), so a new wave's first enemy appears on its start tick.
   * 3. movement: every enemy walks towards the player (movement.ts).
   * 4. contact: enemies that reached the player hit it and leak (contact.ts).
   * 5. emitters: due attacks fire projectiles (emitters.ts).
   * 6. projectiles: move, retarget, and hit on arrival (projectiles.ts). Hits and chains
   *    (hits.ts) and kills with their spread, drops and splits (death.ts) resolve inline.
   * 7. ailments: burn stacks expire; burn damage every BURN_TICK_INTERVAL (ailments.ts).
   * 8. death: compact dead enemies and projectiles (death.ts).
   * 9. waveControl: record cleared waves (waves.ts).
   * 10. runEnd: overkill tracking, then the end checks (runEnd.ts).
   *
   * Steps 5–7 run only while the player is alive.
   */
  function step(_input: InputFrame): readonly SimEvent[] {
    events.length = 0;
    if (state.finished) return events;
    ctx.now = ++state.tick;

    startDueWave(ctx);
    releaseEnemies(ctx);
    moveEnemies(ctx);
    resolveContacts(ctx);
    if (ctx.player.life > 0) {
      attack(ctx);
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
