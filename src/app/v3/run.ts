/**
 * One run of a character on the v3 game page (docs/v3/game-design-v3.md §1, §7): the web's build
 * compiled (webBuild), its config (webRunConfig) from the chosen start wave, the simulation on the
 * v3 game data, and on its last tick the settlement (settleWebRun). It also notes whether the
 * blow that ended a death was a shooter's bullet or a contact, which RunResult.killedBy does not
 * say and the result screen's cause line does (Q11). DOM-free, so the tests reach it.
 */

import { deriveSeed } from '../../core/rng';
import type { GameData } from '../../data/types';
import type { AssembledWeb } from '../../data/web';
import { settleWebRun, webBuild, webRunConfig, webStartWave } from '../../meta/web';
import type { CharacterProgress, WebRun } from '../../meta/web';
import type { Settlement } from '../../meta';
import { createSimulation, NO_INPUT } from '../../sim';
import type { RunConfig, RunResult, SimEvent, Simulation } from '../../sim';
import { typicalHitOf } from '../typicalHit';

/** How the last life-ending hit landed; null before one, or after an extra life revived. */
export type FatalBlow = 'contact' | 'bullet' | null;

export interface FinishedRun {
  readonly result: RunResult;
  readonly settlement: Settlement;
  /** The character's progress with the run settled. */
  readonly progress: CharacterProgress;
  /** The run ended in a death whose last blow was a shooter's bullet. */
  readonly killedByBullet: boolean;
}

/**
 * The run's seed: one per character and run count, so a profile replays the same runs on the
 * same build (CLAUDE.md: same build + same seed).
 */
export function runSeed(progress: CharacterProgress): number {
  return deriveSeed(1000 + progress.runs, `run.${progress.character}`);
}

/** The highest start wave `progress` may pick on `web`: webStartWave, under the scope's cap. */
export function maxStartWave(web: AssembledWeb, progress: CharacterProgress): number {
  const allowed = webStartWave(progress);
  const cap = web.scope.waveCap;
  return cap === null ? allowed : Math.max(1, Math.min(allowed, cap));
}

/**
 * The start wave of the next run: the slot's pick clamped to 1…maxStartWave, or the highest
 * allowed when the slot holds none (null follows the highest allowed wave upward, as M1's).
 */
export function startWaveOf(
  web: AssembledWeb,
  progress: CharacterProgress,
  picked: number | null,
): number {
  const max = maxStartWave(web, progress);
  return picked === null ? max : Math.max(1, Math.min(max, Math.round(picked)));
}

/** What the slot stores for a pick of `wave`: null at the highest allowed wave, else the wave. */
export function storedPick(
  web: AssembledWeb,
  progress: CharacterProgress,
  wave: number,
): number | null {
  const max = maxStartWave(web, progress);
  const clamped = Math.max(1, Math.min(max, Math.round(wave)));
  return clamped >= max ? null : clamped;
}

export class CharacterRunState {
  readonly build: WebRun;
  readonly config: RunConfig;
  readonly sim: Simulation;
  readonly typicalHit: number;
  /** 1-based: the character's runs before this one, plus one. */
  readonly number: number;
  private fatal: FatalBlow = null;

  constructor(
    readonly web: AssembledWeb,
    private readonly start: CharacterProgress,
    startWave: number,
    private readonly data: GameData,
  ) {
    this.build = webBuild(web, start);
    const cap = web.scope.waveCap ?? undefined;
    this.config = webRunConfig(
      this.build,
      runSeed(start),
      startWave,
      cap === undefined ? undefined : Math.max(cap, startWave),
    );
    this.sim = createSimulation(this.config, data);
    this.typicalHit = typicalHitOf(this.config);
    this.number = start.runs + 1;
  }

  get finished(): boolean {
    return this.sim.state.finished;
  }

  /** The last life-ending hit so far (FatalBlow). */
  get fatalBlow(): FatalBlow {
    return this.fatal;
  }

  /** One tick; the returned array is the simulation's, reused by the next call. */
  step(): readonly SimEvent[] {
    const events = this.sim.step(NO_INPUT);
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as SimEvent;
      if (event.type === 'playerHit' && event.lifeLeft <= 0) this.fatal = 'contact';
      else if (event.type === 'bulletHit' && event.lifeLeft <= 0) this.fatal = 'bullet';
      else if (event.type === 'revive') this.fatal = null;
    }
    return events;
  }

  /** The finished run settled on the progress it started from; throws before the run ends. */
  finish(): FinishedRun {
    if (!this.finished) throw new Error('CharacterRunState.finish: the run has not ended');
    const result = this.sim.result();
    const settled = settleWebRun(this.start, result, this.data, this.build.stats);
    return {
      result,
      settlement: settled.settlement,
      progress: settled.progress,
      killedByBullet: result.endReason === 'death' && this.fatal === 'bullet',
    };
  }
}
