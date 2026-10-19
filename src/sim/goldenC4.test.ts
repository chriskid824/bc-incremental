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
import { mul, num } from '../core/num';
import type { RuleSpec } from '../data/rules';
import type { Modifier } from '../data/stats';
import { TAG } from '../data/tags';
import type { TriggerSpec } from '../data/triggers';
import type { GameData } from '../data/types';
import { SMALL_PROJECTILE_TICKS } from './caps';
import { createPayload, ROWS } from './emitters/types';
import type { Payload } from './emitters/types';
import type { BuildCompiler, TestModule } from './rules';
import { createSimulation } from './simulation';
import { MOTION_HOMING, MOTION_LOB, MOTION_STRAIGHT, spawnShot } from './systems/shots';
import {
  GOLDEN_BUILDS,
  makeConfig,
  makeStats,
  makeTestData,
  maskProbeMods,
  projectResult,
} from './testing';
import { COUNTER_IDS, NO_INPUT } from './types';
import type { CounterId, RunConfig } from './types';

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

  it.each(cases)('$id', ({ entry, seed, expected }) => {
    const [first, second] = runCase(entry, seed);
    expect(second, 'the second run of the same case').toBe(first);
    expect(first).toBe(expected);
  });
});
