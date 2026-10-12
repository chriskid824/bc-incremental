/** The player: a glowing hexagon at the arena center that flashes red when hit. */

import { Container, Graphics } from 'pixi.js';
import { PLAYER_RADIUS } from '../sim';
import type { PlayerState } from '../sim';
import { COLORS, mixColor } from './palette';

const HIT_FLASH_MS = 260;
const PULSE_MS = 140;

export class PlayerView {
  readonly view = new Container({ label: 'player' });
  private readonly glow = new Graphics();
  private readonly hull = new Graphics();
  private hitMs = 0;
  private pulseMs = 0;
  private timeMs = 0;

  constructor() {
    const r = PLAYER_RADIUS;
    this.glow
      .circle(0, 0, r * 2.4)
      .fill({ color: COLORS.player, alpha: 0.04 })
      .circle(0, 0, r * 1.7)
      .fill({ color: COLORS.player, alpha: 0.07 })
      .circle(0, 0, r * 1.25)
      .fill({ color: COLORS.player, alpha: 0.1 });
    this.glow.blendMode = 'add';
    this.hull
      .regularPoly(0, 0, r, 6)
      .fill({ color: COLORS.player, alpha: 0.16 })
      .stroke({ width: 3, color: COLORS.player, alpha: 1 })
      .regularPoly(0, 0, r * 0.55, 6, Math.PI / 6)
      .stroke({ width: 2, color: COLORS.player, alpha: 0.6 })
      .circle(0, 0, r * 0.26)
      .fill({ color: COLORS.playerCore, alpha: 1 });
    this.view.addChild(this.glow, this.hull);
  }

  hit(): void {
    this.hitMs = HIT_FLASH_MS;
  }

  /** Small swell when kill shards are absorbed. */
  pulse(): void {
    this.pulseMs = PULSE_MS;
  }

  reset(): void {
    this.hitMs = 0;
    this.pulseMs = 0;
  }

  update(player: Readonly<PlayerState>, dtMs: number): void {
    this.timeMs += dtMs;
    this.hitMs = Math.max(0, this.hitMs - dtMs);
    this.pulseMs = Math.max(0, this.pulseMs - dtMs);
    this.view.position.set(player.x, player.y);
    this.hull.rotation = this.timeMs * 0.0004;
    const breathe = 1 + 0.04 * Math.sin(this.timeMs * 0.003);
    this.glow.scale.set(breathe + 0.25 * (this.pulseMs / PULSE_MS));
    const hit = this.hitMs / HIT_FLASH_MS;
    this.view.tint = mixColor(0xffffff, COLORS.playerHit, hit);
    this.view.scale.set(1 + 0.12 * hit);
    this.view.alpha = player.life > 0 ? 1 : 0.35;
  }
}
