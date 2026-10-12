/**
 * Enemy views: one pooled view per live enemy id, built once per enemy type. Geometry is drawn
 * in white and colored by tint, so hit flashes and burn flicker only change the tint.
 */

import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { div, toNumber } from '../core/num';
import type { EnemyDef, EnemyId, EnemyShape, GameData } from '../data/types';
import type { EnemyState } from '../sim';
import { COLORS, mixColor } from './palette';

const SIDES: Readonly<Record<EnemyShape, number>> = {
  triangle: 3,
  square: 4,
  pentagon: 5,
  hexagon: 6,
  octagon: 8,
};

const FLASH_MS = 90;
const HP_BAR_HEIGHT = 6;
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

  constructor(readonly def: EnemyDef) {
    const r = def.radius;
    const sides = SIDES[def.shape];
    const hull = new Graphics()
      .regularPoly(0, 0, r * 1.1, sides)
      .stroke({ width: 10, color: 0xffffff, alpha: 0.16 })
      .regularPoly(0, 0, r, sides)
      .fill({ color: 0xffffff, alpha: 0.28 })
      .stroke({ width: Math.max(3, r * 0.14), color: 0xffffff, alpha: 1 });
    this.body.addChild(hull);
    if (def.id === 'boss') {
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

    if (def.id === 'hexagon' || def.id === 'boss') {
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
  private readonly active = new Map<number, EnemyView>();
  private readonly pools = new Map<EnemyId, EnemyView[]>();
  private frame = 0;
  private timeMs = 0;

  constructor(private readonly data: GameData) {}

  /** Starts a white flash on the enemy, if it has a view. */
  flash(enemyId: number): void {
    const view = this.active.get(enemyId);
    if (view) view.flashMs = FLASH_MS;
  }

  /** Releases every view; enemy ids restart with each run. */
  clear(): void {
    for (const view of this.active.values()) this.release(view);
    this.active.clear();
  }

  update(enemies: readonly EnemyState[], alpha: number, dtMs: number): void {
    this.frame++;
    this.timeMs += dtMs;
    const seconds = this.timeMs / 1000;
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
      view.root.position.set(
        enemy.prevX + (enemy.x - enemy.prevX) * alpha,
        enemy.prevY + (enemy.y - enemy.prevY) * alpha,
      );
      // Alternate spin direction by id so crowds do not rotate in lockstep.
      const direction = enemy.id % 2 === 0 ? 1 : -1;
      view.body.rotation = direction * seconds * view.spin + enemy.id;
      if (view.inner) view.inner.rotation = -2 * view.body.rotation;

      let tint = view.def.color;
      if (enemy.burnStacks > 0) {
        const flicker = 0.35 + 0.2 * Math.sin(seconds * 26 + enemy.id * 1.7);
        tint = mixColor(tint, COLORS.burn, flicker);
      }
      if (view.flashMs > 0) tint = mixColor(tint, COLORS.hitFlash, view.flashMs / FLASH_MS);
      view.body.tint = tint;
      view.body.scale.set(1 + 0.12 * (view.flashMs / FLASH_MS));
      if (view.hpFill) view.setHp(toNumber(div(enemy.hp, enemy.maxHp)));
    }
    for (const [id, view] of this.active) {
      if (view.seenFrame !== this.frame) {
        this.release(view);
        this.active.delete(id);
      }
    }
  }

  private acquire(enemy: EnemyState): EnemyView {
    const view = this.pools.get(enemy.type)?.pop() ?? new EnemyView(this.data.enemies[enemy.type]);
    view.flashMs = 0;
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
