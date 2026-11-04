/**
 * Turns a tick's sim events into cues (./cues.ts), as the renderer turns them into effects: the
 * page calls handleEvents with each step's events, beside Renderer.handleEvents, so the renderer
 * stays visual-only. A tick plays each cue at most once, its loudest instance: the events of one
 * tick are summed first (the biggest explosion, the kill count, any crit), then the engine's
 * cooldowns and voice caps thin what is left.
 */

import type { EnemyId } from '../data/types';
import type { SimEvent } from '../sim/types';
import type { CueId } from './cues';
import type { PlayOptions } from './engine';

/** Something that plays cues: the AudioEngine, or a test's recorder. */
export interface CuePlayer {
  play(cue: CueId, options?: PlayOptions): boolean;
}

/** An explosion of this radius plays at gain 1 and pitch 1; bigger ones are louder and lower. */
export const EXPLOSION_RADIUS_REF = 80;
/** A kill streak raises the kill pop's pitch by this much per streak step, up to MAX_STREAK. */
const STREAK_PITCH_STEP = 0.035;
const MAX_STREAK = 12;
/** Ticks without a kill that end a streak. */
const STREAK_GAP_TICKS = 18;

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/** 0 a normal enemy, 1 an elite, 2 a boss (src/render/killTier.ts). */
export type KillTierOf = (enemy: EnemyId) => number;

export class SimAudio {
  private streak = 0;
  private ticksSinceKill = STREAK_GAP_TICKS;

  constructor(
    private readonly player: CuePlayer,
    private readonly tierOf: KillTierOf = () => 0,
  ) {}

  /** Forgets the kill streak; call as a run begins. */
  reset(): void {
    this.streak = 0;
    this.ticksSinceKill = STREAK_GAP_TICKS;
  }

  /** Plays one tick's cues. Call after every sim step. */
  handleEvents(events: readonly SimEvent[]): void {
    let hit = false;
    let crit = false;
    let lob = false;
    let blastRadius = 0;
    let blasts = 0;
    let kills = 0;
    let bigKill = false;
    let ignite = false;
    let freeze = false;
    let shatter = 0;
    let playerHit = false;
    let waveCleared = false;
    let runEnded: Extract<SimEvent, { type: 'runEnded' }>['reason'] | null = null;
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as SimEvent;
      switch (event.type) {
        case 'hit':
          if (event.crit) crit = true;
          else if (event.chainIndex === 0) hit = true;
          break;
        case 'lob':
          lob = true;
          break;
        case 'explosion':
          blasts++;
          blastRadius = Math.max(blastRadius, event.radius);
          break;
        case 'burst':
          // 連環爆's and triggers' small blasts; novas have their own rings and stay quiet.
          if (event.kind === 'explode') {
            blasts++;
            blastRadius = Math.max(blastRadius, event.radius * 0.7);
          }
          break;
        case 'enemyKilled':
          kills++;
          if (this.tierOf(event.enemy) > 0) bigKill = true;
          break;
        case 'ignite':
          if (event.stacks === 1) ignite = true;
          break;
        case 'freeze':
          freeze = true;
          break;
        case 'shatter':
          shatter = Math.max(shatter, event.radius);
          break;
        case 'playerHit':
        case 'bulletHit':
          if (event.damage > 0) playerHit = true;
          break;
        case 'waveCleared':
          waveCleared = true;
          break;
        case 'runEnded':
          runEnded = event.reason;
          break;
        default:
          break;
      }
    }

    if (kills > 0) {
      this.streak = this.ticksSinceKill < STREAK_GAP_TICKS ? this.streak + 1 : 0;
      this.ticksSinceKill = 0;
    } else if (this.ticksSinceKill < STREAK_GAP_TICKS) {
      this.ticksSinceKill++;
    }

    if (runEnded !== null) {
      this.player.play('runEnd', { pitch: runEnded === 'death' ? 0.85 : 1 });
    }
    if (playerHit) this.player.play('playerHit');
    if (blasts > 0) this.player.play('explosion', explosionOptions(blastRadius, blasts));
    if (bigKill) this.player.play('killBig');
    if (kills > 0) {
      this.player.play('kill', {
        gain: clamp(0.8 + 0.1 * Math.log2(kills), 0.8, 1.3),
        pitch: 1 + STREAK_PITCH_STEP * Math.min(this.streak, MAX_STREAK),
      });
    }
    if (crit) this.player.play('crit');
    else if (hit) this.player.play('hit');
    if (shatter > 0) this.player.play('shatter');
    else if (freeze) this.player.play('freeze');
    if (ignite) this.player.play('ignite');
    if (lob) this.player.play('lob');
    if (waveCleared) this.player.play('waveCleared');
  }
}

/** A tick's explosion cue: louder and lower for a bigger blast, a little louder for several. */
export function explosionOptions(radius: number, count: number): PlayOptions {
  const size = clamp(radius / EXPLOSION_RADIUS_REF, 0.3, 4);
  return {
    gain: clamp(0.55 + 0.35 * Math.sqrt(size) + 0.08 * Math.log2(Math.max(1, count)), 0.4, 1.4),
    pitch: clamp(1 / Math.pow(size, 0.3), 0.6, 1.4),
  };
}
