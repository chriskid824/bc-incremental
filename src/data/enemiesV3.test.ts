import { describe, expect, it } from 'vitest';
import { ENEMIES } from './enemies';
import { V3_ENEMIES } from './enemiesV3';
import { characterGameData, loadGameData } from './index';
import { ENEMY_IDS } from './types';
import type { EnemyDef, EnemyId } from './types';
import { WAVES } from './waves';
import { V3_WAVES } from './wavesV3';

/** M1's six defs as C6.9 (304c668) had them, plus the two flags. */
const M1_DEFS: Readonly<Partial<Record<EnemyId, EnemyDef>>> = {
  triangle: {
    id: 'triangle',
    shape: 'triangle',
    hpMult: 0.5,
    speed: 160,
    radius: 16,
    contactDamage: 2,
    dropMult: 0.5,
    cores: 0,
    color: 0xff4fd8,
    tough: false,
    boss: false,
  },
  square: {
    id: 'square',
    shape: 'square',
    hpMult: 1,
    speed: 110,
    radius: 20,
    contactDamage: 4,
    dropMult: 1,
    cores: 0,
    color: 0x5b6cff,
    tough: false,
    boss: false,
  },
  pentagon: {
    id: 'pentagon',
    shape: 'pentagon',
    hpMult: 1,
    speed: 150,
    radius: 22,
    contactDamage: 3,
    dropMult: 1,
    cores: 0,
    splitInto: { enemy: 'shard', count: 3 },
    color: 0x3fe07a,
    tough: false,
    boss: false,
  },
  shard: {
    id: 'shard',
    shape: 'triangle',
    hpMult: 0.25,
    speed: 200,
    radius: 10,
    contactDamage: 1,
    dropMult: 0.25,
    cores: 0,
    color: 0xa6f7bf,
    tough: false,
    boss: false,
  },
  hexagon: {
    id: 'hexagon',
    shape: 'hexagon',
    hpMult: 14,
    speed: 90,
    radius: 34,
    contactDamage: 30,
    dropMult: 14,
    cores: 1,
    color: 0xa45cff,
    tough: true,
    boss: false,
  },
  boss: {
    id: 'boss',
    shape: 'octagon',
    hpMult: 28,
    speed: 45,
    radius: 70,
    contactDamage: 100,
    dropMult: 16,
    cores: 3,
    color: 0xff3d8b,
    tough: true,
    boss: true,
  },
};

const M1_IDS = ['triangle', 'square', 'pentagon', 'shard', 'hexagon', 'boss'] as const;

/** The seven v3 defs as the C7 design's §1.2 table and colours give them, every field. */
const V3_DEFS: Readonly<Partial<Record<EnemyId, EnemyDef>>> = {
  shielder: {
    id: 'shielder',
    shape: 'circle',
    hpMult: 1.5,
    speed: 100,
    radius: 22,
    contactDamage: 5,
    dropMult: 1.5,
    cores: 0,
    color: 0xe8ecf2,
    tough: false,
    boss: false,
    behaviour: { kind: 'shield', blockBelowPct: 0.15 },
  },
  regenerator: {
    id: 'regenerator',
    shape: 'cross',
    hpMult: 1.5,
    speed: 110,
    radius: 20,
    contactDamage: 4,
    dropMult: 1.5,
    cores: 0,
    color: 0xe8ecf2,
    tough: false,
    boss: false,
    behaviour: { kind: 'regen', lifePctPerSec: 0.08 },
  },
  dasher: {
    id: 'dasher',
    shape: 'rhombus',
    hpMult: 1,
    speed: 110,
    radius: 18,
    contactDamage: 6,
    dropMult: 1,
    cores: 0,
    color: 0xe8ecf2,
    tough: false,
    boss: false,
    behaviour: { kind: 'dash', chargeDist: 420, chargeSec: 0.6, dashMult: 4 },
  },
  shooter: {
    id: 'shooter',
    shape: 'trapezoid',
    hpMult: 1,
    speed: 120,
    radius: 20,
    contactDamage: 3,
    dropMult: 1,
    cores: 0,
    color: 0xe8ecf2,
    tough: false,
    boss: false,
    behaviour: { kind: 'shoot', stopDist: 300, periodSec: 2, bulletSpeed: 200, bulletDamage: 3 },
  },
  summoner: {
    id: 'summoner',
    shape: 'ring',
    hpMult: 3,
    speed: 90,
    radius: 22,
    contactDamage: 8,
    dropMult: 3,
    cores: 0,
    color: 0xe8ecf2,
    tough: false,
    boss: false,
    behaviour: { kind: 'summon', stopDist: 480, periodSec: 3, enemy: 'triangle', count: 2 },
  },
  treasure: {
    id: 'treasure',
    shape: 'diamond',
    hpMult: 2,
    speed: 150,
    radius: 14,
    contactDamage: 0,
    dropMult: 20,
    cores: 1,
    color: 0xffd23f,
    tough: false,
    boss: false,
    behaviour: { kind: 'treasure', orbitDist: 480, orbitSec: 8, fleeMult: 2 },
  },
  onion: {
    id: 'onion',
    shape: 'onion',
    hpMult: 28,
    speed: 45,
    radius: 70,
    contactDamage: 100,
    dropMult: 16,
    cores: 3,
    color: 0xe8ecf2,
    tough: true,
    boss: true,
    behaviour: { kind: 'layers', layers: 3, burst: { enemy: 'triangle', count: 12 } },
  },
};

describe('the enemy roster (docs/v3 C7 design §1.2)', () => {
  it('appends the seven v3 ids to M1’s six, which keep their order', () => {
    expect(ENEMY_IDS).toEqual([
      ...M1_IDS,
      'shielder',
      'regenerator',
      'dasher',
      'shooter',
      'summoner',
      'treasure',
      'onion',
    ]);
  });

  it('keeps M1’s six defs as they were, with only the two flags added', () => {
    for (const id of M1_IDS) {
      expect(ENEMIES[id], id).toEqual(M1_DEFS[id]);
      expect(loadGameData().enemies[id], id).toEqual(M1_DEFS[id]);
    }
  });

  it('defines the seven v3 types as the design’s table gives them, every field', () => {
    expect(Object.keys(V3_ENEMIES)).toEqual(Object.keys(V3_DEFS));
    for (const id of Object.keys(V3_DEFS) as EnemyId[]) {
      expect(V3_ENEMIES[id as keyof typeof V3_ENEMIES], id).toEqual(V3_DEFS[id]);
      expect(ENEMIES[id], id).toEqual(V3_DEFS[id]);
      expect(characterGameData().enemies[id], id).toEqual(V3_DEFS[id]);
    }
  });

  it('flags reproduce the id checks they replace: tough for the elite and the bosses, boss for the bosses', () => {
    for (const data of [loadGameData(), characterGameData()]) {
      for (const id of ENEMY_IDS) {
        const def = data.enemies[id];
        if ((M1_IDS as readonly EnemyId[]).includes(id)) {
          expect(def.tough, id).toBe(id === 'hexagon' || id === 'boss');
        }
        expect(def.boss, id).toBe(id === 'boss' || id === 'onion');
        if (def.boss) expect(def.tough, id).toBe(true);
      }
    }
    // The v3 types other than the onion are neither.
    for (const def of Object.values(V3_ENEMIES)) expect(def.tough).toBe(def.id === 'onion');
  });

  it('gives each v3 type its behaviour and keeps every non-tough radius within 22 (shotPad)', () => {
    const kinds = Object.fromEntries(
      Object.values(V3_ENEMIES).map((def) => [def.id, def.behaviour.kind]),
    );
    expect(kinds).toEqual({
      shielder: 'shield',
      regenerator: 'regen',
      dasher: 'dash',
      shooter: 'shoot',
      summoner: 'summon',
      treasure: 'treasure',
      onion: 'layers',
    });
    for (const def of Object.values(loadGameData().enemies)) {
      if (!def.tough) expect(def.radius, def.id).toBeLessThanOrEqual(22);
    }
  });
});

describe('characterGameData (docs/v3 C7 design §1.1)', () => {
  it('holds the v3 block that makes a run v3, which loadGameData never does', () => {
    expect(loadGameData().waves.v3).toBeUndefined();
    expect(WAVES).not.toHaveProperty('v3');
    expect(characterGameData().waves.v3).toEqual(V3_WAVES.v3);
    expect(characterGameData().waves.v3).toEqual({
      enemyCap: 400,
      bossRotation: ['onion'],
      affixes: [
        { fromWave: 5, count: 1 },
        { fromWave: 25, count: 2 },
        { fromWave: 60, count: 3 },
      ],
      treasure: { enemy: 'treasure', fromWave: 15, every: 5 },
    });
  });

  it('is validated once and shared, with the same enemies and talents as loadGameData', () => {
    const data = characterGameData();
    expect(characterGameData()).toBe(data);
    expect(data).not.toBe(loadGameData());
    expect(data.enemies).toEqual(loadGameData().enemies);
    expect(data.talents).toEqual(loadGameData().talents);
    expect(Object.isFrozen(data.waves.v3)).toBe(true);
  });

  it('keeps M1’s rules first and M1’s wave settings, then the v3 types’ rules', () => {
    const { rules, v3, ...settings } = characterGameData().waves;
    const { rules: m1Rules, ...m1Settings } = WAVES;
    expect(v3).toBeDefined();
    expect(settings).toEqual(m1Settings);
    expect(rules.slice(0, m1Rules.length)).toEqual(m1Rules);
    expect(rules.slice(m1Rules.length)).toEqual([
      { enemy: 'shielder', fromWave: 12, base: 3, perWave: 0.3, maxCount: 18 },
      { enemy: 'regenerator', fromWave: 16, base: 3, perWave: 0.3, maxCount: 18 },
      { enemy: 'dasher', fromWave: 22, base: 3, perWave: 0.3, maxCount: 18 },
      { enemy: 'shooter', fromWave: 32, base: 2, perWave: 0.2, maxCount: 10 },
      { enemy: 'summoner', fromWave: 42, base: 1, perWave: 0.1, maxCount: 4 },
    ]);
  });
});
