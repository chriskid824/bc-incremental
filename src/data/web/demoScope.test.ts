import { describe, expect, it } from 'vitest';
import { revealedOuters, viewIn } from '../../meta/web/reveal';
import { assembleWeb } from './assemble';
import { loadContent } from './index';
import { DEMO_SCOPE_A } from './scope';

const content = loadContent();
/** B3's boards: they belong to the full game only. */
const B3_OUTERS = ['lightning', 'bleed', 'barrage'] as const;

describe('the Demo holds none of B3 (DEMO_SCOPE_A; Hoshi 2026-11-05: Demo and full kept apart)', () => {
  it('does not assemble 霜晶', () => {
    expect(() => assembleWeb(content, 'ice', DEMO_SCOPE_A)).toThrow(
      "does not list character 'ice'",
    );
  });

  it.each(['fire', 'summon'] as const)(
    "locks B3's outers on %s's web, even once every outer is revealed, and has none of their nodes",
    (c) => {
      const web = assembleWeb(content, c, DEMO_SCOPE_A);
      const revealed = revealedOuters(web.def, 100);
      for (const outer of B3_OUTERS) expect(viewIn(web, revealed, outer), outer).toBe('locked');
      const b3 = web.nodes.filter((node) =>
        B3_OUTERS.some((o) => node.board === `outer.${o}` || node.board.endsWith(`.${o}`)),
      );
      expect(b3).toEqual([]);
      expect(web.scope.waveCap).toBe(40);
    },
  );
});
