/**
 * The simulation's spec caps (docs/v3/implementation-plan-v3.md §2.4–§2.6): fixed limits that
 * bound one attack's or one system's work. Each cap counts what it refuses in a RunResult
 * counter (COUNTER_IDS, src/sim/types.ts).
 */

/**
 * Hits of one attack, its primary hit and every chain jump together (src/sim/combat/chain.ts);
 * the jumps it refuses count in chainHitCapped.
 */
export const CHAIN_HIT_CAP = 32;
/**
 * Projectiles in flight at once: the volley's homing projectiles and the shot pool's shots
 * together (src/sim/systems/shots.ts). A spawn at the cap is refused and counted in
 * projectilesCapped.
 */
export const PROJECTILE_CAP = 512;
/** Enemies a shot remembers having hit; it passes through them without hitting them again. */
export const SHOT_MEMORY = 16;
/** Ticks a small projectile lives: 2 s. */
export const SMALL_PROJECTILE_TICKS = 120;
