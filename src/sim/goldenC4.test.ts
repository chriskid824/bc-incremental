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
import type { Num } from '../core/num';
import { AFFIX_IDS, AFFIX_MULTIPLY } from '../data/affixes';
import type { RuleSpec } from '../data/rules';
import type { Modifier } from '../data/stats';
import { TAG } from '../data/tags';
import type { TriggerSpec } from '../data/triggers';
import { ENEMY_IDS } from '../data/types';
import type { EnemyId, GameData } from '../data/types';
import { enemySlow, frostMeter } from './ailments/frost';
import { holdsBurn } from './ailments/records';
import { liveBleedStacks, livePoisonStacks } from './ailments/rings';
import { holdsShock } from './ailments/shock';
import { compileScaling, scaledValue } from './build/eval';
import { spreadOf } from './build/size';
import { SMALL_PROJECTILE_TICKS } from './caps';
import { KILLED, REPEAT } from './effects/flags';
import { MAX_DEPTH } from './effects/types';
import { enemiesInAura } from './emitters/aura';
import { createPayload, ROWS } from './emitters/types';
import type { EmitterRuntime, Payload, SegmentSpec } from './emitters/types';
import { enqueueModuleEffect } from './rules';
import type { BuildCompiler, TestModule } from './rules';
import { createSimulation } from './simulation';
import { BERSERK_MULT, MULTIPLY_COUNT, SWIFT_MULT, WARDED } from './systems/affixes';
import type { Enemy, RunContext } from './systems/context';
import {
  ARMOURED,
  CHARGING,
  DASHING,
  ENTANGLED,
  FLEEING,
  ORBITING,
  SHIELDED,
  STOPPED,
} from './systems/enemyRecord';
import { MOTION_HOMING, MOTION_LOB, MOTION_STRAIGHT, spawnShot } from './systems/shots';
import {
  afterimageModule,
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
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  COUNTER_IDS,
  DRONE_DASH,
  DRONE_DOCKED,
  DRONE_GUARD,
  DRONE_KIND_DRONE,
  DRONE_KIND_SPIRIT,
  DRONE_KIND_TURRET,
  DRONE_RETURN,
  DT,
  NO_INPUT,
} from './types';
import type {
  ContactTally,
  CounterId,
  EnemyState,
  RunConfig,
  SegmentLinesState,
  SimEvent,
} from './types';

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
  /**
   * A second run at the same seed and length, hashed after the first into the same digest:
   * E1's `gigantism`, whose two builds (magma bombs and the swarm) are one entry.
   */
  readonly also?: Pick<GoldenC4Entry, 'config' | 'data' | 'modules'>;
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
 * C5.7's timed rows, on the effects stream. `spirits`: M1's volley at attack speed 12 and two
 * projectiles over the magma bombs' base (crits, ignites, a chain jump, frost and
 * maskProbeMods()), whose every fourth attack spawns one 火靈-like row at the player (a 'player'
 * pick): it lives 4 s, dashes at the enemy nearest to it at speed 200 × m 3 (the drones' 600),
 * impacts once, hitting every enemy within 40 of its target for the damage stat, and burns each
 * enemy it hit that is still alive with 3 stacks; at most 6 live at once, which the wave holds
 * out long enough to reach, so later spawns are refused and counted, and a few rows leave on
 * time. `temporaries`: the swarm entry's base with the swarm's turret (3 drones and 1 turret,
 * fixed rows 1–4) and a hit trigger spawning a row of 4 s, 3 impacts at the drones' outer aim
 * and 30% of the damage stat at the hit's point; only the fixed rows' hits spawn them (rule 3
 * keeps the trigger off its own rows' hits: every row is at depth 1 with the trigger as its
 * origin), enough to fill the pool to its summon cap of 24, fixed and timed rows together, which
 * refuses the rest; rows leave spent and on time.
 */
const SPIRIT_TRIGGER: TriggerSpec = {
  on: 'nthAttack',
  every: 4,
  target: { pick: 'player' },
  do: [
    {
      kind: 'spawnDrone',
      lifeSec: 4,
      damagePct: 1,
      impacts: 1,
      aim: 'nearest',
      maxLive: 6,
      speed: 200,
      splash: 40,
      ailment: 'burn',
      ailmentStacks: 3,
    },
  ],
};
const SPIRIT_STATS = makeStats(
  { ...MAGMA_STATS.values, attackSpeed: 12, projectileCount: 2 },
  maskProbeMods(),
  { triggers: [{ source: 'outer.fire', spec: SPIRIT_TRIGGER }], conversions: [], emitters: [] },
);
const TEMPORARY_TRIGGER: TriggerSpec = {
  on: 'hit',
  do: [{ kind: 'spawnDrone', lifeSec: 4, damagePct: 0.3, impacts: 3, aim: 'outer' }],
};
const TEMPORARY_STATS = makeStats(SWARM_VALUES, maskProbeMods(), {
  triggers: [{ source: 'outer.summon', spec: TEMPORARY_TRIGGER }],
  conversions: [],
  emitters: [],
});

/**
 * C5.8's segments between the drone pool's rows, at the default range of 200, share of 10% and
 * one shock stack, every 0.25 s. `fence` (雷射柵欄's shape): C4.7's magma bombs (their stats,
 * triggers and probes) with an outer.summon drone grant of 2 drones and 1 turret, `spirits`'
 * spawnDrone trigger on every fourth bomb, and a 'summons' segment from outer.summon of links 1:
 * each row, drones, turret and spirits alike, links to its nearest other within 200, and the
 * enemies on the links take a minion lightning hit and a shock stack, some dying of it, while
 * spirits come and leave between the judgements. `droneWeb` (雷網蜂's shape): the swarm entry's
 * base with the swarm's turret, whose 3 drones fly sorties at the farthest enemies, and a
 * 'drones' segment from outer.lightning of links 1 that pairs every 0.5 s: the judgement between
 * two pairings keeps the drones' last pairs wherever they have flown, the turret never an
 * endpoint.
 */
const FENCE_STATS = makeStats(MAGMA_STATS.values, [...maskProbeMods(), PROJECTILE_PROBE], {
  triggers: [
    ...MAGMA_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    { source: 'outer.fire', spec: SPIRIT_TRIGGER },
  ],
  conversions: [],
  emitters: [
    { source: 'outer.summon', grant: { kind: 'drone', drones: 2, turrets: 1 } },
    { source: 'outer.summon', grant: { kind: 'segment', endpoints: 'summons', links: 1 } },
  ],
});
const DRONE_WEB_STATS = makeStats(SWARM_VALUES, maskProbeMods(), {
  triggers: [{ source: 'center', spec: SWARM_POISON }],
  conversions: [],
  emitters: [
    {
      source: 'outer.lightning',
      grant: { kind: 'segment', endpoints: 'drones', links: 1, pairPeriodSec: 0.5 },
    },
  ],
});

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

/**
 * C7.6's elite affixes (docs/v3 C7 design §2.7) on a v3 run of triangles and squares from wave 1
 * with an elite every wave (eliteEvery 1, bossEvery 1000) and three affixes from wave 1, and no
 * treasure (§1.9; TEST_V3_WAVES.v3 spread, as v3TestData's merge is shallow): every wave releases
 * one hexagon that draws three of the eight affixes on the `affixes` stream. §2.7's build —
 * ignites, poisons and chills, with a turret granted on outer.summon beside M1's volley — reaches
 * the ailment entries the ward shrinks and the cadence a frost elite slows, the turret's included.
 */
const AFFIX_STATS = makeStats(
  {
    damage: 12,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.3,
    poisonChance: 0.2,
    frostOnHit: 0.1,
  },
  [],
  {
    triggers: [],
    conversions: [],
    emitters: [{ source: 'outer.summon', grant: { kind: 'drone', turrets: 1 } }],
  },
);
const affixData = (): GameData =>
  v3TestData({
    waves: {
      rules: [
        { enemy: 'triangle', fromWave: 1, base: 6, perWave: 0.6, maxCount: 40 },
        { enemy: 'square', fromWave: 1, base: 2, perWave: 0.3, maxCount: 20 },
      ],
      eliteEvery: 1,
      bossEvery: 1000,
      v3: {
        ...TEST_V3_WAVES.v3,
        affixes: [{ fromWave: 1, count: 3 }],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });

/**
 * C7.7's onion boss (docs/v3 C7 design §2.8) on a v3 run of triangles from wave 1 with a boss
 * every wave (bossEvery 1: TEST_V3_WAVES' rotation, the onion), and no affix, treasure or elite
 * (§1.9; TEST_V3_WAVES.v3 spread, as v3TestData's merge is shallow). Damage 40 on BASE_STATS'
 * volley, with poison at 0.5 and too much life to die, breaks the onions' shells within 20 s,
 * some by its hits and some by damage over time (its poison, and BASE_STATS' ignites); each break
 * sprays twelve triangles, and the last falls through to the kill and its drops.
 */
const ONION_STATS = makeStats({ damage: 40, poisonChance: 0.5, maxLife: 1e6 });
const onionData = (): GameData =>
  v3TestData({
    waves: {
      rules: [{ enemy: 'triangle', fromWave: 1, base: 6, perWave: 0.6, maxCount: 40 }],
      eliteEvery: 1000,
      bossEvery: 1,
      v3: {
        ...TEST_V3_WAVES.v3,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });

/**
 * C6b.2's combo stacks and timed buff (docs/v3 C6 design §7.4, gd §4.5) on M1's volley: attack
 * speed × (1 + 0.03 per stack) and damage +2 % increased per stack, a stack per kill beside each
 * attack's, and every 10 s an untagged buff of attack speed × 3 for 2 s. A v3 run from wave 12 of
 * three triangles and one square a wave (the square at 15 × its life), released over 8 s
 * (TEST_V3_WAVES.v3 spread, as v3TestData's merge is shallow, with no affix or treasure): the
 * stacks reach the cap, a square that walks in halves them, and the gaps between a wave's
 * releases clear them.
 */
const COMBO_STATS = makeStats(
  { damage: 10, maxLife: 1e6 },
  [
    { stat: 'attackSpeed', kind: 'more', value: 0.03, scaling: { per: 'comboStacks' } },
    { stat: 'damage', kind: 'increased', value: 0.02, scaling: { per: 'comboStacks' } },
  ],
  {
    triggers: [
      { source: 'center', spec: { on: 'kill', do: [{ kind: 'comboStack', stacks: 1 }] } },
      {
        source: 'center',
        spec: {
          on: 'periodic',
          every: 10,
          do: [{ kind: 'buff', stat: 'attackSpeed', more: 2, durationSec: 2 }],
        },
      },
    ],
    conversions: [],
    emitters: [],
  },
);
const comboData = (): GameData =>
  v3TestData({
    enemies: { square: { hpMult: 15 } },
    waves: {
      rules: [
        { enemy: 'triangle', fromWave: 1, base: 3, perWave: 0, maxCount: 3 },
        { enemy: 'square', fromWave: 1, base: 1, perWave: 0, maxCount: 1 },
      ],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 8,
      waveTimerSec: 12,
      v3: {
        ...TEST_V3_WAVES.v3,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });

/**
 * C6b.3's per-tick run variables and greed's kill shards (docs/v3 C6 design §7.4 C6b.3, H19,
 * H20) on C7.3's squares and shielders from wave 12 (enemyDefenceData; armouredSquares armours
 * the squares): a wallet of 1e4 shards and a damage more of × (held shards)^0.12, which starts
 * at 1e4^0.12 = 3.02 and rises with the shards the run collects, and +2 % damage increased per
 * enemy an aura pulse of radius 240 reaches, at most +20 %. Every 0.5 s a coin of ×10 that passes
 * the shield and the armour hits the enemy with the most life, credited to outer.greed, and its
 * kills drop × 1.01 shards; the volley's, the aura's and the burns' kills do not. The volley's
 * hits of 4 × the held-shard factor stay under a shielder's 15 % from wave 12, so its shield
 * blocks them, while the coins land whole on shielders and armoured squares alike.
 */
const GREED_STATS = makeStats(
  { damage: 4, maxLife: 1e6, igniteChance: 0.2, auraRadius: 240 },
  [
    {
      stat: 'damage',
      kind: 'more',
      value: 1,
      scaling: { per: 'shardsHeld', curve: 'powFactor', exponent: 0.12 },
    },
    { stat: 'damage', kind: 'increased', value: 0.02, scaling: { per: 'enemiesInAura', cap: 0.2 } },
  ],
  {
    triggers: [
      {
        source: 'outer.greed',
        spec: {
          on: 'periodic',
          every: 0.5,
          target: { pick: 'highestHp' },
          do: [{ kind: 'coinHit', multiplier: 10, ignoreShield: true, ignoreArmour: true }],
          killShards: 0.01,
        },
      },
    ],
    conversions: [],
    emitters: [{ source: 'outer.aura', grant: { kind: 'aura' } }],
  },
);

/**
 * C7b's bleedRings (docs/v3 C7 design §2.10, lead ruling W2): 大出血's module (bleedRings, the
 * 8-stack cap, bleedMoveMult 1) on a volley of three projectiles that bleed at 0.8, in a v3 run
 * of three squares and a dasher a wave, both at 6 × their life, from wave 1 (no affix, treasure,
 * elite or boss; TEST_V3_WAVES.v3 spread, as v3TestData's merge is shallow). The walkers and the
 * dashing dashers bleed as they come, many enemies reach the cap, and none holds a bleed in the
 * strongest-only slot.
 */
const BLEED_RINGS_MODULE: TestModule = (b) => {
  b.flags.bleedRings = true;
  b.flags.bleedMoveMult = 1;
};
const BLEED_RINGS_STATS = makeStats({
  damage: 4,
  bleedChance: 0.8,
  igniteChance: 0,
  critChance: 0.1,
  maxLife: 1e6,
  projectileCount: 3,
});
const bleedRingsData = (): GameData =>
  v3TestData({
    enemies: { square: { hpMult: 6 }, dasher: { hpMult: 6 } },
    waves: {
      rules: [
        { enemy: 'square', fromWave: 1, base: 3, perWave: 0, maxCount: 3 },
        { enemy: 'dasher', fromWave: 1, base: 1, perWave: 0, maxCount: 1 },
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
 * C7b's contact hooks (§2.10, lead rulings W3 and W4): thorns (outer.thorns, 300 % of damage 4)
 * with 拒馬's ×3 as B4 writes it (a thorns `damage more 2` on a dashing target), dashRepel 80 and
 * bossHoldSec 1, in a v3 run of three dashers at 4 × their life and an onion a wave from wave 1
 * (bossEvery 1; no affix, treasure or elite). Every dasher that dashes into the player is pushed
 * back or dies to the thorns, and the first onion to walk in is held for a second.
 */
const CONTACT_HOOKS_STATS = makeStats(
  { damage: 4, maxLife: 1e6, critChance: 0, igniteChance: 0, dashRepel: 80, bossHoldSec: 1 },
  [
    {
      stat: 'damage',
      kind: 'more',
      value: 2,
      tags: ['thorns'],
      when: [{ targetState: 'dashing' }],
    },
  ],
  {
    triggers: [],
    conversions: [],
    emitters: [{ source: 'outer.thorns', grant: { kind: 'thorns' } }],
  },
);
const contactHooksData = (): GameData =>
  v3TestData({
    enemies: { dasher: { hpMult: 4 } },
    waves: {
      rules: [{ enemy: 'dasher', fromWave: 1, base: 3, perWave: 0, maxCount: 3 }],
      eliteEvery: 1000,
      bossEvery: 1,
      v3: {
        ...TEST_V3_WAVES.v3,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });

/**
 * C7b's bullet hooks (§2.10, lead rulings W5 and W6), the dodge and the orbit's block: 節奏閃避
 * as B4 writes it (3 s, at 15 stacks), the combo stacks topped up by 10 every 0.25 s (so a hit's
 * halving leaves them short only briefly), and an orbit of two orbs with orbitBlocksBullets, in
 * a v3 run of eight shooters at 8 × their life and six triangles a wave from wave 1 (no affix,
 * treasure, elite or boss). 反射 turns every bullet at the player before the dodge could take it
 * (W7's order), so one build cannot show it with the dodge: bulletHooks/reflect does.
 */
const DODGE_BLOCK_STATS = makeStats(
  { damage: 10, maxLife: 1e6, bulletDodgeSec: 3, bulletDodgeCombo: 15, orbitBlocksBullets: 1 },
  [],
  {
    triggers: [
      {
        source: 'center',
        spec: { on: 'periodic', every: 0.25, do: [{ kind: 'comboStack', stacks: 10 }] },
      },
    ],
    conversions: [],
    emitters: [{ source: 'outer.aura', grant: { kind: 'orbit', count: 2 } }],
  },
);
const shooterWaves = (shooters: number, triangles: number, hpMult: number) => (): GameData =>
  v3TestData({
    enemies: { shooter: { hpMult } },
    waves: {
      rules: [
        { enemy: 'shooter', fromWave: 1, base: shooters, perWave: 0, maxCount: shooters },
        { enemy: 'triangle', fromWave: 1, base: triangles, perWave: 0, maxCount: triangles },
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
 * C7b's 反射 (§2.10, lead ruling W7): reflectBullets with thorns (outer.thorns, 300 % of damage
 * 6) for the hit a bullet brings home, in a v3 run of eight shooters at 2 × their life and four
 * triangles a wave from wave 1. Every bullet turns at the player; most reach their shooter, and
 * those whose shooter died first (the life is low so that some do) are gone on the way.
 */
const REFLECT_STATS = makeStats({ damage: 6, maxLife: 1e6, reflectBullets: 1 }, [], {
  triggers: [],
  conversions: [],
  emitters: [{ source: 'outer.thorns', grant: { kind: 'thorns' } }],
});

/**
 * C7b's 集火 (§2.10, lead ruling W8): shieldPoolSec 0.2 as B3 writes it on a volley of six
 * projectiles at 6 attacks a second, damage 3, against three shielders and two squares a wave
 * from wave 12's life (no affix, treasure, elite or boss): each projectile's hit is below the
 * shield's 15 % alone, and the pool lets through those that come close enough together.
 */
const SHIELD_POOL_STATS = makeStats({
  damage: 3,
  projectileCount: 6,
  attackSpeed: 6,
  critChance: 0,
  igniteChance: 0,
  maxLife: 1e6,
  shieldPoolSec: 0.2,
});
const shieldPoolData = (): GameData =>
  v3TestData({
    waves: {
      rules: [
        { enemy: 'shielder', fromWave: 1, base: 3, perWave: 0, maxCount: 3 },
        { enemy: 'square', fromWave: 1, base: 2, perWave: 0, maxCount: 2 },
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
 * E1's area factors (docs/v3 C4 design D29; Hoshi's Q2 (A); lead ruling G5). `areaSize`: C4.7's
 * magma bombs (MAGMA_STATS' values, triggers and probes) at areaSize 1.5 and bombRadius 1.2, with
 * an aura of 120 on the hub: each bomb's R and its fire zone 60 × 1.5 × 1.2, the explode
 * trigger's novas (100), the fire kill trigger's explosions (80), the shatter (90) and the aura's
 * reach × 1.5 alone. `gigantism`: 巨大化 (sizeMult 2) on two runs hashed as one: C4.7's magma
 * bombs at raw projectileCount 5, two bombs a firing (4 halved, no fraction rolled), chainCount 2
 * halved to 1 and every radius × 2; then the swarm, its 3 drones halved to 1 beside a grant's 4
 * halved to 2, every turret kept (its own and the grant's 2), each splash × 2.
 */
const AREA_SIZE_STATS = makeStats(
  { ...MAGMA_STATS.values, areaSize: 1.5, bombRadius: 1.2, auraRadius: 120 },
  [...maskProbeMods(), PROJECTILE_PROBE],
  {
    triggers: MAGMA_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [{ source: 'hub', grant: { kind: 'aura', damagePct: 0.15 } }],
  },
);
const GIGANTISM: RuleSpec = { id: 'gigantism', sizeMult: 2 };
const GIANT_MAGMA_STATS = makeStats(
  { ...MAGMA_STATS.values, projectileCount: 5, chainCount: 2 },
  [...maskProbeMods(), PROJECTILE_PROBE],
  {
    triggers: MAGMA_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);
const GIANT_SWARM_STATS = makeStats(SWARM_VALUES, maskProbeMods(), {
  triggers: [{ source: 'center', spec: SWARM_POISON }],
  conversions: [],
  emitters: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 4, turrets: 2 } }],
});

/**
 * E2's ◆鎖定 (C4 design §11's B1 row, F16; lead rulings H1, H2, H5): crit chance +25 % against
 * the highest-life enemy and a shock on each hit of it, with no other crit, on a volley of four
 * projectiles chaining twice at six attacks a second, damage 8, from wave 8 of the v3 fixture
 * waves: the highest moves from enemy to enemy as they are worn down, the onion boss of wave 10
 * among them.
 */
const HIGHEST_HP_STATS = makeStats(
  {
    damage: 8,
    maxLife: 1e6,
    critChance: 0,
    igniteChance: 0,
    attackSpeed: 6,
    projectileCount: 4,
    chainCount: 2,
  },
  [{ stat: 'critChance', kind: 'flat', value: 0.25, when: [{ targetIs: 'highestHp' }] }],
  {
    triggers: [
      {
        source: 'center',
        spec: {
          on: 'hit',
          when: [{ targetIs: 'highestHp' }],
          do: [{ kind: 'applyAilment', ailment: 'shock' }],
        },
      },
    ],
    conversions: [],
    emitters: [],
  },
);

/**
 * E2's ◆神經毒 (gd:389; C4 design §11's B1 row, I7; lead rulings H3, H4, H5): poisonSlow at its
 * 初始值 (2 % for every 5 live poison stacks, at most 40 %) on a build that poisons every hit and
 * adds four stacks a hit on outer.poison, three projectiles chaining once at six attacks a
 * second, damage 10, from wave 8 of the v3 fixture waves: its enemies hold from a few stacks to
 * past 200, the onion boss of wave 10 among them, so the term's steps and its cap both show.
 */
const POISON_SLOW_STATS = makeStats(
  {
    damage: 10,
    maxLife: 1e6,
    critChance: 0,
    igniteChance: 0,
    poisonChance: 1,
    attackSpeed: 6,
    projectileCount: 3,
    chainCount: 1,
  },
  [],
  {
    triggers: [
      {
        source: 'outer.poison',
        spec: { on: 'hit', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 4 }] },
      },
    ],
    conversions: [],
    emitters: [],
  },
);

/**
 * E3's spread distance (lead ruling S5) at spreadRadius 1.5 and areaSize 1.2, so that the
 * product shows: 瘟疫's form (gd:62), a burning enemy's death passing 40% of its burn to every
 * enemy within 250 × 1.2 × 1.5 = 450, where the area alone would reach 300; 火星's form (gd:376),
 * a marked applyAilment igniting the 2 nearest within 90 × 1.8 = 162 of a burning enemy's death
 * (108 by the area alone); a kill trigger's marked selector shocking the farthest enemy within
 * 120 × 1.5 = 180 of the victim, a reach that areaSize leaves (216 if it did not); and 燎原's form
 * (gd:379) as a test module reading spreadOf: every second, each burning enemy passes 1 burn
 * stack to the nearest other enemy within 60 × 1.5 = 90.
 */
const SPREAD_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'center',
    {
      on: 'diedWithAilment',
      when: [{ victimHas: 'burn' }],
      do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 250, effect: 0.4 }],
    },
  ],
  [
    'outer.fire',
    {
      on: 'diedWithAilment',
      when: [{ victimHas: 'burn' }],
      do: [
        {
          kind: 'applyAilment',
          ailment: 'burn',
          radius: 90,
          maxTargets: 2,
          order: 'nearest',
          spread: true,
        },
      ],
    },
  ],
  [
    'center',
    {
      on: 'kill',
      target: { pick: 'farthest', range: 120, spread: true },
      do: [{ kind: 'applyAilment', ailment: 'shock', stacks: 1 }],
    },
  ],
];
const SPREAD_STATS = makeStats(
  {
    damage: 14,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.35,
    projectileCount: 2,
    spreadRadius: 1.5,
    areaSize: 1.2,
  },
  maskProbeMods(),
  {
    triggers: SPREAD_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);

/**
 * 燎原's form (gd:379, 「燃燒中的敵人每秒把 1 層燃燒傳給 60 內最近的敵人」) as a test module: every
 * 60 ticks, each burning enemy passes 1 burn stack to the nearest other alive enemy within
 * spreadOf(60), read at use. `seen`, for the coverage test alone, gets each pass's distance.
 */
function wildfireModule(seen?: (distance: number) => void): TestModule {
  return (b) => {
    const fx = b.addEffect('outer.fire', { kind: 'applyAilment', ailment: 'burn', stacks: 1 });
    const owner = b.instanceTrigger();
    b.hook('tick', (ctx) => {
      if (ctx.now % 60 !== 0) return;
      const reach = spreadOf(ctx.build, 60);
      for (const from of ctx.enemies) {
        if (!from.alive || !holdsBurn(from, ctx.now)) continue;
        const to = ctx.grid.nearest(from.x, from.y, reach * reach, (e) => e !== from && e.alive);
        if (to === null) continue;
        seen?.(Math.hypot(to.x - from.x, to.y - from.y));
        const ev = { depth: 0, origin: -1, target: to, x: to.x, y: to.y, flags: 0 };
        enqueueModuleEffect(ctx, owner, fx, ev);
      }
    });
  };
}

/**
 * C5.9's summon policies (gd:193, :476-481; lead rulings P2–P6): a drone grant of 6 drones and 2
 * turrets on outer.summon beside M1's volley, with a test module standing in for B1's four:
 * 鎖定信標 (summonEliteFirst), 蟲海 (droneCountMult 2, so 12 drones, and dronesStay), 加農砲
 * (turretRateMult 1/3 and turretSplash 60) and 特斯拉塔 (turretChains 2); droneSpeed 1.5; and
 * every attack spawning two 3 s spirits of 2 impacts at the outer aim at the player, which the
 * 14 fixed rows leave 10 places for under the summon cap of 24, so later spawns are refused.
 * Their data halves ride along: 鎖定信標's +30 % on the minions against elites and bosses, 加農砲's
 * ×4 on the turret shots. From wave 8 of the v3 fixture waves, as highestHp: elites from wave 9
 * and the onion boss of wave 10 to pick first.
 */
const SUMMON_POLICY_MODS: readonly Modifier[] = [
  ...(['elite', 'boss'] as const).map((kind): Modifier => ({
    stat: 'damage',
    kind: 'increased',
    value: 0.3,
    tags: ['minion'],
    when: [{ targetKind: kind }],
  })),
  { stat: 'damage', kind: 'more', value: 3, tags: ['minion', 'projectile'] },
];
const SUMMON_POLICY_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    chainCount: 1,
    attackSpeed: 6,
    droneSpeed: 1.5,
  },
  SUMMON_POLICY_MODS,
  {
    triggers: [
      {
        source: 'outer.summon',
        spec: {
          on: 'nthAttack',
          every: 1,
          target: { pick: 'player' },
          do: [
            { kind: 'spawnDrone', lifeSec: 3, damagePct: 0.5, count: 2, impacts: 2, aim: 'outer' },
          ],
        },
      },
    ],
    conversions: [],
    emitters: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 6, turrets: 2 } }],
  },
);
/** B1's four modules in one: what 鎖定信標, 蟲海, 加農砲 and 特斯拉塔 write. */
const summonPolicyModule = (): TestModule => (b) =>
  void Object.assign(b.flags, {
    summonEliteFirst: true,
    droneCountMult: 2,
    dronesStay: true,
    turretRateMult: 1 / 3,
    turretSplash: 60,
    turretChains: 2,
  });

/**
 * C5.9's minionCount (gd:572 「場上每有 1 架小無人機，中心傷害 +4%（最多 +20%）」; lead ruling P7):
 * :572's line as data, center damage increased 4 % per live temporary summon up to 20 %, on M1's
 * volley, whose every second attack spawns a 2.5 s spirit of 3 impacts at the nearest aim at the
 * player, at most 8 live, beside a drone grant of 2 drones and a turret on outer.summon (fixed
 * rows, which never count); from wave 12 of the fixture waves. The count climbs past the cap's 5
 * and falls as the rows leave.
 */
const MINION_SCALING_STATS = makeStats(
  {
    damage: 8,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    attackSpeed: 6,
  },
  [
    {
      stat: 'damage',
      kind: 'increased',
      value: 0.04,
      scope: 'center',
      scaling: { per: 'minionCount', cap: 0.2 },
    },
  ],
  {
    triggers: [
      {
        source: 'outer.summon',
        spec: {
          on: 'nthAttack',
          every: 2,
          target: { pick: 'player' },
          do: [
            {
              kind: 'spawnDrone',
              lifeSec: 2.5,
              damagePct: 0.3,
              impacts: 3,
              aim: 'nearest',
              maxLive: 8,
            },
          ],
        },
      },
    ],
    conversions: [],
    emitters: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 2, turrets: 1 } }],
  },
);

/**
 * FL's flight slash (gd:643 刃翼 「撞擊時沿飛行方向畫一條必定暴擊的斬擊線」; lead rulings F1–F3, F7,
 * FL-R1): the swarm with five drones and no turret over the swarm entry's base (crits, ignites and
 * a chain jump), for the 蜂巢 character, from wave 12 of the fixture waves. Each drone impact
 * raises droneImpact, whose trigger on fusion.summon.crit, at coef 1, is the crit outer's payload
 * as the generator places it on droneImpact: a slash from the impact's point, the target's center,
 * along the drone's flight, 300 long and 24 wide, always a crit, critScale 1. The drones fly out
 * from five docks at the farthest enemies, so they fly in from every side, and the slashes run the
 * way each flew in, mostly off the outward line; every impact cuts one, a killing one too.
 */
const FLIGHT_SLASH_STATS = makeStats(SWARM_VALUES, maskProbeMods(), {
  triggers: [
    {
      source: 'fusion.summon.crit',
      spec: {
        on: 'droneImpact',
        do: [
          {
            kind: 'slashLine',
            length: 300,
            width: 24,
            damagePct: 1,
            alwaysCrit: true,
            critScale: 1,
            from: 'event',
            toward: 'flight',
          },
        ],
      },
      coef: 1,
    },
  ],
  conversions: [],
  emitters: [],
});
/** Five swarm drones and no turret. */
const fiveDrones = (): TestModule[] => [
  (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) Object.assign(swarm, { drones: 5, turrets: 0 });
  },
];

/**
 * E4's hive roles, seat and size (gd:184-192; lead rulings R1, R3, R4): the swarm's 3 drones and
 * turret, with a test module standing in for B2's: ◆蜂后 on dock index 0 (damage ×2, size ×1.5,
 * and × 1.2 on another drone's impact on its target), ◆重錘 on dock index 1 (damage ×5, speed
 * ×0.4), ◆前哨's turret seat at 220 and ★巨像's size ×1.2. Over droneWeb's base (crits, ignites,
 * maskProbeMods() and the swarm's poison on each impact) at projectileCount 3, so a firing of the
 * turret is two shots; from wave 9 of the v3 fixture waves, whose elites and the onion boss of
 * wave 10 draw the drones to one enemy, so that the queen's followers impact its target at both
 * seeds (from wave 12 of the fixture waves, droneWeb's, they do twice at seed 1 and never at 2).
 */
const HIVE_ROLES_STATS = makeStats({ ...SWARM_VALUES, projectileCount: 3 }, maskProbeMods(), {
  triggers: [{ source: 'center', spec: SWARM_POISON }],
  conversions: [],
  emitters: [],
});
/** B2's 蜂后, 重錘, 前哨 and 巨像 in one: what they write over the swarm's SwarmParams. */
const hiveRolesModule = (): TestModule => (b) => {
  const swarm = b.signature().swarm;
  if (swarm === null) return;
  swarm.roles.push(
    { slot: 0, damageMult: 2, speedMult: 1, sizeMult: 1.5, followBonus: 0.2 },
    { slot: 1, damageMult: 5, speedMult: 0.4, sizeMult: 1, followBonus: 0 },
  );
  swarm.turretRadius = 220;
  swarm.sizeMult = 1.2;
};

/**
 * E4's 集火指令 and 蜂王漿 (gd:187, :199; lead rulings R2, R5): a drone grant of 3 drones and 2
 * turrets on outer.summon beside M1's volley, with a test module setting summonHighestHp, and
 * every second attack spawning a 2 s spirit of 3 impacts at each aim at the player, at
 * summonDuration 1.5, so each lives 180 ticks unless it is spent first; projectileCount 2, so a
 * turret's firing is two shots, both at its pick. 集火指令's +25 % on the minions rides along as
 * data. From wave 8 of the v3 fixture waves, as summonPolicies: elites from wave 9 and the onion
 * boss of wave 10, whose hp the picks follow.
 */
const FOCUS_FIRE_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    chainCount: 1,
    attackSpeed: 6,
    projectileCount: 2,
    summonDuration: 1.5,
  },
  [{ stat: 'damage', kind: 'increased', value: 0.25, tags: ['minion'] }],
  {
    triggers: [
      {
        source: 'outer.summon',
        spec: {
          on: 'nthAttack',
          every: 2,
          target: { pick: 'player' },
          do: (['outer', 'nearest'] as const).map((aim) => ({
            kind: 'spawnDrone' as const,
            lifeSec: 2,
            damagePct: 0.5,
            impacts: 3,
            aim,
          })),
        },
      },
    ],
    conversions: [],
    emitters: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 3, turrets: 2 } }],
  },
);
/** B2's 集火指令: the flag it sets. */
const focusFireModule = (): TestModule => (b) => void (b.flags.summonHighestHp = true);

/** A test module standing in for B2's: `fields` over the swarm's SwarmParams (E5). */
const swarmFields =
  (fields: Record<string, unknown>): TestModule =>
  (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) Object.assign(swarm, fields);
  };

/**
 * E5's 自爆協議 (gd:183 「無人機回巢前的第 3 次撞擊改成爆炸，半徑 80、150% 傷害」; lead ruling K1): the
 * swarm's 3 drones without their turret, its SwarmParams.lastImpact { radius 80, damagePct 1.5 }
 * from a test module standing in for B2's, beside a drone grant of 2 on outer.summon, whose
 * impacts never explode; SWARM_STATS' poison on each droneImpact and its chain; from wave 12 of
 * the fixture waves. It pins the explosions, every sortie's third impact at 80, their hits at
 * 0.75 × an impact's and what they list, and the other impacts at the splash.
 */
const SELF_DESTRUCT_STATS = makeStats(SWARM_VALUES, maskProbeMods(), {
  triggers: [{ source: 'center', spec: SWARM_POISON }],
  conversions: [],
  emitters: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 2 } }],
});

/**
 * E5's 攔截守衛 (gd:188 「2 架無人機改在半徑 120 繞行，優先撞正在蓄力的衝刺者」; lead rulings K2
 * and K2-R1): the swarm of 4 drones without its turret, its last 2 guards on a ring of 120
 * (SwarmParams.guards), at damage 3 over v3 waves of the fixture walkers and of dashers from wave
 * 1, 3 a wave and more (C7.4a's TEST_V3_WAVES rules, as regenDasherTreasure builds them, with no
 * affix, treasure, elite or boss), from wave 12. Dashers walk in to 420 and charge: it pins the
 * charge starts, the guards' forced picks of the charging dashers and their impacts on them, their
 * other picks in the ring, and the other drones' picks past it.
 */
const GUARD_STATS = makeStats({ ...SWARM_VALUES, damage: 3 }, maskProbeMods());
const guardsData = (): GameData =>
  v3TestData({
    waves: {
      rules: [
        ...TEST_WAVES.rules,
        { enemy: 'dasher', fromWave: 1, base: 3, perWave: 0.2, maxCount: 8 },
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
 * E5's 蜂潮 (gd:194 「每 8 秒，全部無人機一起俯衝到最密集處，傷害 ×2」; lead ruling K3): the swarm of
 * 6 drones and its turret, its SwarmParams.surge { periodSec 8, damageMult 2 }, on SWARM_STATS
 * from wave 20 of the fixture waves, dense with triangles, squares and pentagons. It pins the
 * run's two surges (ticks 480 and 960), their targets and the 6 rows each sends, and each row's
 * next impact, on the target, at × 2: neither seed loses a target with a row's mark on it.
 */
const SURGE_STATS = SWARM_STATS;

/**
 * E7's chain bolts (超導 gd:527, 放電 gd:410; lead rulings B1-B3, B6): M1's volley chills as
 * freezeList's does (frostOnHit 0.5, no iceFan), and each freeze sends a fusion's three bolts,
 * from 'nearestOther', 0 jumps and a shock stack each, at the three alive enemies nearest the
 * frozen one within the chain range, the frozen one left out; half the kills send one 2-jump
 * bolt from 'nearestToPoint' at the enemy nearest the victim's point, a shock stack a hit. Both
 * arc. From wave 12 of the fixture waves; the volley shocks nothing, so every shock is a bolt's.
 * It pins the picks (distinct, nearest first, never the frozen enemy, all in range), the arcs'
 * from-positions (each first hit from its event's point, each jump from the enemy before) and
 * the shocks.
 */
const CHAIN_BOLTS_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'fusion.ice.lightning',
    {
      on: 'freeze',
      do: [
        {
          kind: 'chainBolt',
          from: 'nearestOther',
          bolts: 3,
          jumps: 0,
          arc: true,
          damagePct: 0.3,
          shockStacks: 1,
        },
      ],
    },
  ],
  [
    'outer.lightning',
    {
      on: 'kill',
      when: [{ chance: 0.5 }],
      do: [
        {
          kind: 'chainBolt',
          from: 'nearestToPoint',
          bolts: 1,
          jumps: 2,
          arc: true,
          damagePct: 0.4,
          shockStacks: 1,
        },
      ],
    },
  ],
];
const CHAIN_BOLTS_STATS = makeStats(
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
    triggers: CHAIN_BOLTS_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [],
  },
);

/** M1's volley with frost on hit, for E6's entries: no ignite or shock unless an entry adds one. */
const ICE_VALUES = {
  damage: 6,
  maxLife: 1e6,
  critChance: 0.2,
  critMultiplier: 2,
  igniteChance: 0,
  frostOnHit: 0.5,
  attackSpeed: 6,
  projectileCount: 2,
};

/**
 * E6's ◆連鎖碎裂 (gd:105 「被碎裂打死的敵人也會碎裂」; lead ruling F1): ICE_VALUES' volley at
 * frostOnHit 1 with shatterDamage 1.5 and shatterRadius 180, so that a shatter kills most enemies
 * within 180 of it at 150 % of its victim's max life, and BuildFlags.shatterChain from a test
 * module standing in for B3's, over the fixture waves from wave 12, dense with triangles, squares
 * and pentagons. It pins the chained shatters of the enemies shatters kill, frozen or not, and
 * the cascade's end at MAX_DEPTH: two chained shatters at most after a hit's kill, the next
 * capped.
 */
const SHATTER_CHAIN_STATS = makeStats(
  { ...ICE_VALUES, frostOnHit: 1, shatterDamage: 1.5, shatterRadius: 180 },
  maskProbeMods(),
);
const shatterChainModule = (): TestModule => (b) => void (b.flags.shatterChain = true);

/**
 * E6's ◆粉碎 (gd:106 「凍結中死亡的五角不分裂」; lead ruling F2): ICE_VALUES' volley and
 * BuildFlags.frozenNoSplit from a test module standing in for B3's, over v3 waves of 8 s with
 * pentagons from wave 1 and an elite every wave with 3 affixes (no treasure), from wave 8. It pins
 * the pentagons frozen at their death leaving no shard, the others their 3, and the 增殖 elites
 * frozen at their death leaving their 2 children all the same.
 */
const NO_SPLIT_STATS = makeStats(ICE_VALUES, maskProbeMods());
const noSplitModule = (): TestModule => (b) => void (b.flags.frozenNoSplit = true);
const noSplitData = (): GameData =>
  v3TestData({
    waves: {
      rules: [
        ...TEST_WAVES.rules.slice(0, 2),
        { enemy: 'pentagon', fromWave: 1, base: 4, perWave: 0.5, maxCount: 20 },
      ],
      eliteEvery: 1,
      bossEvery: 1000,
      v3: {
        ...TEST_V3_WAVES.v3,
        affixes: [{ fromWave: 1, count: 3 }],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });

/**
 * E6's thaw (熱震's 「解凍」, gd:526; lead ruling F3): ICE_VALUES' volley igniting at 0.3, and a
 * 冰火 trigger that thaws the frozen enemies an ignite reaches (on ailmentApplied burn with
 * targetHas frozen), from wave 12 of the fixture waves. It pins the thaws at the ignites, each
 * thawed meter locked for 180 ticks from the thaw, beside the freezes that end on their own, and
 * a thawed enemy that dies before it freezes again shattering nothing.
 */
const THAW_STATS = makeStats(
  { ...ICE_VALUES, damage: 2, frostOnHit: 1, igniteChance: 0.3 },
  maskProbeMods(),
  {
    triggers: [
      {
        source: 'fusion.ice.fire',
        spec: {
          on: 'ailmentApplied',
          when: [{ ailment: 'burn' }, { targetHas: 'frozen' }],
          do: [{ kind: 'thaw' }],
        },
      },
    ],
    conversions: [],
    emitters: [],
  },
);

/**
 * E6's frost gain (超導's gd:527 「感電的敵人冰冷累積 ×1.5」, B5's 霜蝕 at gd:119; lead ruling F4):
 * ICE_VALUES' volley at frostOnHit 0.125, shocking at 0.5, and BuildFlags.frostGainShocked and
 * frostGainBoss both 0.5 from a test module standing in for B3's and B5's, from wave 10 of the
 * fixture waves, its boss among them. It pins each hit's frost: × 1 on a normal enemy, × 1.5 on a
 * shocked one or the boss, × 2 on the shocked boss.
 */
const FROST_GAIN_STATS = makeStats(
  {
    ...ICE_VALUES,
    damage: 3,
    critChance: 0,
    projectileCount: 1,
    frostOnHit: 0.125,
    shockChance: 0.5,
    shockMaxStacks: 3,
  },
  maskProbeMods(),
);
const frostGainModule = (): TestModule => (b) => {
  b.flags.frostGainShocked = 0.5;
  b.flags.frostGainBoss = 0.5;
};

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
  {
    name: 'affixes',
    config: { stats: AFFIX_STATS, rules: [], startWave: 12 },
    data: affixData,
    expected: ['abc807c726a49210', '337c1909fca5b8d7'],
  },
  {
    name: 'onion',
    config: { stats: ONION_STATS, rules: [], startWave: 10 },
    data: onionData,
    expected: ['1d73c42d306cbd2d', 'da114191660d2463'],
  },
  {
    name: 'combo',
    config: { stats: COMBO_STATS, rules: [], startWave: 12 },
    data: comboData,
    expected: ['dbcf015be087c6c0', '95856d903901563c'],
  },
  {
    name: 'greed',
    config: { stats: GREED_STATS, rules: [], startWave: 12, walletShards: num(1e4) },
    data: enemyDefenceData,
    modules: () => [armouredSquares()],
    expected: ['02eeaeab6f5845d4', '9b4b4349d77245df'],
  },
  // C6b.4's 殘影 (lead ruling E3) on combo's build and waves, through the test module: at full
  // stacks each attack's echo, half its damage, 18 ticks later.
  {
    name: 'afterimage',
    config: { stats: COMBO_STATS, rules: [], startWave: 12 },
    data: comboData,
    modules: () => [afterimageModule()],
    expected: ['a67d786a39587fd2', 'b73235919ad0dcfd'],
  },
  {
    name: 'bleedRings',
    config: { stats: BLEED_RINGS_STATS, rules: [], startWave: 12 },
    data: bleedRingsData,
    modules: () => [BLEED_RINGS_MODULE],
    expected: ['56bd3a17d7b12a16', '4cd2dc1d06f2d90a'],
  },
  {
    name: 'contactHooks',
    config: { stats: CONTACT_HOOKS_STATS, rules: [], startWave: 12 },
    data: contactHooksData,
    expected: ['034c8a78b68bffbf', '6d218d4ce2d2a26d'],
  },
  {
    name: 'bulletHooks/dodgeBlock',
    config: { stats: DODGE_BLOCK_STATS, rules: [], startWave: 12 },
    data: shooterWaves(8, 6, 8),
    expected: ['d0083cfeac7b78d3', '4aeaf3b5cca17ac5'],
  },
  {
    name: 'bulletHooks/reflect',
    config: { stats: REFLECT_STATS, rules: [], startWave: 12 },
    data: shooterWaves(8, 4, 2),
    expected: ['12b75a15202fef53', '3036598cf40af0fb'],
  },
  {
    name: 'shieldPool',
    config: { stats: SHIELD_POOL_STATS, rules: [], startWave: 12 },
    data: shieldPoolData,
    expected: ['b361cfcf7b157fab', '9fb1b544c7c05ef4'],
  },
  {
    name: 'areaSize',
    config: { stats: AREA_SIZE_STATS, rules: [], signature: { id: 'magmaBomb' }, startWave: 12 },
    expected: ['9ec3827e275369ce', 'aec284f0f823af1d'],
  },
  {
    name: 'gigantism',
    config: {
      stats: GIANT_MAGMA_STATS,
      rules: [GIGANTISM],
      signature: { id: 'magmaBomb' },
      startWave: 12,
    },
    also: {
      config: {
        stats: GIANT_SWARM_STATS,
        rules: [GIGANTISM],
        signature: { id: 'swarm' },
        startWave: 12,
      },
    },
    expected: ['ad16c2f0388397f6', '6a2634374d2084b6'],
  },
  {
    name: 'spirits',
    config: { stats: SPIRIT_STATS, rules: [], startWave: 12 },
    expected: ['b115812b24d90592', '4889c1a8c3d06c9b'],
  },
  {
    name: 'temporaries',
    config: { stats: TEMPORARY_STATS, rules: [], signature: { id: 'swarm' }, startWave: 12 },
    expected: ['461c9839e9831c6f', '1f12ca2e24674c66'],
  },
  {
    name: 'highestHp',
    config: { stats: HIGHEST_HP_STATS, rules: [], startWave: 8 },
    data: () => v3TestData(),
    expected: ['7238818b14232ce7', '3bdb6f7dc21b3322'],
  },
  {
    name: 'poisonSlow',
    config: {
      stats: POISON_SLOW_STATS,
      rules: [{ id: 'poisonSlow', stacksPer: 5, slowPer: 0.02, max: 0.4 }],
      startWave: 8,
    },
    data: () => v3TestData(),
    expected: ['7395fc0553e5b380', 'b26cf10df94b895a'],
  },
  {
    name: 'fence',
    config: { stats: FENCE_STATS, rules: [], signature: { id: 'magmaBomb' }, startWave: 12 },
    expected: ['99c9400c39a6f9de', '4e95de42b237b636'],
  },
  {
    name: 'droneWeb',
    config: { stats: DRONE_WEB_STATS, rules: [], signature: { id: 'swarm' }, startWave: 12 },
    expected: ['11d62aceed10bd1a', '773be1decb5c6398'],
  },
  {
    name: 'spread',
    config: { stats: SPREAD_STATS, rules: [], startWave: 12 },
    modules: () => [wildfireModule()],
    expected: ['fb019c0af84ff0b5', 'd4f3333e8e4dd4a4'],
  },
  {
    name: 'summonPolicies',
    config: { stats: SUMMON_POLICY_STATS, rules: [], startWave: 8 },
    data: () => v3TestData(),
    modules: () => [summonPolicyModule()],
    expected: ['e8902de222de4ff1', 'f9ddb7ea027e6525'],
  },
  {
    name: 'minionScaling',
    config: { stats: MINION_SCALING_STATS, rules: [], startWave: 12 },
    expected: ['2c05d44828f0dc2f', 'ab0c793413743f91'],
  },
  {
    name: 'flightSlash',
    config: {
      stats: FLIGHT_SLASH_STATS,
      rules: [],
      signature: { id: 'swarm' },
      character: { id: 'summon', rules: [] },
      startWave: 12,
    },
    modules: fiveDrones,
    expected: ['6cf25678e219387e', 'd983258df11dc284'],
  },
  {
    name: 'hiveRoles',
    config: { stats: HIVE_ROLES_STATS, rules: [], signature: { id: 'swarm' }, startWave: 9 },
    data: () => v3TestData(),
    modules: () => [hiveRolesModule()],
    expected: ['8a792e3aa1a5fc39', '2c1139411aad3d8c'],
  },
  {
    name: 'focusFire',
    config: { stats: FOCUS_FIRE_STATS, rules: [], startWave: 8 },
    data: () => v3TestData(),
    modules: () => [focusFireModule()],
    expected: ['13eb4c5d3f7085d2', 'd6f1fd704e524f17'],
  },
  {
    name: 'selfDestruct',
    config: { stats: SELF_DESTRUCT_STATS, rules: [], signature: { id: 'swarm' }, startWave: 12 },
    modules: () => [swarmFields({ turrets: 0, lastImpact: { radius: 80, damagePct: 1.5 } })],
    expected: ['284a23bfd4930626', 'f1708fa8f56b5901'],
  },
  {
    name: 'guards',
    config: { stats: GUARD_STATS, rules: [], signature: { id: 'swarm' }, startWave: 12 },
    data: guardsData,
    modules: () => [swarmFields({ drones: 4, turrets: 0, guards: { count: 2, radius: 120 } })],
    expected: ['568b23db868767ff', '386d786a2875eff3'],
  },
  {
    name: 'surge',
    config: { stats: SURGE_STATS, rules: [], signature: { id: 'swarm' }, startWave: 20 },
    modules: () => [swarmFields({ drones: 6, surge: { periodSec: 8, damageMult: 2 } })],
    expected: ['dfbb0e7129a32dfd', 'd3a3f581aa9b9f5e'],
  },
  {
    name: 'chainBolts',
    config: { stats: CHAIN_BOLTS_STATS, rules: [], startWave: 12 },
    expected: ['8c4f28efce9228f0', '19e7da6f3f42c620'],
  },
  {
    name: 'shatterChain',
    config: { stats: SHATTER_CHAIN_STATS, rules: [], startWave: 12 },
    modules: () => [shatterChainModule()],
    expected: ['1a4a0456d886a73e', '73c7070f5fc52c99'],
  },
  {
    name: 'frozenNoSplit',
    config: { stats: NO_SPLIT_STATS, rules: [], startWave: 8 },
    data: noSplitData,
    modules: () => [noSplitModule()],
    expected: ['4ee5ff613357723e', '626a400e541a839a'],
  },
  {
    name: 'thaw',
    config: { stats: THAW_STATS, rules: [], startWave: 12 },
    expected: ['e83223c6b7566a9a', '3ecaacfc6cd25bc2'],
  },
  {
    name: 'frostGain',
    config: { stats: FROST_GAIN_STATS, rules: [], startWave: 10 },
    modules: () => [frostGainModule()],
    expected: ['ca215a045e5e26c1', '94329b45724f7c45'],
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
  also: readonly (readonly [RunConfig, GameData, readonly TestModule[]])[] = [],
): string {
  const hash = createHash('sha256');
  // A second run (GoldenC4Entry.also) goes on in the same hash, after the first's result.
  for (const [runConfig, runData, runModules] of [[config, data, modules] as const, ...also]) {
    const sim = createSimulation(runConfig, runData, runModules);
    while (!sim.state.finished) hash.update(JSON.stringify(sim.step(NO_INPUT)));
    const result = sim.result();
    hash.update(
      JSON.stringify([
        projectResult(result),
        result.damageBySource,
        nonzeroCounters(result.counters),
      ]),
    );
  }
  return hash.digest('hex').slice(0, 16);
}

/** One entry at one seed, hashed twice. */
function runCase(entry: GoldenC4Entry, seed: number): [string, string] {
  const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
  const also = entry.also;
  const once = (): string =>
    goldenC4Hash(
      config,
      entry.data?.() ?? makeTestData(),
      entry.modules?.() ?? [],
      also === undefined
        ? []
        : [
            [
              makeConfig({ ...also.config, seed, maxTicks: GOLDEN_C4_TICKS }),
              also.data?.() ?? makeTestData(),
              also.modules?.() ?? [],
            ],
          ],
    );
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
    // The count docs/ARCHITECTURE.md gives: E6's thaw and frostGain are the last two.
    expect([names.length, ...names.slice(-2)]).toEqual([68, 'thaw', 'frostGain']);
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

  it('draws three affixes an elite in affixes, and every affix fires across its seeds (C7.6)', () => {
    const entry = ENTRIES.find((e) => e.name === 'affixes') as GoldenC4Entry;
    const names = (bits: number): string =>
      AFFIX_IDS.filter((_, i) => (bits & (1 << i)) !== 0).join(', ');
    const bySeed: Record<number, { drawn: string[]; children: string[]; fired: string[] }> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const fired = new Set<string>();
      // Each affixed enemy's wave, bits and whether it is a 增殖 child (extra), first seen.
      const carried = new Map<number, { wave: number; bits: number; extra: boolean }>();
      const defence = new Map<number, number>();
      const hp = new Map<number, number>();
      const watch: TestModule = (b) =>
        void b.hook('tick', (ctx) => {
          const factor = ctx.sys.affixes.frostFactor;
          if (factor !== 1) {
            fired.add(`冰霜 holds frostFactor at ${factor}`);
            if (ctx.emitters.every((em) => em.cadence === factor)) {
              fired.add(`冰霜 holds every cadence at ${factor}`);
            }
          }
        });
      const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
      const data = entry.data?.() ?? makeTestData();
      const sim = createSimulation(config, data, [watch]);
      while (!sim.state.finished) {
        for (const enemy of sim.state.enemies) {
          const v = enemy.v3;
          if (v === null || !enemy.alive) continue;
          defence.set(enemy.id, v.defence);
          const was = hp.get(enemy.id);
          const now = toNumber(enemy.hp);
          if (was !== undefined && now > was) fired.add('再生 heals an elite');
          hp.set(enemy.id, now);
          if (v.affixes === 0) continue;
          if (!carried.has(enemy.id)) {
            carried.set(enemy.id, { wave: enemy.wave, bits: v.affixes, extra: v.extra });
          }
          if ((v.defence & ARMOURED) !== 0) fired.add('堅甲 armours an elite');
          if ((v.defence & WARDED) !== 0) fired.add('元素護盾 wards an elite');
          if (v.contactMult === BERSERK_MULT) fired.add('狂暴 doubles its contact damage');
          if (v.baseStep === data.enemies[enemy.type].speed * DT * SWIFT_MULT) {
            fired.add('迅捷 doubles its walk step');
          }
        }
        for (const event of sim.step(NO_INPUT)) {
          if (event.type === 'wardBroken') fired.add('元素護盾 breaks');
          else if (event.type === 'hitBlocked') {
            fired.add(
              ((defence.get(event.targetId) ?? 0) & SHIELDED) === 0
                ? '守護 blocks a hit on an enemy with no shield of its own'
                : 'a shield of its own blocks a hit',
            );
          }
        }
      }
      // Every child carries its parent's other affixes, never 增殖 itself.
      const children = [...carried.values()].filter((e) => e.extra);
      const parents = [...carried.values()].filter((e) => !e.extra);
      if (children.length !== 0) {
        const multiplying = parents.filter((p) => (p.bits & AFFIX_MULTIPLY) !== 0);
        const inherited = children.every((child) =>
          multiplying.some((p) => (p.bits & ~AFFIX_MULTIPLY) === child.bits),
        );
        fired.add(
          children.length === multiplying.length * MULTIPLY_COUNT && inherited
            ? `增殖 leaves ${MULTIPLY_COUNT} children carrying its other affixes`
            : `增殖 leaves ${children.length} children of ${multiplying.length} elites`,
        );
      }
      bySeed[seed] = {
        drawn: parents.map((e) => `wave ${e.wave}: ${names(e.bits)}`),
        children: children.map((e) => `wave ${e.wave}: ${names(e.bits)}`),
        fired: [...fired].sort(),
      };
    }
    // Each of the three waves releases one elite that draws three distinct affixes; seed 1's
    // first multiplies, seed 2's third does. Between them the eight affixes all fire: seed 1 has
    // 再生 and 冰霜, seed 2 守護, and both have 迅捷, 堅甲, 增殖, 狂暴 and 元素護盾.
    expect(bySeed).toEqual({
      1: {
        drawn: [
          'wave 12: regen, multiply, ward',
          'wave 13: armoured, berserk, ward',
          'wave 14: swift, ward, frost',
        ],
        children: ['wave 12: regen, ward', 'wave 12: regen, ward'],
        fired: [
          '元素護盾 breaks',
          '元素護盾 wards an elite',
          '再生 heals an elite',
          '冰霜 holds every cadence at 0.75',
          '冰霜 holds frostFactor at 0.75',
          '堅甲 armours an elite',
          '增殖 leaves 2 children carrying its other affixes',
          '狂暴 doubles its contact damage',
          '迅捷 doubles its walk step',
        ],
      },
      2: {
        drawn: [
          'wave 12: swift, guardian, berserk',
          'wave 13: armoured, guardian, ward',
          'wave 14: guardian, multiply, ward',
        ],
        children: ['wave 14: guardian, ward', 'wave 14: guardian, ward'],
        fired: [
          '元素護盾 breaks',
          '元素護盾 wards an elite',
          '堅甲 armours an elite',
          '增殖 leaves 2 children carrying its other affixes',
          '守護 blocks a hit on an enemy with no shield of its own',
          '狂暴 doubles its contact damage',
          '迅捷 doubles its walk step',
        ],
      },
    });
  });

  it('breaks each onion’s shells in onion one by one, by hits and damage over time, each spraying twelve triangles, and pays its drops once, at its kill (C7.7)', () => {
    const entry = ENTRIES.find((e) => e.name === 'onion') as GoldenC4Entry;
    interface OnionSeen {
      wave: number;
      /** What broke each shell, and the layers it left. */
      breaks: string[];
      burst: number[];
      kills: { shards: number; cores: number }[];
    }
    const bySeed: Record<number, string[]> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
      const sim = createSimulation(config, entry.data?.() ?? makeTestData());
      const onions = new Map<number, OnionSeen>();
      const shardsOf = new Map<number, number>();
      while (!sim.state.finished) {
        let cause = '';
        // The enemySpawned events right before an onionLayer: its burst.
        let spawned: number[] = [];
        for (const event of sim.step(NO_INPUT)) {
          if (event.type === 'enemySpawned') {
            if (event.enemy === 'onion') {
              const wave = sim.state.enemies.find((e) => e.id === event.enemyId)?.wave ?? 0;
              onions.set(event.enemyId, { wave, breaks: [], burst: [], kills: [] });
            }
            spawned.push(event.enemyId);
            continue;
          }
          if (event.type === 'onionLayer') {
            const onion = onions.get(event.enemyId) as OnionSeen;
            onion.breaks.push(`${cause} (${event.layersLeft} left, ${spawned.length} sprayed)`);
            onion.burst.push(...spawned);
          } else if (event.type === 'enemyKilled') {
            shardsOf.set(event.enemyId, toNumber(event.shards));
            onions
              .get(event.enemyId)
              ?.kills.push({ shards: toNumber(event.shards), cores: event.cores });
          } else if (event.type === 'hit') cause = 'hit';
          else if (event.type === 'burnTick') cause = 'burn';
          else if (event.type === 'dotTick') cause = event.ailment;
          spawned = [];
        }
      }
      bySeed[seed] = [...onions].map(([id, onion]) => {
        // A kill pays 16 ×: 32 × the 0.5 of a triangle its bursts sprayed into its wave.
        const triangle = onion.burst
          .map((child) => shardsOf.get(child))
          .find((v) => v !== undefined);
        const kills = onion.kills.map(({ shards, cores }) =>
          triangle !== undefined && shards === toNumber(mul(num(32), triangle))
            ? `killed: 32 × a burst triangle’s shards, ${cores} cores`
            : `killed: ${shards} shards, ${cores} cores`,
        );
        return `onion ${id}, wave ${onion.wave}: ${[...onion.breaks, ...kills].join('; ')}`;
      });
    }
    // Waves 10 and 11's onions lose all three shells and die; wave 12's loses one by the end.
    // Seed 1's last shells go to burns, seed 2's to poison, which takes seed 2's first onion's
    // second shell too.
    expect(bySeed).toEqual({
      1: [
        'onion 5, wave 10: hit (2 left, 12 sprayed); hit (1 left, 12 sprayed); burn (0 left, 12 sprayed); killed: 32 × a burst triangle’s shards, 3 cores',
        'onion 54, wave 11: hit (2 left, 12 sprayed); hit (1 left, 12 sprayed); burn (0 left, 12 sprayed); killed: 32 × a burst triangle’s shards, 3 cores',
        'onion 90, wave 12: hit (2 left, 12 sprayed)',
      ],
      2: [
        'onion 7, wave 10: hit (2 left, 12 sprayed); poison (1 left, 12 sprayed); poison (0 left, 12 sprayed); killed: 32 × a burst triangle’s shards, 3 cores',
        'onion 60, wave 11: hit (2 left, 12 sprayed); hit (1 left, 12 sprayed); poison (0 left, 12 sprayed); killed: 32 × a burst triangle’s shards, 3 cores',
        'onion 105, wave 12: burn (2 left, 12 sprayed)',
      ],
    });
  });

  it('fills the stacks to the cap in combo, halves them at a leak, clears them after 60 idle ticks between releases, and runs a 2 s buff window (C6b.2)', () => {
    const entry = ENTRIES.find((e) => e.name === 'combo') as GoldenC4Entry;
    const bySeed: Record<number, Record<string, string[]>> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const seen: Record<string, string[]> = { cap: [], halved: [], cleared: [], buffed: [] };
      let prev = 0;
      let buffFrom = -1;
      // At each tick's end of the emitter stage: the stacks after the tick's hits on the player,
      // its combo step and its attacks.
      const watch: TestModule = (b) =>
        void b.hook('tick', (ctx) => {
          const cs = ctx.sys.combo;
          const em = ctx.emitters[0] as EmitterRuntime;
          const wave = ctx.current?.wave ?? 0;
          if (cs.stacks === 20 && prev < 20) seen.cap?.push(`${ctx.now} (wave ${wave})`);
          if (ctx.events.some((e) => e.type === 'playerHit')) {
            seen.halved?.push(`${ctx.now}: ${prev} → ${cs.stacks}`);
          }
          if (cs.idle > 0 && cs.idle % 60 === 0 && prev > 0) {
            const rec = ctx.current;
            const left = rec === null ? 0 : rec.queue.length - rec.released;
            seen.cleared?.push(
              `${ctx.now} (wave ${wave}, ${left} to release): ${prev} → ${cs.stacks}`,
            );
          }
          // The buff's factor × the combo factor, 冰霜 never there.
          const factor = cs.comboFactor[0] as number;
          if (cs.active > 0 && buffFrom < 0) buffFrom = ctx.now;
          if (cs.active > 0 && em.cadence !== factor * 3) seen.buffed?.push(`${ctx.now}: off`);
          if (cs.active === 0 && buffFrom >= 0) {
            seen.buffed?.push(`${buffFrom}–${ctx.now - 1}`);
            buffFrom = -1;
          }
          if (cs.active === 0 && em.cadence !== factor) seen.buffed?.push(`${ctx.now}: off`);
          prev = cs.stacks;
        });
      const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
      const sim = createSimulation(config, entry.data?.() ?? makeTestData(), [watch]);
      while (!sim.state.finished) sim.step(NO_INPUT);
      bySeed[seed] = seen;
    }
    // Both seeds fill the stacks in wave 12, each square that walks in halves them, and each
    // wave's first releases die more than a second before the next one appears: the gaps clear
    // them. A wave starts the tick after the field is clear and releases its first enemy at
    // once, so no gap ever falls between two waves. The buff fires at tick 602 (its period from
    // tick 1, staggered by its trigger index, 1) and holds the cadence at its combo factor × 3
    // for 120 emitter stages, and at the combo factor alone outside its window.
    expect(bySeed).toEqual({
      1: {
        cap: ['228 (wave 12)', '457 (wave 13)', '722 (wave 13)'],
        halved: ['376: 20 → 10', '964: 20 → 10'],
        cleared: [
          '515 (wave 13, 3 to release): 20 → 0',
          '643 (wave 13, 2 to release): 6 → 0',
          '1065 (wave 14, 3 to release): 15 → 0',
        ],
        buffed: ['603–722'],
      },
      2: {
        cap: ['263 (wave 12)', '730 (wave 13)'],
        halved: ['406: 20 → 10'],
        cleared: ['528 (wave 13, 3 to release): 18 → 0', '635 (wave 13, 2 to release): 5 → 0'],
        buffed: ['603–722'],
      },
    });
  });

  it('reads the held-shard factor from 1e4^0.12 = 3.02 rising with the run’s shards, counts the aura’s enemies, credits the coin’s kills × 1.01 and no other kill, and lets the coins through shields and armour in greed (C6b.3)', () => {
    const entry = ENTRIES.find((e) => e.name === 'greed') as GoldenC4Entry;
    const COIN = 1; // the coin trigger's index, after SHATTER_TRIGGER
    const bySeed: Record<number, Record<string, unknown>> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const held: number[] = [];
      const aura = new Set<number>();
      const kills: Record<string, number> = {};
      // Each victim's drop before the kill shards, and what its kill must credit.
      const credit = new Map<number, Num>();
      const watch: TestModule = (b) => {
        b.hook('tick', (ctx) => {
          held.push(ctx.evalInput.shardsHeld);
          aura.add(ctx.evalInput.enemiesInAura);
        });
        b.hook('onKill', (ctx, victim, kill) => {
          const base = mul(
            mul(mul(num(victim.def.dropMult), victim.rec.shardsPerStd), ctx.shardGain),
            victim.v3?.dropScale ?? 1,
          );
          const by = kill.origin === COIN ? 'coin' : victim.killKind === 0 ? 'hit' : 'dot';
          kills[by] = (kills[by] ?? 0) + 1;
          credit.set(victim.id, by === 'coin' ? mul(base, 1.01) : base);
        });
      };
      const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
      const sim = createSimulation(config, entry.data?.() ?? makeTestData(), [
        ...(entry.modules?.() ?? []),
        watch,
      ]);
      const types = new Map<number, EnemyId>();
      const seen = new Set<string>();
      let credited = 0;
      while (!sim.state.finished) {
        for (const event of sim.step(NO_INPUT)) {
          if (event.type === 'enemySpawned') types.set(event.enemyId, event.enemy);
          else if (event.type === 'hitBlocked') seen.add(`${types.get(event.targetId)} blocks`);
          else if (event.type === 'hit' && event.source !== 0) {
            seen.add(`${types.get(event.targetId)} takes source ${event.source}`);
          } else if (event.type === 'pulse') {
            seen.add(`${event.kind} pulse`);
          } else if (event.type === 'enemyKilled') {
            expect(event.shards, `kill of ${event.enemyId}`).toBe(credit.get(event.enemyId));
            credited++;
          }
        }
      }
      const factor = (x: number): number => Math.max(1, x) ** 0.12;
      expect(credited).toBe(credit.size);
      bySeed[seed] = {
        start: factor(held[0] as number).toFixed(4),
        end: factor(held.at(-1) as number).toFixed(4),
        rising: held.every((x, i) => i === 0 || x >= (held[i - 1] as number)),
        aura: [Math.min(...aura), Math.max(...aura)],
        kills,
        seen: [...seen].sort(),
      };
    }
    // The factor starts at 1e4^0.12 and only rises, by 0.01 over the run's shards; the coins
    // (source 1) kill most, landing on shielders, whose shields block the volley, and on armoured
    // squares; the aura pulses, and reaches at most 3 enemies at once; burns and the volley's or
    // the aura's hits kill the rest, each credited its plain drop.
    const seen = [
      'aura pulse',
      'shielder blocks',
      'shielder takes source 1',
      'square takes source 1',
    ];
    expect(bySeed).toEqual({
      1: {
        start: '3.0200',
        end: '3.0308',
        rising: true,
        aura: [0, 3],
        kills: { coin: 18, dot: 13, hit: 2 },
        seen,
      },
      2: {
        start: '3.0200',
        end: '3.0300',
        rising: true,
        aura: [0, 2],
        kills: { coin: 19, dot: 8, hit: 4 },
        seen,
      },
    });
  });

  it('echoes each attack at full stacks in afterimage 18 ticks later at half damage, through a halving and past the run’s end (C6b.4)', () => {
    const entry = ENTRIES.find((e) => e.name === 'afterimage') as GoldenC4Entry;
    const bySeed: Record<number, Record<string, unknown>> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const full: string[] = [];
      const halved: string[] = [];
      const cleared: string[] = [];
      const late: string[] = [];
      const afterHalving: string[] = [];
      const shares = { echo: new Set<number>(), attack: new Set<number>() };
      const waiting: number[] = [];
      let first = '';
      let last = '';
      let fullFrom = -1;
      let halvedAt = -1;
      let prev = 0;
      let scheduled = 0;
      let fired = 0;
      let count = 0;
      // At each tick's end of the emitter stage, after its hits on the player, its drain and its
      // attacks: the echoes the tick scheduled and fired (in scheduling order, as they share one
      // delay), the stretches of full stacks and the halvings.
      const watch: TestModule = (b) => {
        b.hook('tick', (ctx) => {
          const list = ctx.sys.repeat.delayed;
          const stacks = ctx.sys.combo.stacks;
          if (ctx.events.some((e) => e.type === 'playerHit')) {
            halved.push(`${ctx.now}: ${prev} → ${stacks}`);
            halvedAt = ctx.now;
          }
          const idle = ctx.sys.combo.idle;
          if (idle > 0 && idle % 60 === 0 && prev > 0)
            cleared.push(`${ctx.now}: ${prev} → ${stacks}`);
          const fresh = list.scheduled - scheduled;
          const out = count + fresh - list.count;
          for (let n = 0; n < out; n++) {
            const at = waiting.shift() as number;
            if (ctx.now - at !== 18) late.push(`${at} → ${ctx.now}`);
            if (at < halvedAt) afterHalving.push(`${at} → ${ctx.now}`);
            last = `${at} → ${ctx.now}`;
          }
          for (let n = 0; n < fresh; n++) waiting.push(ctx.now);
          if (first === '' && fresh > 0) first = `${ctx.now} (wave ${ctx.current?.wave ?? 0})`;
          scheduled = list.scheduled;
          fired += out;
          count = list.count;
          if (stacks >= 20 && fullFrom < 0) fullFrom = ctx.now;
          if (stacks < 20 && fullFrom >= 0) {
            full.push(`${fullFrom}–${ctx.now - 1}`);
            fullFrom = -1;
          }
          prev = stacks;
        });
        // A primary emitter hit's share of 10 × (1 + 0.02 per stack), the attack's damage at the
        // stacks it lands at: × 1.5 on a crit.
        b.hook('onHit', (ctx, hit) => {
          if (hit.origin !== -1 || hit.chainIndex !== 0) return;
          const share = toNumber(hit.amount) / (10 * (1 + 0.02 * ctx.sys.combo.stacks));
          shares[(hit.flags & REPEAT) !== 0 ? 'echo' : 'attack'].add(Math.round(share * 1e9) / 1e9);
        });
      };
      const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
      const modules = [...(entry.modules?.() ?? []), watch];
      const sim = createSimulation(config, entry.data?.() ?? makeTestData(), modules);
      while (!sim.state.finished) sim.step(NO_INPUT);
      if (fullFrom >= 0) full.push(`${fullFrom}–`);
      bySeed[seed] = {
        first,
        last,
        full,
        halved,
        cleared,
        scheduled,
        fired,
        pending: count,
        late,
        afterHalving,
        echoShares: [...shares.echo].sort(),
        attackShares: [...shares.attack].sort(),
      };
    }
    // Both seeds fill the stacks in wave 12, as combo does, and echo each attack from then on,
    // 18 ticks after it, until a square walks in and halves them; the two echoes still waiting
    // fire after the halving all the same. Seed 1 fills them again at 712 and schedules its last
    // echo at 944, the gap between releases clearing the stacks at 1013; seed 2 fills them at
    // 722 and is still echoing when the run ends, two echoes left unfired. Each echo fires 18
    // ticks after its attack, and its primary hit deals half the attack's damage at the stacks
    // it lands at, × 1.5 on a crit.
    const echoes = { echoShares: [0.5, 0.75], attackShares: [1, 1.5], late: [] };
    expect(bySeed).toEqual({
      1: {
        ...echoes,
        first: '228 (wave 12)',
        last: '944 → 962',
        full: ['228–375', '712–1012'],
        halved: ['376: 20 → 10'],
        cleared: ['505: 19 → 0', '633: 6 → 0', '1013: 20 → 0', '1158: 6 → 0'],
        scheduled: 44,
        fired: 44,
        pending: 0,
        afterHalving: ['359 → 377', '368 → 386'],
      },
      2: {
        ...echoes,
        first: '263 (wave 12)',
        last: '1180 → 1198',
        full: ['263–405', '722–'],
        halved: ['406: 20 → 10'],
        cleared: ['519: 16 → 0', '632: 5 → 0'],
        scheduled: 68,
        fired: 66,
        pending: 2,
        afterHalving: ['394 → 412', '404 → 422'],
      },
    });
  });

  /** The squared distance between two points. */
  const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

  /**
   * A run of `entry` at `seed` with the entry's modules and a hook that keeps the run's context:
   * `each` sees each tick's number, events and context once the tick is over.
   */
  function watchRun(
    entry: GoldenC4Entry,
    seed: number,
    each: (now: number, events: readonly SimEvent[], ctx: RunContext) => void,
  ): void {
    const watched: { ctx: RunContext | null } = { ctx: null };
    const grab: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        watched.ctx = ctx;
      });
    const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
    const modules = [...(entry.modules?.() ?? []), grab];
    const sim = createSimulation(config, entry.data?.() ?? makeTestData(), modules);
    while (!sim.state.finished) {
      const now = sim.state.tick + 1;
      const events = sim.step(NO_INPUT);
      each(now, events, watched.ctx as RunContext);
    }
  }

  it('holds at most 8 live bleed stacks an enemy in bleedRings, its walkers and dashers bleeding in rings, the strongest-only slot unused (C7b)', () => {
    const entry = ENTRIES.find((e) => e.name === 'bleedRings') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const types = new Map<number, EnemyId>();
      const capped = new Set<number>();
      const applied: number[] = Array(9).fill(0);
      const steps: Record<string, number> = {};
      const lengths = new Set<number>();
      let maxLive = 0;
      let capTicks = 0;
      let slotUsed = 0;
      watchRun(entry, seed, (now, events, ctx) => {
        for (const event of events) {
          if (event.type === 'enemySpawned') types.set(event.enemyId, event.enemy);
          else if (event.type === 'ailmentApplied' && event.ailment === 'bleed') {
            applied[event.stacks] = (applied[event.stacks] ?? 0) + 1;
          } else if (event.type === 'dotTick' && event.ailment === 'bleed') {
            const type = types.get(event.targetId) ?? 'none';
            steps[type] = (steps[type] ?? 0) + 1;
          }
        }
        for (const e of ctx.enemies) {
          if (!e.alive) continue;
          lengths.add(e.rings.length);
          if (e.bleedUntil !== 0) slotUsed++;
          const live = liveBleedStacks(ctx.rings, e, now);
          maxLive = Math.max(maxLive, live);
          if (live === 8) {
            capTicks++;
            capped.add(e.id);
          }
        }
      });
      bySeed[seed] = {
        maxLive,
        capped: capped.size,
        capTicks,
        applied: applied.join(' '),
        steps,
        lengths: [...lengths],
        slotUsed,
      };
    }
    // The cap holds: no enemy ever holds 9 live stacks, and the 8th stack's applications are the
    // most common (`applied` counts each application's stacks after it, from 0 to 8). Every ring
    // is 9 long, both walkers and dashers bleed, and no bleed takes the strongest-only slot.
    expect(bySeed).toEqual({
      1: {
        maxLive: 8,
        capped: 9,
        capTicks: 1236,
        applied: '0 15 14 13 13 15 14 12 26',
        steps: { square: 173, dasher: 27 },
        lengths: [9],
        slotUsed: 0,
      },
      2: {
        maxLive: 8,
        capped: 10,
        capTicks: 1019,
        applied: '0 12 12 11 11 11 13 12 22',
        steps: { square: 156, dasher: 37 },
        lengths: [9],
        slotUsed: 0,
      },
    });
  });

  it('pushes every dashing dasher 80 back after thorns ×3 in contactHooks, none leaking, and holds an onion for 60 ticks with 4 thorns rounds and its life loss at the end (C7b)', () => {
    const entry = ENTRIES.find((e) => e.name === 'contactHooks') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const types = new Map<number, EnemyId>();
      const last = new Map<number, { state: number; dist: number; step: number }>();
      const pushes = new Set<string>();
      const thorns: Record<string, Set<number>> = {};
      const holds = new Map<
        number,
        { touch: number; until: number; rounds: number[]; hit: string }
      >();
      const leaks: Record<string, number> = {};
      let repels = 0;
      watchRun(entry, seed, (now, events, ctx) => {
        for (const event of events) {
          if (event.type === 'enemySpawned') types.set(event.enemyId, event.enemy);
          else if (event.type === 'hit' && (event.tags & TAG.thorns) !== 0) {
            const type = types.get(event.targetId) ?? 'none';
            (thorns[type] ??= new Set()).add(toNumber(event.amount));
            holds.get(event.targetId)?.rounds.push(now);
          } else if (event.type === 'playerHit') {
            const type = types.get(event.enemyId) ?? 'none';
            leaks[type] = (leaks[type] ?? 0) + 1;
            const hold = holds.get(event.enemyId);
            if (hold !== undefined) hold.hit = `${now} for ${event.damage}`;
          }
        }
        for (const e of ctx.enemies) {
          const v = e.v3;
          if (v === null || !e.alive) continue;
          const was = last.get(e.id);
          if (was !== undefined && was.state === DASHING && v.state === 0) {
            repels++;
            pushes.add(`+${Math.round((e.dist - (was.dist - was.step)) * 1e6) / 1e6}`);
          }
          if (v.state === ENTANGLED && !holds.has(e.id)) {
            // Its touch's thorns hit came before the hold began: this tick's.
            holds.set(e.id, { touch: now, until: v.stateUntil, rounds: [now], hit: '' });
          }
          last.set(e.id, { state: v.state, dist: e.dist, step: e.stepDist });
        }
      });
      bySeed[seed] = {
        repels,
        pushes: [...pushes],
        thorns: Object.fromEntries(Object.entries(thorns).map(([k, v]) => [k, [...v]])),
        leaks,
        holds: [...holds].map(
          ([id, h]) =>
            `${types.get(id)} ${id}: touch ${h.touch}, until ${h.until}, rounds ${[...new Set(h.rounds)].join('/')}, life loss ${h.hit}`,
        ),
      };
    }
    // Every repel puts the dasher back 80 past where its dash step left it, its thorns hit 36
    // (12 × 3 on a dashing target) against the onion's 12; no dasher's contact costs life. The
    // onion is held from its touch for 60 ticks, takes thorns at the touch and each 15 ticks after,
    // 4 rounds, and costs its 100 only at the release: its one playerHit.
    expect(bySeed).toEqual({
      1: {
        repels: 55,
        pushes: ['+80'],
        thorns: { dasher: [36], onion: [12] },
        leaks: { onion: 1 },
        holds: ['onion 1: touch 939, until 999, rounds 939/954/969/984, life loss 999 for 100'],
      },
      2: {
        repels: 57,
        pushes: ['+80'],
        thorns: { dasher: [36], onion: [12] },
        leaks: { onion: 1 },
        holds: ['onion 2: touch 716, until 776, rounds 716/731/746/761, life loss 776 for 100'],
      },
    });
  });

  it('dodges a bullet at most every 180 ticks at 15 stacks or more in bulletHooks/dodgeBlock, lands the others, and blocks those an orb touches (C7b)', () => {
    const entry = ENTRIES.find((e) => e.name === 'bulletHooks/dodgeBlock') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const dodged: string[] = [];
      let stacks = 0;
      let blocked = 0;
      let hits = 0;
      let cooling = 0;
      let missed = 0;
      let readyAt = 0;
      watchRun(entry, seed, (now, events, ctx) => {
        for (const event of events) {
          if (event.type === 'bulletDodged') {
            dodged.push(`${now} at ${stacks}`);
            readyAt = now + 180;
          } else if (event.type === 'bulletBlocked') blocked++;
          else if (event.type === 'bulletHit') {
            hits++;
            if (stacks >= 15 && now < readyAt) cooling++;
            else if (stacks >= 15) missed++;
          }
        }
        // The stacks the next tick's bullets meet.
        stacks = ctx.sys.combo.stacks;
      });
      bySeed[seed] = { dodged, blocked, hits, cooling, missed };
    }
    // Each dodge comes at 15 stacks or more and at least 180 ticks after the one before; the hits
    // at 15 stacks or more all land in a dodge's cooldown (`missed` 0), and the orbs block some.
    expect(bySeed).toEqual({
      1: {
        dodged: ['359 at 20', '550 at 20', '738 at 18', '924 at 20', '1116 at 20'],
        blocked: 26,
        hits: 41,
        cooling: 35,
        missed: 0,
      },
      2: {
        dodged: ['348 at 20', '539 at 20', '731 at 19', '928 at 20', '1131 at 17'],
        blocked: 22,
        hits: 46,
        cooling: 27,
        missed: 0,
      },
    });
  });

  it('turns every bullet at the player in bulletHooks/reflect, brings the first thorns payload’s hit home to each live shooter and drops those whose shooter died (C7b)', () => {
    const entry = ENTRIES.find((e) => e.name === 'bulletHooks/reflect') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const types = new Map<number, EnemyId>();
      const reflected = new Set<number>();
      const amounts = new Set<number>();
      let flying = new Set<number>();
      let arrivals = 0;
      let vanished = 0;
      let bulletHits = 0;
      watchRun(entry, seed, (_now, events, ctx) => {
        for (const event of events) {
          if (event.type === 'enemySpawned') types.set(event.enemyId, event.enemy);
          else if (event.type === 'bulletHit') bulletHits++;
          else if (
            event.type === 'hit' &&
            (event.tags & TAG.thorns) !== 0 &&
            types.get(event.targetId) === 'shooter'
          ) {
            arrivals++;
            amounts.add(toNumber(event.amount));
          }
        }
        const pool = ctx.sys.bullets;
        const now = new Set<number>();
        for (let s = 0; s < pool.count; s++) {
          if (pool.reflected[s] === 1) {
            reflected.add(pool.id[s] as number);
            now.add(pool.id[s] as number);
          }
        }
        for (const id of flying) if (!now.has(id)) vanished++;
        flying = now;
      });
      bySeed[seed] = {
        reflected: reflected.size,
        arrivals,
        amounts: [...amounts].sort((a, b) => a - b),
        gone: vanished - arrivals,
        flying: flying.size,
        bulletHits,
      };
    }
    // No bullet hits the player; each reflected bullet arrives (a thorns hit of 18, 27 on a crit),
    // is gone with its dead shooter, or is still in flight at the end: 50 + 3 + 5 and 45 + 3 + 10.
    expect(bySeed).toEqual({
      1: { reflected: 58, arrivals: 50, amounts: [18, 27], gone: 3, flying: 5, bulletHits: 0 },
      2: { reflected: 58, arrivals: 45, amounts: [18, 27], gone: 3, flying: 10, bulletHits: 0 },
    });
  });

  it('lands the shielders’ hits below their shield’s 15 % only as a pool in shieldPool (C7b)', () => {
    const entry = ENTRIES.find((e) => e.name === 'shieldPool') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const pools = new Set<string>();
      let pooled = 0;
      let alone = 0;
      let blocked = 0;
      watchRun(entry, seed, (_now, events, ctx) => {
        const byId = new Map(ctx.enemies.map((e) => [e.id, e]));
        for (const event of events) {
          if (event.type !== 'hit' && event.type !== 'hitBlocked') continue;
          const e = byId.get(event.targetId);
          if (e === undefined || e.type !== 'shielder') continue;
          if (event.type === 'hitBlocked') blocked++;
          else if (toNumber(event.amount) < 0.15 * toNumber(e.maxHp)) pooled++;
          else alone++;
        }
        for (const e of ctx.enemies) {
          const v = e.v3;
          if (e.type === 'shielder' && v !== null && v.poolStart >= 0)
            pools.add(`${e.id}@${v.poolStart}`);
        }
      });
      bySeed[seed] = { pooled, alone, blocked, pools: pools.size };
    }
    // Without the pool every hit on a shielder is blocked; with it, some land below 15 % of the
    // shielder's life, and none of the build's hits is 15 % alone.
    expect(bySeed).toEqual({
      1: { pooled: 49, alone: 0, blocked: 480, pools: 163 },
      2: { pooled: 63, alone: 0, blocked: 469, pools: 156 },
    });
  });

  it('sizes the bombs and their 火地 × 1.5 × 1.2, the novas, the kill explosions, the shatters and the aura × 1.5 in areaSize (E1)', () => {
    const entry = ENTRIES.find((e) => e.name === 'areaSize') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const radii = new Map<string, Set<number>>();
      const counts = new Map<string, number>();
      const seen = (kind: string, radius: number): void => {
        radii.set(kind, (radii.get(kind) ?? new Set()).add(radius));
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      };
      let pulses = 0;
      let past120 = 0;
      watchRun(entry, seed, (_now, events, ctx) => {
        for (const event of events) {
          if (event.type === 'explosion') seen('explosion', event.radius);
          else if (event.type === 'zone') seen(event.signature ? 'fireZone' : 'zone', event.radius);
          else if (event.type === 'burst') seen(event.kind, event.radius);
          else if (event.type === 'shatter') seen('shatter', event.radius);
          else if (event.type === 'pulse' && event.kind === 'aura') pulses++;
        }
        // The aura reaches 180: the grid's count within it, more than within 120 at times.
        const { x, y } = ctx.player;
        expect(enemiesInAura(ctx)).toBe(ctx.grid.countWithin(x, y, 180 * 180));
        if (enemiesInAura(ctx) > ctx.grid.countWithin(x, y, 120 * 120)) past120++;
      });
      bySeed[seed] = {
        radii: Object.fromEntries([...radii].map(([kind, set]) => [kind, [...set]])),
        counts: Object.fromEntries(counts),
        pulses,
        past120: past120 > 0,
      };
    }
    // R = 60 × 1.5 × 1.2 = 108 for the bombs and their 火地; 100, 80 and 90 × 1.5 for the rest.
    const radii = {
      explode: [120],
      explosion: [108],
      fireZone: [108],
      nova: [150],
      shatter: [135],
    };
    expect(bySeed).toEqual({
      1: {
        radii,
        counts: { explode: 20, explosion: 84, fireZone: 84, nova: 25, shatter: 47 },
        pulses: 13,
        past120: true,
      },
      2: {
        radii,
        counts: { explode: 17, explosion: 94, fireZone: 94, nova: 26, shatter: 55 },
        pulses: 27,
        past120: true,
      },
    });
  });

  it('throws two bombs a firing from raw 5, chains once and doubles every radius, then halves the swarm’s and the grant’s drones and keeps their turrets in gigantism (E1)', () => {
    const entry = ENTRIES.find((e) => e.name === 'gigantism') as GoldenC4Entry;
    const swarm: GoldenC4Entry = {
      name: 'gigantism/swarm',
      config: (entry.also as GoldenC4Entry).config,
      expected: entry.expected,
    };
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const radii = new Map<string, Set<number>>();
      const seen = (kind: string, radius: number): void => {
        radii.set(kind, (radii.get(kind) ?? new Set()).add(radius));
      };
      const firings = new Map<number, number>();
      let maxChain = 0;
      let projectileCount = 0;
      watchRun(entry, seed, (now, events, ctx) => {
        projectileCount = ctx.projectileCount;
        for (const event of events) {
          if (event.type === 'lob' && event.form === 0)
            firings.set(now, (firings.get(now) ?? 0) + 1);
          else if (event.type === 'explosion') seen('explosion', event.radius);
          else if (event.type === 'zone') seen(event.signature ? 'fireZone' : 'zone', event.radius);
          else if (event.type === 'burst') seen(event.kind, event.radius);
          else if (event.type === 'shatter') seen('shatter', event.radius);
          else if (event.type === 'hit') maxChain = Math.max(maxChain, event.chainIndex);
        }
      });
      const impacts = new Map<number, number>();
      const turrets = new Map<number, number>();
      let layout: number[] = [];
      watchRun(swarm, seed, (_now, events, ctx) => {
        const ds = ctx.sys.drones;
        layout = Array.from(ds.kind.slice(0, ds.count));
        for (const event of events) {
          if (event.type === 'impact') {
            seen('impact', event.radius);
            impacts.set(event.droneId, (impacts.get(event.droneId) ?? 0) + 1);
          } else if (event.type === 'turretFire') {
            turrets.set(event.droneId, (turrets.get(event.droneId) ?? 0) + 1);
          }
        }
      });
      const perFiring = new Map<number, number>();
      for (const n of firings.values()) perFiring.set(n, (perFiring.get(n) ?? 0) + 1);
      bySeed[seed] = {
        projectileCount,
        perFiring: Object.fromEntries(perFiring),
        maxChain,
        radii: Object.fromEntries([...radii].map(([kind, set]) => [kind, [...set]])),
        layout,
        impactDrones: [...impacts.keys()].sort((a, b) => a - b),
        turretDrones: [...turrets.keys()].sort((a, b) => a - b),
      };
    }
    // Every radius × 2 once: R 120 and its 火地, novas 200, kill explosions 160, shatters 180,
    // the drones' splash 80. The swarm's row: a drone and its turret, then the grant's 2 and 2.
    const radii = {
      explode: [160],
      explosion: [120],
      fireZone: [120],
      impact: [80],
      nova: [200],
      shatter: [180],
    };
    const drones = { layout: [0, 1, 0, 0, 1, 1], impactDrones: [1, 3, 4], turretDrones: [2, 5, 6] };
    expect(bySeed).toEqual({
      1: { projectileCount: 2, perFiring: { 1: 8, 2: 36 }, maxChain: 1, radii, ...drones },
      2: { projectileCount: 2, perFiring: { 1: 11, 2: 33 }, maxChain: 1, radii, ...drones },
    });
  });

  it('spawns, caps, impacts and leaves timed rows in spirits and temporaries, the one at its maxLive of 6 and burning, the other at the summon cap of 24 with its fixed rows kept (C5.7)', () => {
    /** Per seed: the rows' coverage, from the pool at each tick's start and the run's events. */
    const coverage = (name: string): Record<number, Record<string, number>> => {
      const entry = ENTRIES.find((e) => e.name === name) as GoldenC4Entry;
      const bySeed: Record<number, Record<string, number>> = {};
      for (const seed of GOLDEN_C4_SEEDS) {
        const seen = { fixed: -1, maxRows: 0, maxLive: 0, fixedKept: 1 };
        const watched: { ctx: RunContext | null } = { ctx: null };
        const watch: TestModule = (b) =>
          void b.hook('tick', (ctx) => {
            watched.ctx = ctx;
            const ds = ctx.sys.drones;
            if (seen.fixed < 0) seen.fixed = ds.nextId - 1;
            seen.maxRows = Math.max(seen.maxRows, ds.count);
            for (const live of ds.specs?.live ?? []) seen.maxLive = Math.max(seen.maxLive, live);
            for (let s = 0; s < seen.fixed; s++) if (ds.id[s] !== s + 1) seen.fixedKept = 0;
          });
        const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
        const sim = createSimulation(config, entry.data?.() ?? makeTestData(), [
          ...(entry.modules?.() ?? []),
          watch,
        ]);
        let impacts = 0;
        let time = 0;
        let spent = 0;
        let ailmentTerm = 0;
        while (!sim.state.finished) {
          // A row's ailment term: the ignites right after its impact event.
          let term = false;
          for (const event of sim.step(NO_INPUT)) {
            if (event.type === 'impact') {
              term = event.droneId > seen.fixed;
              if (term) impacts++;
            } else if (term && event.type === 'ignite') ailmentTerm++;
            else {
              term = false;
              if (event.type === 'droneExpire') {
                if (event.cause === 'time') time++;
                else spent++;
              }
            }
          }
        }
        const ds = (watched.ctx as RunContext).sys.drones;
        bySeed[seed] = {
          spawns: ds.nextId - 1 - seen.fixed,
          refused: sim.result().counters.summonCapped,
          maxRows: seen.maxRows,
          maxLive: seen.maxLive,
          impacts,
          time,
          spent,
          ailmentTerm,
          fixedKept: seen.fixedKept,
        };
      }
      return bySeed;
    };
    // spirits: the sixth live row reached and later ones refused; 3 burn stacks a hit enemy
    // still alive, after each impact; a few rows leave on time, before they reach their enemy.
    expect(coverage('spirits')).toEqual({
      1: {
        spawns: 52,
        refused: 8,
        maxRows: 6,
        maxLive: 6,
        impacts: 46,
        time: 2,
        spent: 46,
        ailmentTerm: 141,
        fixedKept: 1,
      },
      2: {
        spawns: 47,
        refused: 13,
        maxRows: 6,
        maxLive: 6,
        impacts: 39,
        time: 3,
        spent: 39,
        ailmentTerm: 120,
        fixedKept: 1,
      },
    });
    // temporaries: 20 timed rows beside the 4 fixed ones, which never leave, and the rest refused.
    expect(coverage('temporaries')).toEqual({
      1: {
        spawns: 142,
        refused: 24,
        maxRows: 24,
        maxLive: 20,
        impacts: 389,
        time: 4,
        spent: 124,
        ailmentTerm: 0,
        fixedKept: 1,
      },
      2: {
        spawns: 135,
        refused: 39,
        maxRows: 24,
        maxLive: 20,
        impacts: 379,
        time: 6,
        spent: 117,
        ailmentTerm: 0,
        fixedKept: 1,
      },
    });
  });

  it('crits on the highest-life enemy alone in highestHp, and shocks it alone, the onion boss among them (E2)', () => {
    const entry = ENTRIES.find((e) => e.name === 'highestHp') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const bosses = new Set<number>();
      const tops = new Set<number>();
      let top = 0;
      let crits = 0;
      let bossCrits = 0;
      let elsewhere = 0;
      let shocks = 0;
      let moves = 0;
      let last = 0;
      watchRun(entry, seed, (now, events, ctx) => {
        // The id this tick's globals step wrote, which every hit of the tick reads.
        const id = ctx.evalInput.highestHpId;
        if (id !== last) moves++;
        last = id;
        if (id !== 0) tops.add(id);
        for (const event of events) {
          if (event.type === 'enemySpawned' && event.enemy === 'onion') bosses.add(event.enemyId);
          else if (event.type === 'hit') {
            if (event.targetId !== id) {
              expect(event.crit, `tick ${now}`).toBe(false);
              elsewhere++;
              continue;
            }
            top++;
            if (event.crit) crits++;
            if (event.crit && bosses.has(id)) bossCrits++;
          } else if (event.type === 'ailmentApplied' && event.ailment === 'shock') {
            expect(event.targetId, `tick ${now}`).toBe(id);
            shocks++;
          }
        }
      });
      bySeed[seed] = { top, crits, bossCrits, elsewhere, shocks, moves, tops: tops.size };
    }
    // No hit off the highest crits or shocks; of those on it, at a crit chance of 25 %, 32 % and
    // 26 % crit, the onion's among them, and the highest moves from enemy to enemy.
    expect(bySeed).toEqual({
      1: { top: 143, crits: 46, bossCrits: 36, elsewhere: 635, shocks: 135, moves: 23, tops: 18 },
      2: { top: 163, crits: 43, bossCrits: 32, elsewhere: 666, shocks: 157, moves: 24, tops: 20 },
    });
  });

  it('slows the poisoned enemies of poisonSlow 2 % for every 5 live stacks, up to 40 % past 100, the onion boss in full, and they walk that much less (E2)', () => {
    const entry = ENTRIES.find((e) => e.name === 'poisonSlow') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const steps = new Set<number>();
      // Each alive enemy's distance and slow at the end of the last tick: the slow the next
      // tick's movement takes, before that tick's hits change its stacks.
      const last = new Map<number, { dist: number; slow: number }>();
      let most = 0;
      let capped = 0;
      let bossCapped = 0;
      let walked = 0;
      watchRun(entry, seed, (now, _events, ctx) => {
        for (const e of ctx.enemies) {
          if (!e.alive) continue;
          // Nothing but movement moves an enemy in this build: a slowed one walked its step
          // less its slow.
          const before = last.get(e.id);
          if (before !== undefined && before.slow > 0 && e.dist > 0) {
            expect(before.dist - e.dist, `enemy ${e.id} at tick ${now}`).toBeCloseTo(
              e.stepDist * (1 - before.slow),
              9,
            );
            walked++;
          }
          const stacks = livePoisonStacks(e, now + 1);
          const slow = enemySlow(ctx, e, now + 1);
          // The build holds no other slow: the term is the whole of it.
          expect(slow, `enemy ${e.id} at tick ${now + 1}`).toBe(
            Math.min(0.4, 0.02 * Math.floor(stacks / 5)),
          );
          most = Math.max(most, stacks);
          if (slow > 0) steps.add(Math.round(slow * 100));
          if (slow === 0.4) capped++;
          if (slow === 0.4 && e.boss) bossCapped++;
          last.set(e.id, { dist: e.dist, slow });
        }
      });
      bySeed[seed] = { most, steps: [...steps].sort((a, b) => a - b), capped, bossCapped, walked };
    }
    // The term from its first step (5 stacks) to its cap, which the onion boss holds past 100
    // stacks, in full; thousands of slowed steps.
    const STEPS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    expect(bySeed).toEqual({
      1: {
        most: 250,
        steps: [...STEPS, 26, 28, 34, 40],
        capped: 149,
        bossCapped: 149,
        walked: 4196,
      },
      2: {
        most: 215,
        steps: [...STEPS, 22, 26, 28, 30, 34, 40],
        capped: 168,
        bossCapped: 168,
        walked: 3375,
      },
    });
  });

  it('links drones, the turret and spirits in fence, hitting, shocking and killing, and holds the drones’ pairs between pairings in droneWeb (C5.8)', () => {
    /**
     * Per seed, from each step's segment state against the rows the tick hook (stage 6) saw
     * given out: the judgements (the segment state's serial) and those of fewer than 2
     * endpoints, the endpoints and links (totals and the most at one judgement), the pairings
     * and the reuses of held pairs, the reused links longer than the range, the links that end
     * on a turret or a spirit, the judgements with a spirit among the endpoints, the hits (the
     * pulses' and the onHit hooks' of the segment's tags, which must agree) and kills, and the
     * rows that left.
     */
    const coverage = (name: string): Record<number, Record<string, number>> => {
      const entry = ENTRIES.find((e) => e.name === name) as GoldenC4Entry;
      const bySeed: Record<number, Record<string, number>> = {};
      for (const seed of GOLDEN_C4_SEEDS) {
        const seen = { ctx: null as RunContext | null, nextId: 0, hooked: 0, kills: 0 };
        const watch: TestModule = (b) => {
          b.hook('tick', (ctx) => {
            seen.ctx = ctx;
            seen.nextId = ctx.sys.drones.nextId;
          });
          b.hook('onHit', (ctx, hit) => {
            const em = ctx.sys.segments.emitters[0] as EmitterRuntime;
            if (hit.origin !== -1 || hit.chainIndex !== 0) return;
            if ((hit.mask & ~TAG.crit) !== em.payload.tags) return;
            seen.hooked++;
            if ((hit.flags & KILLED) !== 0) seen.kills++;
          });
        };
        const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
        const sim = createSimulation(config, entry.data?.() ?? makeTestData(), [
          ...(entry.modules?.() ?? []),
          watch,
        ]);
        const c = {
          judgements: 0,
          below2: 0,
          ends: 0,
          maxEnds: 0,
          links: 0,
          maxLinks: 0,
          pairings: 0,
          reuses: 0,
          stretched: 0,
          turretLinks: 0,
          spiritLinks: 0,
          spiritJudgements: 0,
          hits: 0,
          hooked: 0,
          kills: 0,
          left: 0,
        };
        let serial = 0;
        while (!sim.state.finished) {
          const events = sim.step(NO_INPUT);
          for (const event of events) {
            if (event.type === 'droneExpire') c.left++;
            else if (event.type === 'pulse' && event.kind === 'segment') c.hits += event.hits;
          }
          const ctx = seen.ctx;
          if (ctx === null || ctx.sys.segments.serial === serial) continue;
          serial = ctx.sys.segments.serial;
          const em = ctx.sys.segments.emitters[0] as EmitterRuntime;
          const spec = em.spec as SegmentSpec;
          const ds = ctx.sys.drones;
          const ln = ctx.state.segments.lines[0] as SegmentLinesState;
          const ends: number[] = [];
          for (let s = 0; s < ds.count; s++) {
            if ((ds.id[s] as number) >= seen.nextId) continue;
            if (spec.endpoints === 'summons' || ds.kind[s] === DRONE_KIND_DRONE) ends.push(s);
          }
          const rowAt = (x: number, y: number): number =>
            ends.find((s) => ds.x[s] === x && ds.y[s] === y) ?? -1;
          c.judgements++;
          if (ends.length < 2) c.below2++;
          c.ends += ends.length;
          c.maxEnds = Math.max(c.maxEnds, ends.length);
          c.links += ln.count;
          c.maxLinks = Math.max(c.maxLinks, ln.count);
          if (ends.some((s) => ds.kind[s] === DRONE_KIND_SPIRIT)) c.spiritJudgements++;
          const reuse = spec.pairTicks > 0 && em.pairTimer !== 0;
          if (reuse) c.reuses++;
          else c.pairings++;
          for (let l = 0; l < ln.count; l++) {
            const [x1, y1, x2, y2] = [ln.x1[l], ln.y1[l], ln.x2[l], ln.y2[l]] as number[];
            const kinds = [
              ds.kind[rowAt(x1 as number, y1 as number)],
              ds.kind[rowAt(x2 as number, y2 as number)],
            ];
            if (kinds.includes(DRONE_KIND_TURRET)) c.turretLinks++;
            if (kinds.includes(DRONE_KIND_SPIRIT)) c.spiritLinks++;
            const d2 =
              ((x2 as number) - (x1 as number)) ** 2 + ((y2 as number) - (y1 as number)) ** 2;
            if (reuse && d2 > spec.range * spec.range) c.stretched++;
          }
        }
        c.hooked = seen.hooked;
        c.kills = seen.kills;
        bySeed[seed] = c;
      }
      return bySeed;
    };
    // fence: 2 to 5 rows every judgement, each its one link, many ending on the turret or a
    // spirit; a few enemies on the links, one of them killed by its hit; rows leave between.
    expect(coverage('fence')).toEqual({
      1: {
        judgements: 79,
        below2: 0,
        ends: 305,
        maxEnds: 5,
        links: 94,
        maxLinks: 3,
        pairings: 79,
        reuses: 0,
        stretched: 0,
        turretLinks: 60,
        spiritLinks: 45,
        spiritJudgements: 54,
        hits: 4,
        hooked: 4,
        kills: 1,
        left: 10,
      },
      2: {
        judgements: 79,
        below2: 0,
        ends: 307,
        maxEnds: 5,
        links: 99,
        maxLinks: 3,
        pairings: 79,
        reuses: 0,
        stretched: 0,
        turretLinks: 72,
        spiritLinks: 58,
        spiritJudgements: 63,
        hits: 3,
        hooked: 3,
        kills: 1,
        left: 10,
      },
    });
    // droneWeb: the 3 drones every judgement, never the turret; a pairing at the first
    // judgement and every second one, the reuses between keeping links the drones have flown
    // past the range.
    expect(coverage('droneWeb')).toEqual({
      1: {
        judgements: 79,
        below2: 0,
        ends: 237,
        maxEnds: 3,
        links: 67,
        maxLinks: 2,
        pairings: 40,
        reuses: 39,
        stretched: 7,
        turretLinks: 0,
        spiritLinks: 0,
        spiritJudgements: 0,
        hits: 19,
        hooked: 19,
        kills: 0,
        left: 0,
      },
      2: {
        judgements: 79,
        below2: 0,
        ends: 237,
        maxEnds: 3,
        links: 45,
        maxLinks: 2,
        pairings: 40,
        reuses: 39,
        stretched: 6,
        turretLinks: 0,
        spiritLinks: 0,
        spiritJudgements: 0,
        hits: 18,
        hooked: 18,
        kills: 0,
        left: 0,
      },
    });
  });

  it('spreads 瘟疫 to 450, ignites 火星’s 2 nearest within 162, shocks the farthest within 180 and passes 燎原’s burn within 90 in spread (E3)', () => {
    const entry = ENTRIES.find((e) => e.name === 'spread') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    // 250, 90 and 120 by the area alone (× 1.2) or the spread alone (× 1.5), and as the rulings
    // size them: the spreads × both, the selector × 1.5 and 燎原 × 1.5.
    const R = { plague: 250 * (1.2 * 1.5), spark: 90 * (1.2 * 1.5), pick: 120 * 1.5 };
    const AREA = { plague: 250 * 1.2, spark: 90 * 1.2, pick: 120, wildfire: 60 };
    for (const seed of GOLDEN_C4_SEEDS) {
      // Each kill, seen by an onKill hook after its transfers: where, whether it burnt, and
      // whether its depth leaves its queued triggers (火星's, the selector's) room to fire.
      let kills: { x: number; y: number; burning: boolean; fires: boolean }[] = [];
      const plague = { spreads: 0, targets: 0, atEdge: 0, reachedAtEdge: 0 };
      const radii = new Set<number>();
      const observer: TestModule = (b) =>
        void b.hook('onKill', (ctx, victim, kill) => {
          const burning = holdsBurn(victim, ctx.now);
          kills.push({ x: victim.x, y: victim.y, burning, fires: kill.depth < MAX_DEPTH });
          if (!burning) return;
          // 瘟疫 has just spread: every other alive enemy within 450, past 300 at times.
          const spread = ctx.events.at(-1);
          expect(spread?.type).toBe('burnSpread');
          if (spread?.type !== 'burnSpread') return;
          const within = (r: number): number =>
            ctx.enemies.filter((e) => e.alive && e !== victim && dist2(e, victim) <= r * r).length;
          expect(spread.targets).toBe(within(R.plague));
          radii.add(spread.radius);
          plague.spreads++;
          plague.targets += spread.targets;
          const past = spread.targets - within(AREA.plague);
          if (past > 0) plague.atEdge++;
          plague.reachedAtEdge += past;
        });
      const wildfire = { passes: 0, atEdge: 0, farthest: 0 };
      const passed = (d: number): void => {
        wildfire.passes++;
        if (d > AREA.wildfire) wildfire.atEdge++;
        wildfire.farthest = Math.max(wildfire.farthest, d);
      };
      const spark = { firings: 0, picks: 0, atEdge: 0 };
      const pick = { picks: 0, atEdge: 0 };
      let capped = 0;
      // Last tick's kills, whose 火星 effects run this tick where the enemies stand now, and the
      // selector's picks, made at last tick's end, whose shocks land this tick.
      let lastKills: typeof kills = [];
      let picks: Enemy[] = [];
      const watched = { ...entry, modules: () => [wildfireModule(passed), observer] };
      watchRun(watched, seed, (_now, events, ctx) => {
        const ignited = new Set(events.flatMap((e) => (e.type === 'ignite' ? [e.targetId] : [])));
        const shocked = events.flatMap((e) =>
          e.type === 'ailmentApplied' && e.ailment === 'shock' ? [e.targetId] : [],
        );
        const others = ctx.enemies.filter((e) => e.alive);
        // 火星: the 2 nearest alive within 162 of each of last tick's burning deaths, burnt.
        for (const kill of lastKills) {
          if (!kill.fires || !kill.burning) continue;
          const near = others
            .filter((e) => dist2(e, kill) <= R.spark ** 2)
            .sort((a, b) => dist2(a, kill) - dist2(b, kill) || a.id - b.id)
            .slice(0, 2);
          for (const e of near) expect(ignited.has(e.id), `${e.id}`).toBe(true);
          spark.firings++;
          spark.picks += near.length;
          spark.atEdge += near.filter((e) => dist2(e, kill) > AREA.spark ** 2).length;
        }
        // The selector: its picks, alive still, shocked this tick, and nothing else shocked.
        const alive = picks.filter((e) => e.alive).map((e) => e.id);
        expect(shocked.sort((a, b) => a - b)).toEqual(alive.sort((a, b) => a - b));
        // This tick's kills: the selector picks the farthest alive within 180 at the tick's end.
        picks = [];
        for (const kill of kills) {
          if (!kill.fires) {
            capped++;
            continue;
          }
          let best: Enemy | null = null;
          for (const e of others) {
            if (
              dist2(e, kill) <= R.pick ** 2 &&
              (best === null || dist2(e, kill) > dist2(best, kill))
            )
              best = e;
          }
          if (best === null) continue;
          pick.picks++;
          if (dist2(best, kill) > AREA.pick ** 2) pick.atEdge++;
          picks.push(best);
        }
        lastKills = kills;
        kills = [];
      });
      bySeed[seed] = { plague, radii: [...radii], spark, pick, wildfire, capped };
    }
    // Every 瘟疫 at 450 (250 × 1.8, one product); each count past 300, 108, 120 or 60 is reached
    // only by the spread factor. No kill met the depth cap.
    const plagueRadii = [R.plague];
    expect(bySeed).toEqual({
      1: {
        plague: { spreads: 69, targets: 257, atEdge: 49, reachedAtEdge: 113 },
        radii: plagueRadii,
        spark: { firings: 69, picks: 55, atEdge: 23 },
        pick: { picks: 45, atEdge: 20 },
        wildfire: { passes: 26, atEdge: 9, farthest: 86.59783423281007 },
        capped: 0,
      },
      2: {
        plague: { spreads: 47, targets: 169, atEdge: 29, reachedAtEdge: 70 },
        radii: plagueRadii,
        spark: { firings: 47, picks: 33, atEdge: 15 },
        pick: { picks: 40, atEdge: 28 },
        wildfire: { passes: 27, atEdge: 4, farthest: 84.33918221116593 },
        capped: 0,
      },
    });
  });

  it('picks the tough enemies first in summonPolicies, its drones staying out and its turrets splashing and chaining (C5.9)', () => {
    const entry = ENTRIES.find((e) => e.name === 'summonPolicies') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      // Each drone's and spirit's target, impacts left and mode at the last tick's end, by id.
      const prev = new Map<number, { target: number; left: number; mode: number }>();
      const c = {
        tough: 0,
        other: 0,
        toughOverFarther: 0,
        stays: 0,
        keptStays: 0,
        returns: 0,
        fires: 0,
        splashes: 0,
        listed: 0,
        mostListed: 0,
        jumps: 0,
        refused: 0,
      };
      watchRun(entry, seed, (_now, events, ctx) => {
        const ds = ctx.sys.drones;
        for (let s = 0; s < ds.count; s++) {
          const id = ds.id[s] as number;
          const kind = ds.kind[s];
          if (kind !== DRONE_KIND_DRONE && kind !== DRONE_KIND_SPIRIT) continue;
          const target = ds.targetId[s] as number;
          const left = ds.impactsLeft[s] as number;
          const mode = ds.mode[s] as number;
          const was = prev.get(id) ?? { target: -1, left, mode };
          if (target !== -1 && target !== was.target) {
            const e = ds.target[s] as NonNullable<(typeof ds.target)[number]>;
            if (e.tough) {
              c.tough++;
              const fartherPlain = ctx.enemies.some(
                (o) =>
                  o.alive &&
                  !o.tough &&
                  o.dist > e.dist &&
                  o.x >= 0 &&
                  o.x <= ARENA_WIDTH &&
                  o.y >= 0 &&
                  o.y <= ARENA_HEIGHT,
              );
              if (fartherPlain) c.toughOverFarther++;
            } else c.other++;
          }
          if (kind === DRONE_KIND_DRONE) {
            // A full sortie again away from the dock: a stay (蟲海), kept when it dashes on at the
            // target its sortie ended on (the pick found nothing else); a flight home: a return.
            if (left > was.left && mode !== DRONE_DOCKED) c.stays++;
            if (left > was.left && mode === DRONE_DASH && target === was.target) c.keptStays++;
            if (mode === DRONE_RETURN && was.mode !== DRONE_RETURN) c.returns++;
          }
          prev.set(id, { target, left, mode });
        }
        for (const event of events) {
          if (event.type === 'turretFire') c.fires++;
          else if (event.type === 'impact' && event.droneId === -1) {
            c.splashes++;
            c.listed += event.count;
            c.mostListed = Math.max(c.mostListed, event.count);
          } else if (
            event.type === 'hit' &&
            event.chainIndex > 0 &&
            (event.tags & TAG.minion) !== 0
          ) {
            c.jumps++;
          }
        }
        c.refused = ctx.counters.summonCapped;
      });
      bySeed[seed] = c;
    }
    // Tough picks, some over a farther ordinary enemy; the spirits past the cap refused; stays,
    // some on the target a sortie ended on, and returns home both; every turret arrival but
    // those still in flight at the end splashes, up to 6 listed; the turrets' jumps.
    expect(bySeed).toEqual({
      1: {
        tough: 72,
        other: 513,
        toughOverFarther: 50,
        stays: 102,
        keptStays: 16,
        returns: 24,
        fires: 40,
        splashes: 76,
        listed: 99,
        mostListed: 6,
        jumps: 58,
        refused: 111,
      },
      2: {
        tough: 70,
        other: 476,
        toughOverFarther: 7,
        stays: 107,
        keptStays: 33,
        returns: 21,
        fires: 40,
        splashes: 68,
        listed: 94,
        mostListed: 6,
        jumps: 54,
        refused: 107,
      },
    });
  });

  it('scales the center damage of minionScaling 4 % per live temporary summon up to 20 %, the count past the cap and back (C5.9)', () => {
    const entry = ENTRIES.find((e) => e.name === 'minionScaling') as GoldenC4Entry;
    // The modifier's factor as the run's evaluation reads it, off the run's EvalInput.
    const scaling = compileScaling({ per: 'minionCount', cap: 0.2 });
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const ticksAt: Record<number, number> = {};
      const centerHits: Record<number, number> = {};
      const factors: Record<number, number> = {};
      let live = 0;
      watchRun(entry, seed, (now, events, ctx) => {
        const n = ctx.evalInput.minionCount;
        // The live spirits the tick's globals step found: those of the last tick's end whose time
        // is not up.
        expect(n, `tick ${now}`).toBe(live);
        ticksAt[n] = (ticksAt[n] ?? 0) + 1;
        factors[n] =
          Math.round((1 + scaledValue(0.04, scaling, scaling.read(ctx.evalInput))) * 1e9) / 1e9;
        for (const event of events) {
          if (event.type === 'hit' && event.source === 0) centerHits[n] = (centerHits[n] ?? 0) + 1;
        }
        const ds = ctx.sys.drones;
        live = 0;
        for (let s = 0; s < ds.count; s++) {
          if (ds.kind[s] === DRONE_KIND_SPIRIT && (ds.until[s] as number) > now + 1) live++;
        }
      });
      bySeed[seed] = { ticksAt, centerHits, factors };
    }
    // Every count from 0 to 8 (seed 1) or 7 (seed 2), the factor 1.04 a spirit up to its cap of
    // 1.2 at 5 and held past it; center hits at every count from 1.
    const FACTORS = { 0: 1, 1: 1.04, 2: 1.08, 3: 1.12, 4: 1.16, 5: 1.2, 6: 1.2, 7: 1.2 };
    expect(bySeed).toEqual({
      1: {
        ticksAt: { 0: 20, 1: 25, 2: 220, 3: 516, 4: 193, 5: 90, 6: 89, 7: 46, 8: 1 },
        centerHits: { 1: 4, 2: 42, 3: 109, 4: 28, 5: 20, 6: 12, 7: 11, 8: 1 },
        factors: { ...FACTORS, 8: 1.2 },
      },
      2: {
        ticksAt: { 0: 20, 1: 26, 2: 130, 3: 549, 4: 320, 5: 108, 6: 41, 7: 6 },
        centerHits: { 1: 6, 2: 24, 3: 106, 4: 63, 5: 22, 6: 7, 7: 2 },
        factors: FACTORS,
      },
    });
  });

  it('cuts each drone impact’s slash in flightSlash from the impact’s point along the drone’s flight, a killing impact’s too, from every side and mostly off the outward line, every hit a crit (FL, FL-R1)', () => {
    const entry = ENTRIES.find((e) => e.name === 'flightSlash') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const c = {
        impacts: 0,
        // The impacts that killed their target, and the slashes cut from such an impact's point.
        killing: 0,
        slashes: 0,
        onKills: 0,
        hits: 0,
        crits: 0,
        offOutward: 0,
        atOutward: 0,
        // The slashes by the quarter their angle falls in, from −π.
        quarters: [0, 0, 0, 0],
        first: [] as number[],
      };
      watchRun(entry, seed, (_now, events, ctx) => {
        const source = ctx.state.sources.indexOf('fusion.summon.crit');
        // Kills resolve at the hit, so a target the impact killed has its kill event before it.
        const killed = new Set<number>();
        const killPoints = new Set<string>();
        for (const event of events) {
          if (event.type === 'enemyKilled') killed.add(event.enemyId);
          else if (event.type === 'impact' && event.droneId > 0) {
            c.impacts++;
            if (killed.has(event.targetId)) {
              c.killing++;
              killPoints.add(`${event.x},${event.y}`);
            }
          } else if (event.type === 'slash') {
            c.slashes++;
            if (killPoints.has(`${event.x1},${event.y1}`)) c.onKills++;
            const angle = Math.atan2(event.y2 - event.y1, event.x2 - event.x1);
            const outward = Math.atan2(event.y1 - ctx.player.y, event.x1 - ctx.player.x);
            const off = Math.abs(Math.atan2(Math.sin(angle - outward), Math.cos(angle - outward)));
            if (off > 0.05) c.offOutward++;
            else if (off < 1e-9) c.atOutward++;
            const q = Math.min(3, Math.floor((angle + Math.PI) / (Math.PI / 2)));
            c.quarters[q] = (c.quarters[q] as number) + 1;
            if (c.first.length < 3) c.first.push(Math.round(angle * 1e9) / 1e9);
          } else if (event.type === 'hit' && event.source === source) {
            c.hits++;
            if (event.crit) c.crits++;
          }
        }
      });
      bySeed[seed] = c;
    }
    // A slash for every impact, the killing impacts' cut from their point too (FL-R1), every
    // slash hit a crit; slashes in every quarter, none on the outward line exactly (no drone met
    // its target within its body) and most off it by more than 0.05; the first three's angles.
    expect(bySeed).toEqual({
      1: {
        impacts: 81,
        killing: 9,
        slashes: 81,
        onKills: 9,
        hits: 85,
        crits: 85,
        offOutward: 71,
        atOutward: 0,
        quarters: [26, 17, 18, 20],
        first: [-1.338164943, -1.42159069, -1.830768879],
      },
      2: {
        impacts: 83,
        killing: 8,
        slashes: 83,
        onKills: 8,
        hits: 90,
        crits: 90,
        offOutward: 71,
        atOutward: 0,
        quarters: [12, 11, 36, 24],
        first: [-1.422365095, -1.492312199, 0.107866274],
      },
    });
  });

  it('gives the queen and the hammer their factors and steps, the followers their bonus on the queen’s target, the turret its seat at 220 and the drones their sizes in hiveRoles (E4)', () => {
    const entry = ENTRIES.find((e) => e.name === 'hiveRoles') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const impacts: Record<number, number> = {};
      const follows: Record<number, number> = {};
      const steps: Record<number, Record<string, number>> = {};
      const was = new Map<number, readonly [number, number]>();
      const seats = new Set<number>();
      const sizes = new Set<string>();
      let fires = 0;
      watchRun(entry, seed, (_now, events, ctx) => {
        const ds = ctx.sys.drones;
        const leader = ds.leader;
        for (const event of events) {
          if (event.type === 'impact' && event.droneId > 0) {
            const id = event.droneId;
            impacts[id] = (impacts[id] ?? 0) + 1;
            // The leader steps first in the stage: its mode and target at the stage's end are
            // those at a later drone's impact.
            const led =
              id !== (ds.id[leader] as number) &&
              ds.mode[leader] === DRONE_DASH &&
              ds.targetId[leader] === event.targetId;
            if (led) follows[id] = (follows[id] ?? 0) + 1;
          } else if (event.type === 'turretFire') {
            fires++;
            seats.add(
              Math.round(Math.hypot(event.x - ARENA_WIDTH / 2, event.y - ARENA_HEIGHT / 2)),
            );
          }
        }
        for (let s = 0; s < ds.count; s++) {
          if (ds.kind[s] !== DRONE_KIND_DRONE) continue;
          const id = ds.id[s] as number;
          const mode = ds.mode[s] as number;
          const targetId = ds.targetId[s] as number;
          const [lastMode, lastTarget] = was.get(id) ?? [-1, -1];
          was.set(id, [mode, targetId]);
          // A whole step: a dash on at the same target short of its center, or a flight home on
          // short of the dock.
          const t = ds.target[s] ?? null;
          const x = ds.x[s] as number;
          const y = ds.y[s] as number;
          const dashOn = mode === DRONE_DASH && t !== null && (x !== t.x || y !== t.y);
          if (mode !== lastMode || targetId !== lastTarget || !(dashOn || mode === DRONE_RETURN)) {
            continue;
          }
          const step = Math.hypot(x - (ds.prevX[s] as number), y - (ds.prevY[s] as number));
          const key = `${mode === DRONE_DASH ? 'dash' : 'home'} ${Math.round(step * 1e9) / 1e9}`;
          const of = (steps[id] ??= {});
          of[key] = (of[key] ?? 0) + 1;
        }
        sizes.add(JSON.stringify(Array.from(ds.size.subarray(0, ds.count))));
      });
      bySeed[seed] = { impacts, follows, steps, seats: [...seats], sizes: [...sizes], fires };
    }
    // Every drone impacts, the hammer (2) the least, and the hammer's and the third's on the
    // queen's (1) live target among them; the hammer's whole steps, dashing and flying home,
    // are 0.4 of the others' 10; the turret fires from 220; the sizes hold, 1 on the turret.
    const SIZES = [JSON.stringify([1.2 * 1.5, 1.2, 1.2, 1])];
    expect(bySeed).toEqual({
      1: {
        impacts: { 1: 16, 2: 8, 3: 18 },
        follows: { 2: 2, 3: 4 },
        steps: {
          1: { 'dash 10': 546, 'home 10': 177 },
          2: { 'dash 4': 839, 'home 4': 130 },
          3: { 'dash 10': 422, 'home 10': 217 },
        },
        seats: [220],
        sizes: SIZES,
        fires: 40,
      },
      2: {
        impacts: { 1: 17, 2: 5, 3: 17 },
        follows: { 2: 2, 3: 2 },
        steps: {
          1: { 'dash 10': 455, 'home 10': 230 },
          2: { 'dash 4': 770, 'home 4': 233 },
          3: { 'dash 10': 419, 'home 10': 263 },
        },
        seats: [220],
        sizes: SIZES,
        fires: 40,
      },
    });
  });

  it('picks the enemy of the most hp for every summon in focusFire, its turrets’ shots all at it, its spirits living 180 ticks at summonDuration 1.5 (E4)', () => {
    const entry = ENTRIES.find((e) => e.name === 'focusFire') as GoldenC4Entry;
    const inArena = (e: Enemy): boolean =>
      e.x >= 0 && e.x <= ARENA_WIDTH && e.y >= 0 && e.y <= ARENA_HEIGHT;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const prev = new Map<number, number>();
      const seen = new Set<number>();
      const c = {
        picks: 0,
        topAtEnd: 0,
        notFarthest: 0,
        tough: 0,
        shared: 0,
        fires: 0,
        firesAtTop: 0,
        shotCounts: {} as Record<number, number>,
        lives: {} as Record<number, number>,
        expired: {} as Record<string, number>,
      };
      watchRun(entry, seed, (now, events, ctx) => {
        const alive = ctx.enemies.filter((e) => e.alive && inArena(e));
        const top = alive.reduce<Enemy | null>(
          (b, e) => (b === null || toNumber(e.hp) > toNumber(b.hp) ? e : b),
          null,
        );
        const farthest = alive.reduce<Enemy | null>(
          (b, e) => (b === null || e.dist > b.dist ? e : b),
          null,
        );
        const ds = ctx.sys.drones;
        const dashedAt = new Map<number, number>();
        for (let s = 0; s < ds.count; s++) {
          const kind = ds.kind[s];
          if (kind !== DRONE_KIND_DRONE && kind !== DRONE_KIND_SPIRIT) continue;
          const id = ds.id[s] as number;
          const target = ds.targetId[s] as number;
          if (kind === DRONE_KIND_SPIRIT && !seen.has(id)) {
            seen.add(id);
            const life = (ds.until[s] as number) - now;
            c.lives[life] = (c.lives[life] ?? 0) + 1;
          }
          if (target !== -1 && target !== (prev.get(id) ?? -1)) {
            c.picks++;
            if (target === top?.id) c.topAtEnd++;
            if (target !== farthest?.id) c.notFarthest++;
            if ((ds.target[s] as Enemy).tough) c.tough++;
          }
          if (ds.mode[s] === DRONE_DASH && target !== -1) {
            dashedAt.set(target, (dashedAt.get(target) ?? 0) + 1);
          }
          prev.set(id, target);
        }
        for (const n of dashedAt.values()) if (n > 1) c.shared++;
        for (const event of events) {
          if (event.type === 'turretFire') {
            c.fires++;
            if (event.targetId === top?.id) c.firesAtTop++;
            c.shotCounts[event.count] = (c.shotCounts[event.count] ?? 0) + 1;
          } else if (event.type === 'droneExpire') {
            c.expired[event.cause] = (c.expired[event.cause] ?? 0) + 1;
          }
        }
      });
      bySeed[seed] = c;
    }
    // Most picks are the enemy of the most hp as the tick ends (the rest of the tick's hits move
    // it), more than half not the farthest enemy, tough ones among them; rows share their
    // target; every firing is its two shots, most at the enemy of the most hp as the tick ends;
    // every spirit's life is 180 ticks, and some are spent before.
    expect(bySeed).toEqual({
      1: {
        picks: 401,
        topAtEnd: 378,
        notFarthest: 238,
        tough: 47,
        shared: 1868,
        fires: 118,
        firesAtTop: 110,
        shotCounts: { 2: 118 },
        lives: { 180: 120 },
        expired: { spent: 67, time: 45 },
      },
      2: {
        picks: 423,
        topAtEnd: 408,
        notFarthest: 231,
        tough: 65,
        shared: 1626,
        fires: 120,
        firesAtTop: 114,
        shotCounts: { 2: 120 },
        lives: { 180: 120 },
        expired: { spent: 59, time: 47 },
      },
    });
  });

  it('explodes every sortie’s third impact of selfDestruct’s swarm at 80, and never a granted drone’s (E5)', () => {
    const entry = ENTRIES.find((e) => e.name === 'selfDestruct') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      // Each drone's impacts left at the last tick's end, by id.
      const left = new Map<number, number>();
      const c = {
        impacts: 0,
        explosions: 0,
        listed: 0,
        mostListed: 0,
        notLast: 0,
        lastPlain: 0,
        grant: 0,
        radii: [] as number[],
      };
      const radii = new Set<number>();
      watchRun(entry, seed, (_now, events, ctx) => {
        const ds = ctx.sys.drones;
        const owner = new Map<number, number>();
        for (let s = 0; s < ds.count; s++) owner.set(ds.id[s] as number, ds.owner[s] as number);
        for (const event of events) {
          if (event.type !== 'impact' || event.droneId < 0) continue;
          radii.add(event.radius);
          if (owner.get(event.droneId) !== 0) {
            c.grant++;
            if (event.radius !== 40) c.notLast++;
            continue;
          }
          c.impacts++;
          const was = left.get(event.droneId) ?? 3;
          if (event.radius === 80) {
            c.explosions++;
            c.listed += event.count;
            c.mostListed = Math.max(c.mostListed, event.count);
            if (was !== 1) c.notLast++;
          } else if (was === 1) c.lastPlain++;
        }
        for (let s = 0; s < ds.count; s++) {
          left.set(ds.id[s] as number, ds.impactsLeft[s] as number);
        }
      });
      c.radii = [...radii].sort((a, b) => a - b);
      bySeed[seed] = c;
    }
    // Every explosion a sortie's last impact and every last impact an explosion; the granted
    // drones' impacts at their splash of 40.
    expect(bySeed).toEqual({
      1: {
        impacts: 54,
        explosions: 17,
        listed: 20,
        mostListed: 3,
        notLast: 0,
        lastPlain: 0,
        grant: 35,
        radii: [40, 80],
      },
      2: {
        impacts: 50,
        explosions: 15,
        listed: 15,
        mostListed: 1,
        notLast: 0,
        lastPlain: 0,
        grant: 35,
        radii: [40, 80],
      },
    });
  });

  it('sends guards’ guards at the charging dashers on each charge start and impacts them, picking in the ring otherwise; the other drones past it (E5)', () => {
    const entry = ENTRIES.find((e) => e.name === 'guards') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      // Each drone's target while it dashes at the last tick's end (−1 otherwise), and its mode
      // then, by id; every enemy seen, by id.
      const prev = new Map<number, number>();
      const prevMode = new Map<number, number>();
      const byId = new Map<number, Enemy>();
      const c = {
        chargeStarts: 0,
        forced: 0,
        chargingPicks: 0,
        ringPicks: 0,
        pastRing: 0,
        guardImpacts: 0,
        onCharging: 0,
        otherPicks: 0,
        otherPastRing: 0,
        orbitTicks: 0,
        docks: 0,
      };
      const charging = (e: Enemy | undefined): boolean =>
        e !== undefined && e.v3 !== null && (e.v3.state & CHARGING) !== 0;
      watchRun(entry, seed, (_now, events, ctx) => {
        for (const e of ctx.enemies) byId.set(e.id, e);
        const ds = ctx.sys.drones;
        const starts = events.filter((e) => e.type === 'dasherCharge').length;
        c.chargeStarts += starts;
        const guards = new Set<number>();
        for (let s = 0; s < ds.count; s++) {
          if (ds.kind[s] !== DRONE_KIND_DRONE) continue;
          const id = ds.id[s] as number;
          const guard = s >= ds.guardFirst && s < ds.guardEnd;
          if (guard) guards.add(id);
          const mode = ds.mode[s] as number;
          const t = mode === DRONE_DASH ? (ds.targetId[s] as number) : -1;
          if (t !== -1 && t !== (prev.get(id) ?? -1)) {
            const e = ds.target[s] as Enemy;
            if (!guard) {
              c.otherPicks++;
              if (e.dist > 120) c.otherPastRing++;
            } else if (charging(e)) {
              c.chargingPicks++;
              if (starts > 0) c.forced++;
            } else if (e.dist <= 120) c.ringPicks++;
            else c.pastRing++;
          }
          if (mode === DRONE_GUARD) c.orbitTicks++;
          // A guard back on its orbit from its flight home (lead ruling K2-R1).
          if (guard && mode === DRONE_GUARD && prevMode.get(id) === DRONE_RETURN) c.docks++;
          prev.set(id, t);
          prevMode.set(id, mode);
        }
        for (const event of events) {
          if (event.type !== 'impact' || !guards.has(event.droneId)) continue;
          c.guardImpacts++;
          if (charging(byId.get(event.targetId))) c.onCharging++;
        }
      });
      bySeed[seed] = c;
    }
    // Charge starts and the guards' picks of charging dashers on them; their impacts on charging
    // dashers; every other guard pick in the ring, and none past it; the other drones' picks,
    // many past the ring; the guards' dockings back on their orbits (K2-R1).
    expect(bySeed).toEqual({
      1: {
        chargeStarts: 13,
        forced: 17,
        chargingPicks: 17,
        ringPicks: 19,
        pastRing: 0,
        guardImpacts: 32,
        onCharging: 6,
        otherPicks: 15,
        otherPastRing: 15,
        orbitTicks: 773,
        docks: 9,
      },
      2: {
        chargeStarts: 12,
        forced: 12,
        chargingPicks: 12,
        ringPicks: 24,
        pastRing: 0,
        guardImpacts: 43,
        onCharging: 6,
        otherPicks: 16,
        otherPastRing: 14,
        orbitTicks: 803,
        docks: 14,
      },
    });
  });

  it('surges surge’s swarm at the densest enemy at 480 and 960 with its 6 drones, each one’s next impact on it spending its mark (E5)', () => {
    const entry = ENTRIES.find((e) => e.name === 'surge') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      // Each drone's mark at the last tick's end, by id.
      const marked = new Map<number, number>();
      const c = { surges: [] as number[][], surged: 0, onTarget: 0, cleared: 0 };
      watchRun(entry, seed, (now, events, ctx) => {
        const ds = ctx.sys.drones;
        const fired = events.some((e) => e.type === 'droneSurge');
        for (const event of events) {
          if (event.type === 'droneSurge') c.surges.push([now, event.targetId, event.count]);
        }
        const impacted = new Map<number, number>();
        for (const event of events) {
          if (event.type === 'impact' && event.droneId >= 0) {
            impacted.set(event.droneId, event.targetId);
          }
        }
        const target = ds.surge?.target?.id ?? -1;
        for (let s = 0; s < ds.count; s++) {
          if (ds.kind[s] !== DRONE_KIND_DRONE || ds.owner[s] !== 0) continue;
          const id = ds.id[s] as number;
          const was = fired ? 1 : (marked.get(id) ?? 0);
          const is = ds.surging[s] as number;
          if (was === 1 && is === 0) {
            const hit = impacted.get(id);
            if (hit === undefined) c.cleared++;
            else {
              c.surged++;
              if (hit === target) c.onTarget++;
            }
          }
          marked.set(id, is);
        }
      });
      bySeed[seed] = c;
    }
    // Two surges of 6 rows; each row's mark spent on its next impact, on the target.
    expect(bySeed).toEqual({
      1: {
        surges: [
          [480, 8, 6],
          [960, 57, 6],
        ],
        surged: 12,
        onTarget: 12,
        cleared: 0,
      },
      2: {
        surges: [
          [480, 10, 6],
          [960, 43, 6],
        ],
        surged: 12,
        onTarget: 12,
        cleared: 0,
      },
    });
  });

  it('sends chainBolts’ freeze bolts to the 3 nearest others and its kill bolts to the nearest, each from its event’s point, every hit a shock (E7)', () => {
    const entry = ENTRIES.find((e) => e.name === 'chainBolts') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const c = {
        freezes: 0,
        firings: 0,
        sizes: [0, 0, 0],
        killFirings: 0,
        jumps: 0,
        hits: 0,
        kills: 0,
        shocked: 0,
        limited: 0,
        lonely: 0,
        crowded: 0,
        ownBolt: 0,
        unmatched: 0,
        frozenPicked: 0,
        repeated: 0,
        unordered: 0,
        outOfRange: 0,
        badJump: 0,
        unshocked: 0,
      };
      // Each enemy's position at its last hit, the points of the freezes and kills not yet
      // answered, and the last bolt hit, which a jump comes from.
      const at = new Map<number, [number, number]>();
      const frozen = new Map<string, number>();
      const kills = new Set<string>();
      // The enemies whose last hit was a freeze bolt's, which raises no freeze bolt (rule 3).
      const boltHit = new Set<number>();
      const own = new Set<string>();
      watchRun(entry, seed, (_now, events, ctx) => {
        const ice = ctx.sources.index('fusion.ice.lightning');
        const lightning = ctx.sources.index('outer.lightning');
        const rangeSq = ctx.chainRangeSq;
        const struck = new Set<number>();
        let group: { key: string; frozen: number; ids: number[]; distSq: number } | null = null;
        let last: [number, number] | null = null;
        for (const event of events) {
          if (event.type === 'freeze') {
            c.freezes++;
            const point = at.get(event.targetId) as [number, number];
            frozen.set(point.join(), event.targetId);
            if (boltHit.has(event.targetId)) own.add(point.join());
          } else if (event.type === 'enemyKilled') {
            kills.add([event.x, event.y].join());
          }
          if (event.type !== 'hit') continue;
          at.set(event.targetId, [event.x, event.y]);
          if (event.source === ice && (event.tags & TAG.trigger) !== 0) boltHit.add(event.targetId);
          else boltHit.delete(event.targetId);
          // A shatter of an enemy a bolt killed is credited to the bolt's source too.
          if (event.source !== ice && event.source !== lightning) continue;
          if ((event.tags & TAG.trigger) === 0) continue;
          c.hits++;
          struck.add(event.targetId);
          if (event.chainIndex > 0) {
            c.jumps++;
            if (last === null || event.fromX !== last[0] || event.fromY !== last[1]) c.badJump++;
            last = [event.x, event.y];
            continue;
          }
          last = [event.x, event.y];
          if (event.fromX === null || event.fromY === null) {
            c.unmatched++;
            continue;
          }
          const key = [event.fromX, event.fromY].join();
          const dx = event.x - event.fromX;
          const dy = event.y - event.fromY;
          const distSq = dx * dx + dy * dy;
          if (distSq > rangeSq) c.outOfRange++;
          if (event.source === lightning) {
            c.killFirings++;
            if (!kills.delete(key)) c.unmatched++;
            continue;
          }
          if (group === null || group.key !== key) {
            const id = frozen.get(key);
            if (id === undefined) c.unmatched++;
            frozen.delete(key);
            c.firings++;
            group = { key, frozen: id ?? -1, ids: [], distSq: -1 };
          }
          if (group.frozen === event.targetId) c.frozenPicked++;
          if (group.ids.includes(event.targetId)) c.repeated++;
          if (distSq < group.distSq) c.unordered++;
          group.ids.push(event.targetId);
          group.distSq = distSq;
          // The group's size so far: one more of it, one fewer of the size before.
          const n = group.ids.length;
          c.sizes[n - 1] = (c.sizes[n - 1] as number) + 1;
          if (n > 1) c.sizes[n - 2] = (c.sizes[n - 2] as number) - 1;
        }
        for (const event of events) {
          if (event.type === 'enemyKilled' && struck.has(event.enemyId)) c.kills++;
        }
        // Every enemy a bolt hit and left alive is shocked as the tick ends.
        for (const enemy of ctx.enemies) {
          if (!enemy.alive || !struck.has(enemy.id)) continue;
          if (enemy.shockStacks > 0 && enemy.shockUntil > ctx.now) c.shocked++;
          else c.unshocked++;
        }
        // A freeze no bolt answered: no other enemy in range of its point, a freeze bolt's own
        // freeze, or else rate-limited.
        for (const [key, id] of frozen) {
          const [x, y] = key.split(',').map(Number) as [number, number];
          const near = ctx.enemies.some(
            (e) => e.alive && e.id !== id && dist2(e, { x, y }) <= rangeSq,
          );
          if (!near) c.lonely++;
          else if (own.has(key)) c.ownBolt++;
          else c.crowded++;
        }
        frozen.clear();
        own.clear();
        c.limited = ctx.counters.freezePayloadsLimited;
      });
      bySeed[seed] = c;
    }
    // Every freeze is answered by one firing or is lonely, its own bolt's or limited (crowded at
    // most limited); 8 + 10 · 2 + 21 · 3 + 19 + 27 = 137 hits, 15 + 19 · 2 + 13 · 3 + 26 + 27 = 145.
    expect(bySeed).toEqual({
      1: {
        freezes: 72,
        firings: 39,
        sizes: [8, 10, 21],
        limited: 10,
        lonely: 10,
        ownBolt: 14,
        crowded: 9,
        killFirings: 19,
        hits: 137,
        jumps: 27,
        kills: 14,
        shocked: 100,
        unmatched: 0,
        frozenPicked: 0,
        repeated: 0,
        unordered: 0,
        outOfRange: 0,
        badJump: 0,
        unshocked: 0,
      },
      2: {
        freezes: 72,
        firings: 47,
        sizes: [15, 19, 13],
        limited: 2,
        lonely: 6,
        ownBolt: 18,
        crowded: 1,
        killFirings: 26,
        hits: 145,
        jumps: 27,
        kills: 9,
        shocked: 123,
        unmatched: 0,
        frozenPicked: 0,
        repeated: 0,
        unordered: 0,
        outOfRange: 0,
        badJump: 0,
        unshocked: 0,
      },
    });
  });

  /**
   * Whether each enemy killed in a tick was frozen at its death, by id: frozen through the tick
   * as the last tick left it (frozenUntil > now), or frozen by a freeze event of the tick. Call
   * `kill` for each enemyKilled event in order, `freeze` for each freeze event and `end` with the
   * tick's context once the tick's events are read.
   */
  function freezeWatch() {
    let frozenUntil = new Map<number, number>();
    const froze = new Set<number>();
    return {
      freeze(id: number): void {
        froze.add(id);
      },
      frozenAt(id: number, now: number): boolean {
        return (frozenUntil.get(id) ?? 0) > now || froze.has(id);
      },
      end(ctx: RunContext): void {
        frozenUntil = new Map(ctx.enemies.map((e) => [e.id, e.frozenUntil]));
        froze.clear();
      },
    };
  }

  it('chains the shatters of shatterChain’s shatter kills, frozen or not, two deep at most after a hit’s kill, then caps (E6)', () => {
    const entry = ENTRIES.find((e) => e.name === 'shatterChain') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const watch = freezeWatch();
      // Each victim's chain generation and freeze, by its death point, until its shatter: 0
      // for a kill by anything but a shatter, one more than the killing shatter's otherwise.
      const victims = new Map<string, { gen: number; frozen: boolean }>();
      const c = {
        shatters: 0,
        chained: 0,
        unfrozenChained: 0,
        byGen: [0, 0, 0, 0],
        unmatched: 0,
        capped: 0,
      };
      watchRun(entry, seed, (now, events, ctx) => {
        let gen = -1;
        let lastHit: Extract<SimEvent, { type: 'hit' }> | null = null;
        for (const event of events) {
          if (event.type === 'freeze') watch.freeze(event.targetId);
          else if (event.type === 'hit') lastHit = event;
          else if (event.type === 'shatter') {
            const at = `${event.x},${event.y}`;
            const victim = victims.get(at);
            victims.delete(at);
            c.shatters++;
            if (victim === undefined) {
              c.unmatched++;
              gen = -1;
              continue;
            }
            gen = victim.gen;
            c.byGen[gen] = (c.byGen[gen] ?? 0) + 1;
            if (gen > 0) {
              c.chained++;
              if (!victim.frozen) c.unfrozenChained++;
            }
          } else if (event.type === 'enemyKilled') {
            const byShatter =
              lastHit !== null &&
              lastHit.targetId === event.enemyId &&
              (lastHit.tags & TAG.area) !== 0;
            victims.set(`${event.x},${event.y}`, {
              gen: byShatter ? gen + 1 : 0,
              frozen: watch.frozenAt(event.enemyId, now),
            });
          }
        }
        watch.end(ctx);
        c.capped = ctx.counters.triggerDepthCapped;
      });
      bySeed[seed] = c;
    }
    // Every shatter found its victim; chained ones, many of unfrozen victims, two deep at most
    // (the third generation, recorded at depth 3, capped).
    expect(bySeed).toEqual({
      1: {
        shatters: 46,
        chained: 35,
        unfrozenChained: 25,
        byGen: [11, 13, 22, 0],
        unmatched: 0,
        capped: 9,
      },
      2: {
        shatters: 40,
        chained: 25,
        unfrozenChained: 14,
        byGen: [15, 18, 7, 0],
        unmatched: 0,
        capped: 5,
      },
    });
  });

  it('leaves no shard of frozenNoSplit’s pentagons frozen at their death, 3 of the others, and 2 children of every 增殖 elite, frozen or not (E6)', () => {
    const entry = ENTRIES.find((e) => e.name === 'frozenNoSplit') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      const watch = freezeWatch();
      // The affix bits of each enemy as the last tick left it, by id.
      let affixes = new Map<number, number>();
      const tally: Record<string, number[]> = {};
      const add = (key: string, children: number): void => {
        tally[key] = [...(tally[key] ?? []), children];
      };
      watchRun(entry, seed, (now, events, ctx) => {
        for (let i = 0; i < events.length; i++) {
          const event = events[i] as SimEvent;
          if (event.type === 'freeze') watch.freeze(event.targetId);
          if (event.type !== 'enemyKilled') continue;
          // The children follow their parent's kill event.
          let children = 0;
          while (events[i + 1 + children]?.type === 'enemySpawned') children++;
          const frozen = watch.frozenAt(event.enemyId, now) ? 'frozen' : 'unfrozen';
          if (event.enemy === 'pentagon') add(`pentagon ${frozen}`, children);
          else if (((affixes.get(event.enemyId) ?? 0) & AFFIX_MULTIPLY) !== 0) {
            add(`增殖 ${event.enemy} ${frozen}`, children);
          }
        }
        watch.end(ctx);
        affixes = new Map(ctx.enemies.map((e) => [e.id, e.v3?.affixes ?? 0]));
      });
      bySeed[seed] = Object.fromEntries(
        Object.entries(tally)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, list]) => [key, { kills: list.length, children: [...new Set(list)] }]),
      );
    }
    // Each seed kills a 增殖 hexagon frozen, which leaves its 2 elites all the same.
    const tallies = (frozen: number, unfrozen: number) => ({
      'pentagon frozen': { kills: frozen, children: [0] },
      'pentagon unfrozen': { kills: unfrozen, children: [3] },
      '增殖 hexagon frozen': { kills: 1, children: [MULTIPLY_COUNT] },
    });
    expect(bySeed).toEqual({ 1: tallies(13, 2), 2: tallies(12, 1) });
  });

  it('thaws thaw’s frozen enemies as they ignite, locks each meter 180 ticks from the thaw, and shatters none that dies thawed (E6)', () => {
    const entry = ENTRIES.find((e) => e.name === 'thaw') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      // Each enemy's freeze and lock as the last tick left them, by id.
      let last = new Map<number, { frozenUntil: number; lock: number }>();
      // The enemies thawed and not frozen since, with their lock's end, by id.
      const thawed = new Map<number, number>();
      const c = {
        thaws: 0,
        ignitedThaws: 0,
        lockedFromThaw: 0,
        naturalEnds: 0,
        lockedHits: 0,
        chilledInLock: 0,
        refrozen: 0,
        refrozenEarly: 0,
        thawedKills: 0,
        thawedShatters: 0,
      };
      watchRun(entry, seed, (now, events, ctx) => {
        const ignited = new Set<number>();
        const killedAt = new Set<string>();
        for (const event of events) {
          if (event.type === 'ignite') ignited.add(event.targetId);
          else if (event.type === 'hit') {
            const lock = thawed.get(event.targetId);
            if (lock !== undefined && now < lock) c.lockedHits++;
          } else if (event.type === 'freeze') {
            const lock = thawed.get(event.targetId);
            if (lock !== undefined) {
              c.refrozen++;
              if (now < lock) c.refrozenEarly++;
              thawed.delete(event.targetId);
            }
          } else if (event.type === 'enemyKilled' && thawed.has(event.enemyId)) {
            c.thawedKills++;
            killedAt.add(`${event.x},${event.y}`);
            thawed.delete(event.enemyId);
          } else if (event.type === 'shatter' && killedAt.has(`${event.x},${event.y}`)) {
            c.thawedShatters++;
          }
        }
        for (const e of ctx.enemies) {
          const lock = thawed.get(e.id);
          if (lock !== undefined && now < lock && e.frost !== 0) c.chilledInLock++;
          const was = last.get(e.id);
          if (was === undefined) continue;
          if (was.frozenUntil > now && e.frozenUntil === now) {
            c.thaws++;
            if (ignited.has(e.id)) c.ignitedThaws++;
            if (e.frostLockUntil === now + 180) c.lockedFromThaw++;
            thawed.set(e.id, e.frostLockUntil);
          } else if (was.frozenUntil === now) c.naturalEnds++;
        }
        last = new Map(
          ctx.enemies.map((e) => [e.id, { frozenUntil: e.frozenUntil, lock: e.frostLockUntil }]),
        );
      });
      bySeed[seed] = c;
    }
    // Every thaw at an ignite, its lock 180 from it; the locked meters take none of the hits'
    // frost, and none thaws early again before its lock ends.
    expect(bySeed).toEqual({
      1: {
        thaws: 27,
        ignitedThaws: 27,
        lockedFromThaw: 27,
        naturalEnds: 17,
        lockedHits: 97,
        chilledInLock: 0,
        refrozen: 1,
        refrozenEarly: 0,
        thawedKills: 3,
        thawedShatters: 0,
      },
      2: {
        thaws: 23,
        ignitedThaws: 23,
        lockedFromThaw: 23,
        naturalEnds: 18,
        lockedHits: 96,
        chilledInLock: 0,
        refrozen: 0,
        refrozenEarly: 0,
        thawedKills: 3,
        thawedShatters: 0,
      },
    });
  });

  it('gives frostGain’s hits their frost × 1 on a normal enemy, × 1.5 shocked or on the boss, × 2 on the shocked boss (E6)', () => {
    const entry = ENTRIES.find((e) => e.name === 'frostGain') as GoldenC4Entry;
    const bySeed: Record<number, unknown> = {};
    for (const seed of GOLDEN_C4_SEEDS) {
      // Each enemy's meter and lock as the last tick left them, by id.
      let last = new Map<number, { frost: number; lock: number }>();
      const ratios: Record<string, Record<string, number>> = {};
      watchRun(entry, seed, (now, events, ctx) => {
        const hits = new Map<number, number>();
        for (const event of events) {
          if (event.type === 'hit') hits.set(event.targetId, (hits.get(event.targetId) ?? 0) + 1);
        }
        for (const e of ctx.enemies) {
          const was = last.get(e.id);
          // A tick of one hit on an enemy whose meter takes it and does not fill.
          if (was === undefined || hits.get(e.id) !== 1 || now < was.lock) continue;
          if (!(e.frost > was.frost)) continue;
          const key = `${e.boss ? 'boss' : 'normal'} ${holdsShock(e, now) ? 'shocked' : 'plain'}`;
          const ratio = String((e.frost - was.frost) / 0.125);
          const seen = (ratios[key] ??= {});
          seen[ratio] = (seen[ratio] ?? 0) + 1;
        }
        last = new Map(ctx.enemies.map((e) => [e.id, { frost: e.frost, lock: e.frostLockUntil }]));
      });
      bySeed[seed] = ratios;
    }
    // The ratio of each one-hit tick's frost to frostOnHit, by the enemy's kind and shock.
    expect(bySeed).toEqual({
      1: {
        'normal plain': { 1: 10 },
        'normal shocked': { 1.5: 31 },
        'boss plain': { 1.5: 1 },
        'boss shocked': { 2: 9 },
      },
      2: {
        'normal plain': { 1: 8 },
        'normal shocked': { 1.5: 26 },
        'boss plain': { 1.5: 1 },
        'boss shocked': { 2: 9 },
      },
    });
  });

  it.each(cases)('$id', ({ entry, seed, expected }) => {
    const [first, second] = runCase(entry, seed);
    expect(second, 'the second run of the same case').toBe(first);
    expect(first).toBe(expected);
  });
});
