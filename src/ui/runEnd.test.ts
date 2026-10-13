import { afterEach, describe, expect, it } from 'vitest';
import { ENEMY_IDS } from '../data/types';
import type { EnemyId } from '../data/types';
import { setLocale } from '../i18n';
import type { ContactTally } from '../sim/types';
import { describeRunEnd, enemyName, enemyPlural, FAST_SPEED, mainThreat } from './runEnd';
import type { EnemySpeeds, RunEndFacts } from './runEnd';

/** Fixture speeds: triangles and splinters are fast, the rest slow. */
const SPEEDS: EnemySpeeds = {
  triangle: { speed: 160 },
  square: { speed: 110 },
  pentagon: { speed: 130 },
  shard: { speed: 200 },
  hexagon: { speed: 90 },
  boss: { speed: 60 },
};

function tallies(hits: Partial<Record<EnemyId, readonly [number, number]>> = {}) {
  const by = {} as Record<EnemyId, ContactTally>;
  for (const id of ENEMY_IDS) {
    const [count, damage] = hits[id] ?? [0, 0];
    by[id] = { hits: count, damage };
  }
  return by;
}

/** Facts with leaks and damageTaken summed from the per-type tallies. */
function facts(
  overrides: Partial<RunEndFacts>,
  hits: Partial<Record<EnemyId, readonly [number, number]>> = {},
): RunEndFacts {
  const by = tallies(hits);
  const all = Object.values(by);
  return {
    endReason: 'death',
    startWave: 1,
    clearedStartWave: true,
    nextStartWave: 1,
    highestWave: 7,
    limitSec: 180,
    maxLife: 100,
    glassCannon: false,
    leaks: all.reduce((sum, tally) => sum + tally.hits, 0),
    damageTaken: all.reduce((sum, tally) => sum + tally.damage, 0),
    damageTakenBy: by,
    killedBy: null,
    ...overrides,
  };
}

describe('describeRunEnd', () => {
  afterEach(() => setLocale('en'));

  it('names the killer and the type that dealt the most damage, with a fast-enemy tip', () => {
    const text = describeRunEnd(
      facts({ killedBy: 'square' }, { triangle: [8, 64], square: [3, 45], pentagon: [1, 12] }),
      SPEEDS,
    );
    expect(text.cause).toBe('Killed by a Square');
    expect(text.leaks).toBe('12 enemies reached you for 121 damage (64 from Triangles)');
    expect(text.tip).toMatch(/^Triangles are fast/);
    expect(text.tip).toContain('damage and attack speed');
    expect(text.tip).toContain('Vitality');
  });

  it('calls out an enemy whose single hit takes a large share of life', () => {
    const text = describeRunEnd(
      facts({ killedBy: 'boss' }, { triangle: [2, 16], boss: [1, 100] }),
      SPEEDS,
    );
    expect(text.cause).toBe('Killed by a Boss');
    // One boss is the biggest share: singular, not "from Bosses".
    expect(text.leaks).toBe('3 enemies reached you for 116 damage (100 from one Boss)');
    expect(text.tip).toMatch(/^One Boss hit takes 100 of your 100 life\./);
  });

  it('falls back to the swarm tip for slow enemies that keep getting through', () => {
    const text = describeRunEnd(facts({ killedBy: 'square' }, { square: [7, 105] }), SPEEDS);
    expect(text.leaks).toBe('7 enemies reached you for 105 damage');
    expect(text.tip).toMatch(/^Squares kept getting through\./);
    expect(SPEEDS.square.speed).toBeLessThan(FAST_SPEED);
  });

  it('does not suggest Life nodes under Glass Cannon', () => {
    const text = describeRunEnd(
      facts({ killedBy: 'triangle', maxLife: 1, glassCannon: true }, { triangle: [1, 8] }),
      SPEEDS,
    );
    expect(text.leaks).toBe('1 enemy reached you for 8 damage');
    expect(text.tip).toMatch(/^Glass Cannon sets your life to 1/);
    expect(text.tip).toContain('damage and attack speed');
    // Respec is free, so dropping the keystone is the other lever.
    expect(text.tip).toContain('Refund all');
    expect(text.tip).not.toContain('Vitality');
  });

  it('explains timeouts and the wave cap without a tip', () => {
    const timeout = describeRunEnd(facts({ endReason: 'timeout' }), SPEEDS);
    expect(timeout).toEqual({
      cause: 'You lasted the full 3:00',
      leaks: 'No enemy reached you',
      lowerStart: null,
      tip: null,
    });
    const capped = describeRunEnd(
      facts({ endReason: 'waveCap', highestWave: 40 }, { hexagon: [1, 30] }),
      SPEEDS,
    );
    expect(capped.cause).toBe('Wave 40 cleared, the last wave of this prototype');
    expect(capped.leaks).toBe('1 enemy reached you for 30 damage');
    expect(capped.tip).toBeNull();
  });

  it('says the next run starts lower when the start wave was not cleared', () => {
    const failed = { startWave: 18, clearedStartWave: false, nextStartWave: 12 } as const;
    const text = describeRunEnd(
      facts({ ...failed, killedBy: 'triangle' }, { triangle: [9, 18] }),
      SPEEDS,
    );
    expect(text.lowerStart).toBe(
      'This run did not clear its start wave 18, so it earned no skip compensation. ' +
        'The next run starts lower on its own, at wave 12.',
    );
    // The usual advice still follows.
    expect(text.tip).toMatch(/^Triangles are fast/);
    // Also when the run did not end in death.
    expect(describeRunEnd(facts({ ...failed, endReason: 'timeout' }), SPEEDS).lowerStart).toBe(
      text.lowerStart,
    );
    setLocale('zh-TW');
    expect(describeRunEnd(facts(failed), SPEEDS).lowerStart).toBe(
      '這局沒有清掉起始的第 18 波，所以沒有跳波補償。下一局會自動從比較低的第 12 波開始。',
    );
  });

  it('says nothing about the start wave when it was cleared or could not go lower', () => {
    const lowerStart = (overrides: Partial<RunEndFacts>) =>
      describeRunEnd(facts(overrides), SPEEDS).lowerStart;
    expect(lowerStart({ startWave: 18, clearedStartWave: true, nextStartWave: 18 })).toBeNull();
    expect(lowerStart({ startWave: 1, clearedStartWave: false, nextStartWave: 1 })).toBeNull();
    expect(lowerStart({ startWave: 6, clearedStartWave: false, nextStartWave: 6 })).toBeNull();
  });

  it('formats big damage like the rest of the panel', () => {
    const text = describeRunEnd(
      facts({ killedBy: 'triangle', maxLife: 5000 }, { triangle: [700, 5600], shard: [2, 8] }),
      SPEEDS,
    );
    expect(text.leaks).toBe('702 enemies reached you for 5.61K damage (5.60K from Triangles)');
  });

  it('speaks Traditional Chinese', () => {
    setLocale('zh-TW');
    const text = describeRunEnd(
      facts({ killedBy: 'square' }, { triangle: [8, 64], square: [3, 45] }),
      SPEEDS,
    );
    expect(text.cause).toBe('被方塊撞死');
    expect(text.leaks).toBe('11 個敵人碰到你，共 109 點傷害（三角佔 64）');
    expect(text.tip).toMatch(/^三角速度快/);
    expect(text.tip).toContain('「活力」');
    const boss = describeRunEnd(
      facts({ killedBy: 'boss' }, { triangle: [2, 16], boss: [1, 100] }),
      SPEEDS,
    );
    expect(boss.leaks).toBe('3 個敵人碰到你，共 116 點傷害（一個頭目就佔 100）');
  });
});

describe('mainThreat', () => {
  it('picks the most damage, the first type on ties, null when nothing got through', () => {
    expect(mainThreat(tallies({ triangle: [5, 40], hexagon: [1, 30] }))).toBe('triangle');
    expect(mainThreat(tallies({ square: [2, 30], hexagon: [1, 30] }))).toBe('square');
    expect(mainThreat(tallies())).toBeNull();
  });
});

describe('enemy names', () => {
  afterEach(() => setLocale('en'));

  it('has a singular and plural name for every enemy type', () => {
    for (const id of ENEMY_IDS) {
      expect(enemyName(id)).not.toBe('');
      expect(enemyPlural(id)).not.toBe('');
    }
    expect(enemyName('shard')).toBe('Splinter');
    setLocale('zh-TW');
    expect(enemyName('shard')).toBe('小三角');
  });
});
