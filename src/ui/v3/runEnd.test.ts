import { afterEach, describe, expect, it } from 'vitest';
import { characterGameData } from '../../data';
import { ENEMY_IDS } from '../../data/types';
import type { EnemyId } from '../../data/types';
import { setLocale } from '../../i18n';
import type { ContactTally } from '../../sim/types';
import { describeV3RunEnd } from './runEnd';
import type { V3RunEndFacts } from './runEnd';

const ENEMIES = characterGameData().enemies;

function tallies(hits: Partial<Record<EnemyId, readonly [number, number]>> = {}) {
  const by = {} as Record<EnemyId, ContactTally>;
  for (const id of ENEMY_IDS) {
    const [count, damage] = hits[id] ?? [0, 0];
    by[id] = { hits: count, damage };
  }
  return by;
}

function facts(
  overrides: Partial<V3RunEndFacts>,
  contact: Partial<Record<EnemyId, readonly [number, number]>> = {},
  bullets: Partial<Record<EnemyId, readonly [number, number]>> = {},
): V3RunEndFacts {
  const by = tallies(contact);
  const all = Object.values(by);
  return {
    endReason: 'death',
    startWave: 1,
    clearedStartWave: true,
    nextStartWave: 1,
    highestWave: 7,
    limitSec: 180,
    maxLife: 100,
    glassCannon: false,
    leaks: all.reduce((sum, tally) => sum + tally.hits, 0),
    damageTaken: all.reduce((sum, tally) => sum + tally.damage, 0),
    damageTakenBy: by,
    bulletTakenBy: tallies(bullets),
    killedBy: null,
    killedByBullet: false,
    ...overrides,
  };
}

const periodOf = (): string => {
  const b = ENEMIES.shooter.behaviour;
  if (b?.kind !== 'shoot') throw new Error('the shooter does not shoot');
  return String(Number(b.periodSec.toFixed(2)));
};

describe('describeV3RunEnd', () => {
  afterEach(() => setLocale('en'));

  it('says a bullet death in its own line, and counts the bullets apart from the leaks (Q11)', () => {
    const text = describeV3RunEnd(
      facts(
        { killedBy: 'shooter', killedByBullet: true },
        { triangle: [2, 20] },
        { shooter: [8, 80] },
      ),
      ENEMIES,
    );
    expect(text.cause).toBe("Shot down by a Shooter's bullet");
    expect(text.leaks).toBe('2 enemies reached you for 20 damage');
    expect(text.bullets).toBe('8 bullets hit you for 80 damage');
    expect(text.tip).toContain('Shooters fire from range');
    expect(text.tip).toContain(`every ${periodOf()} s`);
  });

  it('keeps the contact line for a shooter that reached the player', () => {
    const text = describeV3RunEnd(
      facts({ killedBy: 'shooter', killedByBullet: false }, { shooter: [3, 100] }),
      ENEMIES,
    );
    expect(text.cause).toBe('Killed by a Shooter');
    expect(text.bullets).toBeNull();
    expect(text.tip).not.toContain('fire from range');
  });

  it('writes the bullet lines in zh-TW', () => {
    setLocale('zh-TW');
    const text = describeV3RunEnd(
      facts({ killedBy: 'shooter', killedByBullet: true }, {}, { shooter: [1, 100] }),
      ENEMIES,
    );
    expect(text.cause).toBe('被射手的子彈擊倒');
    expect(text.bullets).toBe('被 1 發子彈打中，造成 100 點傷害');
    expect(text.tip).toContain(`每 ${periodOf()} 秒一發`);
  });

  it('names no M1 talent in its contact tips', () => {
    const text = describeV3RunEnd(
      facts({ killedBy: 'triangle' }, { triangle: [30, 100] }),
      ENEMIES,
    );
    expect(text.tip).toContain('life nodes');
    expect(text.tip).not.toContain('Vitality');
  });

  it("says the Demo's wave cap, not M1's prototype line, at the cap", () => {
    const capped = facts({ endReason: 'waveCap', highestWave: 40 });
    expect(describeV3RunEnd(capped, ENEMIES).cause).toBe(
      'Wave 40 cleared, the last wave of the demo',
    );
    expect(describeV3RunEnd(capped, ENEMIES).tip).toBeNull();
    setLocale('zh-TW');
    expect(describeV3RunEnd(capped, ENEMIES).cause).toBe('清完第 40 波，這是 Demo 的最後一波');
  });

  it('has no tip outside a death', () => {
    const text = describeV3RunEnd(facts({ endReason: 'timeout' }), ENEMIES);
    expect(text.tip).toBeNull();
    expect(text.bullets).toBeNull();
    expect(text.reflected).toBeNull();
  });

  it('says a death to 稜鏡’s reflection in its own line, counts the reflected hits and points at damage over time', () => {
    const text = describeV3RunEnd(
      facts(
        {
          killedBy: 'prism',
          killedByReflect: true,
          reflectTakenBy: tallies({ prism: [40, 100] }),
        },
        { triangle: [2, 20] },
      ),
      ENEMIES,
    );
    expect(text.cause).toBe("Cut down by a Prism's reflection");
    expect(text.leaks).toBe('2 enemies reached you for 20 damage');
    expect(text.bullets).toBeNull();
    expect(text.reflected).toBe('40 hits were reflected back at you for 100 damage');
    expect(text.tip).toContain('Prisms reflected your hits');
    expect(text.tip).toContain('Burn, poison and bleed are never reflected');
  });

  it('writes the reflection lines in zh-TW', () => {
    setLocale('zh-TW');
    const text = describeV3RunEnd(
      facts({
        killedBy: 'prism',
        killedByReflect: true,
        reflectTakenBy: tallies({ prism: [1, 100] }),
      }),
      ENEMIES,
    );
    expect(text.cause).toBe('被稜鏡反射的傷害擊倒');
    expect(text.reflected).toBe('1 次擊中被反彈回來，造成 100 點傷害');
    expect(text.tip).toContain('燃燒、中毒、流血不會被反彈');
  });

  it('keeps the contact line for a prism that reached the player', () => {
    const text = describeV3RunEnd(
      facts(
        { killedBy: 'prism', killedByReflect: false, reflectTakenBy: tallies({ prism: [3, 3] }) },
        { prism: [1, 100] },
      ),
      ENEMIES,
    );
    expect(text.cause).toBe('Killed by a Prism');
    expect(text.tip).not.toContain('reflected your hits');
  });
});
