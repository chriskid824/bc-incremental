/**
 * Entry point of the data module: validated game data plus the shared vocabulary
 * (types, stats, damage tags, damage sources, ailment kinds, rules, master curve, wave
 * composition).
 */

import { ENEMIES } from './enemies';
import { GameDataSchema } from './schema';
import { TALENTS } from './talents';
import type { GameData } from './types';
import { validateGameData } from './validate';
import { WAVES } from './waves';

export * from './types';
export * from './stats';
export * from './tags';
export * from './sources';
export * from './triggers';
export * from './rules';
export * from './curve';
export * from './compose';
export { MAX_KEYSTONES, validateGameData } from './validate';

/**
 * Parses raw data through the schema, then runs the content checks. Throws one Error that
 * lists every issue; the result is deeply frozen.
 */
export function parseGameData(raw: unknown): GameData {
  const parsed = GameDataSchema.safeParse(raw);
  const issues = parsed.success
    ? validateGameData(parsed.data)
    : parsed.error.issues.map((issue) => {
        const path = issue.path.map(String).join('.');
        return path === '' ? issue.message : `${path}: ${issue.message}`;
      });
  if (!parsed.success || issues.length > 0) {
    const count = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
    throw new Error(`Invalid game data (${count}):\n- ${issues.join('\n- ')}`);
  }
  return parsed.data;
}

let cached: GameData | undefined;

/** The game's content, validated on first call and shared afterwards. */
export function loadGameData(): GameData {
  cached ??= parseGameData({ enemies: ENEMIES, waves: WAVES, talents: TALENTS });
  return cached;
}
