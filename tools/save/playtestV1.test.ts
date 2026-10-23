/**
 * The playtest v1 save's generator (docs/v3 C8 design §2.2's T10; the lead's ruling K2): the save
 * PLAYTEST_LOG ends on fits the M1 web, holds what an hour on the M1 page does and has a stale twin
 * the M1 loader refunds. The save is built afresh and the committed file never read, so a fixture
 * regenerated from the `playtest-v1` tag cannot break CHECK; the generator's imports stay M1's,
 * so it runs at the tag.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toNumber } from '../../src/core/num';
import { loadGameData } from '../../src/data';
import { loadSave } from '../../src/save';
import { staleTwinV1 } from '../../src/save/testing';
import { PLAYTEST_LOG, PLAYTEST_SPEED, playtestFile, playtestSave } from './playtestV1';

const data = loadGameData();
const byId = new Map(data.talents.map((node) => [node.id, node]));
/** An id the M1 web does not have: the stale twin's (the lead's ruling K2). */
const STALE_ID = 'retiredTalent';

const TEXT = playtestSave();
const LOADED = loadSave(TEXT, data);
if (!LOADED.ok) throw new Error(`the M1 loader refuses the playtest save: ${LOADED.error}`);
const { meta, playSeconds, speed } = LOADED.profile;

// T10 catches a log that buys nothing or keeps whole numbers.
describe('the playtest v1 save (T10)', () => {
  it('fits the M1 web: the M1 loader reads it with nothing refunded', () => {
    expect(LOADED).toMatchObject({ ok: true, fromVersion: 1, refunded: false });
  });

  it('buys might to rank 3 or more and 10 nodes or more over 2 archetypes or more, spending cores', () => {
    expect(meta.ranks.get('might')).toBeGreaterThanOrEqual(3);
    const nodes = [...meta.allocated].filter((id) => byId.get(id)?.kind !== 'repeatable');
    expect(nodes.length).toBeGreaterThanOrEqual(10);
    const archetypes = new Set(nodes.map((id) => byId.get(id)?.archetype));
    archetypes.delete('none');
    expect(archetypes.size).toBeGreaterThanOrEqual(2);
    expect(meta.spentCores).toBeGreaterThan(0);
    expect(PLAYTEST_LOG.filter((step) => step.kind === 'buy')).toHaveLength(
      nodes.length + [...meta.ranks.values()].reduce((sum, rank) => sum + rank, 0),
    );
  });

  it('keeps fractions: every income, the shards and the shards spent are not whole', () => {
    for (const step of PLAYTEST_LOG) {
      if (step.kind === 'income') expect(Number.isInteger(step.shards)).toBe(false);
    }
    expect(Number.isInteger(toNumber(meta.shards))).toBe(false);
    expect(Number.isInteger(toNumber(meta.spentShards))).toBe(false);
  });

  it('ends on a frontier from 20 to 39, a run per income and about an hour at speed 2', () => {
    expect(meta.maxWave).toBeGreaterThanOrEqual(20);
    expect(meta.maxWave).toBeLessThanOrEqual(39);
    expect(meta.runs).toBe(PLAYTEST_LOG.filter((step) => step.kind === 'income').length);
    expect(Number.isInteger(playSeconds)).toBe(false);
    expect(Math.abs(playSeconds - 3600)).toBeLessThan(600);
    expect(speed).toBe(PLAYTEST_SPEED);
    expect(PLAYTEST_SPEED).toBe(2);
  });

  it('has a stale twin the M1 loader refunds in full: its shards plus spent', () => {
    expect(byId.has(STALE_ID)).toBe(false);
    const twin = loadSave(staleTwinV1(TEXT, STALE_ID), data);
    expect(twin).toMatchObject({ ok: true, fromVersion: 1, refunded: true });
    if (!twin.ok) return;
    const after = twin.profile.meta;
    expect(
      Object.is(toNumber(after.shards), toNumber(meta.shards) + toNumber(meta.spentShards)),
    ).toBe(true);
    expect(after.cores).toBe(meta.cores + meta.spentCores);
    expect(after.allocated.size).toBe(0);
  });

  it('formats the file as the repository formats JSON, around the same save', async () => {
    const file = await playtestFile();
    expect(file).not.toBe(TEXT);
    expect(JSON.parse(file)).toEqual(JSON.parse(TEXT));
    expect(file.endsWith('}\n')).toBe(true);
  });

  it('imports M1 names only, so it runs at the playtest-v1 tag (the lead’s ruling K2)', () => {
    const source = readFileSync(new URL('./playtestV1.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import [^;]*;/gm)].map(([statement]) =>
      statement.replace(/\s+/g, ' '),
    );
    expect(imports).toEqual([
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "import { parseArgs } from 'node:util';",
      "import { format, resolveConfig } from 'prettier';",
      "import { num } from '../../src/core/num';",
      "import { loadGameData } from '../../src/data';",
      "import { allocate, canAllocate, createMetaState, DEFAULT_ECONOMY } from '../../src/meta';",
      "import { loadSave, serializeSave } from '../../src/save';",
    ]);
  });
});
