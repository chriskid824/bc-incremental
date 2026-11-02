import { describe, expect, it } from 'vitest';
import { characterGameData } from '../../data';
import { assembleWeb, FULL_SCOPE, loadContent } from '../../data/web';
import { emptyProgress } from '../../meta/web';
import type { CharacterProgress } from '../../meta/web';
import { CharacterRunState, maxStartWave, runSeed, startWaveOf, storedPick } from './run';

const web = assembleWeb(loadContent(), 'fire', FULL_SCOPE);
const fresh = emptyProgress('fire');
const reached = (cycleBest: number): CharacterProgress => ({
  ...fresh,
  cycleBest,
  bestWave: cycleBest,
});

describe('start waves', () => {
  it('starts a fresh character at wave 1', () => {
    expect(maxStartWave(web, fresh)).toBe(1);
    expect(startWaveOf(web, fresh, null)).toBe(1);
    expect(startWaveOf(web, fresh, 7)).toBe(1);
  });

  it('follows the highest allowed wave on null and clamps a pick into range', () => {
    const progress = reached(40);
    const max = maxStartWave(web, progress);
    expect(max).toBeGreaterThan(1);
    expect(startWaveOf(web, progress, null)).toBe(max);
    expect(startWaveOf(web, progress, 3)).toBe(3);
    expect(startWaveOf(web, progress, max + 10)).toBe(max);
    expect(startWaveOf(web, progress, 0)).toBe(1);
    expect(storedPick(web, progress, max)).toBeNull();
    expect(storedPick(web, progress, 2)).toBe(2);
  });
});

describe('CharacterRunState', () => {
  it('seeds by character and run count', () => {
    expect(runSeed(fresh)).toBe(runSeed(emptyProgress('fire')));
    expect(runSeed({ ...fresh, runs: 1 })).not.toBe(runSeed(fresh));
  });

  it('plays a fresh run to its end and settles it on the progress it started from', () => {
    const run = new CharacterRunState(web, fresh, 1, characterGameData());
    expect(run.number).toBe(1);
    expect(() => run.finish()).toThrow();
    for (let i = 0; i < 200_000 && !run.finished; i++) run.step();
    const finished = run.finish();
    expect(finished.progress.runs).toBe(1);
    expect(finished.progress.bestWave).toBe(finished.result.highestWaveReached);
    expect(finished.killedByBullet).toBe(
      finished.result.endReason === 'death' && run.fatalBlow === 'bullet',
    );
    if (finished.result.endReason === 'death') expect(run.fatalBlow).not.toBeNull();
  }, 30_000);
});
