import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { DEFAULT_ECONOMY, allowedStartWave } from '../meta';
import { loadSave } from '../save';
import HIVE_PRESET from './hivePreset.json';

describe('the ?hive preset (tools/balance/hivePreset.ts)', () => {
  it('loads through the v1 loader and validates, as main.ts loads it', () => {
    const data = loadGameData();
    const loaded = loadSave(JSON.stringify(HIVE_PRESET), data);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.fromVersion).toBe(1);
    // Every node it bought is in today's web: nothing was refunded.
    expect(loaded.refunded).toBe(false);
    const { meta } = loaded.profile;
    expect(meta.allocated.size).toBeGreaterThan(0);
    // A returning profile, which opens on the talent web (not the intro), past wave 1.
    expect(meta.runs).toBeGreaterThan(0);
    expect(allowedStartWave(meta, DEFAULT_ECONOMY)).toBeGreaterThan(1);
  });
});
