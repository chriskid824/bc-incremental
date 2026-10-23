import { describe, expect, it } from 'vitest';
import { bossOf, composeWave, isBossWave, isEliteWave, reachableEnemies } from './compose';
import type { WaveEntry } from './compose';
import { ENEMIES } from './enemies';
import { characterGameData, loadGameData } from './index';
import { TALENTS } from './talents';
import type { EnemyId, GameData, WaveTable } from './types';
import { WAVES } from './waves';
import { V3_WAVES } from './wavesV3';

const countOf = (entries: readonly WaveEntry[], enemy: EnemyId): number =>
  entries.find((entry) => entry.enemy === enemy)?.count ?? 0;

describe('composeWave', () => {
  it('spawns only triangles on wave 1, at their minimum count', () => {
    expect(composeWave(1, WAVES)).toEqual([{ enemy: 'triangle', count: 45 }]);
  });

  it('grows triangles past their minimum from wave 18', () => {
    expect(countOf(composeWave(16, WAVES), 'triangle')).toBe(45);
    expect(countOf(composeWave(17, WAVES), 'triangle')).toBe(45);
    expect(countOf(composeWave(18, WAVES), 'triangle')).toBe(47);
  });

  it('adds squares from wave 3', () => {
    expect(countOf(composeWave(2, WAVES), 'square')).toBe(0);
    expect(composeWave(3, WAVES)).toEqual([
      { enemy: 'triangle', count: 45 },
      { enemy: 'square', count: 8 },
    ]);
  });

  it('adds pentagons from wave 8', () => {
    expect(countOf(composeWave(7, WAVES), 'pentagon')).toBe(0);
    expect(countOf(composeWave(8, WAVES), 'pentagon')).toBe(4);
  });

  it('adds one hexagon on elite waves', () => {
    const wave5 = composeWave(5, WAVES);
    expect(countOf(wave5, 'hexagon')).toBe(1);
    expect(countOf(wave5, 'boss')).toBe(0);
    expect(wave5.at(-1)).toEqual({ enemy: 'hexagon', count: 1 });
    expect(countOf(composeWave(15, WAVES), 'hexagon')).toBe(1);
    expect(countOf(composeWave(6, WAVES), 'hexagon')).toBe(0);
  });

  it('adds one boss and no hexagon on boss waves', () => {
    for (const wave of [10, 20, 100]) {
      const entries = composeWave(wave, WAVES);
      expect(countOf(entries, 'boss')).toBe(1);
      expect(countOf(entries, 'hexagon')).toBe(0);
      expect(entries.at(-1)).toEqual({ enemy: 'boss', count: 1 });
    }
  });

  it('floors a rule at its minCount until its growth passes it', () => {
    const table: WaveTable = {
      ...WAVES,
      rules: [{ enemy: 'square', fromWave: 1, base: 10, perWave: 2, minCount: 15, maxCount: 30 }],
    };
    expect(countOf(composeWave(1, table), 'square')).toBe(15);
    expect(countOf(composeWave(3, table), 'square')).toBe(15);
    expect(countOf(composeWave(4, table), 'square')).toBe(16);
    expect(countOf(composeWave(50, table), 'square')).toBe(30);
  });

  it('caps every rule at its maxCount on very high waves', () => {
    for (const wave of [200, 1000, 2000]) {
      const entries = composeWave(wave, WAVES);
      for (const rule of WAVES.rules) {
        expect(countOf(entries, rule.enemy)).toBe(rule.maxCount);
      }
    }
  });

  it('never produces empty or fractional groups', () => {
    for (let wave = 1; wave <= 150; wave++) {
      for (const entry of composeWave(wave, WAVES)) {
        expect(Number.isInteger(entry.count)).toBe(true);
        expect(entry.count).toBeGreaterThan(0);
      }
    }
  });
});

describe('isBossWave / isEliteWave', () => {
  it('gives boss waves precedence over elite waves', () => {
    expect(isBossWave(10, WAVES)).toBe(true);
    expect(isEliteWave(10, WAVES)).toBe(false);
    expect(isEliteWave(5, WAVES)).toBe(true);
    expect(isBossWave(5, WAVES)).toBe(false);
    expect(isEliteWave(4, WAVES)).toBe(false);
  });
});

/** V3_WAVES with its boss rotation replaced. */
const rotating = (bossRotation: readonly EnemyId[], bossEvery = V3_WAVES.bossEvery): WaveTable => ({
  ...V3_WAVES,
  bossEvery,
  v3: { ...V3_WAVES.v3, bossRotation },
});

/** The M1 rule types' entries of a wave. */
const m1Entries = (entries: readonly WaveEntry[]): WaveEntry[] =>
  entries.filter((entry) => ['triangle', 'square', 'pentagon'].includes(entry.enemy));

describe('composeWave: v3 waves (docs/v3 C7 design §1.2)', () => {
  it.each([
    ['shielder', 12, 3],
    ['regenerator', 16, 3],
    ['dasher', 22, 3],
    ['shooter', 32, 2],
    ['summoner', 42, 1],
  ] as const)(
    'first spawns %s on wave %i, %i of them, and none the wave before',
    (enemy, first, count) => {
      expect(countOf(composeWave(first - 1, V3_WAVES), enemy)).toBe(0);
      expect(countOf(composeWave(first, V3_WAVES), enemy)).toBe(count);
    },
  );

  it('keeps M1’s groups and elites, and never composes the treasure, whose schedule brings it', () => {
    for (let wave = 1; wave <= 150; wave++) {
      const v3 = composeWave(wave, V3_WAVES);
      const m1 = composeWave(wave, WAVES);
      expect(m1Entries(v3), `wave ${wave}`).toEqual(m1Entries(m1));
      expect(countOf(v3, 'hexagon')).toBe(countOf(m1, 'hexagon'));
      expect(countOf(v3, 'treasure')).toBe(0);
      expect(countOf(v3, 'boss')).toBe(0);
    }
  });

  it('caps the v3 types at 18, 18, 18, 10 and 4', () => {
    const entries = composeWave(1001, V3_WAVES);
    expect(
      (['shielder', 'regenerator', 'dasher', 'shooter', 'summoner'] as const).map((enemy) =>
        countOf(entries, enemy),
      ),
    ).toEqual([18, 18, 18, 10, 4]);
  });

  it('ends a boss wave with the rotation’s boss', () => {
    for (const wave of [10, 20, 100]) {
      const entries = composeWave(wave, V3_WAVES);
      expect(entries.at(-1)).toEqual({ enemy: 'onion', count: 1 });
      expect(countOf(entries, 'hexagon')).toBe(0);
    }
  });
});

describe('bossOf', () => {
  it('names M1’s boss on M1 boss waves and the onion on v3 ones', () => {
    for (const wave of [10, 20, 30]) {
      expect(bossOf(wave, WAVES)).toBe('boss');
      expect(bossOf(wave, V3_WAVES)).toBe('onion');
    }
  });

  it('takes the rotation in turn from the first boss wave', () => {
    const waves = [10, 20, 30, 40, 50, 60];
    expect(waves.map((wave) => bossOf(wave, rotating(['onion', 'boss'])))).toEqual([
      'onion',
      'boss',
      'onion',
      'boss',
      'onion',
      'boss',
    ]);
    const every7 = rotating(['boss', 'onion', 'onion'], 7);
    expect([7, 14, 21, 28].map((wave) => bossOf(wave, every7))).toEqual([
      'boss',
      'onion',
      'onion',
      'boss',
    ]);
    expect(composeWave(14, every7).at(-1)).toEqual({ enemy: 'onion', count: 1 });
    expect(composeWave(28, every7).at(-1)).toEqual({ enemy: 'boss', count: 1 });
  });
});

describe('reachableEnemies', () => {
  it('is the rule types, their splits, the elite and the boss for M1’s data', () => {
    expect(reachableEnemies(loadGameData())).toEqual([
      'triangle',
      'square',
      'pentagon',
      'shard',
      'hexagon',
      'boss',
    ]);
  });

  it('is every type but M1’s boss for the v3 data: the rules’, the rotation’s and the treasure', () => {
    expect(reachableEnemies(characterGameData())).toEqual([
      'triangle',
      'square',
      'pentagon',
      'shard',
      'hexagon',
      'shielder',
      'regenerator',
      'dasher',
      'shooter',
      'summoner',
      'treasure',
      'onion',
    ]);
  });

  it('closes over what each type splits into, summons and bursts into', () => {
    // A summoner alone in the rules: its summons are squares, and the onion's bursts pentagons,
    // which split into shards.
    const data: GameData = {
      enemies: {
        ...ENEMIES,
        summoner: {
          ...ENEMIES.summoner,
          behaviour: { kind: 'summon', stopDist: 480, periodSec: 3, enemy: 'square', count: 2 },
        },
        onion: {
          ...ENEMIES.onion,
          behaviour: { kind: 'layers', layers: 3, burst: { enemy: 'pentagon', count: 12 } },
        },
      },
      waves: {
        ...V3_WAVES,
        rules: [{ enemy: 'summoner', fromWave: 1, base: 1, perWave: 0, maxCount: 1 }],
      },
      talents: TALENTS,
    };
    expect(reachableEnemies(data)).toEqual([
      'square',
      'pentagon',
      'shard',
      'hexagon',
      'summoner',
      'treasure',
      'onion',
    ]);
    // Without the v3 block: the rule, the elite and M1's boss only.
    expect(reachableEnemies({ ...data, waves: { ...WAVES, rules: data.waves.rules } })).toEqual([
      'square',
      'hexagon',
      'boss',
      'summoner',
    ]);
  });
});
