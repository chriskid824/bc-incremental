/**
 * Deterministic run simulation (docs/ARCHITECTURE.md §4, docs/GDD.md §2–3, §7).
 *
 * createSimulation validates the config, builds the run context once
 * (src/sim/systems/context.ts) and each step() advances one fixed tick, running the systems
 * in src/sim/systems/ in a fixed order (see step() and docs/v3/implementation-plan-v3.md
 * §2.15).
 * Randomness comes only from the seeded spawn, split, combat, drops, trigger and effects
 * streams, and entity arrays stay ordered by increasing id, so a seed fully determines the run.
 * Projectiles spread over enemies that projectiles already in flight will not kill, focus
 * elites and bosses that come close, and retarget when their target dies first
 * (src/sim/targeting.ts). Target queries read a spatial grid rebuilt every tick
 * (src/sim/grid.ts), with exactly the results of a linear scan.
 * The build's stats and keystone rules (config.rules, or a character run's sourced
 * config.character.rules) compile once per run (src/sim/build/compile.ts): each rule is a module
 * (src/sim/rules/) that changes stats, flags and modifiers and may hook into the tick. A
 * character run also credits ailments and the center's chain jumps by its character
 * (src/sim/build/sources.ts). The scoped stats (damage multiplier, crit and ignite
 * chances, crit multiplier) per tag mask and damage source fill a ModTable on first use
 * (src/sim/build/modTable.ts, src/sim/build/sources.ts).
 * The build's triggers (StatBlock.triggers, and those rule modules add) listen to events of the
 * run; the effects of those that fire wait in a queue for the tick's effect phase
 * (src/sim/effects/).
 */

import { CHARACTER_SIGNATURE } from '../data/rules';
import type { RuleId } from '../data/rules';
import { STAT_IDS } from '../data/stats';
import type { SourcedRule } from '../data/stats';
import { COEF_MAX, COEF_MIN } from '../data/triggers';
import type { GameData } from '../data/types';
import { dispatchPendingKills } from './effects/dispatch';
import { runEffectQueue } from './effects/execute';
import { updateAilments } from './systems/ailments';
import { resolveContacts } from './systems/contact';
import { createRunContext } from './systems/context';
import type { TestModule } from './rules';
import { compact } from './systems/death';
import { stepDrones } from './systems/drones';
import { runEmitters, runTickHooks } from './systems/emitters';
import { rebuildGrid } from './systems/grid';
import { moveEnemies } from './systems/movement';
import { moveProjectiles } from './systems/projectiles';
import { checkRunEnd, trackOverkill } from './systems/runEnd';
import { stepSegments } from './systems/segments';
import { releaseEnemies } from './systems/spawn';
import { stepZones } from './systems/zones';
import { startDueWave, updateClears } from './systems/waves';
import type { InputFrame, RunConfig, RunResult, SimEvent, Simulation } from './types';

export { BURN_TICK_INTERVAL } from './ailments/records';

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
  // A fusion's coefficient stays in its range, and a transfer it scales below 1 (docs/v3 C6
  // design D10, F39).
  const legalCoef = (coef: number): boolean =>
    Number.isFinite(coef) && coef >= COEF_MIN && coef <= COEF_MAX;
  for (const { spec, coef } of config.stats.triggers) {
    if (coef === undefined) continue; // every M1 trigger
    if (!legalCoef(coef)) {
      throw new RangeError(`A trigger's coef must be in [${COEF_MIN}, ${COEF_MAX}], got ${coef}`);
    }
    for (const effect of spec.do) {
      if (effect.kind === 'spreadAilment' && (effect.effect ?? 1) * coef >= 1) {
        throw new RangeError(
          `A transfer at effect ${effect.effect ?? 1} × coef ${coef} must stay below 1`,
        );
      }
    }
  }
  // A character run (docs/v3 C6 design D7, D9): its rules come sourced, one source and one coef
  // per rule id, and it attacks with its character's signature. The character is never derived
  // from the signature.
  const character = config.character;
  if (character !== undefined) {
    if (config.rules.length > 0) {
      throw new Error('A character run takes its rules from character.rules');
    }
    if (config.signature?.id !== CHARACTER_SIGNATURE[character.id]) {
      throw new Error(
        `Character '${character.id}' attacks with ${CHARACTER_SIGNATURE[character.id]}`,
      );
    }
    const first = new Map<RuleId, SourcedRule>();
    for (const rule of character.rules) {
      if (!legalCoef(rule.coef)) throw new RangeError(`Rule '${rule.spec.id}': coef ${rule.coef}`);
      const seen = first.get(rule.spec.id);
      if (seen === undefined) first.set(rule.spec.id, rule);
      else if (seen.source !== rule.source || seen.coef !== rule.coef) {
        throw new Error(
          `Rule '${rule.spec.id}' on sources '${seen.source}' and '${rule.source}': ` +
            'one source and one coef per rule id',
        );
      }
    }
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
  // The segment emitters are fixed with the run context. A stage with nothing to do is not
  // called, since a call made every tick, even one that returns at once, takes from V8's
  // inlining budget for step and leaves other stages out of it.
  const segments = ctx.sys.segments.emitters.length !== 0;

  /**
   * Advances one tick. The systems run in the tick order of
   * docs/v3/implementation-plan-v3.md §2.15, as far as they exist yet:
   *
   * 1. input: ignored; the only control mode is 'auto'.
   * 2. spawn: start the due wave (waveControl's wave start, waves.ts) with its waveStart
   *    triggers, then release queued enemies (spawn.ts), so a new wave's first enemy appears on
   *    its start tick.
   * 3. movement: every enemy walks towards the player (movement.ts).
   * 4. grid: sort the enemies into the spatial grid for this tick's target queries (grid.ts).
   * 5. contact: enemies that reached the player hit it, through its defences (damage taken,
   *    shield, extra lives), and leak, raising heroHit and contact; then the player regenerates
   *    (contact.ts).
   * 6. emitters: each emitter's due attacks are counted, with the onAttack hooks and the
   *    nthAttack triggers, and fire projectiles; then the rule modules' tick hooks run
   *    (emitters.ts, src/sim/emitters/).
   * 6b. drones: the drone pool's slots step in id order (src/sim/systems/drones.ts): drones
   *    move, pick and impact, with their hits, chains and kills resolved inline as in step 7,
   *    and turrets fire homing shots, which move in step 7.
   * 7. projectiles: the volley's projectiles move, retarget, and hit on arrival, and the shot
   *    pool's shots move and hit, all in id order (projectiles.ts, shots.ts). Hits and chains
   *    (src/sim/combat/) with their hit and crit triggers, and kills with their transfer
   *    triggers, onKill hooks, drops and splits (death.ts) resolve inline.
   * 8. segments: the segment emitters due judge, in emitter order, linking the shocked
   *    enemies and hitting the enemies on the links (segments.ts).
   * 9. zones: the ground zones due pulse, in id order, and the ended ones are released
   *    (zones.ts).
   * 10. ailments: burn records expire; every BURN_TICK_INTERVAL, damage over time (burn, poison,
   *    bleed) and the ailmentTick triggers (ailments.ts, src/sim/ailments/).
   * 11. effects: due periodic triggers, then up to EFFECTS_PER_TICK queued effects
   *    (src/sim/effects/execute.ts).
   * 12. death: this tick's pending kill triggers fire, sorted by victim id (their effects run
   *    next tick); then compact dead enemies and projectiles (death.ts), after the last grid
   *    query.
   * 13. waveControl: record cleared waves (waves.ts).
   * 14. runEnd: overkill tracking, then the end checks (runEnd.ts).
   *
   * Steps 6–11 run only while the player is alive; 6b only while there is a drone, 8 in a run
   * with segment emitters and 9 while there is a zone (a run of M1's content has none of them).
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
      runEmitters(ctx);
      runTickHooks(ctx);
      if (ctx.sys.drones.count !== 0) stepDrones(ctx);
      moveProjectiles(ctx);
      if (segments) stepSegments(ctx);
      if (ctx.sys.zones.count !== 0) stepZones(ctx);
      updateAilments(ctx);
      runEffectQueue(ctx);
    }
    dispatchPendingKills(ctx);
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
