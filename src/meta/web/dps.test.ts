import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import { characterGameData } from '../../data';
import { loadContent } from '../../data/web';
import { assembleWeb } from '../../data/web/assemble';
import { FULL_SCOPE } from '../../data/web/scope';
import { probeData, readDps, withRanks } from './dps';
import { defaultProgress } from './invest';

const data = characterGameData();
const ice = assembleWeb(loadContent(), 'ice', FULL_SCOPE);
const account = { singularityBeaten: false };

describe('the DPS preview (gd §8 item 7)', () => {
  it('reads a crowd and a boss, both above zero, and the same twice', () => {
    const progress = defaultProgress(ice, account, 10);
    const reading = readDps(ice, progress, data);
    expect(toNumber(reading.crowd)).toBeGreaterThan(0);
    expect(toNumber(reading.boss)).toBeGreaterThan(0);
    expect(readDps(ice, progress, data)).toEqual(reading);
  });

  it('moves with a node: a rank of 強化∞ is ×1.10 to all damage', () => {
    const progress = defaultProgress(ice, account, 20);
    const before = readDps(ice, progress, data);
    const after = readDps(ice, withRanks(progress, ['hub.might.might']), data);
    expect(toNumber(after.crowd) / toNumber(before.crowd)).toBeCloseTo(1.1, 2);
    expect(toNumber(after.boss) / toNumber(before.boss)).toBeCloseTo(1.1, 2);
  });

  it('probes enemies that neither die nor hurt, from cached data', () => {
    const probes = probeData(data);
    expect(probeData(data)).toBe(probes);
    expect(probes.crowd.enemies.square.contactDamage).toBe(0);
    expect(probes.boss.waves.bossEvery).toBe(1);
    expect(probes.boss.waves.v3?.bossRotation).toEqual(['onion']);
  });
});
