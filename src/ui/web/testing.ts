/**
 * The fixture's text (docs/v3 C6 design F45; the lead's ruling R2): each locale's shipped messages
 * plus every content key fixtureContent()'s webs need (node, branch, ascendancy and character
 * text, the 44 fusion titles, the descriptions), so V17, V19 and the card tests run on the fixture
 * and the viewer's `?fixture` shows it with no fixture key in the shipped JSON. Imported by tests
 * and the dev viewer only, as src/data/web/testing.ts is; no module of the build imports it.
 */

import { CHARACTER_IDS } from '../../data/sources';
import type { CharacterId, OuterId } from '../../data/sources';
import { assembleWeb } from '../../data/web/assemble';
import { MAIN_BRANCH, parseNodeId } from '../../data/web/ids';
import { FULL_SCOPE } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import { NAMED_KINDS } from '../../data/web/types';
import type { AssembledWeb, WebNode } from '../../data/web/types';
import { MESSAGES } from '../../i18n';
import type { Locale } from '../../i18n';
import { messageLookup } from './text';
import type { TextLookup } from './text';

type Text = readonly [en: string, zh: string];

/** The fixture's slug words (src/data/web/testing.ts). */
const WORDS: Readonly<Record<string, Text>> = {
  alpha: ['Alpha', '甲'],
  beta: ['Beta', '乙'],
  gamma: ['Gamma', '丙'],
  one: ['One', '一'],
  two: ['Two', '二'],
  three: ['Three', '三'],
  four: ['Four', '四'],
  star: ['Star', '星'],
  counter: ['Counter', '剋星'],
  defense: ['Defense', '防禦'],
  economy: ['Economy', '經濟'],
  echo: ['Echo', '迴響'],
  rule: ['Rule', '規則'],
  path: ['Path', '路線'],
};

/** Slot names that name a node. */
const SLOTS: Readonly<Record<string, Text>> = {
  signature: ['Signature', '招牌'],
  threshold: ['Threshold', '門檻'],
  entry: ['Entry', '入口'],
  n1: ['First Step', '第一步'],
  n2: ['Second Step', '第二步'],
  final: ['Final', '終極'],
};

const BRANCHES: Readonly<Record<string, Text>> = {
  alpha: ['Alpha', '甲系'],
  beta: ['Beta', '乙系'],
  gamma: ['Gamma', '丙系'],
  might: ['Might', '強化'],
  defense: ['Defense', '防禦'],
  economy: ['Economy', '經濟'],
  echo: ['Echo', '迴響'],
  rules: ['Rules', '規則'],
};

const word = (slug: string): Text => {
  if (SLOTS[slug] !== undefined) return SLOTS[slug];
  const words = slug.split('-').map((part) => WORDS[part] ?? [part, part]);
  return [words.map(([en]) => en).join(' '), words.map(([, zh]) => zh).join('')];
};

/** gd §5.4's titles in English (written in §4.7's style) and zh-TW, by character and outer. */
const TITLES: { readonly [C in CharacterId]: Readonly<Record<Exclude<OuterId, C>, Text>> } = {
  fire: {
    ice: ['Frostflame', '霜焰'],
    lightning: ['Plasma', '電漿'],
    summon: ['Blast Spirit', '爆靈'],
    poison: ['Plague Bomb', '瘟爆'],
    bleed: ['Bloodflame', '血焰'],
    crit: ['Blast Slash', '爆斬'],
    barrage: ['Scatterfire', '散火'],
    combo: ['Quickflame', '疾焰'],
    aura: ['Forgelight', '爐光'],
    greed: ['Molten Gold', '熔金'],
    thorns: ['Fire Thorn', '火刺'],
  },
  ice: {
    fire: ['Thermal Shock', '熱震'],
    lightning: ['Superconductor', '超導'],
    summon: ['Ice Sentry', '冰晶哨'],
    poison: ['Rotfrost', '腐霜'],
    bleed: ['Frostbite', '凍傷'],
    crit: ['Shatter Slash', '碎斬'],
    barrage: ['Hailshot', '霰彈'],
    combo: ['Frost Rhythm', '霜律'],
    aura: ['Permafrost', '永凍'],
    greed: ['Frost Coin', '霜幣'],
    thorns: ['Frost Thorn', '霜棘'],
  },
  lightning: {
    fire: ['Fuse', '引信'],
    ice: ['Ice Chain', '冰鏈'],
    summon: ['Volt Bee', '電蜂'],
    poison: ['Toxic Arc', '毒弧'],
    bleed: ['Crimson Arc', '赤弧'],
    crit: ['Thunder Slash', '雷斬'],
    barrage: ['Scatterbolt', '散雷'],
    combo: ['Thunder Drum', '雷鼓'],
    aura: ['Storm Field', '雷域'],
    greed: ['Volt Coin', '電幣'],
    thorns: ['Volt Thorn', '電棘'],
  },
  summon: {
    fire: ['Flame Bee', '焰蜂'],
    ice: ['Frost Bee', '霜蜂'],
    lightning: ['Netbee', '雷網蜂'],
    poison: ['Toxic Bubble', '毒泡'],
    bleed: ['Leech', '血蛭'],
    crit: ['Bladewing', '刃翼'],
    barrage: ['Autocannon', '機砲'],
    combo: ['Swiftwing', '疾翼'],
    aura: ['Firefly', '螢火'],
    greed: ['Gold Bee', '金蜂'],
    thorns: ['Thornshell', '棘甲'],
  },
};

/** The text of the rule each archetype lends the fixture's hand cores, at its numbers. */
const RULE_TEXT: Readonly<Record<CharacterId, Text>> = {
  fire: ['Burns have no stack cap; burn duration −50%.', '燃燒層數沒有上限；燃燒持續時間 −50%。'],
  ice: [
    'Every 3rd shot is a guaranteed crit and the crit multiplier ×1.5; no random crits.',
    '每第 3 發必定暴擊，暴擊倍率 ×1.5；不會隨機暴擊。',
  ],
  lightning: [
    'Chain count ×2 and chain hits deal ×4.5 damage; chain retention −20 percentage points.',
    '連鎖次數 ×2，連鎖擊中的傷害 ×4.5；保留率 −20 個百分點。',
  ],
  summon: ['All damage ×2; your life becomes 1.', '所有傷害 ×2；生命變成 1。'],
};

/** 冰光's and 雷光's cores, which add a rule to their template trigger (D12). */
const RULE_OVERRIDE_TEXT: Readonly<Record<string, Text>> = {
  'fusion.ice.aura.core': [
    `On each freeze, a 2 s pulse zone at the target; enemies in it take {bonus} center damage. ${RULE_TEXT.ice[0]}`,
    `凍結時在目標留下 2 秒脈衝區，區內的敵人受到中心傷害 {bonus}；${RULE_TEXT.ice[1]}`,
  ],
  'fusion.lightning.aura.core': [
    `Each jump has a {chance} chance to leave a 2 s pulse zone at the target; enemies in it take {bonus} center damage. ${RULE_TEXT.lightning[0]}`,
    `每跳有 {chance} 機率在目標留下 2 秒脈衝區，區內的敵人受到中心傷害 {bonus}；${RULE_TEXT.lightning[1]}`,
  ],
};

/** A named node's name, from its slot or slug. */
function nameOf(node: WebNode): Text {
  const parsed = parseNodeId(node.id);
  if (parsed === null || parsed.block === 'fusion') throw new Error(`no name for '${node.id}'`);
  return word(parsed.block === 'asc' ? parsed.slot : parsed.name);
}

/** A described node's text: a ★'s, a final's, a hand core's or a rule override's. */
function descOf(web: AssembledWeb, node: WebNode): Text | null {
  if (node.kind === 'keystone') {
    return ['A fixture keystone with no effect.', '測試用的關鍵天賦，沒有效果。'];
  }
  if (node.kind === 'ascFinal') {
    return ['A fixture ascendancy final with no effect.', '測試用的昇華終極，沒有效果。'];
  }
  if (node.kind !== 'core') return null;
  const outer = node.board.split('.')[2] as OuterId;
  if (web.fusions.get(outer)?.kind === 'hand') return RULE_TEXT[outer as CharacterId];
  return RULE_OVERRIDE_TEXT[node.id] ?? null;
}

/** The fixture's content keys in both locales, from its full-scope webs. */
function contentKeys(): Readonly<Record<Locale, Record<string, string>>> {
  const keys: Record<Locale, Record<string, string>> = { en: {}, 'zh-TW': {} };
  const put = (key: string, [en, zh]: Text): void => {
    keys.en[key] = en;
    keys['zh-TW'][key] = zh;
  };
  const content = fixtureContent();
  for (const c of CHARACTER_IDS) {
    const web = assembleWeb(content, c, FULL_SCOPE);
    put(web.def.introKey, ['Fixture character', '測試用角色']);
    for (const ascendancy of web.def.ascendancies ?? []) {
      put(`web.asc.${c}.${ascendancy.slug}.name`, word(ascendancy.slug));
    }
    for (const fusion of web.fusions.values()) {
      const outer = fusion.key.split('.')[1] as Exclude<OuterId, typeof c>;
      put(
        `web.fusion.${fusion.key}.title`,
        (TITLES[c] as Readonly<Record<string, Text>>)[outer] as Text,
      );
    }
    for (const node of web.nodes) {
      if (NAMED_KINDS.includes(node.kind)) put(`web.node.${node.id}.name`, nameOf(node));
      const desc = descOf(web, node);
      if (desc !== null) put(`web.node.${node.id}.desc`, desc);
      const parsed = parseNodeId(node.id);
      if (
        (parsed?.block === 'center' || parsed?.block === 'outer') &&
        parsed.branch !== MAIN_BRANCH
      ) {
        put(`web.branch.${parsed.board}.${parsed.branch}`, BRANCHES[parsed.branch] as Text);
      }
      if (parsed?.block === 'hub')
        put(`web.branch.hub.${parsed.group}`, BRANCHES[parsed.group] as Text);
    }
  }
  return keys;
}

/** Fresh copies of each locale's messages with the fixture's content keys, for a test to patch. */
export function fixtureMessages(): Record<Locale, Record<string, string>> {
  const keys = contentKeys();
  return {
    en: { ...MESSAGES.en, ...keys.en },
    'zh-TW': { ...MESSAGES['zh-TW'], ...keys['zh-TW'] },
  };
}

/** One lookup per locale over `messages` (default: fixtureMessages()). */
export function fixtureLookups(
  messages: Readonly<Record<Locale, Readonly<Record<string, string>>>> = fixtureMessages(),
): Readonly<Record<Locale, TextLookup>> {
  return { en: messageLookup(messages.en), 'zh-TW': messageLookup(messages['zh-TW']) };
}
