/**
 * The view at the arena center (docs/v3 C5 design §13.2): the M1 hexagon (PlayerView,
 * src/render/player.ts, as it is) or a character construct that follows the run. The renderer
 * draws whichever RendererOptions.construct picks through this interface.
 */

import { Container } from 'pixi.js';
import type { PlayerState } from '../sim';
import { HiveView } from './constructs/hive';

export interface CoreView {
  readonly view: Container;
  /** Follows the player (position, life) and advances the view's animations by `dtMs`. */
  update(player: Readonly<PlayerState>, dtMs: number): void;
  /** The red hit flash. */
  hit(): void;
  /** A small swell when kill shards are absorbed. */
  pulse(): void;
  /** Back to rest, as at the start of a run. */
  reset(): void;
}

/** What HiveCoreView reads every frame: the share of the run's drones docked (DroneLayer). */
export interface DockedShare {
  readonly dockedShare: number;
}

const PULSE_MS = 140;
const PULSE_SWELL = 0.08;
/** The core fades to this once the player has no life left, as the M1 hexagon does. */
const DEAD_ALPHA = 0.35;

/**
 * 蜂巢's core: HiveView's comb at the player, with no drones of its own (the drone layer draws
 * the run's), its cells set every frame to the share of the run's drones docked.
 */
export class HiveCoreView implements CoreView {
  readonly view = new Container({ label: 'core-hive' });
  private readonly hive = new HiveView({ simDrones: true });
  private pulseMs = 0;

  constructor(private readonly docks: DockedShare) {
    this.view.addChild(this.hive.view);
  }

  update(player: Readonly<PlayerState>, dtMs: number): void {
    this.pulseMs = Math.max(0, this.pulseMs - dtMs);
    this.view.position.set(player.x, player.y);
    this.view.alpha = player.life > 0 ? 1 : DEAD_ALPHA;
    this.hive.view.scale.set(1 + PULSE_SWELL * (this.pulseMs / PULSE_MS));
    this.hive.setDocked(this.docks.dockedShare);
    this.hive.update(dtMs);
  }

  hit(): void {
    this.hive.hit();
  }

  pulse(): void {
    this.pulseMs = PULSE_MS;
  }

  reset(): void {
    this.pulseMs = 0;
    this.hive.reset();
  }
}
