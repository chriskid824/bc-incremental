/** Player-facing text for talent modifiers and build stats. */

import type { RuleSpec } from '../data/rules';
import type { DamageTag, Modifier, StatBlock, StatId } from '../data/stats';
import { DAMAGE_TAG_BIT } from '../data/stats';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import { compileRules } from '../sim/rules';

/** Flat values of these stats are fractions shown as percentages (0.05 → 5%). */
const PERCENT_STATS: ReadonlySet<StatId> = new Set([
  'critChance',
  'critMultiplier',
  'igniteChance',
  'burnDamage',
  'chainRetention',
]);

const TAGGED_DAMAGE: Readonly<Record<DamageTag, MessageKey>> = {
  hit: 'stat.damage.hit',
  crit: 'stat.damage.crit',
  burn: 'stat.damage.burn',
  chain: 'stat.damage.chain',
};

function statName(mod: Modifier): string {
  const tag = mod.tags?.[0];
  if (mod.stat === 'damage' && tag !== undefined) return t(TAGGED_DAMAGE[tag]);
  return t(`stat.${mod.stat}` as MessageKey);
}

/** Up to two decimals, trailing zeros dropped. */
function trim(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function signed(text: string, value: number): string {
  return value >= 0 ? `+${text}` : `−${text.replace('-', '')}`;
}

/** One line per modifier, e.g. "+3% crit chance", "20% increased burn damage". */
export function describeModifier(mod: Modifier): string {
  const stat = statName(mod);
  if (mod.kind === 'flat') {
    const value = PERCENT_STATS.has(mod.stat)
      ? `${trim(Math.abs(mod.value) * 100)}%`
      : trim(Math.abs(mod.value));
    return t('mod.flat', { value: signed(value, mod.value), stat });
  }
  const percent = trim(Math.abs(mod.value) * 100);
  if (mod.kind === 'increased') return t('mod.increased', { value: percent, stat });
  return t(mod.value >= 0 ? 'mod.more' : 'mod.less', { value: percent, stat });
}

export interface BuildLine {
  readonly label: string;
  readonly value: string;
}

const pct = (value: number): string => `${trim(value * 100)}%`;

/**
 * The few stats that tell builds apart, for the talent screen's summary. Values are what the
 * simulation plays with once keystone rules apply (src/sim/rules.ts): hit damage is a non-crit
 * primary hit, steadyAim replaces the crit chance with its every-Nth-shot rhythm, and so on.
 */
export function describeBuild(stats: StatBlock, rules: readonly RuleSpec[] = []): BuildLine[] {
  const { values, damageMult } = stats;
  const fx = compileRules(rules);
  const hit =
    values.damage *
    (damageMult[DAMAGE_TAG_BIT.hit] as number) *
    fx.hitMult *
    fx.nonCritHitMult *
    fx.allDamageMult;
  const crit =
    fx.steadyAimEvery > 0
      ? t('build.critEveryNth', { n: fx.steadyAimEvery })
      : pct(Math.min(1, values.critChance));
  return [
    { label: t('stat.damage.hit'), value: trim(hit) },
    { label: t('stat.attackSpeed'), value: `${trim(values.attackSpeed)}/s` },
    { label: t('stat.projectileCount'), value: trim(values.projectileCount) },
    { label: t('stat.critChance'), value: crit },
    { label: t('stat.critMultiplier'), value: pct(values.critMultiplier * fx.critMultiplierMult) },
    { label: t('stat.igniteChance'), value: pct(Math.min(1, values.igniteChance)) },
    {
      label: t('stat.chainCount'),
      value: trim(Math.max(0, values.chainCount * fx.chainCountMult)),
    },
    { label: t('stat.maxLife'), value: trim(fx.maxLife ?? values.maxLife) },
  ];
}
