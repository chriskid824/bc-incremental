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
import type { RuleSpec } from './rules';
import type { TalentNode } from './types';

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
  readonly shardCostFactor?: number;
  readonly coreCost?: number;
  readonly repeat?: TalentNode['repeat'];
}

/** Fills the boilerplate fields: kind defaults to small, keys follow talent.<id>.name/desc. */
function node(id: string, spec: NodeSpec): TalentNode {
  const kind = spec.kind ?? 'small';
  const withDesc = (spec.rules?.length ?? 0) > 0;
  return {
    id,
    kind,
    pos: spec.pos,
    links: spec.links,
    ...(spec.shardCostFactor === undefined ? {} : { shardCostFactor: spec.shardCostFactor }),
    ...(spec.coreCost === undefined ? {} : { coreCost: spec.coreCost }),
    ...(spec.repeat === undefined ? {} : { repeat: spec.repeat }),
    modifiers: spec.modifiers ?? [],
    rules: spec.rules ?? [],
    archetype: spec.archetype,
    nameKey: `talent.${id}.name`,
    ...(withDesc ? { descKey: `talent.${id}.desc` } : {}),
  };
}

const NOTABLE = { kind: 'notable', shardCostFactor: 2, coreCost: 1 } as const;
const NOTABLE_2 = { kind: 'notable', shardCostFactor: 3, coreCost: 2 } as const;
const KEYSTONE = { kind: 'keystone', shardCostFactor: 3, coreCost: 3 } as const;

const flat = (stat: Modifier['stat'], value: number): Modifier => ({ stat, kind: 'flat', value });
const inc = (stat: Modifier['stat'], value: number): Modifier => ({
  stat,
  kind: 'increased',
  value,
});
const dmg = (value: number, tag?: 'crit' | 'burn' | 'chain'): Modifier =>
  tag === undefined
    ? { stat: 'damage', kind: 'increased', value }
    : { stat: 'damage', kind: 'increased', value, tags: [tag] };
const moreDmg = (value: number, tag?: 'crit' | 'burn' | 'chain'): Modifier =>
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

  // Generic twigs next to the start.
  node('might', {
    kind: 'repeatable',
    pos: at(DOT_CHAIN, 120),
    links: ['start', 'glassCannon'],
    repeat: { baseShards: 3500, growth: 1.1 },
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
    modifiers: [inc('attackSpeed', 0.1)],
    archetype: 'none',
  }),
  node('swiftness2', {
    pos: at(CRIT_DOT, 240),
    links: ['swiftness'],
    modifiers: [inc('attackSpeed', 0.1)],
    archetype: 'none',
  }),
  node('vitality', {
    pos: at(CHAIN_CRIT, 120),
    links: ['start', 'vitality2'],
    modifiers: [flat('maxLife', 25)],
    archetype: 'none',
  }),
  node('vitality2', {
    pos: at(CHAIN_CRIT, 240),
    links: ['vitality'],
    modifiers: [flat('maxLife', 25)],
    archetype: 'none',
  }),

  // Crit sector (up): big hits, more projectiles, a fixed crit rhythm.
  node('keenEye', {
    pos: at(CRIT, 120),
    links: ['start', 'sharpen'],
    modifiers: [flat('critChance', 0.03)],
    archetype: 'crit',
  }),
  node('sharpen', {
    pos: at(CRIT, 240),
    links: ['keenEye', 'quickDraw'],
    modifiers: [flat('critMultiplier', 0.3)],
    archetype: 'crit',
  }),
  node('quickDraw', {
    pos: at(CRIT, 360),
    links: ['sharpen', 'precision', 'emberEdge', 'stormEye'],
    modifiers: [inc('attackSpeed', 0.1)],
    archetype: 'crit',
  }),
  node('precision', {
    ...NOTABLE,
    pos: at(CRIT, 480),
    links: ['quickDraw', 'deadlyAim', 'splitShot'],
    modifiers: [flat('critChance', 0.1), flat('critMultiplier', 1)],
    archetype: 'crit',
  }),
  node('deadlyAim', {
    pos: at(CRIT - 10, 600),
    links: ['precision', 'assassin'],
    modifiers: [flat('critMultiplier', 0.75)],
    archetype: 'crit',
  }),
  node('splitShot', {
    pos: at(CRIT + 10, 600),
    links: ['precision', 'volley'],
    modifiers: [flat('projectileCount', 0.5)],
    archetype: 'crit',
  }),
  node('assassin', {
    pos: at(CRIT - 10, 720),
    links: ['deadlyAim', 'steadyAim'],
    modifiers: [moreDmg(0.6, 'crit')],
    archetype: 'crit',
  }),
  node('volley', {
    ...NOTABLE_2,
    pos: at(CRIT + 10, 720),
    links: ['splitShot', 'steadyAim'],
    modifiers: [flat('projectileCount', 5), inc('attackSpeed', 0.2)],
    archetype: 'crit',
  }),
  node('steadyAim', {
    ...KEYSTONE,
    pos: at(CRIT, 840),
    links: ['assassin', 'volley'],
    modifiers: [moreDmg(2.5, 'crit')],
    rules: [{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5 }],
    archetype: 'crit',
  }),

  // DoT sector (lower right): ignite, stacking burns, burns that spread.
  node('kindling', {
    pos: at(DOT, 120),
    links: ['start', 'fuel'],
    modifiers: [flat('igniteChance', 0.4)],
    archetype: 'dot',
  }),
  node('fuel', {
    pos: at(DOT, 240),
    links: ['kindling', 'slowBurn'],
    modifiers: [dmg(0.6, 'burn')],
    archetype: 'dot',
  }),
  node('slowBurn', {
    pos: at(DOT, 360),
    links: ['fuel', 'inferno', 'emberEdge', 'staticHeat'],
    modifiers: [flat('burnDuration', 1)],
    archetype: 'dot',
  }),
  node('inferno', {
    ...NOTABLE,
    pos: at(DOT, 480),
    links: ['slowBurn', 'stoke', 'scorch'],
    modifiers: [flat('igniteChance', 0.3), moreDmg(1.2, 'burn')],
    archetype: 'dot',
  }),
  node('stoke', {
    pos: at(DOT - 10, 600),
    links: ['inferno', 'heat'],
    modifiers: [flat('burnMaxStacks', 2), inc('attackSpeed', 0.4)],
    archetype: 'dot',
  }),
  node('scorch', {
    pos: at(DOT + 10, 600),
    links: ['inferno', 'wildfire'],
    modifiers: [flat('burnDamage', 0.15)],
    archetype: 'dot',
  }),
  node('heat', {
    pos: at(DOT - 10, 720),
    links: ['stoke', 'pandemic'],
    modifiers: [dmg(0.3, 'burn')],
    archetype: 'dot',
  }),
  node('wildfire', {
    ...NOTABLE_2,
    pos: at(DOT + 10, 720),
    links: ['scorch', 'pandemic'],
    modifiers: [flat('igniteChance', 0.25), flat('burnDamage', 0.2), moreDmg(0.5, 'burn')],
    archetype: 'dot',
  }),
  node('pandemic', {
    ...KEYSTONE,
    pos: at(DOT, 840),
    links: ['heat', 'wildfire'],
    rules: [{ id: 'pandemic', spreadRadius: 250, spreadEffect: 0.5, hitMore: -0.3 }],
    archetype: 'dot',
  }),

  // Chain sector (lower left): more jumps, better retention, longer arcs.
  node('spark', {
    pos: at(CHAIN, 120),
    links: ['start', 'conductor'],
    modifiers: [flat('chainCount', 1)],
    archetype: 'chain',
  }),
  node('conductor', {
    pos: at(CHAIN, 240),
    links: ['spark', 'charge'],
    modifiers: [flat('chainRetention', 0.1)],
    archetype: 'chain',
  }),
  node('charge', {
    pos: at(CHAIN, 360),
    links: ['conductor', 'arcStorm', 'staticHeat', 'stormEye'],
    modifiers: [dmg(0.3, 'chain')],
    archetype: 'chain',
  }),
  node('arcStorm', {
    ...NOTABLE,
    pos: at(CHAIN, 480),
    links: ['charge', 'reach', 'fork'],
    modifiers: [flat('chainCount', 1), flat('chainRetention', 0.1), moreDmg(0.5)],
    archetype: 'chain',
  }),
  node('reach', {
    pos: at(CHAIN - 10, 600),
    links: ['arcStorm', 'voltage'],
    modifiers: [flat('chainRange', 60)],
    archetype: 'chain',
  }),
  node('fork', {
    pos: at(CHAIN + 10, 600),
    links: ['arcStorm', 'tempest'],
    modifiers: [flat('chainCount', 1)],
    archetype: 'chain',
  }),
  node('voltage', {
    pos: at(CHAIN - 10, 720),
    links: ['reach', 'overload'],
    modifiers: [dmg(0.3, 'chain')],
    archetype: 'chain',
  }),
  node('tempest', {
    ...NOTABLE_2,
    pos: at(CHAIN + 10, 720),
    links: ['fork', 'overload'],
    modifiers: [flat('chainCount', 1), moreDmg(2.2)],
    archetype: 'chain',
  }),
  node('overload', {
    ...KEYSTONE,
    pos: at(CHAIN, 840),
    links: ['voltage', 'tempest'],
    rules: [{ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.15 }],
    archetype: 'chain',
  }),

  // Bridge crit × burn (upper right).
  node('emberEdge', {
    pos: at(CRIT_DOT, 420),
    links: ['quickDraw', 'slowBurn', 'cinder'],
    modifiers: [flat('critChance', 0.02), flat('igniteChance', 0.05)],
    archetype: 'hybrid',
  }),
  node('cinder', {
    pos: at(CRIT_DOT, 540),
    links: ['emberEdge', 'flashpoint'],
    modifiers: [dmg(0.15), flat('maxLife', 15)],
    archetype: 'hybrid',
  }),
  node('flashpoint', {
    ...NOTABLE,
    pos: at(CRIT_DOT, 660),
    links: ['cinder', 'searingCrits'],
    modifiers: [flat('critMultiplier', 0.3)],
    rules: [{ id: 'critIgniteChance', chance: 0.3 }],
    archetype: 'hybrid',
  }),
  node('searingCrits', {
    ...KEYSTONE,
    pos: at(CRIT_DOT, 780),
    links: ['flashpoint'],
    rules: [{ id: 'critsAlwaysIgnite', nonCritHitMore: -0.5 }],
    archetype: 'hybrid',
  }),

  // Bridge burn × chain (bottom).
  node('staticHeat', {
    pos: at(DOT_CHAIN, 420),
    links: ['slowBurn', 'charge', 'arcFlame'],
    modifiers: [flat('chainCount', 0.25), flat('igniteChance', 0.05)],
    archetype: 'hybrid',
  }),
  node('arcFlame', {
    pos: at(DOT_CHAIN, 540),
    links: ['staticHeat', 'conduction'],
    modifiers: [dmg(0.15), flat('maxLife', 15)],
    archetype: 'hybrid',
  }),
  node('conduction', {
    ...NOTABLE,
    pos: at(DOT_CHAIN, 660),
    links: ['arcFlame'],
    modifiers: [dmg(0.2, 'burn')],
    rules: [{ id: 'chainIgniteChance', chance: 0.25 }],
    archetype: 'hybrid',
  }),

  // Bridge chain × crit (upper left).
  node('stormEye', {
    pos: at(CHAIN_CRIT, 420),
    links: ['charge', 'quickDraw', 'thunderclap'],
    modifiers: [flat('critChance', 0.02), flat('chainRetention', 0.03)],
    archetype: 'hybrid',
  }),
  node('thunderclap', {
    pos: at(CHAIN_CRIT, 540),
    links: ['stormEye', 'staticFocus'],
    modifiers: [dmg(0.15), flat('maxLife', 15)],
    archetype: 'hybrid',
  }),
  node('staticFocus', {
    ...NOTABLE,
    pos: at(CHAIN_CRIT, 660),
    links: ['thunderclap'],
    modifiers: [flat('chainCount', 0.5)],
    rules: [{ id: 'chainCritChance', perJump: 0.1 }],
    archetype: 'hybrid',
  }),
];
