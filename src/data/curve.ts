/**
 * The single master curve (docs/GDD.md §7): standard-enemy HP per wave, target hits to
 * kill, and the damage targets derived from them. Game and balance simulator share it.
 */

/**
 * HP of the standard enemy (the square) at wave 1. Waves are a swarm of small enemies, so the
 * standard enemy is a quarter of the M1 one (20) and waves hold about four times as many.
 */
export const HP_WAVE_1 = 5;

/** Piecewise growth: from `fromWave` onward each wave multiplies HP by `growth`. */
export const HP_SEGMENTS: readonly { readonly fromWave: number; readonly growth: number }[] = [
  { fromWave: 2, growth: 1.3 },
  { fromWave: 26, growth: 1.2 },
  { fromWave: 51, growth: 1.15 },
  { fromWave: 101, growth: 1.12 },
];

/** Hits a standard enemy should take at the frontier wave. */
export const FRONTIER_HITS_TO_KILL = 2;

/**
 * HP multipliers relative to the standard enemy (docs/GDD.md §2.4); src/data/enemies.ts must
 * use the same values. Elites and bosses stay single tough targets in the swarm.
 */
export const ELITE_HP_MULT = 14;
export const BOSS_HP_MULT = 28;

const MAX_TABLE_WAVE = 2000;
const hpTable: number[] = buildHpTable();

function buildHpTable(): number[] {
  const table = [0, HP_WAVE_1];
  for (let wave = 2; wave <= MAX_TABLE_WAVE; wave++) {
    let growth = 1;
    for (const segment of HP_SEGMENTS) {
      if (wave >= segment.fromWave) growth = segment.growth;
    }
    table.push((table[wave - 1] as number) * growth);
  }
  return table;
}

function checkWave(wave: number): void {
  if (!Number.isInteger(wave) || wave < 1 || wave > MAX_TABLE_WAVE) {
    throw new RangeError(`Wave out of range: ${wave}`);
  }
}

/** Standard-enemy HP at a wave. */
export function stdHp(wave: number): number {
  checkWave(wave);
  return hpTable[wave] as number;
}

/**
 * The growth from wave `wave` − 1 to `wave`: the last HP_SEGMENTS entry with fromWave ≤ wave;
 * HP_SEGMENTS[0]'s below 2 (docs/v3 C6 design §4.10).
 */
export function growthInto(wave: number): number {
  let growth = (HP_SEGMENTS[0] as { readonly growth: number }).growth;
  for (const segment of HP_SEGMENTS) {
    if (wave >= segment.fromWave) growth = segment.growth;
  }
  return growth;
}

/**
 * Standard HP at a fractional wave, geometric inside a wave (docs/v3 C6 design §4.10, F28):
 * stdHp(⌊x⌋) × growthInto(⌊x⌋ + 1)^(x − ⌊x⌋), and HP_WAVE_1 × growthInto(1)^(x − 1) below 1, so
 * it equals stdHp at every wave and the 25/26, 50/51 and 100/101 seams need no rule of their own.
 * Calibration reads a run's fractional frontier through it.
 */
export function stdHpAt(x: number): number {
  if (x < 1) return HP_WAVE_1 * Math.pow(growthInto(1), x - 1);
  const wave = Math.floor(x);
  return stdHp(wave) * Math.pow(growthInto(wave + 1), x - wave);
}

/** Target effective damage per attack when `wave` is the frontier: HP(F) ÷ hits-to-kill. */
export function targetDamage(frontierWave: number): number {
  return stdHp(frontierWave) / FRONTIER_HITS_TO_KILL;
}

/**
 * Shards dropped by an enemy with dropMult 1 at a wave, before shardGain.
 * Placeholder economy; the balance simulator tunes SHARD_SCALE and SHARD_EXPONENT.
 * SHARD_SCALE 0.15 ≈ 0.2 × 4^-0.2 keeps a wave's shards where they were before the swarm
 * change (four times the enemies, each with a quarter of the HP).
 */
export const SHARD_SCALE = 0.15;
export const SHARD_EXPONENT = 0.8;

export function shardsPerStdEnemy(wave: number): number {
  return SHARD_SCALE * Math.pow(stdHp(wave), SHARD_EXPONENT);
}

/** Progress targets from docs/GDD.md §7.3, used by the balance simulator's curve check. */
export const PACING_TARGETS: readonly {
  readonly minutes: number;
  readonly frontierWave: number;
  readonly event: string;
}[] = [
  { minutes: 0, frontierWave: 3, event: 'start' },
  { minutes: 10, frontierWave: 15, event: 'first notable' },
  { minutes: 20, frontierWave: 22, event: 'first keystone' },
  { minutes: 40, frontierWave: 30, event: 'first prestige' },
  { minutes: 60, frontierWave: 40, event: 'demo end' },
  { minutes: 180, frontierWave: 70, event: '' },
];

/** Allowed relative deviation of the frontier wave from PACING_TARGETS (docs/GDD.md §7.5). */
export const PACING_TOLERANCE = 0.15;
