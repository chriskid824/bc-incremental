/**
 * Names on the v3 web (docs/v3 C6 design §3.9, §4.7; gd:510-513, impl:345): a fusion's name and
 * title, every node's name and a modifier's stat name, read through a TextLookup. The app's
 * lookup lives here too, so text.ts, card.ts and svg.ts can import it without a value-import
 * cycle (L8): this module imports text.ts' types only.
 */

import type { CharacterId, OuterId } from '../../data/sources';
import type { Modifier } from '../../data/stats';
import { parseNodeId } from '../../data/web/ids';
import { NAMED_KINDS } from '../../data/web/types';
import type { AssembledWeb, FusionKey } from '../../data/web/types';
import { isMessageKey, MESSAGES, t } from '../../i18n';
import type { MessageKey, MessageValues } from '../../i18n';
import type { TextLookup } from './text';

/** The app's lookup (R6): the merged messages of the current locale, as t reads them. */
export const APP_LOOKUP: TextLookup = {
  has: isMessageKey,
  get: (key, values) => t(key as MessageKey, values),
  keys: () => Object.keys(MESSAGES.en),
};

/**
 * A shipped key's text. `key` is a MessageKey, so a template-literal key over a union
 * (`web.tag.${tag}`) compiles only when every member's key ships (H15, L9).
 */
export function say(lookup: TextLookup, key: MessageKey, values?: MessageValues): string {
  return lookup.get(key, values);
}

/**
 * A content key's text (`web.node.*`, `web.branch.*`, `web.asc.*`, `web.fusion.*`,
 * `web.char.<c>.intro`), which only a batch writes: the key itself while it is missing, which
 * V17 reports.
 */
export function contentText(lookup: TextLookup, key: string, values?: MessageValues): string {
  return lookup.has(key) ? lookup.get(key, values) : key;
}

/** The name of a modifier's stat: its first tag's `stat.damage.<tag>` for tagged damage (M1's). */
export function statName(mod: Modifier, lookup: TextLookup = APP_LOOKUP): string {
  const tag = mod.tags?.[0];
  if (mod.stat === 'damage' && tag !== undefined) return say(lookup, `stat.damage.${tag}`);
  return say(lookup, `stat.${mod.stat}`);
}

/**
 * A fusion's name by gd's rule (§4.7): the center first (火毒, 冰火), 「X召喚」 with a per-outer
 * prefix for 蜂巢 (毒召喚, 暴擊召喚), 「X靈」 for the summon outer (火靈); English mirrors it
 * (Q3 (A): "Fire Poison", "Poison Swarm", "Fire Spirit").
 */
export function fusionName(key: FusionKey, lookup: TextLookup = APP_LOOKUP): string {
  const [c, o] = key.split('.') as [CharacterId, OuterId];
  if (c === 'summon') {
    const prefix = say(lookup, `web.hivePrefix.${o as Exclude<OuterId, 'summon'>}`);
    return say(lookup, 'web.fusionName.hive', { prefix });
  }
  if (o === 'summon')
    return say(lookup, 'web.fusionName.spirit', { c: say(lookup, `web.abbr.${c}`) });
  return say(lookup, 'web.fusionName.pair', {
    c: say(lookup, `web.abbr.${c}`),
    o: say(lookup, `web.abbr.${o}`),
  });
}

/** A fusion's title (瘟爆), hand-written by its batch: `web.fusion.<c>.<o>.title`. */
export function fusionTitle(key: FusionKey, lookup: TextLookup = APP_LOOKUP): string {
  return contentText(lookup, `web.fusion.${key}.title`);
}

/** The fusion key of a fusion board's id (`fusion.<c>.<o>`). */
export function fusionKeyOf(board: string): FusionKey {
  return board.slice('fusion.'.length) as FusionKey;
}

/**
 * A node's name (§4.7): `web.node.<id>.name` for a named kind (NAMED_KINDS); a ranked node by its
 * first modifier's stat, a mastery 「{branch}精通」 (a fusion's mastery by the fusion's name), a
 * core by its fusion's name and title, 強化∞ by its kind. Throws on an id the web does not hold.
 */
export function nodeName(web: AssembledWeb, id: string, lookup: TextLookup = APP_LOOKUP): string {
  const node = web.byId.get(id);
  if (node === undefined) {
    throw new Error(`node '${id}' is not on character '${web.character}''s web`);
  }
  if (!NAMED_KINDS.includes(node.kind)) {
    switch (node.kind) {
      case 'ranked': {
        const mod = node.effects.modifiers[0];
        return mod === undefined ? say(lookup, 'web.kind.ranked') : statName(mod, lookup);
      }
      case 'mastery':
        return say(lookup, 'web.masteryName', { branch: branchName(node.board, id, lookup) });
      case 'core': {
        const key = fusionKeyOf(node.board);
        return say(lookup, 'web.coreName', {
          name: fusionName(key, lookup),
          title: fusionTitle(key, lookup),
        });
      }
      case 'might':
        return say(lookup, 'web.kind.might');
    }
  }
  return contentText(lookup, `web.node.${id}.name`);
}

/** The branch a mastery closes: its branch's `web.branch.<board>.<slug>`, or its fusion's name. */
function branchName(board: string, id: string, lookup: TextLookup): string {
  if (board.startsWith('fusion.')) return fusionName(fusionKeyOf(board), lookup);
  const parsed = parseNodeId(id);
  const branch = parsed?.block === 'center' || parsed?.block === 'outer' ? parsed.branch : '';
  return contentText(lookup, `web.branch.${board}.${branch}`);
}
