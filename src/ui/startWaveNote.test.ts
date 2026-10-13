import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { startWaveNote } from './startWaveNote';

describe('startWaveNote', () => {
  afterEach(() => setLocale('en'));

  it('warns when the start wave is above what the build clears', () => {
    expect(startWaveNote({ startWave: 15, reach: 12, lowering: null })).toEqual({
      warn: true,
      text: 'Your build should clear up to wave 12. A start wave it does not clear earns no skip bonus.',
    });
  });

  it('explains a start wave the session lowered', () => {
    expect(startWaveNote({ startWave: 12, reach: 12, lowering: 'build' })).toEqual({
      warn: false,
      text: 'Lowered automatically: your build should clear up to wave 12.',
    });
    expect(startWaveNote({ startWave: 9, reach: 12, lowering: 'failedRun' })).toEqual({
      warn: false,
      text: 'Lowered automatically: the last run did not clear its start wave.',
    });
    setLocale('zh-TW');
    expect(startWaveNote({ startWave: 12, reach: 12, lowering: 'build' })?.text).toBe(
      '已自動調降：目前配置應該能清到第 12 波。',
    );
  });

  it('stays quiet when there is nothing to say or the build is not measured yet', () => {
    expect(startWaveNote({ startWave: 12, reach: 12, lowering: null })).toBeNull();
    expect(startWaveNote({ startWave: 3, reach: 12, lowering: null })).toBeNull();
    expect(startWaveNote({ startWave: 15, reach: null, lowering: null })).toBeNull();
    expect(startWaveNote({ startWave: 12, reach: null, lowering: 'build' })).toBeNull();
  });
});
