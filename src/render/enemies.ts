/**
 * Enemy views: one pooled view per live enemy id, built once per enemy type. Geometry is drawn
 * in white and colored by tint, so hit flashes and burn flicker only change the tint; a dark
 * backing under the fill keeps each shape a readable silhouette over bright effects.
 * Burning enemies (docs/GDD.md §3.3) also get a flickering fire glow on a shared additive
 * particle layer under the crowd, and shed flames that rise and cool, also drawn under the
 * crowd so the enemy's own outline and color stay on top; both grow with the stack count up to
 * a low cap. Flame emission shares one budget per second across all burning enemies.
 */

import { Container, Graphics, Particle, ParticleContainer, Sprite, Texture } from 'pixi.js';
import { div, toNumber } from '../core/num';
import type { EnemyDef, EnemyId, EnemyShape, GameData } from '../data/types';
import type { EnemyState } from '../sim';
import type { Bursts } from './bursts';
import type { EnemySpot } from './drones';
import { packColor } from './fx';
import { COLORS, mixColor } from './palette';
import { defaultRandom } from './random';
import type { RenderRandom } from './random';

/** Polygon sides per shape; the v3 shapes' are placeholders until their own drawings. */
const SIDES: Readonly<Record<EnemyShape, number>> = {
  triangle: 3,
  square: 4,
  pentagon: 5,
  hexagon: 6,
  octagon: 8,
  circle: 24,
  cross: 4,
  rhombus: 4,
  trapezoid: 4,
  ring: 24,
  diamond: 4,
  onion: 8,
};

const FLASH_MS = 100;
/** Scale punch of a normal hit flash; crits pass a bigger one. */
export const HIT_PUNCH = 0.18;
const HP_BAR_HEIGHT = 6;
/** Burn visuals stop growing at this many stacks (eternalFlame has no stack cap). */
const BURN_VISUAL_STACKS = 4;
/** Flames per second from one burning enemy, at 1 stack and per extra stack. */
const FLAME_RATE = 11;
const FLAME_RATE_PER_STACK = 3;
/** Flames per second across all burning enemies; above it each enemy emits proportionally less. */
const FLAME_BUDGET = 650;
/** How far a burning enemy's tint leans toward the fire color: base, at full heat, flicker. */
const BURN_TINT = 0.06;
const BURN_TINT_HEAT = 0.08;
const BURN_TINT_FLICKER = 0.06;
/** Glow texture diameter in pixels (src/render/fxTextures.ts). */
const GLOW_SIZE = 64;
/** Radians per second; small enemies spin faster. */
const SPIN_BASE = 0.9;

class EnemyView {
  readonly root = new Container();
  readonly body = new Container();
  readonly inner: Graphics | null;
  readonly hpBack: Sprite | null;
  readonly hpFill: Sprite | null;
  readonly spin: number;
  seenFrame = 0;
  flashMs = 0;
  punch = HIT_PUNCH;
  /** Fractional flames owed; one is emitted per whole unit. */
  flameDebt = 0;

  constructor(readonly def: EnemyDef) {
    const r = def.radius;
    const sides = SIDES[def.shape];
    const hull = new Graphics()
      // Tinting leaves black black: a dark backing that keeps the shape solid over fire.
      .regularPoly(0, 0, r, sides)
      .fill({ color: 0x000000, alpha: 0.6 })
      .regularPoly(0, 0, r * 1.1, sides)
      .stroke({ width: 10, color: 0xffffff, alpha: 0.16 })
      .regularPoly(0, 0, r, sides)
      .fill({ color: 0xffffff, alpha: 0.28 })
      .stroke({ width: Math.max(3, r * 0.14), color: 0xffffff, alpha: 1 });
    this.body.addChild(hull);
    if (def.boss) {
      // Layered polygon (docs/GDD.md §2.4): an inner ring counter-rotates.
      this.inner = new Graphics()
        .regularPoly(0, 0, r * 0.6, sides, Math.PI / sides)
        .fill({ color: 0xffffff, alpha: 0.25 })
        .stroke({ width: 4, color: 0xffffff, alpha: 0.9 })
        .regularPoly(0, 0, r * 0.25, sides)
        .fill({ color: 0xffffff, alpha: 0.85 });
      this.body.addChild(this.inner);
    } else {
      this.inner = null;
      hull.regularPoly(0, 0, r * 0.38, sides).fill({ color: 0xffffff, alpha: 0.6 });
    }
    this.root.addChild(this.body);

    if (def.tough) {
      const width = r * 1.8;
      this.hpBack = new Sprite(Texture.WHITE);
      this.hpBack.tint = COLORS.hpBack;
      this.hpBack.alpha = 0.7;
      this.hpBack.width = width + 2;
      this.hpBack.height = HP_BAR_HEIGHT + 2;
      this.hpBack.position.set(-width / 2 - 1, -r - 16 - 1);
      this.hpFill = new Sprite(Texture.WHITE);
      this.hpFill.tint = COLORS.hpFill;
      this.hpFill.height = HP_BAR_HEIGHT;
      this.hpFill.position.set(-width / 2, -r - 16);
      this.root.addChild(this.hpBack, this.hpFill);
    } else {
      this.hpBack = null;
      this.hpFill = null;
    }
    this.spin = SPIN_BASE * (16 / Math.max(r, 8));
  }

  setHp(ratio: number): void {
    if (this.hpFill === null) return;
    const width = this.def.radius * 1.8;
    this.hpFill.width = width * Math.min(1, Math.max(0, ratio));
  }
}

export class EnemyLayer {
  readonly view = new Container({ label: 'enemies' });
  /** Fire glows of burning enemies; add it under `view`. */
  readonly burnGlow: ParticleContainer;
  private readonly glows: Particle[] = [];
  private readonly active = new Map<number, EnemyView>();
  private readonly pools = new Map<EnemyId, EnemyView[]>();
  private frame = 0;
  private timeMs = 0;
  /** Flames per second all burning enemies asked for last frame. */
  private flameDemand = 0;
  /** Map visitor for update(): frees views of enemies gone this frame, without allocating. */
  private readonly releaseUnseen = (view: EnemyView, id: number): void => {
    if (view.seenFrame === this.frame) return;
    this.release(view);
    this.active.delete(id);
  };

  constructor(
    private readonly data: GameData,
    private readonly glowTexture: Texture,
    private readonly random: RenderRandom = defaultRandom,
  ) {
    this.burnGlow = new ParticleContainer({
      label: 'burn-glow',
      texture: glowTexture,
      dynamicProperties: { position: true, color: true, vertex: true },
    });
    this.burnGlow.blendMode = 'add';
  }

  /** Starts a white flash on the enemy, if it has a view; `punch` is the scale bump. */
  flash(enemyId: number, punch = HIT_PUNCH): void {
    const view = this.active.get(enemyId);
    if (view === undefined) return;
    // Overlapping flashes keep the bigger punch.
    view.punch = view.flashMs > 0 ? Math.max(punch, view.punch) : punch;
    view.flashMs = FLASH_MS;
  }

  /**
   * Where enemy `id` was drawn by the last update and its radius, or null when it has no view
   * (gone, or not drawn yet). Read-only: the drone layer places its chase brackets with it.
   */
  positionOf(id: number): EnemySpot | null {
    const view = this.active.get(id);
    if (view === undefined) return null;
    return { x: view.root.position.x, y: view.root.position.y, radius: view.def.radius };
  }

  /** Releases every view; enemy ids restart with each run. */
  clear(): void {
    for (const view of this.active.values()) this.release(view);
    this.active.clear();
    this.burnGlow.particleChildren.length = 0;
    this.burnGlow.update();
    this.flameDemand = 0;
  }

  /** The spin and flicker clock and the frame count back at zero, as a new layer has them. */
  rewind(): void {
    this.frame = 0;
    this.timeMs = 0;
  }

  /** Positions and tints every live enemy; burning ones glow and shed flames via `bursts`. */
  update(enemies: readonly EnemyState[], alpha: number, dtMs: number, bursts: Bursts): void {
    this.frame++;
    this.timeMs += dtMs;
    const seconds = this.timeMs / 1000;
    const dt = dtMs / 1000;
    const flameShare = this.flameDemand > FLAME_BUDGET ? FLAME_BUDGET / this.flameDemand : 1;
    let demand = 0;
    let glowCount = 0;
    const glowChildren = this.burnGlow.particleChildren;
    const previousGlows = glowChildren.length;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i] as EnemyState;
      if (!enemy.alive) continue;
      let view = this.active.get(enemy.id);
      if (view === undefined) {
        view = this.acquire(enemy);
        this.active.set(enemy.id, view);
      }
      view.seenFrame = this.frame;
      view.flashMs = Math.max(0, view.flashMs - dtMs);
      const x = enemy.prevX + (enemy.x - enemy.prevX) * alpha;
      const y = enemy.prevY + (enemy.y - enemy.prevY) * alpha;
      view.root.position.set(x, y);
      // Alternate spin direction by id so crowds do not rotate in lockstep.
      const direction = enemy.id % 2 === 0 ? 1 : -1;
      view.body.rotation = direction * seconds * view.spin + enemy.id;
      if (view.inner) view.inner.rotation = -2 * view.body.rotation;

      let tint = view.def.color;
      if (enemy.burnStacks > 0) {
        const heat = Math.min(enemy.burnStacks, BURN_VISUAL_STACKS) / BURN_VISUAL_STACKS;
        const flicker = 0.5 + 0.5 * Math.sin(seconds * 23 + enemy.id * 1.7);
        const flutter = 0.5 + 0.5 * Math.sin(seconds * 37 + enemy.id * 0.9);
        // A warm cast only: the enemy keeps its own color and outline over its fire.
        tint = mixColor(
          tint,
          COLORS.burn,
          BURN_TINT + BURN_TINT_HEAT * heat + BURN_TINT_FLICKER * flicker,
        );

        let glow = this.glows[glowCount];
        if (glow === undefined) {
          glow = new Particle({ texture: this.glowTexture, anchorX: 0.5, anchorY: 0.5 });
          this.glows.push(glow);
        }
        const size = (view.def.radius * (3.4 + 1.6 * heat) * (0.9 + 0.15 * flutter)) / GLOW_SIZE;
        glow.x = x;
        glow.y = y - view.def.radius * 0.35;
        glow.scaleX = size;
        glow.scaleY = size * 1.2;
        // Deep orange, never the hot yellow: the glow texture's core already peaks at full.
        glow.color = packColor(
          mixColor(COLORS.burnDeep, COLORS.burn, 0.45 + 0.35 * flicker),
          (0.32 + 0.2 * heat) * (0.8 + 0.2 * flicker),
        );
        glowChildren[glowCount++] = glow;

        const rate =
          FLAME_RATE + FLAME_RATE_PER_STACK * (Math.min(enemy.burnStacks, BURN_VISUAL_STACKS) - 1);
        demand += rate;
        view.flameDebt += rate * flameShare * dt;
        while (view.flameDebt >= 1) {
          view.flameDebt -= 1;
          bursts.flame(x, y, view.def.radius, heat);
        }
      } else {
        view.flameDebt = 0;
      }
      const flash = view.flashMs / FLASH_MS;
      if (flash > 0) tint = mixColor(tint, COLORS.hitFlash, flash);
      view.body.tint = tint;
      view.body.scale.set(1 + view.punch * flash);
      if (view.hpFill) view.setHp(toNumber(div(enemy.hp, enemy.maxHp)));
    }
    this.flameDemand = demand;
    glowChildren.length = glowCount;
    if (glowCount !== previousGlows) this.burnGlow.update();
    this.active.forEach(this.releaseUnseen);
  }

  private acquire(enemy: EnemyState): EnemyView {
    const view = this.pools.get(enemy.type)?.pop() ?? new EnemyView(this.data.enemies[enemy.type]);
    view.flashMs = 0;
    view.punch = HIT_PUNCH;
    view.flameDebt = this.random();
    view.setHp(1);
    // Bosses and elites draw under the crowd so small enemies stay visible.
    if (view.def.radius >= 30) this.view.addChildAt(view.root, 0);
    else this.view.addChild(view.root);
    return view;
  }

  private release(view: EnemyView): void {
    this.view.removeChild(view.root);
    let pool = this.pools.get(view.def.id);
    if (pool === undefined) {
      pool = [];
      this.pools.set(view.def.id, pool);
    }
    pool.push(view);
  }
}
