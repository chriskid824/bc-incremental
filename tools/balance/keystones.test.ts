import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../src/data';
import { collectRules } from '../../src/meta';
import {
  allocatedNodes,
  beelineBuild,
  isSector,
  runFrom,
  sectorBuild,
  sectorKeystone,
  sectorSpine,
  shortestPath,
} from './builds';
import {
  beelineReport,
  GAMBLE_KEYSTONE,
  keystoneChecks,
  keystoneReport,
  measureBeelines,
  measureKeystones,
  medianGain,
  ownMargin,
  pairedGain,
  parseLevels,
  worstGain,
} from './keystones';
import type { BeelineValue, KeystoneValue } from './keystones';

const data = loadGameData();

const value = (overrides: Partial<KeystoneValue>): KeystoneValue => ({
  sector: 'crit',
  keystone: 'steadyAim',
  might: 0,
  without: [20, 21, 22],
  with: [24, 26, 25],
  ...overrides,
});

describe('sectorBuild', () => {
  it('allocates the whole sector, the generic small nodes and Might ranks', () => {
    const meta = sectorBuild(data, 'chain', { keystone: false, might: 7 });
    for (const node of data.talents) {
      const expected =
        (node.archetype === 'chain' && node.kind !== 'keystone') ||
        (node.archetype === 'none' && node.kind === 'small') ||
        node.kind === 'repeatable';
      expect(meta.allocated.has(node.id), node.id).toBe(expected);
    }
    expect([...meta.ranks.values()]).toEqual([7]);
  });

  it('adds the sector keystone or an extra node on request', () => {
    const withKeystone = sectorBuild(data, 'dot', { keystone: true, might: 0 });
    expect(withKeystone.allocated.has(sectorKeystone(data, 'dot').id)).toBe(true);
    expect(withKeystone.ranks.size).toBe(0);
    const gamble = sectorBuild(data, 'crit', { keystone: false, might: 0, extra: ['glassCannon'] });
    expect(collectRules(gamble, data).map((rule) => rule.id)).toEqual(['glassCannon']);
  });

  it('knows the sectors and their keystones', () => {
    expect(['crit', 'dot', 'chain'].map((s) => isSector(s) && sectorKeystone(data, s).id)).toEqual([
      'steadyAim',
      'pandemic',
      'overload',
    ]);
    expect(isSector('hybrid')).toBe(false);
  });
});

describe('beelineBuild', () => {
  it('finds each sector spine up to its first notable', () => {
    expect(sectorSpine(data, 'crit')).toEqual(['keenEye', 'sharpen', 'quickDraw', 'precision']);
    expect(sectorSpine(data, 'dot')).toEqual(['kindling', 'fuel', 'slowBurn', 'inferno']);
    expect(sectorSpine(data, 'chain')).toEqual(['spark', 'conductor', 'charge', 'arcStorm']);
  });

  it('takes the shortest link path, through a bridge rather than the start', () => {
    expect(shortestPath(data, sectorSpine(data, 'dot'), 'overload')).toEqual([
      'staticHeat',
      'charge',
      'arcStorm',
      'reach',
      'voltage',
      'overload',
    ]);
    expect(shortestPath(data, ['keenEye'], 'kindling')).toEqual(['start', 'kindling']);
    expect(() => shortestPath(data, ['keenEye'], 'nowhere')).toThrow();
  });

  it('buys the spine and the path instead of the rest of the sector', () => {
    const meta = beelineBuild(data, 'crit', 'overload', 3);
    expect(meta.allocated.has('precision')).toBe(true);
    expect(meta.allocated.has('stormEye')).toBe(true);
    expect(meta.allocated.has('overload')).toBe(true);
    expect(meta.allocated.has('deadlyAim')).toBe(false);
    expect(meta.allocated.has('steadyAim')).toBe(false);
    expect(meta.allocated.has('swiftness')).toBe(true);
    expect(meta.ranks.get('might')).toBe(3);
    const own = sectorBuild(data, 'crit', { keystone: true, might: 3 });
    expect(allocatedNodes(meta, data)).toBe(allocatedNodes(own, data) + 1);
  });
});

describe('runFrom', () => {
  it('is deterministic and starts at the given wave', () => {
    const meta = sectorBuild(data, 'crit', { keystone: true, might: 0 });
    const first = runFrom(meta, data, 8, 3);
    expect(runFrom(meta, data, 8, 3)).toEqual(first);
    expect(first.wave).toBeGreaterThanOrEqual(8);
  });
});

describe('keystone gains', () => {
  it('compares medians, per-seed pairs and the worst seed', () => {
    const v = value({});
    expect(medianGain(v)).toBe(4);
    expect(pairedGain(v)).toBeCloseTo(4, 12);
    expect(worstGain(v)).toBe(3);
  });

  it('checks archetype keystones against +4..+6 at Might 0 and 15, never negative', () => {
    const checks = keystoneChecks([
      value({ might: 0 }),
      value({ might: 15, with: [26, 27, 28] }),
      value({ might: 30, with: [20, 21, 22] }),
      value({ keystone: 'overload', sector: 'chain', might: 0, with: [27, 28, 29] }),
      value({ keystone: 'pandemic', sector: 'dot', might: 30, with: [19, 20, 21] }),
      value({ keystone: GAMBLE_KEYSTONE, with: [1, 1, 1] }),
    ]);
    expect(checks.map((c) => [c.keystone, c.targetGains, c.lowest, c.lowestAt, c.pass])).toEqual([
      ['steadyAim', [4, 6], 0, 30, true],
      ['overload', [7], 7, 0, false],
      ['pandemic', [], -1, 30, false],
    ]);
  });

  it('parses Might levels as lists and stepped ranges', () => {
    expect(parseLevels('0,15')).toEqual([0, 15]);
    expect(parseLevels('0-30:10,45')).toEqual([0, 10, 20, 30, 45]);
    expect(parseLevels('3-5')).toEqual([3, 4, 5]);
    for (const bad of ['x', '-1', '5-3', '0-10:0']) expect(() => parseLevels(bad)).toThrow();
  });

  it('measures each keystone against the same runs without it', () => {
    const values = measureKeystones(data, {
      seeds: [1],
      startWave: 8,
      might: [0],
      sectors: ['crit'],
      gamble: true,
    });
    expect(values.map((v) => v.keystone)).toEqual(['steadyAim', GAMBLE_KEYSTONE]);
    expect(values[1]?.without).toBe(values[0]?.without);
    expect(keystoneReport(values)).toMatch(/\ncrit\s+steadyAim\s+0\s/);
  });
});

describe('keystone identity', () => {
  const beeline = (own: number[], ...others: number[][]): BeelineValue => ({
    sector: 'dot',
    might: 0,
    own,
    ownNodes: 13,
    beelines: others.map((waves, i) => ({ keystone: `k${i}`, nodes: 14, waves })),
  });

  it('compares the own keystone with the best beeline', () => {
    expect(ownMargin(beeline([21, 21, 22], [20, 20, 20], [23, 24, 24]))).toBe(-3);
    expect(ownMargin(beeline([25], [20], [22]))).toBe(3);
  });

  it('measures the own build and a beeline into each other keystone', () => {
    const values = measureBeelines(data, {
      seeds: [1],
      startWave: 8,
      might: [0],
      sectors: ['chain'],
    });
    expect(values).toHaveLength(1);
    expect(values[0]?.beelines.map((b) => b.keystone)).toEqual(['steadyAim', 'pandemic']);
    expect(values[0]?.ownNodes).toBe(13);
    expect(values[0]?.beelines.map((b) => b.nodes)).toEqual([14, 14]);
    expect(beelineReport(values)).toMatch(/\nchain\s+0\s+\d+ \(13\)\s+steadyAim \d+ \(14\)/);
  });
});
