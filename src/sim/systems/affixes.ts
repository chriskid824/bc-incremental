/**
 * The elite affixes (docs/v3 C7 design §2.7, gd:703-714): an elite draws distinct affixes at
 * spawn (pickAffixes, src/sim/systems/enemyRecord.ts) and its record carries them as AFFIX_* bits
 * (src/data/affixes.ts). Six rules need nothing beyond the record, which addEnemy sets up: 迅捷
 * (a faster walk step), 堅甲 (ARMOURED, src/sim/combat/defend.ts), 再生 (C7.4a's regeneration),
 * 守護 and 冰霜 (the two lists of ctx.sys.affixes) and 元素護盾 (WARDED and the wardLeft counter).
 * The other three run here:
 * - `guarded`: whether some live guardian is within GUARD_RADIUS of an enemy being hit, which
 *   makes it count as shielded with the shielder's threshold for that hit alone (`defend`);
 * - `multiply`: 增殖's children, at a kill, right after the split children
 *   (src/sim/systems/death.ts);
 * - `stepAffixes` and `refreshCadence`: 冰霜's factor on every emitter's cadence, taken once at
 *   the start of the enemy AI step (src/sim/systems/enemyAi.ts), where the two lists are also
 *   compacted. 狂暴 runs in that step's own loop, with the constants below.
 *
 * §1.8 gives this module as the home of C7.6's constants. The ones the record, the spawn path
 * and the ailment entries need are declared in enemyRecord.ts and re-exported here (deviation
 * D1): `multiply` calls spawnOrSkip, so spawn.ts, enemyRecord.ts and the ailment modules cannot
 * import this module without closing an import cycle, one of them inside systemState.ts's leaf
 * closure (ARCH §4.7.15).
 */

import { AFFIX_MULTIPLY } from '../../data/affixes';
import type { Enemy, RunContext } from './context';
import type { EnemyV3, SpawnOrigin } from './enemyRecord';
import { spawnOrSkip } from './spawn';

export {
  affixCount,
  pickAffixes,
  SWIFT_MULT,
  WARD_AILMENT_MULT,
  WARD_BREAK_PCT,
  WARDED,
} from './enemyRecord';

const TAU = Math.PI * 2;

/** 守護 (gd:710): how far its shield reaches, BASE_STATS.auraRadius, the game's 「周圍」. */
export const GUARD_RADIUS = 160;
const GUARD_RADIUS_SQ = GUARD_RADIUS * GUARD_RADIUS;

/** 增殖 (gd:711): 「2 個小菁英」. */
export const MULTIPLY_COUNT = 2;
/** A 增殖 child's share of its parent's max life: the two together hold half of it. */
export const MULTIPLY_HP = 0.25;
/** A 增殖 child's share of its parent's drops: the two together pay half of them. */
export const MULTIPLY_DROP = 0.25;
/** A 增殖 child's share of its parent's radius: about half the area, visibly 「小」. */
export const MULTIPLY_RADIUS = 0.7;

/** 狂暴 (gd:712): the share of its max life it rages below. */
export const BERSERK_BELOW = 0.5;
/** 狂暴 (gd:712): × on its walk step and its contact damage while it rages. */
export const BERSERK_MULT = 2;

/** 冰霜 (gd:714): how close to the player it has to be to slow every attack. */
export const FROST_RANGE = 300;
/** 冰霜 (gd:714): the cadence every emitter keeps while one is in range (「頻率 −25%」). */
export const FROST_CADENCE = 0.75;

/**
 * Whether 守護 covers `enemy` for a hit: some live guardian other than it is within GUARD_RADIUS
 * of it, inclusive, compared as squared distances. The scan skips dead guardians itself, since a
 * guardian killed earlier in the same tick is only taken off the list at the next step.
 */
export function guarded(ctx: RunContext, enemy: Enemy): boolean {
  const guardians = ctx.sys.affixes.guardians;
  const x = enemy.x;
  const y = enemy.y;
  for (let i = 0; i < guardians.length; i++) {
    const guardian = guardians[i] as Enemy;
    if (guardian === enemy || !guardian.alive) continue;
    const dx = guardian.x - x;
    const dy = guardian.y - y;
    if (dx * dx + dy * dy <= GUARD_RADIUS_SQ) return true;
  }
  return false;
}

/**
 * 增殖's children at `parent`'s death (killEnemy, right after its split children, so a
 * toSplitChildren transfer reaches them too): MULTIPLY_COUNT of the parent's own type at
 * MULTIPLY_HP of its life, MULTIPLY_RADIUS of its radius and MULTIPLY_DROP of its drops, outside
 * composeWave's count and in its wave record. They inherit its other affixes with their own
 * at-spawn effects, never 增殖 itself, so they cannot multiply again. Each draws its angle on the
 * split stream and is placed on the parent's rim, as `split` places a split child, and goes
 * through spawnOrSkip, so a child past the enemy cap is skipped and counted (lead ruling L4).
 */
export function multiply(ctx: RunContext, parent: Enemy): void {
  const origin: SpawnOrigin = {
    hpScale: MULTIPLY_HP,
    radiusScale: MULTIPLY_RADIUS,
    dropScale: MULTIPLY_DROP,
    extra: true,
    affixes: (parent.v3 as EnemyV3).affixes & ~AFFIX_MULTIPLY,
  };
  const def = parent.def;
  const rec = parent.rec;
  const player = ctx.player;
  for (let i = 0; i < MULTIPLY_COUNT; i++) {
    const angle = ctx.splitRng.range(0, TAU);
    const dx = parent.x + Math.cos(angle) * parent.radius - player.x;
    const dy = parent.y + Math.sin(angle) * parent.radius - player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0) spawnOrSkip(ctx, def, rec, dx / dist, dy / dist, dist, origin);
    else spawnOrSkip(ctx, def, rec, 1, 0, 0, origin);
  }
}

/**
 * Writes 冰霜's factor (AffixState.frostFactor) on every emitter of the run, which every emitter
 * that counts attacks by its cadence then runs at: the signature attacks (volley, lob, fan, arc)
 * and the drones and turrets, whose dash and return speeds, dock time and impact cooldown all
 * scale with it (src/sim/systems/drones.ts). An aura's pulse phase, a strike's timer and an
 * orbit's cooldown are fixed periods that never read cadence, so they keep their own rate (lead
 * ruling L5). Every emitter of a run exists from createRunContext, and nothing else writes
 * cadence, so one pass covers the run.
 */
export function refreshCadence(ctx: RunContext): void {
  const cadence = ctx.sys.affixes.frostFactor;
  for (const em of ctx.emitters) em.cadence = cadence;
}

/**
 * The affix work of the enemy AI step's start, before its list walk: the guardians and the frost
 * elites leave their lists once they are dead (in place, order kept, as the AI list is
 * compacted), and 冰霜's factor is taken from the frost elites that are left. Any number of them
 * within FROST_RANGE of the player gives the one factor FROST_CADENCE (no stacking); none gives
 * exactly 1. The emitters are rewritten only when the factor changes.
 */
export function stepAffixes(ctx: RunContext): void {
  const affixes = ctx.sys.affixes;
  const guardians = affixes.guardians;
  let kept = 0;
  for (let i = 0; i < guardians.length; i++) {
    const guardian = guardians[i] as Enemy;
    if (guardian.alive) guardians[kept++] = guardian;
  }
  guardians.length = kept;
  const frostElites = affixes.frostElites;
  kept = 0;
  let near = false;
  for (let i = 0; i < frostElites.length; i++) {
    const elite = frostElites[i] as Enemy;
    if (!elite.alive) continue;
    frostElites[kept++] = elite;
    if (elite.dist <= FROST_RANGE) near = true;
  }
  frostElites.length = kept;
  const factor = near ? FROST_CADENCE : 1;
  if (factor !== affixes.frostFactor) {
    affixes.frostFactor = factor;
    refreshCadence(ctx);
  }
}
