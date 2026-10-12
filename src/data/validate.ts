/**
 * Content checks that a schema cannot express: cross-references, graph shape and value
 * ranges (docs/ARCHITECTURE.md §6). Runs on load and in tests; the talent viewer can show
 * the same messages.
 */

import { ENEMY_IDS } from './types';
import type { EnemyDef, EnemyId, GameData, TalentNode, WaveTable } from './types';

/** Upper bound on keystones in the web (docs/GDD.md §4.1: 4–6 in the MVP). */
export const MAX_KEYSTONES = 6;

/** Enemies added by eliteEvery/bossEvery; spawn rules must not use them. */
const SPECIAL_ENEMIES: readonly EnemyId[] = ['hexagon', 'boss'];

const isPositiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;
const isNonNegativeInt = (n: number): boolean => Number.isInteger(n) && n >= 0;

/** Returns human-readable issues; an empty list means the data is valid. */
export function validateGameData(data: GameData): string[] {
  return [...validateEnemies(data), ...validateWaves(data), ...validateTalents(data.talents)];
}

function validateEnemies(data: GameData): string[] {
  const issues: string[] = [];
  const enemies: Readonly<Record<string, EnemyDef | undefined>> = data.enemies;
  const known = new Set<string>(ENEMY_IDS);

  for (const id of ENEMY_IDS) {
    if (enemies[id] === undefined) issues.push(`enemies: missing definition for '${id}'`);
  }

  for (const [key, def] of Object.entries(enemies)) {
    if (def === undefined) continue;
    const at = `enemies.${key}`;
    if (!known.has(key)) issues.push(`${at}: unknown enemy id`);
    if (def.id !== key) issues.push(`${at}: id is '${def.id}', expected '${key}'`);
    if (!(def.hpMult > 0)) issues.push(`${at}: hpMult must be > 0 (got ${def.hpMult})`);
    if (!(def.speed >= 0)) issues.push(`${at}: speed must be >= 0 (got ${def.speed})`);
    if (!(def.radius > 0)) issues.push(`${at}: radius must be > 0 (got ${def.radius})`);
    if (!(def.contactDamage >= 0)) {
      issues.push(`${at}: contactDamage must be >= 0 (got ${def.contactDamage})`);
    }
    if (!(def.dropMult >= 0)) issues.push(`${at}: dropMult must be >= 0 (got ${def.dropMult})`);
    if (!isNonNegativeInt(def.cores)) {
      issues.push(`${at}: cores must be a non-negative integer (got ${def.cores})`);
    }
    if (!isNonNegativeInt(def.color) || def.color > 0xffffff) {
      issues.push(`${at}: color must be an integer 0xRRGGBB (got ${def.color})`);
    }
    if (def.splitInto !== undefined) {
      const { enemy, count } = def.splitInto;
      if (enemy === key) issues.push(`${at}: splitInto references itself`);
      else if (enemies[enemy] === undefined) {
        issues.push(`${at}: splitInto references unknown enemy '${enemy}'`);
      }
      if (!isPositiveInt(count)) {
        issues.push(`${at}: splitInto.count must be a positive integer (got ${count})`);
      }
    }
  }

  // A split chain that loops back (a → b → a) would spawn forever. Every enemy on the loop
  // gets its own issue; self-splits are reported above.
  for (const [key, def] of Object.entries(enemies)) {
    if (def?.splitInto === undefined || def.splitInto.enemy === key) continue;
    const seen = new Set<string>();
    let current: string | undefined = key;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      current = enemies[current]?.splitInto?.enemy;
    }
    if (current === key) issues.push(`enemies.${key}: splitInto chain loops back to itself`);
  }

  return issues;
}

function validateWaves(data: GameData): string[] {
  const issues: string[] = [];
  const waves: WaveTable = data.waves;
  const enemies: Readonly<Record<string, unknown>> = data.enemies;

  waves.rules.forEach((rule, i) => {
    const at = `waves.rules[${i}] (${rule.enemy})`;
    if (enemies[rule.enemy] === undefined) issues.push(`${at}: unknown enemy`);
    if (SPECIAL_ENEMIES.includes(rule.enemy)) {
      issues.push(`${at}: '${rule.enemy}' is added by eliteEvery/bossEvery, not spawn rules`);
    }
    if (!isPositiveInt(rule.fromWave)) {
      issues.push(`${at}: fromWave must be a positive integer (got ${rule.fromWave})`);
    }
    if (!(rule.base >= 0)) issues.push(`${at}: base must be >= 0 (got ${rule.base})`);
    if (!(rule.perWave >= 0)) issues.push(`${at}: perWave must be >= 0 (got ${rule.perWave})`);
    if (!isNonNegativeInt(rule.maxCount)) {
      issues.push(`${at}: maxCount must be a non-negative integer (got ${rule.maxCount})`);
    }
  });

  for (const key of ['eliteEvery', 'bossEvery'] as const) {
    if (!isPositiveInt(waves[key])) {
      issues.push(`waves: ${key} must be a positive integer (got ${waves[key]})`);
    }
  }
  for (const key of ['spawnDurationSec', 'waveTimerSec'] as const) {
    if (!(waves[key] > 0)) issues.push(`waves: ${key} must be > 0 (got ${waves[key]})`);
  }

  return issues;
}

function validateTalents(talents: readonly TalentNode[]): string[] {
  const issues: string[] = [];
  const byId = new Map<string, TalentNode>();

  for (const node of talents) {
    if (node.id === '') issues.push('talents: node with an empty id');
    else if (byId.has(node.id)) issues.push(`talents: duplicate id '${node.id}'`);
    else byId.set(node.id, node);
  }

  const starts = talents.filter((node) => node.kind === 'start');
  if (starts.length !== 1) {
    issues.push(`talents: expected exactly one 'start' node, found ${starts.length}`);
  }
  for (const start of starts) {
    if (start.pos.x !== 0 || start.pos.y !== 0) {
      issues.push(`talent '${start.id}': start node must be at (0, 0)`);
    }
  }

  const keystones = talents.filter((node) => node.kind === 'keystone').length;
  if (keystones > MAX_KEYSTONES) {
    issues.push(`talents: ${keystones} keystones, at most ${MAX_KEYSTONES} allowed`);
  }

  for (const node of talents) {
    const at = `talent '${node.id}'`;

    const seenLinks = new Set<string>();
    for (const link of node.links) {
      if (seenLinks.has(link)) {
        issues.push(`${at}: duplicate link to '${link}'`);
        continue;
      }
      seenLinks.add(link);
      if (link === node.id) {
        issues.push(`${at}: links to itself`);
        continue;
      }
      const other = byId.get(link);
      if (other === undefined) issues.push(`${at}: links to unknown node '${link}'`);
      else if (!other.links.includes(node.id)) {
        issues.push(`${at}: links to '${link}' but '${link}' does not link back`);
      }
    }

    if (node.kind === 'repeatable' && node.repeat === undefined) {
      issues.push(`${at}: repeatable node needs 'repeat'`);
    }
    if (node.kind !== 'repeatable' && node.repeat !== undefined) {
      issues.push(`${at}: only repeatable nodes may have 'repeat'`);
    }
    if (node.repeat !== undefined) {
      if (!(node.repeat.baseShards > 0)) {
        issues.push(`${at}: repeat.baseShards must be > 0 (got ${node.repeat.baseShards})`);
      }
      if (!(node.repeat.growth >= 1)) {
        issues.push(`${at}: repeat.growth must be >= 1 (got ${node.repeat.growth})`);
      }
    }

    if (node.kind === 'keystone' && node.rules.length === 0) {
      issues.push(`${at}: keystone needs at least one rule`);
    }
    if (node.kind !== 'keystone' && node.rules.length > 0) {
      issues.push(`${at}: only keystones may have rules`);
    }

    if (node.shardCostFactor !== undefined && !(node.shardCostFactor >= 0)) {
      issues.push(`${at}: shardCostFactor must be >= 0 (got ${node.shardCostFactor})`);
    }
    if (node.coreCost !== undefined && !isNonNegativeInt(node.coreCost)) {
      issues.push(`${at}: coreCost must be a non-negative integer (got ${node.coreCost})`);
    }
    if (node.nameKey === '') issues.push(`${at}: empty nameKey`);
    if (node.descKey === '') issues.push(`${at}: empty descKey`);
  }

  // Reachability over the links as listed; asymmetric links are reported above.
  if (starts.length > 0) {
    const reached = new Set<string>(starts.map((node) => node.id));
    const queue = [...reached];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      for (const link of byId.get(id)?.links ?? []) {
        if (byId.has(link) && !reached.has(link)) {
          reached.add(link);
          queue.push(link);
        }
      }
    }
    for (const id of byId.keys()) {
      if (!reached.has(id)) issues.push(`talent '${id}': not reachable from the start node`);
    }
  }

  return issues;
}
