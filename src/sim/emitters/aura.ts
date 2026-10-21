/**
 * Auras (docs/v3 C4 design D21, §4.13): the aura grants (光環). An aura emitter pulses every
 * PHASE_TICKS ticks, four times a second whatever the attack speed, on the ticks whose remainder
 * is its phase, (3 + 4 × its emitter index) % PHASE_TICKS, and counts its pulses in em.attacks.
 * A pulse hits every alive enemy within the auraRadius stat of the player, in id order, with the
 * emitter's payload. Its hits crit and roll and apply their ailments as a zone pulse's do
 * (hitPulse, src/sim/systems/zones.ts; Hoshi's Q4 (B)), on the combat stream, with depth 0 and
 * no origin, and raise no hit events: they add to the pulse's tally (PulseAcc), and a pulse that
 * hit anything raises one pulse event of kind 'aura'.
 *
 * Under everyNth (聚能脈衝) only every n-th pulse acts, at × mult: the pulses between only count,
 * so they query, hit, draw and raise nothing, and n pulses deal what n plain ones would, in one
 * hit per enemy with one set of rolls (F6, Q4/F5). With a corona (日冕) the emitter's timer counts
 * the ticks to its period, and then every alive enemy of the run takes one hit of its corona
 * payload (EmitterRuntime.alt), corona.damagePct × a pulse's, rolled as a pulse's and tallied
 * into a pulse event of its own; a corona counts no pulse (F7). A tick's pulse comes before its
 * corona. Nothing a pulse reaches adds an aura emitter or an enemy to the pulse's list.
 */

import { ZERO } from '../../core/num';
import { sizeOf } from '../build/size';
import type { Enemy, RunContext } from '../systems/context';
import type { PulseAcc } from '../systems/systemState';
import { hitPulse, hoistPulseRows } from '../systems/zones';
import { PHASE_TICKS, periodTicks } from './types';
import type { AuraSpec, EmitterRuntime, Payload } from './types';

/** Pulses aura emitter `em` on its phase, then fires its corona when its timer reaches its period. */
export function runAura(ctx: RunContext, em: EmitterRuntime): void {
  const spec = em.spec as AuraSpec;
  if (ctx.now % PHASE_TICKS === (3 + 4 * em.index) % PHASE_TICKS) {
    const pulseNo = ++em.attacks;
    const nth = spec.everyNth;
    // 聚能脈衝 merges n pulses into their n-th (F6).
    if (nth === null) pulse(ctx, em, 1);
    else if (pulseNo % nth.n === 0) pulse(ctx, em, nth.mult);
  }
  const corona = spec.corona;
  if (corona === null) return;
  const period = periodTicks(1 / corona.periodSec);
  em.timer += 1;
  if (em.timer < period) return;
  em.timer -= period;
  coronaPulse(ctx, em);
}

/** One pulse of aura emitter `em` at `scale`: a hit on every alive enemy within its radius. */
function pulse(ctx: RunContext, em: EmitterRuntime, scale: number): void {
  const targets = em.targets as Enemy[];
  const r = sizeOf(ctx.build, ctx.build.values.auraRadius);
  const player = ctx.player;
  const n = ctx.grid.within(player.x, player.y, r * r, targets);
  if (n === 0) return;
  const acc = ctx.sys.pulse;
  const p = em.payload;
  begin(ctx, acc, p);
  for (let j = 0; j < n; j++) {
    const enemy = targets[j] as Enemy;
    if (enemy.alive) hitPulse(ctx, acc, enemy, p, scale, 0, -1);
  }
  raisePulse(ctx, acc, em.index);
}

/**
 * 日冕: a hit of aura emitter `em`'s corona payload on every alive enemy, in id order; enemies a
 * hit's kill appends after the count is taken are not hit.
 */
function coronaPulse(ctx: RunContext, em: EmitterRuntime): void {
  const enemies = ctx.enemies;
  const m = enemies.length;
  const acc = ctx.sys.pulse;
  const p = em.alt as Payload;
  begin(ctx, acc, p);
  for (let j = 0; j < m; j++) {
    const enemy = enemies[j] as Enemy;
    if (enemy.alive) hitPulse(ctx, acc, enemy, p, 1, 0, -1);
  }
  raisePulse(ctx, acc, em.index);
}

/** Resets the pulse tally `acc` and hoists the rows of pulse payload `p` into it. */
function begin(ctx: RunContext, acc: PulseAcc, p: Payload): void {
  acc.hits = 0;
  acc.total = ZERO;
  acc.critCount = 0;
  hoistPulseRows(ctx, acc, p);
}

/** The pulse event of the tally `acc` of aura emitter `index`, when its pulse hit anything. */
function raisePulse(ctx: RunContext, acc: PulseAcc, index: number): void {
  if (acc.hits === 0) return;
  ctx.events.push({
    type: 'pulse',
    kind: 'aura',
    id: index,
    hits: acc.hits,
    total: acc.total,
    crits: acc.crits.slice(0, acc.critCount),
  });
}
