import { ENEMY_IDS } from './types';
import type { EnemyDef, EnemyId, GameData, WaveTable } from './types';

export interface WaveEntry {
  readonly enemy: EnemyId;
  readonly count: number;
}

export const isBossWave = (wave: number, table: WaveTable): boolean => wave % table.bossEvery === 0;

export const isEliteWave = (wave: number, table: WaveTable): boolean =>
  !isBossWave(wave, table) && wave % table.eliteEvery === 0;

/**
 * The boss of boss wave `wave`: M1's `boss`, or in a v3 run its bossRotation in turn from the
 * first boss wave on (docs/v3 C7 design §1.2). Validation keeps the rotation non-empty.
 */
export function bossOf(wave: number, table: WaveTable): EnemyId {
  if (table.v3 === undefined) return 'boss';
  const rotation = table.v3.bossRotation;
  return rotation[(wave / table.bossEvery - 1) % rotation.length] ?? 'boss';
}

/**
 * Enemies spawned in a wave, in spawn order. Shared by the simulation (spawning) and meta
 * (expected drops for skip compensation) so both always agree.
 */
export function composeWave(wave: number, table: WaveTable): WaveEntry[] {
  const entries: WaveEntry[] = [];
  for (const rule of table.rules) {
    if (wave < rule.fromWave) continue;
    const count = Math.min(
      rule.maxCount,
      Math.max(rule.minCount ?? 0, Math.floor(rule.base + rule.perWave * (wave - rule.fromWave))),
    );
    if (count > 0) entries.push({ enemy: rule.enemy, count });
  }
  if (isBossWave(wave, table)) entries.push({ enemy: bossOf(wave, table), count: 1 });
  else if (isEliteWave(wave, table)) entries.push({ enemy: 'hexagon', count: 1 });
  return entries;
}

/**
 * Every type a run of `data` can spawn, in ENEMY_IDS order (docs/v3 C7 design §1.2): the rules'
 * types, the elite, the bosses (a v3 run's rotation, else `boss`) and a v3 run's treasure, closed
 * over what each splits into, summons and bursts into. The shots' tough pass needs every
 * non-tough one within ctx.shotPad, which is taken over these alone.
 */
export function reachableEnemies(data: GameData): EnemyId[] {
  const { enemies, waves } = data;
  const reached = new Set<EnemyId>(waves.rules.map((rule) => rule.enemy));
  reached.add('hexagon');
  if (waves.v3 === undefined) reached.add('boss');
  else {
    for (const id of waves.v3.bossRotation) reached.add(id);
    reached.add(waves.v3.treasure.enemy);
  }
  // The set grows while it is walked; each type added is visited in turn.
  for (const id of reached) {
    for (const spawned of spawnsOf(enemies[id])) reached.add(spawned);
  }
  return ENEMY_IDS.filter((id) => reached.has(id));
}

/** The types an enemy of `def` brings into the run: its split, its summons, its bursts. */
function spawnsOf(def: EnemyDef): EnemyId[] {
  const spawns: EnemyId[] = [];
  if (def.splitInto !== undefined) spawns.push(def.splitInto.enemy);
  const behaviour = def.behaviour;
  if (behaviour?.kind === 'summon') spawns.push(behaviour.enemy);
  else if (behaviour?.kind === 'layers') spawns.push(behaviour.burst.enemy);
  return spawns;
}
