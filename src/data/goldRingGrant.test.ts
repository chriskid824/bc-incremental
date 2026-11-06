/**
 * 金山's gold ring grant's data (E17, lead ruling G1; src/data/emitters.ts GoldRingGrant): its
 * schema (GRANT_SCHEMAS.goldRing, src/data/schema.ts), its check (src/data/validate.ts grantIssues,
 * by goldRingIssues), its key and grantConflicts on it. Its compile and its drop are
 * src/sim/systems/goldRing.test.ts's.
 */

import { describe, expect, it } from 'vitest';
import { goldRingIssues, grantKey } from './emitters';
import type { EmitterGrant, GoldRingGrant } from './emitters';
import { EmitterGrantSchema, GRANT_SCHEMAS } from './schema';
import { grantConflicts, nodeEffectIssues } from './validate';

/** The issues of a node holding these grants alone. */
const issuesOf = (...emitters: EmitterGrant[]): string[] =>
  nodeEffectIssues("talent 'outer.greed.threshold'", {
    modifiers: [],
    triggers: [],
    conversions: [],
    emitters,
    rules: [],
  });

const ring = (radius: number, dropPct: number): GoldRingGrant => ({
  kind: 'goldRing',
  radius,
  dropPct,
});

describe('the gold ring grant (G1)', () => {
  it('parses with its radius and its share, through its own schema too', () => {
    const grant = { kind: 'goldRing', radius: 200, dropPct: 0.5 };
    expect(EmitterGrantSchema.parse(grant)).toEqual(grant);
    expect(GRANT_SCHEMAS.goldRing.parse(grant)).toEqual(grant);
    // validate.ts refuses a radius or a share not above 0, not the schema.
    expect(EmitterGrantSchema.parse({ kind: 'goldRing', radius: -1, dropPct: 0 })).toEqual({
      kind: 'goldRing',
      radius: -1,
      dropPct: 0,
    });
  });

  it.each([
    ['no radius', { kind: 'goldRing', dropPct: 0.5 }],
    ['no share', { kind: 'goldRing', radius: 200 }],
    ['a radius that is not a number', { kind: 'goldRing', radius: '200', dropPct: 0.5 }],
    ['a share that is not a number', { kind: 'goldRing', radius: 200, dropPct: '50%' }],
    ['a radius that is NaN', { kind: 'goldRing', radius: NaN, dropPct: 0.5 }],
    ['a share that is NaN', { kind: 'goldRing', radius: 200, dropPct: NaN }],
    ['a radius that is not finite', { kind: 'goldRing', radius: Infinity, dropPct: 0.5 }],
    ['a share that is not finite', { kind: 'goldRing', radius: 200, dropPct: -Infinity }],
    ['an extra key', { kind: 'goldRing', radius: 200, dropPct: 0.5, growth: 1 }],
    [
      'an areaSize scaling, which G3 refuses',
      { kind: 'goldRing', radius: 200, dropPct: 0.5, sized: true },
    ],
  ])('rejects %s', (_label, grant) => {
    // Planted bug: the schema not strict (an extra key accepted).
    expect(EmitterGrantSchema.safeParse(grant).success).toBe(false);
    expect(GRANT_SCHEMAS.goldRing.safeParse(grant).success).toBe(false);
  });

  it('accepts a radius and a share above 0, and refuses radius 0, −1, NaN and dropPct 0, −0.5, NaN, naming each', () => {
    // Planted bug 7: dropPct 0 or negative accepted; and a radius not above 0 accepted.
    expect(issuesOf(ring(200, 0.5))).toEqual([]);
    expect(issuesOf(ring(1e-6, 1e-6))).toEqual([]);
    expect(issuesOf(ring(5000, 10))).toEqual([]);
    expect(
      issuesOf(
        ring(0, 0.5),
        ring(-1, 0.5),
        ring(NaN, 0.5),
        ring(Infinity, 0.5),
        ring(200, 0),
        ring(200, -0.5),
        ring(200, NaN),
        ring(200, Infinity),
        ring(-0, -0),
      ),
    ).toEqual([
      "talent 'outer.greed.threshold': emitters[0] radius must be finite and > 0 (got 0)",
      "talent 'outer.greed.threshold': emitters[1] radius must be finite and > 0 (got -1)",
      "talent 'outer.greed.threshold': emitters[2] radius must be finite and > 0 (got NaN)",
      "talent 'outer.greed.threshold': emitters[3] radius must be finite and > 0 (got Infinity)",
      "talent 'outer.greed.threshold': emitters[4] dropPct must be finite and > 0 (got 0)",
      "talent 'outer.greed.threshold': emitters[5] dropPct must be finite and > 0 (got -0.5)",
      "talent 'outer.greed.threshold': emitters[6] dropPct must be finite and > 0 (got NaN)",
      "talent 'outer.greed.threshold': emitters[7] dropPct must be finite and > 0 " +
        '(got Infinity)',
      "talent 'outer.greed.threshold': emitters[8] radius must be finite and > 0 (got 0)",
      "talent 'outer.greed.threshold': emitters[8] dropPct must be finite and > 0 (got 0)",
    ]);
  });

  it('checks both fields in goldRingIssues, which compileBuild asks too', () => {
    expect(goldRingIssues(ring(200, 0.5))).toEqual([]);
    expect(goldRingIssues(ring(Number.MIN_VALUE, Number.MIN_VALUE))).toEqual([]);
    expect(goldRingIssues(ring(0, -0.5))).toEqual([
      'radius must be finite and > 0 (got 0)',
      'dropPct must be finite and > 0 (got -0.5)',
    ]);
  });

  it('has no key: one ring a source, nodes of it agreeing, refused at load when they differ', () => {
    // Planted bug 6 (at load): two different rings of one source silently combined.
    expect(grantKey(ring(200, 0.5))).toBe('');
    expect(grantKey(ring(300, 1))).toBe('');
    const node = (id: string, grant: EmitterGrant) => ({ id, emitters: [grant] });
    expect(
      grantConflicts([
        node('outer.greed.threshold', ring(200, 0.5)),
        node('outer.greed.more', ring(200, 0.5)),
      ]),
    ).toEqual([]);
    expect(
      grantConflicts([
        node('outer.greed.threshold', ring(200, 0.5)),
        node('outer.greed.more', ring(250, 0.5)),
      ]),
    ).toEqual([
      "talents: emitter goldRing '' is granted twice by source 'outer.greed' with different " +
        'fields; keep it on one node',
    ]);
    // Two sources are compileBuild's to refuse when they differ (compileGoldRing), not the
    // data's: a source's nodes alone are checked here.
    expect(
      grantConflicts([
        node('outer.greed.threshold', ring(200, 0.5)),
        node('fusion.fire.greed.core', ring(200, 0.25)),
      ]),
    ).toEqual([]);
  });
});
