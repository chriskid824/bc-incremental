/** Projectiles as bright dots with a short trail, redrawn into one Graphics each frame. */

import { Graphics } from 'pixi.js';
import type { ProjectileState } from '../sim';
import { COLORS } from './palette';

const TRAIL_LENGTH = 42;
const HEAD_RADIUS = 5;

export class ProjectileLayer {
  readonly view = new Graphics({ label: 'projectiles' });

  update(projectiles: readonly ProjectileState[], alpha: number): void {
    const g = this.view;
    g.clear();
    let drawn = 0;
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i] as ProjectileState;
      if (!p.alive) continue;
      const dx = p.x - p.prevX;
      const dy = p.y - p.prevY;
      const x = p.prevX + dx * alpha;
      const y = p.prevY + dy * alpha;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        const k = TRAIL_LENGTH / len;
        g.moveTo(x, y).lineTo(x - dx * k, y - dy * k);
        g.stroke({ width: 4, color: COLORS.projectileTrail, alpha: 0.35, cap: 'round' });
      }
      g.circle(x, y, HEAD_RADIUS * 2).fill({ color: COLORS.projectileTrail, alpha: 0.18 });
      g.circle(x, y, HEAD_RADIUS).fill({ color: COLORS.projectile, alpha: 1 });
      drawn++;
    }
    g.visible = drawn > 0;
  }
}
