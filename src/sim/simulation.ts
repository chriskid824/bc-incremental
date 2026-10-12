/**
 * Deterministic run simulation (docs/ARCHITECTURE.md §4, docs/GDD.md §2–3, §7).
 *
 * Each step() advances one fixed tick and runs the systems in a fixed order:
 * wave start → spawn → movement and contact → attack → projectiles (retargets, hits, chains,
 * kills, drops) → burn → compaction → wave clears → overkill → run end.
 * Randomness comes only from the seeded spawn, split, combat and drops streams, and entity
 * arrays stay ordered by increasing id, so a seed fully determines the run.
 * Projectiles spread over enemies that projectiles already in flight will not kill, and
 * retarget when their target dies first (src/sim/targeting.ts).
 * Keystone rules (config.rules) arrive in M1; M0 ignores them.
 */

import type { Num } from '../core/num';
import { add, assertFinite, gt, lt, lte, mul, num, sub, ZERO } from '../core/num';
import { createStreams } from '../core/rng';
import { composeWave } from '../data/compose';
import { shardsPerStdEnemy, stdHp } from '../data/curve';
import { DAMAGE_TAG_BIT, DAMAGE_TAG_MASK_COUNT, STAT_IDS } from '../data/stats';
import type { EnemyDef, GameData } from '../data/types';
import { pickTarget } from './targeting';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, MAX_RUN_SECONDS, PLAYER_RADIUS, TICK_RATE } from './types';
import type {
  EndReason,
  EnemyState,
  InputFrame,
  ProjectileState,
  RunConfig,
  RunResult,
  SimEvent,
  SimState,
  Simulation,
} from './types';

/** Burn damage is dealt on a global cadence of this many ticks (0.25 s). */
export const BURN_TICK_INTERVAL = 15;

const HIT = DAMAGE_TAG_BIT.hit;
const CRIT = DAMAGE_TAG_BIT.crit;
const BURN = DAMAGE_TAG_BIT.burn;
const CHAIN = DAMAGE_TAG_BIT.chain;

const TAU = Math.PI * 2;
const HALF_WIDTH = ARENA_WIDTH / 2;
const HALF_HEIGHT = ARENA_HEIGHT / 2;

interface WaveRecord {
  readonly wave: number;
  /** Enemies of the wave in (shuffled) spawn order. */
  readonly queue: readonly EnemyDef[];
  released: number;
  readonly startTick: number;
  /** Released enemies of this wave, split children included, that are still alive. */
  alive: number;
  /** Every enemy is released and gone, killed or not. */
  cleared: boolean;
  /** One of its enemies, split children included, reached the player. */
  leaked: boolean;
  readonly stdHp: number;
  readonly shardsPerStd: number;
}

interface BurnStack {
  dps: Num;
  /** Tick the stack was applied, and the (possibly fractional) tick it ends. */
  start: number;
  end: number;
}

interface Enemy extends EnemyState {
  readonly def: EnemyDef;
  readonly rec: WaveRecord;
  /** Unit vector from the player towards the enemy; the enemy walks it inwards. */
  readonly ux: number;
  readonly uy: number;
  /** Distance from the player along (ux, uy). */
  dist: number;
  /** Distance covered per tick. */
  readonly stepDist: number;
  /** Player radius + enemy radius. */
  readonly contactDist: number;
  readonly burns: BurnStack[];
  /** Damage of stacks that ended or were replaced since the last burn tick. */
  burnPending: Num;
  /** Earliest end tick among the active stacks; Infinity when there are none. */
  burnNextEnd: number;
  /** Serial of the last attack that hit this enemy, so chains skip it. */
  hitMark: number;
  /** Projectiles in flight towards this enemy (see src/sim/targeting.ts). */
  inbound: number;
}

interface Projectile extends ProjectileState {
  target: Enemy;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function validateConfig(config: RunConfig): void {
  if (config.mode !== 'auto') {
    throw new Error(`Control mode '${config.mode}' arrives in M1; M0 supports 'auto' only.`);
  }
  if (!Number.isInteger(config.startWave) || config.startWave < 1) {
    throw new RangeError(`startWave must be an integer >= 1, got ${config.startWave}`);
  }
  if (
    config.waveCap !== undefined &&
    (!Number.isInteger(config.waveCap) || config.waveCap < config.startWave)
  ) {
    throw new RangeError(`waveCap must be an integer >= startWave, got ${config.waveCap}`);
  }
  if (
    config.maxTicks !== undefined &&
    (!Number.isInteger(config.maxTicks) || config.maxTicks < 1)
  ) {
    throw new RangeError(`maxTicks must be an integer >= 1, got ${config.maxTicks}`);
  }
  const { values, damageMult } = config.stats;
  for (const id of STAT_IDS) {
    if (!Number.isFinite(values[id])) throw new RangeError(`Stat ${id} is not finite`);
  }
  if (values.maxLife <= 0) throw new RangeError('maxLife must be positive');
  if (values.projectileSpeed <= 0) throw new RangeError('projectileSpeed must be positive');
  if (damageMult.length !== DAMAGE_TAG_MASK_COUNT || !damageMult.every(Number.isFinite)) {
    throw new RangeError(`damageMult must hold ${DAMAGE_TAG_MASK_COUNT} finite numbers`);
  }
}

export function createSimulation(config: RunConfig, data: GameData): Simulation {
  validateConfig(config);

  const { values, damageMult } = config.stats;
  const {
    spawn: spawnRng,
    split: splitRng,
    combat: combatRng,
    drops: dropsRng,
  } = createStreams(config.seed);
  const startWaveNumber = config.startWave;
  const waveCap = config.waveCap ?? Infinity;
  const maxTicks = config.maxTicks ?? MAX_RUN_SECONDS * TICK_RATE;
  const spawnTicks = data.waves.spawnDurationSec * TICK_RATE;
  const waveTimerTicks = data.waves.waveTimerSec * TICK_RATE;

  // Derived stats, clamped as documented in src/data/stats.ts.
  const multAt = (mask: number): number => damageMult[mask] as number;
  const damage = num(values.damage);
  const critChance = clamp01(values.critChance);
  const critMultiplier = values.critMultiplier;
  const igniteChance = clamp01(values.igniteChance);
  const burnDamage = values.burnDamage;
  const burnTicks = values.burnDuration * TICK_RATE;
  const burnCap = Math.max(1, Math.floor(values.burnMaxStacks));
  const burnMult = multAt(BURN);
  const burnCritMult = multAt(BURN | CRIT);
  const chainCount = Math.max(0, values.chainCount);
  const chainWhole = Math.floor(chainCount);
  const chainFrac = chainCount - chainWhole;
  const chainRetention = clamp01(values.chainRetention);
  const chainRangeSq = Math.max(0, values.chainRange) ** 2;
  /** Ticks between attacks; Infinity disables attacking. */
  const attackInterval = values.attackSpeed > 0 ? TICK_RATE / values.attackSpeed : Infinity;
  const projectileStep = values.projectileSpeed * DT;
  const shardGain = values.shardGain;
  const coreGain = Math.max(0, values.coreGain);
  /** Average primary hit, for overkill tracking (docs/GDD.md §2.2); crits use mult[hit|crit]. */
  const expectedHit =
    values.damage *
    ((1 - critChance) * multAt(HIT) + critChance * critMultiplier * multAt(HIT | CRIT));
  /** Damage a projectile in flight is expected to deal, for targeting: the non-crit primary hit. */
  const projectileEstimate = mul(damage, multAt(HIT));

  const enemies: Enemy[] = [];
  const projectiles: Projectile[] = [];
  const player = {
    x: HALF_WIDTH,
    y: HALF_HEIGHT,
    life: values.maxLife,
    maxLife: values.maxLife,
  };
  const state: SimState = {
    tick: 0,
    wave: startWaveNumber,
    highestWaveReached: 0,
    highestWaveCleared: 0,
    player,
    enemies,
    projectiles,
    shards: ZERO,
    cores: 0,
    finished: false,
  };
  const events: SimEvent[] = [];

  /** Started waves that are not cleared yet, in wave order. */
  const open: WaveRecord[] = [];
  let current: WaveRecord | null = null;
  /** The start wave, once started; it decides RunResult.clearedStartWave. */
  let startRec: WaveRecord | null = null;
  let now = 0;
  let nextEnemyId = 1;
  let nextProjectileId = 1;
  let attackSerial = 0;
  let attackTicks = 0;
  let lastBurnTick = 0;
  let enemiesDirty = false;
  let projectilesDirty = false;
  let kills = 0;
  let overkillTicks = 0;
  let damageHit = ZERO;
  let damageCrit = ZERO;
  let damageChain = ZERO;
  let damageBurn = ZERO;
  let maxHit = ZERO;
  let runResult: RunResult | null = null;

  // ---- Waves and spawning ----

  function startWave(wave: number): void {
    const queue: EnemyDef[] = [];
    for (const entry of composeWave(wave, data.waves)) {
      const def = data.enemies[entry.enemy];
      for (let i = 0; i < entry.count; i++) queue.push(def);
    }
    for (let i = queue.length - 1; i > 0; i--) {
      const j = spawnRng.int(i + 1);
      const swap = queue[i] as EnemyDef;
      queue[i] = queue[j] as EnemyDef;
      queue[j] = swap;
    }
    const rec: WaveRecord = {
      wave,
      queue,
      released: 0,
      startTick: now,
      alive: 0,
      cleared: false,
      leaked: false,
      stdHp: stdHp(wave),
      shardsPerStd: shardsPerStdEnemy(wave),
    };
    open.push(rec);
    current = rec;
    if (wave === startWaveNumber) startRec = rec;
    state.wave = wave;
    state.highestWaveReached = wave;
    events.push({ type: 'waveStarted', wave });
  }

  /**
   * Starts the first wave, or the next one once the field is clear (every started wave is
   * cleared, docs/GDD.md §2.1) or the current wave has run for waveTimerSec.
   */
  function startDueWave(): void {
    if (current === null) {
      startWave(startWaveNumber);
    } else if (
      current.wave < waveCap &&
      (open.length === 0 || now - current.startTick >= waveTimerTicks)
    ) {
      startWave(current.wave + 1);
    }
  }

  /** Releases each open wave's queue evenly over spawnDurationSec, the first enemy at once. */
  function releaseEnemies(): void {
    for (let w = 0; w < open.length; w++) {
      const rec = open[w] as WaveRecord;
      const total = rec.queue.length;
      if (rec.released >= total) continue;
      const elapsed = now - rec.startTick;
      const due =
        spawnTicks > 0 ? Math.min(total, Math.floor((elapsed * total) / spawnTicks) + 1) : total;
      while (rec.released < due) {
        const def = rec.queue[rec.released] as EnemyDef;
        rec.released++;
        // Random direction from the center, placed just outside the arena rectangle.
        const angle = spawnRng.range(0, TAU);
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        const dist = Math.min(
          (HALF_WIDTH + def.radius) / Math.abs(ux),
          (HALF_HEIGHT + def.radius) / Math.abs(uy),
        );
        addEnemy(def, rec, ux, uy, dist);
      }
    }
  }

  function addEnemy(def: EnemyDef, rec: WaveRecord, ux: number, uy: number, dist: number): void {
    const x = player.x + ux * dist;
    const y = player.y + uy * dist;
    const hp = mul(num(def.hpMult), rec.stdHp);
    const enemy: Enemy = {
      id: nextEnemyId++,
      type: def.id,
      wave: rec.wave,
      x,
      y,
      prevX: x,
      prevY: y,
      hp,
      maxHp: hp,
      radius: def.radius,
      burnStacks: 0,
      alive: true,
      def,
      rec,
      ux,
      uy,
      dist,
      stepDist: def.speed * DT,
      contactDist: PLAYER_RADIUS + def.radius,
      burns: [],
      burnPending: ZERO,
      burnNextEnd: Infinity,
      hitMark: 0,
      inbound: 0,
    };
    enemies.push(enemy);
    rec.alive++;
    events.push({ type: 'enemySpawned', enemyId: enemy.id, enemy: def.id });
  }

  /**
   * Children appear around the parent and belong to its wave. Their angles come from their
   * own stream: kills depend on combat, and must not shift later waves' spawns.
   */
  function split(parent: Enemy): void {
    const splitInto = parent.def.splitInto;
    if (splitInto === undefined) return;
    const def = data.enemies[splitInto.enemy];
    for (let i = 0; i < splitInto.count; i++) {
      const angle = splitRng.range(0, TAU);
      const dx = parent.x + Math.cos(angle) * parent.radius - player.x;
      const dy = parent.y + Math.sin(angle) * parent.radius - player.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0) addEnemy(def, parent.rec, dx / dist, dy / dist, dist);
      else addEnemy(def, parent.rec, 1, 0, 0);
    }
  }

  function removeEnemy(enemy: Enemy): void {
    enemy.alive = false;
    enemy.rec.alive--;
    enemiesDirty = true;
  }

  function updateClears(): void {
    let kept = 0;
    for (let r = 0; r < open.length; r++) {
      const rec = open[r] as WaveRecord;
      if (rec.alive === 0 && rec.released === rec.queue.length) {
        rec.cleared = true;
        if (rec.wave > state.highestWaveCleared) state.highestWaveCleared = rec.wave;
        events.push({ type: 'waveCleared', wave: rec.wave });
      } else {
        open[kept++] = rec;
      }
    }
    open.length = kept;
  }

  // ---- Movement and contact ----

  function moveEnemies(): void {
    const px = player.x;
    const py = player.y;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i] as Enemy;
      enemy.prevX = enemy.x;
      enemy.prevY = enemy.y;
      const dist = enemy.dist - enemy.stepDist;
      enemy.dist = dist > 0 ? dist : 0;
      enemy.x = px + enemy.ux * enemy.dist;
      enemy.y = py + enemy.uy * enemy.dist;
      if (enemy.dist <= enemy.contactDist && player.life > 0) {
        const damageTaken = enemy.def.contactDamage;
        player.life = Math.max(0, player.life - damageTaken);
        enemy.rec.leaked = true;
        removeEnemy(enemy);
        events.push({
          type: 'playerHit',
          enemyId: enemy.id,
          damage: damageTaken,
          lifeLeft: player.life,
        });
      }
    }
  }

  // ---- Attacks, projectiles, hits and chains ----

  /** Fires every due attack, each at its own target so projectiles spread over enemies. */
  function attack(): void {
    attackTicks += 1;
    while (attackTicks >= attackInterval) {
      const target = pickTarget(enemies, player.x, player.y, projectileEstimate);
      if (target === null) {
        // Stay ready without banking attacks: fire on the tick a target appears.
        attackTicks = attackInterval - 1;
        return;
      }
      attackTicks -= attackInterval;
      target.inbound++;
      const projectile: Projectile = {
        id: nextProjectileId++,
        x: player.x,
        y: player.y,
        prevX: player.x,
        prevY: player.y,
        targetId: target.id,
        alive: true,
        target,
      };
      projectiles.push(projectile);
      events.push({ type: 'attack', projectileId: projectile.id, targetId: target.id });
    }
  }

  /** Alive enemy closest to (x, y) within chain range not hit by the current attack. */
  function nearestChainTarget(x: number, y: number): Enemy | null {
    let best: Enemy | null = null;
    let bestDistSq = chainRangeSq;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i] as Enemy;
      if (!enemy.alive || enemy.hitMark === attackSerial) continue;
      const dx = enemy.x - x;
      const dy = enemy.y - y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq || (distSq === bestDistSq && best === null)) {
        best = enemy;
        bestDistSq = distSq;
      }
    }
    return best;
  }

  /** Homes each projectile on its target, retargeting first if the target died. */
  function moveProjectiles(): void {
    for (let i = 0; i < projectiles.length; i++) {
      const projectile = projectiles[i] as Projectile;
      projectile.prevX = projectile.x;
      projectile.prevY = projectile.y;
      let target = projectile.target;
      if (!target.alive) {
        target.inbound--;
        const next = pickTarget(enemies, projectile.x, projectile.y, projectileEstimate);
        if (next === null) {
          projectile.alive = false;
          projectilesDirty = true;
          continue;
        }
        target = next;
        target.inbound++;
        projectile.target = target;
        projectile.targetId = target.id;
      }
      const dx = target.x - projectile.x;
      const dy = target.y - projectile.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist - projectileStep <= target.radius) {
        projectile.x = target.x;
        projectile.y = target.y;
        projectile.alive = false;
        projectilesDirty = true;
        target.inbound--;
        resolveAttack(target);
      } else {
        const k = projectileStep / dist;
        projectile.x += dx * k;
        projectile.y += dy * k;
      }
    }
  }

  /** Primary hit, then instant chain jumps from the last hit position. */
  function resolveAttack(primary: Enemy): void {
    attackSerial++;
    hitEnemy(primary, 0, 1, null, null);
    const jumps = chainWhole + (combatRng.chance(chainFrac) ? 1 : 0);
    let fromX = primary.x;
    let fromY = primary.y;
    let retention = 1;
    for (let k = 1; k <= jumps; k++) {
      const next = nearestChainTarget(fromX, fromY);
      if (next === null) break;
      retention *= chainRetention;
      hitEnemy(next, k, retention, fromX, fromY);
      fromX = next.x;
      fromY = next.y;
    }
  }

  function hitEnemy(
    enemy: Enemy,
    chainIndex: number,
    retention: number,
    fromX: number | null,
    fromY: number | null,
  ): void {
    const crit = combatRng.chance(critChance);
    const ignite = combatRng.chance(igniteChance);
    const baseHit = mul(damage, (crit ? critMultiplier : 1) * retention);
    const mask = HIT | (crit ? CRIT : 0) | (chainIndex > 0 ? CHAIN : 0);
    const amount = assertFinite(mul(baseHit, multAt(mask)), 'hit damage');
    enemy.hp = sub(enemy.hp, amount);
    enemy.hitMark = attackSerial;
    if (crit) damageCrit = add(damageCrit, amount);
    else if (chainIndex > 0) damageChain = add(damageChain, amount);
    else damageHit = add(damageHit, amount);
    if (gt(amount, maxHit)) maxHit = amount;
    events.push({
      type: 'hit',
      targetId: enemy.id,
      x: enemy.x,
      y: enemy.y,
      amount,
      crit,
      chainIndex,
      fromX,
      fromY,
    });
    if (lte(enemy.hp, ZERO)) {
      killEnemy(enemy);
    } else if (ignite && burnTicks > 0) {
      addBurn(enemy, mul(baseHit, burnDamage * (crit ? burnCritMult : burnMult)));
    }
  }

  // ---- Burning ----

  /** Damage of a stack between the last burn tick (or its start) and `until`. */
  function accrued(stack: BurnStack, until: number): Num {
    const ticks = Math.min(stack.end, until) - Math.max(stack.start, lastBurnTick);
    return ticks > 0 ? mul(stack.dps, ticks * DT) : ZERO;
  }

  /** Moves ended stacks into burnPending and recomputes burnNextEnd. */
  function expireBurns(enemy: Enemy): void {
    const burns = enemy.burns;
    let kept = 0;
    let nextEnd = Infinity;
    for (let r = 0; r < burns.length; r++) {
      const stack = burns[r] as BurnStack;
      if (stack.end <= now) {
        enemy.burnPending = add(enemy.burnPending, accrued(stack, stack.end));
      } else {
        burns[kept++] = stack;
        if (stack.end < nextEnd) nextEnd = stack.end;
      }
    }
    burns.length = kept;
    enemy.burnNextEnd = nextEnd;
    enemy.burnStacks = kept;
  }

  function addBurn(enemy: Enemy, dps: Num): void {
    if (now >= enemy.burnNextEnd) expireBurns(enemy);
    const burns = enemy.burns;
    const end = now + burnTicks;
    if (burns.length < burnCap) {
      burns.push({ dps, start: now, end });
      if (end < enemy.burnNextEnd) enemy.burnNextEnd = end;
    } else {
      // At the cap, replace the stack with the least remaining damage (first on ties).
      let weakest = burns[0] as BurnStack;
      let weakestLeft = mul(weakest.dps, weakest.end - now);
      for (let i = 1; i < burns.length; i++) {
        const stack = burns[i] as BurnStack;
        const left = mul(stack.dps, stack.end - now);
        if (lt(left, weakestLeft)) {
          weakest = stack;
          weakestLeft = left;
        }
      }
      enemy.burnPending = add(enemy.burnPending, accrued(weakest, now));
      weakest.dps = dps;
      weakest.start = now;
      weakest.end = end;
      let nextEnd = Infinity;
      for (let i = 0; i < burns.length; i++) {
        const stackEnd = (burns[i] as BurnStack).end;
        if (stackEnd < nextEnd) nextEnd = stackEnd;
      }
      enemy.burnNextEnd = nextEnd;
    }
    enemy.burnStacks = burns.length;
    events.push({ type: 'ignite', targetId: enemy.id, stacks: burns.length });
  }

  /** Expires stacks every tick; deals accrued burn damage every BURN_TICK_INTERVAL ticks. */
  function updateBurns(): void {
    const burnTick = now % BURN_TICK_INTERVAL === 0;
    // Children spawned by burn kills are appended past `count`; they cannot be burning yet.
    for (let i = 0, count = enemies.length; i < count; i++) {
      const enemy = enemies[i] as Enemy;
      if (!enemy.alive) continue;
      if (now >= enemy.burnNextEnd) expireBurns(enemy);
      if (!burnTick) continue;
      let amount = enemy.burnPending;
      const burns = enemy.burns;
      for (let s = 0; s < burns.length; s++) {
        amount = add(amount, accrued(burns[s] as BurnStack, now));
      }
      enemy.burnPending = ZERO;
      if (!gt(amount, ZERO)) continue;
      assertFinite(amount, 'burn damage');
      enemy.hp = sub(enemy.hp, amount);
      damageBurn = add(damageBurn, amount);
      if (gt(amount, maxHit)) maxHit = amount;
      events.push({ type: 'burnTick', targetId: enemy.id, x: enemy.x, y: enemy.y, amount });
      if (lte(enemy.hp, ZERO)) killEnemy(enemy);
    }
    if (burnTick) lastBurnTick = now;
  }

  // ---- Deaths and drops ----

  function killEnemy(enemy: Enemy): void {
    removeEnemy(enemy);
    kills++;
    const def = enemy.def;
    const shards = mul(mul(num(def.dropMult), enemy.rec.shardsPerStd), shardGain);
    const expectedCores = def.cores * coreGain;
    let cores = 0;
    if (expectedCores > 0) {
      cores = Math.floor(expectedCores);
      if (dropsRng.chance(expectedCores - cores)) cores++;
    }
    state.shards = add(state.shards, shards);
    state.cores += cores;
    events.push({
      type: 'enemyKilled',
      enemyId: enemy.id,
      enemy: def.id,
      x: enemy.x,
      y: enemy.y,
      shards,
      cores,
    });
    split(enemy);
  }

  /** Removes dead entities in place, preserving id order. */
  function compact(): void {
    if (enemiesDirty) {
      let kept = 0;
      for (let i = 0; i < enemies.length; i++) {
        const enemy = enemies[i] as Enemy;
        if (enemy.alive) enemies[kept++] = enemy;
      }
      enemies.length = kept;
      enemiesDirty = false;
    }
    if (projectilesDirty) {
      let kept = 0;
      for (let i = 0; i < projectiles.length; i++) {
        const projectile = projectiles[i] as Projectile;
        if (projectile.alive) projectiles[kept++] = projectile;
      }
      projectiles.length = kept;
      projectilesDirty = false;
    }
  }

  // ---- Run end ----

  function end(reason: EndReason): void {
    state.finished = true;
    events.push({ type: 'runEnded', reason });
    runResult = {
      startWave: startWaveNumber,
      highestWaveReached: state.highestWaveReached,
      highestWaveCleared: state.highestWaveCleared,
      clearedStartWave: startRec !== null && startRec.cleared && !startRec.leaked,
      endReason: reason,
      ticks: state.tick,
      shards: state.shards,
      cores: state.cores,
      kills,
      damage: { hit: damageHit, crit: damageCrit, burn: damageBurn, chain: damageChain },
      maxHit,
      overkillSeconds: overkillTicks / TICK_RATE,
    };
  }

  function step(_input: InputFrame): readonly SimEvent[] {
    events.length = 0;
    if (state.finished) return events;
    now = ++state.tick;

    startDueWave();
    releaseEnemies();
    moveEnemies();
    if (player.life > 0) {
      attack();
      moveProjectiles();
      updateBurns();
    }
    compact();
    updateClears();

    const wave = current;
    if (wave !== null && wave.stdHp * 10 <= expectedHit) overkillTicks++;

    if (player.life <= 0) end('death');
    else if (wave !== null && wave.wave === waveCap && open.length === 0) end('waveCap');
    else if (now >= maxTicks) end('timeout');
    return events;
  }

  return {
    state,
    step,
    result(): RunResult {
      if (runResult === null) throw new Error('result() is available once the run has finished');
      return runResult;
    },
  };
}
