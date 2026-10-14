/**
 * Small hand-made GameData for meta tests. Test-only: never import from production code.
 *
 *   far ─ k ─ a2 ─ a ─ start ─ b
 *                        │
 *                        r (repeatable)
 */

import type { EnemyDef, EnemyId, GameData, TalentKind, TalentNode } from '../data/types';
import { needsDescKey } from '../data/validate';

type TalentExtras = Partial<
  Pick<
    TalentNode,
    | 'shardCostFactor'
    | 'coreCost'
    | 'repeat'
    | 'modifiers'
    | 'rules'
    | 'triggers'
    | 'conversions'
    | 'emitters'
    | 'archetype'
    | 'pos'
  >
>;

/**
 * A node with empty lists by default; like src/data/talents.ts node(), it gets a descKey when
 * it has rules, triggers, conversions, emitters or behaviour modifiers (needsDescKey).
 */
export function talent(
  id: string,
  kind: TalentKind,
  links: readonly string[],
  extras: TalentExtras = {},
): TalentNode {
  const node: TalentNode = {
    id,
    kind,
    pos: { x: 0, y: 0 },
    links,
    modifiers: [],
    rules: [],
    triggers: [],
    conversions: [],
    emitters: [],
    archetype: 'none',
    nameKey: `talent.${id}.name`,
    ...extras,
  };
  return needsDescKey(node) ? { ...node, descKey: `talent.${id}.desc` } : node;
}

export const FIXTURE_TALENTS: readonly TalentNode[] = [
  talent('start', 'start', ['a', 'b', 'r'], {
    modifiers: [{ stat: 'maxLife', kind: 'flat', value: 20 }],
  }),
  talent('a', 'small', ['start', 'a2'], {
    modifiers: [{ stat: 'damage', kind: 'increased', value: 0.1 }],
  }),
  talent('a2', 'notable', ['a', 'k'], {
    shardCostFactor: 2,
    coreCost: 1,
    modifiers: [{ stat: 'critChance', kind: 'flat', value: 0.05 }],
  }),
  talent('k', 'keystone', ['a2', 'far'], {
    coreCost: 2,
    rules: [{ id: 'glassCannon', damageMore: 1 }],
  }),
  talent('far', 'small', ['k'], {
    modifiers: [{ stat: 'damage', kind: 'flat', value: 3 }],
  }),
  talent('b', 'small', ['start'], {
    modifiers: [{ stat: 'attackSpeed', kind: 'increased', value: 0.2 }],
  }),
  talent('r', 'repeatable', ['start'], {
    repeat: { baseShards: 10, growth: 2 },
    modifiers: [{ stat: 'damage', kind: 'more', value: 0.1 }],
  }),
];

function enemy(
  id: EnemyId,
  dropMult: number,
  cores: number,
  extras: Partial<EnemyDef> = {},
): EnemyDef {
  return {
    id,
    shape: 'triangle',
    hpMult: 1,
    speed: 100,
    radius: 20,
    contactDamage: 10,
    dropMult,
    cores,
    color: 0xffffff,
    ...extras,
  };
}

export const FIXTURE_ENEMIES: Readonly<Record<EnemyId, EnemyDef>> = {
  triangle: enemy('triangle', 0.5, 0),
  square: enemy('square', 1, 0),
  pentagon: enemy('pentagon', 1, 0, { splitInto: { enemy: 'shard', count: 3 } }),
  shard: enemy('shard', 0.25, 0),
  hexagon: enemy('hexagon', 3, 1),
  boss: enemy('boss', 6, 5),
};

export function fixtureData(overrides: Partial<GameData> = {}): GameData {
  return {
    enemies: FIXTURE_ENEMIES,
    waves: {
      rules: [
        { enemy: 'triangle', fromWave: 1, base: 4, perWave: 0.5, maxCount: 12 },
        { enemy: 'square', fromWave: 3, base: 2, perWave: 0.25, maxCount: 8 },
        { enemy: 'pentagon', fromWave: 8, base: 1, perWave: 0.2, maxCount: 4 },
      ],
      eliteEvery: 5,
      bossEvery: 10,
      spawnDurationSec: 1,
      waveTimerSec: 8,
    },
    talents: FIXTURE_TALENTS,
    ...overrides,
  };
}
