/**
 * The typical hit of a run (ActiveRun.typicalHit, src/app/session.ts): the damage of a plain
 * (non-crit, non-chain) hit of its signature attack, against which the renderer sizes damage
 * numbers, screen shake and the crit hit-stop (Renderer.beginRun). The session and the replay
 * (src/app/replay) both take it from here; a character run's own rules count (compileBuild).
 */

import { compileBuild, signatureRows } from '../sim';
import type { RunConfig } from '../sim';
import type { ArcParams } from '../sim/build/compile';
import type { EmitterSpec } from '../sim/emitters/types';

export function typicalHitOf(config: RunConfig): number {
  const { stats } = config;
  // The signature attack's hit row includes Searing Crits' ×0.5, Glass Cannon's ×2 and
  // Pandemic's ×0.7. Its share of the damage stat is its payload's (emitterPayload), because
  // the renderer sizes numbers, shake and the crit hit-stop against this hit.
  const build = compileBuild(stats, config.rules, config.signature, [], config.character ?? null);
  const attack = build.emitters[0] as EmitterSpec;
  const arc = attack.kind === 'arc' ? (build.signature.arc as ArcParams) : null;
  const share = arc === null ? attack.damagePct : attack.damagePct * arc.damageMult;
  return build.values.damage * share * build.table.damage(signatureRows(build).hit);
}
