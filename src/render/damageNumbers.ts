/**
 * Floating damage numbers (docs/ARCHITECTURE.md §10): pooled BitmapText on a dynamically
 * installed font, sized by log10 of the amount relative to the run's typical hit. The pool is
 * a ring, so once full the oldest number is recycled.
 */

import { BitmapFont, BitmapText, Container } from 'pixi.js';
import { formatNum } from '../core/format';
import { log10 } from '../core/num';
import type { Num } from '../core/num';
import { COLORS } from './palette';

export type DamageKind = 'hit' | 'crit' | 'burn' | 'chain';

const FONT_NAME = 'bc-damage';
const FONT_SIZE = 48;
const MAX_NUMBERS = 120;
const FORMAT = { format: 'short' } as const;

interface KindStyle {
  readonly color: number;
  /** Height in arena units at the typical hit. */
  readonly size: number;
  readonly lifeMs: number;
  readonly rise: number;
  readonly pop: number;
}

const STYLES: Readonly<Record<DamageKind, KindStyle>> = {
  hit: { color: COLORS.damageHit, size: 24, lifeMs: 800, rise: 56, pop: 0.35 },
  crit: { color: COLORS.damageCrit, size: 34, lifeMs: 950, rise: 70, pop: 0.7 },
  burn: { color: COLORS.damageBurn, size: 16, lifeMs: 700, rise: 36, pop: 0.15 },
  chain: { color: COLORS.damageChain, size: 21, lifeMs: 800, rise: 50, pop: 0.3 },
};

/** Size grows by this fraction per order of magnitude above the typical hit. */
const SIZE_PER_DECADE = 0.3;
const MIN_DECADES = -1;
const MAX_DECADES = 4;
const POP_MS = 110;

interface FloatingNumber {
  readonly text: BitmapText;
  ageMs: number;
  lifeMs: number;
  x: number;
  y: number;
  rise: number;
  scale: number;
  pop: number;
}

let fontInstalled = false;

function installFont(): void {
  if (fontInstalled) return;
  BitmapFont.install({
    name: FONT_NAME,
    style: {
      fontFamily: ['Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      fontSize: FONT_SIZE,
      fontWeight: '800',
      fill: 0xffffff,
      stroke: { color: 0x05060a, width: 6, join: 'round' },
    },
    chars: '0123456789.,-+eKMBTNa∞ ',
    resolution: 2,
    padding: 6,
  });
  fontInstalled = true;
}

export class DamageNumbers {
  readonly view = new Container({ label: 'damage-numbers' });
  private readonly slots: FloatingNumber[] = [];
  private next = 0;
  private typicalHit = 1;

  constructor() {
    installFont();
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

  spawn(kind: DamageKind, amount: Num, x: number, y: number): void {
    const style = STYLES[kind];
    const slot = this.acquire();
    const text = slot.text;
    text.text = formatNum(amount, FORMAT);
    text.tint = style.color;
    text.visible = true;
    text.alpha = 1;
    slot.ageMs = 0;
    slot.lifeMs = style.lifeMs;
    slot.x = x + (Math.random() * 2 - 1) * 14;
    slot.y = y - 10 + (Math.random() * 2 - 1) * 8;
    slot.rise = style.rise;
    slot.pop = style.pop;
    const size = style.size * (1 + SIZE_PER_DECADE * this.decades(amount));
    slot.scale = Math.max(8, size) / FONT_SIZE;
    // Newest on top.
    this.view.addChild(text);
    this.place(slot);
  }

  clear(): void {
    for (const slot of this.slots) {
      slot.ageMs = slot.lifeMs;
      slot.text.visible = false;
    }
  }

  update(dtMs: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i] as FloatingNumber;
      if (!slot.text.visible) continue;
      slot.ageMs += dtMs;
      if (slot.ageMs >= slot.lifeMs) {
        slot.text.visible = false;
        continue;
      }
      this.place(slot);
    }
  }

  private place(slot: FloatingNumber): void {
    const t = slot.ageMs / slot.lifeMs;
    const ease = 1 - (1 - t) * (1 - t);
    const pop = slot.ageMs < POP_MS ? 1 + slot.pop * (1 - slot.ageMs / POP_MS) : 1;
    const text = slot.text;
    text.position.set(slot.x, slot.y - slot.rise * ease);
    text.scale.set(slot.scale * pop);
    text.alpha = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
  }

  private acquire(): FloatingNumber {
    if (this.slots.length < MAX_NUMBERS) {
      const text = new BitmapText({
        text: '',
        style: { fontFamily: FONT_NAME, fontSize: FONT_SIZE },
        anchor: 0.5,
      });
      const slot: FloatingNumber = {
        text,
        ageMs: 0,
        lifeMs: 1,
        x: 0,
        y: 0,
        rise: 0,
        scale: 1,
        pop: 0,
      };
      this.slots.push(slot);
      this.view.addChild(text);
      return slot;
    }
    const slot = this.slots[this.next] as FloatingNumber;
    this.next = (this.next + 1) % MAX_NUMBERS;
    return slot;
  }
}
