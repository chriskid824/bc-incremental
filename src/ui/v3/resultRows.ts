/**
 * The v3 result card's rows (src/ui/v3/result.ts), label then value. DOM-free, so the tests reach
 * it.
 */

import { formatNum } from '../../core/format';
import { gt, num, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import { t } from '../../i18n';

/** What the rows read of the result screen's V3ResultInfo. */
export interface ResultRowFacts {
  readonly highestWave: number;
  readonly bestWave: number;
  readonly startWave: number;
  readonly clearedStartWave: boolean;
  readonly kills: number;
  readonly averageDps: Num;
  readonly damageTaken: number;
  readonly shardsFromRun: Num;
  /** 利息 (gd:501): the run's interest pool, credited to the wallet beside its shards (E17). */
  readonly interestFromRun: Num;
  readonly coresFromRun: number;
  readonly skipShards: Num;
  readonly skipCores: number;
  /** The wallet's shards after the run, its interest included. */
  readonly walletShards: Num;
}

const FORMAT = { format: 'short' } as const;

/**
 * The rows: 利息 (E17) only when the run's interest pool is above 0, after the run's shards; the
 * wallet line is the wallet after the settlement, which holds the interest too.
 */
export function resultRows(info: ResultRowFacts): readonly (readonly [string, string])[] {
  const rows: (readonly [string, string])[] = [];
  const row = (label: string, value: string): void => {
    rows.push([label, value]);
  };
  row(t('result.highestWave'), String(info.highestWave));
  row(t('v3.result.bestWave'), String(info.bestWave));
  row(t('result.startWave'), String(info.startWave));
  row(t('result.kills'), String(info.kills));
  row(t('result.averageDps'), formatNum(info.averageDps, FORMAT));
  row(t('result.damageTaken'), formatNum(num(info.damageTaken), FORMAT));
  row(t('result.shardsFromRun'), formatNum(info.shardsFromRun, FORMAT));
  if (gt(info.interestFromRun, ZERO)) {
    row(t('v3.result.interest'), formatNum(info.interestFromRun, FORMAT));
  }
  row(t('result.coresFromRun'), String(info.coresFromRun));
  let skip: string;
  if (info.startWave <= 1) skip = t('result.skipNone');
  else if (!info.clearedStartWave) skip = t('result.skipNotCleared');
  else {
    skip = t('result.skipValue', {
      shards: formatNum(info.skipShards, FORMAT),
      cores: info.skipCores,
    });
  }
  row(t('result.skipCompensation'), skip);
  row(t('v3.result.wallet'), formatNum(info.walletShards, FORMAT));
  return rows;
}
