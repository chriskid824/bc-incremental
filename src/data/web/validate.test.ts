import { describe, expect, it, vi } from 'vitest';
import { ModifierSchema } from '../schema';
import { assembleWeb } from './assemble';
import { ContentError, loadContent, parseContent } from './index';
import { BATCH_COUNTS, DEMO_SCOPE_A, DEMO_SCOPE_B, FULL_SCOPE, SCOPES } from './scope';
import type { Batch } from './scope';
import { fixtureContent } from './testing';
import type { BoardDef, Content, WebNode, WebScope } from './types';
import { contentIds } from './snapshot';
import { contentIssues, fileOfBoard, keysAt, pathText, zodIssueText } from './validate';
import type { ValidateOptions } from './validate';
import type * as RulesModule from '../rules';

// POLICY_RULES and RULE_COEF_FIELDS are empty until their modules land (D8, F50): the tests
// fill these copies (C-1).
const rules = vi.hoisted(() => ({
  policy: [] as string[],
  coefFields: {} as Record<string, Record<string, string>>,
}));
vi.mock('../rules', async (importOriginal) => {
  const actual = await importOriginal<typeof RulesModule>();
  return { ...actual, POLICY_RULES: rules.policy, RULE_COEF_FIELDS: rules.coefFields };
});

const BATCHES: readonly Batch[] = ['B1', 'B2', 'B3', 'B4', 'B5'];

/** Writes `value` at `key` of `target`, whatever their types: a planted fault. */
function set(target: object, key: string, value: unknown): void {
  Reflect.set(target, key, value);
}
function push(list: readonly unknown[], ...items: unknown[]): void {
  (list as unknown[]).push(...items);
}
function find(board: BoardDef | null | undefined, id: string): WebNode {
  const node = board?.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`the fixture has no node '${id}'`);
  return node;
}
function drop(board: BoardDef | null | undefined, ids: readonly string[]): void {
  if (board === null || board === undefined) throw new Error('no board');
  set(
    board,
    'nodes',
    board.nodes.filter((node) => !ids.includes(node.id)),
  );
}

/** `base` with `fields` its type would refuse: a planted typo (V24). */
const scopeWith = (base: WebScope, fields: Record<string, unknown>): WebScope =>
  ({ ...base, ...fields }) as WebScope;

const messages = (content: Content, options: ValidateOptions = {}): string[] =>
  contentIssues(content, { firstPick: 'fire', ...options }).map((issue) => issue.message);

/** A copy of the fixture after `variant` with `edit` planted. */
function edited(variant: Batch, edit: (content: Content) => void): Content {
  const content = structuredClone(fixtureContent(variant));
  edit(content);
  return content;
}

/**
 * The issues `edit` adds to the fixture after `variant` (default B3, which has none) under the same
 * options. An issue the options cause alone, as a scope's, is in both lists: read those with
 * messages().
 */
function plant(
  edit: (content: Content) => void,
  variant: Batch = 'B3',
  options: ValidateOptions = {},
): string[] {
  const before = new Set(messages(fixtureContent(variant), options));
  return messages(edited(variant, edit), options).filter((message) => !before.has(message));
}

/** M1's zone check (src/data/validate.ts), after the subject and file. */
const ZONE_DOES_NOTHING =
  'triggers[0] do[0] groundZone does nothing: give it damagePctPerSec > 0, ailment, addFrostPerSec or slow';

describe('the fixture under the load-time checks (§4.8)', () => {
  it('passes B1–B5 with no issue', () => {
    for (const variant of BATCHES) {
      expect(messages(fixtureContent(variant)), variant).toEqual([]);
    }
  });

  it('parses B1 without FIRST_PICK, and loads the registered content', () => {
    expect(parseContent(fixtureContent('B1')).hub).not.toBeNull();
    expect(Object.keys(loadContent().characters)).toEqual(['fire', 'ice', 'lightning', 'summon']);
  });
});

describe('V14: the counts (gd §2.1, B-2)', () => {
  it('counts 644 in all and 323 per character on the full fixture', () => {
    const content = fixtureContent();
    const webs = (['fire', 'ice', 'lightning', 'summon'] as const).map((c) =>
      assembleWeb(content, c, FULL_SCOPE),
    );
    for (const web of webs) expect(web.nodes, web.character).toHaveLength(323);
    expect(new Set(webs.flatMap((web) => web.nodes.map((node) => node.id))).size).toBe(644);
    expect(contentIds(content)).toHaveLength(644);
  });

  it('counts each batch variant at its BATCH_COUNTS entry, and the Demo at 246 and 162', () => {
    for (const variant of BATCHES) {
      const content = fixtureContent(variant);
      const built = (['fire', 'ice', 'lightning', 'summon'] as const).filter(
        (c) => content.characters[c].center !== null,
      );
      const ids = new Set(
        built.flatMap((c) => assembleWeb(content, c, FULL_SCOPE).nodes.map((node) => node.id)),
      );
      expect(ids.size, variant).toBe(BATCH_COUNTS[variant]);
      expect(
        messages(content).filter((message) => /gd §2\.1|BATCH_COUNTS/.test(message)),
        variant,
      ).toEqual([]);
    }
    const demo = fixtureContent('B2');
    const webs = (['fire', 'summon'] as const).map((c) => assembleWeb(demo, c, DEMO_SCOPE_A));
    expect(webs.map((web) => web.nodes.length)).toEqual([162, 162]);
    expect(new Set(webs.flatMap((web) => web.nodes.map((node) => node.id))).size).toBe(246);
  });

  it('reports a web that misses nodes against the formula and BATCH_COUNTS', () => {
    const issues = plant((content) => {
      drop(content.outers.poison?.board, [
        'outer.poison.beta.r3',
        'outer.poison.beta.r4',
        'outer.poison.beta.beta-two',
        'outer.poison.main.star',
        'outer.poison.main.threshold',
      ]);
    }, 'B5');
    expect(issues).toContain(
      "scope 'full': character 'fire' sees 318 nodes; gd §2.1's formula over its blocks gives 323",
    );
    expect(issues).toContain(
      "scope 'full': the webs hold 639 nodes in all; gd §2.1's formula over the registered blocks gives 644",
    );
    expect(issues).toContain(
      "scope 'full': the registered blocks are B5's, which BATCH_COUNTS counts 644; the webs hold 639",
    );
  });

  it('checks BATCH_COUNTS on the assembled webs, generated fusion nodes included', () => {
    const issues = plant((content) => {
      drop(content.outers.poison?.board, ['outer.poison.main.threshold']);
    });
    expect(issues).toContain(
      "scope 'full': the registered blocks are B3's, which BATCH_COUNTS counts 405; the webs hold 404",
    );
  });
});

describe('one golden message per load-time check (D23)', () => {
  it('V1: a misspelt stat, with the nearest name (rule (b))', () => {
    expect(
      plant((content) => {
        const node = find(content.outers.poison?.board, 'outer.poison.alpha.r2');
        set(node.effects.modifiers[0] as object, 'stat', 'posionDamage');
      }),
    ).toEqual([
      "node 'outer.poison.alpha.r2' (src/data/outer/poison.ts): modifiers[0].stat 'posionDamage' is not a stat; did you mean 'poisonDamage'?",
    ]);
  });

  it('V1: an unknown field and a wrong type (rule (b))', () => {
    expect(
      plant((content) => {
        const node = find(content.outers.poison?.board, 'outer.poison.alpha.r2');
        set(node.effects.modifiers[0] as object, 'vlaue', 0.1);
        set(
          find(content.hub?.board, 'hub.defense.r1').effects.modifiers[0] as object,
          'value',
          '0.1',
        );
      }),
    ).toEqual([
      "node 'hub.defense.r1' (src/data/hub.ts): modifiers[0].value '0.1' is not a number",
      "node 'outer.poison.alpha.r2' (src/data/outer/poison.ts): modifiers[0] 'vlaue' is not a key; did you mean 'value'?",
    ]);
  });

  it('V1: unions, events, conditions, scopes and the other defs (rule (b))', () => {
    expect(
      plant((content) => {
        const node = find(content.outers.poison?.board, 'outer.poison.alpha.r2');
        push(
          node.effects.triggers,
          { on: 'kil', do: [{ kind: 'nova', radius: 90, damagePct: 1 }] },
          { on: 'kill', do: [{ kind: 'nvoa', radius: 90, damagePct: 1 }] },
          { on: 'kill', do: [{ kind: 'nova', radius: 90, damagePct: 1, raduis: 2 }] },
          { on: 'kill', do: [{ kind: 'nova', damagePct: 1 }] },
        );
        set(node.effects.modifiers[0] as object, 'when', [{ targetHas: 'posion' }]);
        set(node.effects.modifiers[0] as object, 'scope', 'outer.posion');
        set(content.characters.fire, 'colour', 1);
        set(content.overrides, 'fire.crit', { bonsu: null });
        set(content.calibrated, 'fire.crit', {
          coef: 1,
          status: 'okay',
          median: 1,
          min: 1,
          max: 1,
          seeds: 8,
          startWave: 30,
          digest: '0123456789abcdef',
        });
      }),
    ).toEqual([
      "character 'fire' (src/data/characters/fire.ts): 'colour' is not a key; did you mean 'color'?",
      "fusion 'fire.crit' (src/data/fusion/calibrated.ts): status 'okay' is not a status; did you mean 'ok'?",
      "override 'fire.crit' (src/data/fusion/overrides.ts): 'bonsu' is not a key; did you mean 'bonus'?",
      "node 'outer.poison.alpha.r2' (src/data/outer/poison.ts): modifiers[0].scope 'outer.posion' must be a source class or a source id (src/data/sources.ts); did you mean 'outer.poison'?",
      "node 'outer.poison.alpha.r2' (src/data/outer/poison.ts): modifiers[0].when[0].targetHas 'posion' is not an ailment; did you mean 'poison'?",
      "node 'outer.poison.alpha.r2' (src/data/outer/poison.ts): triggers[0].on 'kil' is not an event; did you mean 'kill'?",
      "node 'outer.poison.alpha.r2' (src/data/outer/poison.ts): triggers[1].do[0].kind 'nvoa' is not a kind; did you mean 'nova'?",
      "node 'outer.poison.alpha.r2' (src/data/outer/poison.ts): triggers[2].do[0] 'raduis' is not a key; did you mean 'radius'?",
      "node 'outer.poison.alpha.r2' (src/data/outer/poison.ts): triggers[3].do[0].radius is missing; write a number",
    ]);
  });

  it('V1: a value outside a literal list, and an id outside its template (rule (b))', () => {
    expect(
      plant((content) => {
        set(find(content.characters.fire.center, 'fire.center.alpha.mastery'), 'ranks', 2);
        set(content.outers.bleed?.board as object, 'id', 'outer.blood');
      }),
    ).toEqual([
      "node 'fire.center.alpha.mastery' (src/data/characters/fire.ts): ranks 2 is not one of 1, 3, 4, 5 or 'unlimited'",
      "outer 'bleed' (src/data/outer/bleed.ts): board.id 'outer.blood' is not a valid id",
    ]);
  });

  it("V1: a payload's placement field, which the center event fills", () => {
    expect(
      plant((content) => {
        set(content.outers.crit?.payload?.effects[0] as object, 'from', 'player');
      }),
    ).toEqual(["outer 'crit' (src/data/outer/crit.ts): payload.effects[0] 'from' is not a key"]);
  });

  it("V1: nodeEffectIssues' and grantConflicts' M1 text after the subject and file (rule (a))", () => {
    expect(
      plant((content) => {
        const center = content.characters.fire.center;
        push(find(center, 'fire.center.alpha.alpha-one').effects.triggers, { on: 'kill', do: [] });
        const board = content.outers.poison?.board;
        push(find(board, 'outer.poison.alpha.alpha-one').effects.emitters, {
          kind: 'thorns',
          damagePct: 1,
        });
        push(find(board, 'outer.poison.beta.beta-one').effects.emitters, {
          kind: 'thorns',
          damagePct: 2,
        });
      }),
    ).toEqual([
      "node 'fire.center.alpha.alpha-one' (src/data/characters/fire.ts): triggers[0] needs at least one effect",
      "outer 'poison' (src/data/outer/poison.ts): emitter thorns '' is granted twice by source 'outer.poison' with different fields; keep it on one node",
    ]);
  });

  it('V1: a zone with no damage and no term, which only an inZone condition on its node reads (F24)', () => {
    /** The issues of a 0-damage zone on alpha-one, with an inZone modifier on `reader` if any. */
    const zoneOn = (reader: string | null): string[] =>
      plant((content) => {
        const board = content.outers.poison?.board;
        push(find(board, 'outer.poison.alpha.alpha-one').effects.triggers, {
          on: 'hit',
          do: [{ kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0 }],
        });
        if (reader === null) return;
        push(find(board, reader).effects.modifiers, {
          stat: 'damage',
          kind: 'increased',
          value: 0.2,
          when: [{ inZone: 'outer.poison' }],
        });
      });
    const nothing = `node 'outer.poison.alpha.alpha-one' (src/data/outer/poison.ts): ${ZONE_DOES_NOTHING}`;
    expect(zoneOn(null)).toEqual([nothing]);
    expect(zoneOn('outer.poison.alpha.alpha-one')).toEqual([]);
    // The rule is per node: another node's inZone condition does not admit it.
    expect(zoneOn('outer.poison.beta.beta-one')).toEqual([nothing]);
  });

  it('V2: a slug that is not kebab-case', () => {
    expect(
      plant((content) => {
        const board = content.outers.poison?.board;
        const old = 'outer.poison.alpha.alpha-one';
        set(find(board, old), 'id', 'outer.poison.alpha.toxic_cloud');
        set(
          board as object,
          'edges',
          board?.edges.map((edge) =>
            edge.map((id) => (id === old ? 'outer.poison.alpha.toxic_cloud' : id)),
          ),
        );
      }),
    ).toEqual([
      "node 'outer.poison.alpha.toxic_cloud' (src/data/outer/poison.ts): slug 'toxic_cloud' is not kebab-case; write 'toxic-cloud'",
    ]);
  });

  it('V2: a reserved slug, an id twice, an id outside the grammar or on another board', () => {
    const issues = plant((content) => {
      const board = content.outers.poison?.board;
      set(find(board, 'outer.poison.alpha.alpha-one'), 'id', 'outer.poison.alpha.threshold');
      set(find(board, 'outer.poison.beta.beta-one'), 'id', 'outer.poison.beta.beta-two');
      set(find(board, 'outer.poison.alpha.r1'), 'id', 'outer.poison.alpha.r9');
      set(find(content.hub?.board, 'hub.defense.r1'), 'id', 'outer.bleed.main.r1');
    });
    // V2 speaks per node; the slots and edges the renamed nodes leave are V3's and V13's.
    expect(issues.filter((message) => message.startsWith('node '))).toEqual([
      "node 'outer.bleed.main.r1' (src/data/hub.ts): the id is outside D4's grammar; write the node through its board's template",
      "node 'outer.poison.alpha.r9' (src/data/outer/poison.ts): the id is outside D4's grammar; write the node through its board's template",
      "node 'outer.poison.alpha.threshold' (src/data/outer/poison.ts): slug 'threshold' is a reserved word; pick another slug",
      "node 'outer.poison.beta.beta-two' (src/data/outer/poison.ts): the id is used twice on board 'outer.poison'; give one of them another slug",
    ]);
    expect(issues).toContain(
      "hub 'hub' (src/data/hub.ts): ring slot 1 holds 'outer.bleed.main.r1'; ring slot 1 takes 'hub.defense.r1'",
    );
    expect(
      plant((content) => {
        set(find(content.hub?.board, 'hub.defense.r1'), 'id', 'outer.bleed.alpha.r1');
      }),
    ).toContain(
      "node 'outer.bleed.alpha.r1' (src/data/hub.ts): the id names board 'outer.bleed', the node sits on 'hub'; write the node through its board's template",
    );
  });

  it("V2: a key of a character's own archetype, or of no fusion", () => {
    expect(
      plant((content) => {
        set(content.overrides, 'fire.fire', { bonus: null });
        set(content.acceptedFails, 'fire.crt', 'flat');
      }),
    ).toEqual([
      "override 'fire.fire' (src/data/fusion/overrides.ts): 'fire' is the character's own archetype, which has no fusion; remove the entry",
      "fusion 'fire.crt' (src/data/fusion/overrides.ts): 'fire.crt' is not a fusion; did you mean 'fire.crit'?",
    ]);
  });

  it('V3: a slot holding the wrong template', () => {
    expect(
      plant((content) => {
        const node = find(content.characters.fire.center, 'fire.center.alpha.alpha-two');
        set(node, 'kind', 'ranked');
        set(node, 'ranks', 3);
      }),
    ).toEqual([
      "center 'fire.center' (src/data/characters/fire.ts): branch 'alpha' slot b holds a ranked node; slot b takes notable(slug, effects)",
    ]);
  });

  it('V3: the hub by its fixed table (D15)', () => {
    expect(
      plant((content) => {
        const board = content.hub?.board;
        set(find(board, 'hub.economy.r4'), 'id', 'hub.economy.r5');
        set(
          board as object,
          'edges',
          board?.edges.map((edge) =>
            edge.map((id) => (id === 'hub.economy.r4' ? 'hub.economy.r5' : id)),
          ),
        );
      }),
    ).toEqual([
      "hub 'hub' (src/data/hub.ts): spur 6 holds 'hub.economy.r5'; spur 6 takes 'hub.economy.r4'",
    ]);
  });

  it('V3: holes, a missing branch, ranks, edges, a board id and an empty chain', () => {
    expect(
      plant((content) => {
        const center = content.characters.fire.center;
        drop(center, ['fire.center.main.c3']);
        set(find(center, 'fire.center.main.c2'), 'ranks', 'unlimited');
        set(find(center, 'fire.center.alpha.mastery'), 'ranks', 3);
        push(center?.edges ?? [], ['fire.center.alpha.r1', 'fire.center.beta.r1']);
        set(
          center as object,
          'edges',
          center?.edges.filter(
            ([a, b]) => !(a === 'fire.center.alpha.r2' && b === 'fire.center.alpha.alpha-one'),
          ),
        );
        const poison = content.outers.poison?.board;
        drop(
          poison,
          (poison?.nodes ?? [])
            .filter((node) => node.id.startsWith('outer.poison.beta.'))
            .map((node) => node.id),
        );
        // The nodes the missing branch takes away are V14's to count.
      }).filter((message) => !message.startsWith('scope ')),
    ).toEqual([
      "center 'fire.center' (src/data/characters/fire.ts): branch 'alpha' slot mastery has 3 ranks; a mastery node takes unlimited",
      "center 'fire.center' (src/data/characters/fire.ts): connector c2 has unlimited ranks; a ranked node takes 3–5",
      "center 'fire.center' (src/data/characters/fire.ts): connector c3 is empty; connector c3 takes ranked(stat, perRank, ranks)",
      "center 'fire.center' (src/data/characters/fire.ts): edge 'fire.center.alpha.r2'–'fire.center.alpha.alpha-one' is missing; the board's builder makes it",
      "center 'fire.center' (src/data/characters/fire.ts): edge 'fire.center.alpha.r1'–'fire.center.beta.r1' is not in the board's shape; edges come from its builder",
      "outer 'poison' (src/data/outer/poison.ts): branch 2 of 2 is missing; write outerBranch(slug, slots)",
    ]);
    const moved = plant((content) => {
      set(content.outers.bleed?.board as object, 'id', 'outer.barrage');
    });
    expect(moved).toContain(
      "outer 'bleed' (src/data/outer/bleed.ts): the board's id is 'outer.barrage'; it must be 'outer.bleed'",
    );
    expect(moved).toContain(
      "node 'outer.bleed.alpha.r1' (src/data/outer/bleed.ts): the id names board 'outer.bleed', the node sits on 'outer.barrage'; write the node through its board's template",
    );
    const chain = plant((content) => {
      const [path] = content.characters.fire.ascendancies ?? [];
      set(path?.board as object, 'nodes', []);
      set(path?.board as object, 'edges', []);
    }, 'B2');
    expect(chain).toContain(
      "ascendancy 'fire.asc.path-one' (src/data/characters/fire.ts): the chain is empty; write ascendancy(slug, { n1, n2, final })",
    );
  });

  it("V4: a def under another's key", () => {
    const issues = plant((content) => {
      set(content.characters, 'lightning', content.characters.ice);
    });
    expect(issues).toContain(
      "character 'ice' (src/data/characters/index.ts): registered as 'lightning'; the key must be the def's id",
    );
    expect(issues).toContain(
      "character 'ice' (src/data/characters/ice.ts): construct 'frostCrystal' is also 'ice''s; each character has its own construct",
    );
  });

  it('V4: the registry, FIRST_PICK and the derived fields', () => {
    const content = edited('B1', (edit) => {
      const fire = edit.characters.fire;
      set(fire, 'nameKey', 'web.char.ice.name');
      set(fire, 'revealAt15', ['poison', 'poison', 'fire']);
      set(fire, 'recommendedOuter', ['ice', 'crit', 'poison']);
      set(edit.characters, 'smoke', fire);
      Reflect.deleteProperty(edit.characters, 'summon');
      set(edit.outers, 'posion', edit.outers.poison);
    });
    // The registered blocks change with the registry: V14's counts follow from the issues here.
    expect(
      messages(content, { firstPick: 'fier' }).filter((message) => !message.startsWith('scope ')),
    ).toEqual([
      "character 'fire' (src/data/characters/fire.ts): nameKey 'web.char.ice.name' is not its derivation 'web.char.fire.name'; build the def with defineCharacter",
      "character 'fire' (src/data/characters/fire.ts): revealAt15 names 'poison' twice; name three different outers",
      "character 'fire' (src/data/characters/fire.ts): revealAt15 names its own archetype 'fire'; its clock holds the ascendancies",
      "character 'fire' (src/data/characters/fire.ts): 'poison' is in both recommendedOuter and revealAt15; reveal each outer once",
      "character 'fire' (src/data/characters/fire.ts): construct 'magmaCore' is also 'fire''s; each character has its own construct",
      "character 'smoke' (src/data/characters/index.ts): 'smoke' is not a character; write one of 'fire', 'ice', 'lightning' or 'summon'",
      "character 'summon' (src/data/characters/index.ts): not registered; add it to CHARACTERS",
      "character 'fier' (src/data/characters/index.ts): FIRST_PICK is not a registered character; did you mean 'fire'?",
      "outer 'posion' (src/data/outer/index.ts): 'posion' is not an outer; did you mean 'poison'?",
    ]);
  });

  it('V5: a form on another character', () => {
    expect(
      plant((content) => {
        const node = find(content.characters.ice.center, 'ice.center.alpha.alpha-one');
        push(node.effects.rules, { id: 'volcano', periodSec: 1, radiusMult: 1, damageMult: 1 });
      }),
    ).toEqual([
      "node 'ice.center.alpha.alpha-one' (src/data/characters/ice.ts): form 'volcano' is magmaBomb's; iceFan takes icicle and prism",
    ]);
  });

  it('V5: a form off a center ◆ or ★, and on its own center ◆', () => {
    const volcano = { id: 'volcano', periodSec: 1, radiusMult: 1, damageMult: 1 };
    expect(
      plant((content) => {
        push(
          find(content.characters.fire.center, 'fire.center.alpha.alpha-one').effects.rules,
          volcano,
        );
        push(find(content.characters.fire.center, 'fire.center.alpha.r1').effects.rules, volcano);
        push(find(content.outers.poison?.board, 'outer.poison.main.star').effects.rules, volcano);
        set(content.overrides, 'fire.crit', { addRules: [volcano] });
      }).filter((message) => !message.startsWith('rule ')),
    ).toEqual([
      "node 'fire.center.alpha.r1' (src/data/characters/fire.ts): form 'volcano' sits on a ranked node; a form takes a center ◆ or ★",
      "override 'fire.crit' (src/data/fusion/overrides.ts): addRules is only for TEMPLATE_RULE_OVERRIDES ('ice.aura' and 'lightning.aura'); write a trigger instead",
      "override 'fire.crit' (src/data/fusion/overrides.ts): form 'volcano' is magmaBomb's; a form sits only on a center ◆ or ★ of a character whose signature takes it",
      "node 'outer.poison.main.star' (src/data/outer/poison.ts): form 'volcano' is magmaBomb's; a form sits only on a center ◆ or ★ of a character whose signature takes it",
    ]);
  });

  it('V5: a form on its own center ★ (火山 is a ★)', () => {
    expect(
      plant((content) => {
        push(find(content.characters.fire.center, 'fire.center.main.star-one').effects.rules, {
          id: 'volcano',
          periodSec: 1,
          radiusMult: 1,
          damageMult: 1,
        });
      }),
    ).toEqual([]);
  });

  it('V6: a rule id on two boards of one web', () => {
    const overload = {
      id: 'overload',
      chainCountMultiplier: 2,
      retentionPenalty: 0.2,
      chainMore: 3.5,
    };
    const issues = plant(
      (content) => {
        push(
          find(content.characters.lightning.center, 'lightning.center.main.star-one').effects.rules,
          overload,
        );
        push(find(content.hub?.board, 'hub.rules.rule-one').effects.rules, overload);
      },
      'B4',
      { scopes: [{ ...FULL_SCOPE, deferredFusions: ['lightning.aura'] }] },
    );
    expect(issues).toContain(
      "rule 'overload' (web 'lightning'): on boards 'lightning.center' and 'hub'; a rule id may sit on one board per web",
    );
    expect(issues).toContain(
      "rule 'overload' (web 'fire'): on boards 'hub' and 'fusion.fire.lightning'; a rule id may sit on one board per web",
    );
  });

  it('V6: a ◆ holds a rule only when POLICY_RULES lists it (C-1)', () => {
    const flame = { id: 'eternalFlame', durationMore: -0.5 };
    const edit = (content: Content): void => {
      push(
        find(content.characters.fire.center, 'fire.center.alpha.alpha-one').effects.rules,
        flame,
      );
      push(find(content.characters.fire.center, 'fire.center.alpha.r1').effects.rules, flame);
      const [path] = content.characters.fire.ascendancies ?? [];
      push(find(path?.board, 'fire.asc.path-one.n1').effects.rules, flame);
    };
    const refused = [
      "node 'fire.center.alpha.r1' (src/data/characters/fire.ts): rule 'eternalFlame' sits on a ranked node; a rule takes a ★, a fusion core or an ascendancy final, or a ◆ when POLICY_RULES lists it",
      "node 'fire.center.alpha.alpha-one' (src/data/characters/fire.ts): rule 'eternalFlame' sits on a notable node; a rule takes a ★, a fusion core or an ascendancy final, or a ◆ when POLICY_RULES lists it",
      "node 'fire.asc.path-one.n1' (src/data/characters/fire.ts): rule 'eternalFlame' sits on an asc node; a rule takes a ★, a fusion core or an ascendancy final, or a ◆ when POLICY_RULES lists it",
    ];
    const ownRules = (issues: string[]) => issues.filter((message) => !message.startsWith('rule '));
    expect(ownRules(plant(edit, 'B2'))).toEqual(refused);
    rules.policy.push('eternalFlame');
    try {
      expect(ownRules(plant(edit, 'B2'))).toEqual([refused[0]]);
    } finally {
      rules.policy.length = 0;
    }
  });

  it('V6: a rule on a ★ or an ascendancy final, which POLICY_RULES need not list', () => {
    const flame = { id: 'eternalFlame', durationMore: -0.5 };
    expect(
      plant((content) => {
        push(
          find(content.characters.fire.center, 'fire.center.main.star-one').effects.rules,
          flame,
        );
        const [path] = content.characters.fire.ascendancies ?? [];
        push(find(path?.board, 'fire.asc.path-one.final').effects.rules, flame);
      }, 'B2').filter((message) => !message.startsWith('rule ')),
    ).toEqual([]);
  });

  it('V6: addRules only on TEMPLATE_RULE_OVERRIDES, and RULE_COEF_FIELDS on number fields', () => {
    expect(
      plant((content) => {
        set(content.overrides, 'fire.crit', { addRules: [{ id: 'glassCannon', damageMore: 1 }] });
      }),
    ).toContain(
      "override 'fire.crit' (src/data/fusion/overrides.ts): addRules is only for TEMPLATE_RULE_OVERRIDES ('ice.aura' and 'lightning.aura'); write a trigger instead",
    );
    rules.coefFields.glassCannon = { damageMor: 'pct' };
    rules.coefFields.steadyAim = { counts: 'chance', everyNth: 'chance' };
    try {
      expect(messages(fixtureContent('B3'))).toEqual([
        "rule 'glassCannon' (src/data/rules.ts): RULE_COEF_FIELDS names 'damageMor', which is not a number field of its spec; did you mean 'damageMore'?",
        "rule 'steadyAim' (src/data/rules.ts): RULE_COEF_FIELDS names 'counts', which is not a number field of its spec; name one of 'everyNth' or 'critMultiplierMore'",
      ]);
    } finally {
      delete rules.coefFields.glassCannon;
      delete rules.coefFields.steadyAim;
    }
  });

  it('V7: an outer ★ that adds damage outside its archetype (rule (a))', () => {
    expect(
      plant((content) => {
        push(find(content.outers.poison?.board, 'outer.poison.main.star').effects.modifiers, {
          stat: 'damage',
          kind: 'more',
          value: 0.5,
        });
      }),
    ).toEqual([
      'keystone \'outer.poison.main.star\' (src/data/outer/poison.ts): ★ damage modifier {"stat":"damage","kind":"more","value":0.5} needs a tag of outer.poison (poison) or scope \'outer.poison\'',
    ]);
  });

  it('V8: a transfer at the calibrated coef', () => {
    expect(
      plant((content) => {
        set(content.calibrated, 'fire.poison', {
          coef: 2.1,
          status: 'ok',
          median: 1.2,
          min: 1.1,
          max: 1.3,
          seeds: 8,
          startWave: 30,
          digest: '0123456789abcdef',
        });
      }),
    ).toEqual([
      "fusion 'fire.poison' (src/data/fusion/overrides.ts): spreadAilment.effect 0.5 × coef 2.1 = 1.05; a transfer stays below 1",
    ]);
  });

  it('V8: a transfer off a fusion board at coef 1, its effect 1 when left out (F49)', () => {
    expect(
      plant((content) => {
        const spread = (effect?: number) => ({
          on: 'kill',
          do: [
            {
              kind: 'spreadAilment',
              ailment: 'poison',
              radius: 90,
              ...(effect === undefined ? {} : { effect }),
            },
          ],
        });
        push(
          find(content.outers.poison?.board, 'outer.poison.alpha.alpha-one').effects.triggers,
          spread(),
        );
        push(
          find(content.outers.poison?.board, 'outer.poison.beta.beta-one').effects.triggers,
          spread(0.99),
        );
      }),
    ).toEqual([
      "node 'outer.poison.alpha.alpha-one' (src/data/outer/poison.ts): spreadAilment.effect 1 × coef 1 = 1; a transfer stays below 1",
    ]);
  });

  it('V10: an override or calibration of a pair no scope assembles', () => {
    expect(
      plant((content) => {
        set(content.overrides, 'fire.bleed', { bonus: null });
        set(content.overrides, 'ice.poison', { bonus: null });
        set(content.calibrated, 'fire.greed', {
          coef: 1,
          status: 'ok',
          median: 1,
          min: 1,
          max: 1,
          seeds: 8,
          startWave: 30,
          digest: '0123456789abcdef',
        });
      }, 'B1'),
    ).toEqual([
      "fusion 'fire.greed' (src/data/fusion/calibrated.ts): outer 'greed' is not registered; move it to the batch that adds greed",
      "override 'fire.bleed' (src/data/fusion/overrides.ts): outer 'bleed' is not registered; move it to the batch that adds bleed",
      "override 'ice.poison' (src/data/fusion/overrides.ts): character 'ice' has no center yet; move it to the batch that writes ice's center",
    ]);
    const deferred = edited('B3', (content) => {
      set(content.acceptedFails, 'fire.poison', 'insensitive by design');
    });
    expect(
      messages(deferred, { scopes: [{ ...FULL_SCOPE, deferredFusions: ['fire.poison'] }] }),
    ).toEqual([
      "override 'fire.poison' (src/data/fusion/overrides.ts): no scope assembles fusion 'fire.poison'; remove the entry or add the fusion to a scope",
      "fusion 'fire.poison' (src/data/fusion/overrides.ts): no scope assembles fusion 'fire.poison'; remove the entry or add the fusion to a scope",
    ]);
  });

  it('V11: a hand pair without its rule', () => {
    expect(
      plant((content) => {
        set(content.overrides, 'fire.ice', {});
      }),
    ).toEqual([
      "override 'fire.ice' (src/data/fusion/overrides.ts): a hand-made fusion needs its rule",
    ]);
  });

  it('V11: a hand pair with triggers, addTriggers, a bonus or addRules, a template pair with a rule', () => {
    expect(
      plant((content) => {
        const heal = { on: 'kill', do: [{ kind: 'heal', lifePct: 0.05 }] };
        const ice = content.overrides['fire.ice'] as object;
        set(ice, 'triggers', [heal]);
        set(ice, 'addTriggers', [heal]);
        set(ice, 'bonus', null);
        set(ice, 'addRules', [{ id: 'glassCannon', damageMore: 1 }]);
        set(content.overrides, 'fire.crit', { rule: { id: 'glassCannon', damageMore: 1 } });
      }).filter((message) => !message.startsWith('rule ')),
    ).toEqual([
      "override 'fire.ice' (src/data/fusion/overrides.ts): a hand-made fusion takes no triggers; its rule is its core",
      "override 'fire.ice' (src/data/fusion/overrides.ts): a hand-made fusion takes no addTriggers; its rule is its core",
      "override 'fire.ice' (src/data/fusion/overrides.ts): a hand-made fusion takes no bonus; its rule is its core",
      "override 'fire.ice' (src/data/fusion/overrides.ts): a hand-made fusion takes no addRules; its rule is its core",
      "override 'fire.crit' (src/data/fusion/overrides.ts): a template fusion takes no rule; its core is its outer's payload, which addRules extends on a TEMPLATE_RULE_OVERRIDES pair",
    ]);
  });

  it('V12: a bonus with nothing to read', () => {
    expect(
      plant((content) => {
        set(content.outers.aura?.payload as object, 'effects', [
          { kind: 'nova', radius: 90, damagePct: 1 },
        ]);
      }, 'B5'),
    ).toEqual([
      "outer 'aura' (src/data/outer/aura.ts): bonus 'inZone' needs a groundZone in the payload",
      "outer 'aura' (src/data/outer/aura.ts): coefScalesBonus with a nova the coef already scales; drop coefScalesBonus",
    ]);
  });

  it('V12: the payload, its bonus, a status radius, the placed triggers and scope fusion', () => {
    expect(
      plant((content) => {
        set(content.outers.bleed as object, 'payload', null);
        const poison = content.outers.poison?.payload as object;
        set(poison, 'bonus', { form: 'status', ailment: 'bleed', value: 0.2 });
        set(poison, 'effects', [
          { kind: 'applyAilment', ailment: 'poison', stacks: 2, radius: 50 },
        ]);
        Reflect.deleteProperty(content.outers.crit?.payload?.effects[0] as object, 'critScale');
        set(content.outers.barrage?.payload?.effects[0] as object, 'damagePct', -1);
        push(find(content.outers.lightning?.board, 'outer.lightning.alpha.r1').effects.modifiers, {
          stat: 'damage',
          kind: 'increased',
          value: 0.1,
          scope: 'fusion',
        });
        set(content.overrides, 'fire.crit', {
          modifiers: [{ stat: 'damage', kind: 'increased', value: 0.1, scope: 'fusion' }],
        });
      }),
    ).toEqual([
      "override 'fire.crit' (src/data/fusion/overrides.ts): modifiers[0] scope 'fusion' is for a fusion's ranks only; scope it to 'fusion.fire.crit'",
      // A template core holds its outer's payload as the character's event places it (V1).
      ...['fire', 'ice', 'summon'].map(
        (c) =>
          `node 'fusion.${c}.barrage.core' (src/data/fusion/overrides.ts): triggers[0] do[0] damagePct must be >= 0 (got -1)`,
      ),
      ...['explode', 'freeze', 'chainJump', 'droneImpact'].map(
        (event) =>
          `outer 'barrage' (src/data/outer/barrage.ts) on ${event}: triggers[0] do[0] damagePct must be >= 0 (got -1)`,
      ),
      "outer 'bleed' (src/data/outer/bleed.ts): a template outer needs a payload; write its effects, bonus and ranks",
      "outer 'crit' (src/data/outer/crit.ts): bonus 'inPayload' needs a critScale, a thorns tag or a projectile count in the payload",
      "node 'outer.lightning.alpha.r1' (src/data/outer/lightning.ts): modifiers[1] scope 'fusion' is for a fusion's ranks only; scope it to 'outer.lightning'",
      "outer 'poison' (src/data/outer/poison.ts): bonus 'status' needs an applyAilment or addFrost of bleed in the payload",
      "outer 'poison' (src/data/outer/poison.ts): payload.effects[0] applyAilment has a radius, which stops the engine's fan-out on explode and freeze; write it per event in perEvent",
    ]);
  });

  it('V12: coefScalesBonus never with a powFactor bonus', () => {
    expect(
      plant((content) => {
        set(content.outers.combo?.payload as object, 'bonus', {
          form: 'scaling',
          kind: 'more',
          value: 1,
          scaling: { per: 'targetBurnStacks', curve: 'powFactor', exponent: 0.5 },
        });
      }, 'B5'),
    ).toEqual([
      "outer 'combo' (src/data/outer/combo.ts): coefScalesBonus with a powFactor bonus, which the coef cannot scale; drop coefScalesBonus",
    ]);
  });

  it('V12: a zone with no damage and no term under an inZone bonus, which reads it (F24), and under no other', () => {
    // The aura payload's zone deals 0 damage and writes no term; its inZone bonus reads it.
    expect(
      messages(fixtureContent('B5')).filter((message) => message.startsWith("outer 'aura'")),
    ).toEqual([]);
    /** V1 on each aura core, `bonus`'s own issues, then V12 on each center event. */
    const reported = (bonus: readonly string[]): string[] => [
      ...['fire', 'ice', 'lightning', 'summon'].map(
        (c) => `node 'fusion.${c}.aura.core' (src/data/fusion/overrides.ts): ${ZONE_DOES_NOTHING}`,
      ),
      ...bonus,
      ...['explode', 'freeze', 'chainJump', 'droneImpact'].map(
        (event) => `outer 'aura' (src/data/outer/aura.ts) on ${event}: ${ZONE_DOES_NOTHING}`,
      ),
    ];
    expect(
      plant((content) => {
        set(content.outers.aura?.payload as object, 'bonus', {
          form: 'status',
          ailment: 'poison',
          value: 0.2,
        });
      }, 'B5'),
    ).toEqual(
      reported([
        "outer 'aura' (src/data/outer/aura.ts): bonus 'status' needs an applyAilment or addFrost of poison in the payload",
      ]),
    );
    expect(
      plant((content) => {
        set(content.outers.aura?.payload as object, 'bonus', null);
      }, 'B5'),
    ).toEqual(reported([]));
  });

  it("V13: an outer's entry reachable only through fusion nodes", () => {
    const issues = plant((content) => {
      const hub = content.hub?.board;
      const cut = ['hub.might.might|hub.defense.r1', 'hub.defense.r1|hub.defense.r2'];
      set(
        hub as object,
        'edges',
        hub?.edges.filter(([a, b]) => !cut.includes(`${a}|${b}`) && !cut.includes(`${b}|${a}`)),
      );
      push(hub?.edges ?? [], ['hub.might.might', 'fusion.fire.poison.mastery']);
      drop(content.characters.fire.center, ['fire.center.main.c1']);
    });
    expect(issues).toContain(
      "outer 'poison': its entry 'outer.poison.main.entry' is reachable only through fusion nodes",
    );
  });

  it('V13: a node the signature does not reach', () => {
    const issues = plant((content) => {
      const board = content.outers.poison?.board;
      set(
        board as object,
        'edges',
        board?.edges.filter((edge) => !edge.includes('outer.poison.beta.beta-two')),
      );
    });
    expect(issues).toContain(
      "outer 'poison' (src/data/outer/poison.ts): 1 of its nodes is not reachable from 'fire.center.main.signature', 'outer.poison.beta.beta-two' first; connect them through the board's edges and the hub",
    );
    const center = plant((content) => {
      const board = content.characters.fire.center;
      set(
        board as object,
        'edges',
        board?.edges.filter((edge) => !edge.includes('fire.center.alpha.r1')),
      );
    });
    expect(center).toContain(
      "center 'fire.center' (src/data/characters/fire.ts): 1 of its nodes is not reachable from 'fire.center.main.signature', 'fire.center.alpha.r1' first; connect them through the board's edges and the hub",
    );
  });

  it('V18: a ✗ no center node answers', () => {
    expect(
      plant((content) => {
        set(find(content.characters.fire.center, 'fire.center.alpha.alpha-one'), 'answers', []);
      }),
    ).toEqual([
      "character 'fire' (src/data/characters/fire.ts): enemyRow marks 'dasher' ✗ and no center node answers it; tag one with answers(spec, 'dasher')",
    ]);
  });

  it("V18: an outer's covers and answers, and from B4 three outers per ✗", () => {
    expect(
      plant((content) => {
        const counter = find(content.outers.poison?.board, 'outer.poison.main.counter');
        set(counter, 'answers', ['pentagon', 'shielder', 'dasher', 'boss']);
        set(find(content.outers.crit?.board, 'outer.crit.main.counter'), 'answers', []);
      }),
    ).toEqual([
      "outer 'crit' (src/data/outer/crit.ts): covers marks 'triangle' 'answer' and no node answers it; tag one with answers(spec, 'triangle')",
      "outer 'crit' (src/data/outer/crit.ts): covers marks 'regenerator' 'answer' and no node answers it; tag one with answers(spec, 'regenerator')",
      "outer 'crit' (src/data/outer/crit.ts): its answer ◆ 'outer.crit.main.counter' answers no enemy; tag it with answers(spec, enemy)",
      "outer 'poison' (src/data/outer/poison.ts): covers marks 'triangle' 'answer' and no node answers it; tag one with answers(spec, 'triangle')",
      "outer 'poison' (src/data/outer/poison.ts): a node answers 'boss', which covers does not mark 'answer'; mark it 'answer' in covers",
    ]);
    const covered = plant((content) => {
      for (const outer of Object.values(content.outers)) {
        if (outer !== undefined && outer.id !== 'poison' && outer.id !== 'ice') {
          Reflect.deleteProperty(outer.covers, 'summoner');
        }
      }
    }, 'B5');
    expect(covered).toContain(
      "character 'fire' (src/data/characters/fire.ts): enemyRow marks 'summoner' ✗ and 1 of the outers it sees cover it; gd:762 asks for 3, so mark it in more outers' covers",
    );
    // Before every outer is registered (B4), the coverage waits.
    expect(
      plant((content) => {
        for (const outer of Object.values(content.outers)) {
          if (outer !== undefined) Reflect.deleteProperty(outer.covers, 'summoner');
        }
      }).filter((message) => message.includes('gd:762')),
    ).toEqual([]);
  });

  it('V18: from B4, a ✗ two outers it sees cover, but not three; its own outer does not count (gd:762)', () => {
    /** fire's ✗ 'summoner' covered by its own outer and by the first `keep` outers it sees. */
    const coveredBy = (keep: number): string[] =>
      plant((content) => {
        let kept = 0;
        for (const outer of Object.values(content.outers)) {
          if (outer === undefined) continue;
          if (outer.id === 'fire') {
            set(outer.covers, 'summoner', 'helps');
          } else if (outer.covers.summoner !== undefined) {
            kept += 1;
            if (kept > keep) Reflect.deleteProperty(outer.covers, 'summoner');
          }
        }
      }, 'B5').filter((message) => message.includes('gd:762'));
    expect(coveredBy(2)).toEqual([
      "character 'fire' (src/data/characters/fire.ts): enemyRow marks 'summoner' ✗ and 2 of the outers it sees cover it; gd:762 asks for 3, so mark it in more outers' covers",
    ]);
    expect(coveredBy(3)).toEqual([]);
  });

  it('V24: a misspelt id in a scope', () => {
    expect(
      messages(fixtureContent('B3'), {
        scopes: [
          FULL_SCOPE,
          scopeWith(DEMO_SCOPE_A, { outers: ['fire', 'ice', 'poison', 'cirt', 'summon'] }),
        ],
      }),
    ).toEqual([
      "scope 'demoA' (src/data/web/scope.ts): outer 'cirt' is not an outer; did you mean 'crit'?",
    ]);
  });

  it('V24: a scope name twice, an unknown character or fusion', () => {
    expect(
      messages(fixtureContent('B3'), {
        scopes: [
          FULL_SCOPE,
          DEMO_SCOPE_A,
          scopeWith(DEMO_SCOPE_B, {
            name: 'demoA',
            characters: ['fier'],
            deferredFusions: ['fire.fire'],
          }),
        ],
      }),
    ).toEqual([
      "scope 'demoA' (src/data/web/scope.ts): another scope has this name; give each scope its own",
      "scope 'demoA' (src/data/web/scope.ts): character 'fier' is not a character; did you mean 'fire'?",
      "scope 'demoA' (src/data/web/scope.ts): fusion 'fire.fire' is not a fusion; did you mean 'fire.ice'?",
    ]);
  });
});

describe('the issue list (§4.8)', () => {
  it('sorts by file, keeps each file in check order, and puts issues without a file last', () => {
    const content = structuredClone(fixtureContent('B3'));
    set(find(content.hub?.board, 'hub.economy.r4'), 'ranks', 1);
    set(find(content.characters.fire.center, 'fire.center.alpha.alpha-one'), 'answers', []);
    set(content.overrides, 'fire.ice', {});
    drop(content.outers.poison?.board, ['outer.poison.main.threshold']);
    set(find(content.characters.fire.center, 'fire.center.main.c2'), 'ranks', 1);
    const issues = contentIssues(content, { firstPick: 'fire' });
    const files = issues.map((issue) => issue.file);
    expect(files).toEqual([
      'src/data/characters/fire.ts',
      'src/data/characters/fire.ts',
      'src/data/fusion/overrides.ts',
      'src/data/hub.ts',
      'src/data/outer/poison.ts',
      ...files.slice(5).map(() => null),
    ]);
    expect(files.length).toBeGreaterThan(5);
    expect(issues[0]?.message).toContain('connector c2 has 1 ranks');
    expect(issues[1]?.message).toContain("enemyRow marks 'dasher'");
    expect(issues[0]?.node).toBe('fire.center.main.c2');
    expect(issues[3]?.node).toBe('hub.economy.r4');
  });

  it('throws one ContentError listing every issue', () => {
    const content = structuredClone(fixtureContent('B3'));
    set(content.overrides, 'fire.ice', {});
    set(find(content.characters.fire.center, 'fire.center.alpha.alpha-one'), 'answers', []);
    const error = (() => {
      try {
        parseContent(content);
      } catch (thrown) {
        return thrown;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ContentError);
    expect((error as ContentError).name).toBe('ContentError');
    expect((error as ContentError).issues).toHaveLength(2);
    expect((error as ContentError).message).toBe(
      [
        'Invalid content (2 issues):',
        "- character 'fire' (src/data/characters/fire.ts): enemyRow marks 'dasher' ✗ and no center node answers it; tag one with answers(spec, 'dasher')",
        "- override 'fire.ice' (src/data/fusion/overrides.ts): a hand-made fusion needs its rule",
      ].join('\n'),
    );
    set(find(content.characters.fire.center, 'fire.center.alpha.alpha-one'), 'answers', ['dasher']);
    expect(() => parseContent(content)).toThrow(
      /^Invalid content \(1 issue\):\n- override 'fire\.ice'/,
    );
  });

  it('stops after a schema issue, with the scopes', () => {
    const content = structuredClone(fixtureContent('B3'));
    set(
      find(content.outers.poison?.board, 'outer.poison.alpha.r2').effects.modifiers[0] as object,
      'stat',
      'x',
    );
    set(content.overrides, 'fire.ice', {});
    const issues = contentIssues(content, {
      scopes: [scopeWith(FULL_SCOPE, { outers: ['crti'] })],
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      "node 'outer.poison.alpha.r2' (src/data/outer/poison.ts): modifiers[0].stat 'x' is not a stat",
      "scope 'full' (src/data/web/scope.ts): outer 'crti' is not an outer; did you mean 'crit'?",
    ]);
  });

  it('assembles each built character in every scope by default', () => {
    expect(SCOPES.map((scope) => scope.name)).toEqual(['full', 'demoA', 'demoB']);
    const issues = plant((content) => {
      drop(content.outers.ice?.board, ['outer.ice.main.threshold']);
    }).filter((message) => message.includes('sees'));
    expect(issues).toEqual([
      "scope 'full': character 'fire' sees 230 nodes; gd §2.1's formula over its blocks gives 231",
      "scope 'full': character 'summon' sees 230 nodes; gd §2.1's formula over its blocks gives 231",
      "scope 'demoA': character 'fire' sees 161 nodes; gd §2.1's formula over its blocks gives 162",
      "scope 'demoA': character 'summon' sees 161 nodes; gd §2.1's formula over its blocks gives 162",
      "scope 'demoB': character 'fire' sees 161 nodes; gd §2.1's formula over its blocks gives 162",
    ]);
  });
});

describe('zodIssueText (rule (b), N-5)', () => {
  const at = "node 'outer.poison.alpha.r2' (src/data/outer/poison.ts)";
  const issueOf = (value: unknown) => {
    const parsed = ModifierSchema.safeParse(value, { reportInput: true });
    if (parsed.success) throw new Error('the value parses');
    return parsed.error.issues;
  };

  it('words an unknown stat with its nearest name', () => {
    const [issue] = issueOf({ stat: 'posionDamage', kind: 'increased', value: 0.1 });
    expect(issue && zodIssueText(at, issue)).toBe(
      `${at}: stat 'posionDamage' is not a stat; did you mean 'poisonDamage'?`,
    );
    const [far] = issueOf({ stat: 'zzzz', kind: 'increased', value: 0.1 });
    expect(far && zodIssueText(at, far)).toBe(`${at}: stat 'zzzz' is not a stat`);
  });

  it('words an unknown field with the nearest field the object allows', () => {
    const value = { stat: 'damage', kind: 'increased', value: 0.1, vlaue: 1 };
    const [issue] = issueOf(value);
    const keys = keysAt(ModifierSchema, value, []);
    expect(keys).toEqual(expect.arrayContaining(['stat', 'kind', 'value', 'scope', 'when']));
    expect(issue && zodIssueText(at, issue, keys)).toBe(
      `${at}: 'vlaue' is not a key; did you mean 'value'?`,
    );
    expect(issue && zodIssueText(at, issue)).toBe(`${at}: 'vlaue' is not a key`);
  });

  it('words a wrong type and a missing field', () => {
    const [wrong] = issueOf({ stat: 'damage', kind: 'increased', value: '0.1' });
    expect(wrong && zodIssueText(at, wrong)).toBe(`${at}: value '0.1' is not a number`);
    const [missing] = issueOf({ stat: 'damage', kind: 'increased' });
    expect(missing && zodIssueText(at, missing)).toBe(`${at}: value is missing; write a number`);
    const [kind] = issueOf({ stat: 'damage', kind: 'increasd', value: 0.1 });
    expect(kind && zodIssueText(at, kind)).toBe(
      `${at}: kind 'increasd' is not a kind; did you mean 'increased'?`,
    );
  });

  it('writes a number bare and a string quoted, and a value at the root without a path', () => {
    const [stat] = issueOf({ stat: 5, kind: 'increased', value: 0.1 });
    expect(stat && zodIssueText(at, stat)).toBe(`${at}: stat 5 is not a stat`);
    const [root] = issueOf('damage');
    expect(root && zodIssueText(at, root)).toBe(`${at}: 'damage' is not an object`);
  });

  it('writes a path with its indices in brackets', () => {
    expect(pathText(['modifiers', 0, 'when', 1, 'targetHas'])).toBe(
      'modifiers[0].when[1].targetHas',
    );
    expect(pathText(['payload', 'effects', 0])).toBe('payload.effects[0]');
    expect(pathText([])).toBe('');
  });

  it("names a board's file (rule (c))", () => {
    expect(fileOfBoard('fire.center')).toBe('src/data/characters/fire.ts');
    expect(fileOfBoard('summon.asc.queen')).toBe('src/data/characters/summon.ts');
    expect(fileOfBoard('outer.poison')).toBe('src/data/outer/poison.ts');
    expect(fileOfBoard('hub')).toBe('src/data/hub.ts');
    expect(fileOfBoard('fusion.fire.poison')).toBe('src/data/fusion/overrides.ts');
  });
});
