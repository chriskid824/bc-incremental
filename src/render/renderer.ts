/**
 * PixiJS view of a run (docs/ARCHITECTURE.md §3, §10). Reads simulation state and events and
 * never mutates them. The arena (ARENA_WIDTH × ARENA_HEIGHT) is scaled to fit the window with
 * letterboxing; every effect runs on its own timers driven by the frame time, not the sim.
 *
 * Feel (docs/GDD.md §1, §3): kills explode in the enemy's color, crits flare and pop numbers
 * (a few big pops at a time), burning enemies glow and shed flames behind their outlines,
 * pandemic spreads as a fire nova, chains arc as flickering lightning. Shake and hit-stop are
 * budgeted so they punch instead of jitter, and every effect pool is capped so a crowded screen
 * sheds detail instead of frame rate. docs/ARCHITECTURE.md §10 lists the layers and budgets.
 */

import { Container, Graphics } from 'pixi.js';
import type { Application } from 'pixi.js';
import type { Num } from '../core/num';
import type { GameData } from '../data/types';
import { ARENA_HEIGHT, ARENA_WIDTH, PLAYER_RADIUS } from '../sim';
import type { SimEvent, SimState } from '../sim';
import { ArcLayer } from './arcs';
import { createBackdrop } from './backdrop';
import { BurnTally } from './burnTally';
import { Bursts, TIER_BOSS, TIER_ELITE, TIER_NORMAL } from './bursts';
import { HiveCoreView } from './core';
import type { CoreView } from './core';
import { CritStopGate } from './critStop';
import { DamageNumbers } from './damageNumbers';
import { DroneLayer } from './drones';
import { EnemyLayer, HIT_PUNCH } from './enemies';
import { FxParticles } from './fx';
import { createFxTextures } from './fxTextures';
import { hudSafeArea } from './numberLayout';
import { COLORS } from './palette';
import { ShardParticles } from './particles';
import { PlayerView } from './player';
import { PoolShotLayer } from './poolShots';
import { ProjectileLayer } from './projectiles';
import { RingLayer } from './rings';
import { ScreenShake } from './shake';

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

const CENTER_X = ARENA_WIDTH / 2;
const CENTER_Y = ARENA_HEIGHT / 2;

export class Renderer {
  private readonly world = new Container({ label: 'world' });
  private readonly letterbox = new Graphics({ label: 'letterbox' });
  private readonly enemies: EnemyLayer;
  private readonly projectiles: ProjectileLayer;
  private readonly arcs = new ArcLayer();
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
  private readonly shards: ShardParticles;
  private readonly numbers = new DamageNumbers();
  private readonly burnTally = new BurnTally();
  private readonly shake: ScreenShake;
  private readonly hitStop: (ms: number) => void;
  private readonly critStop = new CritStopGate();
  private critShakeCooldownMs = 0;
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
  private readonly flamePuff = (x: number, y: number): void => this.bursts.flamePuff(x, y);

  constructor(
    private readonly app: Application,
    private readonly data: GameData,
    options: RendererOptions,
  ) {
    const textures = createFxTextures();
    this.enemies = new EnemyLayer(data, textures.glow);
    this.projectiles = new ProjectileLayer(textures);
    this.fx = new FxParticles(textures);
    this.flames = new FxParticles(textures);
    this.bursts = new Bursts(this.fx, this.flames, textures, this.rings);
    this.shards = new ShardParticles(app.renderer);
    this.drones =
      options.construct === 'hive' ? new DroneLayer(app.renderer, textures.streak) : null;
    this.poolShots = this.drones === null ? null : new PoolShotLayer(textures);
    this.core = this.drones === null ? new PlayerView() : new HiveCoreView(this.drones);
    this.shake = new ScreenShake(options.reducedMotion);
    this.hitStop = options.hitStop ?? ((): void => undefined);
    // Static: one cached quad instead of grid lines, light pool and vignette every frame.
    const backdrop = createBackdrop();
    backdrop.cacheAsTexture({ resolution: Math.min(2, app.renderer.resolution), antialias: true });
    this.world.addChild(
      backdrop,
      this.enemies.burnGlow,
      this.flames.view,
      this.enemies.view,
      this.rings.view,
      this.core.view,
      // The drones fly over the core and under the shots (docs/v3 C5 design §13.2).
      ...(this.drones === null ? [] : [this.drones.view]),
      this.projectiles.view,
      ...(this.poolShots === null ? [] : [this.poolShots.view]),
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
    this.core.reset();
    this.drones?.reset();
    this.poolShots?.reset();
    this.shake.reset();
    this.critStop.reset();
    this.critShakeCooldownMs = 0;
    this.killsThisFrame = 0;
    this.pendingNovaCount = 0;
    this.numbers.setTypicalHit(typicalHit);
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
          this.rings.impact(event.x, event.y, event.radius);
          break;
        case 'turretFire':
          this.drones?.turretFired(event.droneId, event.targetId);
          break;
        case 'playerHit':
          this.core.hit();
          break;
        default:
          break;
      }
    }
  }

  /** Draws the state, interpolating positions by `alpha` between the last two ticks. */
  render(state: Readonly<SimState>, alpha: number, frameMs: number): void {
    const dt = Math.min(Math.max(0, frameMs), MAX_EFFECT_DT_MS);
    this.critShakeCooldownMs = Math.max(0, this.critShakeCooldownMs - dt);
    this.critStop.update(dt);
    this.shake.update(dt);
    this.world.position.set(
      this.worldX + this.shake.offsetX * this.worldScale,
      this.worldY + this.shake.offsetY * this.worldScale,
    );
    this.aimEmbers(state);
    this.enemies.update(state.enemies, alpha, dt, this.bursts);
    // After the enemies: the chase brackets and the barrels go by where they were just drawn.
    this.drones?.update(state, alpha, this.enemies, dt);
    this.projectiles.update(state.projectiles, alpha);
    this.poolShots?.update(state.shots, state.shotCount, state.tick, alpha);
    this.arcs.update(dt);
    this.rings.update(dt);
    this.flames.update(dt);
    this.fx.update(dt);
    this.fx.drainFollowUps(this.flamePuff);
    this.core.update(state.player, dt);
    const absorbed = this.shards.update(dt, state.player.x, state.player.y, PLAYER_RADIUS * 1.5);
    if (absorbed > 0) this.core.pulse();
    this.burnTally.update(dt, this.showBurn);
    this.numbers.update(dt);
    this.killsThisFrame = 0;
  }

  destroy(): void {
    this.app.renderer.off('resize', this.onResize);
  }

  private onHit(event: Extract<SimEvent, { type: 'hit' }>): void {
    const { x, y, crit } = event;
    const chain = event.chainIndex > 0;
    this.enemies.flash(event.targetId, crit ? HIT_PUNCH * 1.8 : HIT_PUNCH);
    if (chain && event.fromX !== null && event.fromY !== null) {
      this.arcs.add(event.fromX, event.fromY, x, y, event.chainIndex);
      this.bursts.chain(x, y);
    } else if (!crit) {
      this.bursts.hit(x, y, x - CENTER_X, y - CENTER_Y);
    }
    const kind = crit ? 'crit' : chain ? 'chain' : 'hit';
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
    const def = this.data.enemies[event.enemy];
    const tier = def.boss ? TIER_BOSS : def.tough ? TIER_ELITE : TIER_NORMAL;
    this.killsThisFrame++;
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
