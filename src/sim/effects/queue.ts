/**
 * The effect queue (docs/v3/implementation-plan-v3.md §2.6): effects of fired triggers wait here
 * for the tick's effect phase (execute.ts) and run first in, first out. A ring of typed arrays
 * that doubles when full, up to EFFECT_QUEUE_HARD_CAP entries, and never shrinks: enqueueing
 * allocates nothing once it has grown.
 */

import type { Num } from '../../core/num';
import { toNumber } from '../../core/num';
import type { Enemy, RunContext } from '../systems/context';
import { EFFECT_QUEUE_HARD_CAP } from './types';

/** Entries a new queue has room for. */
const INITIAL_CAPACITY = 256;

export interface EffectQueue {
  /** Slot of the oldest entry. */
  head: number;
  size: number;
  /** Capacity − 1; the capacity is a power of two. */
  capMask: number;
  /** Per slot: the effect (CompiledBuild.effects index) and what its entry carries. */
  effect: Int32Array;
  origin: Int32Array;
  depth: Uint8Array;
  source: Int32Array;
  flags: Int32Array;
  x: Float64Array;
  y: Float64Array;
  value: Float64Array;
  target: (Enemy | null)[];
}

/** One effect to run: what its queue entry, or an inline trigger at a kill, carries. */
export interface EffectEntry {
  /** Index in CompiledBuild.effects. */
  effect: number;
  /** Depth of the effect: one more than its event's. */
  depth: number;
  /** The trigger that fired it: the origin of the damage it deals. */
  origin: number;
  /** Source index its trigger was credited with for this event. */
  source: number;
  /** The event's flags (src/sim/effects/flags.ts). */
  flags: number;
  /** Where the event happened: its enemy's position, or the player's. */
  x: number;
  y: number;
  /** The event's value: a kill's drop for gainShards, a shatter's victim's max life, else 0. */
  value: number;
  /** The event's enemy; null for events without one and for kills. */
  target: Enemy | null;
}

export const createEffectEntry = (): EffectEntry => ({
  effect: 0,
  depth: 0,
  origin: -1,
  source: 0,
  flags: 0,
  x: 0,
  y: 0,
  value: 0,
  target: null,
});

export function createEffectQueue(capacity = INITIAL_CAPACITY): EffectQueue {
  return {
    head: 0,
    size: 0,
    capMask: capacity - 1,
    effect: new Int32Array(capacity),
    origin: new Int32Array(capacity),
    depth: new Uint8Array(capacity),
    source: new Int32Array(capacity),
    flags: new Int32Array(capacity),
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    value: new Float64Array(capacity),
    target: new Array<Enemy | null>(capacity).fill(null),
  };
}

/** Doubles the capacity, moving the entries to slots 0 .. size in queue order. */
function grow(q: EffectQueue): void {
  const capacity = (q.capMask + 1) * 2;
  const next = createEffectQueue(capacity);
  for (let n = 0; n < q.size; n++) {
    const from = (q.head + n) & q.capMask;
    next.effect[n] = q.effect[from] as number;
    next.origin[n] = q.origin[from] as number;
    next.depth[n] = q.depth[from] as number;
    next.source[n] = q.source[from] as number;
    next.flags[n] = q.flags[from] as number;
    next.x[n] = q.x[from] as number;
    next.y[n] = q.y[from] as number;
    next.value[n] = q.value[from] as number;
    next.target[n] = q.target[from] as Enemy | null;
  }
  q.head = 0;
  q.capMask = next.capMask;
  q.effect = next.effect;
  q.origin = next.origin;
  q.depth = next.depth;
  q.source = next.source;
  q.flags = next.flags;
  q.x = next.x;
  q.y = next.y;
  q.value = next.value;
  q.target = next.target;
}

/** Queues effect `effect` behind every queued entry, or drops it at the hard cap. */
export function enqueue(
  ctx: RunContext,
  effect: number,
  depth: number,
  origin: number,
  source: number,
  target: Enemy | null,
  x: number,
  y: number,
  value: Num,
  flags: number,
): void {
  const q = ctx.effectQueue;
  const counters = ctx.counters;
  if (q.size === EFFECT_QUEUE_HARD_CAP) {
    counters.effectsDropped++;
    return;
  }
  if (q.size === q.capMask + 1) grow(q);
  const at = (q.head + q.size) & q.capMask;
  q.effect[at] = effect;
  q.origin[at] = origin;
  q.depth[at] = depth;
  q.source[at] = source;
  q.flags[at] = flags;
  q.x[at] = x;
  q.y[at] = y;
  q.value[at] = toNumber(value);
  q.target[at] = target;
  q.size++;
  if (q.size > counters.effectQueuePeak) counters.effectQueuePeak = q.size;
}

/** Moves the oldest entry into `entry`; the queue must not be empty. */
export function dequeue(q: EffectQueue, entry: EffectEntry): void {
  const at = q.head;
  entry.effect = q.effect[at] as number;
  entry.origin = q.origin[at] as number;
  entry.depth = q.depth[at] as number;
  entry.source = q.source[at] as number;
  entry.flags = q.flags[at] as number;
  entry.x = q.x[at] as number;
  entry.y = q.y[at] as number;
  entry.value = q.value[at] as number;
  entry.target = q.target[at] as Enemy | null;
  q.target[at] = null;
  q.head = (at + 1) & q.capMask;
  q.size--;
}

/** Per trigger index (TriggerState in RunContext). */
export interface TriggerState {
  /** Events counted towards `every` (nthAttack). */
  readonly count: Int32Array;
  /** Tick from which it can fire again (cooldownSec). */
  readonly readyAt: Float64Array;
  /** periodic: tick of its next firing. */
  readonly nextPeriodic: Float64Array;
}

/**
 * A kill trigger to dispatch at the death step (dispatch.ts): the victim and what the kill
 * carried, captured at the kill. Reused objects (RunContext.pendingKills).
 */
export interface PendingKill {
  trigger: number;
  victim: Enemy;
  /** Depth of the killing damage (Enemy.killDepth). */
  depth: number;
  /** The trigger whose damage killed; −1 for emitter hits and kills by damage over time. */
  origin: number;
  /** The kill's flags: the killing hit's, the ailments held, the kill kind. */
  flags: number;
  /**
   * The victim's drop for a trigger with gainShards, its max life for SHATTER_TRIGGER; ZERO
   * otherwise.
   */
  value: Num;
  /**
   * Source to credit instead of the trigger's own (SHATTER_TRIGGER: the credit of the frost that
   * froze the victim); −1 for the trigger's.
   */
  source: number;
}
