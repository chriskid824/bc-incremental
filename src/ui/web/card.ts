/**
 * The preview card 「接到你的角色會得到什麼」 (docs/v3 C6 design §3.9, §4.7; impl:453, gd:817): what
 * an outer gives the character, read off the assembled web. A template fusion's rule is its core's
 * generated text (the event's fan-out of the payload, the bonus, then the override's added
 * triggers); a hand fusion's is its core's hand description (AMB31).
 */

import type { OuterId } from '../../data/sources';
import { ROW_ENEMIES } from '../../data/web/types';
import type { AssembledWeb, FusionKey } from '../../data/web/types';
import { fusionProgress } from '../../meta/web';
import type { CharacterProgress, GateProgress } from '../../meta/web';
import { APP_LOOKUP, fusionName, fusionTitle, say } from './names';
import { describeNode } from './text';
import type { TextLookup } from './text';

export interface PreviewCard {
  readonly outer: string;
  readonly entry: readonly string[];
  /** null when the fusion is deferred or locked. */
  readonly fusion: {
    readonly name: string;
    readonly title: string;
    readonly hand: boolean;
    readonly rule: readonly string[];
  } | null;
  readonly covers: { readonly answer: readonly string[]; readonly helps: readonly string[] };
  readonly gate: GateProgress;
}

/**
 * The card of `outer` on `web` at `progress`: the outer's name, its entry's lines, the fusion and
 * its rule at the fusion's coef, the row enemies it answers and helps against (gd §6.5's ◆ and ＋,
 * in the row's order) and the fusion gate (「中心 8/8・毒 3/6」). An outer the web does not hold
 * open (locked by the scope, or not written yet) shows its name and gate only.
 */
export function previewCard(
  web: AssembledWeb,
  progress: CharacterProgress,
  outer: OuterId,
  lookup: TextLookup = APP_LOOKUP,
): PreviewCard {
  const def = web.outers.get(outer);
  const entry = def?.board.nodes.find((node) => node.kind === 'entry');
  const fusion = web.fusions.get(outer);
  const key = `${web.character}.${outer}` as FusionKey;
  const names = (cover: 'answer' | 'helps'): string[] =>
    ROW_ENEMIES.filter((enemy) => def?.covers[enemy] === cover).map((enemy) =>
      say(lookup, `web.enemy.${enemy}`),
    );
  const { center, centerNeed, outer: count, outerNeed } = fusionProgress(web, progress, outer);
  return {
    outer: say(lookup, `web.outer.${outer}.name`),
    entry: entry === undefined ? [] : describeNode(web, entry.id, 1, lookup).lines,
    fusion:
      fusion === undefined
        ? null
        : {
            name: fusionName(key, lookup),
            title: fusionTitle(key, lookup),
            hand: fusion.kind === 'hand',
            rule: describeNode(web, `fusion.${key}.core`, 1, lookup).lines,
          },
    covers: { answer: names('answer'), helps: names('helps') },
    gate: { center, centerNeed, outer: count, outerNeed },
  };
}
