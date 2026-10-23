import { describe, expect, it } from 'vitest';
import { STRESS_START_WAVE } from '../../sim/testing';
import { readDevFlags } from '../devFlags';
import {
  CLIP_TICKS,
  CLIP_WARMUP_TICKS,
  CLIP_WAVE,
  fusionClipSpec,
  GIF_FPS,
  GIF_SECONDS,
  GIF_WAVE,
  GIF_WIDTH,
  gifSpec,
  parseReplayParam,
  parseReplayRoute,
  PREVIEW_PURCHASES,
  PREVIEW_SECONDS,
  PREVIEW_WAVE,
  previewSpec,
  renderStressSpec,
} from './specs';

describe('the replay specs (docs/v3 C10 design §1.7, §1.8)', () => {
  it('holds the sources’ constants: the GIF’s, the wall’s 3 s clips, the select card’s 10 s', () => {
    expect([GIF_WAVE, GIF_SECONDS, GIF_FPS, GIF_WIDTH]).toEqual([30, 15, 30, 640]);
    expect([CLIP_TICKS, PREVIEW_SECONDS]).toEqual([180, 10]);
    expect([CLIP_WAVE, CLIP_WARMUP_TICKS, PREVIEW_WAVE, PREVIEW_PURCHASES]).toEqual([
      18, 300, 30, 68,
    ]);
  });

  it('builds the wall’s clip, the select card’s loop, the PR GIF and renderStress', () => {
    expect(fusionClipSpec('fire.ice')).toEqual({
      build: { kind: 'fusion', key: 'fire.ice' },
      content: 'registered',
      seed: 1,
      startWave: 18,
      warmupTicks: 300,
      durationTicks: 180,
      loop: true,
    });
    expect(previewSpec('summon')).toEqual({
      build: { kind: 'default', character: 'summon', count: 68 },
      content: 'registered',
      seed: 1,
      startWave: 30,
      warmupTicks: 300,
      durationTicks: 600,
      loop: true,
    });
    expect(gifSpec('ice')).toMatchObject({ startWave: 30, durationTicks: 900, loop: false });
    expect(renderStressSpec()).toEqual({
      build: { kind: 'preset', id: 'renderStress' },
      content: 'registered',
      seed: 1,
      startWave: STRESS_START_WAVE,
      warmupTicks: 300,
      durationTicks: 1500,
      loop: true,
    });
    expect(previewSpec('fire', { seed: 9, content: 'fixture' })).toMatchObject({
      seed: 9,
      content: 'fixture',
    });
  });
});

describe('parseReplayParam (OWN test 5)', () => {
  it('reads every form: renderStress, preview:<c>, gif:<c> and clip:<c>.<o>', () => {
    expect(parseReplayParam('?replay=renderStress')).toEqual(renderStressSpec());
    expect(parseReplayParam('?replay=preview:lightning')).toEqual(previewSpec('lightning'));
    expect(parseReplayParam('?replay=gif:fire')).toEqual(gifSpec('fire'));
    expect(parseReplayParam('?replay=clip:summon.aura')).toEqual(fusionClipSpec('summon.aura'));
    expect(parseReplayParam('?lang=zh-TW&replay=gif%3Aice')).toEqual(gifSpec('ice'));
  });

  it('reads an empty ?replay= as none, as readDevFlags does: not as renderStress', () => {
    for (const search of ['?replay=', '?replay', '?replay=&seed=3', '?hive&replay=']) {
      expect(parseReplayParam(search), search).toHaveProperty('error');
      expect(readDevFlags(search, 100).replay, search).toBeNull();
    }
  });

  it('takes &seed=, &wave= and &fixture', () => {
    expect(parseReplayParam('?replay=clip:fire.ice&seed=7&wave=22&fixture')).toEqual(
      fusionClipSpec('fire.ice', { seed: 7, startWave: 22, content: 'fixture' }),
    );
    expect(parseReplayParam('?replay=renderStress&seed=4294967295')).toMatchObject({
      seed: 4294967295,
    });
  });

  it('says why for an unknown form, a missing character or outer, or a number out of range', () => {
    for (const search of [
      '',
      '?hive',
      '?replay=stress',
      '?replay=preview',
      '?replay=preview:',
      '?replay=preview:fire.ice',
      '?replay=gif:hive',
      '?replay=clip:fire',
      '?replay=clip:fire.',
      '?replay=clip:.ice',
      '?replay=clip:fire.nothing',
      '?replay=clip:nobody.ice',
      '?replay=clip:fire.ice.aura',
      '?replay=renderStress&seed=-1',
      '?replay=renderStress&seed=1.5',
      '?replay=renderStress&seed=4294967296',
      '?replay=renderStress&wave=0',
      '?replay=renderStress&wave=',
    ]) {
      const parsed = parseReplayParam(search);
      expect(parsed, search).toHaveProperty('error');
      expect((parsed as { error: string }).error.length, search).toBeGreaterThan(0);
    }
  });
});

describe('parseReplayRoute: the route’s own parameters', () => {
  const route = (search: string) => {
    const parsed = parseReplayRoute(search);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed;
  };

  it('defaults &readout to 1 for renderStress and to 0 for every other form', () => {
    expect(route('?replay=renderStress').readout).toBe(true);
    for (const form of ['preview:fire', 'gif:fire', 'clip:fire.ice']) {
      expect(route(`?replay=${form}`).readout, form).toBe(false);
    }
    expect(route('?replay=renderStress&readout=0').readout).toBe(false);
    expect(route('?replay=preview:fire&readout=1').readout).toBe(true);
  });

  it('steps with &step=1, a GIF at 2 ticks a frame and 640 px wide unless &width= says', () => {
    expect(route('?replay=renderStress')).toMatchObject({
      step: false,
      width: null,
      frameTicks: 1,
    });
    expect(route('?replay=renderStress&step=1&width=480')).toMatchObject({
      step: true,
      width: 480,
      frameTicks: 1,
    });
    expect(route('?replay=gif:fire&step=1')).toMatchObject({
      step: true,
      width: 640,
      frameTicks: 2,
    });
    expect(route('?replay=gif:fire&width=320').width).toBe(320);
  });

  it('says why for a flag that is not 0 or 1, a bad width or a bad spec', () => {
    for (const search of [
      '?replay=renderStress&readout=yes',
      '?replay=renderStress&step=2',
      '?replay=renderStress&width=0',
      '?replay=renderStress&width=wide',
      '?replay=nothing',
    ]) {
      expect(parseReplayRoute(search), search).toHaveProperty('error');
    }
  });
});
