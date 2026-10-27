/**
 * The `?enemies` grid (docs/v3 C7 design §2.9, the lead's ruling P7): a dev page's run on
 * characterGameData() whose waves bring nothing, on a fixed seed. On its first tick a test module
 * stands every v3 type in a row above the player, in roster order, and a hexagon elite of each
 * affix in a row below it, in AFFIX_IDS order; between the rows, 洋蔥 with two shells left and
 * with one, a pair of 增殖's children at MULTIPLY_RADIUS and an elite of three affixes. Each is
 * immortal and stands still, placed where its behaviour shows: 衝刺者 charges (red) at once,
 * 射手 fires at the player, 召喚者 calls its triangles, 寶藏怪 orbits, then flees, and 守護's
 * neighbours stand inside its ring. The player attacks with M1's base stats, and a shield refilled
 * every GRID_SHIELD_SEC shows its arc. The run starts again every GRID_LOOP_SECONDS, so the charge
 * comes round again; the banner (src/ui/banner.ts), given a fresh seen set per page load (the
 * lead's ruling L7), hears every tick and keeps it across the restarts. DOM-free, so the tests
 * reach it; route.ts draws it. It writes no storage, sends no playtest event and calls no
 * platform API.
 */

import { characterGameData } from '../../data';
import { AFFIX_IDS } from '../../data/affixes';
import { V3_ENEMIES } from '../../data/enemiesV3';
import { BASE_STATS } from '../../data/stats';
import type { StatBlock } from '../../data/stats';
import { ENEMY_IDS } from '../../data/types';
import type { EnemyDef, GameData } from '../../data/types';
import { createSimulation, NO_INPUT, TICK_RATE } from '../../sim';
import type { RunConfig, SimEvent, SimState, Simulation } from '../../sim';
import type { TestModule } from '../../sim/rules';
import { MULTIPLY_RADIUS } from '../../sim/systems/affixes';
import type { SpawnOrigin } from '../../sim/systems/enemyRecord';
import { addEnemy } from '../../sim/systems/spawn';
import type { EnemyBanner } from '../../ui/banner';
import type { LoopHost } from '../loop';
import { typicalHitOf } from '../typicalHit';

/** The run's seed and its effects' (src/render/random.ts): fixed, so every load draws the same. */
export const GRID_SEED = 1;
export const GRID_RENDER_SEED = 2;
/** The run starts again this often: long enough for 寶藏怪 to orbit its 8 s and flee. */
export const GRID_LOOP_SECONDS = 20;
/** × on every type's life: immortal in practice, as the replay's boss (presets.ts). */
const GRID_HP_MULT = 1e12;
/** The player's shield: this share of max life, refilled every GRID_SHIELD_SEC (C7.2's effect). */
const GRID_SHIELD_PCT = 0.2;
const GRID_SHIELD_SEC = 3;
/** The rows' offsets from the player, arena units: the types above, the elites below. */
const TYPE_ROW = -240;
/**
 * Between two types: 衝刺者 (third) stands inside its chargeDist (420), 射手 (fourth) inside its
 * stopDist (300), 召喚者 inside its 480 and 寶藏怪 (sixth) inside its orbitDist (480).
 */
const TYPE_STEP = 200;
const AFFIX_ROW = 240;
/** Between two elites: under GUARD_RADIUS (160), so 守護's neighbours stand inside its ring. */
const AFFIX_STEP = 150;
/**
 * The middle row's spots, left and right of the player: 洋蔥's two, 增殖's pair (far enough apart
 * for their labels), three affixes.
 */
const ONION_SPOTS = [-600, -360] as const;
const CHILD_SPOTS = [290, 420] as const;
const TRIPLE_SPOT = 600;
/** The three-affix elite's: 迅捷, 堅甲 and 元素護盾 (a symbol row and a shell). */
const TRIPLE = ['swift', 'armoured', 'ward'] as const;

/** One enemy of the grid: its label (dev text), its def as placed, its offset and its origin. */
export interface GridSpot {
  readonly label: string;
  readonly def: EnemyDef;
  readonly dx: number;
  readonly dy: number;
  readonly origin: SpawnOrigin;
}

/** The affix bit of AFFIX_IDS' entry `id`. */
const bitOf = (id: (typeof AFFIX_IDS)[number]): number => 1 << AFFIX_IDS.indexOf(id);

const origin = (affixes: number, radiusScale = 1): SpawnOrigin => ({
  hpScale: 1,
  radiusScale,
  dropScale: 1,
  extra: true,
  affixes,
});

/** `def` standing still and immortal; a layered def (洋蔥) with `layers` shells when given. */
function still(def: EnemyDef, layers?: number): EnemyDef {
  const placed = { ...def, speed: 0, hpMult: GRID_HP_MULT };
  const behaviour = def.behaviour;
  if (layers === undefined || behaviour?.kind !== 'layers') return placed;
  return { ...placed, behaviour: { ...behaviour, layers } };
}

/** The grid's data: characterGameData() with waves that bring nothing (a wave every 1000 s). */
export function gridData(): GameData {
  const data = characterGameData();
  return {
    ...data,
    waves: {
      ...data.waves,
      // Named at a count of 0: none spawns, but the run can spawn them (reachableEnemies), so
      // its shot padding is a v3 run's.
      rules: data.waves.rules.map((rule) => ({ ...rule, base: 0, perWave: 0, maxCount: 0 })),
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
    },
  };
}

/** The grid's enemies on `data`, in the order they spawn (the banner's sighting order). */
export function gridSpots(data: GameData): GridSpot[] {
  const types = ENEMY_IDS.filter((id) => Object.hasOwn(V3_ENEMIES, id));
  const elite = data.enemies.hexagon;
  const onion = data.enemies.onion;
  return [
    ...types.map((id, i) => ({
      label: id,
      def: still(data.enemies[id]),
      dx: (i - (types.length - 1) / 2) * TYPE_STEP,
      dy: TYPE_ROW,
      origin: origin(0),
    })),
    ...AFFIX_IDS.map((id, i) => ({
      label: id,
      def: still(elite),
      dx: (i - (AFFIX_IDS.length - 1) / 2) * AFFIX_STEP,
      dy: AFFIX_ROW,
      origin: origin(bitOf(id)),
    })),
    ...ONION_SPOTS.map((dx, i) => ({
      label: `onion, ${2 - i} left`,
      def: still(onion, 2 - i),
      dx,
      dy: 0,
      origin: origin(0),
    })),
    ...CHILD_SPOTS.map((dx) => ({
      label: 'multiply child',
      def: still(elite),
      dx,
      dy: 0,
      origin: origin(bitOf('swift'), MULTIPLY_RADIUS),
    })),
    {
      label: TRIPLE.join(' + '),
      def: still(elite),
      dx: TRIPLE_SPOT,
      dy: 0,
      origin: origin(TRIPLE.reduce((bits, id) => bits | bitOf(id), 0)),
    },
  ];
}

/** Stands `spots` round the player on the first tick that has a wave. */
function placeGrid(spots: readonly GridSpot[]): TestModule {
  return (b) => {
    let placed = false;
    b.hook('tick', (ctx) => {
      const rec = ctx.current;
      if (placed || rec === null) return;
      placed = true;
      for (const spot of spots) {
        const dist = Math.hypot(spot.dx, spot.dy);
        addEnemy(ctx, spot.def, rec, spot.dx / dist, spot.dy / dist, dist, spot.origin);
      }
    });
  };
}

/** M1's base stats, with a shield refilled every GRID_SHIELD_SEC. */
export function gridConfig(): RunConfig {
  const stats: StatBlock = {
    base: BASE_STATS,
    values: BASE_STATS,
    scoped: [],
    triggers: [
      {
        source: 'center',
        spec: {
          on: 'periodic',
          every: GRID_SHIELD_SEC,
          do: [{ kind: 'shield', lifePct: GRID_SHIELD_PCT, capPct: GRID_SHIELD_PCT }],
        },
      },
    ],
    conversions: [],
    emitters: [],
  };
  return { seed: GRID_SEED, stats, rules: [], startWave: 1, mode: 'auto' };
}

/** What the grid draws into: the game's renderer (route.ts), or a recording stub in the tests. */
export interface GridView {
  /** A run (re)starts: Renderer.beginRun with its typical hit. */
  start(typicalHit: number): void;
  /** One tick's events. */
  events(events: readonly SimEvent[]): void;
  /** One frame: the state, interpolated by `alpha`, `elapsedMs` after the last. */
  frame(state: Readonly<SimState>, alpha: number, elapsedMs: number): void;
}

/**
 * The grid's run as the game loop's host (src/app/loop.ts): always running; each tick goes to the
 * view and the banner, each frame's wall-clock time to the banner's clock. Nothing here waits on
 * the banner: the ticks go on while a line shows (gd A.3 「不暫停」).
 */
export class EnemyGrid implements LoopHost {
  /** The enemies it stands, in spawn order (route.ts labels them). */
  readonly spots: readonly GridSpot[];
  private readonly config = gridConfig();
  private sim: Simulation;
  /** Runs started, the first included. */
  private runs = 0;

  /** `data`: gridData()'s, which the renderer and the banner take too. */
  constructor(
    private readonly view: GridView,
    private readonly banner: EnemyBanner,
    private readonly data: GameData = gridData(),
  ) {
    this.spots = gridSpots(data);
    this.sim = this.restart();
  }

  /** The current run's state. */
  get state(): Readonly<SimState> {
    return this.sim.state;
  }

  /** How many runs have started, the first included. */
  get started(): number {
    return this.runs;
  }

  isRunning(): boolean {
    return true;
  }

  step(): void {
    const state = this.sim.state;
    if (state.finished || state.tick >= GRID_LOOP_SECONDS * TICK_RATE) this.sim = this.restart();
    const events = this.sim.step(NO_INPUT);
    this.view.events(events);
    this.banner.events(events);
  }

  frame(alpha: number, elapsedMs: number): void {
    this.banner.update(elapsedMs);
    this.view.frame(this.sim.state, alpha, elapsedMs);
  }

  private restart(): Simulation {
    this.runs++;
    const sim = createSimulation(this.config, this.data, [placeGrid(this.spots)]);
    this.view.start(typicalHitOf(this.config));
    return sim;
  }
}
