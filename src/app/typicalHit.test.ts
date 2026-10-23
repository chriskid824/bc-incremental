import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { createMetaState } from '../meta';
import { compileBuild, signatureRows } from '../sim';
import type { CompiledBuild, RunConfig } from '../sim';
import type { ArcParams } from '../sim/build/compile';
import type { EmitterSpec } from '../sim/emitters/types';
import { makeConfig, makeStats } from '../sim/testing';
import { Session } from './session';
import { typicalHitOf } from './typicalHit';

/** The lines of session.ts' block that C10.5a moved, after its compileBuild call (verbatim). */
function hitOf(build: CompiledBuild): number {
  const attack = build.emitters[0] as EmitterSpec;
  const arc = attack.kind === 'arc' ? (build.signature.arc as ArcParams) : null;
  const share = arc === null ? attack.damagePct : attack.damagePct * arc.damageMult;
  return build.values.damage * share * build.table.damage(signatureRows(build).hit);
}

/**
 * A 熔核 character run with GOLDEN-C4's v3fire rules at the center and its v3summon's glassCannon
 * on the hub, which doubles the hit's damage.
 */
const CHARACTER_CONFIG: RunConfig = makeConfig({
  stats: makeStats({ damage: 8, attackSpeed: 6, projectileCount: 2, critChance: 0.2 }),
  signature: { id: 'magmaBomb' },
  character: {
    id: 'fire',
    rules: [
      { source: 'center', spec: { id: 'eternalFlame', durationMore: 0.5 }, coef: 1 },
      {
        source: 'center',
        spec: { id: 'volcano', periodSec: 1, radiusMult: 2, damageMult: 3 },
        coef: 1,
      },
      { source: 'hub', spec: { id: 'glassCannon', damageMore: 1 }, coef: 1 },
    ],
  },
});

describe('typicalHitOf (src/app/session.ts block moved, docs/v3 C10 design §2.5)', () => {
  it("equals session.ts' former inline value on M1's first run", () => {
    const data = loadGameData();
    const session = new Session(data, createMetaState(), {
      runStarted: () => undefined,
      runFinished: () => undefined,
      talentsOpened: () => undefined,
      profileChanged: () => undefined,
    });
    session.start();
    const { config, typicalHit } = session.run;
    // The block's own call, before the move: no test modules, no character.
    const inline = hitOf(compileBuild(config.stats, config.rules, config.signature));
    expect(inline).toBeGreaterThan(0);
    expect(typicalHitOf(config)).toBe(inline);
    expect(typicalHit).toBe(inline);
  });

  it("counts a character run's own rules (compileBuild with config.character)", () => {
    const { stats, rules, signature, character } = CHARACTER_CONFIG;
    const withCharacter = hitOf(compileBuild(stats, rules, signature, [], character ?? null));
    const without = hitOf(compileBuild(stats, rules, signature));
    // glassCannon's damage reaches the hit, so leaving the character out would halve the number.
    expect(withCharacter).toBe(2 * without);
    expect(typicalHitOf(CHARACTER_CONFIG)).toBe(withCharacter);
  });
});
