/**
 * The PR GIF (tools/sheets/gif.ts, docs/v3 C10 design §2.6): the capture's plan (OWN test 2) and
 * the replay page's query, a fusion's 15 s clip in one take (the lead's ruling H8), the size ladder
 * (OWN test 3), ffmpeg's argument lists (OWN test 4), makeGif's captures and encodes on stub deps,
 * the flags, and the session: the server and the browser stop on every exit path.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayRun, resolveSpec } from '../../src/app/replay/build';
import type { ReplayView } from '../../src/app/replay/build';
import { parseReplayRoute } from '../../src/app/replay/specs';
import { TICK_RATE } from '../../src/sim';
import {
  capturePlan,
  captureReplay,
  climbLadder,
  FIRST_FRAME,
  findOnPath,
  frameName,
  GIF_MAX_BYTES,
  gifArgs,
  ladderRungs,
  makeGif,
  mp4Args,
  overCap,
  paletteArgs,
  parseGifArgs,
  replayQuery,
  run,
  withSession,
} from './gif';
import type {
  CapturePage,
  CapturePlan,
  GifDeps,
  GifOptions,
  Rung,
  Session,
  SessionDeps,
} from './gif';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bc-gif-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('the capture’s plan (docs/v3 C10 design §2.6, OWN test 2)', () => {
  it('plans 15 s at 30 fps as 450 frames of 2 ticks: frameTicks = TICK_RATE ÷ fps', () => {
    expect(capturePlan(15, 30)).toEqual({ frames: 450, frameTicks: 2 });
    expect(capturePlan(15, 20)).toEqual({ frames: 300, frameTicks: 3 });
    expect(capturePlan(3, 30)).toEqual({ frames: 90, frameTicks: 2 });
    // At every rate the page takes, the frames cover the clip's ticks exactly.
    for (const fps of [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]) {
      const plan = capturePlan(15, fps);
      expect(plan.frames * plan.frameTicks).toBe(15 * TICK_RATE);
    }
  });

  it('names the frames from 0000, where ffmpeg’s pattern starts', () => {
    expect([FIRST_FRAME, frameName(FIRST_FRAME), frameName(449), frameName(1234)]).toEqual([
      0,
      '0000.png',
      '0449.png',
      '1234.png',
    ]);
  });

  it('opens gif:<c> or clip:<key> with the length, the rate, the width and step mode', () => {
    const at = { seconds: 15, fps: 30, width: 640, fixture: false };
    expect(replayQuery({ kind: 'character', character: 'fire' }, at)).toBe(
      '/?replay=gif:fire&seconds=15&fps=30&width=640&step=1',
    );
    expect(
      replayQuery({ kind: 'fusion', key: 'fire.ice' }, { ...at, fps: 20, fixture: true }),
    ).toBe('/?replay=clip:fire.ice&seconds=15&fps=20&width=640&step=1&fixture');
    // The page reads them as the capture plans them.
    for (const [target, fps] of [
      [{ kind: 'character', character: 'ice' }, 30],
      [{ kind: 'fusion', key: 'ice.fire' }, 20],
    ] as const) {
      const route = parseReplayRoute(replayQuery(target, { ...at, fps, fixture: true }).slice(1));
      if ('error' in route) throw new Error(route.error);
      const plan = capturePlan(15, fps);
      expect(route).toMatchObject({ width: 640, step: true, frameTicks: plan.frameTicks });
      expect(route.spec).toMatchObject({ content: 'fixture', durationTicks: 900 });
    }
  });
});

/** A view that draws nothing: the test reads the run's ticks and loops. */
const NO_VIEW: ReplayView = {
  start: () => undefined,
  events: () => undefined,
  frame: () => undefined,
};

describe('a fusion’s 15 s clip (the lead’s ruling H8)', () => {
  it('captures 900 ticks in one take: the last frame shows the clip’s last tick, no restart inside', () => {
    const query = replayQuery(
      { kind: 'fusion', key: 'fire.ice' },
      { seconds: 15, fps: 30, width: 640, fixture: true },
    );
    // From wave 1, where the fixture's run outlasts the clip (from CLIP_WAVE it ends early: H10).
    const route = parseReplayRoute(`${query.slice(1)}&wave=1`);
    if ('error' in route) throw new Error(route.error);
    const plan = capturePlan(15, 30);
    expect([route.spec.durationTicks, route.spec.loop]).toEqual([
      plan.frames * plan.frameTicks,
      true,
    ]);
    let loops = 0;
    const replay = new ReplayRun(route.spec, resolveSpec(route.spec).run, NO_VIEW, () => loops++);
    replay.stepFrames(plan.frames, route.frameTicks);
    expect([replay.tick, loops]).toEqual([900, 0]);
    // The frame after the capture is the clip's next loop.
    replay.stepFrames(1, route.frameTicks);
    expect([replay.tick, loops]).toEqual([2, 1]);
  });
});

describe('the size ladder (docs/v3 C10 design §2.6 (5), OWN test 3)', () => {
  it('is 640 px at 30 fps, 480 at 30 and 480 at 20 with the defaults', () => {
    expect(ladderRungs({ width: 640, fps: 30 })).toEqual([
      { width: 640, fps: 30 },
      { width: 480, fps: 30 },
      { width: 480, fps: 20 },
    ]);
  });

  it('skips a rung no smaller than the one before it with other flags', () => {
    const rungs = (width: number, fps: number): string[] =>
      ladderRungs({ width, fps }).map((rung) => `${rung.width}@${rung.fps}`);
    expect(rungs(480, 30)).toEqual(['480@30', '480@20']);
    expect(rungs(640, 20)).toEqual(['640@20', '480@20']);
    expect(rungs(640, 15)).toEqual(['640@15', '480@15']);
    expect(rungs(1280, 60)).toEqual(['1280@60', '480@60', '480@20']);
    // Wider than the capture: no rung after it is smaller.
    expect(rungs(320, 30)).toEqual(['320@30']);
  });

  it('stops at the first rung under the cap: a GIF of exactly the cap fits', async () => {
    const rungs = ladderRungs({ width: 640, fps: 30 });
    const sizes = [GIF_MAX_BYTES + 1, GIF_MAX_BYTES, 1];
    const made: Rung[] = [];
    const climbed = await climbLadder(
      rungs,
      (rung) => {
        made.push(rung);
        return Promise.resolve(sizes[made.length - 1] as number);
      },
      GIF_MAX_BYTES,
    );
    expect(climbed).toEqual({
      chosen: { width: 480, fps: 30 },
      tried: [
        { rung: { width: 640, fps: 30 }, bytes: GIF_MAX_BYTES + 1 },
        { rung: { width: 480, fps: 30 }, bytes: GIF_MAX_BYTES },
      ],
    });
    expect(made).toHaveLength(2);
    expect([
      overCap(GIF_MAX_BYTES, GIF_MAX_BYTES),
      overCap(GIF_MAX_BYTES + 1, GIF_MAX_BYTES),
    ]).toEqual([false, true]);
  });

  it('tries every rung when none fits, and chooses none', async () => {
    const climbed = await climbLadder(
      ladderRungs({ width: 640, fps: 30 }),
      () => Promise.resolve(2),
      1,
    );
    expect(climbed.chosen).toBeNull();
    expect(climbed.tried.map((tried) => tried.rung.fps)).toEqual([30, 30, 20]);
  });

  it('caps the GIF at §1.8’s 9.5 MB, in bytes', () => {
    expect(GIF_MAX_BYTES).toBe(9_500_000);
  });
});

describe('ffmpeg’s argument lists (docs/v3 C10 design §2.6 (4), OWN test 4)', () => {
  const input = ['-hide_banner', '-loglevel', 'error', '-y', '-framerate'];
  const frames = (fps: string): string[] => [
    ...input,
    fps,
    '-start_number',
    '0',
    '-i',
    join('f', '%04d.png'),
  ];

  it('makes the palette, then the GIF through it, at the capture’s size', () => {
    expect(paletteArgs('f', 30, null, 'p.png')).toEqual([
      ...frames('30'),
      '-vf',
      'palettegen=stats_mode=diff',
      'p.png',
    ]);
    expect(gifArgs('f', 30, null, 'p.png', 'a.gif')).toEqual([
      ...frames('30'),
      '-i',
      'p.png',
      '-lavfi',
      '[0:v][1:v]paletteuse=dither=bayer:bayer_scale=5',
      'a.gif',
    ]);
  });

  it('scales the captured frames with lanczos for a narrower rung, the palette as the GIF', () => {
    expect(paletteArgs('f', 20, 480, 'p.png')).toEqual([
      ...frames('20'),
      '-vf',
      'scale=480:-1:flags=lanczos,palettegen=stats_mode=diff',
      'p.png',
    ]);
    expect(gifArgs('f', 20, 480, 'p.png', 'a.gif')).toEqual([
      ...frames('20'),
      '-i',
      'p.png',
      '-lavfi',
      '[0:v]scale=480:-1:flags=lanczos[scaled];[scaled][1:v]paletteuse=dither=bayer:bayer_scale=5',
      'a.gif',
    ]);
  });

  it('makes the MP4 with libx264, yuv420p, crf 23 and faststart', () => {
    expect(mp4Args('f', 30, 'a.mp4')).toEqual([
      ...frames('30'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '23',
      '-movflags',
      '+faststart',
      'a.mp4',
    ]);
  });
});

/** Stub deps: the captures and ffmpeg's runs in order, each GIF's size from `gifBytes` in turn. */
function stubDeps(gifBytes: readonly number[]) {
  const captures: { query: string; plan: CapturePlan; dir: string }[] = [];
  const ffmpeg: string[][] = [];
  const lines: string[] = [];
  let gifs = 0;
  const deps: GifDeps = {
    capture: (query, plan, dir) => {
      captures.push({ query, plan, dir });
      return Promise.resolve();
    },
    ffmpeg: (args) => void ffmpeg.push([...args]),
    size: (file) => (file.endsWith('.gif') ? (gifBytes[gifs++] ?? 0) : 2_000_000),
    log: (line) => void lines.push(line),
  };
  return { deps, captures, ffmpeg, lines };
}

const OPTIONS: GifOptions = {
  target: { kind: 'character', character: 'fire' },
  seconds: 15,
  fps: 30,
  width: 640,
  out: 'out/gif',
  fixture: true,
  maxBytes: GIF_MAX_BYTES,
};
const OUT = {
  frames30: join('out/gif', 'frames', 'fire-30fps'),
  frames20: join('out/gif', 'frames', 'fire-20fps'),
  palette: join('out/gif', 'frames', 'fire-palette.png'),
  gif: join('out/gif', 'fire.gif'),
  mp4: join('out/gif', 'fire.mp4'),
};
const QUERY30 = '/?replay=gif:fire&seconds=15&fps=30&width=640&step=1&fixture';

describe('makeGif (docs/v3 C10 design §2.6; the lead’s ruling H8)', () => {
  it('captures once and makes the MP4, then the GIF, which fits at the first rung and is attached', async () => {
    const { deps, captures, ffmpeg, lines } = stubDeps([5_000_000]);
    const result = await makeGif(OPTIONS, deps);
    expect(captures).toEqual([
      { query: QUERY30, plan: { frames: 450, frameTicks: 2 }, dir: OUT.frames30 },
    ]);
    expect(ffmpeg).toEqual([
      mp4Args(OUT.frames30, 30, OUT.mp4),
      paletteArgs(OUT.frames30, 30, null, OUT.palette),
      gifArgs(OUT.frames30, 30, null, OUT.palette, OUT.gif),
    ]);
    expect(result).toEqual({
      gif: OUT.gif,
      mp4: OUT.mp4,
      tried: [{ rung: { width: 640, fps: 30 }, bytes: 5_000_000 }],
      chosen: { width: 640, fps: 30 },
      attachment: OUT.gif,
    });
    expect(lines.at(-1)).toBe(`attach: ${OUT.gif} (640 px at 30 fps), with ${OUT.mp4} beside it`);
  });

  it('makes 480 px at 30 fps from the same frames, scaled, when 640 px is over the cap', async () => {
    const { deps, captures, ffmpeg } = stubDeps([GIF_MAX_BYTES + 1, 7_000_000]);
    const result = await makeGif(OPTIONS, deps);
    expect(captures).toHaveLength(1);
    expect(ffmpeg.slice(3)).toEqual([
      paletteArgs(OUT.frames30, 30, 480, OUT.palette),
      gifArgs(OUT.frames30, 30, 480, OUT.palette, OUT.gif),
    ]);
    expect([result.chosen, result.attachment]).toEqual([{ width: 480, fps: 30 }, OUT.gif]);
  });

  it('captures again at 20 fps, 3 ticks a frame, for the last rung; past it the MP4 is attached', async () => {
    const { deps, captures, ffmpeg, lines } = stubDeps([3, 2, 2]);
    const result = await makeGif({ ...OPTIONS, maxBytes: 1 }, deps);
    expect(captures).toEqual([
      { query: QUERY30, plan: { frames: 450, frameTicks: 2 }, dir: OUT.frames30 },
      {
        query: '/?replay=gif:fire&seconds=15&fps=20&width=640&step=1&fixture',
        plan: { frames: 300, frameTicks: 3 },
        dir: OUT.frames20,
      },
    ]);
    // The MP4 is the first capture's, at --width and --fps.
    expect(ffmpeg[0]).toEqual(mp4Args(OUT.frames30, 30, OUT.mp4));
    expect(ffmpeg.slice(5)).toEqual([
      paletteArgs(OUT.frames20, 20, 480, OUT.palette),
      gifArgs(OUT.frames20, 20, 480, OUT.palette, OUT.gif),
    ]);
    expect(result.tried.map((tried) => tried.rung)).toEqual([
      { width: 640, fps: 30 },
      { width: 480, fps: 30 },
      { width: 480, fps: 20 },
    ]);
    expect([result.chosen, result.attachment]).toEqual([null, OUT.mp4]);
    expect(lines.at(-1)).toContain(`attach: ${OUT.mp4}: no rung's GIF is under the cap of 1 B`);
    expect(lines.at(-1)).toContain('the MP4 is the attachment');
  });

  it('captures a fusion’s clip by its key, and a rung at the capture’s width unscaled', async () => {
    const { deps, captures, ffmpeg } = stubDeps([9, 9]);
    const options: GifOptions = {
      ...OPTIONS,
      target: { kind: 'fusion', key: 'fire.ice' },
      width: 480,
      fixture: false,
      maxBytes: 1,
    };
    const result = await makeGif(options, deps);
    expect(captures.map((capture) => capture.query)).toEqual([
      '/?replay=clip:fire.ice&seconds=15&fps=30&width=480&step=1',
      '/?replay=clip:fire.ice&seconds=15&fps=20&width=480&step=1',
    ]);
    const frames20 = join('out/gif', 'frames', 'fire.ice-20fps');
    const palette = join('out/gif', 'frames', 'fire.ice-palette.png');
    expect(ffmpeg.at(-1)).toEqual(
      gifArgs(frames20, 20, null, palette, join('out/gif', 'fire.ice.gif')),
    );
    expect([result.gif, result.mp4]).toEqual([
      join('out/gif', 'fire.ice.gif'),
      join('out/gif', 'fire.ice.mp4'),
    ]);
  });
});

describe('gif.ts’ flags', () => {
  it('defaults to 15 s at 30 fps, 640 px, out/gif and the 9.5 MB cap', () => {
    expect(parseGifArgs(['--character', 'fire'])).toEqual({
      target: { kind: 'character', character: 'fire' },
      seconds: 15,
      fps: 30,
      width: 640,
      out: 'out/gif',
      fixture: false,
      maxBytes: GIF_MAX_BYTES,
    });
    expect(
      parseGifArgs([
        '--fusion',
        'ice.fire',
        '--seconds',
        '3',
        '--fps',
        '20',
        '--width',
        '480',
        '--out',
        'x',
        '--fixture',
        '--max-bytes',
        '1',
      ]),
    ).toEqual({
      target: { kind: 'fusion', key: 'ice.fire' },
      seconds: 3,
      fps: 20,
      width: 480,
      out: 'x',
      fixture: true,
      maxBytes: 1,
    });
  });

  it('refuses what the replay page or the MP4 would refuse', () => {
    const error = (...argv: string[]): string => {
      const parsed = parseGifArgs(argv);
      return 'error' in parsed ? parsed.error : 'parsed';
    };
    expect(error()).toBe('one of --character <c> and --fusion <c>.<o>');
    expect(error('--character', 'fire', '--fusion', 'fire.ice')).toBe(
      'one of --character <c> and --fusion <c>.<o>',
    );
    expect(error('--character', 'fire', '--fps', '7')).toContain(
      '&fps=7: a divisor of 60: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60',
    );
    expect(error('--character', 'fire', '--seconds', '61')).toContain(
      '&seconds=61: a whole number from 1 to 60',
    );
    expect(error('--character', 'fire', '--seconds', '0')).toContain('from 1 to 60');
    expect(error('--character', 'fire', '--seconds', '1.5')).toBe('--seconds 1.5: a whole number');
    expect(error('--character', 'nobody')).toContain("no character 'nobody'");
    expect(error('--fusion', 'fire')).toContain('a fusion is clip:<character>.<outer>');
    expect(error('--fusion', 'fire.fire')).toContain('a character has no fusion with itself');
    expect(error('--character', 'fire', '--width', '641')).toContain('an even width and height');
    // 642 px is even, its 16:9 height (361) is not.
    expect(error('--character', 'fire', '--width', '642')).toContain('642 × 361 px');
    expect(error('--character', 'fire', '--max-bytes', '0')).toBe('--max-bytes 0: at least 1');
    expect(error('--character', 'fire', '--bogus')).toContain("Unknown option '--bogus'");
  });
});

/** A stub of Playwright's page: each step's canvas reads `frame <n>`, and what was asked of it. */
function stubPage(behaviour: { tick?: number; goto?: (page: StubPage) => Promise<unknown> } = {}) {
  const listeners = new Map<string, (value: never) => void>();
  const asked: string[] = [];
  let steps = 0;
  const page = {
    asked,
    /** Calls the page's listener for `event`, as the browser would. */
    emit(event: 'pageerror' | 'console', value: unknown): void {
      listeners.get(event)?.(value as never);
    },
    goto(url: string): Promise<unknown> {
      asked.push(`goto ${url}`);
      return behaviour.goto?.(page) ?? Promise.resolve(null);
    },
    waitForFunction(expression: string): Promise<unknown> {
      asked.push(`wait ${expression}`);
      return Promise.resolve(true);
    },
    evaluate(expression: string): Promise<unknown> {
      if (expression === 'window.__replay.tick') return Promise.resolve(behaviour.tick ?? 0);
      if (!expression.includes('window.__replay.step(1)')) {
        return Promise.reject(new Error(`unexpected: ${expression}`));
      }
      steps++;
      const png = Buffer.from(`frame ${steps}`).toString('base64');
      return Promise.resolve(`data:image/png;base64,${png}`);
    },
    locator: () => ({ screenshot: () => Promise.reject(new Error('no locator here')) }),
    on(event: string, listener: (value: never) => void): void {
      listeners.set(event, listener);
    },
  };
  return page;
}
type StubPage = ReturnType<typeof stubPage>;

/** A session on `page` that never fails, as withSession's is before an error. */
const sessionOf = (page: CapturePage): Session => ({
  page,
  base: 'http://127.0.0.1:5173/',
  errors: [],
  failed: new Promise<never>(() => undefined),
});

/** Stub server and browser on `page`: what started and stopped, in order. */
function stubSession(page: CapturePage, launch?: () => Promise<never>) {
  const log: string[] = [];
  const deps: SessionDeps = {
    startServer: () => {
      log.push('start server');
      return Promise.resolve({
        base: 'http://127.0.0.1:5173/',
        close: () => {
          log.push('close server');
          return Promise.resolve();
        },
      });
    },
    launch:
      launch ??
      (() => {
        log.push('launch');
        return Promise.resolve({
          newPage: (viewport) => {
            log.push(`page ${viewport.width}x${viewport.height}`);
            return Promise.resolve(page);
          },
          close: () => {
            log.push('close browser');
            return Promise.resolve();
          },
        });
      }),
  };
  return { deps, log };
}

describe('the capture (docs/v3 C10 design §2.6 (2), (3))', () => {
  it('writes one PNG a step from 0000.png into an emptied folder, and reads the last tick', async () => {
    const dir = join(root, 'frames', 'fire-30fps');
    mkdirSync(dir, { recursive: true });
    // An earlier, longer capture's frame: ffmpeg would read it past this capture's.
    writeFileSync(join(dir, '0450.png'), 'stale');
    const page = stubPage({ tick: 900 });
    const tick = await captureReplay(sessionOf(page), QUERY30, capturePlan(15, 30), dir);
    expect(tick).toBe(900);
    const names = readdirSync(dir).sort();
    expect([names.length, names[0], names.at(-1)]).toEqual([450, '0000.png', '0449.png']);
    expect(readFileSync(join(dir, '0000.png'), 'utf8')).toBe('frame 1');
    expect(readFileSync(join(dir, '0449.png'), 'utf8')).toBe('frame 450');
    expect(page.asked).toEqual([
      `goto http://127.0.0.1:5173${QUERY30}`,
      'wait window.__replay !== undefined',
    ]);
  });

  it('fails with what the page reported during the capture', async () => {
    const session = { ...sessionOf(stubPage()), errors: ['page error: boom'] };
    await expect(
      captureReplay(session, QUERY30, capturePlan(1, 1), join(root, 'frames')),
    ).rejects.toThrow('page error: boom');
  });
});

describe('the session: the server and the browser stop on every exit path', () => {
  it('stops the browser, then the server, after the work and after an error', async () => {
    const { deps, log } = stubSession(stubPage());
    const viewport = { width: 1280, height: 720 };
    expect(await withSession(deps, viewport, () => Promise.resolve(7))).toBe(7);
    await expect(
      withSession(deps, viewport, () => Promise.reject(new Error('capture failed'))),
    ).rejects.toThrow('capture failed');
    const once = ['start server', 'launch', 'page 1280x720', 'close browser', 'close server'];
    expect(log).toEqual([...once, ...once]);
  });

  it('stops the server when the browser does not launch', async () => {
    const { deps, log } = stubSession(stubPage(), () => Promise.reject(new Error('no Chromium')));
    await expect(
      withSession(deps, { width: 1, height: 1 }, () => Promise.resolve()),
    ).rejects.toThrow('no Chromium');
    expect(log).toEqual(['start server', 'close server']);
  });

  it('fails at the page’s first error rather than wait out the load', async () => {
    const page = stubPage({
      goto: (self) => {
        self.emit('pageerror', new Error('replay: no fusion'));
        return Promise.resolve(null);
      },
    });
    // The page never gets ready.
    page.waitForFunction = () => new Promise(() => undefined);
    const { deps, log } = stubSession(page);
    await expect(
      withSession(deps, { width: 1, height: 1 }, (live) =>
        captureReplay(live, QUERY30, capturePlan(1, 30), join(root, 'frames')),
      ),
    ).rejects.toThrow('page error: replay: no fusion');
    expect(log.slice(-2)).toEqual(['close browser', 'close server']);
  });

  it('reports console errors as the page’s, and ignores other console messages', async () => {
    const page = stubPage();
    const { deps } = stubSession(page);
    const errors = await withSession(deps, { width: 1, height: 1 }, (live) => {
      page.emit('console', { type: () => 'warning', text: () => 'slow' });
      page.emit('console', { type: () => 'error', text: () => 'WebGL: CONTEXT_LOST_WEBGL' });
      return Promise.resolve(live.errors);
    });
    expect(errors).toEqual(['console error: WebGL: CONTEXT_LOST_WEBGL']);
  });
});

describe('gif.ts’ run', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  /** A folder for PATH holding an executable named ffmpeg, never run here. */
  function fakeFfmpeg(): string {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ffmpeg'), '');
    chmodSync(join(bin, 'ffmpeg'), 0o755);
    return bin;
  }

  it('says ffmpeg is missing and exits 1 before it starts anything', async () => {
    const { deps, log } = stubSession(stubPage());
    expect(await run(['--character', 'fire'], { PATH: join(root, 'none') }, deps)).toBe(1);
    expect(log).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ffmpeg is not on PATH'));
  });

  it('exits 2 on a usage error, before it looks for ffmpeg', async () => {
    const { deps, log } = stubSession(stubPage());
    expect(await run(['--character', 'fire', '--fps', '7'], {}, deps)).toBe(2);
    expect(log).toEqual([]);
  });

  it('stops the server and the browser when the page does not load; a window holds a wide canvas', async () => {
    const page = stubPage({ goto: () => Promise.reject(new Error('net::ERR_CONNECTION_REFUSED')) });
    const { deps, log } = stubSession(page);
    const out = join(root, 'gif');
    const env = { PATH: fakeFfmpeg(), PATHEXT: '' };
    await expect(run(['--character', 'fire', '--out', out], env, deps)).rejects.toThrow(
      'ERR_CONNECTION_REFUSED',
    );
    expect(log).toEqual([
      'start server',
      'launch',
      'page 1280x720',
      'close browser',
      'close server',
    ]);
    // A canvas wider than 1280 px gets a window that holds it.
    log.length = 0;
    await expect(
      run(['--character', 'fire', '--width', '1920', '--out', out], env, deps),
    ).rejects.toThrow('ERR_CONNECTION_REFUSED');
    expect(log[2]).toBe('page 1920x1080');
  });

  it('finds an executable on PATH, and only an executable file', () => {
    const bin = fakeFfmpeg();
    expect(findOnPath('ffmpeg', { PATH: bin, PATHEXT: '' })).toBe(join(bin, 'ffmpeg'));
    expect(findOnPath('ffprobe', { PATH: bin, PATHEXT: '' })).toBeNull();
    expect(findOnPath('bin', { PATH: root, PATHEXT: '' })).toBeNull();
    expect(findOnPath('ffmpeg', { PATHEXT: '' })).toBeNull();
  });
});
