/**
 * The player's shield (docs/v3 C7 design §2.9: PlayerState.shield, which C7.2's `shield` effect
 * grants): an arc round the center, centered on its top, whose sweep is the shield's share of
 * max life, the full ring at SHIELD_FULL_SHARE; it brightens for a moment when the shield takes a
 * hit (shieldAbsorbed). Nothing shows while the shield is 0. An M1 run has no shield: the renderer
 * makes the arc for v3 data only. DOM-free, so the tests reach it.
 */

import { Graphics } from 'pixi.js';
import type { PlayerState } from '../sim';
import { PLAYER_RADIUS } from '../sim/types';
import { COLORS } from './palette';

/**
 * The shield's share of max life that draws the full ring: 霜甲's cap (gd:110, 30%), the largest
 * shield the game design gives; 波次護盾's 20% (gd:265) draws two thirds of it.
 */
export const SHIELD_FULL_SHARE = 0.3;
/** The arc's radius, outside the core's hull and halo, and its line. */
export const SHIELD_RADIUS = PLAYER_RADIUS * 1.55;
const SHIELD_WIDTH = 4;
/** Its alpha at rest, and at the peak of a flash. */
export const SHIELD_ALPHA = 0.65;
const SHIELD_FLASH_ALPHA = 1;
/** How long it brightens when the shield takes a hit. */
export const SHIELD_FLASH_MS = 180;

const TAU = Math.PI * 2;
/** The arc grows both ways from the top. */
const TOP = -Math.PI / 2;

export class PlayerShield {
  readonly view = new Graphics({ label: 'player-shield' });
  /** The sweep drawn now, in radians; −1 before the first draw. */
  private sweep = -1;
  private flashMs = 0;

  /** The shield took a hit (shieldAbsorbed): brighten. */
  absorb(): void {
    this.flashMs = SHIELD_FLASH_MS;
  }

  /** No shield and no flash, as at a run's start. */
  reset(): void {
    this.flashMs = 0;
    this.draw(0);
  }

  update(player: Readonly<PlayerState>, dtMs: number): void {
    this.flashMs = Math.max(0, this.flashMs - dtMs);
    const share = player.maxLife > 0 ? player.shield / (player.maxLife * SHIELD_FULL_SHARE) : 0;
    this.draw(TAU * Math.min(1, Math.max(0, share)));
    this.view.position.set(player.x, player.y);
    const flash = this.flashMs / SHIELD_FLASH_MS;
    this.view.alpha = SHIELD_ALPHA + (SHIELD_FLASH_ALPHA - SHIELD_ALPHA) * flash;
  }

  /** Redraws the arc when its sweep changed. */
  private draw(sweep: number): void {
    if (sweep === this.sweep) return;
    this.sweep = sweep;
    const g = this.view.clear();
    if (sweep <= 0) return;
    if (sweep >= TAU) g.circle(0, 0, SHIELD_RADIUS);
    else g.arc(0, 0, SHIELD_RADIUS, TOP - sweep / 2, TOP + sweep / 2);
    g.stroke({ width: SHIELD_WIDTH, color: COLORS.playerShield, alpha: 1, cap: 'round' });
  }
}
