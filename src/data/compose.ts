import type { EnemyId, WaveTable } from './types';

export interface WaveEntry {
  readonly enemy: EnemyId;
  readonly count: number;
}

export const isBossWave = (wave: number, table: WaveTable): boolean => wave % table.bossEvery === 0;

export const isEliteWave = (wave: number, table: WaveTable): boolean =>
  !isBossWave(wave, table) && wave % table.eliteEvery === 0;

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
      Math.floor(rule.base + rule.perWave * (wave - rule.fromWave)),
    );
    if (count > 0) entries.push({ enemy: rule.enemy, count });
  }
  if (isBossWave(wave, table)) entries.push({ enemy: 'boss', count: 1 });
  else if (isEliteWave(wave, table)) entries.push({ enemy: 'hexagon', count: 1 });
  return entries;
}
