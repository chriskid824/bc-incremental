/**
 * The line under the talent web's start-wave slider: a warning when the start wave is above
 * what the build clears, or why the session lowered it. DOM-free so tests can run it.
 */

import { t } from '../i18n';

export interface StartWaveFacts {
  readonly startWave: number;
  /** Highest start wave the build clears (src/meta/startWave.ts); null while not measured. */
  readonly reach: number | null;
  /** Why the start wave sits below the player's pick, if it does. */
  readonly lowering: 'build' | 'failedRun' | 'climbing' | null;
}

export interface StartWaveNote {
  readonly text: string;
  /** A warning (the start wave may not be cleared) rather than information. */
  readonly warn: boolean;
}

export function startWaveNote(facts: StartWaveFacts): StartWaveNote | null {
  const { startWave, reach, lowering } = facts;
  if (reach !== null && startWave > reach) {
    return { warn: true, text: t('talents.startWaveAbove', { reach }) };
  }
  if (lowering === 'build' && reach !== null) {
    return { warn: false, text: t('talents.startWaveLoweredBuild', { reach }) };
  }
  if (lowering === 'failedRun') return { warn: false, text: t('talents.startWaveLoweredRun') };
  if (lowering === 'climbing') return { warn: false, text: t('talents.startWaveClimbing') };
  return null;
}
