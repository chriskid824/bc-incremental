/**
 * Floating damage numbers (docs/ARCHITECTURE.md §10): pooled BitmapText on dynamically
 * installed fonts, sized by log10 of the amount relative to the run's typical hit.
 * Crits use a bold glowing font on their own top layer and pop (overshoot, then settle); when
 * their pool is full the oldest crit is recycled. Hit, chain and burn numbers share a second
 * pool with a cap per kind, and new ones are dropped once their cap is reached, so a crowded
 * screen shows fewer numbers rather than a wall of them.
 */

import { BitmapFont, BitmapText, Container } from 'pixi.js';
import { formatNum } from '../core/format';
import { log10 } from '../core/num';
import type { Num } from '../core/num';
import { COLORS, mixColor } from './palette';
import { ageStep } from './timing';

export type DamageKind = 'hit' | 'crit' | 'burn' | 'chain';

const FONT_NAME = 'bc-damage';
const CRIT_FONT_NAME = 'bc-damage-crit';
const FONT_SIZE = 48;
const CHARS = '0123456789.,-+eKMBTNa∞ ';
const FORMAT = { format: 'short' } as const;

const MAX_NUMBERS = 110;
const MAX_CRITS = 36;
/** Live numbers allowed per kind in the shared pool. */
const KIND_CAP: Readonly<Record<Exclude<DamageKind, 'crit'>, number>> = {
  hit: 70,
  chain: 45,
  burn: 40,
};

interface KindStyle {
  readonly color: number;
  /** Height in arena units at the typical hit. */
  readonly size: number;
  /** Size grows by this fraction per order of magnitude above the typical hit. */
  readonly perDecade: number;
  readonly lifeMs: number;
  readonly rise: number;
  readonly pop: number;
}

const STYLES: Readonly<Record<DamageKind, KindStyle>> = {
  hit: { color: COLORS.damageHit, size: 22, perDecade: 0.3, lifeMs: 700, rise: 50, pop: 0.35 },
  crit: { color: COLORS.damageCrit, size: 40, perDecade: 0.55, lifeMs: 820, rise: 30, pop: 0 },
  burn: { color: COLORS.damageBurn, size: 15, perDecade: 0.25, lifeMs: 650, rise: 34, pop: 0.2 },
  chain: { color: COLORS.damageChain, size: 20, perDecade: 0.3, lifeMs: 700, rise: 46, pop: 0.3 },
};

const MIN_DECADES = -1;
const MAX_DECADES = 4;
const POP_MS = 110;
/** Crit pop: grows to CRIT_OVERSHOOT by CRIT_GROW_MS, settles to 1 by CRIT_SETTLE_MS. */
const CRIT_START = 0.45;
const CRIT_OVERSHOOT = 1.55;
const CRIT_GROW_MS = 70;
const CRIT_SETTLE_MS = 210;

interface FloatingNumber {
  readonly text: BitmapText;
  kind: DamageKind;
  ageMs: number;
  lifeMs: number;
  x: number;
  y: number;
  rise: number;
  scale: number;
  pop: number;
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

/** A pool of numbers on one font and layer. */
class NumberPool {
  readonly layer = new Container();
  readonly live: FloatingNumber[] = [];
  private readonly free: FloatingNumber[] = [];
  private created = 0;

  constructor(
    private readonly font: string,
    private readonly max: number,
  ) {}

  /** A free slot; when none is left, the oldest live one if `recycle`, else null. */
  acquire(recycle: boolean): FloatingNumber | null {
    let slot = this.free.pop();
    if (slot === undefined) {
      if (this.created < this.max) {
        slot = this.create();
      } else if (recycle && this.live.length > 0) {
        slot = this.live.shift() as FloatingNumber;
      } else {
        return null;
      }
    }
    slot.text.visible = true;
    this.live.push(slot);
    return slot;
  }

  /** Ages live numbers; returns expired ones to the pool and reports them to `onExpire`. */
  update(dtMs: number, onExpire: (kind: DamageKind) => void): void {
    let kept = 0;
    for (let i = 0; i < this.live.length; i++) {
      const slot = this.live[i] as FloatingNumber;
      slot.ageMs += ageStep(dtMs, slot.fresh);
      slot.fresh = false;
      if (slot.ageMs >= slot.lifeMs) {
        slot.text.visible = false;
        this.free.push(slot);
        onExpire(slot.kind);
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

  private create(): FloatingNumber {
    this.created++;
    const text = new BitmapText({
      text: '',
      style: { fontFamily: this.font, fontSize: FONT_SIZE },
      anchor: 0.5,
    });
    this.layer.addChild(text);
    return {
      text,
      kind: 'hit',
      ageMs: 0,
      lifeMs: 1,
      x: 0,
      y: 0,
      rise: 0,
      scale: 1,
      pop: 0,
      fresh: true,
    };
  }
}

export class DamageNumbers {
  readonly view = new Container({ label: 'damage-numbers' });
  private readonly normal = new NumberPool(FONT_NAME, MAX_NUMBERS);
  private readonly crits = new NumberPool(CRIT_FONT_NAME, MAX_CRITS);
  private readonly counts = { hit: 0, crit: 0, burn: 0, chain: 0 };
  private readonly onExpire = (kind: DamageKind): void => {
    this.counts[kind]--;
  };
  private typicalHit = 1;

  constructor() {
    installFonts();
    // Crits draw above everything else.
    this.view.addChild(this.normal.layer, this.crits.layer);
  }

  /** Reference amount for sizing; numbers at this amount get the base size. */
  setTypicalHit(amount: number): void {
    this.typicalHit = amount > 0 && Number.isFinite(amount) ? amount : 1;
  }

  /** log10(amount / typical hit), clamped to the sizing range. */
  decades(amount: Num): number {
    const d = log10(amount) - Math.log10(this.typicalHit);
    if (!Number.isFinite(d)) return MIN_DECADES;
    return Math.min(MAX_DECADES, Math.max(MIN_DECADES, d));
  }

  /** Shows a number; returns false when it was dropped to stay under the caps. */
  spawn(kind: DamageKind, amount: Num, x: number, y: number): boolean {
    let slot: FloatingNumber | null;
    if (kind === 'crit') {
      const recycled = this.crits.live.length >= MAX_CRITS;
      slot = this.crits.acquire(true);
      if (slot !== null && recycled) this.counts[slot.kind]--;
    } else {
      if (this.counts[kind] >= KIND_CAP[kind]) return false;
      slot = this.normal.acquire(false);
    }
    if (slot === null) return false;
    this.counts[kind]++;

    const style = STYLES[kind];
    const decades = this.decades(amount);
    const text = slot.text;
    text.text = formatNum(amount, FORMAT);
    // Big crits burn whiter.
    text.tint =
      kind === 'crit'
        ? mixColor(style.color, COLORS.critHot, Math.min(1, Math.max(0, decades) / 1.5))
        : style.color;
    text.alpha = 1;
    text.rotation = kind === 'crit' ? (Math.random() * 2 - 1) * 0.1 : 0;
    slot.kind = kind;
    slot.ageMs = 0;
    slot.fresh = true;
    slot.lifeMs = style.lifeMs;
    slot.x = x + (Math.random() * 2 - 1) * 14;
    slot.y = y - 10 + (Math.random() * 2 - 1) * 8;
    slot.rise = style.rise;
    slot.pop = style.pop;
    const size = style.size * (1 + style.perDecade * decades);
    slot.scale = Math.max(8, size) / FONT_SIZE;
    place(slot);
    return true;
  }

  clear(): void {
    this.normal.clear();
    this.crits.clear();
    this.counts.hit = 0;
    this.counts.crit = 0;
    this.counts.burn = 0;
    this.counts.chain = 0;
  }

  update(dtMs: number): void {
    this.normal.update(dtMs, this.onExpire);
    this.crits.update(dtMs, this.onExpire);
    for (const slot of this.normal.live) place(slot);
    for (const slot of this.crits.live) place(slot);
  }
}

function place(slot: FloatingNumber): void {
  const t = slot.ageMs / slot.lifeMs;
  const text = slot.text;
  if (slot.kind === 'crit') {
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
    // Holds still while it pops, then drifts up and fades.
    const drift =
      age < CRIT_SETTLE_MS ? 0 : (age - CRIT_SETTLE_MS) / (slot.lifeMs - CRIT_SETTLE_MS);
    text.position.set(slot.x, slot.y - slot.rise * drift);
    text.scale.set(slot.scale * pop);
    text.alpha = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;
    return;
  }
  const ease = 1 - (1 - t) * (1 - t);
  const pop = slot.ageMs < POP_MS ? 1 + slot.pop * (1 - slot.ageMs / POP_MS) : 1;
  text.position.set(slot.x, slot.y - slot.rise * ease);
  text.scale.set(slot.scale * pop);
  text.alpha = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
}
