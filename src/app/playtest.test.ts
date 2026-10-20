import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { createMetaState } from '../meta';
import { TICK_RATE } from '../sim';
import {
  allocatedKeystones,
  archetypePoints,
  feedbackLink,
  playtestFirestore,
  runEndFields,
  sessionEndFields,
  sessionStartFields,
} from './playtest';
import { Session } from './session';
import type { RunReport } from './session';

const data = loadGameData();

function metaWith(nodes: readonly string[], might = 0) {
  const meta = createMetaState();
  for (const id of nodes) meta.allocated.add(id);
  if (might > 0) meta.ranks.set('might', might);
  return meta;
}

describe('playtest events', () => {
  it('counts allocated nodes per archetype, with Might ranks apart', () => {
    const meta = metaWith(['keenEye', 'sharpen', 'kindling', 'spark', 'glassCannon'], 7);
    expect(archetypePoints(meta, data)).toEqual({ crit: 2, dot: 1, chain: 1, hybrid: 0, none: 1 });
    expect(allocatedKeystones(meta, data)).toEqual(['glassCannon']);
    const fields = sessionStartFields(meta, data, 61.4, { width: 1600, height: 900 });
    expect(fields).toMatchObject({ runs: 0, play: 61, ranks: { might: 7 }, width: 1600 });
  });

  it('describes a finished run with the talents it was played with', () => {
    const meta = createMetaState();
    let report: RunReport | null = null;
    const session = new Session(data, meta, {
      runStarted: () => undefined,
      runFinished: (r) => (report = r),
      talentsOpened: () => undefined,
      profileChanged: () => undefined,
    });
    session.start();
    while (session.phase === 'running') session.step();
    const finished = report as RunReport | null;
    if (finished === null) throw new Error('run did not finish');
    const fields = runEndFields(finished, meta, data, 75.6);
    expect(fields).toMatchObject({
      run: 1,
      startWave: 1,
      wave: finished.result.highestWaveReached,
      end: finished.result.endReason,
      kills: finished.result.kills,
      seconds: Math.round((finished.result.ticks / TICK_RATE) * 10) / 10,
      play: 76,
      keystones: [],
      points: { crit: 0, dot: 0, chain: 0, hybrid: 0, none: 0 },
    });
    expect(fields['dps']).toBeGreaterThan(0);
    expect(fields['shards']).toBeGreaterThan(0);
    // Everything must survive JSON (the local log) and Firestore (no Num objects).
    expect(JSON.parse(JSON.stringify(fields))).toEqual(fields);
  });

  it('records the exit screen', () => {
    expect(sessionEndFields('running', 4, 12, 300.2)).toEqual({
      screen: 'running',
      run: 4,
      wave: 12,
      play: 300,
    });
  });

  it('puts the install id into the survey link, or has no link', () => {
    expect(feedbackLink('a b', 'https://forms.example/viewform?entry.1=INSTALL_ID')).toBe(
      'https://forms.example/viewform?entry.1=a%20b',
    );
    expect(feedbackLink('x', '')).toBeNull();
  });

  it('sends events from a release build only: none from the dev server, none under ?hive', () => {
    const firestore = { projectId: 'playtest', apiKey: 'web-key' };
    expect(playtestFirestore(firestore, false, false)).toBe(firestore);
    expect(playtestFirestore(firestore, false, true)).toBeNull();
    expect(playtestFirestore(firestore, true, false)).toBeNull();
    expect(playtestFirestore(firestore, true, true)).toBeNull();
    expect(playtestFirestore(null, false, false)).toBeNull();
  });
});
