/**
 * The result screen's 傷害分佈 (Hoshi's playtest, 2026-11-03): a run's damage by source (the
 * center, each outer, each fusion, the hub ring, the ascendancy) and by kind (hit, crit, burn,
 * chain, poison, bleed), each with its share of the total. Pure: it reads RunResult's
 * damageBySource and damage, and names through a TextLookup.
 */

import { add, toNumber, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import { sourceClass } from '../../data/sources';
import type { FusionKey } from '../../data/web/types';
import type { DamageBreakdown } from '../../sim/types';
import { APP_LOOKUP, fusionName, fusionTitle, say } from '../web/names';
import type { TextLookup } from '../web/text';

export interface DamageShare {
  /** The source id (`center`, `outer.poison`, `fusion.fire.ice`, …) or the kind (`burn`, …). */
  readonly id: string;
  readonly label: string;
  readonly amount: Num;
  /** amount ÷ the total, 0 to 1. */
  readonly share: number;
}

export interface DamageBreakdownView {
  readonly total: Num;
  readonly sources: readonly DamageShare[];
  readonly kinds: readonly DamageShare[];
}

const KINDS = ['hit', 'crit', 'burn', 'chain', 'poison', 'bleed'] as const;

/** Entries above 0, largest first, each with its share of their sum. */
function shares(
  entries: readonly (readonly [string, Num])[],
  label: (id: string) => string,
): { total: Num; rows: DamageShare[] } {
  let total = ZERO;
  for (const [, amount] of entries) total = add(total, amount);
  const sum = toNumber(total);
  const rows = entries
    .filter(([, amount]) => toNumber(amount) > 0)
    .map(([id, amount]) => ({
      id,
      label: label(id),
      amount,
      share: sum > 0 ? toNumber(amount) / sum : 0,
    }))
    .sort((a, b) => b.share - a.share || (a.id < b.id ? -1 : 1));
  return { total, rows };
}

/** A source's name: 「熔核本體」, 「毒外盤」, 「火冰「霜焰」」, 「樞紐環」, 「昇華」. */
export function sourceLabel(
  id: string,
  characterName: string,
  lookup: TextLookup = APP_LOOKUP,
): string {
  switch (sourceClass(id)) {
    case 'center':
      return say(lookup, 'v3.damage.center', { name: characterName });
    case 'hub':
      return say(lookup, 'web.scope.hub');
    case 'asc':
      return say(lookup, 'web.scope.asc');
    case 'outer': {
      const outer = id.slice('outer.'.length);
      const key = `web.outer.${outer}.name`;
      const name = lookup.has(key) ? lookup.get(key) : outer;
      return say(lookup, 'v3.damage.outer', { name });
    }
    case 'fusion': {
      const key = id.slice('fusion.'.length) as FusionKey;
      return say(lookup, 'web.coreName', {
        name: fusionName(key, lookup),
        title: fusionTitle(key, lookup),
      });
    }
    default:
      return id;
  }
}

/** The run's damage by source and by kind, largest first, zero rows left out. */
export function damageBreakdown(
  bySource: Readonly<Record<string, Num>>,
  byKind: DamageBreakdown,
  characterName: string,
  lookup: TextLookup = APP_LOOKUP,
): DamageBreakdownView {
  const sources = shares(Object.entries(bySource), (id) => sourceLabel(id, characterName, lookup));
  const kinds = shares(
    KINDS.map((kind) => [kind, byKind[kind]] as const),
    (kind) => say(lookup, `web.tag.${kind as (typeof KINDS)[number]}`),
  );
  return { total: sources.total, sources: sources.rows, kinds: kinds.rows };
}
