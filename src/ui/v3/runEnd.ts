/**
 * The v3 result screen's "why the run ended" lines (docs/v3/game-design-v3.md A.4; the answered
 * question Q11 (A)): M1's wording (src/ui/runEnd.ts) where it fits, with lines of its own where
 * a v3 run differs. A death whose last blow was a shooter's bullet says so instead of the
 * contact sentence (「被{敵人}撞死」); the bullets that hit get a line beside the leaks, which
 * leave them out; and the tip, picked by mainThreat with bullets counted, has a shooter line,
 * and lines that name no M1 talent. 稜鏡's reflected hits (RunResult.reflectTakenBy) are told
 * as the bullets are: a death line of their own, a line beside the leaks, counted in the main
 * threat with a tip that points at damage over time (M1's name 「活力」, which the v3 web does not have). DOM-free,
 * so the tests reach it.
 */

import { formatNum } from '../../core/format';
import { num } from '../../core/num';
import type { EnemyDef, EnemyId } from '../../data/types';
import { t } from '../../i18n';
import {
  describeRunEnd,
  enemyName,
  enemyPlural,
  FAST_SPEED,
  HEAVY_HIT_SHARE,
  mainThreat,
} from '../runEnd';
import type { RunEndFacts, RunEndText } from '../runEnd';
import type { ContactTally } from '../../sim/types';

export interface V3RunEndFacts extends RunEndFacts {
  readonly bulletTakenBy: Readonly<Record<EnemyId, ContactTally>>;
  /** The death's last blow was a shooter's bullet (CharacterRunState.fatalBlow). */
  readonly killedByBullet: boolean;
  /** RunResult.reflectTakenBy: 稜鏡's reflected hits by type; none when left out. */
  readonly reflectTakenBy?: Readonly<Record<EnemyId, ContactTally>>;
  /** The death's last blow was a reflected hit (CharacterRunState.fatalBlow). */
  readonly killedByReflect?: boolean;
}

export interface V3RunEndText extends RunEndText {
  /** The bullets that hit the player, or null when none did. */
  readonly bullets: string | null;
  /** The hits reflected onto the player, or null when none were. */
  readonly reflected: string | null;
}

/** The run's enemy defs: the tip reads their speed and a shooter's period between shots. */
export type V3Enemies = Readonly<Record<EnemyId, EnemyDef>>;

const FORMAT = { format: 'short' } as const;
const fmt = (value: number): string => formatNum(num(value), FORMAT);
const decimal = (x: number): string => String(Number(x.toFixed(2)));

export function describeV3RunEnd(facts: V3RunEndFacts, enemies: V3Enemies): V3RunEndText {
  const m1 = describeRunEnd(facts, enemies);
  return {
    cause: causeText(facts) ?? m1.cause,
    leaks: m1.leaks,
    bullets: bulletsText(facts),
    reflected: reflectedText(facts),
    lowerStart: m1.lowerStart,
    tip: facts.endReason === 'death' ? tipText(facts, enemies) : null,
  };
}

/**
 * A bullet death's or a reflection death's own line, and a capped run's: the only cap a v3 scope
 * has is the Demo's (gd §10), where M1's 「這是原型的最後一波」 would be wrong; null leaves M1's.
 */
function causeText(facts: V3RunEndFacts): string | null {
  if (facts.endReason === 'waveCap') {
    return t('v3.result.cause.waveCap', { wave: facts.highestWave });
  }
  if (facts.endReason !== 'death' || facts.killedBy === null) return null;
  if (facts.killedByReflect === true) {
    return t('v3.result.cause.reflect', { enemy: enemyName(facts.killedBy) });
  }
  if (!facts.killedByBullet) return null;
  return t('v3.result.cause.bullet', { enemy: enemyName(facts.killedBy) });
}

function reflectedText(facts: V3RunEndFacts): string | null {
  let hits = 0;
  let damage = 0;
  for (const tally of Object.values(facts.reflectTakenBy ?? {})) {
    hits += tally.hits;
    damage += tally.damage;
  }
  if (hits === 0) return null;
  if (hits === 1) return t('v3.result.reflected.one', { damage: fmt(damage) });
  return t('v3.result.reflected.many', { count: hits, damage: fmt(damage) });
}

/** The bullets' and the reflections' damage by type, the ranged share of mainThreat. */
function rangedOf(facts: V3RunEndFacts): Readonly<Record<EnemyId, ContactTally>> {
  const reflect = facts.reflectTakenBy;
  if (reflect === undefined) return facts.bulletTakenBy;
  const sum = {} as Record<EnemyId, ContactTally>;
  for (const id of Object.keys(facts.bulletTakenBy) as EnemyId[]) {
    const bullet = facts.bulletTakenBy[id];
    const mirrored = reflect[id];
    sum[id] = { hits: bullet.hits + mirrored.hits, damage: bullet.damage + mirrored.damage };
  }
  return sum;
}

function bulletsText(facts: V3RunEndFacts): string | null {
  let hits = 0;
  let damage = 0;
  for (const tally of Object.values(facts.bulletTakenBy)) {
    hits += tally.hits;
    damage += tally.damage;
  }
  if (hits === 0) return null;
  if (hits === 1) return t('v3.result.bullets.one', { damage: fmt(damage) });
  return t('v3.result.bullets.many', { count: hits, damage: fmt(damage) });
}

/**
 * By the main threat, bullets and reflections counted: 稜鏡 by its reflections, a shooter by its
 * bullets, else hits hard, fast, or many.
 */
function tipText(facts: V3RunEndFacts, enemies: V3Enemies): string | null {
  const main = mainThreat(facts.damageTakenBy, rangedOf(facts)) ?? facts.killedBy;
  if (main === null) return null;
  const contact = facts.damageTakenBy[main];
  const bullet = facts.bulletTakenBy[main];
  const mirrored = facts.reflectTakenBy?.[main].damage ?? 0;
  if (mirrored > contact.damage && mirrored > bullet.damage) {
    return t('v3.result.tip.reflect', { enemies: enemyPlural(main) });
  }
  if (bullet.damage > contact.damage) {
    const behaviour = enemies[main].behaviour;
    return behaviour?.kind !== 'shoot'
      ? t('v3.result.tip.bullets', { enemies: enemyPlural(main) })
      : t('v3.result.tip.shooter', {
          enemies: enemyPlural(main),
          sec: decimal(behaviour.periodSec),
        });
  }
  const perHit = contact.hits > 0 ? contact.damage / contact.hits : 0;
  if (perHit >= facts.maxLife * HEAVY_HIT_SHARE) {
    return t('v3.result.tip.heavy', {
      enemy: enemyName(main),
      damage: fmt(perHit),
      life: fmt(facts.maxLife),
    });
  }
  const key = enemies[main].speed >= FAST_SPEED ? 'v3.result.tip.fast' : 'v3.result.tip.swarm';
  return t(key, { enemies: enemyPlural(main) });
}
