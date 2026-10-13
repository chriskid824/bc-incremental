import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../core/num';
import { loadGameData } from '../data';
import { createMetaState } from '../meta';
import { loadSave, MIGRATIONS, SAVE_VERSION, serializeSave } from '.';
import type { Profile } from '.';

const data = loadGameData();
const fixture = (version: number): string =>
  readFileSync(new URL(`../../tests/fixtures/save-v${version}.json`, import.meta.url), 'utf8');

function profile(): Profile {
  const meta = createMetaState();
  meta.shards = num(42.5);
  meta.cores = 2;
  meta.allocated.add('spark');
  meta.allocated.add('might');
  meta.ranks.set('might', 3);
  meta.maxWave = 12;
  meta.runs = 9;
  meta.spentShards = num(100);
  meta.spentCores = 1;
  return { meta, playSeconds: 600, speed: 4 };
}

describe('save', () => {
  it('round-trips a profile', () => {
    const text = serializeSave(profile(), '2026-10-20T00:00:00.000Z');
    const loaded = loadSave(text, data);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.fromVersion).toBe(SAVE_VERSION);
    expect(loaded.refunded).toBe(false);
    const { meta } = loaded.profile;
    expect(toNumber(meta.shards)).toBe(42.5);
    expect([...meta.allocated]).toEqual(['spark', 'might']);
    expect(meta.ranks.get('might')).toBe(3);
    expect(loaded.profile.speed).toBe(4);
  });

  it.each(Array.from({ length: SAVE_VERSION }, (_, i) => i + 1))(
    'migrates the v%i fixture to the current version',
    (version) => {
      const loaded = loadSave(fixture(version), data);
      expect(loaded).toMatchObject({ ok: true, fromVersion: version, refunded: false });
    },
  );

  it('has a migration for every older version', () => {
    for (let v = 1; v < SAVE_VERSION; v++) expect(MIGRATIONS[v]).toBeTypeOf('function');
  });

  it('refunds everything when the allocation no longer fits the talent web', () => {
    const p = profile();
    p.meta.allocated.add('removedNode');
    const loaded = loadSave(serializeSave(p, 'now'), data);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.refunded).toBe(true);
    expect(loaded.profile.meta.allocated.size).toBe(0);
    expect(toNumber(loaded.profile.meta.shards)).toBe(142.5);
    expect(loaded.profile.meta.cores).toBe(3);
  });

  it('refunds a disconnected allocation', () => {
    const p = profile();
    p.meta.allocated.add('arcStorm');
    const loaded = loadSave(serializeSave(p, 'now'), data);
    expect(loaded.ok && loaded.refunded).toBe(true);
  });

  it('rejects garbage, other games and newer versions', () => {
    expect(loadSave('{', data).ok).toBe(false);
    expect(loadSave(JSON.stringify({ v: 1, savedAt: '', game: 'x', data: {} }), data).ok).toBe(
      false,
    );
    const newer = JSON.parse(serializeSave(profile(), 'now')) as { v: number };
    newer.v = SAVE_VERSION + 1;
    expect(loadSave(JSON.stringify(newer), data)).toMatchObject({ ok: false });
    const bad = JSON.parse(serializeSave(profile(), 'now')) as { data: { speed: number } };
    bad.data.speed = 3;
    expect(loadSave(JSON.stringify(bad), data).ok).toBe(false);
  });
});
