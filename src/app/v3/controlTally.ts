/**
 * 控場 on the result screen (Hoshi's playtest, 2026-11-04: 冰外盤 deals little damage of its own,
 * so its freezes and shatters are counted where the player can see them). One run's counts, read
 * from the sim's events as the page steps it.
 */

import { holdsFrost } from '../../sim/ailments/frost';
import type { Enemy } from '../../sim/systems/context';
import type { SimEvent, SimState } from '../../sim/types';

export interface ControlCounts {
  /** Enemies frozen (a boss whose meter emptied without a freeze is not counted). */
  readonly freezes: number;
  /** Frozen enemies that died and shattered. */
  readonly shatters: number;
  /** The share of live enemy time spent chilled, frozen or in a slowing zone, 0 to 1. */
  readonly slowedShare: number;
}

export class ControlTally {
  private freezes = 0;
  private shatters = 0;
  private enemyTicks = 0;
  private slowedTicks = 0;

  reset(): void {
    this.freezes = 0;
    this.shatters = 0;
    this.enemyTicks = 0;
    this.slowedTicks = 0;
  }

  /** Counts, at the state's tick, the live enemies and those chilled, frozen or zone-slowed. */
  observe(state: Readonly<SimState>): void {
    const now = state.tick;
    const enemies = state.enemies;
    for (let i = 0; i < enemies.length; i++) {
      // SimState.enemies are the run's Enemy records (src/sim/systems/context.ts).
      const enemy = enemies[i] as Enemy;
      if (!enemy.alive) continue;
      this.enemyTicks++;
      if (holdsFrost(enemy, now) || (enemy.zoneSlow > 0 && enemy.zoneSlowUntil > now)) {
        this.slowedTicks++;
      }
    }
  }

  handleEvents(events: readonly SimEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as SimEvent;
      if (event.type === 'freeze') {
        if (!event.boss) this.freezes++;
      } else if (event.type === 'shatter') this.shatters++;
    }
  }

  get counts(): ControlCounts {
    return {
      freezes: this.freezes,
      shatters: this.shatters,
      slowedShare: this.enemyTicks > 0 ? this.slowedTicks / this.enemyTicks : 0,
    };
  }
}
