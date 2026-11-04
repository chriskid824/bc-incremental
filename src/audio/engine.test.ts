import { describe, expect, it, vi } from 'vitest';
import { CUE_IDS, CUES } from './cues';
import type { CueDef, CueId } from './cues';
import { AudioEngine, DEFAULT_VOLUME, MAX_VOICES } from './engine';
import { FakeAudioContext } from './testing';

function unlocked(options: { muted?: boolean; cues?: Record<CueId, CueDef> } = {}): {
  engine: AudioEngine;
  ctx: FakeAudioContext;
} {
  const ctx = new FakeAudioContext();
  const engine = new AudioEngine({ createContext: () => ctx, random: () => 0.5, ...options });
  engine.unlock();
  return { engine, ctx };
}

/** CUES with every cue's limits set, for checking the overall cap alone. */
function loose(priority: CueDef['priority']): Record<CueId, CueDef> {
  const cues = {} as Record<CueId, CueDef>;
  for (const id of CUE_IDS) cues[id] = { ...CUES[id], cooldownMs: 0, maxVoices: 99, priority };
  return cues;
}

describe('AudioEngine', () => {
  it('makes no context and plays nothing before unlock', () => {
    const factory = vi.fn(() => new FakeAudioContext());
    const engine = new AudioEngine({ createContext: factory });
    expect(engine.play('explosion')).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(engine.stats.skipped).toBe(1);
  });

  it('makes the context once on unlock and resumes it', () => {
    const ctx = new FakeAudioContext();
    const factory = vi.fn(() => ctx);
    const engine = new AudioEngine({ createContext: factory });
    engine.unlock();
    engine.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe('running');
    expect(engine.live).toBe(true);
  });

  it('stays silent where there is no Web Audio', () => {
    const factory = vi.fn(() => null);
    const engine = new AudioEngine({ createContext: factory });
    engine.unlock();
    engine.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(engine.play('hit')).toBe(false);
  });

  it('starts the master gain at the default volume, and at 0 while muted', () => {
    const { engine, ctx } = unlocked();
    const master = ctx.gains[0];
    expect(master?.gain.value).toBe(DEFAULT_VOLUME);
    engine.muted = true;
    expect(master?.gain.value).toBe(0);
    expect(engine.play('kill')).toBe(false);
    engine.muted = false;
    expect(master?.gain.value).toBe(DEFAULT_VOLUME);
    expect(engine.play('kill')).toBe(true);
  });

  it('schedules one source per recipe layer, stopping after the envelope', () => {
    const { engine, ctx } = unlocked();
    engine.play('waveCleared');
    expect(ctx.started).toHaveLength(CUES.waveCleared.layers.length);
    for (const source of ctx.started) {
      expect(source.stoppedAt).toBeGreaterThan(source.startedAt ?? Infinity);
    }
    // The nodes are freed when a source ends.
    ctx.started[0]?.onended?.();
    expect(ctx.started[0]?.disconnected).toBe(true);
  });

  it('drops a cue inside its cooldown, and plays it again after', () => {
    const { engine, ctx } = unlocked();
    expect(engine.play('kill')).toBe(true);
    ctx.currentTime += (CUES.kill.cooldownMs - 1) / 1000;
    expect(engine.play('kill')).toBe(false);
    ctx.currentTime += 2 / 1000;
    expect(engine.play('kill')).toBe(true);
    expect(engine.stats.played.kill).toBe(2);
    expect(engine.stats.dropped).toBe(1);
  });

  it('caps the voices of one cue', () => {
    const { engine, ctx } = unlocked();
    let played = 0;
    // Plays just past the cooldown each time, while earlier voices still sound.
    for (let i = 0; i < 20; i++) {
      if (engine.play('explosion')) played++;
      ctx.currentTime += (CUES.explosion.cooldownMs + 1) / 1000;
    }
    expect(played).toBeLessThan(20);
    expect(engine.activeVoices()).toBeLessThanOrEqual(CUES.explosion.maxVoices);
  });

  it('caps all normal voices at MAX_VOICES; high-priority cues pass it', () => {
    const { engine } = unlocked({ cues: loose('normal') });
    let played = 0;
    for (let i = 0; i < 40; i++) if (engine.play('explosion')) played++;
    expect(played).toBe(MAX_VOICES);
    expect(engine.activeVoices()).toBe(MAX_VOICES);

    const high = unlocked({ cues: loose('high') });
    for (let i = 0; i < 40; i++) high.engine.play('explosion');
    expect(high.engine.activeVoices()).toBe(40);
  });

  it('gives no cue a cooldown or cap that lets a big wave flood the mix', () => {
    for (const id of CUE_IDS) {
      const def = CUES[id];
      expect(def.cooldownMs, id).toBeGreaterThanOrEqual(30);
      expect(def.maxVoices, id).toBeLessThanOrEqual(4);
      expect(def.volume, id).toBeLessThanOrEqual(0.6);
      expect(def.layers.length, id).toBeGreaterThan(0);
    }
    // The cues that fire many times a second are the most limited.
    expect(CUES.hit.maxVoices).toBeLessThanOrEqual(2);
    expect(CUES.hit.volume).toBeLessThan(CUES.kill.volume);
  });

  it('plays a cue file over its recipe once it has loaded', async () => {
    const ctx = new FakeAudioContext();
    const fetchFile = vi.fn(() => Promise.resolve(new ArrayBuffer(4)));
    const engine = new AudioEngine({
      createContext: () => ctx,
      files: { explosion: 'sfx/boom.ogg' },
      fetchFile,
    });
    engine.unlock();
    expect(fetchFile).toHaveBeenCalledWith('sfx/boom.ogg');
    expect(fetchFile).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine.play('explosion');
    expect(ctx.started).toHaveLength(1);
    // Cues without a file keep their recipe.
    engine.play('lob');
    expect(ctx.started).toHaveLength(1 + CUES.lob.layers.length);
  });

  it('keeps the recipe when a cue file fails to load', async () => {
    const ctx = new FakeAudioContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const engine = new AudioEngine({
      createContext: () => ctx,
      files: { hit: 'missing.ogg' },
      fetchFile: () => Promise.reject(new Error('404')),
    });
    engine.unlock();
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine.play('hit');
    expect(ctx.started).toHaveLength(CUES.hit.layers.length);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
