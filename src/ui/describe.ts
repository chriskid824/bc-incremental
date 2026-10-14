/** Player-facing text for talent modifiers and build stats. */

import { formatNum } from '../core/format';
import { num } from '../core/num';
import type { RuleSpec } from '../data/rules';
import type { Modifier, StatBlock, StatId } from '../data/stats';
import { DAMAGE_TAG_BIT, isBehaviourModifier } from '../data/stats';
import type { DamageTag } from '../data/tags';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import { centerDamage, compileBuild } from '../sim/build/compile';

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
  projectile: 'stat.damage.projectile',
  area: 'stat.damage.area',
  zone: 'stat.damage.zone',
  aura: 'stat.damage.aura',
  orbit: 'stat.damage.orbit',
  strike: 'stat.damage.strike',
  minion: 'stat.damage.minion',
  thorns: 'stat.damage.thorns',
  trigger: 'stat.damage.trigger',
  poison: 'stat.damage.poison',
  bleed: 'stat.damage.bleed',
  cold: 'stat.damage.cold',
  lightning: 'stat.damage.lightning',
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

/**
 * One line per modifier, e.g. "+3% crit chance", "20% increased burn damage"; null for a
 * behaviour modifier (src/data/stats.ts), which its node's descKey text describes.
 */
export function describeModifier(mod: Modifier): string | null {
  if (isBehaviourModifier(mod)) return null;
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
 * simulation plays with once keystone rules apply (src/sim/build/compile.ts and
 * src/sim/systems/): hit damage is a non-crit primary hit, a crit hit is one primary crit, a burn
 * stack is what a non-crit hit ignites, the first chain jump is a non-crit jump, and steadyAim
 * replaces the crit chance with its every-Nth-shot rhythm. Damage reads each instance's damage
 * row, so tagged modifiers (Searing Crits' non-crit half and Pandemic's hit cost included) and
 * rule-added ones (Glass Cannon's) count. Each archetype's nodes move at least one line.
 */
export function describeBuild(stats: StatBlock, rules: readonly RuleSpec[] = []): BuildLine[] {
  const build = compileBuild(stats, rules);
  const { values, flags } = build;
  const multAt = (mask: number): number => centerDamage(build, mask);
  const { hit: HIT, crit: CRIT, burn: BURN, chain: CHAIN } = DAMAGE_TAG_BIT;
  const hit = values.damage * multAt(HIT);
  const critHit = values.damage * values.critMultiplier * multAt(HIT | CRIT);
  const burnPerSecond = values.damage * values.burnDamage * multAt(BURN);
  const retention = Math.min(1, Math.max(0, values.chainRetention));
  const chainJump = values.damage * retention * multAt(HIT | CHAIN);
  const every = build.signature.forceCritEvery;
  const crit =
    every > 0 ? t('build.critEveryNth', { n: every }) : pct(Math.min(1, values.critChance));
  const short = (value: number): string => formatNum(num(value), { format: 'short' });
  return [
    { label: t('stat.damage.hit'), value: short(hit) },
    { label: t('stat.attackSpeed'), value: `${trim(values.attackSpeed)}/s` },
    { label: t('stat.projectileCount'), value: trim(values.projectileCount) },
    { label: t('stat.critChance'), value: crit },
    { label: t('stat.critMultiplier'), value: pct(values.critMultiplier) },
    { label: t('build.critHit'), value: short(critHit) },
    { label: t('stat.igniteChance'), value: pct(Math.min(1, values.igniteChance)) },
    { label: t('build.burnPerStack'), value: `${short(burnPerSecond)}/s` },
    {
      label: t('stat.burnDuration'),
      value: trim(Math.max(0, values.burnDuration)),
    },
    {
      label: t('stat.burnMaxStacks'),
      value: flags.burnRings ? '∞' : String(Math.max(1, Math.floor(values.burnMaxStacks))),
    },
    {
      label: t('stat.chainCount'),
      value: trim(Math.max(0, values.chainCount)),
    },
    { label: t('build.chainJump'), value: short(chainJump) },
    { label: t('stat.maxLife'), value: trim(flags.maxLife ?? values.maxLife) },
  ];
}
