import { describe, expect, it, vi } from 'vitest';
import { loadGameData } from '../../src/data';
import { createMetaState } from '../../src/meta';
import type { MetaState } from '../../src/meta';
import {
  FRONTIER_MINUTES,
  FRONTIER_SESSIONS,
  FRONTIER_SIDES,
  FRONTIER_WAVES,
  formatReport,
  frontierConfigs,
  frontierGap,
  meanOf,
  minutesToReach,
  runFrontier,
  sessionFrontier,
} from './hiveFrontier';
import type { SideFrontier } from './hiveFrontier';
import { PRESET_SESSION } from './hivePreset';
import { runSession } from './session';
import type * as SessionModule from './session';
import type { RunRow, SessionConfig, SessionResult } from './session';

/** While set, runSession's stand-in: runFrontier's sessions without playing them. */
const stub = vi.hoisted(() => ({
  runSession: null as ((config: SessionConfig) => SessionResult) | null,
}));

vi.mock('./session', async (importOriginal) => {
  const original = await importOriginal<typeof SessionModule>();
  return {
    ...original,
    runSession: (...args: Parameters<typeof original.runSession>): SessionResult =>
      stub.runSession === null ? original.runSession(...args) : stub.runSession(args[0]),
  };
});

const SWARM = { id: 'swarm' };

/** A session whose runs reached `waves`, ending at minutes 1, 2, …; every row's maxWave 27. */
function result(waves: readonly number[], session = 0): SessionResult {
  const rows = waves.map(
    (wave, i) =>
      ({
        strategy: 'balanced',
        session,
        run: i + 1,
        minutes: i + 1,
        startWave: 13,
        highestWaveReached: wave,
        maxWave: 27,
      }) as unknown as RunRow,
  );
  return {
    strategy: 'balanced',
    session,
    rows,
    endMinutes: waves.length,
    firstNotableMinutes: null,
    firstKeystoneMinutes: null,
  };
}

/** A profile with a node, a frontier and some shards, as the preset is. */
function profile(): MetaState {
  const meta = createMetaState();
  meta.allocated.add('keenEye');
  meta.maxWave = 27;
  meta.runs = 40;
  return meta;
}

describe('hiveFrontier', () => {
  it('plays the swarm with its signature and M1 without one, in the preset session’s config', () => {
    expect(FRONTIER_SIDES.map((side) => side.name)).toEqual(['swarm', 'M1']);
    const [swarm, m1] = FRONTIER_SIDES.map((side) => frontierConfigs(side, profile));
    const expected = (session: number) => ({
      ...PRESET_SESSION,
      session,
      minutes: FRONTIER_MINUTES,
      initialMeta: profile(),
    });
    expect(swarm).toEqual([0, 1].map((session) => ({ ...expected(session), signature: SWARM })));
    expect(m1).toEqual([0, 1].map(expected));
    for (const config of m1 ?? []) expect('signature' in config).toBe(false);
    expect([FRONTIER_SESSIONS, FRONTIER_MINUTES, FRONTIER_WAVES]).toEqual([2, 10, [20, 30]]);
  });

  it('starts every session from a profile of its own', () => {
    let loads = 0;
    const load = (): MetaState => {
      loads++;
      return profile();
    };
    const configs = FRONTIER_SIDES.flatMap((side) => frontierConfigs(side, load));
    expect(loads).toBe(4);
    const metas = configs.map((config) => config.initialMeta as MetaState);
    expect(new Set(metas).size).toBe(4);
    // A change to one profile reaches no other session.
    metas[0]?.allocated.add('sharpen');
    (metas[0] as MetaState).maxWave = 40;
    for (const meta of metas.slice(1)) expect(meta).toEqual(profile());
  });

  it('reads the frontier and the minutes to a wave from the waves the runs reached, not maxWave', () => {
    const r = result([12, 18, 21, 19, 31]);
    expect(minutesToReach(r, 20)).toBe(3);
    expect(minutesToReach(r, 21)).toBe(3);
    expect(minutesToReach(r, 30)).toBe(5);
    expect(minutesToReach(r, 32)).toBeNull();
    expect(minutesToReach(r, 1)).toBe(1);
    expect(sessionFrontier(result([12, 18, 21, 19, 31], 1))).toEqual({
      session: 1,
      frontier: 31,
      minutesTo: [3, 5],
      runs: 5,
      startWave: 13,
    });
    expect(sessionFrontier(result([14, 14, 13])).minutesTo).toEqual([null, null]);
    expect([meanOf([3, 4]), meanOf([3, null]), meanOf([])]).toEqual([3.5, null, null]);
  });

  it('takes a session’s frontier as the highest wave its runs reached, not its last run’s', () => {
    // A session's last run can stop short: its minutes run out mid-run.
    expect(sessionFrontier(result([12, 31, 18])).frontier).toBe(31);
    const sides: SideFrontier[] = [
      { name: 'swarm', sessions: [sessionFrontier(result([12, 25, 14]))] },
      { name: 'M1', sessions: [sessionFrontier(result([31, 30]))] },
    ];
    expect(frontierGap(sides)).toBe(6);
  });

  it('labels each side with its own sessions and gives the gap as M1’s frontier less the swarm’s', () => {
    const sides: SideFrontier[] = [
      {
        name: 'swarm',
        sessions: [sessionFrontier(result([12, 14])), sessionFrontier(result([13, 15], 1))],
      },
      {
        name: 'M1',
        sessions: [sessionFrontier(result([25, 31])), sessionFrontier(result([22, 30], 1))],
      },
    ];
    expect(frontierGap(sides)).toBe(16);
    expect(frontierGap([...sides].reverse())).toBe(16);
    const lines = formatReport(sides);
    expect(lines.find((line) => line.startsWith('swarm') && line.includes('mean'))).toMatch(
      /^swarm\s+mean\s+14\.5\s+—\s+—$/,
    );
    expect(lines.find((line) => line.startsWith('M1') && line.includes('mean'))).toMatch(
      /^M1\s+mean\s+30\.5\s+1\.00\s+2\.00$/,
    );
    expect(lines.at(-1)).toBe(
      'gap (M1 − swarm, mean frontier): 16.0 waves, more than 5: Q5 (A) calls for C5.R',
    );
    const close: SideFrontier[] = [
      { name: 'swarm', sessions: [sessionFrontier(result([26]))] },
      { name: 'M1', sessions: [sessionFrontier(result([31]))] },
    ];
    expect(formatReport(close).at(-1)).toBe(
      'gap (M1 − swarm, mean frontier): 5.0 waves, within 5: no C5.R under Q5 (A)',
    );
  });

  it('plays the swarm’s sessions with the swarm: its runs deal other damage than M1’s from one profile', () => {
    // A one-minute session of each side's first config.
    const data = loadGameData();
    const [swarm, m1] = FRONTIER_SIDES.map((side) => {
      const config = frontierConfigs(side, profile)[0] as SessionConfig;
      return runSession({ ...config, minutes: 1 }, data);
    });
    const first = (r: SessionResult | undefined): RunRow => r?.rows[0] as RunRow;
    expect(first(swarm).startWave).toBe(first(m1).startWave);
    expect(first(swarm).dmgHit).not.toBe(first(m1).dmgHit);
  });

  it('plays each side’s own sessions in runFrontier and labels them with its name: the gap is M1’s less the swarm’s', () => {
    const played: string[] = [];
    stub.runSession = (config) => {
      const side = config.signature?.id ?? 'M1';
      played.push(`${side}/${config.session}`);
      return result(side === 'swarm' ? [14, 16] : [25, 30], config.session);
    };
    try {
      const sides = runFrontier(loadGameData(), profile);
      expect(played).toEqual(['swarm/0', 'swarm/1', 'M1/0', 'M1/1']);
      expect(sides.map((side) => [side.name, side.sessions.map((s) => s.frontier)])).toEqual([
        ['swarm', [16, 16]],
        ['M1', [30, 30]],
      ]);
      expect(frontierGap(sides)).toBe(14);
    } finally {
      stub.runSession = null;
    }
  });
});
