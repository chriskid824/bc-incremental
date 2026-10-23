import { describe, expect, it } from 'vitest';
import type { ShellInfo } from './bridge';
import { ANSWER_KEYS, REPORT_TITLE, buildReport, redactPaths } from './report';
import type { CheckLog, ReportMeta } from './report';

const META: ReportMeta = { when: '2026-10-30T09:15:42.123Z', build: '0.0.1+e57606a' };

const WINDOWS: ShellInfo = {
  bridgeVersion: 1,
  checkMode: true,
  steam: { ok: true, appId: 480, language: 'tchinese', steamDeck: false, initMs: 137 },
  overlaySwitches: ['in-process-gpu', 'disable-direct-composition'],
  saveDir: 'C:\\Users\\Hoshi\\AppData\\Roaming\\bc-incremental\\saves',
  saveDirShown: '%APPDATA%\\bc-incremental\\saves',
  autoCloud: { root: 'WinAppDataRoaming', subdirectory: 'bc-incremental/saves', pattern: '*.json' },
  versions: {
    app: '0.0.1',
    electron: '44.8.0',
    chrome: '146.0.7680.65',
    node: '24.11.1',
    steamworks: '0.4.0',
  },
  os: { platform: 'win32', arch: 'x64', release: '10.0.22631', translated: false },
  gpu: 'gpu_compositing=enabled webgl=enabled',
};

const MAC: ShellInfo = {
  ...WINDOWS,
  steam: { ok: true, appId: 480, language: 'english', steamDeck: false, initMs: 412 },
  saveDir: '/Users/hoshi/Library/Application Support/bc-incremental/saves',
  saveDirShown: '~/Library/Application Support/bc-incremental/saves',
  autoCloud: { root: 'MacAppSupport', subdirectory: 'bc-incremental/saves', pattern: '*.json' },
  os: { platform: 'darwin', arch: 'arm64', release: '24.6.0', translated: false },
  gpu: 'gpu_compositing=enabled metal=enabled_on webgl=enabled',
};

/** The container's run: no Steam, so no overlay switches; userData in a temporary folder. */
const NO_STEAM: ShellInfo = {
  ...WINDOWS,
  steam: {
    ok: false,
    stage: 'init',
    error: "Failed to load module '/root/.steam/sdk64/steamclient.so'",
  },
  overlaySwitches: [],
  saveDir: '/tmp/bc-esmoke-x1Yz/saves',
  saveDirShown: '/tmp/bc-esmoke-x1Yz/saves',
  autoCloud: {
    root: 'LinuxHome',
    subdirectory: '.config/bc-incremental/saves',
    pattern: '*.json',
  },
  versions: { ...WINDOWS.versions, steamworks: null },
  os: { platform: 'linux', arch: 'x64', release: '6.18.44', translated: false },
  gpu: '',
};

const SAVE_FILES = [
  { name: 'backup.json', bytes: 4790, modified: '2026-10-30T09:14:10.000Z' },
  { name: 'main.json', bytes: 4812, modified: '2026-10-30T09:15:20.000Z' },
];

describe('buildReport', () => {
  it('writes a Windows session where everything worked, line for line', () => {
    const log: CheckLog = {
      before: 'locked',
      presses: [
        { action: 'unlock', returned: true, now: 'unlocked' },
        { action: 'clear', returned: true, now: 'locked' },
      ],
      answers: {
        hint_at_start: 'yes',
        unlock_popup: 'yes',
        shift_tab: 'yes',
        overlay_page: 'overlay',
      },
      saveFiles: SAVE_FILES,
      errors: [],
    };
    expect(buildReport(WINDOWS, log, META)).toBe(
      [
        'bc-incremental steam check v1',
        'when: 2026-10-30T09:15:42.123Z   build: 0.0.1+e57606a',
        'os: win32 x64 10.0.22631 translated=no',
        'versions: electron 44.8.0 chrome 146.0.7680.65 node 24.11.1 steamworks.js 0.4.0',
        'steam: ok app=480 language=tchinese deck=no init_ms=137',
        'overlay_switches: in-process-gpu, disable-direct-composition',
        'gpu: gpu_compositing=enabled webgl=enabled',
        'saves: %APPDATA%\\bc-incremental\\saves   autocloud: WinAppDataRoaming bc-incremental/saves *.json',
        'save_files: backup.json 4790 B 2026-10-30T09:14:10.000Z; main.json 4812 B 2026-10-30T09:15:20.000Z',
        'ach: before=locked | unlock returned=yes now=unlocked | clear returned=yes now=locked',
        'answers: hint_at_start=yes unlock_popup=yes shift_tab=yes overlay_page=overlay',
        'errors: 0',
        '',
      ].join('\n'),
    );
  });

  it('writes a macOS session where the overlay never showed, line for line', () => {
    const log: CheckLog = {
      before: 'unlocked',
      presses: [
        { action: 'clear', returned: true, now: 'locked' },
        { action: 'recheck', now: 'locked' },
        { action: 'unlock', returned: true, now: 'unlocked' },
        { action: 'clear', returned: false, now: 'unlocked' },
      ],
      answers: {
        hint_at_start: 'no',
        unlock_popup: 'no',
        shift_tab: 'no',
        overlay_page: 'nothing',
      },
      saveFiles: SAVE_FILES.slice(1),
      errors: [
        'console error: WebGL: CONTEXT_LOST_WEBGL (file:///Users/hoshi/bc-steam-check/x.js:1)',
        'load failed: ERR_FILE_NOT_FOUND (-6) at file:///Users/hoshi/bc-steam-check/a.png',
      ],
    };
    expect(buildReport(MAC, log, META)).toBe(
      [
        'bc-incremental steam check v1',
        'when: 2026-10-30T09:15:42.123Z   build: 0.0.1+e57606a',
        'os: darwin arm64 24.6.0 translated=no',
        'versions: electron 44.8.0 chrome 146.0.7680.65 node 24.11.1 steamworks.js 0.4.0',
        'steam: ok app=480 language=english deck=no init_ms=412',
        'overlay_switches: in-process-gpu, disable-direct-composition',
        'gpu: gpu_compositing=enabled metal=enabled_on webgl=enabled',
        'saves: ~/Library/Application Support/bc-incremental/saves   autocloud: MacAppSupport bc-incremental/saves *.json',
        'save_files: main.json 4812 B 2026-10-30T09:15:20.000Z',
        'ach: before=unlocked | clear returned=yes now=locked | recheck now=locked' +
          ' | unlock returned=yes now=unlocked | clear returned=no now=unlocked',
        'answers: hint_at_start=no unlock_popup=no shift_tab=no overlay_page=nothing',
        'errors: 2',
        '',
      ].join('\n'),
    );
  });

  it('writes a session without Steam, its error quoted and its paths redacted, line for line', () => {
    const log: CheckLog = {
      before: 'unknown',
      presses: [{ action: 'unlock', returned: false, now: 'unknown' }],
      answers: { hint_at_start: 'no' },
      saveFiles: [],
      errors: [],
    };
    expect(buildReport(NO_STEAM, log, META)).toBe(
      [
        'bc-incremental steam check v1',
        'when: 2026-10-30T09:15:42.123Z   build: 0.0.1+e57606a',
        'os: linux x64 6.18.44 translated=no',
        'versions: electron 44.8.0 chrome 146.0.7680.65 node 24.11.1 steamworks.js unknown',
        `steam: not-connected stage=init error="Failed to load module '<path>'"`,
        'overlay_switches: none',
        'gpu: unknown',
        'saves: <path>   autocloud: LinuxHome .config/bc-incremental/saves *.json',
        'save_files: none',
        'ach: before=unknown | unlock returned=no now=unknown',
        'answers: hint_at_start=no unlock_popup=unknown shift_tab=unknown overlay_page=unknown',
        'errors: 0',
        '',
      ].join('\n'),
    );
  });

  it('writes unknown for each question nobody answered, always in the same order', () => {
    const log = (answers: CheckLog['answers']): string => {
      const text = buildReport(WINDOWS, { ...emptyLog(), answers }, META);
      return text.split('\n').find((line) => line.startsWith('answers: ')) ?? '';
    };
    expect(ANSWER_KEYS).toEqual(['hint_at_start', 'unlock_popup', 'shift_tab', 'overlay_page']);
    expect(log({})).toBe(
      'answers: hint_at_start=unknown unlock_popup=unknown shift_tab=unknown overlay_page=unknown',
    );
    expect(log({ overlay_page: 'steam-window', shift_tab: 'no' })).toBe(
      'answers: hint_at_start=unknown unlock_popup=unknown shift_tab=no overlay_page=steam-window',
    );
    expect(log({ unlock_popup: 'yes' })).toBe(
      'answers: hint_at_start=unknown unlock_popup=yes shift_tab=unknown overlay_page=unknown',
    );
  });

  it('holds no Steam name or ID and no absolute path, whatever the shell adds to its info', () => {
    const log: CheckLog = { ...emptyLog(), saveFiles: SAVE_FILES, errors: ['C:\\Users\\Hoshi'] };
    const plain = buildReport(WINDOWS, log, META);
    // Fields a later shell might add, such as the persona or the Steam ID, never reach the report.
    const persona = { persona: 'HoshiOnSteam', steamId: '76561198000000000' };
    const extra = { ...WINDOWS, ...persona, steam: { ...WINDOWS.steam, ...persona } };
    expect(buildReport(extra, log, META)).toBe(plain);
    expect(plain).not.toContain(WINDOWS.saveDir);
    expect(plain.toLowerCase()).not.toContain('hoshi');
    expect(plain).not.toContain('7656119');
    expect(plain).toContain('saves: %APPDATA%\\bc-incremental\\saves   autocloud: ');
    const linux = buildReport(NO_STEAM, log, META);
    expect(linux).not.toContain('/tmp/');
    expect(linux).not.toContain('/root/');
  });

  it('starts with the title line and ends each line, the last too, with a newline', () => {
    const text = buildReport(WINDOWS, emptyLog(), META);
    expect(REPORT_TITLE).toBe('bc-incremental steam check v1');
    expect(text.startsWith(`${REPORT_TITLE}\n`)).toBe(true);
    expect(text.endsWith('errors: 0\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(13);
    expect(text).not.toContain('\r');
  });
});

describe('redactPaths', () => {
  it('writes every absolute path as <path>, spaces and all', () => {
    const cases: readonly (readonly [string, string])[] = [
      [
        "Failed to load module '/root/.steam/sdk64/steamclient.so'",
        "Failed to load module '<path>'",
      ],
      [
        'Error: /home/hoshi/bc/node_modules/steamworks.js/dist/linux64/steamworksjs.linux-x64-gnu.node: cannot open shared object file: No such file or directory',
        'Error: <path>: cannot open shared object file: No such file or directory',
      ],
      [
        'The specified module could not be found.\r\n\\\\?\\C:\\Users\\Hoshi Chen\\bc-steam-check\\node_modules\\steamworks.js\\dist\\win64\\steamworksjs.win32-x64-msvc.node',
        'The specified module could not be found.\r\n<path>',
      ],
      ['saved in C:\\Users\\Hoshi Chen\\AppData', 'saved in <path>'],
      ['at "D:/Games/My Steam/steam.dll" and C:/x', 'at "<path>" and <path>'],
      ['/Users/hoshi/Library/Application Support/bc-incremental/saves', '<path>'],
      ['(\\\\server\\share\\hoshi\\file.node), then', '(<path>), then'],
      ['dlopen(/Users/hoshi/a b/x.node, 0x0001): tried: x', 'dlopen(<path>, 0x0001): tried: x'],
      ['path=/tmp/bc-esmoke-x1Yz/saves', 'path=<path>'],
      ['at file:///Users/hoshi/bc/x.js:12', 'at file:<path>'],
    ];
    for (const [text, redacted] of cases) {
      expect(redactPaths(text), text).toBe(redacted);
    }
  });

  it('leaves shown and relative paths, and words, alone', () => {
    for (const text of [
      '%APPDATA%\\bc-incremental\\saves',
      '~/Library/Application Support/bc-incremental/saves',
      '~\\Documents\\bc\\saves',
      '.config/bc-incremental/saves',
      'Steam is not running',
      'in-process-gpu, disable-direct-composition',
      'ratio 3/4 and either/or',
    ]) {
      expect(redactPaths(text), text).toBe(text);
    }
  });
});

function emptyLog(): CheckLog {
  return { before: 'locked', presses: [], answers: {}, saveFiles: [], errors: [] };
}
