/**
 * Floating damage numbers (docs/ARCHITECTURE.md §10): pooled BitmapText on dynamically
 * installed fonts, sized by log10 of the amount relative to the run's typical hit, with a low
 * ceiling (src/render/numberLayout.ts) so a big crit never covers the crowd.
 * Crits pop on a bold glowing font on their own top layer, but only a few at a time; past that
 * budget a crit shows as a normal-size number in the crit color. Hit, chain, burn and small crit
 * numbers share a second pool with a cap per style. Numbers for the same enemy and kind within
 * a short window merge into one growing number; a new number steps aside from those already on
 * screen or is dropped, and none floats under the DOM HUD. Busy pools shorten new lifetimes.
 */

import { BitmapFont, BitmapText, Container } from 'pixi.js';
import { formatNum } from '../core/format';
import { add, log10, ZERO } from '../core/num';
import type { Num } from '../core/num';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../sim';
import {
  findSpot,
  halfHeight,
  halfWidth,
  lifeUnderLoad,
  numberSize,
  RISE_PER_MS,
} from './numberLayout';
import type { NumberStyle, Point, SafeArea } from './numberLayout';
import { COLORS, mixColor } from './palette';
import { defaultRandom } from './random';
import type { RenderRandom } from './random';
import { ageStep } from './timing';

export type DamageKind = 'hit' | 'crit' | 'burn' | 'chain';

/**
 * What spawn() did: dropped to stay under the caps, shown as a normal number (small crits
 * included), shown as a big crit pop, or merged into a number already shown for that enemy.
 */
export type SpawnResult = 'dropped' | 'shown' | 'big' | 'merged';

const FONT_NAME = 'bc-damage';
const CRIT_FONT_NAME = 'bc-damage-crit';
const FONT_SIZE = 48;
const CHARS = '0123456789.,-+eKMBTNa∞ ';
const FORMAT = { format: 'short' } as const;

/** Numbers on screen at once in the shared pool, and big crit pops at once. */
const MAX_NUMBERS = 80;
const MAX_BIG_CRITS = 6;
/** Live numbers allowed per style in the shared pool. */
const STYLE_CAP: Readonly<Record<Exclude<NumberStyle, 'crit'>, number>> = {
  hit: 40,
  chain: 30,
  burn: 30,
  critSmall: 18,
};

/** A number for the same enemy and kind younger than this absorbs the new amount. */
const MERGE_MS = 220;
/** Scale bump when a number absorbs another, fading over BUMP_MS. */
const BUMP = 0.22;
const BUMP_MS = 100;

interface Look {
  readonly color: number;
  readonly lifeMs: number;
  readonly pop: number;
}

const LOOKS: Readonly<Record<NumberStyle, Look>> = {
  hit: { color: COLORS.damageHit, lifeMs: 650, pop: 0.3 },
  chain: { color: COLORS.damageChain, lifeMs: 650, pop: 0.3 },
  burn: { color: COLORS.damageBurn, lifeMs: 600, pop: 0.2 },
  crit: { color: COLORS.damageCrit, lifeMs: 760, pop: 0 },
  critSmall: { color: COLORS.damageCrit, lifeMs: 560, pop: 0.4 },
};
/** Past this fraction of its life a number is fading and no longer keeps new ones away. */
const SOLID_UNTIL = 0.8;

const MIN_DECADES = -1;
const MAX_DECADES = 4;
const POP_MS = 110;
/** Crit pop: grows to CRIT_OVERSHOOT by CRIT_GROW_MS, settles to 1 by CRIT_SETTLE_MS. */
const CRIT_START = 0.6;
const CRIT_OVERSHOOT = 1.12;
const CRIT_GROW_MS = 70;
const CRIT_SETTLE_MS = 210;
/** Random spread of a new number around the hit, in arena units. */
const JITTER_X = 10;
const JITTER_Y = 6;

interface FloatingNumber {
  readonly text: BitmapText;
  style: NumberStyle;
  kind: DamageKind;
  /** Enemy the number belongs to, -1 when unknown. */
  targetId: number;
  amount: Num;
  ageMs: number;
  lifeMs: number;
  /** Where it spawned. */
  baseX: number;
  baseY: number;
  /** Center now, and settled half extents, for spacing new numbers (numberLayout.NumberBox). */
  x: number;
  y: number;
  halfW: number;
  halfH: number;
  solid: boolean;
  scale: number;
  pop: number;
  bumpMs: number;
  /** Spawned since the last update (see src/render/timing.ts). */
  fresh: boolean;
}

let fontsInstalled = false;

function installFonts(): void {
  if (fontsInstalled) return;
  const fontFamily = ['Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'];
  BitmapFont.install({
    name: FONT_NAME,
    style: {
      fontFamily,
      fontSize: FONT_SIZE,
      fontWeight: '800',
      fill: 0xffffff,
      stroke: { color: 0x05060a, width: 6, join: 'round' },
    },
    chars: CHARS,
    resolution: 2,
    padding: 6,
  });
  // White glow around a dark outline; the tint colors fill and glow alike.
  BitmapFont.install({
    name: CRIT_FONT_NAME,
    style: {
      fontFamily,
      fontSize: FONT_SIZE,
      fontWeight: '900',
      fill: 0xffffff,
      stroke: { color: 0x1a0d00, width: 8, join: 'round' },
      dropShadow: { color: 0xffffff, alpha: 0.85, blur: 12, distance: 0, angle: 0 },
    },
    chars: CHARS,
    resolution: 2,
    padding: 18,
  });
  fontsInstalled = true;
}

/** A pool of numbers on one font and layer; spawns past `max` are refused. */
class NumberPool {
  readonly layer = new Container();
  readonly live: FloatingNumber[] = [];
  private readonly free: FloatingNumber[] = [];
  /** Every slot made, in the order made: the layer's order, bottom first. */
  private readonly slots: FloatingNumber[] = [];
  private created = 0;

  constructor(
    private readonly font: string,
    readonly max: number,
  ) {}

  get full(): boolean {
    return this.live.length >= this.max;
  }

  /** A free slot, or null when `max` numbers are live. */
  acquire(): FloatingNumber | null {
    let slot = this.free.pop();
    if (slot === undefined) {
      if (this.created >= this.max) return null;
      slot = this.create();
    }
    slot.text.visible = true;
    this.live.push(slot);
    return slot;
  }

  /** The live number of `kind` for `targetId` still young enough to merge into, if any. */
  findMergeable(kind: DamageKind, targetId: number): FloatingNumber | null {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const slot = this.live[i] as FloatingNumber;
      if (slot.targetId === targetId && slot.kind === kind && slot.ageMs < MERGE_MS) return slot;
    }
    return null;
  }

  /** Ages live numbers; returns expired ones to the pool and reports them to `onExpire`. */
  update(dtMs: number, onExpire: (style: NumberStyle) => void): void {
    let kept = 0;
    for (let i = 0; i < this.live.length; i++) {
      const slot = this.live[i] as FloatingNumber;
      slot.ageMs += ageStep(dtMs, slot.fresh);
      slot.bumpMs = Math.max(0, slot.bumpMs - dtMs);
      slot.fresh = false;
      if (slot.ageMs >= slot.lifeMs) {
        slot.text.visible = false;
        this.free.push(slot);
        onExpire(slot.style);
        continue;
      }
      this.live[kept++] = slot;
    }
    this.live.length = kept;
  }

  clear(): void {
    for (const slot of this.live) {
      slot.text.visible = false;
      this.free.push(slot);
    }
    this.live.length = 0;
  }

  /**
   * clear(), then every slot handed out first-made first, as a new pool makes them: the numbers
   * that follow stack as they would on a new pool (Renderer.restart).
   */
  rewind(): void {
    this.clear();
    // acquire() pops: the first-made slot goes in last.
    this.free.length = 0;
    for (let i = this.slots.length - 1; i >= 0; i--) {
      this.free.push(this.slots[i] as FloatingNumber);
    }
  }

  private create(): FloatingNumber {
    this.created++;
    const text = new BitmapText({
      text: '',
      style: { fontFamily: this.font, fontSize: FONT_SIZE },
      anchor: 0.5,
    });
    this.layer.addChild(text);
    const slot: FloatingNumber = {
      text,
      style: 'hit',
      kind: 'hit',
      targetId: -1,
      amount: ZERO,
      ageMs: 0,
      lifeMs: 1,
      baseX: 0,
      baseY: 0,
      x: 0,
      y: 0,
      halfW: 0,
      halfH: 0,
      solid: true,
      scale: 1,
      pop: 0,
      bumpMs: 0,
      fresh: true,
    };
    this.slots.push(slot);
    return slot;
  }
}

export class DamageNumbers {
  readonly view = new Container({ label: 'damage-numbers' });
  private readonly normal = new NumberPool(FONT_NAME, MAX_NUMBERS);
  private readonly crits = new NumberPool(CRIT_FONT_NAME, MAX_BIG_CRITS);
  /** Both pools, for spacing new numbers against everything on screen. */
  private readonly onScreen: readonly FloatingNumber[][] = [this.crits.live, this.normal.live];
  private readonly counts: Record<NumberStyle, number> = {
    hit: 0,
    crit: 0,
    burn: 0,
    chain: 0,
    critSmall: 0,
  };
  private readonly onExpire = (style: NumberStyle): void => {
    this.counts[style]--;
  };
  private readonly spot: Point = { x: 0, y: 0 };
  private area: SafeArea = { width: ARENA_WIDTH, height: ARENA_HEIGHT, zones: [] };
  private typicalHit = 1;

  constructor(private readonly random: RenderRandom = defaultRandom) {
    installFonts();
    // Crits draw above everything else.
    this.view.addChild(this.normal.layer, this.crits.layer);
  }

  /** Reference amount for sizing; numbers at this amount get the base size. */
  setTypicalHit(amount: number): void {
    this.typicalHit = amount > 0 && Number.isFinite(amount) ? amount : 1;
  }

  /** Where numbers may float: the arena minus the HUD (numberLayout.hudSafeArea). */
  setSafeArea(area: SafeArea): void {
    this.area = area;
  }

  /** log10(amount / typical hit), clamped to the sizing range. */
  decades(amount: Num): number {
    const d = log10(amount) - Math.log10(this.typicalHit);
    if (!Number.isFinite(d)) return MIN_DECADES;
    return Math.min(MAX_DECADES, Math.max(MIN_DECADES, d));
  }

  /**
   * Shows `amount` dealt to enemy `targetId` (-1 when unknown) at (x, y), merges it into a young
   * number of the same kind for that enemy, or drops it to keep the screen readable.
   */
  spawn(kind: DamageKind, amount: Num, x: number, y: number, targetId = -1): SpawnResult {
    if (targetId >= 0 && this.merge(kind, amount, targetId)) return 'merged';

    let style: NumberStyle = kind;
    let pool = this.normal;
    if (kind === 'crit') {
      if (this.crits.full) style = 'critSmall';
      else pool = this.crits;
    }
    if (pool === this.normal && (pool.full || this.counts[style] >= capOf(style))) {
      return 'dropped';
    }

    const look = LOOKS[style];
    const label = formatNum(amount, FORMAT);
    const size = numberSize(style, this.decades(amount));
    const halfW = halfWidth(label.length, size);
    const halfH = halfHeight(size);
    const lifeMs = lifeUnderLoad(look.lifeMs, pool.live.length, pool.max);
    const rise = RISE_PER_MS * lifeMs;
    const jx = x + (this.random() * 2 - 1) * JITTER_X;
    const jy = y - 10 + (this.random() * 2 - 1) * JITTER_Y;
    // A number that would cover another one is left out, crits included (their flare stays).
    if (!findSpot(this.spot, this.area, this.onScreen, jx, jy, halfW, halfH, rise)) {
      return 'dropped';
    }

    const slot = pool.acquire();
    if (slot === null) return 'dropped';
    this.counts[style]++;

    const text = slot.text;
    text.text = label;
    text.tint = tintOf(style, this.decades(amount));
    text.alpha = 1;
    text.rotation = style === 'crit' ? (this.random() * 2 - 1) * 0.06 : 0;
    slot.style = style;
    slot.kind = kind;
    slot.targetId = targetId;
    slot.amount = amount;
    slot.ageMs = 0;
    slot.fresh = true;
    slot.lifeMs = lifeMs;
    slot.baseX = this.spot.x;
    slot.baseY = this.spot.y;
    slot.x = this.spot.x;
    slot.y = this.spot.y;
    slot.halfW = halfW;
    slot.halfH = halfH;
    slot.solid = true;
    slot.pop = look.pop;
    slot.bumpMs = 0;
    slot.scale = size / FONT_SIZE;
    place(slot);
    return style === 'crit' ? 'big' : 'shown';
  }

  clear(): void {
    this.normal.clear();
    this.crits.clear();
    for (const style of Object.keys(this.counts) as NumberStyle[]) this.counts[style] = 0;
  }

  /** clear(), with both pools' slots handed out as a new DamageNumbers makes them. */
  rewind(): void {
    this.clear();
    this.normal.rewind();
    this.crits.rewind();
  }

  update(dtMs: number): void {
    this.normal.update(dtMs, this.onExpire);
    this.crits.update(dtMs, this.onExpire);
    for (const slot of this.normal.live) place(slot);
    for (const slot of this.crits.live) place(slot);
  }

  /** Adds `amount` to a young number of `kind` for `targetId`; false when there is none. */
  private merge(kind: DamageKind, amount: Num, targetId: number): boolean {
    const slot =
      (kind === 'crit' ? this.crits.findMergeable(kind, targetId) : null) ??
      this.normal.findMergeable(kind, targetId);
    if (slot === null) return false;
    slot.amount = add(slot.amount, amount);
    const label = formatNum(slot.amount, FORMAT);
    const decades = this.decades(slot.amount);
    const size = numberSize(slot.style, decades);
    slot.text.text = label;
    slot.text.tint = tintOf(slot.style, decades);
    slot.scale = size / FONT_SIZE;
    slot.halfW = halfWidth(label.length, size);
    slot.halfH = halfHeight(size);
    slot.bumpMs = BUMP_MS;
    return true;
  }
}

function capOf(style: NumberStyle): number {
  return style === 'crit' ? MAX_BIG_CRITS : STYLE_CAP[style];
}

function tintOf(style: NumberStyle, decades: number): number {
  const color = LOOKS[style].color;
  // Big crits burn whiter.
  return style === 'crit'
    ? mixColor(color, COLORS.critHot, Math.min(1, Math.max(0, decades) / 1.5))
    : color;
}

function place(slot: FloatingNumber): void {
  const t = slot.ageMs / slot.lifeMs;
  const text = slot.text;
  const bump = slot.bumpMs > 0 ? 1 + (BUMP * slot.bumpMs) / BUMP_MS : 1;
  // Every number rises at the same steady speed (numberLayout.RISE_PER_MS).
  slot.x = slot.baseX;
  slot.y = slot.baseY - RISE_PER_MS * slot.ageMs;
  slot.solid = t < SOLID_UNTIL;
  text.position.set(slot.x, slot.y);
  if (slot.style === 'crit') {
    // Pops (grows past full size, then settles) as it rises, and fades late.
    const age = slot.ageMs;
    let pop: number;
    if (age < CRIT_GROW_MS) {
      const k = age / CRIT_GROW_MS;
      pop = CRIT_START + (CRIT_OVERSHOOT - CRIT_START) * (1 - (1 - k) * (1 - k));
    } else if (age < CRIT_SETTLE_MS) {
      const k = (age - CRIT_GROW_MS) / (CRIT_SETTLE_MS - CRIT_GROW_MS);
      pop = CRIT_OVERSHOOT + (1 - CRIT_OVERSHOOT) * (k * k * (3 - 2 * k));
    } else {
      pop = 1;
    }
    text.scale.set(slot.scale * pop * bump);
    text.alpha = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;
    return;
  }
  const pop = slot.ageMs < POP_MS ? 1 + slot.pop * (1 - slot.ageMs / POP_MS) : 1;
  text.scale.set(slot.scale * pop * bump);
  text.alpha = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
}
