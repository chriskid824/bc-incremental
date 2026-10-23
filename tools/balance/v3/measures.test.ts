import { describe, expect, it } from 'vitest';
import type { FusionKey } from '../../../src/data/web';
import { DEFAULT_WEB_ECONOMY } from '../../../src/meta/web';
import { auditStart } from '../../../src/meta/web/invest';
import { runJob, runJobs } from '../jobs';
import type { BalanceJob } from '../jobs';
import { FRESH_ACCOUNT } from './checks/types';
import { webOf } from './content';
import { measureKeystone, measureStrength, runMeasure } from './measures';
import type { KeystoneInput } from './measures';

type MeasureJob = Extract<BalanceJob, { kind: 'measure' }>;

const B1 = { fixture: 'B1' } as const;
const B5 = { fixture: 'B5' } as const;

const star: KeystoneInput = {
  content: B1,
  character: 'fire',
  star: 'fire.center.main.star-one',
  snapshot: auditStart(webOf(B1, 'fire', 'full'), false),
  account: FRESH_ACCOUNT,
  economy: DEFAULT_WEB_ECONOMY,
  seed: 0,
};
const keystone = (seed: number): MeasureJob => ({
  kind: 'measure',
  measure: 'keystone',
  input: { ...star, seed },
});
const strength = (seed: number): MeasureJob => ({
  kind: 'measure',
  measure: 'fusionStrength',
  input: { content: B5, key: 'fire.crit', coef: 0.5, seed },
});

describe('measure jobs', () => {
  it('runs each measure through runJob, its input and its reading plain data', () => {
    for (const job of [keystone(0), strength(0)]) {
      const result = runJob(job);
      expect(result).toMatchObject({ kind: 'measure', measure: job.measure });
      expect(result.result).toEqual(runMeasure(job.measure, job.input));
      expect(JSON.parse(JSON.stringify(job))).toStrictEqual(job);
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
    }
  });

  it('reads the same on two workers as in-process, in job order', async () => {
    const jobs = [keystone(0), strength(0), keystone(1), strength(1)];
    const inProcess = await runJobs(jobs, 1);
    const workers = await runJobs(jobs, 2);
    expect([inProcess.mode, workers.mode]).toEqual(['in-process', 'workers']);
    expect(workers.results).toEqual(inProcess.results);
  }, 30_000);

  it('refuses a ★ or a fusion core the web does not have', () => {
    expect(() => measureKeystone({ ...star, star: 'fire.center.main.nope' })).toThrow(
      "keystone 'fire.center.main.nope': no such ★ in fire's web",
    );
    expect(() => measureKeystone({ ...star, star: 'fire.center.alpha.alpha-one' })).toThrow(
      /no such ★/,
    );
    expect(() =>
      measureStrength({ content: B5, key: 'fire.nope' as FusionKey, coef: 1, seed: 0 }),
    ).toThrow("fusionStrength 'fire.nope': no such fusion core in the web");
  });
});
