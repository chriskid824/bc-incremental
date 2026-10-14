/**
 * Snapshot of the build estimators behind probe T6 (effectiveHit, attackDamage, crowdDps and
 * buildMultipliers in tools/balance/session.ts) and of the talent screen's build summary
 * (src/ui/describe.ts) for six fixed builds of the real talent web, which between them carry
 * every M1 rule on a talent node (Searing Crits and the bridge notables as modifiers since C3.3,
 * Pandemic as a trigger and a modifier since C3.7). A refactor of how stats, tags and rules
 * compile must keep the numbers within 1e-12 (exactly, in practice) and the summary text
 * unchanged.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../../src/data';
import { setLocale } from '../../src/i18n';
import { collectRules, statBlockFor } from '../../src/meta';
import type { MetaState } from '../../src/meta';
import { describeBuild } from '../../src/ui/describe';
import { sectorBuild } from './builds';
import { attackDamage, buildMultipliers, crowdDps, effectiveHit } from './session';
import type { BuildMultipliers } from './session';

const data = loadGameData();

const BUILDS: Readonly<Record<string, MetaState>> = {
  'crit+steadyAim': sectorBuild(data, 'crit', { keystone: true, might: 5 }),
  'dot+pandemic': sectorBuild(data, 'dot', { keystone: true, might: 5 }),
  'chain+overload': sectorBuild(data, 'chain', { keystone: true, might: 5 }),
  'crit+glassCannon': sectorBuild(data, 'crit', {
    keystone: false,
    might: 3,
    extra: ['glassCannon'],
  }),
  'dot+bridges': sectorBuild(data, 'dot', {
    keystone: false,
    might: 8,
    extra: [
      'emberEdge',
      'cinder',
      'flashpoint',
      'searingCrits',
      'staticHeat',
      'arcFlame',
      'conduction',
    ],
  }),
  'chain+staticFocus': sectorBuild(data, 'chain', {
    keystone: false,
    might: 12,
    extra: ['stormEye', 'thunderclap', 'staticFocus'],
  }),
};

interface Expected {
  readonly rules: readonly string[];
  readonly effectiveHit: number;
  readonly attackDamage: number;
  readonly crowdDps: number;
  readonly multipliers: BuildMultipliers;
  /** describeBuild in English, [label, value]. */
  readonly summary: readonly (readonly [string, string])[];
}

/** Recorded before the C3 damage-engine refactor. */
const EXPECTED: Readonly<Record<string, Expected>> = {
  'crit+steadyAim': {
    rules: ['steadyAim'],
    effectiveHit: 450.05809532068014,
    attackDamage: 450.05809532068014,
    crowdDps: 22502.904766034007,
    multipliers: {
      repeatableMultD: 1.6105100000000008,
      sectorMultD: 14.440402439024387,
      sectorMultAttack: 14.440402439024387,
      sectorMultCrowd: 56.40782202743901,
    },
    summary: [
      ['Hit damage', '33.8'],
      ['Attack speed', '10/s'],
      ['Projectiles', '5'],
      ['Crit chance', 'Every 3 shots'],
      ['Crit multiplier', '795%'],
      ['Crit hit', '1.08K'],
      ['Ignite chance', '10%'],
      ['Burn per stack', '50.7/s'],
      ['Burn duration (s)', '1.2'],
      ['Max burn stacks', '5'],
      ['Chains', '0'],
      ['First chain jump', '23.7'],
      ['Life', '200'],
    ],
  },
  'dot+pandemic': {
    // Pandemic is a trigger and a modifier since C3.7.
    rules: [],
    effectiveHit: 403.73939610400015,
    attackDamage: 403.73939610400015,
    crowdDps: 8074.787922080003,
    multipliers: {
      repeatableMultD: 1.6105100000000008,
      sectorMultD: 12.954237288135591,
      sectorMultAttack: 12.954237288135591,
      sectorMultCrowd: 20.24099576271186,
    },
    summary: [
      ['Hit damage', '18'],
      ['Attack speed', '10/s'],
      ['Projectiles', '2'],
      ['Crit chance', '5%'],
      ['Crit multiplier', '150%'],
      ['Crit hit', '27.1'],
      ['Ignite chance', '100%'],
      ['Burn per stack', '235/s'],
      ['Burn duration (s)', '1.6'],
      ['Max burn stacks', '8'],
      ['Chains', '0'],
      ['First chain jump', '12.6'],
      ['Life', '200'],
    ],
  },
  'chain+overload': {
    rules: ['overload'],
    effectiveHit: 243.3569188050001,
    attackDamage: 886.5252328186608,
    crowdDps: 11347.522980078858,
    multipliers: {
      repeatableMultD: 1.6105100000000006,
      sectorMultD: 7.808262711864406,
      sectorMultAttack: 28.44473028560811,
      sectorMultCrowd: 28.44473028560811,
    },
    summary: [
      ['Hit damage', '228'],
      ['Attack speed', '6.4/s'],
      ['Projectiles', '2'],
      ['Crit chance', '5%'],
      ['Crit multiplier', '150%'],
      ['Crit hit', '342'],
      ['Ignite chance', '10%'],
      ['Burn per stack', '76.1/s'],
      ['Burn duration (s)', '1.2'],
      ['Max burn stacks', '5'],
      ['Chains', '5.2'],
      ['First chain jump', '240'],
      ['Life', '200'],
    ],
  },
  'crit+glassCannon': {
    rules: ['glassCannon'],
    effectiveHit: 265.5791097960001,
    attackDamage: 265.5791097960001,
    crowdDps: 10623.164391840004,
    multipliers: {
      repeatableMultD: 1.3310000000000004,
      sectorMultD: 5.155371951219513,
      sectorMultAttack: 5.155371951219513,
      sectorMultCrowd: 16.110537347560975,
    },
    summary: [
      ['Hit damage', '55.9'],
      ['Attack speed', '8/s'],
      ['Projectiles', '5'],
      ['Crit chance', '35%'],
      ['Crit multiplier', '530%'],
      ['Crit hit', '539'],
      ['Ignite chance', '10%'],
      ['Burn per stack', '83.9/s'],
      ['Burn duration (s)', '1.2'],
      ['Max burn stacks', '5'],
      ['Chains', '0'],
      ['First chain jump', '39.1'],
      ['Life', '1'],
    ],
  },
  'dot+bridges': {
    // Searing Crits and the bridge notables are behaviour modifiers since C3.3.
    rules: [],
    effectiveHit: 1623.8871583541022,
    attackDamage: 1964.9034616084634,
    crowdDps: 39298.06923216927,
    multipliers: {
      repeatableMultD: 2.1435888100000016,
      sectorMultD: 8.624216807558431,
      sectorMultAttack: 8.217328507839799,
      sectorMultCrowd: 12.839575793499684,
    },
    summary: [
      ['Hit damage', '58.5'],
      ['Attack speed', '10/s'],
      ['Projectiles', '2'],
      ['Crit chance', '10%'],
      ['Crit multiplier', '200%'],
      ['Crit hit', '234'],
      ['Ignite chance', '100%'],
      ['Burn per stack', '879/s'],
      ['Burn duration (s)', '1.6'],
      ['Max burn stacks', '8'],
      ['Chains', '0.3'],
      ['First chain jump', '41'],
      ['Life', '260'],
    ],
  },
  'chain+staticFocus': {
    rules: [],
    effectiveHit: 228.64455021493063,
    attackDamage: 1102.0276327106412,
    crowdDps: 14105.953698696208,
    multipliers: {
      repeatableMultD: 3.138428376721004,
      sectorMultD: 1.8260869565217395,
      sectorMultAttack: 6.3189731307749,
      sectorMultCrowd: 6.318973130774901,
    },
    summary: [
      ['Hit damage', '185'],
      ['Attack speed', '6.4/s'],
      ['Projectiles', '2'],
      ['Crit chance', '10%'],
      ['Crit multiplier', '150%'],
      ['Crit hit', '277'],
      ['Ignite chance', '10%'],
      ['Burn per stack', '277/s'],
      ['Burn duration (s)', '1.2'],
      ['Max burn stacks', '5'],
      ['Chains', '3.1'],
      ['First chain jump', '243'],
      ['Life', '230'],
    ],
  },
};

function expectRelative(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(Math.abs(expected) * 1e-12);
}

describe('build estimates of six fixed builds', () => {
  beforeAll(() => setLocale('en'));

  it('covers the same builds as the snapshot', () => {
    expect(Object.keys(BUILDS)).toEqual(Object.keys(EXPECTED));
  });

  it.each(Object.entries(BUILDS))('%s', (name, meta) => {
    const expected = EXPECTED[name];
    if (expected === undefined) throw new Error(`No snapshot for ${name}`);
    const stats = statBlockFor(meta, data);
    const rules = collectRules(meta, data);
    expect(rules.map((rule) => rule.id)).toEqual(expected.rules);
    expectRelative(effectiveHit(stats, rules), expected.effectiveHit, 'effectiveHit');
    expectRelative(attackDamage(stats, rules), expected.attackDamage, 'attackDamage');
    expectRelative(crowdDps(stats, rules), expected.crowdDps, 'crowdDps');
    const multipliers = buildMultipliers(meta, data);
    for (const key of Object.keys(expected.multipliers) as (keyof BuildMultipliers)[]) {
      expectRelative(multipliers[key], expected.multipliers[key], key);
    }
    const summary = describeBuild(stats, rules).map((line) => [line.label, line.value]);
    expect(summary).toEqual(expected.summary);
  });
});
