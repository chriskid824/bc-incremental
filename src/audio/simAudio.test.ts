import { describe, expect, it } from 'vitest';
import { ZERO } from '../core/num';
import type { SimEvent } from '../sim/types';
import type { CueId } from './cues';
import type { PlayOptions } from './engine';
import { explosionOptions, SimAudio } from './simAudio';
import type { CuePlayer } from './simAudio';

class Recorder implements CuePlayer {
  readonly plays: { cue: CueId; options: PlayOptions | undefined }[] = [];
  play(cue: CueId, options?: PlayOptions): boolean {
    this.plays.push({ cue, options });
    return true;
  }
  cues(): CueId[] {
    return this.plays.map((play) => play.cue);
  }
}

const hit = (crit: boolean, chainIndex = 0): SimEvent => ({
  type: 'hit',
  targetId: 1,
  x: 0,
  y: 0,
  amount: ZERO,
  tags: 0,
  source: 0,
  crit,
  chainIndex,
  fromX: null,
  fromY: null,
});
const kill = (enemy = 'circle'): SimEvent =>
  ({ type: 'enemyKilled', enemyId: 1, enemy, x: 0, y: 0, shards: ZERO, cores: 0 }) as SimEvent;
const explosion = (radius: number): SimEvent => ({
  type: 'explosion',
  x: 0,
  y: 0,
  radius,
  primaryId: 1,
  count: 3,
});

describe('SimAudio', () => {
  it('plays each cue at most once a tick', () => {
    const recorder = new Recorder();
    const audio = new SimAudio(recorder);
    audio.handleEvents([
      hit(false),
      hit(false),
      kill(),
      kill(),
      kill(),
      explosion(40),
      explosion(120),
      { type: 'lob', id: 1, fromX: 0, fromY: 0, x: 1, y: 1, landAt: 9, form: 0 },
      { type: 'lob', id: 2, fromX: 0, fromY: 0, x: 1, y: 1, landAt: 9, form: 0 },
    ]);
    expect(recorder.cues().sort()).toEqual(['explosion', 'hit', 'kill', 'lob']);
    // The biggest blast of the tick sets the sound.
    expect(recorder.plays.find((p) => p.cue === 'explosion')?.options).toEqual(
      explosionOptions(120, 2),
    );
  });

  it('plays a crit instead of the plain hit, and nothing for chain jumps alone', () => {
    const recorder = new Recorder();
    const audio = new SimAudio(recorder);
    audio.handleEvents([hit(false), hit(true)]);
    audio.handleEvents([hit(false, 2)]);
    expect(recorder.cues()).toEqual(['crit']);
  });

  it('maps the rest of the events to their cues', () => {
    const recorder = new Recorder();
    const audio = new SimAudio(recorder);
    audio.handleEvents([{ type: 'ignite', targetId: 1, stacks: 1 }]);
    audio.handleEvents([{ type: 'ignite', targetId: 1, stacks: 2 }]);
    audio.handleEvents([{ type: 'freeze', targetId: 1, boss: false }]);
    audio.handleEvents([{ type: 'shatter', x: 0, y: 0, radius: 50 }]);
    audio.handleEvents([{ type: 'playerHit', enemyId: 1, damage: 3, lifeLeft: 7 }]);
    audio.handleEvents([{ type: 'playerHit', enemyId: 1, damage: 0, lifeLeft: 7 }]);
    audio.handleEvents([{ type: 'waveCleared', wave: 3 }]);
    audio.handleEvents([{ type: 'burst', kind: 'explode', x: 0, y: 0, radius: 40 }]);
    audio.handleEvents([{ type: 'burst', kind: 'nova', x: 0, y: 0, radius: 300 }]);
    audio.handleEvents([{ type: 'runEnded', reason: 'death' }]);
    expect(recorder.cues()).toEqual([
      'ignite',
      'freeze',
      'shatter',
      'playerHit',
      'waveCleared',
      'explosion',
      'runEnd',
    ]);
  });

  it('plays the big kill for an elite or boss', () => {
    const recorder = new Recorder();
    const audio = new SimAudio(recorder, (enemy) => (enemy === 'boss' ? 2 : 0));
    audio.handleEvents([kill('circle')]);
    audio.handleEvents([kill('boss')]);
    expect(recorder.cues()).toEqual(['kill', 'killBig', 'kill']);
  });

  it('raises the kill pitch along a streak, and resets after a gap or reset()', () => {
    const recorder = new Recorder();
    const audio = new SimAudio(recorder);
    const pitches = (): number[] =>
      recorder.plays.filter((p) => p.cue === 'kill').map((p) => p.options?.pitch ?? 1);
    for (let i = 0; i < 4; i++) audio.handleEvents([kill()]);
    expect(pitches()).toEqual([...pitches()].sort((a, b) => a - b));
    expect(pitches()[3]).toBeGreaterThan(pitches()[0] as number);
    for (let i = 0; i < 30; i++) audio.handleEvents([]);
    audio.handleEvents([kill()]);
    expect(pitches()[4]).toBe(pitches()[0]);
    audio.handleEvents([kill()]);
    audio.reset();
    audio.handleEvents([kill()]);
    expect(pitches()[6]).toBe(pitches()[0]);
  });

  it('makes a bigger explosion louder and lower, within bounds', () => {
    const small = explosionOptions(30, 1);
    const big = explosionOptions(300, 1);
    expect(big.gain).toBeGreaterThan(small.gain ?? 0);
    expect(big.pitch).toBeLessThan(small.pitch ?? 0);
    const huge = explosionOptions(1e6, 1e6);
    expect(huge.gain).toBeLessThanOrEqual(1.4);
    expect(huge.pitch).toBeGreaterThanOrEqual(0.6);
  });
});
