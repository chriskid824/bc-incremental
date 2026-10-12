/**
 * Every player-visible string of the M0 browser build, in one place so the i18n module
 * (docs/ARCHITECTURE.md §13) can replace it with typed keys. Placeholders use `{name}`.
 */

export const STRINGS = {
  hud: {
    wave: 'Wave',
    run: 'Run {run} · from wave {startWave}',
    time: '{elapsed} / {limit}',
    life: 'Life',
    lifeValue: '{life} / {maxLife}',
    shards: 'Shards',
    cores: 'Cores',
    speed: 'Speed · keys 1 / 2 / 4',
    speedOption: '{speed}×',
  },
  result: {
    title: {
      death: 'Defeated',
      timeout: "Time's up",
      waveCap: 'Wave cap reached',
    },
    run: 'Run {run}',
    highestWave: 'Highest wave',
    startWave: 'Start wave',
    kills: 'Enemies killed',
    shardsFromRun: 'Shards from run',
    coresFromRun: 'Cores from run',
    skipCompensation: 'Skip compensation',
    skipValue: '+{shards} shards · +{cores} cores',
    skipNone: 'None (started at wave 1)',
    skipNotCleared: 'None (start wave not cleared)',
    talents: 'Talents bought (placeholder auto-buyer)',
    talentsNone: 'Nothing affordable',
    talentRank: '{name} ×{count}',
    next: 'Next run in {seconds}s · click to continue',
  },
  error: {
    init: 'The game could not start: {message}',
  },
} as const;

/**
 * Display name of a talent until its nameKey is translated: the id split into words,
 * e.g. "critChance1" → "Crit Chance 1".
 */
export function talentName(id: string): string {
  const words = id.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Run time as m:ss, rounding down. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Replaces each `{name}` in the template with the matching value. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}
