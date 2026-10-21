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
 * Jumps the build's rules add to one attack's chain, extra jumps (跳電) and bounces (回彈)
 * together (src/sim/combat/policy.ts); an extra-jump roll not made and a bounce refused count
 * in extraJumpsCapped. They count against CHAIN_HIT_CAP too.
 */
export const EXTRA_JUMP_CAP = 2;
/**
 * Times one chainJump trigger fires in one attack (passes, src/sim/effects/dispatch.ts): after
 * that it passes over the attack's later jumps, drawing nothing, each counted in
 * centerEventsCapped.
 */
export const CHAIN_JUMP_EVENT_CAP = 3;
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
/**
 * Enemies a center event's list holds at most (CenterEventScratch.list): a freeze's is the
 * frozen enemy and up to four others near it; explode's, which comes later in C4, the first of
 * the bomb's blast.
 */
export const LIST_MAX = 5;
/** How far from a frozen enemy the others of its freeze's list are (raiseFreeze). */
export const FREEZE_LIST_RADIUS = 90;
/**
 * Effect zones live at once (groundZone, src/sim/systems/zones.ts). A new zone past it evicts
 * the oldest effect zone, counted in zonesEvicted.
 */
export const ZONE_CAP = 64;
/** Effect zones one source keeps at once; its next one evicts its own oldest. */
export const ZONE_SOURCE_CAP = 16;
/** Signature zones live at once, apart from the effect zones; the next evicts the oldest. */
export const SIGNATURE_ZONE_CAP = 16;
/** Ticks between two pulses of a zone: four a second. */
export const PULSE_TICKS = 15;
/**
 * Repeats waiting for the signature attack's next own firing (repeatAttack with timing
 * 'nextAttack', src/sim/effects/execute.ts); one more is dropped and counted in
 * repeatChargesDropped.
 */
export const REPEAT_CHARGE_CAP = 8;
/**
 * Burn stacks that stacksAtLeast 'max' asks for under eternalFlame (BuildFlags.burnRings), where
 * burns live in DoT rings and no cap refuses one (burnCapOf, src/sim/ailments/records.ts).
 */
export const BURN_RINGS_MAX_STACKS = 5;
/**
 * Summons a run places: every drone emitter's drones, in emitter order (the drone pool,
 * src/sim/emitters/drone.ts). The rows past it are refused, counted in summonCapped; only a
 * test module raises it (TestModule.summonCap).
 */
export const SUMMON_CAP = 24;
/**
 * Enemies a drone remembers impacting, each until its same-enemy cooldown ends
 * (src/sim/systems/drones.ts): enough at any attack frequency, as the cooldown is at most
 * DRONE_COOLDOWN_MAX and a drone picks at most once every PICK_TICKS.
 */
export const DRONE_MEMORY = 4;
/** Ticks between two picks of one drone at the least: 0.5 s, whatever the attack frequency. */
export const PICK_TICKS = 30;
/** The longest same-enemy cooldown of a drone, in ticks, which keeps DRONE_MEMORY enough. */
export const DRONE_COOLDOWN_MAX = 90;
/**
 * Enemies one orb remembers having hit, each until its cooldown ends (src/sim/emitters/orbit.ts);
 * a power of two, so its ring buffer wraps with a mask. An orb that hits one more while it
 * remembers this many forgets the oldest, counted in orbMemoryFull, and may hit that one again
 * before its cooldown ends.
 */
export const ORB_MEMORY = 64;
