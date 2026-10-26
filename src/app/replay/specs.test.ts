import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../../sim';
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
  RENDER_STRESS_TICKS,
  renderStressSpec,
} from './specs';
import type { ReplayRoute } from './specs';

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

describe('&seconds= and &fps= (the lead’s ruling H8: gif.ts captures any form at any length and rate)', () => {
  const route = (search: string): ReplayRoute => {
    const parsed = parseReplayRoute(search);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed;
  };

  it('parses every URL without them to the route it read before them', () => {
    const today: readonly (readonly [string, ReplayRoute])[] = [
      [
        '?replay=renderStress',
        { spec: renderStressSpec(), width: null, step: false, readout: true, frameTicks: 1 },
      ],
      [
        '?replay=renderStress&step=1&readout=0&width=480',
        { spec: renderStressSpec(), width: 480, step: true, readout: false, frameTicks: 1 },
      ],
      [
        '?replay=gif:fire&step=1',
        { spec: gifSpec('fire'), width: 640, step: true, readout: false, frameTicks: 2 },
      ],
      [
        '?replay=gif:ice&width=320&seed=5&wave=12&fixture',
        {
          spec: gifSpec('ice', { seed: 5, startWave: 12, content: 'fixture' }),
          width: 320,
          step: false,
          readout: false,
          frameTicks: 2,
        },
      ],
      [
        '?replay=clip:fire.ice&step=1&fixture',
        {
          spec: fusionClipSpec('fire.ice', { content: 'fixture' }),
          width: null,
          step: true,
          readout: false,
          frameTicks: 1,
        },
      ],
      [
        '?replay=preview:summon&readout=1',
        { spec: previewSpec('summon'), width: null, step: false, readout: true, frameTicks: 1 },
      ],
      [
        '?hive&lang=zh-TW&replay=clip:summon.aura&wave=3',
        {
          spec: fusionClipSpec('summon.aura', { startWave: 3 }),
          width: null,
          step: false,
          readout: false,
          frameTicks: 1,
        },
      ],
    ];
    for (const [search, expected] of today) expect(route(search), search).toEqual(expected);
  });

  it('keeps each form’s own length and loop without &seconds=, and sets n × TICK_RATE ticks with it', () => {
    const forms = [
      ['gif:fire', GIF_SECONDS * TICK_RATE, false],
      ['clip:fire.ice', CLIP_TICKS, true],
      ['preview:ice', PREVIEW_SECONDS * TICK_RATE, true],
      ['renderStress', RENDER_STRESS_TICKS, true],
    ] as const;
    for (const [form, ticks, loop] of forms) {
      expect(parseReplayParam(`?replay=${form}`), form).toMatchObject({
        durationTicks: ticks,
        loop,
      });
      for (const seconds of [1, 15, 60]) {
        expect(parseReplayParam(`?replay=${form}&seconds=${seconds}`), form).toMatchObject({
          durationTicks: seconds * TICK_RATE,
          loop,
        });
      }
    }
    // A fusion's 15 s clip: 900 ticks from CLIP_WAVE in one take.
    expect(parseReplayParam('?replay=clip:fire.ice&seconds=15&fixture')).toEqual(
      fusionClipSpec('fire.ice', { durationTicks: 900, content: 'fixture' }),
    );
  });

  it('steps TICK_RATE ÷ &fps= ticks a frame for every form; without it 2 for gif: and 1 for the rest', () => {
    const rates = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
    for (const form of ['gif:fire', 'clip:fire.ice', 'preview:ice', 'renderStress']) {
      expect(route(`?replay=${form}`).frameTicks, form).toBe(form === 'gif:fire' ? 2 : 1);
      for (const fps of rates) {
        expect(route(`?replay=${form}&fps=${fps}`).frameTicks, `${form} ${fps}`).toBe(
          TICK_RATE / fps,
        );
      }
    }
    expect(route('?replay=gif:fire&fps=20&step=1')).toMatchObject({ frameTicks: 3, step: true });
    expect(GIF_FPS).toBe(30);
  });

  it('says why for a length outside 1–60 s or a rate that does not divide TICK_RATE', () => {
    for (const search of [
      '?replay=gif:fire&seconds=0',
      '?replay=gif:fire&seconds=61',
      '?replay=gif:fire&seconds=1.5',
      '?replay=gif:fire&seconds=-15',
      '?replay=gif:fire&seconds=',
      '?replay=gif:fire&seconds=ten',
    ]) {
      expect(parseReplayParam(search), search).toHaveProperty('error');
      expect(parseReplayRoute(search), search).toHaveProperty('error');
    }
    for (const fps of ['0', '7', '8', '25', '40', '61', '120', '2.5', '-30', '', 'thirty']) {
      const parsed = parseReplayRoute(`?replay=clip:fire.ice&fps=${fps}`);
      expect(parsed, fps).toEqual({
        error: `&fps=${fps}: a divisor of 60: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60`,
      });
    }
  });
});
