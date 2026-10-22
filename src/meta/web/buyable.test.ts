import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../../data/sources';
import type { CharacterId } from '../../data/sources';
import { assembleWeb, scopeHolds } from '../../data/web/assemble';
import { DEMO_SCOPE_A, SCOPES } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import type { AssembledWeb, WebScope } from '../../data/web/types';
import { buyabilityIssues, orderIssues } from './buyable';

const content = fixtureContent();

/** Every character's web in every scope that holds it. */
const WEBS: readonly (readonly [string, CharacterId, WebScope])[] = SCOPES.flatMap((scope) =>
  CHARACTER_IDS.filter((c) => scopeHolds(scope.characters, c)).map(
    (c) => [`${c} in ${scope.name}`, c, scope] as const,
  ),
);

/** `c`'s web with `defaultOrder` set on a copy of its fixture def (the fixture's is []). */
function withOrder(order: readonly string[], scope: WebScope, c: CharacterId = 'fire') {
  const def = { ...content.characters[c], defaultOrder: order };
  return assembleWeb({ ...content, characters: { ...content.characters, [c]: def } }, c, scope);
}

/** `web` without the edges between each pair. */
function cut(web: AssembledWeb, pairs: readonly (readonly [string, string])[]): AssembledWeb {
  const gone = new Set(pairs.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  const neighbours = new Map(
    [...web.neighbours].map(([id, list]) => [
      id,
      list.filter((other) => !gone.has(`${id}|${other}`)),
    ]),
  );
  return { ...web, edges: web.edges.filter(([a, b]) => !gone.has(`${a}|${b}`)), neighbours };
}

const C = 'fire.center';
const P = 'outer.poison';
/** Four cuts that leave outer.poison 7 nodes before its threshold, and two islands. */
const POISON_CUTS = [
  [`${P}.alpha.r3`, `${P}.alpha.r4`],
  [`${P}.alpha.alpha-two`, `${P}.alpha.mastery`],
  [`${P}.main.entry`, `${P}.beta.r1`],
  [`${P}.main.counter`, `${P}.beta.beta-two`],
] as const;
const ISLANDS = [
  `${P}.alpha.r4`,
  `${P}.alpha.mastery`,
  `${P}.beta.r1`,
  `${P}.beta.r2`,
  `${P}.beta.beta-one`,
  `${P}.beta.r3`,
  `${P}.beta.r4`,
  `${P}.beta.beta-two`,
  `${P}.beta.mastery`,
];

describe('buyabilityIssues (V15)', () => {
  it.each(WEBS)('finds a legal order to every visible node of %s', (_name, c, scope) => {
    expect(buyabilityIssues(assembleWeb(content, c, scope))).toEqual([]);
  });

  it('reports a node no legal order reaches with the state it stopped in (§4.8’s example)', () => {
    const web = cut(assembleWeb(content, 'fire', DEMO_SCOPE_A), POISON_CUTS);
    const at = (id: string) =>
      `node '${id}' (character 'fire', scope 'demoA'): no legal order reaches it; `;
    expect(buyabilityIssues(web)).toEqual([
      ...ISLANDS.slice(0, 2).map(
        (id) => `${at(id)}it stopped at notAdjacent with no path from '${C}.main.signature'`,
      ),
      ...ISLANDS.slice(2).map(
        (id) => `${at(id)}it stopped at notAdjacent with no path from '${C}.main.signature'`,
      ),
      `${at(`${P}.main.threshold`)}it stopped at outerGate with 7 of 8 nodes on 'outer.poison'`,
    ]);
  });

  it('checks only the outers visible at best wave 30 within the wave cap', () => {
    // Capped at 14, fire sees its three recommended outers; poison stays hidden.
    const capped = { ...DEMO_SCOPE_A, name: 'capped', waveCap: 14 };
    expect(buyabilityIssues(cut(assembleWeb(content, 'fire', capped), POISON_CUTS))).toEqual([]);
  });

  it('reports a core whose outer cannot reach 6 counted nodes, and an unreachable final', () => {
    const fire = assembleWeb(content, 'fire', DEMO_SCOPE_A);
    // outer.poison keeps 5 nodes joined to its entry: the entry, alpha r1, r2, ◆a and ◆b.
    const short = cut(fire, [
      [`${P}.main.entry`, `${P}.beta.r1`],
      [`${P}.alpha.alpha-one`, `${P}.alpha.r3`],
      [`${P}.alpha.alpha-two`, `${P}.alpha.mastery`],
      [`${P}.alpha.alpha-two`, `${P}.main.counter`],
    ]);
    const stop =
      "it stopped at fusionGate with 8 of 8 nodes on 'fire.center' and 5 of 6 on 'outer.poison'";
    const issues = buyabilityIssues(short);
    for (const id of ['core', 'r1', 'mastery'].map((slot) => `fusion.fire.poison.${slot}`)) {
      expect(issues).toContain(
        `node '${id}' (character 'fire', scope 'demoA'): no legal order reaches it; ${stop}`,
      );
    }
    const final = 'fire.asc.path-one.final';
    expect(buyabilityIssues(cut(fire, [['fire.asc.path-one.n2', final]]))).toEqual([
      `node '${final}' (character 'fire', scope 'demoA'): no legal order reaches it; ` +
        `it stopped at notAdjacent with no path from '${C}.main.signature'`,
    ]);
  });
});

describe('orderIssues (V25)', () => {
  it.each(WEBS)('passes the fixture’s empty defaultOrder for %s', (_name, c, scope) => {
    expect(orderIssues(assembleWeb(content, c, scope))).toEqual([]);
  });

  /** fire's purchases 0–16: 11 center nodes, ranks by repetition, c3 next to the threshold. */
  const SEVENTEEN = [
    ...Array(3).fill(`${C}.alpha.r1`),
    ...Array(3).fill(`${C}.alpha.r2`),
    `${C}.alpha.alpha-one`,
    `${C}.beta.r1`,
    `${C}.beta.r2`,
    `${C}.beta.beta-one`,
    `${C}.beta.r3`,
    `${C}.main.c3`,
    `${C}.alpha.r3`,
    `${C}.alpha.r4`,
    ...Array(3).fill(`${C}.main.c1`),
  ] as string[];
  const FILE = 'src/data/characters/fire.ts';

  it('passes a legal order, ranks by repetition', () => {
    const web = withOrder([...SEVENTEEN, `${C}.gamma.r1`, `${C}.main.threshold`], DEMO_SCOPE_A);
    expect(orderIssues(web)).toEqual([]);
  });

  it('reports §4.8’s example: a gate the order meets too late', () => {
    const web = withOrder([...SEVENTEEN, `${C}.main.threshold`, `${C}.gamma.r1`], DEMO_SCOPE_A);
    expect(orderIssues(web)).toEqual([
      `character 'fire' defaultOrder[17] '${C}.main.threshold' (${FILE}): centerGate with 11 of 12; ` +
        'move it after another center node',
    ]);
  });

  it('reports every id the web does not hold first, with a near name or the locked board', () => {
    const web = withOrder(
      [
        `${C}.alpha.r1`,
        `${C}.alpha.alpha-on`,
        `${C}.zzz.qqq`,
        'outer.bleed.main.entry',
        `${C}.alpha.r3`,
      ],
      DEMO_SCOPE_A,
    );
    expect(orderIssues(web)).toEqual([
      `character 'fire' defaultOrder[1] '${C}.alpha.alpha-on' (${FILE}): unknown; did you mean '${C}.alpha.alpha-one'?`,
      `character 'fire' defaultOrder[2] '${C}.zzz.qqq' (${FILE}): unknown; no node of web 'fire' has this id`,
      `character 'fire' defaultOrder[3] 'outer.bleed.main.entry' (${FILE}): locked; scope 'demoA' locks its board; leave it out`,
    ]);
  });

  it.each([
    [
      [...Array(4).fill(`${C}.alpha.r1`)],
      "defaultOrder[3] 'fire.center.alpha.r1' (src/data/characters/fire.ts): maxRank; it has 3 ranks; drop the repeat",
    ],
    [
      [`${C}.alpha.r1`, `${C}.alpha.r3`],
      "defaultOrder[1] 'fire.center.alpha.r3' (src/data/characters/fire.ts): notAdjacent; move it after one of its neighbours",
    ],
    [
      [
        `${C}.alpha.r1`,
        `${C}.alpha.r2`,
        `${C}.alpha.alpha-one`,
        `${C}.alpha.r3`,
        `${C}.main.c1`,
        'hub.defense.r1',
        'fusion.fire.poison.core',
      ],
      "defaultOrder[6] 'fusion.fire.poison.core' (src/data/characters/fire.ts): fusionGate with 5 of 8 center " +
        "nodes and 0 of 6 on 'outer.poison'; move it after the center has 8 and 'outer.poison' 6 nodes",
    ],
    [
      [
        `${C}.alpha.r1`,
        `${C}.alpha.r2`,
        `${C}.alpha.alpha-one`,
        `${C}.alpha.r3`,
        `${C}.main.c1`,
        'hub.defense.r1',
        'hub.might.might',
        'fire.asc.path-one.n1',
        'fire.asc.path-two.n1',
      ],
      "defaultOrder[8] 'fire.asc.path-two.n1' (src/data/characters/fire.ts): otherAscendancy; " +
        "the order chose ascendancy 'path-one' first; keep to one chain",
    ],
  ] as const)('reports the first refused purchase: %o', (order, message) => {
    expect(orderIssues(withOrder(order as readonly string[], DEMO_SCOPE_A))).toEqual([
      `character 'fire' ${message}`,
    ]);
  });

  it('names the order’s character and its file', () => {
    const web = withOrder(['summon.center.alpha.r2'], DEMO_SCOPE_A, 'summon');
    expect(orderIssues(web)).toEqual([
      "character 'summon' defaultOrder[0] 'summon.center.alpha.r2' (src/data/characters/summon.ts): " +
        'notAdjacent; move it after one of its neighbours',
    ]);
  });
});
