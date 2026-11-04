import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BLAST_SHAKE_CEILING,
  BLAST_SHAKE_COOLDOWN_MS,
  BLAST_SHAKE_MAX,
  CRIT_PUNCH,
  CROWD_KILL_COUNT,
  HIT_PUNCH_STRONG,
  ImpactShakes,
  PLAYER_HIT_SHAKE_COOLDOWN_MS,
} from './impact';
import { HIT_PUNCH } from './enemyView';
import { ScreenShake } from './shake';

describe('ImpactShakes', () => {
  it('kicks on a blast, then waits out its cooldown', () => {
    const shakes = new ImpactShakes();
    const first = shakes.blast(80);
    expect(first).not.toBeNull();
    expect(first?.ceiling).toBe(BLAST_SHAKE_CEILING);
    expect(shakes.blast(80)).toBeNull();
    shakes.update(BLAST_SHAKE_COOLDOWN_MS - 1);
    expect(shakes.blast(80)).toBeNull();
    shakes.update(1);
    expect(shakes.blast(80)).not.toBeNull();
  });

  it('kicks a bigger blast harder, up to the max, and ignores an empty one', () => {
    const at = (radius: number): number => {
      const shakes = new ImpactShakes();
      return shakes.blast(radius)?.amount ?? 0;
    };
    expect(at(240)).toBeGreaterThan(at(80));
    expect(at(1e9)).toBe(BLAST_SHAKE_MAX);
    expect(at(0)).toBe(0);
  });

  it('spaces the core-hit shake and thumps once a frame reaches the crowd', () => {
    const shakes = new ImpactShakes();
    expect(shakes.playerHit()).not.toBeNull();
    expect(shakes.playerHit()).toBeNull();
    shakes.update(PLAYER_HIT_SHAKE_COOLDOWN_MS);
    expect(shakes.playerHit()).not.toBeNull();
    const kicks = Array.from({ length: 12 }, (_, i) => shakes.kills(i + 1));
    expect(kicks.filter((kick) => kick !== null)).toHaveLength(1);
    expect(kicks[CROWD_KILL_COUNT - 1]).not.toBeNull();
    shakes.reset();
    expect(shakes.blast(80)).not.toBeNull();
  });

  it('keeps a stream of blasts under its ceiling, and still under reduced motion', () => {
    const shakes = new ImpactShakes();
    const shake = new ScreenShake(false, () => 0.5);
    const still = new ScreenShake(true, () => 0.5);
    for (let frame = 0; frame < 120; frame++) {
      const kick = shakes.blast(400);
      if (kick !== null) {
        shake.add(kick.amount, kick.ceiling);
        still.add(kick.amount, kick.ceiling);
      }
      shakes.update(16);
      shake.update(16);
      still.update(16);
      expect(shake.level).toBeLessThanOrEqual(BLAST_SHAKE_CEILING);
    }
    expect(still.level).toBe(0);
  });

  it('punches harder than the old hit punch, a crit harder still', () => {
    expect(HIT_PUNCH_STRONG).toBeGreaterThan(HIT_PUNCH);
    expect(CRIT_PUNCH).toBeGreaterThan(HIT_PUNCH_STRONG);
  });

  it('is wired into the renderer: blasts, core hits and crowd kills', () => {
    const source = readFileSync(new URL('renderer.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/this\.kick\(this\.impactShakes\.blast\(event\.radius\)\);/);
    expect(source).toMatch(/this\.kick\(this\.impactShakes\.playerHit\(\)\);/);
    expect(source).toMatch(/this\.kick\(this\.impactShakes\.kills\(this\.killsThisFrame\)\);/);
    expect(source).toMatch(/this\.impactShakes\.update\(dt\);/);
    expect(source).toMatch(/this\.impactShakes\.reset\(\);/);
  });
});
