/**
 * names.ts (docs/v3 C6 design §4.7; gd §5.1, §5.4): the 44 fusion names in zh-TW and English
 * (Q3 (A)), the titles and the names of the generated nodes.
 */

import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, OUTER_IDS } from '../../data/sources';
import type { CharacterId } from '../../data/sources';
import { assembleWeb, FULL_SCOPE } from '../../data/web';
import type { FusionKey } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import { MESSAGES } from '../../i18n';
import { GD_FUSION_NAMES } from './check';
import { fusionName, fusionTitle, nodeName } from './names';
import { fixtureLookups } from './testing';
import { messageLookup } from './text';

const lookups = fixtureLookups();
const keysOf = (c: CharacterId): FusionKey[] =>
  OUTER_IDS.filter((o) => o !== c).map((o) => `${c}.${o}` as FusionKey);

/** gd §5.4's names, each character's in OUTER_IDS order. */
const GD: Readonly<Record<CharacterId, string>> = {
  fire: '火毒 火血 火雷 火連 火暴 火冰 火光 火棘 火靈 火彈 火金',
  ice: '冰火 冰毒 冰血 冰雷 冰連 冰暴 冰光 冰棘 冰靈 冰彈 冰金',
  lightning: '雷火 雷毒 雷血 雷連 雷暴 雷冰 雷光 雷棘 雷靈 雷彈 雷金',
  summon:
    '火召喚 毒召喚 血召喚 雷召喚 連擊召喚 暴擊召喚 冰召喚 光環召喚 荊棘召喚 彈幕召喚 貪婪召喚',
};

/** Q3 (A): the center first, "<prefix> Swarm" for 蜂巢, "<center> Spirit" for the summon outer. */
const EN: Readonly<Record<CharacterId, string>> = {
  fire: 'Fire Poison,Fire Bleed,Fire Lightning,Fire Combo,Fire Crit,Fire Ice,Fire Aura,Fire Thorns,Fire Spirit,Fire Barrage,Fire Greed',
  ice: 'Ice Fire,Ice Poison,Ice Bleed,Ice Lightning,Ice Combo,Ice Crit,Ice Aura,Ice Thorns,Ice Spirit,Ice Barrage,Ice Greed',
  lightning:
    'Lightning Fire,Lightning Poison,Lightning Bleed,Lightning Combo,Lightning Crit,Lightning Ice,Lightning Aura,Lightning Thorns,Lightning Spirit,Lightning Barrage,Lightning Greed',
  summon:
    'Fire Swarm,Poison Swarm,Bleed Swarm,Lightning Swarm,Combo Swarm,Crit Swarm,Ice Swarm,Aura Swarm,Thorns Swarm,Barrage Swarm,Greed Swarm',
};

describe('fusionName (§4.7)', () => {
  it.each(CHARACTER_IDS)("writes gd §5.4's zh-TW names for %s", (c) => {
    const names = keysOf(c).map((key) => fusionName(key, lookups['zh-TW']));
    expect(names.join(' ')).toBe(GD[c]);
    const gd = GD_FUSION_NAMES[c] as Readonly<Record<string, string>>;
    expect(names).toEqual(keysOf(c).map((key) => gd[key.split('.')[1] as string]));
  });

  it.each(CHARACTER_IDS)('writes Q3 (A) English names for %s', (c) => {
    expect(
      keysOf(c)
        .map((key) => fusionName(key, lookups.en))
        .join(','),
    ).toBe(EN[c]);
  });

  it('reads through the lookup it is given', () => {
    const messages = { ...MESSAGES['zh-TW'], 'web.hivePrefix.crit': '暴' };
    expect(fusionName('summon.crit', messageLookup(messages))).toBe('暴召喚');
    expect(fusionName('fire.summon')).toBe('Fire Spirit');
  });
});

describe('fusionTitle and nodeName', () => {
  const fire = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);

  it("reads a fusion's title, the bare key while it is missing", () => {
    expect(fusionTitle('fire.poison', lookups['zh-TW'])).toBe('瘟爆');
    expect(fusionTitle('fire.poison', lookups.en)).toBe('Plague Bomb');
    expect(fusionTitle('fire.poison')).toBe('web.fusion.fire.poison.title');
  });

  it('names a node by its kind', () => {
    const name = (id: string) => nodeName(fire, id, lookups['zh-TW']);
    expect(name('fire.center.main.star-one')).toBe('星一');
    expect(name('fire.center.beta.r1')).toBe('傷害');
    expect(name('fire.center.beta.mastery')).toBe('乙系精通');
    expect(name('fusion.fire.ice.mastery')).toBe('火冰精通');
    expect(name('fusion.fire.ice.core')).toBe('火冰「霜焰」');
    expect(name('hub.might.might')).toBe('強化∞');
    expect(nodeName(fire, 'fire.center.main.star-one')).toBe(
      'web.node.fire.center.main.star-one.name',
    );
    expect(() => nodeName(fire, 'outer.poison.main.nope', lookups.en)).toThrow(
      "node 'outer.poison.main.nope' is not on character 'fire''s web",
    );
  });
});
