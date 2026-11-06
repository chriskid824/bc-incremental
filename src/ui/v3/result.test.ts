/**
 * The v3 result card's rows (resultRows, src/ui/v3/resultRows.ts): 利息 (E17, lead ruling G5)
 * only when the run's interest pool is above 0, after the run's shards, and the wallet line after
 * the settlement, which credits the pool beside the shards.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { num, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import { setLocale } from '../../i18n';
import type { Locale } from '../../i18n';
import { settleUnfinishedRun } from '../../meta/settle';
import { resultRows } from './resultRows';
import type { ResultRowFacts } from './resultRows';

function info(overrides: Partial<ResultRowFacts>): ResultRowFacts {
  return {
    highestWave: 12,
    bestWave: 12,
    startWave: 1,
    clearedStartWave: true,
    kills: 40,
    averageDps: num(120),
    damageTaken: 0,
    shardsFromRun: num(50),
    interestFromRun: ZERO,
    coresFromRun: 1,
    skipShards: ZERO,
    skipCores: 0,
    walletShards: num(150),
    ...overrides,
  };
}

/** The rows of a run settled with `interest` in its pool, from a wallet of 100. */
function settled(interest: Num): readonly (readonly [string, string])[] {
  const wallet = { shards: num(100), cores: 0, maxWave: 0, runs: 0 };
  const settlement = settleUnfinishedRun(wallet, {
    shards: num(50),
    interestShards: interest,
    cores: 1,
    highestWaveReached: 12,
  });
  return resultRows(
    info({
      shardsFromRun: settlement.shardsFromRun,
      interestFromRun: settlement.interestFromRun,
      walletShards: wallet.shards,
    }),
  );
}

describe('resultRows', () => {
  afterEach(() => setLocale('en'));

  it.each([
    ['en', ['Shards from run', '50'], ['Interest', '25.5'], ['Shards held', '176']],
    ['zh-TW', ['本局碎片', '50'], ['利息', '25.5'], ['持有碎片', '176']],
  ] as [Locale, [string, string], [string, string], [string, string]][])(
    'shows the interest after the run’s shards and a wallet that holds it, in %s (E17, G5)',
    (locale, shards, interest, wallet) => {
      // Planted bugs: the interest line missing, or the wallet without the pool.
      setLocale(locale);
      const rows = settled(num(25.5));
      const at = rows.findIndex(([label]) => label === shards[0]);
      expect(rows[at]).toEqual(shards);
      expect(rows[at + 1]).toEqual(interest);
      expect(rows.at(-1)).toEqual(wallet);
    },
  );

  it('shows no interest line when the pool is 0, the rows as before E17', () => {
    // Planted bug: an interest line of 0 on every run without an interest effect.
    const rows = settled(ZERO);
    expect(rows.map(([label]) => label)).toEqual([
      'Highest wave',
      'Best wave',
      'Start wave',
      'Enemies killed',
      'Average DPS',
      'Damage taken',
      'Shards from run',
      'Cores from run',
      'Skip compensation',
      'Shards held',
    ]);
    expect(rows.at(-1)).toEqual(['Shards held', '150']);
  });
});
