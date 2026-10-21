import { describe, expect, it } from 'vitest';
import { CHAIN_HIT_CAP } from '../../src/sim/caps';
import type { TestModule } from '../../src/sim/rules';
import { runSummonFuzzCase, summonFuzzBuilds, summonFuzzName } from '../../src/sim/testing';
import { fuzzReport, fuzzSummons } from './fuzzSummons';

describe('fuzzSummons', () => {
  it('runs every build from waves 1 and 30, twice, and passes clean builds', () => {
    const cases = fuzzSummons(2, 1);
    expect(cases.map((c) => [c.build.index, c.startWave])).toEqual([
      [0, 1],
      [0, 30],
      [1, 1],
      [1, 30],
    ]);
    expect(cases.flatMap((c) => c.runs.map((run) => run.ticks))).toEqual(Array(8).fill(60));
    const report = fuzzReport(cases, 1, 0.5);
    expect(report.ok).toBe(true);
    expect(report.lines.slice(0, 3)).toEqual([
      'summon fuzz: 2 builds (seed 1028) × start waves 1 and 30 × 1 s (60 ticks), each run twice',
      'runs 8, ticks 480, wall 0.5 s',
      'failures: NaN/Infinity 0, hash mismatches 0, caps 0, layout 0, threw 0',
    ]);
    expect(report.lines.at(-1)).toBe('summon fuzz passed');
  });

  it('fails on any failure and names its build, seed and start wave', () => {
    const [build] = summonFuzzBuilds(1);
    if (build === undefined) throw new Error('no build');
    const peak: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        if (ctx.now === 10) ctx.counters.chainHitsPeak = CHAIN_HIT_CAP + 1;
      });
    const report = fuzzReport([runSummonFuzzCase(build, 30, 60, () => [peak])], 1, 0.5);
    const name = `${summonFuzzName(build)} from wave 30`;
    expect(name).toBe(`build 0 (seed ${build.seed}, swarm) from wave 30`);
    expect(report.ok).toBe(false);
    expect(report.lines[2]).toBe(
      'failures: NaN/Infinity 0, hash mismatches 0, caps 2, layout 0, threw 0',
    );
    expect(report.lines.slice(-3)).toEqual([
      `FAIL cap: ${name}, run 1: tick 10: chainHitsPeak 33, past CHAIN_HIT_CAP`,
      `FAIL cap: ${name}, run 2: tick 10: chainHitsPeak 33, past CHAIN_HIT_CAP`,
      `summon fuzz FAILED: 2 failures in 1 cases: ${name}`,
    ]);
  });
});
