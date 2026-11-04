/**
 * 蜂巢's own rules (docs/v3/game-design-v3.md §1.5; B2): the swarm's counts and dock time, 巨像,
 * and the timed drones of 分巢, 繁衍 and 母艦工廠. Each writes the swarm's parameters
 * (SwarmParams, src/sim/build/compile.ts) in place or compiles a spawnDrone effect, a timed row
 * of the drone pool (src/sim/systems/drones.ts) that dashes at the enemies farthest from the
 * player, impacts HIVE_TIMED_IMPACTS times as a drone's sortie does and leaves.
 *
 * - hiveSplit (分巢): an onKill hook counts the instance's kills and spawns one at every
 *   `every`-th victim.
 * - swarmTune (量產, 回收): turrets added, the dock time × the factors.
 * - colossus (巨像): the swarm keeps one drone and its impacts take a more of damagePerMissing for
 *   each drone given up; hiveExpand's drones, compiled later, are given up too (colossusOf).
 * - hiveExpand (擴巢), hiveBuild (增建): drones, turrets added.
 * - royalJelly (蜂王漿): the ascendancy's timed drones live lifeMult as long; it compiles before
 *   breed, its chain's final, which reads it (jellyOf).
 * - breed (繁衍): a kill trigger with its chance that spawns one at the victim.
 * - motherFactory (母艦工廠): a tick hook that, every periodSec, spawns one at each turret of the
 *   swarm.
 *
 * What one module tells another in the same compile lives in a WeakMap on the compiler, so a run
 * starts clean. A compile error in a run of another signature for the swarm's own rules.
 */

import type { RuleSpec } from '../../data/rules';
import type { SpawnDroneSpec } from '../../data/triggers';
import type { SwarmParams } from '../build/compile';
import { SUMMON_CAP } from '../caps';
import { DRONE_KIND_TURRET, TICK_RATE } from '../types';
import { enqueueModuleEffect } from './api';
import type { ModuleEvent } from './api';
import type { BuildCompiler, RuleModule } from './module';

/** A timed hive drone's impacts: a fixed drone's sortie (SwarmParams.impacts). */
export const HIVE_TIMED_IMPACTS = 3;

/** What the hive's modules tell each other within one compile. */
interface HiveNotes {
  /** 巨像's damagePerMissing and the drones it has given up so far; null without it. */
  colossus: { perMissing: number; missing: number } | null;
  /** 蜂王漿's factor on the ascendancy's timed drones; 1 without it. */
  lifeMult: number;
}

const NOTES = new WeakMap<BuildCompiler, HiveNotes>();

function notesOf(b: BuildCompiler): HiveNotes {
  let notes = NOTES.get(b);
  if (notes === undefined) {
    notes = { colossus: null, lifeMult: 1 };
    NOTES.set(b, notes);
  }
  return notes;
}

/** The swarm's parameters, or the error a swarm rule in a run of another signature is. */
export function swarmParams(b: BuildCompiler, rule: RuleSpec['id']): SwarmParams {
  const signature = b.signature();
  if (signature.swarm === null) {
    throw new Error(
      `rule '${rule}' tunes the swarm signature, but this run's signature is '${signature.id}'`,
    );
  }
  return signature.swarm;
}

/** A drone's impacts and the timed drones' hits: minion and area, never projectile or trigger. */
const DRONE_TAGS = { tags: ['minion', 'area'], notTags: ['projectile', 'trigger'] } as const;

/** A more on the drones' damage, after the build's own modifiers. */
function droneMore(b: BuildCompiler, value: number): void {
  if (value !== 0) b.addModifier({ stat: 'damage', kind: 'more', value, ...DRONE_TAGS });
}

/** A hive timed drone: the enemies farthest from the player, a sortie's impacts. */
function timedDrone(lifeSec: number, damagePct: number, maxLive: number): SpawnDroneSpec {
  return {
    kind: 'spawnDrone',
    lifeSec,
    damagePct,
    maxLive,
    aim: 'outer',
    impacts: HIVE_TIMED_IMPACTS,
  };
}

export const hiveSplit: RuleModule<Extract<RuleSpec, { id: 'hiveSplit' }>> = {
  id: 'hiveSplit',
  compile(b, specs) {
    const { name } = b.credit();
    for (const spec of specs) {
      const effect = b.addEffect(name, timedDrone(spec.lifeSec, spec.damagePct, spec.maxLive));
      let kills = 0;
      const trigger = b.hook('onKill', (ctx, _victim, kill) => {
        kills++;
        if (kills % spec.every === 0) enqueueModuleEffect(ctx, trigger, effect, kill);
      });
    }
  },
};

export const swarmTune: RuleModule<Extract<RuleSpec, { id: 'swarmTune' }>> = {
  id: 'swarmTune',
  compile(b, specs) {
    const swarm = swarmParams(b, 'swarmTune');
    for (const spec of specs) {
      swarm.turrets += spec.turrets;
      swarm.dockSec *= spec.dockSecMult;
    }
  },
};

/** 巨像's growth as drawn: × (1 + this × the drones given up), render only (E4 sizeMult). */
export const COLOSSUS_GROWTH = 0.2;
/** The swarm drone slots 蜂后 and 重錘 take (E4 roles: distinct, the leader at 0). */
export const QUEEN_SLOT = 0;
export const HAMMER_SLOT = 1;

export const colossus: RuleModule<Extract<RuleSpec, { id: 'colossus' }>> = {
  id: 'colossus',
  compile(b, specs) {
    const swarm = swarmParams(b, 'colossus');
    const spec = specs[0];
    if (spec === undefined) return;
    const missing = Math.max(0, swarm.drones - 1);
    swarm.drones = Math.min(swarm.drones, 1);
    notesOf(b).colossus = { perMissing: spec.damagePerMissing, missing };
    droneMore(b, spec.damagePerMissing * missing);
    swarm.sizeMult *= 1 + COLOSSUS_GROWTH * missing;
  },
};

export const hiveExpand: RuleModule<Extract<RuleSpec, { id: 'hiveExpand' }>> = {
  id: 'hiveExpand',
  compile(b, specs) {
    const swarm = swarmParams(b, 'hiveExpand');
    const colossal = notesOf(b).colossus;
    for (const spec of specs) {
      if (colossal === null) {
        swarm.drones += spec.drones;
        continue;
      }
      // Under 巨像 the drones are given up too: its more becomes 1 + p × (m + d), not × twice.
      const { perMissing: p, missing: m } = colossal;
      const d = spec.drones;
      droneMore(b, (1 + p * (m + d)) / (1 + p * m) - 1);
      swarm.sizeMult *= (1 + COLOSSUS_GROWTH * (m + d)) / (1 + COLOSSUS_GROWTH * m);
      colossal.missing = m + d;
    }
  },
};

export const hiveBuild: RuleModule<Extract<RuleSpec, { id: 'hiveBuild' }>> = {
  id: 'hiveBuild',
  compile(b, specs) {
    const swarm = swarmParams(b, 'hiveBuild');
    for (const spec of specs) swarm.turrets += spec.turrets;
  },
};

export const royalJelly: RuleModule<Extract<RuleSpec, { id: 'royalJelly' }>> = {
  id: 'royalJelly',
  compile(b, specs) {
    const notes = notesOf(b);
    for (const spec of specs) notes.lifeMult *= spec.lifeMult;
  },
};

export const breed: RuleModule<Extract<RuleSpec, { id: 'breed' }>> = {
  id: 'breed',
  compile(b, specs) {
    const { name } = b.credit();
    const lifeMult = notesOf(b).lifeMult;
    for (const spec of specs) {
      b.addTrigger(name, {
        on: 'kill',
        when: [{ chance: spec.chance }],
        do: [timedDrone(spec.lifeSec * lifeMult, spec.damagePct, spec.maxLive)],
      });
    }
  },
};

export const motherFactory: RuleModule<Extract<RuleSpec, { id: 'motherFactory' }>> = {
  id: 'motherFactory',
  compile(b, specs) {
    swarmParams(b, 'motherFactory');
    const { name } = b.credit();
    const lifeMult = notesOf(b).lifeMult;
    for (const spec of specs) {
      const effect = b.addEffect(
        name,
        timedDrone(spec.lifeSec * lifeMult, spec.damagePct, SUMMON_CAP),
      );
      const period = Math.max(1, Math.round(spec.periodSec * TICK_RATE));
      const ev: { -readonly [K in keyof ModuleEvent]: ModuleEvent[K] } = {
        depth: 0,
        origin: -1,
        target: null,
        x: 0,
        y: 0,
        flags: 0,
      };
      let ticks = 0;
      const trigger = b.hook('tick', (ctx) => {
        ticks++;
        if (ticks % period !== 0) return;
        const ds = ctx.sys.drones;
        // The swarm's turrets only (emitter 0, the signature): a granted turret makes none.
        for (let s = 0; s < ds.count; s++) {
          if (ds.kind[s] !== DRONE_KIND_TURRET || ds.owner[s] !== 0) continue;
          ev.x = ds.x[s] as number;
          ev.y = ds.y[s] as number;
          enqueueModuleEffect(ctx, trigger, effect, ev);
        }
      });
    }
  },
};

/** 蜂后: the swarm's first drone leads, ×damage and ×size, the others ×(1 + followBonus) on its target. */
export const queenRole: RuleModule<Extract<RuleSpec, { id: 'queenRole' }>> = {
  id: 'queenRole',
  compile(b, specs) {
    const swarm = swarmParams(b, 'queenRole');
    const spec = specs[0];
    if (spec === undefined) return;
    swarm.roles.push({
      slot: QUEEN_SLOT,
      damageMult: spec.damageMult,
      speedMult: 1,
      sizeMult: spec.sizeMult,
      followBonus: spec.followBonus,
    });
  },
};

/** 重錘: the swarm's second drone hits ×damageMult and flies ×speedMult. */
export const hammerRole: RuleModule<Extract<RuleSpec, { id: 'hammerRole' }>> = {
  id: 'hammerRole',
  compile(b, specs) {
    const swarm = swarmParams(b, 'hammerRole');
    const spec = specs[0];
    if (spec === undefined) return;
    swarm.roles.push({
      slot: HAMMER_SLOT,
      damageMult: spec.damageMult,
      speedMult: spec.speedMult,
      sizeMult: 1,
      followBonus: 0,
    });
  },
};

/** 集火指令: every summon picks the enemy with the most hp (E4 summonHighestHp); its +25% is data. */
export const focusFire: RuleModule<Extract<RuleSpec, { id: 'focusFire' }>> = {
  id: 'focusFire',
  compile(b, specs) {
    swarmParams(b, 'focusFire');
    if (specs.length > 0) b.flags.summonHighestHp = true;
  },
};

/** 前哨: the swarm's turrets sit at turretRadius (E4); granted turrets keep theirs. */
export const outpost: RuleModule<Extract<RuleSpec, { id: 'outpost' }>> = {
  id: 'outpost',
  compile(b, specs) {
    const swarm = swarmParams(b, 'outpost');
    for (const spec of specs) swarm.turretRadius = Math.max(swarm.turretRadius, spec.turretRadius);
  },
};

/** 自爆協議: the impact that spends a swarm drone's sortie explodes (E5 lastImpact). */
export const selfDestruct: RuleModule<Extract<RuleSpec, { id: 'selfDestruct' }>> = {
  id: 'selfDestruct',
  compile(b, specs) {
    const swarm = swarmParams(b, 'selfDestruct');
    const spec = specs[0];
    if (spec === undefined) return;
    swarm.lastImpact = { radius: spec.radius, damagePct: spec.damagePct };
  },
};

/** 攔截守衛: the swarm's last `count` drones orbit at `radius` and ram charging dashers (E5). */
export const interceptors: RuleModule<Extract<RuleSpec, { id: 'interceptors' }>> = {
  id: 'interceptors',
  compile(b, specs) {
    const swarm = swarmParams(b, 'interceptors');
    const spec = specs[0];
    if (spec === undefined) return;
    swarm.guards = { count: spec.count, radius: spec.radius };
  },
};

/** 蜂潮: every periodSec the swarm dives at the densest enemy, ×damageMult on that impact (E5). */
export const swarmSurge: RuleModule<Extract<RuleSpec, { id: 'swarmSurge' }>> = {
  id: 'swarmSurge',
  compile(b, specs) {
    const swarm = swarmParams(b, 'swarmSurge');
    const spec = specs[0];
    if (spec === undefined) return;
    swarm.surge = { periodSec: spec.periodSec, damageMult: spec.damageMult };
  },
};
