import { describe, expect, it, vi } from 'vitest';
import { OUTER_IDS } from '../sources';
import type { CharacterId, OuterId } from '../sources';
import { assembleWeb, scopeHolds } from './assemble';
import { loadContent, parseContent } from './index';
import { DEMO_SCOPE_A, DEMO_SCOPE_B, FULL_SCOPE } from './scope';
import { fixtureContent } from './testing';
import type { AssembledWeb, BoardStatus, CalibrationEntry, Content, WebScope } from './types';
import type * as CharactersModule from '../characters';
import type * as AssembleModule from './assemble';
import type * as ValidateModule from './validate';

// assembleWeb and contentIssues, wrapped so the tests can see which webs loadContent assembles
// (N-6) and how often it validates (P8).
vi.mock('./assemble', async (importOriginal) => {
  const actual = await importOriginal<typeof AssembleModule>();
  return { ...actual, assembleWeb: vi.fn(actual.assembleWeb) };
});
vi.mock('./validate', async (importOriginal) => {
  const actual = await importOriginal<typeof ValidateModule>();
  return { ...actual, contentIssues: vi.fn(actual.contentIssues) };
});

/** The outers in clock order (src/data/sources.ts), as §4.4's frame places them. */
const CLOCKS: readonly OuterId[] = [
  'fire',
  'poison',
  'bleed',
  'lightning',
  'combo',
  'crit',
  'ice',
  'aura',
  'thorns',
  'summon',
  'barrage',
  'greed',
];
/** The hub's ring node at each clock (D15's fixed table, §4.4). */
const RING = [
  'hub.might.might',
  'hub.defense.r1',
  'hub.defense.r2',
  'hub.defense.r3',
  'hub.defense.r4',
  'hub.economy.r1',
  'hub.economy.r2',
  'hub.economy.r3',
  'hub.echo.r1',
  'hub.echo.r2',
  'hub.echo.r3',
  'hub.echo.r4',
];

const pair = ([a, b]: readonly [string, string]): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The edges of `web` that no board of `content` writes: §4.3 step 6's cross-board edges. */
function crossEdges(web: AssembledWeb, content: Content): string[] {
  const boards = [
    web.def.center,
    content.hub?.board,
    ...[...web.outers.values()].map((outer) => outer.board),
    ...[...web.fusions.values()].map((fusion) => fusion.board),
    ...(web.def.ascendancies ?? []).map((ascendancy) => ascendancy.board),
  ];
  const written = new Set(boards.flatMap((board) => board?.edges ?? []).map(pair));
  return web.edges.map(pair).filter((edge) => !written.has(edge));
}

/** The cross edges §4.3 step 6 gives `c`'s web when every block of it is open. */
function expectedCross(c: CharacterId, slugs: readonly string[]): string[] {
  const own = CLOCKS.indexOf(c);
  const edges: [string, string][] = [];
  for (let i = 1; i <= 6; i++) edges.push([`${c}.center.main.c${i}`, RING[2 * i - 1] as string]);
  CLOCKS.forEach((o, clock) => {
    if (o === c) return;
    edges.push([RING[clock] as string, `outer.${o}.main.entry`]);
    edges.push([RING[clock] as string, `fusion.${c}.${o}.core`]);
  });
  for (const slug of slugs) edges.push([RING[own] as string, `${c}.asc.${slug}.n1`]);
  return edges.map(pair);
}

const statuses = (web: AssembledWeb, kind: string): Record<string, BoardStatus> =>
  Object.fromEntries(
    web.boards.filter((board) => board.kind === kind).map((board) => [board.id, board.status]),
  );

describe('assembleWeb: the boards (§4.3, D16)', () => {
  it('opens every board of the full fixture in FULL_SCOPE', () => {
    expect(OUTER_IDS).toEqual(CLOCKS);
    const web = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);
    expect(web.boards).toEqual([
      { id: 'fire.center', kind: 'center', clock: null, status: 'open' },
      { id: 'hub', kind: 'hub', clock: null, status: 'open' },
      ...CLOCKS.slice(1).map((o, i) => ({
        id: `outer.${o}`,
        kind: 'outer',
        clock: i + 1,
        status: 'open',
      })),
      ...CLOCKS.slice(1).map((o, i) => ({
        id: `fusion.fire.${o}`,
        kind: 'fusion',
        clock: i + 1,
        status: 'open',
      })),
      { id: 'fire.asc.path-one', kind: 'asc', clock: 0, status: 'open' },
      { id: 'fire.asc.path-two', kind: 'asc', clock: 0, status: 'open' },
    ]);
  });

  it('locks what the Demo leaves out and opens what it shows', () => {
    const shown: Record<string, BoardStatus> = {};
    for (const o of CLOCKS) {
      if (o !== 'fire')
        shown[`outer.${o}`] = ['ice', 'poison', 'crit', 'summon'].includes(o) ? 'open' : 'locked';
    }
    const web = assembleWeb(fixtureContent(), 'fire', DEMO_SCOPE_A);
    expect(statuses(web, 'outer')).toEqual(shown);
    expect(statuses(web, 'fusion')).toEqual(
      Object.fromEntries(
        Object.entries(shown).map(([id, status]) => [id.replace('outer.', 'fusion.fire.'), status]),
      ),
    );
    expect(statuses(web, 'center')).toEqual({ 'fire.center': 'open' });
    expect(statuses(web, 'hub')).toEqual({ hub: 'open' });
    expect(statuses(web, 'asc')).toEqual({
      'fire.asc.path-one': 'open',
      'fire.asc.path-two': 'open',
    });
    expect([...web.outers.keys()]).toEqual(['poison', 'crit', 'ice', 'summon']);
    expect([...web.fusions.keys()]).toEqual(['poison', 'crit', 'ice', 'summon']);
    // 蜂巢 sees the fire outer, which 熔核 never does.
    const summon = assembleWeb(fixtureContent(), 'summon', DEMO_SCOPE_A);
    expect(statuses(summon, 'outer')['outer.fire']).toBe('open');
    expect(statuses(summon, 'outer')['outer.summon']).toBeUndefined();
    expect(
      summon.boards.filter((board) => board.kind === 'asc').map((board) => board.clock),
    ).toEqual([9, 9]);
  });

  it("marks a scope's unregistered outers absent, and locks them outside the scope", () => {
    const content = fixtureContent('B1');
    const full = assembleWeb(content, 'fire', FULL_SCOPE);
    const open = ['outer.ice', 'outer.poison', 'outer.crit', 'outer.summon'];
    for (const [id, status] of Object.entries(statuses(full, 'outer'))) {
      expect(status, id).toBe(open.includes(id) ? 'open' : 'absent');
    }
    for (const [id, status] of Object.entries(statuses(full, 'fusion'))) {
      expect(status, id).toBe(
        open.includes(id.replace('fusion.fire.', 'outer.')) ? 'open' : 'absent',
      );
    }
    // B1 writes no ascendancy: the web has no ascendancy board.
    expect(statuses(full, 'asc')).toEqual({});
    const demo = assembleWeb(content, 'fire', DEMO_SCOPE_B);
    expect(statuses(demo, 'outer')['outer.lightning']).toBe('absent');
    expect(statuses(demo, 'outer')['outer.summon']).toBe('locked');
    expect(statuses(demo, 'outer')['outer.bleed']).toBe('locked');
    expect(full.nodes).toHaveLength(156);
  });

  it('locks a deferred fusion and assembles none of its nodes', () => {
    const scope: WebScope = { ...FULL_SCOPE, deferredFusions: ['fire.poison'] };
    const web = assembleWeb(fixtureContent(), 'fire', scope);
    expect(statuses(web, 'fusion')['fusion.fire.poison']).toBe('locked');
    expect(statuses(web, 'outer')['outer.poison']).toBe('open');
    expect(web.fusions.has('poison')).toBe(false);
    expect(web.nodes.some((node) => node.board === 'fusion.fire.poison')).toBe(false);
    expect(web.nodes).toHaveLength(323 - 5);
    expect(crossEdges(web, fixtureContent())).not.toContain(
      pair(['hub.defense.r1', 'fusion.fire.poison.core']),
    );
  });

  it('marks a missing hub absent and joins nothing across boards without it', () => {
    const content: Content = { ...fixtureContent(), hub: null };
    const web = assembleWeb(content, 'fire', FULL_SCOPE);
    expect(statuses(web, 'hub')).toEqual({ hub: 'absent' });
    expect(web.nodes.some((node) => node.board === 'hub')).toBe(false);
    expect(web.nodes).toHaveLength(323 - 24);
    const written = (web.def.center?.edges.length ?? 0) + 11 * 20 + 11 * 4 + 2 * 2;
    expect(web.edges).toHaveLength(written);
  });

  it('throws for a character without a center, and for one the scope leaves out', () => {
    expect(() => assembleWeb(fixtureContent('B1'), 'ice', FULL_SCOPE)).toThrow(
      "character 'ice' has no center yet (製作中); it has no web",
    );
    expect(() => assembleWeb(fixtureContent(), 'ice', DEMO_SCOPE_A)).toThrow(
      "scope 'demoA' does not list character 'ice'",
    );
  });

  it('reads a scope list or all', () => {
    expect(scopeHolds('all', 'fire')).toBe(true);
    expect(scopeHolds(['fire', 'ice'], 'ice')).toBe(true);
    expect(scopeHolds(['fire', 'ice'], 'summon')).toBe(false);
  });
});

describe('assembleWeb: nodes and edges (§4.3)', () => {
  const content = fixtureContent();

  it('lists center, hub, outers then fusions in clock order, then ascendancies', () => {
    for (const c of ['fire', 'ice'] as const) {
      const web = assembleWeb(content, c, FULL_SCOPE);
      const others = CLOCKS.filter((o) => o !== c);
      const expected = [
        ...(content.characters[c].center?.nodes ?? []),
        ...(content.hub?.board.nodes ?? []),
        ...others.flatMap((o) => content.outers[o]?.board.nodes ?? []),
        ...others.flatMap((o) => web.fusions.get(o)?.board.nodes ?? []),
        ...(content.characters[c].ascendancies ?? []).flatMap((a) => a.board.nodes),
      ].map((node) => node.id);
      expect(
        web.nodes.map((node) => node.id),
        c,
      ).toEqual(expected);
      expect(web.nodes).toHaveLength(323);
      expect(new Set(expected).size).toBe(323);
      expect(web.root).toBe(`${c}.center.main.signature`);
      expect(web.byId.get(web.root)?.kind).toBe('signature');
    }
  });

  it('joins the boards by D15 at the ring node of each clock (F18)', () => {
    const fire = assembleWeb(content, 'fire', FULL_SCOPE);
    expect(crossEdges(fire, content).sort()).toEqual(
      expectedCross('fire', ['path-one', 'path-two']).sort(),
    );
    const ice = assembleWeb(content, 'ice', FULL_SCOPE);
    expect(crossEdges(ice, content).sort()).toEqual(
      expectedCross('ice', ['path-one', 'path-two']).sort(),
    );
    expect(crossEdges(ice, content)).toContain(pair(['hub.economy.r2', 'ice.asc.path-one.n1']));
    expect(crossEdges(ice, content)).toContain(pair(['hub.might.might', 'outer.fire.main.entry']));
    expect(crossEdges(ice, content)).toContain(pair(['hub.might.might', 'fusion.ice.fire.core']));
    for (const web of [fire, ice]) expect(web.edges).toHaveLength(367);
  });

  it('keeps every edge once, between nodes of the web, in neighbours both ways', () => {
    const web = assembleWeb(content, 'summon', FULL_SCOPE);
    expect(new Set(web.edges.map(pair)).size).toBe(web.edges.length);
    for (const [a, b] of web.edges) {
      expect(web.byId.has(a) && web.byId.has(b), `${a}–${b}`).toBe(true);
      expect(web.neighbours.get(a)).toContain(b);
      expect(web.neighbours.get(b)).toContain(a);
    }
    const degree = [...web.neighbours.values()].reduce((sum, list) => sum + list.length, 0);
    expect(degree).toBe(2 * web.edges.length);
  });

  it('drops an edge to an empty slot', () => {
    const center = content.characters.fire.center;
    if (center === null) throw new Error('the fixture builds fire');
    const holed: Content = {
      ...content,
      characters: {
        ...content.characters,
        fire: {
          ...content.characters.fire,
          center: {
            ...center,
            nodes: center.nodes.filter((node) => node.id !== 'fire.center.main.c1'),
          },
        },
      },
    };
    const web = assembleWeb(holed, 'fire', FULL_SCOPE);
    expect(web.edges.some((edge) => edge.includes('fire.center.main.c1'))).toBe(false);
    expect(web.edges).toHaveLength(367 - 3);
  });

  it('gives each fusion its coef: the option, else its calibration, else 1', () => {
    const entry: CalibrationEntry = {
      coef: 1.4,
      status: 'ok',
      median: 1.2,
      min: 1.1,
      max: 1.3,
      seeds: 8,
      startWave: 30,
      digest: '0123456789abcdef',
    };
    const calibrated: Content = {
      ...content,
      calibrated: { 'fire.poison': entry, 'fire.crit': entry },
    };
    const web = assembleWeb(calibrated, 'fire', FULL_SCOPE, { coefs: { 'fire.crit': 2 } });
    expect(web.fusions.get('poison')?.coef).toBe(1.4);
    expect(web.fusions.get('crit')?.coef).toBe(2);
    expect(web.fusions.get('bleed')?.coef).toBe(1);
  });
});

describe('loadContent (§4.8; N-6, P8)', () => {
  it('validates the registered content once and returns the same object afterwards', async () => {
    // A fresh module registry, so this file's other tests cannot have filled the cache.
    vi.resetModules();
    const web = await import('./index');
    const { assembleWeb: assembled } = await import('./assemble');
    const { contentIssues } = await import('./validate');
    const content = web.loadContent();
    expect(vi.mocked(contentIssues)).toHaveBeenCalledTimes(1);
    expect(Object.keys(content.characters)).toEqual(['fire', 'ice', 'lightning', 'summon']);
    // Every character's center is null until its batch: no web is assembled for any of them.
    expect(vi.mocked(assembled)).not.toHaveBeenCalled();
    expect(web.loadContent()).toBe(content);
    expect(web.loadContent()).toBe(content);
    expect(vi.mocked(contentIssues)).toHaveBeenCalledTimes(1);
    expect(loadContent).not.toBe(web.loadContent);
  });

  it('checks FIRST_PICK when it loads the registered content (V4)', async () => {
    vi.resetModules();
    vi.doMock('../characters', async (importOriginal) => ({
      ...(await importOriginal<typeof CharactersModule>()),
      FIRST_PICK: 'fier',
    }));
    try {
      const web = await import('./index');
      expect(() => web.loadContent()).toThrow(
        "Invalid content (1 issue):\n- character 'fier' (src/data/characters/index.ts): FIRST_PICK is not a registered character; did you mean 'fire'?",
      );
    } finally {
      vi.doUnmock('../characters');
      vi.resetModules();
    }
  });

  it('assembles webs only for characters with a center', () => {
    vi.mocked(assembleWeb).mockClear();
    parseContent(fixtureContent('B1'));
    const characters = new Set(vi.mocked(assembleWeb).mock.calls.map((call) => call[1]));
    expect([...characters]).toEqual(['fire']);
  });

  it('checks a character without a center by V1 and V4 only', () => {
    // B3 with ice's center taken away again and B5's ice ascendancies written early.
    const content = fixtureContent('B3');
    const [path, other] = fixtureContent().characters.ice.ascendancies ?? [];
    if (path === undefined || other === undefined) throw new Error('the fixture writes ice');
    const [n1, n2, final] = path.board.nodes;
    if (n1 === undefined || n2 === undefined || final === undefined) throw new Error('3 nodes');
    // V1: a trigger without an effect. V3 would also see n2 holding the final's kind and no edges.
    const broken = {
      ...path,
      board: {
        ...path.board,
        nodes: [
          { ...n1, effects: { ...n1.effects, triggers: [{ on: 'kill' as const, do: [] }] } },
          { ...n2, kind: 'ascFinal' as const },
          final,
        ],
        edges: [],
      },
    };
    const planted: Content = {
      ...content,
      characters: {
        ...content.characters,
        // V4: a derived field that is not its derivation.
        ice: {
          ...content.characters.ice,
          center: null,
          arena: 'fire',
          ascendancies: [broken, other],
        },
      },
      // Pairs of a character without a center are V10's dead data, not this test's.
      overrides: Object.fromEntries(
        Object.entries(content.overrides).filter(([key]) => !key.startsWith('ice.')),
      ),
    };
    vi.mocked(assembleWeb).mockClear();
    expect(() => parseContent(planted)).toThrow(
      [
        'Invalid content (2 issues):',
        "- character 'ice' (src/data/characters/ice.ts): arena 'fire' is not its derivation 'ice'; build the def with defineCharacter",
        "- node 'ice.asc.path-one.n1' (src/data/characters/ice.ts): triggers[0] needs at least one effect",
      ].join('\n'),
    );
    expect(vi.mocked(assembleWeb).mock.calls.some((call) => call[1] === 'ice')).toBe(false);
  });
});
