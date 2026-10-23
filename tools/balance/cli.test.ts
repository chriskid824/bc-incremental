import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, OUTER_IDS } from '../../src/data';
import { DEFAULT_WEB_ECONOMY } from '../../src/meta/web';
import { characterSessionConfigs, main, parseOptions, UsageError } from './cli';
import type { CharacterCliOptions, CliIo } from './cli';
import { BASE_WEB_STRATEGIES } from './v3/strategies';

/** The default --workers, which depends on the machine. */
const WORKERS = Math.max(1, Math.min(4, availableParallelism()));
const ECONOMY = {
  talentBaseShards: 180,
  talentGrowth: 1.31,
  startWaveRatio: 0.5,
  skipRewardRate: 1,
};
const M1_DEFAULTS = {
  strategies: ['crit-greedy'],
  sessions: 20,
  minutes: 60,
  seed: 1,
  startWave: { kind: 'max' },
  economy: ECONOMY,
  menuSeconds: 20,
  waveCap: null,
  out: 'out/balance',
  workers: WORKERS,
};

/** The parent commit's parseOptions on five lists, recorded before character sessions. */
const RECORDED: readonly (readonly [readonly string[], object])[] = [
  [[], M1_DEFAULTS],
  [
    [
      '--strategy',
      'all',
      '--sessions',
      '3',
      '--minutes',
      '12.5',
      '--seed',
      '9',
      '--start-wave',
      'ratio:0.4',
      '--start-wave-ratio',
      '0.75',
      '--skip-reward-rate',
      '0.5',
      '--menu-seconds',
      '0',
      '--wave-cap',
      '40',
      '--out',
      'out/x',
      '--workers',
      '2',
    ],
    {
      strategies: [
        'crit-greedy',
        'dot-greedy',
        'chain-greedy',
        'cheapest',
        'balanced',
        'might-only',
      ],
      sessions: 3,
      minutes: 12.5,
      seed: 9,
      startWave: { kind: 'ratio', ratio: 0.4 },
      economy: { ...ECONOMY, startWaveRatio: 0.75, skipRewardRate: 0.5 },
      menuSeconds: 0,
      waveCap: 40,
      out: 'out/x',
      workers: 2,
    },
  ],
  [
    ['--strategy', 'dot-greedy,cheapest', '--minutes', '30'],
    { ...M1_DEFAULTS, strategies: ['dot-greedy', 'cheapest'], minutes: 30 },
  ],
  [
    ['--sessions', '8', '--start-wave', '1', '--workers', '3'],
    { ...M1_DEFAULTS, sessions: 8, startWave: { kind: 'first' }, workers: 3 },
  ],
  [
    ['--strategy', 'might-only', '--seed=-4', '--start-wave', 'max', '--skip-reward-rate', '0'],
    {
      ...M1_DEFAULTS,
      strategies: ['might-only'],
      seed: -4,
      economy: { ...ECONOMY, skipRewardRate: 0 },
    },
  ],
];

function capture(): CliIo & { readonly lines: string[] } {
  const lines: string[] = [];
  const push = (message: string): void => void lines.push(message);
  return { lines, log: push, warn: push, error: push };
}

const characterOptions = (argv: readonly string[]): CharacterCliOptions => {
  const options = parseOptions(argv);
  if (options === null || !('character' in options)) throw new Error('not character options');
  return options;
};

describe('balance CLI', () => {
  it('parses M1 options as the parent commit did without --character', () => {
    for (const [argv, recorded] of RECORDED)
      expect(parseOptions(argv), argv.join(' ')).toStrictEqual(recorded);
    expect(parseOptions(['--help'])).toBeNull();
    expect(() => parseOptions(['--content', 'fixture'])).toThrow(/need --character/);
    expect(() => parseOptions(['--scope', 'demoA'])).toThrow(/need --character/);
  });

  it('turns --character into character session configs', () => {
    const options = characterOptions(['--character', 'fire', '--content', 'fixture']);
    expect(options).toStrictEqual({
      character: 'fire',
      content: { fixture: 'B5' },
      scope: 'full',
      strategies: ['default'],
      sessions: 20,
      minutes: null,
      seed: 1,
      startWave: { kind: 'max' },
      economy: DEFAULT_WEB_ECONOMY,
      menuSeconds: 20,
      out: 'out/balance/v3',
      workers: WORKERS,
    });
    const configs = characterSessionConfigs(options);
    expect(configs).toHaveLength(20);
    expect(configs[19]).toStrictEqual({
      character: 'fire',
      strategy: 'default',
      session: 19,
      seed: 1,
      minutes: 60,
      startWave: { kind: 'max' },
      economy: DEFAULT_WEB_ECONOMY,
      menuSeconds: 20,
      content: { fixture: 'B5' },
      scope: 'full',
    });

    const all = characterSessionConfigs(
      characterOptions(['--character', 'all', '--content', 'fixture', '--strategy', 'all']),
    );
    const pairs = [...new Set(all.map((config) => `${config.character} ${config.strategy}`))];
    expect(pairs).toEqual(
      CHARACTER_IDS.flatMap((c) => [
        ...BASE_WEB_STRATEGIES.map((s) => `${c} ${s}`),
        ...OUTER_IDS.filter((o) => o !== c).map((o) => `${c} focus:${o}`),
      ]),
    );
    const ratio = characterOptions([
      '--character',
      'summon',
      '--content',
      'fixture:B2',
      '--scope',
      'demoA',
      '--start-wave-ratio',
      '0.25',
      '--skip-reward-rate',
      '0.5',
      '--minutes',
      '5',
      '--seed',
      '7',
      '--menu-seconds',
      '0',
      '--start-wave',
      'ratio:0.4',
    ]);
    expect(ratio.economy).toStrictEqual({
      ...DEFAULT_WEB_ECONOMY,
      startWaveRatio: 0.25,
      skipRewardRate: 0.5,
    });
    expect(characterSessionConfigs(ratio)[0]).toStrictEqual({
      character: 'summon',
      strategy: 'default',
      session: 0,
      seed: 7,
      minutes: 5,
      startWave: { kind: 'ratio', ratio: 0.4 },
      economy: ratio.economy,
      menuSeconds: 0,
      content: { fixture: 'B2' },
      scope: 'demoA',
    });
    // The scope's web decides the focus strategies: demoA opens four outers for fire.
    const demo = characterSessionConfigs(
      characterOptions([
        '--character',
        'fire',
        '--content',
        'fixture',
        '--scope',
        'demoA',
        '--strategy',
        'all',
        '--sessions',
        '1',
      ]),
    );
    expect(demo.map((config) => config.strategy)).toEqual([
      ...BASE_WEB_STRATEGIES,
      'focus:poison',
      'focus:crit',
      'focus:ice',
      'focus:summon',
    ]);
    expect(demo.every((config) => config.scope === 'demoA')).toBe(true);
  });

  it('exits 2 for a character without a center in the registered content, 0 for all', async () => {
    expect(characterOptions(['--character', 'fire']).content).toBe('registered');
    const one = capture();
    expect(await main(['--character', 'fire'], one)).toBe(2);
    expect(one.lines.join('\n')).toMatch(/fire has no center.*before B1.*--content fixture/s);
    const all = capture();
    expect(await main(['--character', 'all'], all)).toBe(0);
    expect(all.lines.join('\n')).toMatch(/^No character has a center in the registered content/);
  });

  it('refuses what character sessions cannot run', async () => {
    const fixture = ['--content', 'fixture'];
    expect(() => parseOptions(['--character', 'water'])).toThrow(/Unknown character 'water'/);
    expect(() => parseOptions(['--character', 'fire', '--wave-cap', '40'])).toThrow(/--wave-cap/);
    expect(() => parseOptions(['--character', 'fire', '--scope', 'demo'])).toThrow(/Invalid scope/);
    expect(() => parseOptions(['--character', 'fire', '--content', 'fixture:B9'])).toThrow(
      /Invalid content/,
    );
    expect(() => parseOptions(['--character', 'fire', '--strategy', 'crit-greedy'])).toThrow(
      /Unknown strategy 'crit-greedy'/,
    );
    expect(() =>
      characterSessionConfigs(
        characterOptions(['--character', 'ice', '--scope', 'demoA', ...fixture]),
      ),
    ).toThrow(UsageError);
    expect(() =>
      characterSessionConfigs(
        characterOptions(['--character', 'fire', '--strategy', 'focus:fire', ...fixture]),
      ),
    ).toThrow(/focus:fire: the outer's board is open on no web/);
    const usage = capture();
    expect(await main(['--character', 'fire', '--sessions', '0'], usage)).toBe(2);
    expect(usage.lines[0]).toMatch(/--sessions must be an integer/);
    expect(usage.lines[1]).toMatch(/Character sessions on the v3 webs/);
  });
});
