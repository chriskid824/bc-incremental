/**
 * V9 on the fixture (docs/v3 C6 design §4.8, D26, F21; S-2): calibrationIssues against a fully
 * calibrated fixture, which passes in every scope, and against each way an entry goes wrong: a
 * missing entry, a stale digest, an entry calibrated for another fusion's digest, a FAIL with no
 * ACCEPTED_FAILS reason, each with its golden message. The registered content's V9 is in
 * content.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../sources';
import { assembleWeb } from './assemble';
import { DEMO_SCOPE_A, FULL_SCOPE, SCOPES } from './scope';
import { fixtureContent } from './testing';
import { CALIBRATION_STATUSES } from './types';
import type { CalibrationEntry, CalibrationStatus, Content, FusionKey, WebScope } from './types';
import { calibrationIssues } from './validate';

/** Every fusion of the full fixture, by key, with the digest it assembles with. */
function fixtureDigests(content: Content): Map<FusionKey, string> {
  const digests = new Map<FusionKey, string>();
  for (const c of CHARACTER_IDS) {
    for (const fusion of assembleWeb(content, c, FULL_SCOPE).fusions.values()) {
      digests.set(fusion.key, fusion.digest);
    }
  }
  return digests;
}

const entry = (digest: string, status: CalibrationStatus = 'ok'): CalibrationEntry => ({
  coef: 1.42,
  status,
  median: 1.2,
  min: 1.13,
  max: 1.27,
  seeds: 8,
  startWave: 1,
  digest,
});

/** The full fixture with an ok entry for each of its 44 fusions, then `patch` on top. */
function calibrated(
  patch: (entries: Partial<Record<FusionKey, CalibrationEntry>>) => void = () => undefined,
  acceptedFails: Partial<Record<FusionKey, string>> = {},
): Content {
  const content = fixtureContent();
  const entries: Partial<Record<FusionKey, CalibrationEntry>> = {};
  for (const [key, digest] of fixtureDigests(content)) entries[key] = entry(digest);
  patch(entries);
  return { ...content, calibrated: entries, acceptedFails };
}

const messages = (content: Content, scope: WebScope = FULL_SCOPE): string[] =>
  calibrationIssues(content, scope).map((issue) => issue.message);

const CRIT = 'fire.crit' satisfies FusionKey;
/** fire.crit's digest in the fixture (generate.ts' fusionDigest of its inputs). */
const CRIT_DIGEST = '6bf6691e233c4ccd';

describe('V9: calibrationIssues on the fixture (S-2)', () => {
  it('passes the fully calibrated fixture in every scope', () => {
    const content = calibrated();
    expect(Object.keys(content.calibrated)).toHaveLength(44);
    for (const scope of SCOPES) expect(calibrationIssues(content, scope)).toEqual([]);
  });

  it("reads each fusion's digest as assembled, whatever coef it was calibrated at", () => {
    const content = fixtureContent();
    expect(fixtureDigests(content).get(CRIT)).toBe(CRIT_DIGEST);
    // The assembled web reads the entry's coef; the digest leaves the coef out (F28).
    const at = calibrated((entries) => {
      entries[CRIT] = { ...entry(CRIT_DIGEST), coef: 3.7 };
    });
    expect(assembleWeb(at, 'fire', FULL_SCOPE).fusions.get('crit')?.coef).toBe(3.7);
    expect(messages(at)).toEqual([]);
  });

  it('fails a missing entry, beside the fusion core', () => {
    const content = calibrated((entries) => {
      delete entries[CRIT];
    });
    expect(calibrationIssues(content, FULL_SCOPE)).toEqual([
      {
        file: 'src/data/fusion/calibrated.ts',
        node: 'fusion.fire.crit.core',
        message:
          "fusion 'fire.crit' (src/data/fusion/calibrated.ts): has no CALIBRATED entry; " +
          'run npm run calibrate -- --only fire.crit',
      },
    ]);
    // The uncalibrated fixture misses every fusion's entry.
    const bare = calibrationIssues(fixtureContent(), FULL_SCOPE);
    expect(bare).toHaveLength(44);
    expect(bare.every((issue) => issue.message.includes(': has no CALIBRATED entry; '))).toBe(true);
  });

  it('fails a stale digest with both digests, as §4.8 prints them', () => {
    const content = calibrated((entries) => {
      entries[CRIT] = entry('3f9a0c1d55aa77bb');
    });
    expect(messages(content)).toEqual([
      "fusion 'fire.crit' (src/data/fusion/calibrated.ts): calibrated for digest 3f9a0c1d…, " +
        'its inputs now hash to 6bf6691e…; run npm run calibrate -- --only fire.crit',
    ]);
  });

  it("fails an entry calibrated for another fusion's digest, in every scope that holds it", () => {
    const others = [...fixtureDigests(fixtureContent())].filter(
      ([key]) => key !== CRIT && key.startsWith('fire.'),
    );
    expect(others).toHaveLength(10);
    for (const [other, digest] of others) {
      const content = calibrated((entries) => {
        entries[CRIT] = entry(digest);
      });
      for (const scope of SCOPES) {
        expect(messages(content, scope), `${other} in ${scope.name}`).toEqual([
          `fusion 'fire.crit' (src/data/fusion/calibrated.ts): calibrated for digest ` +
            `${digest.slice(0, 8)}…, its inputs now hash to 6bf6691e…; run npm run calibrate -- ` +
            '--only fire.crit',
        ]);
      }
    }
  });

  it('makes an entry stale when the fusion it was calibrated for changes', () => {
    const content = calibrated();
    const changed: Content = {
      ...content,
      overrides: { ...content.overrides, [CRIT]: { bonus: null } },
    };
    const digest = assembleWeb(changed, 'fire', FULL_SCOPE).fusions.get('crit')?.digest as string;
    expect(digest).not.toBe(CRIT_DIGEST);
    expect(messages(changed)).toEqual([
      "fusion 'fire.crit' (src/data/fusion/calibrated.ts): calibrated for digest 6bf6691e…, " +
        `its inputs now hash to ${digest.slice(0, 8)}…; run npm run calibrate -- --only fire.crit`,
    ]);
  });

  it('fails a FAIL with no ACCEPTED_FAILS reason, and passes it with one', () => {
    const weak = (reasons: Partial<Record<FusionKey, string>> = {}) =>
      calibrated((entries) => {
        entries[CRIT] = {
          ...entry(CRIT_DIGEST, 'weak'),
          coef: 10,
          median: 1.08,
          min: 1.04,
          max: 1.11,
        };
      }, reasons);
    expect(messages(weak())).toEqual([
      "fusion 'fire.crit' (src/data/fusion/calibrated.ts): calibrated weak at coef 10 " +
        '(median 1.08, seeds 1.04 to 1.11); a FAIL lands only with its reason in ACCEPTED_FAILS ' +
        '(src/data/fusion/overrides.ts), or rework the fusion and run npm run calibrate -- ' +
        '--only fire.crit',
    ]);
    expect(messages(weak({ [CRIT]: 'crits do not scale with burn yet; B4 reworks it' }))).toEqual(
      [],
    );
    // A blank reason is none.
    expect(messages(weak({ [CRIT]: '  ' }))).toHaveLength(1);
    // Another fusion's reason is not this one's.
    expect(messages(weak({ 'fire.poison': 'accepted' }))).toHaveLength(1);
  });

  it.each(CALIBRATION_STATUSES.filter((status) => status !== 'ok'))(
    'fails status %s without a reason (every status but ok is a FAIL)',
    (status) => {
      const content = calibrated((entries) => {
        entries[CRIT] = entry(CRIT_DIGEST, status);
      });
      expect(messages(content)).toEqual([
        `fusion 'fire.crit' (src/data/fusion/calibrated.ts): calibrated ${status} at coef 1.42 ` +
          '(median 1.2, seeds 1.13 to 1.27); a FAIL lands only with its reason in ' +
          'ACCEPTED_FAILS (src/data/fusion/overrides.ts), or rework the fusion and run npm run ' +
          'calibrate -- --only fire.crit',
      ]);
      const accepted = { ...content, acceptedFails: { [CRIT]: 'accepted for the batch' } };
      expect(messages(accepted)).toEqual([]);
    },
  );

  it('lets a reason excuse a status only, never a stale or missing entry', () => {
    const reasons = { [CRIT]: 'accepted for the batch' };
    const stale = calibrated((entries) => {
      entries[CRIT] = entry('0000000000000000');
    }, reasons);
    expect(messages(stale)).toEqual([
      expect.stringContaining('calibrated for digest 00000000…, its inputs now hash to 6bf6691e…'),
    ]);
    const staleFail = calibrated((entries) => {
      entries[CRIT] = entry('0000000000000000', 'strong');
    }, reasons);
    expect(messages(staleFail)).toEqual([expect.stringContaining('calibrated for digest')]);
    const missing = calibrated((entries) => {
      delete entries[CRIT];
    }, reasons);
    expect(messages(missing)).toEqual([expect.stringContaining('has no CALIBRATED entry')]);
  });

  it("checks only the fusions the scope assembles, each scope's own", () => {
    // fire.bleed is assembled in the full scope only; demoA holds fire's poison, crit, ice and
    // summon fusions and the hive's fire, poison, crit and ice, in clock order.
    const content = calibrated((entries) => {
      delete entries['fire.bleed'];
      delete entries['summon.poison'];
    });
    expect(messages(content, FULL_SCOPE)).toEqual([
      expect.stringContaining("fusion 'fire.bleed'"),
      expect.stringContaining("fusion 'summon.poison'"),
    ]);
    expect(messages(content, DEMO_SCOPE_A)).toEqual([
      expect.stringContaining("fusion 'summon.poison'"),
    ]);
    const uncalibrated = calibrationIssues(fixtureContent(), DEMO_SCOPE_A);
    expect(uncalibrated.map((issue) => issue.node)).toEqual([
      'fusion.fire.poison.core',
      'fusion.fire.crit.core',
      'fusion.fire.ice.core',
      'fusion.fire.summon.core',
      'fusion.summon.fire.core',
      'fusion.summon.poison.core',
      'fusion.summon.crit.core',
      'fusion.summon.ice.core',
    ]);
    // A deferred fusion is not assembled, so V9 leaves it alone.
    const deferred: WebScope = { ...FULL_SCOPE, name: 'cut', deferredFusions: ['fire.bleed'] };
    expect(messages(content, deferred)).toEqual([expect.stringContaining("'summon.poison'")]);
  });

  it('skips a character whose center is null, as loadContent does (N-6)', () => {
    const b1 = fixtureContent('B1');
    expect(calibrationIssues(b1, FULL_SCOPE).map((issue) => issue.node)).toEqual([
      'fusion.fire.poison.core',
      'fusion.fire.crit.core',
      'fusion.fire.ice.core',
      'fusion.fire.summon.core',
    ]);
  });
});
