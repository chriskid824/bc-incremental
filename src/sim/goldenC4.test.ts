/**
 * GOLDEN-C4: fixture runs of the C4 mechanics (docs/v3 C4 design §0.3, §9), each for 1,200
 * ticks at seeds 1 and 2, hashed whole: every tick's events as they are (no projection to M1
 * keys, unlike src/sim/golden.test.ts), then the result's M1 fields (projectResult), its damage
 * per source and its counters that are not 0, in COUNTER_IDS order. A counter appended later is
 * 0 in every run that came before it, so it moves no recorded hash. Each case runs twice and
 * must hash the same both times.
 *
 * A commit that lands a mechanic appends its entries with the hashes recorded at that commit.
 * A later commit leaves every recorded hash alone, unless its message names the entries it
 * re-records and why.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mul, num, toNumber } from '../core/num';
import type { RuleSpec } from '../data/rules';
import type { Modifier } from '../data/stats';
import { TAG } from '../data/tags';
import type { TriggerSpec } from '../data/triggers';
import { ENEMY_IDS } from '../data/types';
import type { EnemyId, GameData } from '../data/types';
import { frostMeter } from './ailments/frost';
import { holdsBurn } from './ailments/records';
import { SMALL_PROJECTILE_TICKS } from './caps';
import { createPayload, ROWS } from './emitters/types';
import type { Payload } from './emitters/types';
import type { BuildCompiler, TestModule } from './rules';
import { createSimulation } from './simulation';
import type { RunContext } from './systems/context';
import { ARMOURED, CHARGING, DASHING, FLEEING, ORBITING, STOPPED } from './systems/enemyRecord';
import { MOTION_HOMING, MOTION_LOB, MOTION_STRAIGHT, spawnShot } from './systems/shots';
import {
  GOLDEN_BUILDS,
  makeConfig,
  makeStats,
  makeTestData,
  maskProbeMods,
  projectResult,
  TEST_V3_WAVES,
  TEST_WAVES,
  v3TestData,
} from './testing';
import { ARENA_HEIGHT, ARENA_WIDTH, COUNTER_IDS, DT, NO_INPUT } from './types';
import type { ContactTally, CounterId, EnemyState, RunConfig } from './types';

const GOLDEN_C4_TICKS = 1200;
const GOLDEN_C4_SEEDS = [1, 2] as const;

interface GoldenC4Entry {
  /** The entry's name; its cases are '<name>/s1' and '<name>/s2'. */
  readonly name: string;
  /** The run's config but its seed and length; makeConfig's defaults for the rest. */
  readonly config: Partial<RunConfig>;
  /** The run's data; makeTestData() when omitted. */
  readonly data?: () => GameData;
  /** createSimulation's test modules. */
  readonly modules?: () => readonly TestModule[];
  /** The hash recorded for each seed of GOLDEN_C4_SEEDS, in order. */
  readonly expected: readonly [string, string];
}

/**
 * C4.2's shot pool beside the volley: every 15 ticks, a ring of six straight shots from the
 * player (pierce 1 to 5 or without limit, bounces, one wide shot), a homing shot (steady every
 * fourth round) and a lob landing 24 ticks later, all on one payload credited to
 * outer.barrage.
 */
function shotsModule(): TestModule {
  let payload: Payload | null = null;
  const module = (b: BuildCompiler, source: number): void => {
    b.hook('tick', (ctx) => {
      if (ctx.now % 15 !== 0) return;
      payload ??= createPayload({
        baseDamage: mul(num(ctx.build.values.damage), 0.4),
        tags: TAG.hit | TAG.projectile,
        source,
        flags: 0,
        rng: ctx.effectsRng,
        chains: false,
        rollsAilments: true,
        canCrit: true,
        damageMode: ROWS,
      });
      const round = ctx.now / 15;
      const until = ctx.now + SMALL_PROJECTILE_TICKS;
      const { x, y } = ctx.player;
      for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI) / 3 + round * 0.37;
        const pierce = i === 0 ? -1 : i;
        const vx = 16 * Math.cos(angle);
        const vy = 16 * Math.sin(angle);
        const s = spawnShot(
          ctx,
          MOTION_STRAIGHT,
          x,
          y,
          vx,
          vy,
          until,
          payload,
          0.5,
          pierce,
          i % 3,
          0,
          -1,
          false,
          -1,
          -1,
          null,
        );
        if (s >= 0 && i === 3) ctx.shots.radius[s] = 14;
      }
      const steady = round % 4 === 0;
      spawnShot(
        ctx,
        MOTION_HOMING,
        x,
        y,
        0,
        0,
        until,
        payload,
        1,
        1,
        0,
        0,
        -1,
        steady,
        -1,
        -1,
        null,
      );
      const angle = round * 0.9;
      const lx = x + 300 * Math.cos(angle);
      const ly = y + 300 * Math.sin(angle);
      spawnShot(
        ctx,
        MOTION_LOB,
        lx,
        ly,
        x,
        y,
        ctx.now + 24,
        payload,
        1,
        1,
        0,
        0,
        -1,
        false,
        -1,
        -1,
        null,
      );
    });
  };
  return Object.assign(module, { source: 'outer.barrage' });
}

/**
 * C4.3's thorns: outer.thorns grants thorns at the default 300% and the center at 100%, each
 * contact raises a thorns nova at the toucher, and thorns damage is doubled by a thorns-scoped
 * more. The volley is too weak to clear wave 12, so some touchers die to the thorns (pentagons
 * among them, whose shards touch from the next tick) and others leak.
 */
const THORNS_NOVA: TriggerSpec = {
  on: 'contact',
  do: [{ kind: 'nova', radius: 120, damagePct: 1.5, tags: ['thorns'], at: 'event' }],
};
const THORNS_MORE: Modifier = { stat: 'damage', kind: 'more', value: 1, tags: ['thorns'] };
const THORNS_STATS = makeStats(
  { damage: 5, maxLife: 1e6, critChance: 0.2, critMultiplier: 2, igniteChance: 0.3 },
  [...maskProbeMods(), THORNS_MORE],
  {
    triggers: [{ source: 'center', spec: THORNS_NOVA }],
    conversions: [],
    emitters: [
      { source: 'outer.thorns', grant: { kind: 'thorns' } },
      { source: 'center', grant: { kind: 'thorns', damagePct: 1 } },
    ],
  },
);

/**
 * C4.4's target selectors: periodic triggers picking the densest spot, the most hp (bosses
 * left out) and the most burn stacks; kill triggers picking the nearest to the victim and the
 * outermost; a contact trigger picking the farthest from the player; heroHit centering on the
 * player; a hit trigger picking another enemy near its target; and order 'nearest' on an
 * explode, an applyAilment with a radius and a poison spread.
 */
const SELECTOR_TRIGGERS: readonly TriggerSpec[] = [
  {
    on: 'periodic',
    every: 1.5,
    target: { pick: 'densest' },
    do: [{ kind: 'explode', radius: 110, damagePct: 1.2, maxTargets: 3, order: 'nearest' }],
  },
  {
    on: 'periodic',
    every: 2,
    target: { pick: 'highestHp', excludeBoss: true },
    do: [{ kind: 'applyAilment', ailment: 'burn', stacks: 2 }],
  },
  {
    on: 'periodic',
    every: 2.5,
    target: { pick: 'mostStacks', ailment: 'burn' },
    do: [{ kind: 'nova', radius: 140, damagePct: 0.8, at: 'event' }],
  },
  {
    on: 'kill',
    target: { pick: 'nearest', range: 250 },
    do: [{ kind: 'applyAilment', ailment: 'shock', radius: 120, maxTargets: 3, order: 'nearest' }],
  },
  {
    on: 'kill',
    when: [{ chance: 0.3 }],
    target: { pick: 'outermost' },
    do: [{ kind: 'addFrost', amount: 0.6 }],
  },
  {
    on: 'contact',
    target: { pick: 'farthest', from: 'player', range: 500 },
    do: [{ kind: 'explode', radius: 90, damagePct: 2 }],
  },
  { on: 'heroHit', target: { pick: 'player' }, do: [{ kind: 'push', distance: 60, radius: 160 }] },
  {
    on: 'hit',
    when: [{ chance: 0.1 }],
    target: { pick: 'nearest', excludeEventTarget: true, range: 200 },
    do: [{ kind: 'explode', radius: 60, damagePct: 0.5, maxTargets: 2, order: 'nearest' }],
  },
  {
    on: 'kill',
    do: [
      { kind: 'spreadAilment', ailment: 'poison', radius: 220, maxTargets: 2, order: 'nearest' },
    ],
  },
];
const SELECTOR_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.3,
    poisonChance: 0.3,
  },
  maskProbeMods(),
  {
    triggers: SELECTOR_TRIGGERS.map((spec) => ({ source: 'center', spec })),
    conversions: [],
    emitters: [],
  },
);

/**
 * C4.5's center-event lists: hits fill chill meters fast, and each freeze takes its list. One
 * center trigger with a cooldown fans two poison stacks out over the list and explodes once at
 * the frozen enemy; a chance trigger fans a full meter of frost out, so freezes freeze others; a
 * selector trigger shocks the nearest other enemy once; and a fusion's trigger fans a burn out,
 * which the freeze payload limit stops a few times.
 */
const FREEZE_LIST_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'center',
    {
      on: 'freeze',
      when: [{ cooldownSec: 0.25 }],
      do: [
        { kind: 'applyAilment', ailment: 'poison', stacks: 2 },
        { kind: 'explode', radius: 70, damagePct: 0.6 },
      ],
    },
  ],
  ['center', { on: 'freeze', when: [{ chance: 0.5 }], do: [{ kind: 'addFrost', amount: 1 }] }],
  [
    'center',
    {
      on: 'freeze',
      target: { pick: 'nearest', excludeEventTarget: true, range: 150 },
      do: [{ kind: 'applyAilment', ailment: 'shock', stacks: 2 }],
    },
  ],
  ['fusion.ice.fire', { on: 'freeze', do: [{ kind: 'applyAilment', ailment: 'burn' }] }],
];
const FREEZE_LIST_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    frostOnHit: 0.5,
    chainCount: 1,
    attackSpeed: 6,
    projectileCount: 2,
  },
  maskProbeMods(),
  {
    triggers: FREEZE_LIST_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);

/**
 * C4.6's ground zones: the volley's hits drop burning fire zones (a source's 16 bind, so they
 * evict), crits drop slowing, chilling ice zones that also mark enemies for a damage more, kills
 * drop poison-only zones, half the freezes drop small cold zones, and every second an aura zone
 * lands on the densest spot and marks enemies for a center explode. The damaging zones' hits
 * ignite and chill like the volley's (igniteChance, frostOnHit; re-recorded by C4.6c), and the
 * fire zones' burn terms hold enemies at the burn cap, where those hits' burns (re-recorded by
 * C4.6d) and the terms' own stacks (by C4.7b) replace only weaker stacks.
 */
const ZONE_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'outer.fire',
    {
      on: 'hit',
      when: [{ hitIs: 'signature' }],
      do: [
        { kind: 'groundZone', radius: 50, durationSec: 3, damagePctPerSec: 0.3, ailment: 'burn' },
      ],
    },
  ],
  [
    'outer.ice',
    {
      on: 'crit',
      when: [{ cooldownSec: 0.5 }],
      do: [
        {
          kind: 'groundZone',
          radius: 80,
          durationSec: 2,
          damagePctPerSec: 0.05,
          slow: 0.4,
          addFrostPerSec: 0.6,
        },
      ],
    },
  ],
  [
    'outer.poison',
    {
      on: 'kill',
      do: [
        {
          kind: 'groundZone',
          radius: 60,
          durationSec: 2,
          damagePctPerSec: 0,
          ailment: 'poison',
          ailmentStacks: 2,
          ailmentDamagePct: 0.5,
        },
      ],
    },
  ],
  [
    'center',
    {
      on: 'freeze',
      when: [{ chance: 0.5 }],
      do: [
        { kind: 'groundZone', radius: 40, durationSec: 0.5, damagePctPerSec: 0.5, element: 'cold' },
      ],
    },
  ],
  [
    'outer.aura',
    {
      on: 'periodic',
      every: 1,
      target: { pick: 'densest' },
      do: [{ kind: 'groundZone', radius: 120, durationSec: 3, damagePctPerSec: 0.1 }],
    },
  ],
  [
    'center',
    {
      on: 'hit',
      when: [{ inZone: 'outer.aura' }, { chance: 0.05 }],
      do: [{ kind: 'explode', radius: 60, damagePct: 0.4 }],
    },
  ],
];
const IN_ICE_MORE: Modifier = {
  stat: 'damage',
  kind: 'more',
  value: 0.5,
  when: [{ inZone: 'outer.ice' }],
};
const ZONE_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    frostOnHit: 0.1,
  },
  [...maskProbeMods(), IN_ICE_MORE],
  {
    triggers: ZONE_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);

/**
 * C4.7's magma bombs: the lob, fast, 2.5 bombs a firing (two, and a third on a drawn chance),
 * with steadyAim on every fourth bomb, ignites, a chain jump and enough frost that its hits
 * freeze; a projectile-tagged damage probe beside maskProbeMods() tells the explosions' hits
 * (hit, area and projectile) from their chain jumps and their fire zones' hits. Its explode
 * triggers fan two poison stacks out over the blast's list on a cooldown, shock the struck enemy
 * when it burns, and now and then set off a nova at the landing point; a fire kill trigger's
 * explosions raise no explode. A test module makes the fire zones slow.
 */
const MAGMA_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'center',
    {
      on: 'explode',
      when: [{ cooldownSec: 0.5 }],
      do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }],
    },
  ],
  [
    'center',
    {
      on: 'explode',
      when: [{ targetHas: 'burn' }],
      do: [{ kind: 'applyAilment', ailment: 'shock', stacks: 1 }],
    },
  ],
  [
    'center',
    {
      on: 'explode',
      when: [{ chance: 0.3 }],
      do: [{ kind: 'nova', radius: 100, damagePct: 0.5, at: 'event' }],
    },
  ],
  [
    'outer.fire',
    { on: 'kill', when: [{ chance: 0.2 }], do: [{ kind: 'explode', radius: 80, damagePct: 0.8 }] },
  ],
];
const PROJECTILE_PROBE: Modifier = {
  stat: 'damage',
  kind: 'increased',
  value: 0.11,
  tags: ['projectile'],
};
const MAGMA_STATS = makeStats(
  {
    damage: 8,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    chainCount: 1,
    frostOnHit: 0.35,
    attackSpeed: 6,
    projectileCount: 3.5,
  },
  [...maskProbeMods(), PROJECTILE_PROBE],
  {
    triggers: MAGMA_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);

/**
 * C4.8's lob forms at projectileCount 3, two bombs a firing: C4.7's magma bombs (their stats at
 * that count, their triggers and probes) with 遠投 on every fourth bomb and 連環爆, whose
 * explosions are effects that raise no explode; and, for `volcano`, 火山's giant bombs every
 * 120 ticks at attack speed 6, every fourth thrown far.
 */
const LOB_FORM_STATS = makeStats(
  { ...MAGMA_STATS.values, projectileCount: 3 },
  [...maskProbeMods(), PROJECTILE_PROBE],
  {
    triggers: MAGMA_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);
const FAR_THROW: RuleSpec = { id: 'farThrow', every: 4 };

/** A test module that gives the lob's fire zones a 30% slow (LobParams.zone). */
function slowFireModule(): TestModule {
  return (b) => {
    const lob = b.signature().lob;
    if (lob !== null) lob.zone.slow = 0.3;
  };
}

/**
 * C4.9's repeats: 回聲 repeats every fifth attack once at half its damage, now; 多重施法 on every
 * twelfth queues two full repeats for the next attack; a signature hit now and then repeats the
 * attack at 30% (a repeat's own hits pass that trigger's conditions and do not repeat, rule 7);
 * and a kill now and then queues three more, so pending charges can overflow (`repeat`'s seed 2
 * drops three). `repeat` runs them on the volley at 2.5 projectiles an attack, with crits,
 * ignites and a chain jump; `repeatLob` on C4.7's magma bombs at projectileCount 2.5 (one bomb
 * and a second on a drawn chance), with their triggers, probes and steadyAim on every fourth
 * bomb.
 */
const REPEAT_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'outer.combo',
    { on: 'nthAttack', every: 5, do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }] },
  ],
  [
    'outer.combo',
    {
      on: 'nthAttack',
      every: 12,
      do: [{ kind: 'repeatAttack', count: 2, damagePct: 1, timing: 'nextAttack' }],
    },
  ],
  [
    'center',
    {
      on: 'hit',
      when: [{ hitIs: 'signature' }, { chance: 0.05 }],
      do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.3, timing: 'now' }],
    },
  ],
  [
    'center',
    {
      on: 'kill',
      when: [{ chance: 0.3 }],
      do: [{ kind: 'repeatAttack', count: 3, damagePct: 0.4, timing: 'nextAttack' }],
    },
  ],
];
const REPEAT_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    chainCount: 1,
    attackSpeed: 6,
    projectileCount: 2.5,
  },
  maskProbeMods(),
  {
    triggers: REPEAT_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);
const REPEAT_LOB_STATS = makeStats(
  { ...MAGMA_STATS.values, projectileCount: 2.5 },
  [...maskProbeMods(), PROJECTILE_PROBE],
  {
    triggers: [...MAGMA_TRIGGERS, ...REPEAT_TRIGGERS].map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);

/**
 * C4.10's detonates on records burn, poison rings and bleed, with crits, a chain jump and
 * shocks: a signature hit on a burning enemy now and then takes half its burn; a crit on a
 * poisoned one sets off its poison on the three nearest within 80; 焚屍 deals what a burning
 * victim had left around it, and a bleeding victim half of its bleed (the step's bleed included
 * when its burn or poison step killed it, Hoshi's Q7/F1); a hit on an enemy at the shock cap
 * ('max', 2) takes 30% of its poison, on a cooldown. A modifier at the burn cap ('max', 3) adds
 * 50% more damage.
 */
const DETONATE_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'center',
    {
      on: 'hit',
      when: [{ hitIs: 'signature' }, { targetHas: 'burn' }, { chance: 0.15 }],
      do: [{ kind: 'detonate', ailment: 'burn', fraction: 0.5 }],
    },
  ],
  [
    'outer.poison',
    {
      on: 'crit',
      when: [{ targetHas: 'poison' }],
      do: [
        {
          kind: 'detonate',
          ailment: 'poison',
          radius: 80,
          maxTargets: 3,
          order: 'nearest',
          damage: 0.8,
        },
      ],
    },
  ],
  [
    'outer.fire',
    {
      on: 'kill',
      when: [{ victimHas: 'burn' }],
      do: [{ kind: 'detonate', ailment: 'burn', radius: 100, damage: 0.5 }],
    },
  ],
  [
    'outer.bleed',
    {
      on: 'diedWithAilment',
      when: [{ victimHas: 'bleed' }],
      do: [{ kind: 'detonate', ailment: 'bleed', radius: 60, fraction: 0.5 }],
    },
  ],
  [
    'center',
    {
      on: 'hit',
      when: [{ stacksAtLeast: { ailment: 'shock', stacks: 'max' } }, { cooldownSec: 0.5 }],
      do: [{ kind: 'detonate', ailment: 'poison', fraction: 0.3 }],
    },
  ],
];
const AT_BURN_CAP_MORE: Modifier = {
  stat: 'damage',
  kind: 'more',
  value: 0.5,
  when: [{ stacksAtLeast: { ailment: 'burn', stacks: 'max' } }],
};
const DETONATE_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.3,
    poisonChance: 0.3,
    bleedChance: 0.2,
    shockChance: 0.25,
    shockMaxStacks: 2,
    burnMaxStacks: 3,
    chainCount: 1,
    projectileCount: 2,
  },
  [...maskProbeMods(), AT_BURN_CAP_MORE],
  {
    triggers: DETONATE_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);

/**
 * C4.11's toSplitChildren on waves of pentagons: a poisoned victim's kill spreads half its
 * poison stacks to the two nearest within 120 and gives each child half its poison; half the
 * time a poisoned victim's death also spreads half its poison's damage within 60 and gives each
 * child all of it. A quarter of kills explode, next tick, among the children.
 */
const SPLIT_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'outer.poison',
    {
      on: 'kill',
      when: [{ victimHas: 'poison' }],
      do: [
        {
          kind: 'spreadAilment',
          ailment: 'poison',
          radius: 120,
          stacks: 0.5,
          maxTargets: 2,
          order: 'nearest',
          toSplitChildren: 0.5,
        },
      ],
    },
  ],
  [
    'center',
    {
      on: 'diedWithAilment',
      when: [{ victimHas: 'poison' }, { chance: 0.5 }],
      do: [
        { kind: 'spreadAilment', ailment: 'poison', radius: 60, effect: 0.5, toSplitChildren: 1 },
      ],
    },
  ],
  [
    'center',
    {
      on: 'kill',
      when: [{ chance: 0.25 }],
      do: [{ kind: 'explode', radius: 70, damagePct: 0.6 }],
    },
  ],
];
const SPLIT_STATS = makeStats(
  {
    damage: 20,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    poisonChance: 0.5,
    chainCount: 1,
    projectileCount: 2,
  },
  [...maskProbeMods()],
  {
    triggers: SPLIT_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);
/** makeTestData() with pentagons from wave 1, 6 of them and one more per wave up to 16. */
const splitData = (): GameData =>
  makeTestData({
    waves: {
      rules: [
        { enemy: 'triangle', fromWave: 1, base: 6, perWave: 0.6, maxCount: 40 },
        { enemy: 'pentagon', fromWave: 1, base: 6, perWave: 1, maxCount: 16 },
      ],
    },
  });

/**
 * C4.12's projectiles, every aim: a ring of 10 from the player twice a second, each shot
 * piercing once and bouncing once; two homing shots at the enemy with the most hp every 1.5 s;
 * a crit now and then sends two homing shots at its enemy; a kill now and then one at each of
 * the 3 enemies nearest to it; and a primary hit now and then a cold fan of 5 from the player
 * over 40°, piercing every enemy. Their hits crit, ignite and trigger one another at depth.
 */
const PROJECTILES_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'outer.barrage',
    {
      on: 'periodic',
      every: 0.5,
      do: [
        {
          kind: 'projectiles',
          count: 10,
          aim: 'radial',
          from: 'player',
          damagePct: 0.3,
          pierce: 1,
          bounce: 1,
        },
      ],
    },
  ],
  [
    'outer.barrage',
    {
      on: 'periodic',
      every: 1.5,
      target: { pick: 'highestHp' },
      do: [{ kind: 'projectiles', count: 2, aim: 'target', damagePct: 0.8 }],
    },
  ],
  [
    'center',
    {
      on: 'crit',
      when: [{ chance: 0.4 }],
      do: [{ kind: 'projectiles', count: 2, aim: 'target', damagePct: 0.4 }],
    },
  ],
  [
    'center',
    {
      on: 'kill',
      when: [{ chance: 0.5 }],
      do: [{ kind: 'projectiles', count: 3, aim: 'distinct', damagePct: 0.5 }],
    },
  ],
  [
    'outer.ice',
    {
      on: 'hit',
      when: [{ hitIs: 'primary' }, { chance: 0.25 }],
      do: [
        {
          kind: 'projectiles',
          count: 5,
          aim: 'fan',
          from: 'player',
          spreadDeg: 40,
          pierce: -1,
          damagePct: 0.2,
          element: 'cold',
        },
      ],
    },
  ],
];
const PROJECTILES_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.25,
    critMultiplier: 2,
    igniteChance: 0.2,
    chainCount: 1,
    projectileCount: 2,
  },
  maskProbeMods(),
  {
    triggers: PROJECTILES_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);

/**
 * C4.13's slashes and coins: a primary hit now and then slashes outward from its enemy, and
 * another toward the other enemy nearest to it within 500, which a selector picks; a crit now
 * and then slashes at the enemy nearest to it, always critting, scaled by the crit chance, or
 * flips a coin at its enemy, ignoring armour; a kill now and then slashes at the enemy nearest
 * to the victim; and every 2 s a coin of 10× hits the enemy with the most hp, ignoring
 * shields. Their hits crit, ignite and trigger one another at depth.
 */
const SLASH_COIN_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'outer.barrage',
    {
      on: 'hit',
      when: [{ hitIs: 'primary' }, { chance: 0.3 }],
      do: [
        {
          kind: 'slashLine',
          length: 250,
          width: 30,
          damagePct: 0.4,
          toward: 'outward',
          from: 'target',
          tags: ['chain'],
        },
      ],
    },
  ],
  [
    'outer.barrage',
    {
      on: 'hit',
      when: [{ hitIs: 'primary' }, { chance: 0.2 }],
      target: { pick: 'nearest', range: 500, excludeEventTarget: true },
      do: [{ kind: 'slashLine', length: 400, width: 20, damagePct: 0.25, toward: 'eventTarget' }],
    },
  ],
  [
    'center',
    {
      on: 'crit',
      when: [{ chance: 0.5 }],
      do: [
        {
          kind: 'slashLine',
          length: 300,
          width: 24,
          damagePct: 0.3,
          toward: 'nearest',
          alwaysCrit: true,
          critScale: 1,
        },
      ],
    },
  ],
  [
    'center',
    {
      on: 'crit',
      when: [{ chance: 0.2 }],
      do: [{ kind: 'coinHit', multiplier: 3, ignoreArmour: true }],
    },
  ],
  [
    'outer.ice',
    {
      on: 'kill',
      when: [{ chance: 0.5 }],
      do: [{ kind: 'slashLine', length: 200, width: 40, damagePct: 0.5, toward: 'nearest' }],
    },
  ],
  [
    'outer.barrage',
    {
      on: 'periodic',
      every: 2,
      target: { pick: 'highestHp' },
      do: [{ kind: 'coinHit', multiplier: 10, ignoreShield: true }],
    },
  ],
];
const SLASH_COIN_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.25,
    critMultiplier: 2,
    igniteChance: 0.2,
    chainCount: 1,
    projectileCount: 2,
  },
  maskProbeMods(),
  {
    triggers: SLASH_COIN_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);

/**
 * C4.14's segments: 雷網 on outer.lightning at its defaults (2 links within 200, 10% of the
 * damage stat, 1 shock stack, every 0.25 s) and a center-board segment of 1 link within 150, 30%
 * of the damage stat and 2 stacks every 0.5 s, on a volley that shocks a third of its hits and
 * chains once. The segments' hits crit and kill (pentagons among them, whose shards appear on
 * the links), and their shock keeps the endpoints shocked; a kill trigger on outer.lightning
 * explodes some of the kills.
 */
const SEGMENT_STATS = makeStats(
  {
    damage: 5,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    shockChance: 0.3,
    chainCount: 1,
  },
  maskProbeMods(),
  {
    triggers: [
      {
        source: 'outer.lightning',
        spec: {
          on: 'kill',
          when: [{ chance: 0.3 }],
          do: [{ kind: 'explode', radius: 60, damagePct: 0.5 }],
        },
      },
    ],
    conversions: [],
    emitters: [
      { source: 'outer.lightning', grant: { kind: 'segment', endpoints: 'shocked' } },
      {
        source: 'center',
        grant: {
          kind: 'segment',
          endpoints: 'shocked',
          links: 1,
          range: 150,
          damagePct: 0.3,
          shockStacks: 2,
          periodSec: 0.5,
        },
      },
    ],
  },
);

/**
 * C4.16's chain policies on a volley that chains 2.5 times and repeats (REPEAT_TRIGGERS): two
 * modules write the build's one policy, a fork by 2 at level 1 (渦流), 電荷 and 蓄電, and a 30%
 * extra jump (跳電), one bounce (回彈) and the farthest enemy at the last level (遠雷). The
 * signature's repeats chain by it too.
 */
const POLICY_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    chainCount: 2.5,
    chainRetention: 0.7,
    attackSpeed: 5,
  },
  maskProbeMods(),
  {
    triggers: REPEAT_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);
const policyModules = (): TestModule[] => [
  (b) => {
    const spec = b.chainPolicy();
    spec.branchFirst = 2;
    spec.decay.push({ from: 1, to: 1, factor: 1 });
  },
  (b) => {
    const spec = b.chainPolicy();
    spec.extraJumpChance = 0.3;
    spec.bounces = 1;
    spec.lastFarthest = true;
    spec.decay.push({ from: 3, factor: 1.15 });
  },
];

/**
 * C4.17's chain bolts on a volley that chains once and shocks a fifth of its hits: a primary hit
 * now and then sends a 2-jump bolt on from its enemy that adds a shock stack to each enemy it
 * hits; a crit, one of 3 jumps at the enemy nearest its enemy but that one (a selector), of 2
 * stacks; a kill, one of 3 jumps from the enemy nearest the victim's point, without shock; and
 * every 1.5 s a 4-jump bolt starts at the enemy nearest the player. Their hits crit, ignite,
 * kill and trigger one another at depth, and the shocked enemies take more of every hit.
 */
const CHAIN_BOLT_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'outer.lightning',
    {
      on: 'hit',
      when: [{ hitIs: 'primary' }, { chance: 0.3 }],
      do: [{ kind: 'chainBolt', jumps: 2, damagePct: 0.5, shockStacks: 1 }],
    },
  ],
  [
    'center',
    {
      on: 'crit',
      when: [{ chance: 0.3 }],
      target: { pick: 'nearest', range: 300, excludeEventTarget: true },
      do: [{ kind: 'chainBolt', jumps: 3, damagePct: 0.3, shockStacks: 2 }],
    },
  ],
  [
    'outer.lightning',
    {
      on: 'kill',
      when: [{ chance: 0.5 }],
      do: [{ kind: 'chainBolt', jumps: 3, damagePct: 0.4, from: 'nearestToPoint' }],
    },
  ],
  [
    'outer.barrage',
    {
      on: 'periodic',
      every: 1.5,
      do: [
        {
          kind: 'chainBolt',
          jumps: 4,
          damagePct: 0.6,
          shockStacks: 1,
          from: 'nearestToPoint',
        },
      ],
    },
  ],
];
const CHAIN_BOLT_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    shockChance: 0.2,
    chainCount: 1,
    chainRange: 300,
  },
  maskProbeMods(),
  {
    triggers: CHAIN_BOLT_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);

/**
 * C4.18's strikes beside a thorns grant, on a volley that chains once and shocks a fifth of its
 * hits: 落雷 every second at the enemy nearest the player, its hit and the enemies within 50 of
 * it, a shock stack on the target; 雷鳴 every 1.5 s at the enemy of the most hp within 400,
 * bosses left out, chaining 4 jumps that shock 2 stacks each; and a cold strike every 0.75 s at
 * the most shocked enemy, over 80, with no shock of its own. Their hits crit, ignite and kill,
 * and a kill trigger on outer.lightning explodes some of the kills.
 */
const STRIKE_STATS = makeStats(
  {
    damage: 5,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    shockChance: 0.2,
    chainCount: 1,
  },
  maskProbeMods(),
  {
    triggers: [
      {
        source: 'outer.lightning',
        spec: {
          on: 'kill',
          when: [{ chance: 0.3 }],
          do: [{ kind: 'explode', radius: 60, damagePct: 0.5 }],
        },
      },
    ],
    conversions: [],
    emitters: [
      { source: 'center', grant: { kind: 'thorns', damagePct: 1 } },
      {
        source: 'outer.lightning',
        grant: {
          kind: 'strike',
          name: 'lightningStrike',
          periodSec: 1,
          target: { pick: 'nearest' },
          damagePct: 2,
          radius: 50,
          element: 'lightning',
          shockStacks: 1,
        },
      },
      {
        source: 'outer.lightning',
        grant: {
          kind: 'strike',
          name: 'thunder',
          periodSec: 1.5,
          target: { pick: 'highestHp', range: 400, excludeBoss: true },
          damagePct: 1.5,
          element: 'lightning',
          chainJumps: 4,
          shockStacks: 2,
        },
      },
      {
        source: 'center',
        grant: {
          kind: 'strike',
          name: 'frostfall',
          periodSec: 0.75,
          target: { pick: 'mostStacks', ailment: 'shock' },
          damagePct: 1,
          radius: 80,
          element: 'cold',
        },
      },
    ],
  },
);

/**
 * C4.19's ice fan: 3.125 rounds a second (attack speed 5) of 5.5 cones (five, and a sixth on a
 * drawn chance), every fourth round counted one 冰柱 cone of 400% instead, with steadyAim on
 * every fourth cone, crits, ignites, each round's chain jump and enough frost that its hits
 * freeze; maskProbeMods() and the projectile probe tell the cone hits (hit, projectile and cold)
 * from their chain jumps (hit, chain and cold). C4.9's repeat triggers fire the fan's repeat
 * rounds, now and with the next round.
 */
const ICE_FAN_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    chainCount: 1,
    frostOnHit: 0.15,
    attackSpeed: 5,
    projectileCount: 2.5,
  },
  [...maskProbeMods(), PROJECTILE_PROBE],
  {
    triggers: REPEAT_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);

/**
 * C4.20's three-phase arc under 六線圈: six discharges a second, each at two targets for 55% of
 * the damage, chaining 3.5 times (1.5, and the arc's 2) from both in one chain, which forks by 2
 * at level 1, jumps once more on 30% and bounces; every hit shocks; crits, ignites and steadyAim
 * on every fourth discharge, and maskProbeMods() to tell its hits (hit, chain and lightning)
 * apart. Its jumps raise chainJump for two listeners, each at most 3 times an attack: a data
 * trigger that cuts a slashLine on along the jump at 30%, and a fusion's at coefficient 0.5
 * that burns the enemy jumped to at 15%. C4.9's repeat triggers fire the arc's repeat
 * discharges, now and with the next one.
 */
const ARC_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  ...REPEAT_TRIGGERS,
  [
    'center',
    {
      on: 'chainJump',
      do: [{ kind: 'slashLine', length: 220, width: 24, damagePct: 0.4, toward: 'along' }],
    },
  ],
];
const ARC_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    chainCount: 1.5,
    attackSpeed: 4,
  },
  maskProbeMods(),
  {
    triggers: ARC_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);
const arcModules = (): TestModule[] => [
  (b) => {
    const spec = b.chainPolicy();
    spec.branchFirst = 2;
    spec.extraJumpChance = 0.3;
    spec.bounces = 1;
  },
  (b) =>
    b.addTrigger(
      'fusion.lightning.fire',
      { on: 'chainJump', do: [{ kind: 'applyAilment', ailment: 'burn', stacks: 1 }] },
      0.5,
    ),
];

/**
 * C5.1's drones: M1's volley and three granted drones on outer.summon, over THORNS_STATS' base
 * (crits, ignites and maskProbeMods()). They dock around the player, dash at the farthest enemy
 * inside the arena that no other drone chases, impact it (every enemy within 40 of it takes a
 * hit, tagged hit, minion and area), three impacts a sortie with a same-enemy cooldown, and fly
 * home to dock; their hits crit and ignite on the combat stream, and their kills split.
 */
const DRONES_STATS = makeStats(
  { damage: 5, maxLife: 1e6, critChance: 0.2, critMultiplier: 2, igniteChance: 0.3 },
  maskProbeMods(),
  {
    triggers: [],
    conversions: [],
    emitters: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 3 } }],
  },
);

/**
 * C5.1's summon cap (CD11): 20 drones on outer.summon and 10 more, named 'b', on the hub, over
 * the same base. The pool takes the first 24 in emitter order, 20 and 4, ids in that order, and
 * counts the 6 it refuses (summonCapped).
 */
const DRONE_CAP_STATS = makeStats(
  { damage: 5, maxLife: 1e6, critChance: 0.2, critMultiplier: 2, igniteChance: 0.3 },
  maskProbeMods(),
  {
    triggers: [],
    conversions: [],
    emitters: [
      { source: 'outer.summon', grant: { kind: 'drone', drones: 20 } },
      { source: 'hub', grant: { kind: 'drone', drones: 10, name: 'b' } },
    ],
  },
);

/**
 * C5.2's swarm, 蜂巢's signature, over THORNS_STATS' base (crits, ignites and maskProbeMods())
 * with a chain jump: three drones fly out at the farthest enemies, and each impact is a counted
 * attack and shot whose target takes the primary hit, every other enemy in its splash a hit, and
 * whose chain jumps once, all rolling on the combat stream; each impact raises droneImpact, whose
 * trigger poisons the target with two stacks. The impacts deal the swarm's share of the damage
 * stat (re-recorded by C5.R, which tuned it). A test module sets the swarm's turrets to 0 (IS23),
 * so C5.4's turrets re-record neither entry. `swarmRepeat` adds C4.9's 回聲 (every fifth impact,
 * one repeat at half damage, now) and 多重施法 (every twelfth, two full repeats with the next
 * impact): impacts of no drone at the farthest enemy in the arena, on the effects stream, which
 * raise no droneImpact.
 */
const SWARM_POISON: TriggerSpec = {
  on: 'droneImpact',
  do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }],
};
const SWARM_VALUES = {
  damage: 5,
  maxLife: 1e6,
  critChance: 0.2,
  critMultiplier: 2,
  igniteChance: 0.3,
  chainCount: 1,
};
const SWARM_STATS = makeStats(SWARM_VALUES, maskProbeMods(), {
  triggers: [{ source: 'center', spec: SWARM_POISON }],
  conversions: [],
  emitters: [],
});
const SWARM_REPEAT_STATS = makeStats(SWARM_VALUES, maskProbeMods(), {
  triggers: [
    { source: 'center', spec: SWARM_POISON },
    ...REPEAT_TRIGGERS.slice(0, 2).map(([source, spec]) => ({ source, spec })),
  ],
  conversions: [],
  emitters: [],
});
/** The swarm without turrets (IS23). */
const noTurrets = (): TestModule[] => [
  (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) swarm.turrets = 0;
  },
];

/**
 * C5.4's turrets. `swarmTurret` is the swarm entry with its turret, at attackSpeed 8 and
 * projectileCount 3: four firings a second from its seat between the drones, each a counted
 * attack of two homing shots of the pool (projectileCount − 1) at the enemies nearest to the
 * seat, whose arrivals are the attack's primary hits, each chaining once; its drones fly at twice
 * the base frequency. `turretGrant` is M1's volley with a granted {turrets: 2} on outer.summon
 * over the drones entry's base: two turrets and no drone, seated at angles 0 and π, each firing
 * M1's projectileCount of 2 shots twice a second, which land as plain hits. Both crit and ignite
 * on the combat stream. `swarmTurret` was re-recorded with the swarm entry by C5.R, which tuned
 * the turret's share as well as the impacts'.
 */
const SWARM_TURRET_STATS = makeStats(
  { ...SWARM_VALUES, attackSpeed: 8, projectileCount: 3 },
  maskProbeMods(),
  { triggers: [{ source: 'center', spec: SWARM_POISON }], conversions: [], emitters: [] },
);
const TURRET_GRANT_STATS = makeStats(
  { damage: 5, maxLife: 1e6, critChance: 0.2, critMultiplier: 2, igniteChance: 0.3 },
  maskProbeMods(),
  {
    triggers: [],
    conversions: [],
    emitters: [{ source: 'outer.summon', grant: { kind: 'drone', turrets: 2 } }],
  },
);

/**
 * C4.21's aura and orbit grants beside M1's volley, over the drones entry's base (crits, ignites
 * and maskProbeMods()) with poison rolls: an aura on outer.aura within an auraRadius of 120,
 * every fourth pulse merged at × 4 (聚能脈衝) and a corona (日冕) on every alive enemy every 2 s at
 * half a pulse; a plain aura on the hub at 15%; and two orbit rings on outer.aura, each with the
 * orbitCount stat's whole 1 added: ring 0's 3 orbs at its 0.5 s cooldown and ring 1's (雙軌) 2 at
 * 0.25 s. Every hit rolls on the combat stream.
 */
const AURA_ORBIT_STATS = makeStats(
  {
    damage: 5,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.3,
    poisonChance: 0.2,
    auraRadius: 120,
    orbitCount: 1.5,
  },
  maskProbeMods(),
  {
    triggers: [],
    conversions: [],
    emitters: [
      {
        source: 'outer.aura',
        grant: {
          kind: 'aura',
          everyNth: { n: 4, mult: 4 },
          corona: { periodSec: 2, damagePct: 0.5 },
        },
      },
      { source: 'hub', grant: { kind: 'aura', damagePct: 0.15 } },
      { source: 'outer.aura', grant: { kind: 'orbit', count: 2 } },
      { source: 'outer.aura', grant: { kind: 'orbit', ring: 1, count: 1, cooldownSec: 0.25 } },
    ],
  },
);

/**
 * C6.6's character runs (docs/v3 C6 design §5.4), one per v3 character: its signature, its rules
 * at their boards' sources (CharacterRun) and a fusion's trigger at the fusion's coefficient,
 * over maskProbeMods(). Together they pin who a character run credits its damage to (D8), its
 * jump rows, its sourced rules and the coefficient (D9, D10).
 *
 * `v3fire` (熔核): magma bombs, two a firing, under 火山 (periodSec 1, twice the radius, three
 * times the damage) with eternalFlame's longer, uncapped burns, both rules at the center; the
 * bombs ignite, poison and chain once, and a status bonus raises the center's damage on poisoned
 * enemies. Its explode trigger, on fusion.fire.poison at coef 1.5, fans two poison stacks out
 * over the blast's list at 1.5 × their damage. The bombs, their fire zones and their burns are
 * the center's, their hits' poison outer.poison's, their jumps outer.lightning's and the fusion's
 * poison the fusion's.
 */
const V3_STATUS_BONUS: Modifier = {
  stat: 'damage',
  kind: 'increased',
  value: 0.2,
  scope: 'center',
  when: [{ targetHas: 'poison' }],
};
const V3_FIRE_STATS = makeStats(
  {
    damage: 8,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.3,
    poisonChance: 0.2,
    chainCount: 1,
    attackSpeed: 6,
    projectileCount: 2,
  },
  [...maskProbeMods(), V3_STATUS_BONUS],
  {
    triggers: [
      {
        source: 'fusion.fire.poison',
        spec: { on: 'explode', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }] },
        coef: 1.5,
      },
    ],
    conversions: [],
    emitters: [],
  },
);

/**
 * `v3ice` (霜晶): the ice fan, 3.125 rounds a second of 5.5 cones, chilling and igniting, with
 * steadyAim on every fourth cone on outer.crit; each freeze sets off fusion.ice.crit's slash,
 * which always crits, at coef 0.8. The fan's hits and the shatters are the center's (frost is its
 * own), their burns outer.fire's, the slashes and their burns the fusion's; outer.lightning is
 * numbered though nothing chains.
 */
const V3_ICE_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.3,
    frostOnHit: 0.15,
    attackSpeed: 5,
    projectileCount: 2.5,
  },
  maskProbeMods(),
  {
    triggers: [
      {
        source: 'fusion.ice.crit',
        spec: {
          on: 'freeze',
          do: [
            {
              kind: 'slashLine',
              length: 300,
              width: 24,
              damagePct: 1,
              alwaysCrit: true,
              critScale: 1,
              from: 'target',
              toward: 'outward',
            },
          ],
        },
        coef: 0.8,
      },
    ],
    conversions: [],
    emitters: [],
  },
);

/**
 * `v3lightning` (雷塔): the three-phase arc at chainCount 1, under overload at the center (twice
 * the chain count, 0.2 less retention, chain hits 50% more); each chain jump has
 * fusion.lightning.poison's chance, 0.3 × coef 2, to poison its target with two stacks. The arc's
 * hits and jumps stay the center's, as does its shock; the base ignite chance's burns are
 * outer.fire's and the fusion's poison the fusion's.
 */
const V3_LIGHTNING_STATS = makeStats(
  { damage: 6, maxLife: 1e6, critChance: 0.2, critMultiplier: 2, chainCount: 1, attackSpeed: 4 },
  maskProbeMods(),
  {
    triggers: [
      {
        source: 'fusion.lightning.poison',
        spec: { on: 'chainJump', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }] },
        coef: 2,
      },
    ],
    conversions: [],
    emitters: [],
  },
);

/**
 * `v3summon` (蜂巢): the swarm with its turret over the swarm entry's base (crits, ignites and a
 * chain jump), under glassCannon on the hub; its max life of 1 ends the run at the first contact,
 * so the swarm hits harder (damage 40, attackSpeed 8 and projectileCount 3) and holds wave 12
 * off for the whole run. Each impact raises droneImpact, whose trigger on fusion.summon.poison
 * poisons the target with two stacks at coef 1.2. The impacts and the turret's shots are the
 * center's, their jumps outer.lightning's, their burns outer.fire's and the fusion's poison the
 * fusion's; the hub's row stays 0.
 */
const V3_SUMMON_STATS = makeStats(
  { ...SWARM_VALUES, damage: 40, attackSpeed: 8, projectileCount: 3 },
  maskProbeMods(),
  {
    triggers: [
      {
        source: 'fusion.summon.poison',
        spec: { on: 'droneImpact', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }] },
        coef: 1.2,
      },
    ],
    conversions: [],
    emitters: [],
  },
);

/**
 * C7.2's player defences (docs/v3 C7 design §2.2) on M1's test data, which they need no v3 data
 * for: contact damage ×0.8, 1% of max life regained a second, one extra life, and ◆波次護盾's
 * shield at each wave start, 20% of max life refreshed to at most 20% (lead ruling L3), on 40 of
 * max life. The damage, about half of wave 18's standard hp, lets enemies through yet holds the
 * run past two wave starts: at the second, in both seeds, the first shield is still whole and
 * the cap keeps it at 8. Each seed's run absorbs, regenerates, revives once at 20 of life and
 * ends in the final death with its killer.
 */
const DEFENCE_STATS = makeStats(
  { damage: 225, maxLife: 40, lifeRegen: 0.01, contactDamageTaken: 0.8, extraLives: 1 },
  [],
  {
    triggers: [
      {
        source: 'center',
        spec: { on: 'waveStart', do: [{ kind: 'shield', lifePct: 0.2, capPct: 0.2 }] },
      },
    ],
    conversions: [],
    emitters: [],
  },
);

/**
 * C7.5's enemy cap (docs/v3 C7 design §2.3): a v3 table of M1's fixture types with a cap of 60
 * and a wave every 2 s, and no elite, boss, affix or treasure (§1.9; TEST_V3_WAVES.v3 spread, as
 * v3TestData's merge is shallow). Damage 500 on BASE_STATS' volley, with too much life to die,
 * no longer holds the field from about wave 18: the cap delays releases, oldest wave first, skips
 * the shards of pentagons that die at it, and leaves waves 18 to 21 open at the end.
 */
const CAP_STATS = makeStats({ damage: 500, maxLife: 1e6 });
const capData = (): GameData =>
  v3TestData({
    waves: {
      rules: TEST_WAVES.rules,
      eliteEvery: 1000,
      bossEvery: 1000,
      waveTimerSec: 2,
      v3: {
        ...TEST_V3_WAVES.v3,
        enemyCap: 60,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });

/**
 * C7.3's enemy defences (docs/v3 C7 design §2.4) on a v3 run of squares and shielders from wave
 * 1 (TEST_WAVES' square rule and TEST_V3_WAVES' shielder rule, each from wave 1), with no affix,
 * treasure, elite or boss (§1.9). The volley's hits of 10, 15 on a crit, are below 15 % of a
 * shielder's max life from wave 12 on (134 at wave 12, 227 by wave 14), so its shield blocks
 * every one; yet they burn and, through a poison-tagged ailmentOnBlock (滲透), poison it, and
 * those kill shielders.
 * armouredSquares() armours every square: a plain hit lands 5, a crit 15 whole, through a
 * crit-tagged ignoreArmour (破甲). The build converts nothing: OWN test 2
 * (src/sim/combat/defend.test.ts) pins the per-part tallies.
 */
const ENEMY_DEFENCE_STATS = makeStats({ critChance: 0.3, poisonChance: 0.5, igniteChance: 0.3 }, [
  { stat: 'ignoreArmour', kind: 'flat', value: 1, tags: ['crit'] },
  { stat: 'ailmentOnBlock', kind: 'flat', value: 1, tags: ['poison'] },
]);

const enemyDefenceData = (): GameData =>
  v3TestData({
    waves: {
      rules: [
        { enemy: 'square', fromWave: 1, base: 2, perWave: 0.3, maxCount: 20 },
        { enemy: 'shielder', fromWave: 1, base: 1, perWave: 0.2, maxCount: 8 },
      ],
      eliteEvery: 1000,
      bossEvery: 1000,
      v3: {
        ...TEST_V3_WAVES.v3,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });

/**
 * Armours every square of the run (ARMOURED on its record) before its first defended hit, as
 * C7.6's 堅甲 will at spawn: a test module has no spawn hook, and both hit paths run the
 * modifyDamage hooks before an enemy's defences, so this hook, which leaves the amount alone,
 * reaches every hit they defend, thorns, shatters and drone impacts among them (lead ruling V5).
 */
function armouredSquares(): TestModule {
  return (b) =>
    b.hook('modifyDamage', (_ctx, hit, amount) => {
      const v3 = hit.target.v3;
      if (v3 !== null && hit.target.type === 'square') v3.defence |= ARMOURED;
      return amount;
    });
}

/**
 * C7.4a's enemy behaviours (docs/v3 C7 design §2.5) on a v3 run of regenerators and dashers from
 * wave 1 (TEST_V3_WAVES' rules, each from wave 1) and a treasure every wave from wave 12, with no
 * affix, elite or boss (§1.9). frostOnHit chills what the volley hits, so 凍結生機 (enemyRegen
 * −80 % on a target holding frost) slows a chilled regenerator's 8 %/s, and burns stop it; 迎擊
 * (damage ×2 on a dashing target) doubles the hits on dashing dashers; bleedChance bleeds the
 * treasure, whose orbit and flight count as moving. The treasure holds 8 × the standard hp, 4 ×
 * its def's: at its def's 2 the volley kills every treasure before its flight in both seeds, and
 * the entry pins the flight and the escape.
 */
const REGEN_DASH_STATS = makeStats({ frostOnHit: 0.1, bleedChance: 0.3 }, [
  { stat: 'enemyRegen', kind: 'more', value: -0.8, when: [{ targetHas: 'frost' }] },
  { stat: 'damage', kind: 'more', value: 1, when: [{ targetState: 'dashing' }] },
]);
const regenDasherTreasureData = (): GameData =>
  v3TestData({
    enemies: { treasure: { hpMult: 8 } },
    waves: {
      rules: [
        { enemy: 'regenerator', fromWave: 1, base: 1, perWave: 0.2, maxCount: 8 },
        { enemy: 'dasher', fromWave: 1, base: 1, perWave: 0.2, maxCount: 8 },
      ],
      eliteEvery: 1000,
      bossEvery: 1000,
      v3: {
        ...TEST_V3_WAVES.v3,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 12, every: 1 },
      },
    },
  });

/**
 * C7.4b's shooters and summoners (docs/v3 C7 design §2.6) on a v3 run of both from wave 1, 8
 * shooters and 20 summoners a wave (the design names no count: at TEST_V3_WAVES' 1 + 0.2 a wave
 * the field never comes near the cap within the run), with a cap of 120 and no affix, treasure,
 * elite or boss (§1.9; TEST_V3_WAVES.v3 spread, as v3TestData's merge is shallow). A mid build,
 * damage 20 on BASE_STATS' volley with one extra life, takes contacts at ×0.05
 * (contactDamageTaken), which bullets skip: at ×1 the summoned triangles end the run near tick
 * 580, before the field fills. In both seeds the shooters fire from their posts, a bullet takes
 * the first life, bullets hit the revived life, the summons fill the field to the cap near tick
 * 1,000 and skip children there, and a bullet ends the run.
 */
const SHOOTER_SUMMONER_STATS = makeStats({ damage: 20, extraLives: 1, contactDamageTaken: 0.05 });
const shooterSummonerData = (): GameData =>
  v3TestData({
    waves: {
      rules: [
        { enemy: 'shooter', fromWave: 1, base: 8, perWave: 0, maxCount: 8 },
        { enemy: 'summoner', fromWave: 1, base: 20, perWave: 0, maxCount: 20 },
      ],
      eliteEvery: 1000,
      bossEvery: 1000,
      v3: {
        ...TEST_V3_WAVES.v3,
        enemyCap: 120,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });

/** The entries, in the order their commits appended them. */
const ENTRIES: readonly GoldenC4Entry[] = [
  {
    name: 'shots/testModule',
    config: { ...GOLDEN_BUILDS.bridges, startWave: 8 },
    modules: () => [shotsModule()],
    expected: ['d32decc45c4cb5c1', 'a3baa3324af324b2'],
  },
  {
    name: 'thorns',
    config: { stats: THORNS_STATS, rules: [], startWave: 12 },
    expected: ['1c1cd0d3599dd96f', 'ed95f74a4c91e215'],
  },
  {
    name: 'selector',
    config: { stats: SELECTOR_STATS, rules: [], startWave: 12 },
    expected: ['99d18b8ccc385a7d', '24db421f1d9a6487'],
  },
  {
    name: 'freezeList',
    config: { stats: FREEZE_LIST_STATS, rules: [], startWave: 12 },
    expected: ['fdeaad52c97e75ea', 'fcecca54bd30e778'],
  },
  {
    name: 'zones',
    config: { stats: ZONE_STATS, rules: [], startWave: 12 },
    expected: ['b81f40b410726fde', '3e6d00ae23ad0068'],
  },
  {
    name: 'magmaBomb',
    config: {
      stats: MAGMA_STATS,
      rules: [{ id: 'steadyAim', everyNth: 4, critMultiplierMore: 0.5, counts: 'shot' }],
      signature: { id: 'magmaBomb' },
      startWave: 12,
    },
    modules: () => [slowFireModule()],
    expected: ['0da35025faedd08b', '334e99690a535150'],
  },
  {
    name: 'lobForms',
    config: {
      stats: LOB_FORM_STATS,
      rules: [FAR_THROW, { id: 'chainBlast', radius: 40, damagePct: 0.5, perBomb: 2 }],
      signature: { id: 'magmaBomb' },
      startWave: 12,
    },
    expected: ['60a1953db6c61037', 'cce99037eda62095'],
  },
  {
    name: 'volcano',
    config: {
      stats: LOB_FORM_STATS,
      rules: [{ id: 'volcano', periodSec: 3, radiusMult: 3, damageMult: 5 }, FAR_THROW],
      signature: { id: 'magmaBomb' },
      startWave: 12,
    },
    expected: ['24277606333be1f9', 'afa4bc2dec7da67c'],
  },
  {
    name: 'repeat',
    config: { stats: REPEAT_STATS, rules: [], startWave: 12 },
    expected: ['98990a1fd39d8f45', '8cdd0b7edfebf481'],
  },
  {
    name: 'repeatLob',
    config: {
      stats: REPEAT_LOB_STATS,
      rules: [{ id: 'steadyAim', everyNth: 4, critMultiplierMore: 0.5, counts: 'shot' }],
      signature: { id: 'magmaBomb' },
      startWave: 12,
    },
    expected: ['1bb62573bf834d27', 'b9ea74917d7d6e1e'],
  },
  {
    name: 'detonate',
    config: { stats: DETONATE_STATS, rules: [], startWave: 12 },
    expected: ['7d2fd5f83ec324ff', '9f3742425233f89b'],
  },
  {
    name: 'splitChildren',
    config: { stats: SPLIT_STATS, rules: [], startWave: 12 },
    data: splitData,
    expected: ['e2045f8b27967b7c', '38b84da29c1e58e6'],
  },
  {
    name: 'projectiles',
    config: { stats: PROJECTILES_STATS, rules: [], startWave: 12 },
    expected: ['67db1660d5f8b4f9', 'c977d99b8cea8a4c'],
  },
  {
    name: 'slashCoin',
    config: { stats: SLASH_COIN_STATS, rules: [], startWave: 12 },
    expected: ['d6f12b8bbb528bfb', '27b2f38e6d4dacc2'],
  },
  {
    name: 'segments',
    config: { stats: SEGMENT_STATS, rules: [], startWave: 12 },
    expected: ['a2136f80c726b22c', 'f6cab0da957c63a6'],
  },
  {
    name: 'policy',
    config: { stats: POLICY_STATS, rules: [], startWave: 12 },
    modules: policyModules,
    expected: ['cb7ffbd5c0903d08', '587188bee3ffe3da'],
  },
  {
    name: 'chainBolt',
    config: { stats: CHAIN_BOLT_STATS, rules: [], startWave: 12 },
    expected: ['deadf0cee6495706', '06f8577e803a60f4'],
  },
  {
    name: 'strike',
    config: { stats: STRIKE_STATS, rules: [], startWave: 12 },
    expected: ['2164cf2e374eae13', '9eee8e2dc745d1d0'],
  },
  {
    name: 'iceFan',
    config: {
      stats: ICE_FAN_STATS,
      rules: [
        { id: 'icicle', every: 4, damagePct: 4 },
        { id: 'steadyAim', everyNth: 4, critMultiplierMore: 0.5, counts: 'shot' },
      ],
      signature: { id: 'iceFan' },
      startWave: 12,
    },
    expected: ['527efef683bfb207', '992e37c19000ccfb'],
  },
  {
    name: 'triphaseArc',
    config: {
      stats: ARC_STATS,
      rules: [
        { id: 'sixCoils', coils: 6, targets: 2, damageMult: 0.55 },
        { id: 'steadyAim', everyNth: 4, critMultiplierMore: 0.5, counts: 'shot' },
      ],
      signature: { id: 'triphaseArc' },
      startWave: 12,
    },
    modules: arcModules,
    expected: ['ed41b60b5b8bfa02', 'cfb324913970c72d'],
  },
  {
    name: 'drones',
    config: { stats: DRONES_STATS, rules: [], startWave: 12 },
    expected: ['0b2acdc6eba99e20', '973d883bbf10c1f5'],
  },
  {
    name: 'droneCap',
    config: { stats: DRONE_CAP_STATS, rules: [], startWave: 12 },
    expected: ['984d118c8a9be135', 'edf5fbf5bd1b0248'],
  },
  {
    name: 'swarm',
    config: { stats: SWARM_STATS, rules: [], signature: { id: 'swarm' }, startWave: 12 },
    modules: noTurrets,
    expected: ['29669ce548d99228', 'a6cee7abf0236a2a'],
  },
  {
    name: 'swarmRepeat',
    config: { stats: SWARM_REPEAT_STATS, rules: [], signature: { id: 'swarm' }, startWave: 12 },
    modules: noTurrets,
    expected: ['10fc1903c337cc7d', '2b40eafc3cef9da4'],
  },
  {
    name: 'swarmTurret',
    config: { stats: SWARM_TURRET_STATS, rules: [], signature: { id: 'swarm' }, startWave: 12 },
    expected: ['0692f944079bbf18', '4a718924bc436d83'],
  },
  {
    name: 'turretGrant',
    config: { stats: TURRET_GRANT_STATS, rules: [], startWave: 12 },
    expected: ['8a777f4c0552d30e', 'fb814938ecce6f51'],
  },
  {
    name: 'auraOrbit',
    config: { stats: AURA_ORBIT_STATS, rules: [], startWave: 12 },
    expected: ['c51b22133cb0e4a3', '3570db88979fdb90'],
  },
  {
    name: 'v3fire',
    config: {
      stats: V3_FIRE_STATS,
      rules: [],
      signature: { id: 'magmaBomb' },
      character: {
        id: 'fire',
        rules: [
          { source: 'center', spec: { id: 'eternalFlame', durationMore: 0.5 }, coef: 1 },
          {
            source: 'center',
            spec: { id: 'volcano', periodSec: 1, radiusMult: 2, damageMult: 3 },
            coef: 1,
          },
        ],
      },
      startWave: 12,
    },
    expected: ['0ff0fa2f75385e27', '7db1f6ed925dc1ba'],
  },
  {
    name: 'v3ice',
    config: {
      stats: V3_ICE_STATS,
      rules: [],
      signature: { id: 'iceFan' },
      character: {
        id: 'ice',
        rules: [
          {
            source: 'outer.crit',
            spec: { id: 'steadyAim', everyNth: 4, critMultiplierMore: 0.5, counts: 'shot' },
            coef: 1,
          },
        ],
      },
      startWave: 12,
    },
    expected: ['75d7b40db114dfc0', 'cb670b31d3706200'],
  },
  {
    name: 'v3lightning',
    config: {
      stats: V3_LIGHTNING_STATS,
      rules: [],
      signature: { id: 'triphaseArc' },
      character: {
        id: 'lightning',
        rules: [
          {
            source: 'center',
            spec: {
              id: 'overload',
              chainCountMultiplier: 2,
              retentionPenalty: 0.2,
              chainMore: 0.5,
            },
            coef: 1,
          },
        ],
      },
      startWave: 12,
    },
    expected: ['91921960d5e13d28', '033e1fd4a062dc89'],
  },
  {
    name: 'v3summon',
    config: {
      stats: V3_SUMMON_STATS,
      rules: [],
      signature: { id: 'swarm' },
      character: {
        id: 'summon',
        rules: [{ source: 'hub', spec: { id: 'glassCannon', damageMore: 1 }, coef: 1 }],
      },
      startWave: 12,
    },
    expected: ['355df9aee23cbec2', '84d7dbc4c3567175'],
  },
  {
    name: 'playerDefences',
    config: { stats: DEFENCE_STATS, rules: [], startWave: 18 },
    expected: ['aaa8ac053dc61595', '24d4554bfbb72122'],
  },
  {
    name: 'enemyCap',
    config: { stats: CAP_STATS, rules: [], startWave: 12 },
    data: capData,
    expected: ['424fdd97731eb9b8', 'edcf2e91fba84fbf'],
  },
  {
    name: 'enemyDefences',
    config: { stats: ENEMY_DEFENCE_STATS, rules: [], startWave: 12 },
    data: enemyDefenceData,
    modules: () => [armouredSquares()],
    expected: ['8915e4088942086b', '3d3d5bdb7f1cc85c'],
  },
  {
    name: 'regenDasherTreasure',
    config: { stats: REGEN_DASH_STATS, rules: [], startWave: 12 },
    data: regenDasherTreasureData,
    expected: ['4788017e5f438056', '1e13679b1acb27bd'],
  },
  {
    name: 'shooterSummoner',
    config: { stats: SHOOTER_SUMMONER_STATS, rules: [], startWave: 12 },
    data: shooterSummonerData,
    expected: ['b0267c6a4aa2d8d1', '90a15c629a900259'],
  },
];

/** [id, value] of each counter that is not 0, in COUNTER_IDS order. */
function nonzeroCounters(counters: Readonly<Record<CounterId, number>>): [CounterId, number][] {
  return COUNTER_IDS.filter((id) => counters[id] !== 0).map((id) => [id, counters[id]]);
}

/**
 * The first 16 hex digits of the SHA-256 of every tick's events, whole, then the result's M1
 * fields, damage per source and nonzero counters.
 */
function goldenC4Hash(
  config: RunConfig,
  data: GameData,
  modules: readonly TestModule[] = [],
): string {
  const sim = createSimulation(config, data, modules);
  const hash = createHash('sha256');
  while (!sim.state.finished) hash.update(JSON.stringify(sim.step(NO_INPUT)));
  const result = sim.result();
  hash.update(
    JSON.stringify([
      projectResult(result),
      result.damageBySource,
      nonzeroCounters(result.counters),
    ]),
  );
  return hash.digest('hex').slice(0, 16);
}

/** One entry at one seed, hashed twice. */
function runCase(entry: GoldenC4Entry, seed: number): [string, string] {
  const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
  const once = (): string =>
    goldenC4Hash(config, entry.data?.() ?? makeTestData(), entry.modules?.() ?? []);
  return [once(), once()];
}

describe('golden C4 runner', () => {
  it('lists the counters that are not 0, in COUNTER_IDS order', () => {
    const counters = Object.fromEntries(COUNTER_IDS.map((id) => [id, 0])) as Record<
      CounterId,
      number
    >;
    expect(nonzeroCounters(counters)).toEqual([]);
    const [first, second] = COUNTER_IDS;
    const last = COUNTER_IDS.at(-1) as CounterId;
    counters[last] = 2;
    counters[first] = 7;
    expect(nonzeroCounters(counters)).toEqual([
      [first, 7],
      [last, 2],
    ]);
    counters[second] = -1;
    expect(nonzeroCounters(counters)).toEqual([
      [first, 7],
      [second, -1],
      [last, 2],
    ]);
  });

  it('hashes a run the same twice, and another seed or build differently', () => {
    const data = makeTestData();
    const hashOf = (build: keyof typeof GOLDEN_BUILDS, seed: number): string =>
      goldenC4Hash(
        makeConfig({ ...GOLDEN_BUILDS[build], seed, startWave: 8, maxTicks: GOLDEN_C4_TICKS }),
        data,
      );
    const chain = hashOf('chain', 1);
    expect(chain).toMatch(/^[0-9a-f]{16}$/);
    expect(hashOf('chain', 1)).toBe(chain);
    expect(hashOf('chain', 2)).not.toBe(chain);
    expect(hashOf('pandemic', 1)).not.toBe(chain);
  });
});

describe('golden C4 runs', () => {
  const cases = ENTRIES.flatMap((entry) =>
    GOLDEN_C4_SEEDS.map((seed, i) => ({
      id: `${entry.name}/s${seed}`,
      entry,
      seed,
      expected: entry.expected[i] as string,
    })),
  );

  it('names every entry once and records a hash per seed', () => {
    const names = ENTRIES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const { id, expected } of cases) expect(expected, id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('fires no turret in swarm and swarmRepeat, so only the impact share moves them, and fires swarmTurret’s (IS23, C5.R)', () => {
    const turretFires = (name: string): number => {
      const entry = ENTRIES.find((e) => e.name === name) as GoldenC4Entry;
      const config = makeConfig({ ...entry.config, seed: 1, maxTicks: GOLDEN_C4_TICKS });
      const sim = createSimulation(
        config,
        entry.data?.() ?? makeTestData(),
        entry.modules?.() ?? [],
      );
      let fires = 0;
      while (!sim.state.finished) {
        for (const event of sim.step(NO_INPUT)) if (event.type === 'turretFire') fires++;
      }
      return fires;
    };
    expect([turretFires('swarm'), turretFires('swarmRepeat')]).toEqual([0, 0]);
    expect(turretFires('swarmTurret')).toBeGreaterThan(0);
  });

  it('blocks every hit on a shielder in enemyDefences, which still burns and poisons it, halves a square’s plain hits and lands its crits whole (C7.3)', () => {
    const entry = ENTRIES.find((e) => e.name === 'enemyDefences') as GoldenC4Entry;
    for (const seed of GOLDEN_C4_SEEDS) {
      const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
      const sim = createSimulation(
        config,
        entry.data?.() ?? makeTestData(),
        entry.modules?.() ?? [],
      );
      const types = new Map<number, EnemyId>();
      const seen = new Set<string>();
      while (!sim.state.finished) {
        const blocked = new Set<number>();
        for (const event of sim.step(NO_INPUT)) {
          if (event.type === 'enemySpawned') types.set(event.enemyId, event.enemy);
          else if (event.type === 'hitBlocked') {
            blocked.add(event.targetId);
            seen.add(`${types.get(event.targetId)} blocks ${toNumber(event.amount)}`);
          } else if (event.type === 'hit') {
            seen.add(`${types.get(event.targetId)} takes ${toNumber(event.amount)}`);
          } else if (event.type === 'ignite' && blocked.has(event.targetId)) {
            seen.add('burn on a block');
          } else if (event.type === 'ailmentApplied' && blocked.has(event.targetId)) {
            seen.add(`${event.ailment} on a block`);
          }
        }
      }
      expect([...seen].sort(), `seed ${seed}`).toEqual([
        'burn on a block',
        'poison on a block',
        'shielder blocks 10',
        'shielder blocks 15',
        'square takes 15',
        'square takes 5',
      ]);
    }
  });

  it('regenerates, slower chilled and not while burning, charges and dashes, doubling the hits on dashing dashers, and lets a treasure circle, flee and escape in regenDasherTreasure (C7.4a)', () => {
    const entry = ENTRIES.find((e) => e.name === 'regenDasherTreasure') as GoldenC4Entry;
    const bySeed: Record<number, string[]> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const seen = new Set<string>();
      const watched: { ctx: RunContext | null } = { ctx: null };
      // Each regenerator's hp at the end of the last tick; each dasher's charge tick and frozen
      // ticks since; each treasure's ticks of orbit, frozen ones and last distance.
      const lastHp = new Map<number, number>();
      const charges = new Map<number, { at: number; frozen: number }>();
      const orbits = new Map<number, { ticks: number; frozen: number; dist: number }>();
      const fleeing = new Map<number, number>();
      let dashing = new Set<number>();
      const watch: TestModule = (b) =>
        void b.hook('tick', (ctx) => {
          // After the enemy AI step and movement, before this tick's hits.
          watched.ctx = ctx;
          const now = ctx.now;
          dashing = new Set();
          for (const e of ctx.enemies) {
            const v = e.v3;
            if (!e.alive || v === null) continue;
            const frozen = e.frozenUntil > now;
            if (e.type === 'regenerator') {
              const before = lastHp.get(e.id);
              const max = toNumber(e.maxHp);
              if (before === undefined || before >= max) continue;
              const gain = toNumber(e.hp) - before;
              const rate = frostMeter(e, now) > 0 ? 0.08 * 0.2 : 0.08;
              const full = max * rate * DT;
              if (holdsBurn(e, now))
                seen.add(gain === 0 ? 'no regen while burning' : 'regen burning');
              else if (Math.abs(gain - full) <= 1e-9 * full) {
                seen.add(rate === 0.08 ? 'regen 8 %/s' : 'regen 1.6 %/s chilled');
              } else if (toNumber(e.hp) === max && gain < full) seen.add('regen up to max life');
              else seen.add(`regen ${gain / (max * DT)}/s`);
            } else if (e.type === 'dasher') {
              if (v.state === DASHING) dashing.add(e.id);
              const charge = charges.get(e.id);
              if (charge !== undefined && (v.state & CHARGING) !== 0 && frozen) charge.frozen++;
            } else if (e.type === 'treasure') {
              const orbit = orbits.get(e.id) ?? { ticks: 0, frozen: 0, dist: e.dist };
              if (v.state === ORBITING) {
                orbits.set(e.id, {
                  ...orbit,
                  ticks: orbit.ticks + 1,
                  frozen: orbit.frozen + (frozen ? 1 : 0),
                });
                if (e.dist <= 480 && e.dist > 480 - 2.5) seen.add('treasure circles at 480');
                else seen.add(`treasure circles at ${e.dist}`);
              } else if (v.state === FLEEING) {
                const last = fleeing.get(e.id);
                if (last !== undefined) {
                  seen.add(
                    e.dist > last
                      ? 'treasure flees out'
                      : frozen
                        ? 'treasure frozen in flight'
                        : 'treasure flees slowed to a stop',
                  );
                }
                fleeing.set(e.id, e.dist);
              }
            }
          }
        });
      const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
      const sim = createSimulation(config, entry.data?.() ?? makeTestData(), [watch]);
      const types = new Map<number, EnemyId>();
      while (!sim.state.finished) {
        const now = sim.state.tick + 1;
        for (const event of sim.step(NO_INPUT)) {
          if (event.type === 'enemySpawned') types.set(event.enemyId, event.enemy);
          else if (event.type === 'dasherCharge') {
            const ctx = watched.ctx as RunContext;
            const dasher = ctx.enemies.find((e) => e.id === event.enemyId);
            seen.add(
              dasher !== undefined && dasher.dist <= 420
                ? 'dasher charges at 420 or closer'
                : 'dasher charges far',
            );
            charges.set(event.enemyId, { at: now, frozen: 0 });
          } else if (event.type === 'dasherDash') {
            const charge = charges.get(event.enemyId);
            seen.add(
              charge !== undefined && now - charge.at - charge.frozen === 36
                ? 'dasher dashes 36 unfrozen ticks after its charge'
                : 'dasher dashes off time',
            );
          } else if (event.type === 'hit' && types.get(event.targetId) === 'dasher') {
            const amount = toNumber(event.amount);
            seen.add(`${dashing.has(event.targetId) ? 'dashing ' : ''}dasher takes ${amount}`);
          } else if (event.type === 'treasureEscaped') {
            const orbit = orbits.get(event.enemyId);
            const r = 14;
            const outside =
              event.x <= -r ||
              event.x >= ARENA_WIDTH + r ||
              event.y <= -r ||
              event.y >= ARENA_HEIGHT + r;
            seen.add(outside ? 'treasure escapes past the edge' : 'treasure escapes inside');
            seen.add(
              `treasure escapes after ${orbit === undefined ? 0 : orbit.ticks - orbit.frozen} unfrozen ticks of orbit`,
            );
          } else if (event.type === 'enemyKilled' && event.enemy === 'treasure') {
            seen.add(`treasure killed: ${event.cores} core`);
          } else if (event.type === 'playerHit' && types.get(event.enemyId) === 'treasure') {
            seen.add('treasure hits the player');
          }
        }
        const ctx = watched.ctx;
        if (ctx === null) continue;
        for (const e of ctx.enemies) {
          if (e.alive && e.type === 'regenerator') lastHp.set(e.id, toNumber(e.hp));
        }
      }
      bySeed[seed] = [...seen].sort();
    }
    // Each seed regenerates at both rates and not while burning, charges and dashes on time,
    // doubles the hits on dashing dashers (10 a hit, 15 a crit) and lets one treasure escape.
    const pins = [
      'dasher charges at 420 or closer',
      'dasher dashes 36 unfrozen ticks after its charge',
      'dasher takes 10',
      'dasher takes 15',
      'dashing dasher takes 20',
      'no regen while burning',
      'regen 1.6 %/s chilled',
      'regen 8 %/s',
      'treasure circles at 480',
      'treasure escapes after 480 unfrozen ticks of orbit',
      'treasure escapes past the edge',
      'treasure flees out',
    ];
    expect(bySeed).toEqual({ 1: pins, 2: pins });
  });

  it('stops shooters within a step of 300 and summoners of 480, fires every 120 ticks and summons every 180 from a period after each stops, lands each bullet ceil((d − 36) / (200/60)) ticks after its shot, tallies the bullets in bulletTakenBy alone, revives on a bullet and dies to one, and summons extra children in their summoner’s wave through the cap in shooterSummoner (C7.4b)', () => {
    const entry = ENTRIES.find((e) => e.name === 'shooterSummoner') as GoldenC4Entry;
    const posts: Partial<Record<EnemyId, { readonly dist: number; readonly period: number }>> = {
      shooter: { dist: 300, period: 120 },
      summoner: { dist: 480, period: 180 },
    };
    const bySeed: Record<number, string[]> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const seen = new Set<string>();
      // Each enemy as first seen: its type, wave and whether it is extra; each shooter's and
      // summoner's stop tick and last act; each bullet in flight's fire tick and distance.
      const enemies = new Map<number, { type: EnemyId; wave: number; extra: boolean }>();
      const stops = new Map<number, number>();
      const acts = new Map<number, number>();
      const shots = new Map<number, { at: number; d: number }>();
      let peak = 0;
      const note = (e: EnemyState): void => {
        if (!enemies.has(e.id)) {
          enemies.set(e.id, { type: e.type, wave: e.wave, extra: e.v3 !== null && e.v3.extra });
        }
      };
      const watch: TestModule = (b) =>
        void b.hook('tick', (ctx) => {
          // After the enemy AI step and movement, before this tick's hits.
          let alive = 0;
          for (const e of ctx.enemies) {
            if (!e.alive) continue;
            alive++;
            note(e);
            const post = posts[e.type];
            if (post === undefined || stops.has(e.id) || e.v3?.state !== STOPPED) continue;
            stops.set(e.id, ctx.now);
            seen.add(
              e.dist <= post.dist && e.dist > post.dist - e.def.speed * DT
                ? `${e.type} stops within a step of ${post.dist}`
                : `${e.type} stops at ${e.dist}`,
            );
          }
          peak = Math.max(peak, alive);
          for (const e of ctx.sys.enemyAi.list) {
            if (e.type === 'triangle') seen.add('a summoned triangle on the AI list');
          }
        });
      const act = (id: number, type: 'shooter' | 'summoner', now: number): void => {
        const { period } = posts[type] as { readonly period: number };
        const last = acts.get(id);
        if (last === undefined) {
          seen.add(
            now - (stops.get(id) ?? -Infinity) === period
              ? `${type} first acts ${period} ticks after it stops`
              : `${type} first acts off time`,
          );
        } else {
          seen.add(
            now - last === period
              ? `${type} acts every ${period} ticks`
              : `${type} acts ${now - last} ticks after its last act`,
          );
        }
        acts.set(id, now);
      };
      const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
      const sim = createSimulation(config, entry.data?.() ?? makeTestData(), [watch]);
      // The bulletHit and playerHit events summed by type, as RunResult tallies them.
      const bullets = new Map<EnemyId, ContactTally>();
      const contacts = new Map<EnemyId, ContactTally>();
      const tally = (sums: Map<EnemyId, ContactTally>, type: EnemyId, damage: number): void => {
        const sum = sums.get(type) ?? { hits: 0, damage: 0 };
        sums.set(type, { hits: sum.hits + 1, damage: sum.damage + damage });
      };
      let children: number[] = [];
      let skipped = 0;
      let revived = false;
      let last: { bullet: boolean; lifeLeft: number } | null = null;
      while (!sim.state.finished) {
        const now = sim.state.tick + 1;
        const events = sim.step(NO_INPUT);
        // The children spawned this tick, which the tick hook saw before their summoned event.
        for (const e of sim.state.enemies) note(e);
        for (const event of events) {
          if (event.type === 'enemySpawned' && event.enemy === 'triangle') {
            children.push(event.enemyId);
          } else if (event.type === 'bulletFired') {
            act(event.enemyId, 'shooter', now);
            const d = Math.hypot(event.x - ARENA_WIDTH / 2, event.y - ARENA_HEIGHT / 2);
            shots.set(event.bulletId, { at: now, d });
          } else if (event.type === 'summoned') {
            act(event.enemyId, 'summoner', now);
            seen.add(event.count === 2 ? 'summoner summons 2' : 'summoner skips at the cap');
            skipped += 2 - event.count;
            // Its children's enemySpawned events come right before it.
            if (children.length !== event.count) seen.add('a triangle spawned outside a summons');
            const wave = enemies.get(event.enemyId)?.wave;
            for (const id of children) {
              const child = enemies.get(id);
              seen.add(
                child?.extra === true && child.wave === wave
                  ? 'summoned children are extra, in their summoner’s wave'
                  : 'a summoned child is not extra or not in its summoner’s wave',
              );
            }
            children = [];
          } else if (event.type === 'bulletHit') {
            tally(bullets, event.enemy, event.damage);
            seen.add(`a bullet hits for ${event.damage}`);
            const shot = shots.get(event.bulletId);
            if (shot !== undefined) {
              const flight = (shot.d - 36) / (200 / 60);
              seen.add(
                Math.abs(flight - Math.round(flight)) < 1e-6
                  ? `a bullet fired at a tie, ${shot.d} away`
                  : now - shot.at === Math.ceil(flight)
                    ? 'a bullet hits ceil((d − 36) / (200/60)) ticks after its shot'
                    : `a bullet hits ${now - shot.at - Math.ceil(flight)} ticks off`,
              );
            }
            if (revived && event.lifeLeft > 0) seen.add('bullets hit the revived life');
            last = { bullet: true, lifeLeft: event.lifeLeft };
          } else if (event.type === 'playerHit') {
            const type = enemies.get(event.enemyId)?.type ?? 'triangle';
            tally(contacts, type, event.damage);
            seen.add(`a ${type} touches for ${event.damage}`);
            last = { bullet: false, lifeLeft: event.lifeLeft };
          } else if (event.type === 'revive') {
            seen.add(
              last?.bullet === true && last.lifeLeft === 0
                ? `a bullet takes the first life, revived at ${event.lifeLeft}`
                : 'a contact takes the first life',
            );
            revived = true;
          } else if (event.type === 'runEnded') {
            seen.add(
              last?.bullet === true && last.lifeLeft === 0
                ? `a bullet ends the run (${event.reason})`
                : `the run ends (${event.reason})`,
            );
          }
        }
      }
      const result = sim.result();
      const sums = (
        taken: Readonly<Record<EnemyId, ContactTally>>,
        events: Map<EnemyId, ContactTally>,
      ): boolean =>
        ENEMY_IDS.every((id) => {
          const sum = events.get(id) ?? { hits: 0, damage: 0 };
          return taken[id].hits === sum.hits && taken[id].damage === sum.damage;
        });
      let leaks = 0;
      for (const sum of contacts.values()) leaks += sum.hits;
      seen.add(`killedBy ${result.killedBy}`);
      seen.add(
        sums(result.bulletTakenBy, bullets)
          ? 'bulletTakenBy sums the bulletHit events'
          : 'bulletTakenBy is not the bulletHit events',
      );
      seen.add(
        sums(result.damageTakenBy, contacts) && result.leaks === leaks
          ? 'damageTakenBy and leaks sum the playerHit events alone'
          : 'damageTakenBy or leaks is not the playerHit events',
      );
      seen.add(
        skipped > 0 && result.counters.enemySpawnsSkipped === skipped
          ? 'enemySpawnsSkipped counts the children skipped'
          : `enemySpawnsSkipped ${result.counters.enemySpawnsSkipped} for ${skipped} skipped`,
      );
      seen.add(peak === 120 ? 'the field fills to the cap of 120' : `the field peaks at ${peak}`);
      bySeed[seed] = [...seen].sort();
    }
    // Each seed stops, fires and summons on time, lands every bullet on time for its 3 whole
    // (a triangle's contact of 8 lands 0.4), revives on a bullet that bullets then hit, fills the
    // field to the cap and skips children there, and dies to a bullet.
    const pins = [
      'a bullet ends the run (death)',
      'a bullet hits ceil((d − 36) / (200/60)) ticks after its shot',
      'a bullet hits for 3',
      'a bullet takes the first life, revived at 50',
      'a triangle touches for 0.4',
      'bulletTakenBy sums the bulletHit events',
      'bullets hit the revived life',
      'damageTakenBy and leaks sum the playerHit events alone',
      'enemySpawnsSkipped counts the children skipped',
      'killedBy shooter',
      'shooter acts every 120 ticks',
      'shooter first acts 120 ticks after it stops',
      'shooter stops within a step of 300',
      'summoned children are extra, in their summoner’s wave',
      'summoner acts every 180 ticks',
      'summoner first acts 180 ticks after it stops',
      'summoner skips at the cap',
      'summoner stops within a step of 480',
      'summoner summons 2',
      'the field fills to the cap of 120',
    ];
    expect(bySeed).toEqual({ 1: pins, 2: pins });
  });

  it.each(cases)('$id', ({ entry, seed, expected }) => {
    const [first, second] = runCase(entry, seed);
    expect(second, 'the second run of the same case').toBe(first);
    expect(first).toBe(expected);
  });
});
