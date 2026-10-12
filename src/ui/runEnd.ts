/**
 * Wording of the result screen's "why the run ended" section: the cause, which enemies got
 * through, and on death one tip naming the two levers (kill faster, or survive longer),
 * picked from the run's contact damage. DOM-free so tests can run it.
 */

import { formatNum } from '../core/format';
import { num } from '../core/num';
import { ENEMY_IDS } from '../data/types';
import type { EnemyDef, EnemyId } from '../data/types';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import type { ContactTally, EndReason } from '../sim/types';
import { formatClock } from './strings';

/** Enemies at least this fast (arena units/s) cross half the arena in under 7 s. */
export const FAST_SPEED = 140;

/** A single contact of at least this share of max life gets the "hits hard" tip. */
export const HEAVY_HIT_SHARE = 0.25;

export interface RunEndFacts {
  readonly endReason: EndReason;
  readonly highestWave: number;
  /** Run time limit in seconds. */
  readonly limitSec: number;
  readonly maxLife: number;
  /** Glass Cannon fixes life at 1, so Life nodes cannot help. */
  readonly glassCannon: boolean;
  readonly leaks: number;
  readonly damageTaken: number;
  readonly damageTakenBy: Readonly<Record<EnemyId, ContactTally>>;
  readonly killedBy: EnemyId | null;
}

export type EnemySpeeds = Readonly<Record<EnemyId, Pick<EnemyDef, 'speed'>>>;

export interface RunEndText {
  /** Who killed the player, or why the run stopped; null for a death without a known killer. */
  readonly cause: string | null;
  /** How many enemies got through, for how much damage. */
  readonly leaks: string;
  /** Death only: what to change before the next run. */
  readonly tip: string | null;
}

const FORMAT = { format: 'short' } as const;
const fmt = (value: number): string => formatNum(num(value), FORMAT);

const NAMES: Readonly<Record<EnemyId, { readonly one: MessageKey; readonly many: MessageKey }>> = {
  triangle: { one: 'enemy.triangle.name', many: 'enemy.triangle.plural' },
  square: { one: 'enemy.square.name', many: 'enemy.square.plural' },
  pentagon: { one: 'enemy.pentagon.name', many: 'enemy.pentagon.plural' },
  shard: { one: 'enemy.shard.name', many: 'enemy.shard.plural' },
  hexagon: { one: 'enemy.hexagon.name', many: 'enemy.hexagon.plural' },
  boss: { one: 'enemy.boss.name', many: 'enemy.boss.plural' },
};

export const enemyName = (id: EnemyId): string => t(NAMES[id].one);
export const enemyPlural = (id: EnemyId): string => t(NAMES[id].many);

/** The type that dealt the most contact damage, the first in ENEMY_IDS on ties; null if none. */
export function mainThreat(by: Readonly<Record<EnemyId, ContactTally>>): EnemyId | null {
  let best: EnemyId | null = null;
  let bestDamage = 0;
  for (const id of ENEMY_IDS) {
    if (by[id].damage > bestDamage) {
      best = id;
      bestDamage = by[id].damage;
    }
  }
  return best;
}

export function describeRunEnd(facts: RunEndFacts, enemies: EnemySpeeds): RunEndText {
  return {
    cause: causeText(facts),
    leaks: leaksText(facts),
    tip: facts.endReason === 'death' ? tipText(facts, enemies) : null,
  };
}

function causeText(facts: RunEndFacts): string | null {
  switch (facts.endReason) {
    case 'death':
      return facts.killedBy === null
        ? null
        : t('result.cause.death', { enemy: enemyName(facts.killedBy) });
    case 'timeout':
      return t('result.cause.timeout', { limit: formatClock(facts.limitSec) });
    case 'waveCap':
      return t('result.cause.waveCap', { wave: facts.highestWave });
  }
}

function leaksText(facts: RunEndFacts): string {
  const { leaks: count, damageTakenBy: by } = facts;
  const damage = fmt(facts.damageTaken);
  if (count === 0) return t('result.leaks.none');
  if (count === 1) return t('result.leaks.one', { damage });
  const main = mainThreat(by);
  const types = ENEMY_IDS.filter((id) => by[id].hits > 0).length;
  if (main === null || types < 2) return t('result.leaks.many', { count, damage });
  return t('result.leaks.mixed', {
    count,
    damage,
    mainDamage: fmt(by[main].damage),
    enemies: enemyPlural(main),
  });
}

/** Glass Cannon first (Life cannot help), then by the main threat: hits hard, fast, or many. */
function tipText(facts: RunEndFacts, enemies: EnemySpeeds): string | null {
  if (facts.glassCannon) {
    return t('result.tip.glassCannon', { glassCannon: t('talent.glassCannon.name') });
  }
  const main = mainThreat(facts.damageTakenBy) ?? facts.killedBy;
  if (main === null) return null;
  const vitality = t('talent.vitality.name');
  const tally = facts.damageTakenBy[main];
  const perHit = tally.hits > 0 ? tally.damage / tally.hits : 0;
  if (perHit >= facts.maxLife * HEAVY_HIT_SHARE) {
    return t('result.tip.heavy', {
      enemy: enemyName(main),
      damage: fmt(perHit),
      life: fmt(facts.maxLife),
      vitality,
    });
  }
  const key = enemies[main].speed >= FAST_SPEED ? 'result.tip.fast' : 'result.tip.swarm';
  return t(key, { enemies: enemyPlural(main), vitality });
}
