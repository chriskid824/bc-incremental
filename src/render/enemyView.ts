/**
 * One enemy's view (docs/v3 C7 design §2.9): its type's hull (src/render/enemyShapes.ts), tinted,
 * under its hp bar, and what its look and its v3 record (EnemyState.v3, §1.7) add around it. The
 * look: 再生者's cross pulses, 衝刺者 and 射手 face the player, 召喚者's triangles orbit it, 寶藏怪
 * glows (brighter once it flees) and 洋蔥 shows one shell per layer it has left. The record, each
 * part made the first time a record asks for it and kept with the pooled view: 盾兵's shield
 * facing the center (defence & SHIELDED), 元素護盾's shell (defence & WARDED, which the sim clears
 * at wardBroken), 守護's ring at the sim's GUARD_RADIUS and the affix symbols above it (affixes,
 * bit i AFFIX_IDS[i]); 衝刺者 is red while CHARGING. A view is scaled by enemy.radius / def.radius
 * (增殖's children), its symbols and ring counter-scaled: the symbols stay legible, the ring is
 * the sim's radius. An M1 enemy (v3 null, an M1 shape) gets none of it and draws as before, part
 * for part. Animation reads the layer's clock and the enemy's id, never a random draw.
 * DOM-free, so the tests reach it; EnemyLayer (src/render/enemies.ts) pools and moves the views.
 */

import { Container, Sprite, Texture } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { AFFIX_GUARDIAN } from '../data/affixes';
import type { EnemyDef } from '../data/types';
import type { EnemyState } from '../sim';
import { CHARGING, FLEEING, SHIELDED, WARDED } from '../sim/systems/enemyRecord';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../sim/types';
import {
  bossRing,
  FACING_SHAPES,
  guardRing,
  HULLS,
  ONION_CORE,
  ONION_SHELLS,
  onionShells,
  shieldArc,
  summonerOrbit,
  SYMBOL_SIZE,
  symbolRow,
  treasureGlow,
  wardShell,
} from './enemyShapes';
import { COLORS } from './palette';

/** Scale punch of a normal hit flash; crits pass a bigger one. */
export const HIT_PUNCH = 0.18;
const HP_BAR_HEIGHT = 6;
/** The hp bar's height above the enemy's top edge (M1's). */
const HP_BAR_LIFT = 16;
/** Radians per second; small enemies spin faster. */
const SPIN_BASE = 0.9;
/** 再生者's 「會脈動」: its cross swells by this share of r, this many times a second. */
export const PULSE_AMPLITUDE = 0.12;
const PULSE_HZ = 1.4;
/** 召喚者's triangles: radians per second round the ring, slow enough to follow by eye. */
const ORBIT_SPIN = 1.6;
/** 寶藏怪's 「閃著金光」: its glow shimmers by this share, this many times a second. */
const GLOW_SHIMMER = 0.25;
const GLOW_SHIMMER_HZ = 3;
/** Its glow while it flees: brighter, the reward about to get away. */
export const GLOW_FLEE_ALPHA = 1.8;
/**
 * The glow's alpha at rest: the brightest shimmer while it flees is then exactly 1, since Pixi
 * clamps a container's alpha at 1, which would flatten the shimmer's top and the flee's
 * brightening. treasureGlow draws its discs brighter to make up for it.
 */
export const GLOW_REST_ALPHA = 1 / (GLOW_FLEE_ALPHA * (1 + GLOW_SHIMMER));
/** The gap between the hp bar and the affix symbols above it, in screen units. */
const SYMBOL_GAP = 5;

const CENTER_X = ARENA_WIDTH / 2;
const CENTER_Y = ARENA_HEIGHT / 2;
const TAU = Math.PI * 2;

export class EnemyView {
  readonly root = new Container();
  readonly body = new Container();
  readonly hull: Graphics;
  /** A polygon boss's counter-rotating ring; null for every other type and for 洋蔥. */
  readonly inner: Graphics | null;
  readonly hpBack: Sprite | null;
  readonly hpFill: Sprite | null;
  readonly spin: number;
  /** Turned toward the player instead of spun (FACING_SHAPES: 衝刺者, 射手). */
  readonly faces: boolean;
  /** 洋蔥's three shells, outermost first; null for any other shape. */
  readonly shells: readonly Graphics[] | null;
  /** 召喚者's orbiting triangles; null for any other shape. */
  readonly orbit: Container | null;
  /** 寶藏怪's glow; null for any other shape. */
  readonly glow: Graphics | null;
  /** The radius it draws at, the enemy's (EnemyState.radius); set by place(). */
  radius: number;
  /** enemy.radius / def.radius: 1 but for 增殖's children. */
  scale = 1;
  seenFrame = 0;
  flashMs = 0;
  punch = HIT_PUNCH;
  /** Fractional flames owed; one is emitted per whole unit. */
  flameDebt = 0;
  private shield: Graphics | null = null;
  private ward: Graphics | null = null;
  private guard: Graphics | null = null;
  private symbols: Container | null = null;
  /** The affix bits `symbols` shows; 0 while there is none. */
  private symbolBits = 0;

  constructor(readonly def: EnemyDef) {
    const r = def.radius;
    this.radius = r;
    this.hull = HULLS[def.shape](r, def.boss);
    this.body.addChild(this.hull);
    // Layered polygon (docs/GDD.md §2.4): an inner ring counter-rotates.
    this.inner = def.boss ? bossRing(def.shape, r) : null;
    if (this.inner !== null) this.body.addChild(this.inner);
    if (def.shape === 'onion') {
      const parts = onionShells(r);
      this.body.addChild(...parts);
      this.shells = parts.slice(0, ONION_SHELLS.length);
    } else {
      this.shells = null;
    }
    this.root.addChild(this.body);
    this.orbit = def.shape === 'ring' ? summonerOrbit(r) : null;
    if (this.orbit !== null) this.root.addChild(this.orbit);
    this.glow = def.shape === 'diamond' ? treasureGlow(r, def.color) : null;
    if (this.glow !== null) this.root.addChildAt(this.glow, 0);
    this.faces = FACING_SHAPES.has(def.shape);

    if (def.tough) {
      const width = r * 1.8;
      this.hpBack = new Sprite(Texture.WHITE);
      this.hpBack.tint = COLORS.hpBack;
      this.hpBack.alpha = 0.7;
      this.hpBack.width = width + 2;
      this.hpBack.height = HP_BAR_HEIGHT + 2;
      this.hpBack.position.set(-width / 2 - 1, -r - HP_BAR_LIFT - 1);
      this.hpFill = new Sprite(Texture.WHITE);
      this.hpFill.tint = COLORS.hpFill;
      this.hpFill.height = HP_BAR_HEIGHT;
      this.hpFill.position.set(-width / 2, -r - HP_BAR_LIFT);
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

  /** Takes `enemy`'s radius: the view's scale, and the counter-scale of its ring and symbols. */
  place(enemy: EnemyState): void {
    this.radius = enemy.radius;
    this.scale = enemy.radius / this.def.radius;
    this.root.scale.set(this.scale);
    this.guard?.scale.set(1 / this.scale);
    // Rebuilt by draw() at the new scale.
    this.setSymbols(0);
  }

  /** The tint before burn and flash: its def's color, or 衝刺者's red while it charges. */
  tintOf(enemy: EnemyState): number {
    const v3 = enemy.v3;
    return v3 !== null && (v3.state & CHARGING) !== 0 ? COLORS.enemyCharge : this.def.color;
  }

  /**
   * The body's turn this frame: toward the center for a facing shape, its front being +x, else
   * its spin, which alternates direction by id so crowds do not rotate in lockstep.
   */
  turn(enemy: EnemyState, seconds: number): number {
    const { x, y } = this.root.position;
    if (this.faces) return Math.atan2(CENTER_Y - y, CENTER_X - x);
    const direction = enemy.id % 2 === 0 ? 1 : -1;
    return direction * seconds * this.spin + enemy.id;
  }

  /**
   * Draws the look and the record's parts at the layer's clock `seconds`, once the root is in
   * place: nothing for an M1 enemy (v3 null) of an M1 shape.
   */
  draw(enemy: EnemyState, seconds: number): void {
    const phase = seconds * TAU;
    if (this.def.shape === 'cross') {
      this.hull.scale.set(1 + PULSE_AMPLITUDE * Math.sin(phase * PULSE_HZ + enemy.id));
    }
    if (this.orbit !== null) this.orbit.rotation = seconds * ORBIT_SPIN + enemy.id;
    const v3 = enemy.v3;
    if (this.glow !== null) {
      const flee = v3 !== null && (v3.state & FLEEING) !== 0 ? GLOW_FLEE_ALPHA : 1;
      const shimmer = 1 + GLOW_SHIMMER * Math.sin(phase * GLOW_SHIMMER_HZ + enemy.id);
      this.glow.alpha = GLOW_REST_ALPHA * flee * shimmer;
    }
    if (v3 === null) return;
    if (this.shells !== null) this.drawShells(v3.layersLeft);

    const shielded = (v3.defence & SHIELDED) !== 0;
    if (shielded && this.shield === null) this.shield = this.add(shieldArc(this.def.radius));
    if (this.shield !== null) {
      this.shield.visible = shielded;
      const { x, y } = this.root.position;
      this.shield.rotation = Math.atan2(CENTER_Y - y, CENTER_X - x);
    }
    const warded = (v3.defence & WARDED) !== 0;
    if (warded && this.ward === null) this.ward = this.add(wardShell(this.def.radius));
    if (this.ward !== null) this.ward.visible = warded;
    const guards = (v3.affixes & AFFIX_GUARDIAN) !== 0;
    if (guards && this.guard === null) {
      this.guard = guardRing();
      this.guard.scale.set(1 / this.scale);
      // Under the body: the area the guardian covers, not a part of it.
      this.root.addChildAt(this.guard, 0);
    }
    if (this.guard !== null) this.guard.visible = guards;
    if (v3.affixes !== this.symbolBits) this.setSymbols(v3.affixes);
  }

  /** Shell k (outermost first) shows while `layersLeft` > 2 − k: the outermost drops first. */
  private drawShells(layersLeft: number): void {
    const shells = this.shells as readonly Graphics[];
    const dropped = shells.length - Math.max(0, Math.min(shells.length, layersLeft));
    shells.forEach((shell, k) => {
      shell.visible = k >= dropped;
    });
    // The backing shrinks to the outermost shell left, to the core once every one is gone.
    this.hull.scale.set(ONION_SHELLS[dropped] ?? ONION_CORE);
  }

  /** The symbols of `bits` above the hp bar, SYMBOL_SIZE on screen whatever the view's scale. */
  private setSymbols(bits: number): void {
    if (this.symbols !== null) {
      this.root.removeChild(this.symbols);
      // Each symbol's GraphicsContext too, or every acquire of an elite leaves its row's behind.
      this.symbols.destroy({ children: true, context: true });
      this.symbols = null;
    }
    this.symbolBits = bits;
    if (bits === 0) return;
    const row = symbolRow(bits);
    const lift = (this.def.radius + HP_BAR_LIFT) * this.scale + SYMBOL_GAP + SYMBOL_SIZE;
    row.scale.set(1 / this.scale);
    row.position.set(0, -lift / this.scale);
    this.symbols = this.add(row);
  }

  private add<T extends Container>(part: T): T {
    this.root.addChild(part);
    return part;
  }
}
