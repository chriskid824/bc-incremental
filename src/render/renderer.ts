/**
 * PixiJS view of a run (docs/ARCHITECTURE.md §3, §10). Reads simulation state and events and
 * never mutates them. The arena (ARENA_WIDTH × ARENA_HEIGHT) is scaled to fit the window with
 * letterboxing; every effect runs on its own timers driven by the frame time, not the sim.
 *
 * Feel (docs/GDD.md §1, §3): kills explode in the enemy's color, crits flare and pop numbers
 * (a few big pops at a time), burning enemies glow and shed flames behind their outlines,
 * pandemic spreads as a fire nova, chains arc as flickering lightning. Poison and bleed ticks
 * (dotTick) pop their own green and red numbers, tallied as burn's; poisoned, chilled and frozen
 * enemies take a cast (src/render/enemies.ts); a freeze and a shatter burst in ice. Shake and hit-stop are
 * budgeted so they punch instead of jitter, and every effect pool is capped so a crowded screen
 * sheds detail instead of frame rate. docs/ARCHITECTURE.md §10 lists the layers and budgets.
 *
 * A v3 run (data.waves.v3, docs/v3 C7 design §2.9) also draws the shooters' bullets, the player's
 * shield arc, a spark where an enemy's defences took a hit whole (hitBlocked), a pop as an elite's
 * ward breaks (wardBroken) and a ring as 洋蔥 sheds a shell (onionLayer); the enemy views draw
 * the rest from the record. The kill tier reads the def's flags (killTier), and the core does not
 * flash on a hit the shield took whole (CoreHitFilter). An M1 run has none of their inputs: the
 * bullet and shield layers are not made, and its frames are as before.
 *
 * A v3 character run (RendererOptions.character, B1) draws the character's construct and arena
 * in place of M1's hexagon and floor, its hit numbers in the character colour, the crit slash
 * lines ('slash'), and for 熔核 its attack language (src/render/magma.ts): the bombs, explosions,
 * fire zones and scorch marks, the 火環 nova and the fusion looks (霜焰, 瘟爆, 爆靈); for 蜂巢 its
 * (src/render/swarm.ts): the dock ring and turret seats, the drones' floor wakes, the impacts and
 * muzzle flashes, and its drones dressed in the owned fusions' skins by slot. Without it (the M1
 * page, `?hive`) none of those layers is made and none of those events is drawn.
 *
 * A build with a segment emitter (any construct) also draws its links (src/render/
 * segmentLines.ts, V1): the layer is made the first time render() sees a state with a segment
 * emitter, under the enemies, and kept for the renderer's life; destroy() destroys it. A
 * renderer that never draws a segment emitter never makes it. The links between drones or
 * summons are drawn only by a renderer that draws the drones (the hive construct, the lead's
 * ruling L2); every renderer draws the shocked ones.
 */

import { Container, Graphics } from 'pixi.js';
import type { Application } from 'pixi.js';
import type { Num } from '../core/num';
import { TAG } from '../data/tags';
import type { GameData } from '../data/types';
import { ARENA_HEIGHT, ARENA_WIDTH, PLAYER_RADIUS } from '../sim';
import type { SimEvent, SimState } from '../sim';
import { ArcLayer } from './arcs';
import { createArenaBackdrop, createBackdrop } from './backdrop';
import { BurnTally } from './burnTally';
import { Bursts } from './bursts';
import { BulletLayer } from './bullets';
import { fusionSkin, hitNumberColor, slotSkins } from './characterLook';
import type { CharacterLook } from './characterLook';
import { ConstructCoreView, HiveCoreView } from './core';
import type { CoreView } from './core';
import { CritStopGate } from './critStop';
import { DamageNumbers } from './damageNumbers';
import { BLAST_SPIRIT_SKIN, DroneLayer, HIVE_DRONE_SKIN } from './drones';
import { EnemyLayer } from './enemies';
import { FxParticles } from './fx';
import { createFxTextures } from './fxTextures';
import { killTier, TIER_BOSS, TIER_ELITE } from './killTier';
import { DEFAULT_MAGMA_LOOKS, MagmaLayer } from './magma';
import { hudSafeArea } from './numberLayout';
import { COLORS, MAGMA_COLORS } from './palette';
import { ShardParticles } from './particles';
import { PlayerView } from './player';
import { CoreHitFilter } from './playerHits';
import { PoolShotLayer } from './poolShots';
import { ProjectileLayer } from './projectiles';
import { defaultRandom } from './random';
import type { RenderRandom } from './random';
import { RingLayer } from './rings';
import { SegmentLineLayer } from './segmentLines';
import { ScreenShake } from './shake';
import { CRIT_PUNCH, HIT_PUNCH_STRONG, ImpactShakes } from './impact';
import type { ShakeKick } from './impact';
import { PlayerShield } from './shieldArc';
import { SlashLayer } from './slashes';
import { SwarmLayer, swarmDroneSkin, swarmLooks } from './swarm';

export interface RendererOptions {
  /** Disables screen shake (settings toggle later, docs/ARCHITECTURE.md §10). */
  readonly reducedMotion: boolean;
  /** Asks the game loop for a hit-stop of `ms` wall-clock ms (src/app/loop.ts). */
  readonly hitStop?: (ms: number) => void;
  /**
   * The construct at the center. 'hive' (the `?hive` prototype, docs/v3 C5 design §13.2) draws
   * 蜂巢's comb, the run's drones and turrets and the shot pool's homing shots; without it the
   * center is M1's hexagon and none of them is drawn.
   */
  readonly construct?: 'hive';
  /**
   * A v3 character run's looks (src/render/characterLook.ts): its construct at the center, its
   * arena, its hit-number colour and its attack language. A 'hive' construct takes the `?hive`
   * path above. Left out on the M1 page and `?hive`, whose frames stay as they were.
   */
  readonly character?: CharacterLook;
  /**
   * Where the effects draw their randomness (src/render/random.ts). The M1 page passes none, so
   * they draw Math.random; a replay (src/app/replay) passes a seeded one for repeatable frames.
   */
  readonly random?: RenderRandom;
}

/** Crits at least this many decades above the typical hit shake the screen (2× ≈ 0.3). */
const SHAKE_MIN_DECADES = Math.log10(2);
const SHAKE_BASE = 0.24;
const SHAKE_PER_DECADE = 0.2;
/** Crit shakes never push trauma past this, and come at most once per cooldown. */
const CRIT_SHAKE_CEILING = 0.55;
const CRIT_SHAKE_COOLDOWN_MS = 300;
const ELITE_SHAKE = 0.55;
const ELITE_SHAKE_CEILING = 0.75;
const BOSS_SHAKE = 1;
/** Hit-stop on elite and boss kills; crits go through CritStopGate (src/render/critStop.ts). */
const ELITE_HIT_STOP_MS = 55;
const BOSS_HIT_STOP_MS = 80;
/** Kill debris thins out as more enemies die in the same frame. */
const CROWD_KILLS = 6;
/** pandemic embers per nova, and novas whose embers are resolved per frame. */
const EMBERS_PER_NOVA = 8;
const MAX_PENDING_NOVAS = 8;
/** Frame time cap for effects, so a long pause does not fast-forward them in one jump. */
const MAX_EFFECT_DT_MS = 100;
/** A ward's break: a small ring this much wider than the enemy, white as the shell it was. */
const WARD_BREAK_SCALE = 1.5;
const WARD_BREAK_WIDTH = 3;
const WARD_BREAK_MS = 260;
/** A shell 洋蔥 sheds: a ring out to the onion's radius, wider and longer than an impact's. */
const SHELL_BREAK_WIDTH = 6;
const SHELL_BREAK_MS = 420;

const CENTER_X = ARENA_WIDTH / 2;
const CENTER_Y = ARENA_HEIGHT / 2;
/** 血河's red trail (gd §4.3): the bleed outer's crimson, #D7263D. */
const BLOOD_TRAIL_COLOR = 0xd7263d;
const BLOOD_TRAIL_WIDTH = 6;

export class Renderer {
  private readonly world = new Container({ label: 'world' });
  private readonly letterbox = new Graphics({ label: 'letterbox' });
  private readonly enemies: EnemyLayer;
  private readonly projectiles: ProjectileLayer;
  private readonly arcs: ArcLayer;
  private readonly rings = new RingLayer();
  private readonly fx: FxParticles;
  /** Flames of burning enemies, drawn under the crowd. */
  private readonly flames: FxParticles;
  private readonly bursts: Bursts;
  /** The view at the arena center: M1's hexagon or a construct (RendererOptions.construct). */
  private readonly core: CoreView;
  /** The run's drones and turrets; only with the hive construct. */
  private readonly drones: DroneLayer | null;
  /** The shot pool's homing shots, the turrets'; only with the hive construct. */
  private readonly poolShots: PoolShotLayer | null;
  /** The shooters' bullets; only on v3 data. */
  private readonly bullets: BulletLayer | null;
  /** The player's shield arc; only on v3 data. */
  private readonly playerShield: PlayerShield | null;
  /** A non-hive character's construct (the attack pose); null otherwise. */
  private readonly construct: ConstructCoreView | null;
  /** 熔核's bombs, explosions, fire zones and scorch marks; only on a magmaCore run. */
  private readonly magma: MagmaLayer | null;
  /** 蜂巢's docks, wakes, impacts and muzzle flashes; only on a hive character run. */
  private readonly swarm: SwarmLayer | null;
  /** The crit slash lines; only on a character run. */
  private readonly slashes: SlashLayer | null;
  /** 血河 (E9): each bleed spread that reached an enemy draws a red trail outward. */
  private readonly bloodTrails: SlashLayer | null;
  /**
   * The segment emitters' links, under the enemies; made by the first render() of a state with
   * a segment emitter (a non-empty SimState.segments.lines), null until then.
   */
  private segmentLines: SegmentLineLayer | null = null;
  /** Which player hits flash the core: not one the shield took whole. */
  private readonly coreHits = new CoreHitFilter();
  private readonly shards: ShardParticles;
  private readonly numbers: DamageNumbers;
  private readonly burnTally = new BurnTally();
  /** Poison and bleed ticks (dotTick) are tallied as burn's, each into its own numbers. */
  private readonly poisonTally = new BurnTally();
  private readonly bleedTally = new BurnTally();
  private readonly shake: ScreenShake;
  private readonly hitStop: (ms: number) => void;
  private readonly critStop = new CritStopGate();
  private critShakeCooldownMs = 0;
  private readonly impactShakes = new ImpactShakes();
  private killsThisFrame = 0;
  /** pandemic spreads waiting for render() to aim their embers: x, y, radius triples. */
  private readonly pendingNovas = new Float64Array(MAX_PENDING_NOVAS * 3);
  private pendingNovaCount = 0;
  private worldScale = 1;
  private worldX = 0;
  private worldY = 0;
  private readonly onResize = (): void => this.fit();
  private readonly showBurn = (amount: Num, x: number, y: number, enemyId: number): void => {
    this.numbers.spawn('burn', amount, x, y, enemyId);
  };
  private readonly showPoison = (amount: Num, x: number, y: number, enemyId: number): void => {
    this.numbers.spawn('poison', amount, x, y, enemyId);
  };
  private readonly showBleed = (amount: Num, x: number, y: number, enemyId: number): void => {
    this.numbers.spawn('bleed', amount, x, y, enemyId);
  };
  private readonly flamePuff = (x: number, y: number): void => this.bursts.flamePuff(x, y);

  constructor(
    private readonly app: Application,
    private readonly data: GameData,
    options: RendererOptions,
  ) {
    const random = options.random ?? defaultRandom;
    this.arcs = new ArcLayer(random);
    this.numbers = new DamageNumbers(random);
    const textures = createFxTextures();
    this.enemies = new EnemyLayer(data, textures.glow, random);
    this.projectiles = new ProjectileLayer(textures);
    this.fx = new FxParticles(textures);
    this.flames = new FxParticles(textures);
    this.bursts = new Bursts(this.fx, this.flames, textures, this.rings, random);
    this.shards = new ShardParticles(app.renderer, random);
    const look = options.character ?? null;
    const hive = options.construct === 'hive' || look?.construct === 'hive';
    const spirits = look !== null && !hive && fusionSkin(look, 'summon') !== null;
    // The summon outer's drones and turrets on another construct; one skin for every row, so a
    // build with 火靈's spirits draws its drones in the spirits' colours too.
    const summons = look !== null && !hive && look.summons;
    // A hive character run's drones wear its fusions' skins by slot (gd §5.3); `?hive` has none.
    const swarmLook = hive && look !== null ? swarmLooks(slotSkins(look)) : null;
    this.drones = hive
      ? swarmLook === null
        ? new DroneLayer(app.renderer, textures.streak)
        : new DroneLayer(app.renderer, textures.streak, swarmDroneSkin(swarmLook))
      : spirits || summons
        ? new DroneLayer(
            app.renderer,
            textures.streak,
            spirits && look.construct === 'magmaCore' ? BLAST_SPIRIT_SKIN : HIVE_DRONE_SKIN,
          )
        : null;
    this.poolShots = hive || summons ? new PoolShotLayer(textures) : null;
    this.construct =
      look !== null && look.construct !== 'hive' ? new ConstructCoreView(look.construct) : null;
    this.core =
      this.construct ??
      (hive && this.drones !== null ? new HiveCoreView(this.drones) : null) ??
      new PlayerView();
    this.magma =
      look?.construct === 'magmaCore'
        ? new MagmaLayer(
            textures,
            this.fx,
            this.rings,
            {
              frost: fusionSkin(look, 'ice') !== null,
              poison: fusionSkin(look, 'poison')?.accent ?? DEFAULT_MAGMA_LOOKS.poison,
            },
            random,
          )
        : null;
    this.swarm =
      swarmLook === null ? null : new SwarmLayer(textures, this.fx, this.rings, swarmLook, random);
    this.slashes =
      look === null
        ? null
        : new SlashLayer(textures.streak, fusionSkin(look, 'crit')?.accent ?? MAGMA_COLORS.slash);
    this.bloodTrails = look === null ? null : new SlashLayer(textures.streak, BLOOD_TRAIL_COLOR);
    if (look !== null) this.numbers.setHitColor(hitNumberColor(look));
    // An M1 run has no bullet and no shield: on M1 data neither layer exists.
    const v3 = data.waves.v3 !== undefined;
    this.bullets = v3 ? new BulletLayer(textures) : null;
    this.playerShield = v3 ? new PlayerShield() : null;
    this.shake = new ScreenShake(options.reducedMotion, random);
    this.hitStop = options.hitStop ?? ((): void => undefined);
    // Static: one cached quad instead of grid lines, light pool and vignette every frame.
    const backdrop = look === null ? createBackdrop() : createArenaBackdrop(look.arena);
    backdrop.cacheAsTexture({ resolution: Math.min(2, app.renderer.resolution), antialias: true });
    this.world.addChild(
      backdrop,
      // The floor's scorch marks, fire zones and the bombs' shadows, under the crowd.
      ...(this.magma === null ? [] : this.magma.groundViews),
      // 蜂巢's wakes, dock ring and turret seats, on the floor.
      ...(this.swarm === null ? [] : this.swarm.groundViews),
      this.enemies.burnGlow,
      this.flames.view,
      this.enemies.view,
      this.rings.view,
      this.core.view,
      ...(this.playerShield === null ? [] : [this.playerShield.view]),
      // The drones fly over the core and under the shots (docs/v3 C5 design §13.2).
      ...(this.drones === null ? [] : [this.drones.view]),
      this.projectiles.view,
      ...(this.poolShots === null ? [] : [this.poolShots.view]),
      ...(this.bullets === null ? [] : [this.bullets.view]),
      ...(this.magma === null ? [] : [this.magma.airView]),
      ...(this.slashes === null ? [] : [this.slashes.view]),
      ...(this.bloodTrails === null ? [] : [this.bloodTrails.view]),
      this.arcs.view,
      this.fx.view,
      this.shards.view,
      this.numbers.view,
    );
    app.stage.addChild(this.world, this.letterbox);
    app.renderer.on('resize', this.onResize);
    this.fit();
  }

  /** Resets per-run views. `typicalHit` is the damage of a plain hit this run. */
  beginRun(typicalHit: number): void {
    this.enemies.clear();
    this.arcs.clear();
    this.rings.clear();
    this.fx.clear();
    this.flames.clear();
    this.shards.clear();
    this.numbers.clear();
    this.burnTally.clear();
    this.poisonTally.clear();
    this.bleedTally.clear();
    this.core.reset();
    this.drones?.reset();
    this.poolShots?.reset();
    this.bullets?.clear();
    this.playerShield?.reset();
    this.magma?.reset();
    this.swarm?.reset();
    this.slashes?.clear();
    this.bloodTrails?.clear();
    this.segmentLines?.clear();
    this.coreHits.reset();
    this.shake.reset();
    this.critStop.reset();
    this.critShakeCooldownMs = 0;
    this.impactShakes.reset();
    this.killsThisFrame = 0;
    this.pendingNovaCount = 0;
    this.numbers.setTypicalHit(typicalHit);
  }

  /**
   * beginRun, then the animation clocks back at zero and the number slots handed out in the
   * order a new Renderer makes them: from here it draws what a new Renderer would, without the
   * textures a new one makes (a replay's seek and loop, src/app/replay). The M1 page and `?hive`
   * call beginRun alone.
   */
  restart(typicalHit: number): void {
    this.beginRun(typicalHit);
    this.core.rewind();
    this.magma?.rewind();
    this.enemies.rewind();
    this.numbers.rewind();
  }

  /** Turns one tick's events into effects. Call after every sim step. */
  handleEvents(events: readonly SimEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as SimEvent;
      switch (event.type) {
        case 'hit':
          this.onHit(event);
          break;
        case 'burnTick':
          this.burnTally.add(event.targetId, event.amount, event.x, event.y);
          break;
        case 'dotTick':
          (event.ailment === 'poison' ? this.poisonTally : this.bleedTally).add(
            event.targetId,
            event.amount,
            event.x,
            event.y,
          );
          break;
        case 'freeze':
          if (!event.boss) this.onFrozen(event.targetId);
          break;
        case 'shatter':
          this.bursts.shatter(event.x, event.y, event.radius);
          break;
        case 'enemyKilled':
          this.onKill(event);
          break;
        case 'burnSpread':
          if (event.targets > 0) {
            this.bursts.nova(event.x, event.y, event.radius);
            if (this.pendingNovaCount < MAX_PENDING_NOVAS) {
              const at = this.pendingNovaCount++ * 3;
              this.pendingNovas[at] = event.x;
              this.pendingNovas[at + 1] = event.y;
              this.pendingNovas[at + 2] = event.radius;
            }
          }
          break;
        case 'impact':
          if (this.swarm !== null) {
            this.swarm.impact(event.x, event.y, event.radius, CENTER_X, CENTER_Y);
          } else {
            this.rings.impact(event.x, event.y, event.radius);
          }
          break;
        case 'turretFire':
          this.drones?.turretFired(event.droneId, event.targetId);
          if (this.swarm !== null) this.onTurretFire(event);
          break;
        case 'playerHit':
        case 'bulletHit':
        case 'reflectHit':
          if (this.coreHits.flashes(event)) {
            this.core.hit();
            this.kick(this.impactShakes.playerHit());
          }
          break;
        case 'shieldAbsorbed':
          this.coreHits.flashes(event);
          this.playerShield?.absorb();
          break;
        case 'hitBlocked':
          this.bursts.blocked(event.x, event.y, CENTER_X - event.x, CENTER_Y - event.y);
          break;
        case 'wardBroken':
          this.onWardBroken(event.targetId);
          break;
        case 'onionLayer':
          this.onShellBroken(event.enemyId, event.x, event.y);
          break;
        // A character run's events; on the M1 page and `?hive` their layers are null.
        case 'lob':
          this.construct?.attack(Math.atan2(event.y - event.fromY, event.x - event.fromX));
          break;
        case 'explosion':
          this.magma?.explosion(event.x, event.y, event.radius);
          this.kick(this.impactShakes.blast(event.radius));
          break;
        case 'burst':
          if (this.magma !== null) this.onBurst(event);
          break;
        case 'slash':
          this.slashes?.add(event.x1, event.y1, event.x2, event.y2, event.width);
          break;
        case 'pulse':
          if (event.kind === 'zone' && event.hits > 0) this.magma?.zonePulse(event.id);
          break;
        case 'ailmentApplied':
          if (this.magma !== null && event.ailment === 'poison') this.onPoisoned(event.targetId);
          break;
        case 'ailmentSpread':
          if (event.ailment === 'poison') {
            this.magma?.poisonSpread(event.x, event.y, event.radius, event.targets);
          } else if (event.ailment === 'bleed' && event.targets > 0) {
            this.bloodTrail(event.x, event.y, event.radius);
          }
          break;
        case 'waveCleared':
          this.magma?.waveCleared();
          break;
        default:
          break;
      }
    }
    this.magma?.flushTick();
  }

  /**
   * 血河's trail: from the bleeding enemy at (x, y) outward, away from the centre, `radius` long
   * (the spread's copies go only to enemies farther out). The event names no targets.
   */
  private bloodTrail(x: number, y: number, radius: number): void {
    if (this.bloodTrails === null) return;
    const dx = x - CENTER_X;
    const dy = y - CENTER_Y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return;
    this.bloodTrails.add(x, y, x + (dx / d) * radius, y + (dy / d) * radius, BLOOD_TRAIL_WIDTH);
  }

  /** Draws the state, interpolating positions by `alpha` between the last two ticks. */
  render(state: Readonly<SimState>, alpha: number, frameMs: number): void {
    const dt = Math.min(Math.max(0, frameMs), MAX_EFFECT_DT_MS);
    this.critShakeCooldownMs = Math.max(0, this.critShakeCooldownMs - dt);
    this.impactShakes.update(dt);
    this.critStop.update(dt);
    this.shake.update(dt);
    this.world.position.set(
      this.worldX + this.shake.offsetX * this.worldScale,
      this.worldY + this.shake.offsetY * this.worldScale,
    );
    this.aimEmbers(state);
    this.enemies.update(state.enemies, state.tick, alpha, dt, this.bursts);
    if (this.segmentLines === null && state.segments.lines.length > 0) {
      this.segmentLines = this.makeSegmentLines();
    }
    this.segmentLines?.update(state, alpha, dt);
    // After the enemies: the chase brackets and the barrels go by where they were just drawn.
    this.drones?.update(state, alpha, this.enemies, dt);
    this.projectiles.update(state.projectiles, alpha);
    this.poolShots?.update(state.shots, state.shotCount, state.tick, alpha);
    this.bullets?.update(state.bullets, state.bulletCount, alpha);
    this.magma?.update(
      state.shots,
      state.shotCount,
      state.zones,
      state.zoneCount,
      state.tick,
      alpha,
      dt,
    );
    this.swarm?.update(
      state.drones,
      state.droneCount,
      state.player.x,
      state.player.y,
      state.tick,
      alpha,
      dt,
    );
    this.slashes?.update(dt);
    this.bloodTrails?.update(dt);
    this.arcs.update(dt);
    this.rings.update(dt);
    this.flames.update(dt);
    this.fx.update(dt);
    this.fx.drainFollowUps(this.flamePuff);
    this.core.update(state.player, dt);
    this.playerShield?.update(state.player, dt);
    const absorbed = this.shards.update(dt, state.player.x, state.player.y, PLAYER_RADIUS * 1.5);
    if (absorbed > 0) this.core.pulse();
    this.burnTally.update(dt, this.showBurn);
    this.poisonTally.update(dt, this.showPoison);
    this.bleedTally.update(dt, this.showBleed);
    this.numbers.update(dt);
    this.killsThisFrame = 0;
  }

  destroy(): void {
    this.app.renderer.off('resize', this.onResize);
    // The lead's ruling J10: the layers go with the renderer, the one made late too.
    this.segmentLines?.destroy();
    this.segmentLines = null;
  }

  /**
   * The segment-line layer, in the world just under the enemies, over their flames. It draws
   * the links between the drone pool's rows only when this renderer draws the drones (L2).
   */
  private makeSegmentLines(): SegmentLineLayer {
    const layer = new SegmentLineLayer({ pools: this.drones !== null });
    this.world.addChildAt(layer.view, this.world.getChildIndex(this.enemies.view));
    return layer;
  }

  private onHit(event: Extract<SimEvent, { type: 'hit' }>): void {
    const { x, y, crit } = event;
    const chain = event.chainIndex > 0;
    this.enemies.flash(event.targetId, crit ? CRIT_PUNCH : HIT_PUNCH_STRONG);
    // A jump's hit comes from the enemy it jumped from, and a chainBolt's first hit with arc
    // from its event's point (E7), drawn as a first jump's bolt; no other hit carries one.
    if (event.fromX !== null && event.fromY !== null) {
      this.arcs.add(event.fromX, event.fromY, x, y, Math.max(1, event.chainIndex));
      this.bursts.chain(x, y);
    } else if (!crit) {
      this.bursts.hit(x, y, x - CENTER_X, y - CENTER_Y);
    }
    const kind = crit ? 'crit' : chain ? 'chain' : (event.tags & TAG.cold) !== 0 ? 'cold' : 'hit';
    const shown = this.numbers.spawn(kind, event.amount, x, y, event.targetId);
    if (!crit) return;

    const decades = this.numbers.decades(event.amount);
    this.bursts.crit(x, y, decades, shown === 'big');
    if (decades >= SHAKE_MIN_DECADES && this.critShakeCooldownMs <= 0) {
      this.shake.add(
        SHAKE_BASE + SHAKE_PER_DECADE * (decades - SHAKE_MIN_DECADES),
        CRIT_SHAKE_CEILING,
      );
      this.critShakeCooldownMs = CRIT_SHAKE_COOLDOWN_MS;
    }
    const stopMs = this.critStop.crit(decades);
    if (stopMs > 0) this.hitStop(stopMs);
  }

  private onKill(event: Extract<SimEvent, { type: 'enemyKilled' }>): void {
    this.burnTally.flush(event.enemyId, this.showBurn);
    this.poisonTally.flush(event.enemyId, this.showPoison);
    this.bleedTally.flush(event.enemyId, this.showBleed);
    const def = this.data.enemies[event.enemy];
    const tier = killTier(def);
    this.killsThisFrame++;
    this.kick(this.impactShakes.kills(this.killsThisFrame));
    const crowd = 1 / (1 + Math.max(0, this.killsThisFrame - 1) / CROWD_KILLS);
    this.bursts.kill(event.x, event.y, def.color, def.radius, tier, crowd);
    const count = Math.max(3, Math.round(def.radius / 3.5));
    this.shards.burst(event.x, event.y, def.color, count, 0.8 + def.radius / 80);
    if (tier === TIER_BOSS) {
      this.shake.add(BOSS_SHAKE);
      this.hitStop(BOSS_HIT_STOP_MS);
    } else if (tier === TIER_ELITE) {
      this.shake.add(ELITE_SHAKE, ELITE_SHAKE_CEILING);
      this.hitStop(ELITE_HIT_STOP_MS);
    }
  }

  /** Adds an impact shake (src/render/impact.ts), if its cooldown let one through. */
  private kick(kick: ShakeKick | null): void {
    if (kick !== null) this.shake.add(kick.amount, kick.ceiling);
  }

  /**
   * An explode or nova effect on 熔核's run: a nova at the player is 火環's (the threshold's ring
   * of fire, gd §1.2), any other nova a fire nova where it went off, an explode a small blast.
   */
  private onBurst(event: Extract<SimEvent, { type: 'burst' }>): void {
    const magma = this.magma;
    if (magma === null) return;
    if (event.kind === 'explode') {
      magma.smallBlast(event.x, event.y, event.radius);
      return;
    }
    if (Math.abs(event.x - CENTER_X) < 1 && Math.abs(event.y - CENTER_Y) < 1) {
      magma.thresholdNova(event.x, event.y, event.radius);
    }
    this.bursts.nova(event.x, event.y, event.radius);
  }

  /** A turret fired: 蜂巢's muzzle flash toward where its target is drawn, if it has a view. */
  private onTurretFire(event: Extract<SimEvent, { type: 'turretFire' }>): void {
    const spot = this.enemies.positionOf(event.targetId);
    if (spot === null) return;
    this.swarm?.muzzle(event.x, event.y, Math.atan2(spot.y - event.y, spot.x - event.x));
  }

  /** An enemy froze: an ice burst where it is drawn. */
  private onFrozen(enemyId: number): void {
    const spot = this.enemies.positionOf(enemyId);
    if (spot !== null) this.bursts.freeze(spot.x, spot.y, spot.radius);
  }

  /** An enemy was poisoned: where it is drawn, for the poisoned-explosion check (瘟爆). */
  private onPoisoned(enemyId: number): void {
    const spot = this.enemies.positionOf(enemyId);
    if (spot !== null) this.magma?.poisoned(spot.x, spot.y);
  }

  /** An elite's ward broke: a white ring pops off where it was drawn, if it has a view. */
  private onWardBroken(enemyId: number): void {
    const spot = this.enemies.positionOf(enemyId);
    if (spot === null) return;
    this.rings.shock(
      spot.x,
      spot.y,
      spot.radius * WARD_BREAK_SCALE,
      COLORS.hitFlash,
      WARD_BREAK_WIDTH,
      WARD_BREAK_MS,
    );
  }

  /**
   * 洋蔥 shed a shell at (x, y): a ring out to its radius, if it has a view. A boss's beat: it
   * takes the oldest shock's place when the pool is full.
   */
  private onShellBroken(enemyId: number, x: number, y: number): void {
    const spot = this.enemies.positionOf(enemyId);
    if (spot === null) return;
    this.rings.shock(x, y, spot.radius, COLORS.hitFlash, SHELL_BREAK_WIDTH, SHELL_BREAK_MS, true);
  }

  /** Sends each pending pandemic nova's embers to enemies inside its radius. */
  private aimEmbers(state: Readonly<SimState>): void {
    for (let n = 0; n < this.pendingNovaCount; n++) {
      const x = this.pendingNovas[n * 3] ?? 0;
      const y = this.pendingNovas[n * 3 + 1] ?? 0;
      const radius = this.pendingNovas[n * 3 + 2] ?? 0;
      const r2 = radius * radius;
      let sent = 0;
      for (let i = 0; i < state.enemies.length && sent < EMBERS_PER_NOVA; i++) {
        const enemy = state.enemies[i];
        if (enemy === undefined || !enemy.alive) continue;
        const dx = enemy.x - x;
        const dy = enemy.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2 || d2 < 1) continue;
        this.bursts.ember(x, y, enemy.x, enemy.y);
        sent++;
      }
    }
    this.pendingNovaCount = 0;
  }

  /** Scales the arena to fit the screen, centered, and covers the margins. */
  private fit(): void {
    const { width, height } = this.app.screen;
    const scale = Math.min(width / ARENA_WIDTH, height / ARENA_HEIGHT);
    this.worldScale = scale;
    this.worldX = (width - ARENA_WIDTH * scale) / 2;
    this.worldY = (height - ARENA_HEIGHT * scale) / 2;
    this.world.scale.set(scale);
    this.world.position.set(this.worldX, this.worldY);
    this.numbers.setSafeArea(
      hudSafeArea(ARENA_WIDTH, ARENA_HEIGHT, width, height, scale, this.worldX, this.worldY),
    );

    const g = this.letterbox;
    g.clear();
    if (this.worldX >= 0.5) {
      g.rect(0, 0, Math.ceil(this.worldX), height);
      g.rect(Math.floor(width - this.worldX), 0, Math.ceil(this.worldX), height);
    }
    if (this.worldY >= 0.5) {
      g.rect(0, 0, width, Math.ceil(this.worldY));
      g.rect(0, Math.floor(height - this.worldY), width, Math.ceil(this.worldY));
    }
    g.fill(COLORS.background);
  }
}
