/**
 * save-v2.json's generator (docs/v3 C8 design §2.2): the profile it builds on the fixture webs, a
 * save that loads clean and reads back to its own text, with every part of the format in use as
 * §2.2 lists it. The save is built afresh; T1 and T8 (src/save/save.test.ts) load the committed
 * file.
 */

import { describe, expect, it } from 'vitest';
import { toNumber } from '../../src/core/num';
import { ENEMY_IDS } from '../../src/data/types';
import { fusionSlotOrder } from '../../src/meta/web';
import { freshProfile, parseProfile, serializeProfile } from '../../src/save/profile';
import { deepFreeze } from '../../src/save/testing';
import {
  FIRE_CORE,
  FIXTURE_V2_SAVED_AT,
  fixtureV2Context,
  fixtureV2File,
  fixtureV2Profile,
  fixtureV2Save,
  SUMMON_ORDER,
} from './fixtureV2';

const context = fixtureV2Context();
const TEXT = fixtureV2Save();
const PROFILE = deepFreeze(fixtureV2Profile(context));
const { account, characters } = PROFILE;

describe('the save v2 fixture', () => {
  it('loads on the fixture webs with no notice, nothing changed, and reads back to its text', () => {
    const loaded = parseProfile(TEXT, context);
    expect(loaded).toMatchObject({ ok: true, fromVersion: 2, notices: [], changed: false });
    if (!loaded.ok) return;
    expect(loaded.profile).toEqual(PROFILE);
    expect(serializeProfile(deepFreeze(loaded.profile), FIXTURE_V2_SAVED_AT)).toBe(TEXT);
  });

  it('gives fire 火毒’s investment and core: one fusion slot, one codex entry', () => {
    const fire = characters.fire.progress;
    const web = context.webOf('fire');
    if (web === null) throw new Error('no fire web');
    expect(fire.ranks[FIRE_CORE]).toBe(1);
    expect(fusionSlotOrder(web, fire)).toEqual(['poison']);
    expect(account.codex).toEqual({ 'fire.poison': { bestWave: 34 } });
    expect(Number.isInteger(toNumber(fire.wallet.shards))).toBe(false);
    expect(fire.spent.cores).toBeGreaterThan(0);
    expect([fire.bestWave, fire.cycleBest, fire.runs, fire.prestiges]).toEqual([34, 34, 21, 0]);
    expect(characters.fire.startWave).toBe(15);
    expect(characters.fire.loadouts).toEqual([fire.ranks, null, null]);
    expect(characters.fire.loadouts[0]).not.toBe(fire.ranks);
  });

  it('gives summon a prestige and one ascendancy node bought with 迴響, which sets its chain', () => {
    const summon = characters.summon.progress;
    expect(Object.keys(summon.ranks)).toEqual(SUMMON_ORDER);
    expect(SUMMON_ORDER.filter((id) => id.startsWith('summon.asc.'))).toHaveLength(1);
    expect(summon.ascendancy).toBe('path-one');
    expect(summon.spent.resonance).toBeGreaterThan(0);
    expect(summon.wallet.resonance + summon.spent.resonance).toBe(summon.resonanceEarned);
    expect([summon.prestiges, summon.resonanceEarned, summon.bestWave, summon.cycleBest]).toEqual([
      1, 15, 41, 3,
    ]);
  });

  it('leaves ice and lightning empty, and the account as §2.2 lists it', () => {
    const fresh = freshProfile();
    expect(characters.ice).toEqual(fresh.characters.ice);
    expect(characters.lightning).toEqual(fresh.characters.lightning);
    expect(account.settings).toEqual({ speed: 2 });
    expect(account.stats).toEqual({ playSeconds: 5432.1, runs: 55 });
    expect(account.stats.runs).toBe(
      characters.fire.progress.runs + characters.summon.progress.runs,
    );
    expect(account.lastCharacter).toBe('fire');
    expect(account.pendingV1).toBeNull();
    expect(account.singularity).toEqual(fresh.account.singularity);
  });

  it('holds M1’s enemy types met, sorted (the lead’s ruling K3)', () => {
    expect(account.seenEnemies.length).toBeGreaterThan(0);
    expect(account.seenEnemies).toEqual([...account.seenEnemies].sort());
    for (const id of account.seenEnemies) {
      expect(['triangle', 'square', 'pentagon', 'shard', 'hexagon', 'boss']).toContain(id);
      expect(ENEMY_IDS).toContain(id);
    }
  });

  it('formats the file as the repository formats JSON, around the same save', async () => {
    const file = await fixtureV2File();
    expect(file).not.toBe(TEXT);
    expect(JSON.stringify(JSON.parse(file))).toBe(TEXT);
  });
});
