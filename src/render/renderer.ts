/**
 * PixiJS view of a run (docs/ARCHITECTURE.md §3, §10). Reads simulation state and events and
 * never mutates them. The arena (ARENA_WIDTH × ARENA_HEIGHT) is scaled to fit the window with
 * letterboxing; every effect runs on its own timers driven by the frame time, not the sim.
 */

import { Container, Graphics } from 'pixi.js';
import type { Application } from 'pixi.js';
import type { GameData } from '../data/types';
import { ARENA_HEIGHT, ARENA_WIDTH, PLAYER_RADIUS } from '../sim';
import type { SimEvent, SimState } from '../sim';
import { ArcLayer } from './arcs';
import { createBackdrop } from './backdrop';
import { DamageNumbers } from './damageNumbers';
import { EnemyLayer } from './enemies';
import { COLORS } from './palette';
import { ShardParticles } from './particles';
import { PlayerView } from './player';
import { ProjectileLayer } from './projectiles';
import { ScreenShake } from './shake';

export interface RendererOptions {
  /** Disables screen shake (settings toggle later, docs/ARCHITECTURE.md §10). */
  readonly reducedMotion: boolean;
}

/** Crits at least this many decades above the typical hit shake the screen (2× ≈ 0.3). */
const SHAKE_MIN_DECADES = Math.log10(2);
const SHAKE_BASE = 0.16;
const SHAKE_PER_DECADE = 0.14;
const SHAKE_MAX = 0.4;
/** Frame time cap for effects, so a long pause does not fast-forward them in one jump. */
const MAX_EFFECT_DT_MS = 100;

export class Renderer {
  private readonly world = new Container({ label: 'world' });
  private readonly letterbox = new Graphics({ label: 'letterbox' });
  private readonly enemies: EnemyLayer;
  private readonly projectiles = new ProjectileLayer();
  private readonly arcs = new ArcLayer();
  private readonly player = new PlayerView();
  private readonly shards: ShardParticles;
  private readonly numbers = new DamageNumbers();
  private readonly shake: ScreenShake;
  private worldScale = 1;
  private worldX = 0;
  private worldY = 0;
  private readonly onResize = (): void => this.fit();

  constructor(
    private readonly app: Application,
    private readonly data: GameData,
    options: RendererOptions,
  ) {
    this.enemies = new EnemyLayer(data);
    this.shards = new ShardParticles(app.renderer);
    this.shake = new ScreenShake(options.reducedMotion);
    this.world.addChild(
      createBackdrop(),
      this.enemies.view,
      this.projectiles.view,
      this.arcs.view,
      this.player.view,
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
    this.shards.clear();
    this.numbers.clear();
    this.player.reset();
    this.shake.reset();
    this.numbers.setTypicalHit(typicalHit);
  }

  /** Turns one tick's events into effects. Call after every sim step. */
  handleEvents(events: readonly SimEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as SimEvent;
      switch (event.type) {
        case 'hit': {
          this.enemies.flash(event.targetId);
          const chain = event.chainIndex > 0;
          if (chain && event.fromX !== null && event.fromY !== null) {
            this.arcs.add(event.fromX, event.fromY, event.x, event.y);
          }
          const kind = event.crit ? 'crit' : chain ? 'chain' : 'hit';
          this.numbers.spawn(kind, event.amount, event.x, event.y);
          if (event.crit) {
            const decades = this.numbers.decades(event.amount);
            if (decades >= SHAKE_MIN_DECADES) {
              const trauma = SHAKE_BASE + SHAKE_PER_DECADE * (decades - SHAKE_MIN_DECADES);
              this.shake.add(Math.min(SHAKE_MAX, trauma));
            }
          }
          break;
        }
        case 'burnTick':
          this.numbers.spawn('burn', event.amount, event.x, event.y);
          break;
        case 'enemyKilled': {
          const def = this.data.enemies[event.enemy];
          const count = Math.max(3, Math.round(def.radius / 3.5));
          this.shards.burst(event.x, event.y, def.color, count, 0.8 + def.radius / 80);
          break;
        }
        case 'playerHit':
          this.player.hit();
          break;
        default:
          break;
      }
    }
  }

  /** Draws the state, interpolating positions by `alpha` between the last two ticks. */
  render(state: Readonly<SimState>, alpha: number, frameMs: number): void {
    const dt = Math.min(Math.max(0, frameMs), MAX_EFFECT_DT_MS);
    this.shake.update(dt);
    this.world.position.set(
      this.worldX + this.shake.offsetX * this.worldScale,
      this.worldY + this.shake.offsetY * this.worldScale,
    );
    this.enemies.update(state.enemies, alpha, dt);
    this.projectiles.update(state.projectiles, alpha);
    this.arcs.update(dt);
    this.player.update(state.player, dt);
    const absorbed = this.shards.update(dt, state.player.x, state.player.y, PLAYER_RADIUS * 1.5);
    if (absorbed > 0) this.player.pulse();
    this.numbers.update(dt);
  }

  destroy(): void {
    this.app.renderer.off('resize', this.onResize);
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
