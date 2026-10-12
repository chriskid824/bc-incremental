/**
 * Merges burn ticks into fewer damage numbers (docs/GDD.md §3.3: burn numbers are small and
 * dense). Ticks on the same enemy add up for a short window of wall-clock time, then show as
 * one number where the enemy last burned; a dying enemy shows its tally at once. Entries are
 * pooled, so a screen full of burning enemies allocates nothing per tick.
 */

import { add, ZERO } from '../core/num';
import type { Num } from '../core/num';

/** How long ticks on one enemy are summed before the total is shown. */
export const BURN_TALLY_MS = 380;

interface Entry {
  amount: Num;
  x: number;
  y: number;
  ageMs: number;
}

export type BurnEmit = (amount: Num, x: number, y: number) => void;

export class BurnTally {
  private readonly entries = new Map<number, Entry>();
  private readonly pool: Entry[] = [];
  /** update() state for the bound visitor, so the per-frame sweep allocates nothing. */
  private stepMs = 0;
  private emitTo: BurnEmit | null = null;
  private readonly visit = (entry: Entry, id: number): void => {
    entry.ageMs += this.stepMs;
    if (entry.ageMs < this.windowMs) return;
    this.entries.delete(id);
    this.emitTo?.(entry.amount, entry.x, entry.y);
    this.pool.push(entry);
  };

  constructor(private readonly windowMs = BURN_TALLY_MS) {}

  /** Enemies with an open tally. */
  get size(): number {
    return this.entries.size;
  }

  /** Adds a burn tick on `targetId` at (x, y). */
  add(targetId: number, amount: Num, x: number, y: number): void {
    let entry = this.entries.get(targetId);
    if (entry === undefined) {
      entry = this.pool.pop() ?? { amount: ZERO, x: 0, y: 0, ageMs: 0 };
      entry.amount = ZERO;
      entry.ageMs = 0;
      this.entries.set(targetId, entry);
    }
    entry.amount = add(entry.amount, amount);
    entry.x = x;
    entry.y = y;
  }

  /** Shows the tally of `targetId` now, if it has one (the enemy died). */
  flush(targetId: number, emit: BurnEmit): void {
    const entry = this.entries.get(targetId);
    if (entry === undefined) return;
    this.entries.delete(targetId);
    emit(entry.amount, entry.x, entry.y);
    this.pool.push(entry);
  }

  /** Ages the tallies and shows those whose window has passed. */
  update(dtMs: number, emit: BurnEmit): void {
    this.stepMs = dtMs;
    this.emitTo = emit;
    this.entries.forEach(this.visit);
    this.emitTo = null;
  }

  clear(): void {
    for (const entry of this.entries.values()) this.pool.push(entry);
    this.entries.clear();
  }
}
