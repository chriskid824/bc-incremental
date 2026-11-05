/**
 * The barrage grant's data (E10a, lead ruling W1; src/data/emitters.ts BarrageGrant): its schema
 * (GRANT_SCHEMAS.barrage, src/data/schema.ts), its check (src/data/validate.ts grantIssues) and
 * its key. The rider it makes is src/sim/systems/barrage.ts's; its compile is
 * src/sim/systems/barrage.test.ts's.
 */

import { describe, expect, it } from 'vitest';
import { BARRAGE_DAMAGE_PCT, grantKey } from './emitters';
import type { EmitterGrant } from './emitters';
import { EmitterGrantSchema, GRANT_SCHEMAS } from './schema';
import { grantConflicts, nodeEffectIssues } from './validate';

/** The issues of a node holding these grants alone. */
const issuesOf = (...emitters: EmitterGrant[]): string[] =>
  nodeEffectIssues("talent 'outer.barrage.entry'", {
    modifiers: [],
    triggers: [],
    conversions: [],
    emitters,
    rules: [],
  });

describe('the barrage grant (W1)', () => {
  it('parses with or without its share, through its own schema too', () => {
    for (const grant of [{ kind: 'barrage' }, { kind: 'barrage', damagePct: 0.25 }]) {
      expect(EmitterGrantSchema.parse(grant)).toEqual(grant);
      expect(GRANT_SCHEMAS.barrage.parse(grant)).toEqual(grant);
    }
    // validate.ts rejects a share not above 0, not the schema.
    expect(EmitterGrantSchema.parse({ kind: 'barrage', damagePct: -1 })).toEqual({
      kind: 'barrage',
      damagePct: -1,
    });
  });

  it.each([
    ['a share that is not a number', { kind: 'barrage', damagePct: '0.25' }],
    ['a share that is NaN', { kind: 'barrage', damagePct: NaN }],
    ['a share that is not finite', { kind: 'barrage', damagePct: Infinity }],
    ['the gap map’s name, dropped (W1)', { kind: 'barrage', name: 'side' }],
    ['a count, which is the barrageCount stat’s', { kind: 'barrage', count: 2 }],
    ['a pierce, which is the barragePierce stat’s', { kind: 'barrage', pierce: 1 }],
  ])('rejects %s', (_label, grant) => {
    expect(EmitterGrantSchema.safeParse(grant).success).toBe(false);
    expect(GRANT_SCHEMAS.barrage.safeParse(grant).success).toBe(false);
  });

  it('accepts a share above 0 or none, and refuses 0, below 0, NaN and Infinity, naming it', () => {
    expect(issuesOf({ kind: 'barrage' })).toEqual([]);
    expect(issuesOf({ kind: 'barrage', damagePct: 0.25 })).toEqual([]);
    expect(issuesOf({ kind: 'barrage', damagePct: 1e-6 })).toEqual([]);
    expect(
      issuesOf(
        { kind: 'barrage', damagePct: 0 },
        { kind: 'barrage', damagePct: -0.25 },
        { kind: 'barrage', damagePct: NaN },
        { kind: 'barrage', damagePct: Infinity },
      ),
    ).toEqual([
      "talent 'outer.barrage.entry': emitters[0] damagePct must be finite and > 0 (got 0)",
      "talent 'outer.barrage.entry': emitters[1] damagePct must be finite and > 0 (got -0.25)",
      "talent 'outer.barrage.entry': emitters[2] damagePct must be finite and > 0 (got NaN)",
      "talent 'outer.barrage.entry': emitters[3] damagePct must be finite and > 0 (got Infinity)",
    ]);
  });

  it('defaults its share to 副彈’s 25% and has no key: one per source, nodes of it agreeing', () => {
    expect(BARRAGE_DAMAGE_PCT).toBe(0.25);
    expect(grantKey({ kind: 'barrage' })).toBe('');
    expect(grantKey({ kind: 'barrage', damagePct: 0.5 })).toBe('');
    const node = (id: string, grant: EmitterGrant) => ({ id, emitters: [grant] });
    expect(
      grantConflicts([
        node('outer.barrage.entry', { kind: 'barrage' }),
        node('outer.barrage.more', { kind: 'barrage' }),
      ]),
    ).toEqual([]);
    expect(
      grantConflicts([
        node('outer.barrage.entry', { kind: 'barrage' }),
        node('outer.barrage.more', { kind: 'barrage', damagePct: 0.5 }),
      ]),
    ).toEqual([
      "talents: emitter barrage '' is granted twice by source 'outer.barrage' with different " +
        'fields; keep it on one node',
    ]);
  });
});
