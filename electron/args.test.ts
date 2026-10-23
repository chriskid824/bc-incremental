import { describe, expect, it } from 'vitest';
import { REPLAY_SPEC, parseShellArgs } from './args';

/** What Playwright, the smoke and Chromium put on the command line beside the shell's own. */
const CHROMIUM = [
  '--no-sandbox',
  '--inspect=0',
  '--remote-debugging-port=0',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--disable-dev-shm-usage',
  '.',
];

const NONE = {
  checkMode: false,
  userDataDir: null,
  overlaySwitches: false,
  replay: null,
  ignored: [],
};

describe('parseShellArgs', () => {
  it("leaves Electron's and Chromium's arguments alone", () => {
    expect(parseShellArgs([], 'linux')).toEqual(NONE);
    expect(parseShellArgs(CHROMIUM, 'linux')).toEqual(NONE);
  });

  it("finds the shell's flags anywhere among them", () => {
    const flags = ['--steam-check', '--bc-overlay-switches', '--bc-user-data-dir=/tmp/smoke-1'];
    for (const argv of [
      [...flags, ...CHROMIUM],
      [...CHROMIUM, ...flags],
      ['--no-sandbox', flags[0] ?? '', '.', flags[1] ?? '', '--inspect=0', flags[2] ?? ''],
    ]) {
      expect(parseShellArgs(argv, 'linux'), argv.join(' ')).toEqual({
        checkMode: true,
        userDataDir: '/tmp/smoke-1',
        overlaySwitches: true,
        replay: null,
        ignored: [],
      });
    }
  });

  it('takes only an absolute --bc-user-data-dir, by the rules of the OS', () => {
    expect(parseShellArgs(['--bc-user-data-dir=C:\\bc\\smoke'], 'win32').userDataDir).toBe(
      'C:\\bc\\smoke',
    );
    // Resolved, so that no `..` keeps a user name in the shown path (and the check's report).
    expect(parseShellArgs(['--bc-user-data-dir=/home/hoshi/../x'], 'linux').userDataDir).toBe(
      '/home/x',
    );
    expect(parseShellArgs(['--bc-user-data-dir=/tmp/a/./b//c/'], 'linux').userDataDir).toBe(
      '/tmp/a/b/c',
    );
    expect(
      parseShellArgs(['--bc-user-data-dir=C:\\Users\\Hoshi\\..\\x'], 'win32').userDataDir,
    ).toBe('C:\\Users\\x');
    for (const [value, platform] of [
      ['tmp/smoke', 'linux'],
      ['./smoke', 'linux'],
      ['~/smoke', 'linux'],
      ['C:\\bc\\smoke', 'linux'],
      ['smoke', 'win32'],
      ['', 'linux'],
    ] as const) {
      const parsed = parseShellArgs([`--bc-user-data-dir=${value}`, ...CHROMIUM], platform);
      expect(parsed.userDataDir, value).toBeNull();
      expect(parsed.ignored, value).toEqual([
        `Ignoring --bc-user-data-dir=${JSON.stringify(value)}: the folder must be an absolute path.`,
      ]);
    }
    expect(parseShellArgs(['--bc-user-data-dir'], 'linux').userDataDir).toBeNull();
  });

  it('passes a replay spec of letters, digits, : and . on to the page', () => {
    for (const spec of ['renderStress', 'renderStress:4.5', 'a', '0', 'wave:30.1:x']) {
      expect(parseShellArgs([...CHROMIUM, `--bc-replay=${spec}`], 'linux'), spec).toEqual({
        ...NONE,
        replay: spec,
      });
    }
    expect(REPLAY_SPEC.source).toBe('^[A-Za-z0-9:.]+$');
  });

  it('ignores any other replay value with one terminal line, and no query reaches the page', () => {
    const values = [
      'a&b',
      'a&hive',
      'renderStress&hive=1',
      'a?b',
      '?hive',
      'a/b',
      '../dist',
      'a=b',
      'replay=x',
      'a b',
      ' a',
      'a#b',
      '%41',
      'a\nb',
      'é',
      'a-b',
      'a_b',
      '',
    ];
    for (const value of values) {
      const parsed = parseShellArgs([...CHROMIUM, `--bc-replay=${value}`], 'linux');
      expect(parsed.replay, JSON.stringify(value)).toBeNull();
      expect(parsed.ignored, JSON.stringify(value)).toHaveLength(1);
      expect(parsed.ignored[0]).toBe(
        `Ignoring --bc-replay=${JSON.stringify(value)}: a replay is letters, digits, ':' and '.'.`,
      );
      expect(parsed.ignored[0], 'one line').not.toMatch(/[\r\n]/);
    }
    expect(parseShellArgs(['--bc-replay'], 'linux')).toEqual({
      ...NONE,
      ignored: [`Ignoring --bc-replay="": a replay is letters, digits, ':' and '.'.`],
    });
  });

  it('takes the last value given, and an ignored one changes nothing', () => {
    expect(parseShellArgs(['--bc-replay=a', '--bc-replay=b'], 'linux').replay).toBe('b');
    const kept = parseShellArgs(['--bc-replay=a', '--bc-replay=a&b'], 'linux');
    expect(kept.replay).toBe('a');
    expect(kept.ignored).toHaveLength(1);
    const dirs = ['--bc-user-data-dir=/tmp/a', '--bc-user-data-dir=b', '--bc-user-data-dir=/tmp/c'];
    expect(parseShellArgs(dirs, 'linux').userDataDir).toBe('/tmp/c');
  });

  it('reports a misspelt or valued flag of the shell instead of guessing', () => {
    const parsed = parseShellArgs(
      ['--steam-check=yes', '--bc-overlay-switches=1', '--bc-replays=x', '--bc-check'],
      'linux',
    );
    expect(parsed.checkMode).toBe(false);
    expect(parsed.overlaySwitches).toBe(false);
    expect(parsed.replay).toBeNull();
    expect(parsed.ignored).toEqual([
      'Ignoring --steam-check="yes": not an argument of this shell.',
      'Ignoring --bc-overlay-switches="1": not an argument of this shell.',
      'Ignoring --bc-replays="x": not an argument of this shell.',
      'Ignoring --bc-check="": not an argument of this shell.',
    ]);
  });
});
