/**
 * Impact feel the renderer adds on top of the effects (熔核's playtest: "打擊感"): a short shake
 * when a bomb lands, when the core is struck and when a frame kills a crowd, each through its own
 * cooldown and under a low ceiling, so a run full of bombs rumbles rather than rattles; and a
 * stronger hit punch on the enemy struck. Shakes go through ScreenShake, which reduced motion turns
 * off. DOM-free, so the tests reach it.
 */

/** The hit's scale bump on the enemy struck (src/render/enemies.ts flash), a crit's bigger. */
export const HIT_PUNCH_STRONG = 0.26;
export const CRIT_PUNCH = 0.42;

/** A blast of this radius kicks BLAST_SHAKE; bigger ones a little more, up to BLAST_SHAKE_MAX. */
export const BLAST_RADIUS_REF = 80;
export const BLAST_SHAKE = 0.2;
export const BLAST_SHAKE_MAX = 0.34;
/** Blast shakes never push trauma past this. */
export const BLAST_SHAKE_CEILING = 0.42;
export const BLAST_SHAKE_COOLDOWN_MS = 140;

export const PLAYER_HIT_SHAKE = 0.32;
export const PLAYER_HIT_SHAKE_CEILING = 0.45;
export const PLAYER_HIT_SHAKE_COOLDOWN_MS = 250;

/** A frame with this many kills thumps once. */
export const CROWD_KILL_COUNT = 5;
export const CROWD_KILL_SHAKE = 0.22;
export const CROWD_KILL_SHAKE_CEILING = 0.4;
export const CROWD_KILL_SHAKE_COOLDOWN_MS = 200;

/** A shake kick and the ceiling it may raise trauma to. */
export interface ShakeKick {
  readonly amount: number;
  readonly ceiling: number;
}

/** Spaces the impact shakes: each kind has its own wall-clock cooldown. */
export class ImpactShakes {
  private blastMs = 0;
  private playerMs = 0;
  private crowdMs = 0;

  /** A bomb exploded over `radius`: a kick, or null inside the cooldown. */
  blast(radius: number): ShakeKick | null {
    if (this.blastMs > 0 || !(radius > 0)) return null;
    this.blastMs = BLAST_SHAKE_COOLDOWN_MS;
    const size = Math.sqrt(radius / BLAST_RADIUS_REF);
    const amount = Math.min(BLAST_SHAKE_MAX, BLAST_SHAKE * Math.max(0.5, size));
    return { amount, ceiling: BLAST_SHAKE_CEILING };
  }

  /** The core took a hit that flashes it. */
  playerHit(): ShakeKick | null {
    if (this.playerMs > 0) return null;
    this.playerMs = PLAYER_HIT_SHAKE_COOLDOWN_MS;
    return { amount: PLAYER_HIT_SHAKE, ceiling: PLAYER_HIT_SHAKE_CEILING };
  }

  /** The frame's kill count so far, as each kill lands; a kick once it reaches the crowd. */
  kills(count: number): ShakeKick | null {
    if (count !== CROWD_KILL_COUNT || this.crowdMs > 0) return null;
    this.crowdMs = CROWD_KILL_SHAKE_COOLDOWN_MS;
    return { amount: CROWD_KILL_SHAKE, ceiling: CROWD_KILL_SHAKE_CEILING };
  }

  update(dtMs: number): void {
    const dt = Math.max(0, dtMs);
    this.blastMs = Math.max(0, this.blastMs - dt);
    this.playerMs = Math.max(0, this.playerMs - dt);
    this.crowdMs = Math.max(0, this.crowdMs - dt);
  }

  reset(): void {
    this.blastMs = 0;
    this.playerMs = 0;
    this.crowdMs = 0;
  }
}
