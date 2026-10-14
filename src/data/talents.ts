/**
 * Talent web v1 for the M1 prototype (docs/GDD.md §4, §9): about 40 nodes.
 *
 * Layout: start at the origin; one 120° sector per archetype (crit up, dot lower right,
 * chain lower left), each a spine of three small nodes into a notable, a fork, a second
 * notable and a keystone. Bridge groups between the sectors hold the cross-archetype nodes;
 * short generic twigs (attack speed, life, the repeatable node, glassCannon) sit next to the
 * start. y grows downward; positions are in talent-web units.
 */

import type { Modifier } from './stats';
import type { DamageTag } from './tags';
import type { RuleSpec } from './rules';
import type { TriggerSpec } from './triggers';
import type { TalentNode } from './types';
import { needsDescKey } from './validate';

/** Position at `angle` degrees (0 = right, −90 = up) and `radius` from the start node. */
function at(angle: number, radius: number): { x: number; y: number } {
  const rad = (angle * Math.PI) / 180;
  return { x: Math.round(Math.cos(rad) * radius), y: Math.round(Math.sin(rad) * radius) };
}

type Archetype = TalentNode['archetype'];

interface NodeSpec {
  readonly kind?: TalentNode['kind'];
  readonly pos: { x: number; y: number };
  readonly links: readonly string[];
  readonly archetype: Archetype;
  readonly modifiers?: readonly Modifier[];
  readonly rules?: readonly RuleSpec[];
  readonly triggers?: readonly TriggerSpec[];
  readonly shardCostFactor?: number;
  readonly coreCost?: number;
  readonly repeat?: TalentNode['repeat'];
}

/**
 * Fills the boilerplate fields: kind defaults to small, the lists to empty, keys follow
 * talent.<id>.name/desc, and a node with rules, triggers or behaviour modifiers gets its desc
 * key (needsDescKey).
 */
function node(id: string, spec: NodeSpec): TalentNode {
  const kind = spec.kind ?? 'small';
  const lists = {
    modifiers: spec.modifiers ?? [],
    rules: spec.rules ?? [],
    triggers: spec.triggers ?? [],
    conversions: [],
  };
  return {
    id,
    kind,
    pos: spec.pos,
    links: spec.links,
    ...(spec.shardCostFactor === undefined ? {} : { shardCostFactor: spec.shardCostFactor }),
    ...(spec.coreCost === undefined ? {} : { coreCost: spec.coreCost }),
    ...(spec.repeat === undefined ? {} : { repeat: spec.repeat }),
    ...lists,
    archetype: spec.archetype,
    nameKey: `talent.${id}.name`,
    ...(needsDescKey(lists) ? { descKey: `talent.${id}.desc` } : {}),
  };
}

/**
 * Price tiers (docs/GDD.md §4.2): a node costs talentBaseShards × talentGrowth^n × factor.
 * Bridge nodes override the factor (small 1.5, notables 6, searingCrits 8) so a build
 * finishes its own sector before the bridges, which stay a mid-game goal. The archetype
 * keystones override it too (steadyAim 3, overload 3.5, pandemic 2.5): they carry most of their
 * sector's late "more" damage, so they come about one sector node earlier than a factor of 4.
 */
const NOTABLE = { kind: 'notable', shardCostFactor: 2, coreCost: 1 } as const;
const NOTABLE_2 = { kind: 'notable', shardCostFactor: 3, coreCost: 2 } as const;
const KEYSTONE = { kind: 'keystone', shardCostFactor: 4, coreCost: 3 } as const;

const flat = (stat: Modifier['stat'], value: number): Modifier => ({ stat, kind: 'flat', value });
const inc = (stat: Modifier['stat'], value: number): Modifier => ({
  stat,
  kind: 'increased',
  value,
});
const more = (stat: Modifier['stat'], value: number): Modifier => ({ stat, kind: 'more', value });
const dmg = (value: number, tag?: 'crit' | 'burn' | 'chain'): Modifier =>
  tag === undefined
    ? { stat: 'damage', kind: 'increased', value }
    : { stat: 'damage', kind: 'increased', value, tags: [tag] };
const moreDmg = (value: number, tag?: DamageTag): Modifier =>
  tag === undefined
    ? { stat: 'damage', kind: 'more', value }
    : { stat: 'damage', kind: 'more', value, tags: [tag] };

const CRIT = -90;
const DOT = 30;
const CHAIN = 150;
const CRIT_DOT = -30;
const DOT_CHAIN = 90;
const CHAIN_CRIT = 210;

export const TALENTS: readonly TalentNode[] = [
  node('start', {
    kind: 'start',
    pos: { x: 0, y: 0 },
    links: ['keenEye', 'kindling', 'spark', 'might', 'swiftness', 'vitality'],
    archetype: 'none',
  }),

  // Generic twigs next to the start. Might's first rank fits in the first two or three runs;
  // its ×1.4 price per rank keeps it a sink for spare shards, not the main engine.
  node('might', {
    kind: 'repeatable',
    pos: at(DOT_CHAIN, 120),
    links: ['start', 'glassCannon'],
    repeat: { baseShards: 300, growth: 1.4 },
    modifiers: [{ stat: 'damage', kind: 'more', value: 0.1 }],
    archetype: 'none',
  }),
  node('glassCannon', {
    ...KEYSTONE,
    pos: at(DOT_CHAIN, 240),
    links: ['might'],
    rules: [{ id: 'glassCannon', damageMore: 1 }],
    archetype: 'none',
  }),
  node('swiftness', {
    pos: at(CRIT_DOT, 120),
    links: ['start', 'swiftness2'],
    modifiers: [inc('attackSpeed', 0.3)],
    archetype: 'none',
  }),
  node('swiftness2', {
    pos: at(CRIT_DOT, 240),
    links: ['swiftness'],
    modifiers: [inc('attackSpeed', 0.3)],
    archetype: 'none',
  }),
  node('vitality', {
    pos: at(CHAIN_CRIT, 120),
    links: ['start', 'vitality2'],
    modifiers: [flat('maxLife', 50), dmg(0.3)],
    archetype: 'none',
  }),
  node('vitality2', {
    pos: at(CHAIN_CRIT, 240),
    links: ['vitality'],
    modifiers: [flat('maxLife', 50), dmg(0.3)],
    archetype: 'none',
  }),

  // Crit sector (up): big hits, more projectiles, a fixed crit rhythm.
  node('keenEye', {
    pos: at(CRIT, 120),
    links: ['start', 'sharpen'],
    modifiers: [flat('critChance', 0.1), flat('critMultiplier', 0.5), dmg(0.25)],
    archetype: 'crit',
  }),
  node('sharpen', {
    pos: at(CRIT, 240),
    links: ['keenEye', 'quickDraw'],
    modifiers: [flat('critMultiplier', 0.8), dmg(0.25)],
    archetype: 'crit',
  }),
  node('quickDraw', {
    pos: at(CRIT, 360),
    links: ['sharpen', 'precision', 'emberEdge', 'stormEye'],
    modifiers: [inc('attackSpeed', 0.4), flat('critChance', 0.05)],
    archetype: 'crit',
  }),
  node('precision', {
    ...NOTABLE,
    pos: at(CRIT, 480),
    links: ['quickDraw', 'deadlyAim', 'splitShot'],
    modifiers: [flat('critChance', 0.15), flat('critMultiplier', 1), moreDmg(0.4, 'crit')],
    archetype: 'crit',
  }),
  node('deadlyAim', {
    pos: at(CRIT - 10, 600),
    links: ['precision', 'assassin'],
    modifiers: [flat('critMultiplier', 1.5)],
    archetype: 'crit',
  }),
  node('splitShot', {
    pos: at(CRIT + 10, 600),
    links: ['precision', 'volley'],
    modifiers: [flat('projectileCount', 1)],
    archetype: 'crit',
  }),
  node('assassin', {
    pos: at(CRIT - 10, 720),
    links: ['deadlyAim', 'steadyAim'],
    modifiers: [moreDmg(0.3, 'crit')],
    archetype: 'crit',
  }),
  node('volley', {
    ...NOTABLE_2,
    pos: at(CRIT + 10, 720),
    links: ['splitShot', 'steadyAim'],
    modifiers: [flat('projectileCount', 2)],
    archetype: 'crit',
  }),
  node('steadyAim', {
    ...KEYSTONE,
    pos: at(CRIT, 840),
    links: ['assassin', 'volley'],
    // The crit sector's last big multiplier lives here, not on assassin and volley (§4.2).
    shardCostFactor: 3,
    modifiers: [moreDmg(1.2, 'crit'), more('attackSpeed', 0.25)],
    rules: [{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'shot' }],
    archetype: 'crit',
  }),

  // DoT sector (lower right): ignite, stacking burns, burns that spread.
  node('kindling', {
    pos: at(DOT, 120),
    links: ['start', 'fuel'],
    modifiers: [flat('igniteChance', 0.35), inc('attackSpeed', 0.3)],
    archetype: 'dot',
  }),
  node('fuel', {
    pos: at(DOT, 240),
    links: ['kindling', 'slowBurn'],
    modifiers: [dmg(1, 'burn')],
    archetype: 'dot',
  }),
  node('slowBurn', {
    pos: at(DOT, 360),
    links: ['fuel', 'inferno', 'emberEdge', 'staticHeat'],
    modifiers: [flat('burnDuration', 0.4), flat('igniteChance', 0.2)],
    archetype: 'dot',
  }),
  node('inferno', {
    ...NOTABLE,
    pos: at(DOT, 480),
    links: ['slowBurn', 'stoke', 'scorch'],
    modifiers: [flat('igniteChance', 0.25), moreDmg(0.7, 'burn')],
    archetype: 'dot',
  }),
  node('stoke', {
    pos: at(DOT - 10, 600),
    links: ['inferno', 'heat'],
    modifiers: [flat('burnMaxStacks', 3), inc('attackSpeed', 0.6)],
    archetype: 'dot',
  }),
  node('scorch', {
    pos: at(DOT + 10, 600),
    links: ['inferno', 'wildfire'],
    modifiers: [flat('burnDamage', 0.6)],
    archetype: 'dot',
  }),
  node('heat', {
    pos: at(DOT - 10, 720),
    links: ['stoke', 'pandemic'],
    modifiers: [dmg(0.7, 'burn')],
    archetype: 'dot',
  }),
  node('wildfire', {
    ...NOTABLE_2,
    pos: at(DOT + 10, 720),
    links: ['scorch', 'pandemic'],
    modifiers: [flat('igniteChance', 0.25), flat('burnDamage', 0.5)],
    archetype: 'dot',
  }),
  node('pandemic', {
    ...KEYSTONE,
    pos: at(DOT, 840),
    links: ['heat', 'wildfire'],
    // Cheaper than the other keystones: it adds no damage of its own (hit damage −30%) until
    // burns spread, and spreading needs a burn on the dying enemy.
    shardCostFactor: 2.5,
    rules: [{ id: 'pandemic', spreadRadius: 250, spreadEffect: 0.4, hitMore: -0.3 }],
    archetype: 'dot',
  }),

  // Chain sector (lower left): more jumps, better retention, longer arcs.
  node('spark', {
    pos: at(CHAIN, 120),
    links: ['start', 'conductor'],
    modifiers: [flat('chainCount', 0.4), dmg(0.25)],
    archetype: 'chain',
  }),
  node('conductor', {
    pos: at(CHAIN, 240),
    links: ['spark', 'charge'],
    modifiers: [flat('chainRetention', 0.1), flat('chainCount', 0.3)],
    archetype: 'chain',
  }),
  node('charge', {
    pos: at(CHAIN, 360),
    links: ['conductor', 'arcStorm', 'staticHeat', 'stormEye'],
    modifiers: [dmg(0.5, 'chain'), dmg(0.25)],
    archetype: 'chain',
  }),
  node('arcStorm', {
    ...NOTABLE,
    pos: at(CHAIN, 480),
    links: ['charge', 'reach', 'fork'],
    modifiers: [flat('chainCount', 0.7), flat('chainRetention', 0.05), moreDmg(0.5)],
    archetype: 'chain',
  }),
  node('reach', {
    pos: at(CHAIN - 10, 600),
    links: ['arcStorm', 'voltage'],
    modifiers: [flat('chainRange', 60), dmg(0.4, 'chain')],
    archetype: 'chain',
  }),
  node('fork', {
    pos: at(CHAIN + 10, 600),
    links: ['arcStorm', 'tempest'],
    modifiers: [flat('chainCount', 0.6)],
    archetype: 'chain',
  }),
  node('voltage', {
    pos: at(CHAIN - 10, 720),
    links: ['reach', 'overload'],
    modifiers: [dmg(0.4, 'chain')],
    archetype: 'chain',
  }),
  node('tempest', {
    ...NOTABLE_2,
    pos: at(CHAIN + 10, 720),
    links: ['fork', 'overload'],
    modifiers: [flat('chainCount', 0.6)],
    archetype: 'chain',
  }),
  node('overload', {
    ...KEYSTONE,
    pos: at(CHAIN, 840),
    links: ['voltage', 'tempest'],
    // ×4.5 hit damage pays for the retention penalty; the doubled jumps alone run away late
    // (§9.1). Hits only, so it does not multiply burns: a burn build should not reach for it.
    shardCostFactor: 3.5,
    modifiers: [moreDmg(3.5, 'hit')],
    rules: [{ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2 }],
    archetype: 'chain',
  }),

  // Bridge crit × burn (upper right).
  node('emberEdge', {
    pos: at(CRIT_DOT, 420),
    links: ['quickDraw', 'slowBurn', 'cinder'],
    shardCostFactor: 1.5,
    modifiers: [flat('critChance', 0.05), flat('igniteChance', 0.1), dmg(0.3)],
    archetype: 'hybrid',
  }),
  node('cinder', {
    pos: at(CRIT_DOT, 540),
    links: ['emberEdge', 'flashpoint'],
    shardCostFactor: 1.5,
    modifiers: [dmg(0.4), flat('maxLife', 30)],
    archetype: 'hybrid',
  }),
  node('flashpoint', {
    ...NOTABLE,
    pos: at(CRIT_DOT, 660),
    links: ['cinder', 'searingCrits'],
    shardCostFactor: 6,
    modifiers: [
      flat('critMultiplier', 0.5),
      moreDmg(0.4),
      { stat: 'igniteChance', kind: 'flat', value: 0.3, tags: ['crit'] },
    ],
    archetype: 'hybrid',
  }),
  // Crits ignite whatever the ignite roll (which is still drawn); non-crit hits deal half.
  node('searingCrits', {
    ...KEYSTONE,
    pos: at(CRIT_DOT, 780),
    links: ['flashpoint'],
    shardCostFactor: 8,
    modifiers: [
      { stat: 'igniteAlways', kind: 'flat', value: 1, tags: ['crit'] },
      { stat: 'damage', kind: 'more', value: -0.5, tags: ['hit'], notTags: ['crit'] },
    ],
    archetype: 'hybrid',
  }),

  // Bridge burn × chain (bottom).
  node('staticHeat', {
    pos: at(DOT_CHAIN, 420),
    links: ['slowBurn', 'charge', 'arcFlame'],
    shardCostFactor: 1.5,
    modifiers: [flat('chainCount', 0.3), flat('igniteChance', 0.1), dmg(0.3)],
    archetype: 'hybrid',
  }),
  node('arcFlame', {
    pos: at(DOT_CHAIN, 540),
    links: ['staticHeat', 'conduction'],
    shardCostFactor: 1.5,
    modifiers: [dmg(0.4), flat('maxLife', 30)],
    archetype: 'hybrid',
  }),
  node('conduction', {
    ...NOTABLE,
    pos: at(DOT_CHAIN, 660),
    links: ['arcFlame'],
    shardCostFactor: 6,
    modifiers: [
      dmg(0.4, 'burn'),
      moreDmg(0.3),
      { stat: 'igniteChance', kind: 'flat', value: 0.25, tags: ['chain'] },
    ],
    archetype: 'hybrid',
  }),

  // Bridge chain × crit (upper left).
  node('stormEye', {
    pos: at(CHAIN_CRIT, 420),
    links: ['charge', 'quickDraw', 'thunderclap'],
    shardCostFactor: 1.5,
    modifiers: [flat('critChance', 0.05), flat('chainRetention', 0.05), dmg(0.3)],
    archetype: 'hybrid',
  }),
  node('thunderclap', {
    pos: at(CHAIN_CRIT, 540),
    links: ['stormEye', 'staticFocus'],
    shardCostFactor: 1.5,
    modifiers: [dmg(0.4), flat('maxLife', 30)],
    archetype: 'hybrid',
  }),
  node('staticFocus', {
    ...NOTABLE,
    pos: at(CHAIN_CRIT, 660),
    links: ['thunderclap'],
    shardCostFactor: 6,
    // +10% crit chance per jump so far: the nth jump gets +n × 10%.
    modifiers: [
      flat('chainCount', 0.5),
      moreDmg(0.4),
      { stat: 'critChance', kind: 'flat', value: 0.1, scaling: { per: 'chainJump' } },
    ],
    archetype: 'hybrid',
  }),
];
