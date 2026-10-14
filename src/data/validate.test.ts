import { describe, expect, it } from 'vitest';
import { ENEMIES } from './enemies';
import { loadGameData, parseGameData } from './index';
import { TALENTS } from './talents';
import type { GameData, TalentNode } from './types';
import { MAX_KEYSTONES, validateGameData } from './validate';
import { WAVES } from './waves';

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

const content = (): Mutable<GameData> =>
  structuredClone({ enemies: ENEMIES, waves: WAVES, talents: TALENTS }) as Mutable<GameData>;

function talent(data: Mutable<GameData>, id: string): Mutable<TalentNode> {
  const node = data.talents.find((n) => n.id === id);
  if (node === undefined) throw new Error(`No talent '${id}'`);
  return node;
}

function smallNode(id: string, links: string[]): Mutable<TalentNode> {
  return {
    id,
    kind: 'small',
    pos: { x: 600, y: 600 },
    links,
    modifiers: [],
    rules: [],
    archetype: 'none',
    nameKey: `talent.${id}.name`,
  };
}

/** Issues for a copy of the real content after `mutate`. */
function issuesAfter(mutate: (data: Mutable<GameData>) => void): string[] {
  const data = content();
  mutate(data);
  return validateGameData(data);
}

describe('real content', () => {
  it('loads and validates', () => {
    const data = loadGameData();
    expect(validateGameData(data)).toEqual([]);
    expect(loadGameData()).toBe(data);
  });

  it('has the M1 web v1 shape (docs/MILESTONES.md M1)', () => {
    const { talents } = loadGameData();
    expect(talents.length).toBeGreaterThanOrEqual(38);
    expect(talents.length).toBeLessThanOrEqual(46);
    const start = talents.filter((node) => node.kind === 'start');
    expect(start.map((node) => node.id)).toEqual(['start']);
    const repeatable = talents.find((node) => node.kind === 'repeatable');
    expect(repeatable?.links).toContain('start');
    for (const archetype of ['crit', 'dot', 'chain'] as const) {
      const nodes = talents.filter((node) => node.archetype === archetype);
      expect(nodes.filter((node) => node.kind === 'notable')).toHaveLength(2);
      expect(nodes.filter((node) => node.kind === 'keystone')).toHaveLength(1);
    }
    // One notable per bridge group.
    const bridges = talents.filter((node) => node.archetype === 'hybrid');
    expect(bridges.filter((node) => node.kind === 'notable')).toHaveLength(3);
  });

  it('keeps nodes far enough apart to click', () => {
    const { talents } = loadGameData();
    for (const a of talents) {
      for (const b of talents) {
        if (a === b) continue;
        const dist = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
        expect(dist, `${a.id}–${b.id}`).toBeGreaterThanOrEqual(90);
      }
    }
  });

  it('uses distinct enemy colors', () => {
    const colors = Object.values(loadGameData().enemies).map((def) => def.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe('validateGameData: talents', () => {
  it('accepts an unmodified copy', () => {
    expect(issuesAfter(() => {})).toEqual([]);
  });

  it('rejects an asymmetric link', () => {
    expect(issuesAfter((d) => talent(d, 'vitality').links.push('keenEye'))).toEqual([
      "talent 'vitality': links to 'keenEye' but 'keenEye' does not link back",
    ]);
  });

  it('rejects unreachable nodes', () => {
    const issues = issuesAfter((d) => {
      d.talents.push(smallNode('islandA', ['islandB']), smallNode('islandB', ['islandA']));
    });
    expect(issues).toEqual([
      "talent 'islandA': not reachable from the start node",
      "talent 'islandB': not reachable from the start node",
    ]);
  });

  it('rejects duplicate ids', () => {
    const issues = issuesAfter((d) => d.talents.push(structuredClone(talent(d, 'vitality'))));
    expect(issues).toEqual(["talents: duplicate id 'vitality'"]);
  });

  it('rejects two start nodes', () => {
    const issues = issuesAfter((d) => {
      talent(d, 'vitality').kind = 'start';
    });
    expect(issues).toContain("talents: expected exactly one 'start' node, found 2");
  });

  it('rejects a missing start node', () => {
    const issues = issuesAfter((d) => {
      talent(d, 'start').kind = 'small';
    });
    expect(issues).toEqual(["talents: expected exactly one 'start' node, found 0"]);
  });

  it('rejects a start node away from the origin', () => {
    const issues = issuesAfter((d) => {
      talent(d, 'start').pos.x = 10;
    });
    expect(issues).toEqual(["talent 'start': start node must be at (0, 0)"]);
  });

  it('rejects links to unknown nodes, self links and duplicate links', () => {
    expect(issuesAfter((d) => talent(d, 'vitality').links.push('nowhere'))).toEqual([
      "talent 'vitality': links to unknown node 'nowhere'",
    ]);
    expect(issuesAfter((d) => talent(d, 'vitality').links.push('vitality'))).toEqual([
      "talent 'vitality': links to itself",
    ]);
    expect(issuesAfter((d) => talent(d, 'vitality').links.push('start'))).toEqual([
      "talent 'vitality': duplicate link to 'start'",
    ]);
  });

  it('rejects a repeatable node without repeat', () => {
    const issues = issuesAfter((d) => {
      delete talent(d, 'might').repeat;
    });
    expect(issues).toEqual(["talent 'might': repeatable node needs 'repeat'"]);
  });

  it('rejects repeat on a non-repeatable node', () => {
    const issues = issuesAfter((d) => {
      talent(d, 'vitality').repeat = { baseShards: 10, growth: 1.5 };
    });
    expect(issues).toEqual(["talent 'vitality': only repeatable nodes may have 'repeat'"]);
  });

  it('rejects rules outside keystones and notables and keystones without rules', () => {
    expect(
      issuesAfter((d) => talent(d, 'vitality').rules.push({ id: 'glassCannon', damageMore: 1 })),
    ).toEqual([
      "talent 'vitality': only keystones and notables may have rules",
      "talent 'vitality': a node with rules or behaviour modifiers needs a descKey",
    ]);
    expect(
      issuesAfter((d) => {
        const node = talent(d, 'glassCannon');
        node.rules = [];
        delete node.descKey;
      }),
    ).toEqual(["talent 'glassCannon': keystone needs a rule or a behaviour modifier"]);
  });

  it('accepts a keystone whose behaviour is all modifiers (Searing Crits)', () => {
    const searing = talent(content(), 'searingCrits');
    expect(searing.kind).toBe('keystone');
    expect(searing.rules).toEqual([]);
    expect(
      issuesAfter((d) => {
        // Plain modifiers alone do not make a keystone.
        talent(d, 'searingCrits').modifiers = [{ stat: 'damage', kind: 'more', value: -0.5 }];
      }),
    ).toEqual([
      "talent 'searingCrits': keystone needs a rule or a behaviour modifier",
      "talent 'searingCrits': descKey describes rules and behaviour modifiers; this node has neither",
    ]);
  });

  it(`rejects more than ${MAX_KEYSTONES} keystones`, () => {
    const issues = issuesAfter((d) => {
      const hub = talent(d, 'vitality');
      const existing = d.talents.filter((node) => node.kind === 'keystone').length;
      for (let i = existing; i <= MAX_KEYSTONES; i++) {
        const id = `extraKeystone${i}`;
        hub.links.push(id);
        d.talents.push({
          ...smallNode(id, [hub.id]),
          kind: 'keystone',
          rules: [{ id: 'glassCannon', damageMore: 1 }],
          descKey: `talent.${id}.desc`,
        });
      }
    });
    expect(issues).toEqual([`talents: ${MAX_KEYSTONES + 1} keystones, at most 6 allowed`]);
  });

  it('rejects empty i18n keys', () => {
    const issues = issuesAfter((d) => {
      talent(d, 'vitality').nameKey = '';
      talent(d, 'glassCannon').descKey = '';
    });
    expect(issues).toEqual([
      "talent 'glassCannon': empty descKey",
      "talent 'vitality': empty nameKey",
    ]);
  });

  it('requires a descKey exactly on nodes with rules or behaviour modifiers', () => {
    const issues = issuesAfter((d) => {
      delete talent(d, 'glassCannon').descKey;
      delete talent(d, 'staticFocus').descKey;
      talent(d, 'vitality').descKey = 'talent.vitality.desc';
      talent(d, 'keenEye').modifiers.push({
        stat: 'igniteChance',
        kind: 'flat',
        value: 0.1,
        tags: ['crit'],
      });
      talent(d, 'precision').modifiers.push({ stat: 'critAlways', kind: 'flat', value: 1 });
      talent(d, 'kindling').modifiers.push({
        stat: 'damage',
        kind: 'more',
        value: 0.1,
        notTags: ['crit'],
      });
      // Tags on damage only change a number the talent screen can show.
      talent(d, 'spark').modifiers.push({
        stat: 'damage',
        kind: 'more',
        value: 0.1,
        tags: ['chain'],
      });
    });
    expect(issues).toEqual([
      "talent 'glassCannon': a node with rules or behaviour modifiers needs a descKey",
      "talent 'vitality': descKey describes rules and behaviour modifiers; this node has neither",
      "talent 'keenEye': a node with rules or behaviour modifiers needs a descKey",
      "talent 'precision': a node with rules or behaviour modifiers needs a descKey",
      "talent 'kindling': a node with rules or behaviour modifiers needs a descKey",
      "talent 'staticFocus': a node with rules or behaviour modifiers needs a descKey",
    ]);
  });

  it('rejects scaling parameters out of range', () => {
    const issues = issuesAfter((d) => {
      talent(d, 'staticFocus').modifiers.push(
        { stat: 'critChance', kind: 'flat', value: 0.1, scaling: { per: 'chainJump', every: 0 } },
        {
          stat: 'damage',
          kind: 'more',
          value: 0.1,
          scaling: { per: 'chainJump', curve: 'pow', exponent: -1 },
        },
      );
    });
    expect(issues).toEqual([
      "talent 'staticFocus': modifiers[3] scaling.every must be > 0 (got 0)",
      "talent 'staticFocus': modifiers[4] scaling.exponent must be > 0 (got -1)",
    ]);
  });

  it('rejects rule parameters out of range', () => {
    const issues = issuesAfter((d) => {
      talent(d, 'steadyAim').rules = [
        { id: 'steadyAim', everyNth: 0, critMultiplierMore: -2, counts: 'shot' },
      ];
    });
    expect(issues).toEqual([
      "talent 'steadyAim': rule 'steadyAim' everyNth must be a positive integer (got 0)",
      "talent 'steadyAim': rule 'steadyAim' critMultiplierMore must be > -1 (got -2)",
    ]);
    const chainMore = issuesAfter((d) => {
      talent(d, 'overload').rules = [
        { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2, chainMore: -1 },
      ];
    });
    expect(chainMore).toEqual([
      "talent 'overload': rule 'overload' chainMore must be > -1 (got -1)",
    ]);
  });

  it('rejects invalid costs', () => {
    const issues = issuesAfter((d) => {
      talent(d, 'precision').coreCost = 1.5;
      talent(d, 'inferno').shardCostFactor = -1;
      const might = talent(d, 'might');
      might.repeat = { baseShards: 0, growth: 0.9 };
    });
    expect(issues).toEqual([
      "talent 'might': repeat.baseShards must be > 0 (got 0)",
      "talent 'might': repeat.growth must be >= 1 (got 0.9)",
      "talent 'precision': coreCost must be a non-negative integer (got 1.5)",
      "talent 'inferno': shardCostFactor must be >= 0 (got -1)",
    ]);
  });
});

describe('validateGameData: enemies', () => {
  it('rejects splitInto pointing at itself', () => {
    const issues = issuesAfter((d) => {
      d.enemies.pentagon.splitInto = { enemy: 'pentagon', count: 3 };
    });
    expect(issues).toEqual(['enemies.pentagon: splitInto references itself']);
  });

  it('rejects split chains that loop', () => {
    const issues = issuesAfter((d) => {
      d.enemies.shard.splitInto = { enemy: 'pentagon', count: 1 };
    });
    expect(issues).toEqual([
      'enemies.pentagon: splitInto chain loops back to itself',
      'enemies.shard: splitInto chain loops back to itself',
    ]);
  });

  it('rejects a bad split count', () => {
    const issues = issuesAfter((d) => {
      d.enemies.pentagon.splitInto = { enemy: 'shard', count: 0 };
    });
    expect(issues).toEqual([
      'enemies.pentagon: splitInto.count must be a positive integer (got 0)',
    ]);
  });

  it('rejects a key that does not match the id', () => {
    const issues = issuesAfter((d) => {
      d.enemies.square.id = 'triangle';
    });
    expect(issues).toEqual(["enemies.square: id is 'triangle', expected 'square'"]);
  });

  it('rejects missing and unknown enemies', () => {
    const issues = issuesAfter((d) => {
      Reflect.deleteProperty(d.enemies, 'boss');
      Object.assign(d.enemies, { circle: { ...d.enemies.square, id: 'circle' } });
    });
    expect(issues).toEqual([
      "enemies: missing definition for 'boss'",
      'enemies.circle: unknown enemy id',
    ]);
  });

  it('rejects out-of-range stats', () => {
    const issues = issuesAfter((d) => {
      Object.assign(d.enemies.square, {
        hpMult: 0,
        speed: -1,
        radius: 0,
        contactDamage: -1,
        dropMult: -1,
        cores: 0.5,
        color: 0x1000000,
      });
    });
    expect(issues).toEqual([
      'enemies.square: hpMult must be > 0 (got 0)',
      'enemies.square: speed must be >= 0 (got -1)',
      'enemies.square: radius must be > 0 (got 0)',
      'enemies.square: contactDamage must be >= 0 (got -1)',
      'enemies.square: dropMult must be >= 0 (got -1)',
      'enemies.square: cores must be a non-negative integer (got 0.5)',
      'enemies.square: color must be an integer 0xRRGGBB (got 16777216)',
    ]);
  });
});

describe('validateGameData: waves', () => {
  it.each(['boss', 'hexagon'] as const)('rejects %s in spawn rules', (enemy) => {
    const issues = issuesAfter((d) => {
      d.waves.rules.push({ enemy, fromWave: 1, base: 1, perWave: 0, maxCount: 1 });
    });
    expect(issues).toEqual([
      `waves.rules[3] (${enemy}): '${enemy}' is added by eliteEvery/bossEvery, not spawn rules`,
    ]);
  });

  it('rejects out-of-range spawn rules', () => {
    const issues = issuesAfter((d) => {
      d.waves.rules[0] = { enemy: 'triangle', fromWave: 0, base: -1, perWave: -0.5, maxCount: 2.5 };
    });
    expect(issues).toEqual([
      'waves.rules[0] (triangle): fromWave must be a positive integer (got 0)',
      'waves.rules[0] (triangle): base must be >= 0 (got -1)',
      'waves.rules[0] (triangle): perWave must be >= 0 (got -0.5)',
      'waves.rules[0] (triangle): maxCount must be a non-negative integer (got 2.5)',
    ]);
  });

  it('rejects a minCount that is fractional or above maxCount', () => {
    const issues = issuesAfter((d) => {
      d.waves.rules[0] = {
        enemy: 'triangle',
        fromWave: 1,
        base: 1,
        perWave: 1,
        minCount: 1.5,
        maxCount: 5,
      };
      d.waves.rules[1] = {
        enemy: 'square',
        fromWave: 1,
        base: 1,
        perWave: 1,
        minCount: 6,
        maxCount: 5,
      };
    });
    expect(issues).toEqual([
      'waves.rules[0] (triangle): minCount must be an integer in 0..maxCount (got 1.5)',
      'waves.rules[1] (square): minCount must be an integer in 0..maxCount (got 6)',
    ]);
  });

  it('rejects non-positive or fractional wave settings', () => {
    const issues = issuesAfter((d) => {
      d.waves.eliteEvery = 0;
      d.waves.bossEvery = 2.5;
      d.waves.spawnDurationSec = 0;
      d.waves.waveTimerSec = -8;
    });
    expect(issues).toEqual([
      'waves: eliteEvery must be a positive integer (got 0)',
      'waves: bossEvery must be a positive integer (got 2.5)',
      'waves: spawnDurationSec must be > 0 (got 0)',
      'waves: waveTimerSec must be > 0 (got -8)',
    ]);
  });
});

describe('parseGameData', () => {
  it('throws one error listing every issue', () => {
    const data = content();
    talent(data, 'vitality').links.push('keenEye');
    data.waves.eliteEvery = 0;
    expect(() => parseGameData(data)).toThrow(
      [
        'Invalid game data (2 issues):',
        '- waves: eliteEvery must be a positive integer (got 0)',
        "- talent 'vitality': links to 'keenEye' but 'keenEye' does not link back",
      ].join('\n'),
    );
  });

  it('returns typed data for valid input', () => {
    expect(parseGameData(content())).toEqual(content());
  });
});
