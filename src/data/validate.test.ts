import { describe, expect, it } from 'vitest';
import type { EmitterGrant } from './emitters';
import { ENEMIES } from './enemies';
import { loadGameData, parseGameData } from './index';
import { TALENTS } from './talents';
import { isBehaviourModifier } from './stats';
import type { Modifier } from './stats';
import type { ConversionSpec, SlashLineSpec, TriggerSpec } from './triggers';
import type { GameData, TalentNode } from './types';
import { MAX_KEYSTONES, starArchetypeIssues, validateGameData } from './validate';
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
    triggers: [],
    conversions: [],
    emitters: [],
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
      "talent 'vitality': a node with rules, triggers, conversions, emitters or behaviour modifiers needs a descKey",
    ]);
    expect(
      issuesAfter((d) => {
        const node = talent(d, 'glassCannon');
        node.rules = [];
        delete node.descKey;
      }),
    ).toEqual([
      "talent 'glassCannon': keystone needs a rule, a trigger, a conversion, an emitter or a behaviour modifier",
    ]);
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
      "talent 'searingCrits': keystone needs a rule, a trigger, a conversion, an emitter or a behaviour modifier",
      "talent 'searingCrits': descKey describes rules, triggers, conversions, emitters and behaviour modifiers; this node has none",
    ]);
  });

  it('accepts the Pandemic keystone through its trigger alone', () => {
    const pandemic = talent(content(), 'pandemic');
    expect(pandemic.kind).toBe('keystone');
    expect(pandemic.rules).toEqual([]);
    expect(pandemic.modifiers.filter(isBehaviourModifier)).toEqual([]);
    expect(pandemic.triggers).toHaveLength(1);
    expect(
      issuesAfter((d) => {
        talent(d, 'pandemic').triggers = [];
      }),
    ).toEqual([
      "talent 'pandemic': keystone needs a rule, a trigger, a conversion, an emitter or a behaviour modifier",
      "talent 'pandemic': descKey describes rules, triggers, conversions, emitters and behaviour modifiers; this node has none",
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
      "talent 'glassCannon': a node with rules, triggers, conversions, emitters or behaviour modifiers needs a descKey",
      "talent 'vitality': descKey describes rules, triggers, conversions, emitters and behaviour modifiers; this node has none",
      "talent 'keenEye': a node with rules, triggers, conversions, emitters or behaviour modifiers needs a descKey",
      "talent 'precision': a node with rules, triggers, conversions, emitters or behaviour modifiers needs a descKey",
      "talent 'kindling': a node with rules, triggers, conversions, emitters or behaviour modifiers needs a descKey",
      "talent 'staticFocus': a node with rules, triggers, conversions, emitters or behaviour modifiers needs a descKey",
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

  it('rejects lob form parameters out of range, and takes them at their edges', () => {
    const issues = issuesAfter((d) => {
      talent(d, 'steadyAim').rules = [
        { id: 'farThrow', every: 1 },
        { id: 'volcano', periodSec: 0, radiusMult: 0.5, damageMult: 0 },
        { id: 'chainBlast', radius: 0, damagePct: -0.5, perBomb: 1.5 },
      ];
    });
    expect(issues).toEqual([
      "talent 'steadyAim': rule 'farThrow' farThrowEvery must be an integer >= 2 (got 1)",
      "talent 'steadyAim': rule 'volcano' volcano.periodSec must be > 0 (got 0)",
      "talent 'steadyAim': rule 'volcano' volcano.radiusMult must be >= 1 (got 0.5)",
      "talent 'steadyAim': rule 'volcano' volcano.damageMult must be > 0 (got 0)",
      "talent 'steadyAim': rule 'chainBlast' chainBlast.radius must be > 0 (got 0)",
      "talent 'steadyAim': rule 'chainBlast' chainBlast.damagePct must be >= 0 (got -0.5)",
      "talent 'steadyAim': rule 'chainBlast' chainBlast.perBomb must be a positive integer (got 1.5)",
    ]);
    expect(
      issuesAfter((d) => {
        talent(d, 'steadyAim').rules = [{ id: 'farThrow', every: 2.5 }];
      }),
    ).toEqual([
      "talent 'steadyAim': rule 'farThrow' farThrowEvery must be an integer >= 2 (got 2.5)",
    ]);
    expect(
      issuesAfter((d) => {
        talent(d, 'steadyAim').rules = [
          { id: 'farThrow', every: 2 },
          { id: 'volcano', periodSec: 0.01, radiusMult: 1, damageMult: 0.01 },
          { id: 'chainBlast', radius: 0.01, damagePct: 0, perBomb: 1 },
        ];
      }),
    ).toEqual([]);
  });

  it('rejects fan form parameters out of range, and takes them at their edges', () => {
    const issues = issuesAfter((d) => {
      talent(d, 'steadyAim').rules = [
        { id: 'icicle', every: 1, damagePct: 0 },
        { id: 'prism', perPierce: -0.2, maxBonus: -1 },
      ];
    });
    expect(issues).toEqual([
      "talent 'steadyAim': rule 'icicle' icicle.every must be an integer >= 2 (got 1)",
      "talent 'steadyAim': rule 'icicle' icicle.damagePct must be > 0 (got 0)",
      "talent 'steadyAim': rule 'prism' prism.perPierce must be >= 0 (got -0.2)",
      "talent 'steadyAim': rule 'prism' prism.maxBonus must be >= 0 (got -1)",
    ]);
    expect(
      issuesAfter((d) => {
        talent(d, 'steadyAim').rules = [{ id: 'icicle', every: 4.5, damagePct: -1 }];
      }),
    ).toEqual([
      "talent 'steadyAim': rule 'icicle' icicle.every must be an integer >= 2 (got 4.5)",
      "talent 'steadyAim': rule 'icicle' icicle.damagePct must be > 0 (got -1)",
    ]);
    expect(
      issuesAfter((d) => {
        talent(d, 'steadyAim').rules = [
          { id: 'icicle', every: 2, damagePct: 0.01 },
          { id: 'prism', perPierce: 0, maxBonus: 0 },
        ];
      }),
    ).toEqual([]);
  });

  it('rejects arc form parameters out of range, and takes them at their edges', () => {
    const coils = (coils: number, targets: number, damageMult: number) =>
      issuesAfter((d) => {
        talent(d, 'steadyAim').rules = [{ id: 'sixCoils', coils, targets, damageMult }];
      });
    expect(coils(0, 3, 0)).toEqual([
      "talent 'steadyAim': rule 'sixCoils' sixCoils.coils must be a positive integer (got 0)",
      "talent 'steadyAim': rule 'sixCoils' sixCoils.targets must be 1 or 2 (got 3)",
      "talent 'steadyAim': rule 'sixCoils' sixCoils.damageMult must be > 0 (got 0)",
    ]);
    expect(coils(2.5, 1.5, -1)).toEqual([
      "talent 'steadyAim': rule 'sixCoils' sixCoils.coils must be a positive integer (got 2.5)",
      "talent 'steadyAim': rule 'sixCoils' sixCoils.targets must be 1 or 2 (got 1.5)",
      "talent 'steadyAim': rule 'sixCoils' sixCoils.damageMult must be > 0 (got -1)",
    ]);
    expect([coils(1, 1, 0.01), coils(6, 2, 0.55)]).toEqual([[], []]);
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

describe('trigger validation', () => {
  /** Issues of the real content with `triggers` on 'vitality', which then has its descKey. */
  const triggerIssues = (...triggers: TriggerSpec[]): string[] =>
    issuesAfter((d) => {
      const node = talent(d, 'vitality');
      node.triggers.push(...(triggers as Mutable<TriggerSpec>[]));
      node.descKey = 'talent.vitality.desc';
    });
  const at = "talent 'vitality': triggers[0]";
  const explode = { kind: 'explode', radius: 90, damagePct: 0.5 } as const;
  const heal = { kind: 'heal', lifePct: 0.05 } as const;

  it('accepts triggers on every wired event', () => {
    expect(
      triggerIssues(
        { on: 'hit', when: [{ hitIs: 'primary' }, { targetHpBelow: 0.3 }], do: [explode] },
        { on: 'crit', when: [{ chance: 0.3 }, { cooldownSec: 1 }], do: [explode] },
        { on: 'kill', when: [{ killedBy: 'burn' }, { hitIs: 'crit' }], do: [explode] },
        { on: 'kill', do: [{ kind: 'gainShards', fraction: 0.5 }] },
        {
          on: 'diedWithAilment',
          when: [{ victimHas: 'burn' }],
          do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 250, effect: 0.4 }],
        },
        {
          on: 'nthAttack',
          every: 3,
          when: [{ stacksAtLeast: { ailment: 'burn', stacks: 2 } }],
          do: [{ kind: 'applyAilment', ailment: 'burn', stacks: 2 }],
        },
        { on: 'waveStart', do: [{ kind: 'nova', radius: 300, damagePct: 1 }] },
        { on: 'periodic', every: 8, do: [heal] },
        {
          on: 'heroHit',
          do: [{ kind: 'applyAilment', ailment: 'burn', radius: 200, maxTargets: 3 }],
        },
        {
          on: 'contact',
          when: [{ targetKind: 'boss' }],
          do: [{ kind: 'push', distance: 80, radius: 120 }],
        },
        {
          on: 'ailmentApplied',
          when: [{ ailment: 'shock' }, { stacksAtLeast: { ailment: 'shock', stacks: 3 } }],
          do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }],
        },
        {
          on: 'ailmentTick',
          every: 0.5,
          when: [{ ailment: 'poison' }, { targetHas: 'bleed' }],
          do: [{ kind: 'nova', radius: 80, damagePct: 0.2 }],
        },
        {
          on: 'kill',
          when: [{ victimHas: 'poison' }, { killedBy: 'poison' }],
          do: [
            {
              kind: 'spreadAilment',
              ailment: 'poison',
              radius: 200,
              effect: 0.5,
              stacks: 0.5,
              maxTargets: 3,
            },
          ],
        },
        {
          on: 'freeze',
          when: [{ targetKind: 'boss' }, { targetHas: 'shock' }],
          do: [{ kind: 'addFrost', amount: 0.5, radius: 90, maxTargets: 5 }, explode],
        },
        {
          on: 'shatter',
          when: [{ victimHas: 'burn' }, { hitIs: 'crit' }],
          do: [{ kind: 'nova', radius: 90, damagePct: 0.3, at: 'event' }],
        },
        { on: 'hit', when: [{ targetHas: 'frozen' }], do: [{ kind: 'addFrost', amount: 0.1 }] },
        {
          on: 'explode',
          when: [{ targetHas: 'burn' }, { cooldownSec: 0.5 }],
          do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }, explode],
        },
        {
          on: 'chainJump',
          when: [{ targetHas: 'shock' }, { cooldownSec: 0.5 }],
          do: [{ kind: 'applyAilment', ailment: 'shock', stacks: 1 }, explode],
        },
        {
          on: 'droneImpact',
          when: [{ targetHas: 'poison' }, { chance: 0.5 }],
          do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }, explode],
        },
      ),
    ).toEqual([]);
  });

  it('needs exactly one ailment condition on ailmentApplied and ailmentTick', () => {
    expect(triggerIssues({ on: 'ailmentApplied', do: [explode] })).toEqual([
      `${at} needs exactly one ailment condition on 'ailmentApplied' events`,
    ]);
    expect(
      triggerIssues({ on: 'ailmentTick', when: [{ targetHas: 'burn' }], do: [explode] }),
    ).toEqual([`${at} needs exactly one ailment condition on 'ailmentTick' events`]);
    expect(
      triggerIssues({
        on: 'ailmentApplied',
        when: [{ ailment: 'burn' }, { ailment: 'poison' }],
        do: [explode],
      }),
    ).toEqual([`${at} needs exactly one ailment condition on 'ailmentApplied' events`]);
    // Shock deals no damage over time, so no ailmentTick names it.
    expect(
      triggerIssues({ on: 'ailmentTick', when: [{ ailment: 'shock' }], do: [explode] }),
    ).toEqual([`${at} ailment 'shock' deals no damage over time, so it never ticks`]);
    expect(
      triggerIssues({ on: 'ailmentApplied', when: [{ ailment: 'shock' }], do: [explode] }),
    ).toEqual([]);
    // The condition reads the event's ailment, so only those two events have one.
    expect(triggerIssues({ on: 'hit', when: [{ ailment: 'burn' }], do: [explode] })).toEqual([
      `${at} when[0] ailment does not apply to 'hit' events`,
    ]);
  });

  it('rejects a chance condition on chainJump, whose triggers fire at a fixed chance (C9)', () => {
    expect(triggerIssues({ on: 'chainJump', when: [{ chance: 0.5 }], do: [heal] })).toEqual([
      `${at} when[0] chainJump triggers fire at 30% × the fusion coefficient; drop the chance condition`,
    ]);
  });

  it('rejects an event the simulation does not raise yet', () => {
    expect(triggerIssues({ on: 'droneExpire', do: [heal] })).toEqual([
      `${at} event 'droneExpire' is not raised by the simulation yet`,
    ]);
  });

  it('rejects a condition its event cannot check', () => {
    expect(triggerIssues({ on: 'hit', when: [{ victimHas: 'burn' }], do: [explode] })).toEqual([
      `${at} when[0] victimHas does not apply to 'hit' events`,
    ]);
    // A kill's victim is gone when its triggers run: they read what it held instead.
    expect(triggerIssues({ on: 'kill', when: [{ targetHas: 'burn' }], do: [explode] })).toEqual([
      `${at} when[0] targetHas does not apply to 'kill' events`,
    ]);
    expect(
      triggerIssues({
        on: 'nthAttack',
        when: [{ hitIs: 'crit' }, { killedBy: 'hit' }],
        do: [heal],
      }),
    ).toEqual([
      `${at} when[0] hitIs does not apply to 'nthAttack' events`,
      `${at} when[1] killedBy does not apply to 'nthAttack' events`,
    ]);
    expect(
      triggerIssues({ on: 'periodic', every: 5, when: [{ targetKind: 'boss' }], do: [heal] }),
    ).toEqual([`${at} when[0] targetKind does not apply to 'periodic' events`]);
  });

  it('rejects condition values out of range and repeated chance or cooldown', () => {
    expect(
      triggerIssues({
        on: 'hit',
        when: [
          { chance: 0 },
          { chance: 1.5 },
          { cooldownSec: 0 },
          { targetHpBelow: 0 },
          { stacksAtLeast: { ailment: 'burn', stacks: 1.5 } },
        ],
        do: [explode],
      }),
    ).toEqual([
      `${at} when[0] chance must be in (0, 1] (got 0)`,
      `${at} when[1] chance must be in (0, 1] (got 1.5)`,
      `${at} when[2] cooldownSec must be > 0 (got 0)`,
      `${at} when[3] targetHpBelow must be in (0, 1] (got 0)`,
      `${at} when[4] stacksAtLeast.stacks must be a positive integer (got 1.5)`,
      `${at} at most one chance condition`,
    ]);
  });

  it('rejects a kill trigger that mixes transfers with other effects', () => {
    const spread = { kind: 'spreadAilment', ailment: 'burn', radius: 250 } as const;
    expect(triggerIssues({ on: 'diedWithAilment', do: [spread, explode] })).toEqual([
      `${at} mixes transfer and other effects on a kill event; split it into two triggers`,
    ]);
    expect(
      triggerIssues({ on: 'diedWithAilment', do: [spread] }, { on: 'kill', do: [explode] }),
    ).toEqual([]);
  });

  it('allows gainShards on kill events only', () => {
    const shards = { kind: 'gainShards', fraction: 0.5 } as const;
    expect(triggerIssues({ on: 'hit', do: [shards] })).toEqual([
      `${at} do[0] gainShards only runs on kill events (on hit)`,
    ]);
    expect(triggerIssues({ on: 'diedWithAilment', do: [shards] })).toEqual([]);
    expect(triggerIssues({ on: 'shatter', do: [shards] })).toEqual([
      `${at} do[0] gainShards only runs on kill events (on shatter)`,
    ]);
  });

  it('rejects effects that need the enemy on events without one', () => {
    expect(
      triggerIssues({ on: 'waveStart', do: [{ kind: 'applyAilment', ailment: 'burn' }] }),
    ).toEqual([
      `${at} do[0] applyAilment needs the event's enemy, which 'waveStart' events have not`,
    ]);
    expect(
      triggerIssues({
        on: 'periodic',
        every: 2,
        do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 100 }],
      }),
    ).toEqual([
      `${at} do[0] spreadAilment needs the event's enemy, which 'periodic' events have not`,
    ]);
    // A kill trigger's queued effects run after the victim is gone.
    expect(triggerIssues({ on: 'kill', do: [{ kind: 'applyAilment', ailment: 'burn' }] })).toEqual([
      `${at} do[0] applyAilment needs a radius on 'kill' events, whose enemy is dead`,
    ]);
    // So do a shatter's, its transfers included: shatter triggers never run at the kill.
    expect(
      triggerIssues({
        on: 'shatter',
        do: [
          { kind: 'addFrost', amount: 0.5 },
          { kind: 'spreadAilment', ailment: 'burn', radius: 100 },
        ],
      }),
    ).toEqual([
      `${at} do[0] addFrost needs a radius on 'shatter' events, whose enemy is dead`,
      `${at} do[1] spreadAilment needs the event's enemy, which is gone when 'shatter' triggers run`,
    ]);
    expect(
      triggerIssues({ on: 'periodic', every: 1, do: [{ kind: 'addFrost', amount: 1 }] }),
    ).toEqual([`${at} do[0] addFrost needs the event's enemy, which 'periodic' events have not`]);
    // A touching enemy leaks (or dies) at its touch, before the contact trigger's effects run.
    expect(
      triggerIssues({
        on: 'contact',
        do: [
          { kind: 'applyAilment', ailment: 'burn' },
          { kind: 'spreadAilment', ailment: 'burn', radius: 100 },
        ],
      }),
    ).toEqual([
      `${at} do[0] applyAilment needs the event's enemy, which has left by the time it runs`,
      `${at} do[1] spreadAilment needs the event's enemy, which has left by the time it runs`,
    ]);
    expect(
      triggerIssues({
        on: 'heroHit',
        do: [{ kind: 'applyAilment', ailment: 'burn', radius: 150 }],
      }),
    ).toEqual([]);
    expect(
      triggerIssues({
        on: 'contact',
        do: [{ kind: 'applyAilment', ailment: 'burn', radius: 150 }],
      }),
    ).toEqual([]);
  });

  it('checks every per event', () => {
    expect(triggerIssues({ on: 'nthAttack', every: 1.5, do: [heal] })).toEqual([
      `${at} every must be a positive integer on nthAttack (got 1.5)`,
    ]);
    expect(triggerIssues({ on: 'nthAttack', every: 0, do: [heal] })).toEqual([
      `${at} every must be a positive integer on nthAttack (got 0)`,
    ]);
    expect(triggerIssues({ on: 'periodic', do: [heal] })).toEqual([
      `${at} every must be > 0 seconds on periodic (got undefined)`,
    ]);
    expect(triggerIssues({ on: 'periodic', every: 0, do: [heal] })).toEqual([
      `${at} every must be > 0 seconds on periodic (got 0)`,
    ]);
    expect(triggerIssues({ on: 'kill', every: 2, do: [explode] })).toEqual([
      `${at} every is only allowed on nthAttack, periodic and ailmentTick (on kill)`,
    ]);
    // ailmentTick counts damage-over-time steps of 0.25 s.
    const tick = (every: number) => ({
      on: 'ailmentTick' as const,
      every,
      when: [{ ailment: 'burn' as const }],
      do: [explode],
    });
    expect(triggerIssues(tick(0.25), tick(1), tick(2.75))).toEqual([]);
    expect(triggerIssues(tick(0.3))).toEqual([
      `${at} every must be a positive multiple of 0.25 seconds on ailmentTick (got 0.3)`,
    ]);
    expect(triggerIssues(tick(0))).toEqual([
      `${at} every must be a positive multiple of 0.25 seconds on ailmentTick (got 0)`,
    ]);
  });

  it('rejects effect parameters out of range', () => {
    expect(
      triggerIssues({
        on: 'hit',
        do: [
          { kind: 'explode', radius: 0, damagePct: -1, tags: ['burn'] },
          { kind: 'applyAilment', ailment: 'burn', stacks: 0, maxTargets: 2 },
          { kind: 'spreadAilment', ailment: 'burn', radius: 100, effect: 1.5 },
          { kind: 'push', distance: 0, radius: 100 },
          { kind: 'addFrost', amount: 0, maxTargets: 2 },
          { kind: 'addFrost', amount: 0.2, radius: -5, maxTargets: 1.5 },
        ],
      }),
    ).toEqual([
      `${at} do[0] radius must be > 0 (got 0)`,
      `${at} do[0] damagePct must be >= 0 (got -1)`,
      `${at} do[0] tag 'burn' is not an owner or geometry tag`,
      `${at} do[1] stacks must be a positive integer (got 0)`,
      `${at} do[1] maxTargets needs a radius`,
      `${at} do[2] effect must be in [0, 1] (got 1.5)`,
      `${at} do[3] distance must be > 0 (got 0)`,
      `${at} do[4] amount must be > 0 (got 0)`,
      `${at} do[4] maxTargets needs a radius`,
      `${at} do[5] radius must be > 0 (got -5)`,
      `${at} do[5] maxTargets must be a positive integer (got 1.5)`,
    ]);
    expect(triggerIssues({ on: 'hit', do: [] })).toEqual([`${at} needs at least one effect`]);
    expect(
      triggerIssues({
        on: 'kill',
        when: [{ victimHas: 'poison' }],
        do: [
          { kind: 'spreadAilment', ailment: 'poison', radius: 100, stacks: 1.5, maxTargets: 0 },
          { kind: 'spreadAilment', ailment: 'poison', radius: 100, stacks: 0 },
        ],
      }),
    ).toEqual([
      `${at} do[0] stacks must be in (0, 1] (got 1.5)`,
      `${at} do[0] maxTargets must be a positive integer (got 0)`,
      `${at} do[1] stacks must be in (0, 1] (got 0)`,
    ]);
  });

  it('takes toSplitChildren in (0, 1] on a poison spread that runs at the kill only', () => {
    const toChildren = (toSplitChildren: number) =>
      ({ kind: 'spreadAilment', ailment: 'poison', radius: 100, toSplitChildren }) as const;
    expect(
      triggerIssues(
        { on: 'kill', when: [{ victimHas: 'poison' }], do: [toChildren(1)] },
        { on: 'diedWithAilment', do: [toChildren(0.5), toChildren(0.25)] },
      ),
    ).toEqual([]);
    expect(
      triggerIssues({ on: 'kill', do: [toChildren(0), toChildren(1.5), toChildren(Number.NaN)] }),
    ).toEqual([
      `${at} do[0] toSplitChildren must be in (0, 1] (got 0)`,
      `${at} do[1] toSplitChildren must be in (0, 1] (got 1.5)`,
      `${at} do[2] toSplitChildren must be in (0, 1] (got NaN)`,
    ]);
    // The children appear at the kill: a trigger that runs later has none to give to.
    const notAtKill = `do[0] toSplitChildren runs at the kill: use it on an inline kill trigger`;
    expect(triggerIssues({ on: 'hit', do: [toChildren(0.5)] })).toEqual([`${at} ${notAtKill}`]);
    expect(triggerIssues({ on: 'kill', do: [toChildren(0.5), explode] })).toEqual([
      `${at} mixes transfer and other effects on a kill event; split it into two triggers`,
      `${at} ${notAtKill}`,
    ]);
    expect(triggerIssues({ on: 'shatter', do: [toChildren(0.5)] })).toContain(`${at} ${notAtKill}`);
    // The schema refuses it on a burn spread; data checked without it still gets the issue.
    const burn = { kind: 'spreadAilment', ailment: 'burn', radius: 100, toSplitChildren: 0.5 };
    expect(
      triggerIssues({ on: 'kill', do: [burn as unknown as TriggerSpec['do'][number]] }),
    ).toEqual([`${at} do[0] toSplitChildren moves poison only`]);
  });

  it('accepts target selectors with every pick where they can run', () => {
    expect(
      triggerIssues(
        { on: 'hit', target: { pick: 'nearest', excludeEventTarget: true }, do: [explode] },
        {
          on: 'crit',
          target: { pick: 'nearest', from: 'player', range: 300, excludeBoss: true },
          do: [{ kind: 'applyAilment', ailment: 'shock', stacks: 2 }],
        },
        { on: 'periodic', every: 2, target: { pick: 'farthest' }, do: [explode] },
        {
          on: 'periodic',
          every: 2,
          target: { pick: 'mostStacks', ailment: 'poison' },
          do: [{ kind: 'spreadAilment', ailment: 'poison', radius: 150, maxTargets: 2 }],
        },
        { on: 'kill', target: { pick: 'highestHp', range: 400 }, do: [explode] },
        { on: 'nthAttack', every: 4, target: { pick: 'densest' }, do: [explode] },
        { on: 'heroHit', target: { pick: 'outermost' }, do: [{ kind: 'addFrost', amount: 1 }] },
        {
          on: 'shatter',
          target: { pick: 'player' },
          do: [{ kind: 'push', distance: 50, radius: 90 }],
        },
        // A selector's enemy stands in for one the event has not, or has lost.
        {
          on: 'contact',
          target: { pick: 'nearest', excludeEventTarget: true },
          do: [{ kind: 'applyAilment', ailment: 'burn' }],
        },
      ),
    ).toEqual([]);
  });

  it('rejects target selectors where they cannot run or scan too often', () => {
    expect(triggerIssues({ on: 'waveStart', target: { pick: 'nearest' }, do: [explode] })).toEqual([
      `${at} target is not allowed on 'waveStart' events; use a periodic trigger with a selector`,
    ]);
    // Transfers on a kill run at the kill, on the victim (CompiledTrigger.inline).
    expect(
      triggerIssues({
        on: 'diedWithAilment',
        target: { pick: 'nearest' },
        do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 250 }],
      }),
    ).toEqual([
      `${at} target is not allowed on a kill trigger that runs at the kill; it always acts on the victim`,
    ]);
    const scans = (['farthest', 'highestHp', 'densest', 'outermost'] as const).flatMap((pick) =>
      (['hit', 'crit'] as const).map((on) => ({ on, target: { pick }, do: [explode] })),
    );
    const issues = triggerIssues(...scans);
    expect(issues).toHaveLength(scans.length);
    for (const issue of issues) expect(issue).toContain('scans every enemy');
    expect(triggerIssues({ on: 'hit', target: { pick: 'farthest' }, do: [explode] })).toEqual([
      `${at} target.pick 'farthest' scans every enemy on each 'hit' event; use 'nearest' here, or move the effect to a periodic trigger`,
    ]);
    expect(
      triggerIssues(
        {
          on: 'ailmentApplied',
          when: [{ ailment: 'burn' }],
          target: { pick: 'mostStacks', ailment: 'burn' },
          do: [explode],
        },
        {
          on: 'ailmentTick',
          when: [{ ailment: 'poison' }],
          target: { pick: 'highestHp' },
          do: [explode],
        },
      ),
    ).toEqual([
      `${at} target.pick 'mostStacks' scans every enemy on each 'ailmentApplied' event; use 'nearest' here, or move the effect to a periodic trigger`,
      "talent 'vitality': triggers[1] target.pick 'highestHp' scans every enemy on each 'ailmentTick' event; use 'nearest' here, or move the effect to a periodic trigger",
    ]);
  });

  it('checks a selector’s ailment, range and excluded event enemy', () => {
    expect(
      triggerIssues(
        { on: 'kill', target: { pick: 'mostStacks' }, do: [explode] },
        { on: 'kill', target: { pick: 'nearest', ailment: 'burn' }, do: [explode] },
        { on: 'kill', target: { pick: 'nearest', range: 0 }, do: [explode] },
        {
          on: 'periodic',
          every: 1,
          target: { pick: 'nearest', excludeEventTarget: true },
          do: [explode],
        },
      ),
    ).toEqual([
      `${at} target.pick 'mostStacks' needs target.ailment (burn, poison or shock)`,
      "talent 'vitality': triggers[1] target.ailment only applies to pick 'mostStacks'",
      "talent 'vitality': triggers[2] target.range must be > 0 (got 0)",
      "talent 'vitality': triggers[3] target.excludeEventTarget needs the event's enemy, which 'periodic' events have not",
    ]);
    // A 'player' pick gives the effects no enemy to act on.
    expect(
      triggerIssues({
        on: 'hit',
        target: { pick: 'player' },
        do: [
          { kind: 'applyAilment', ailment: 'burn' },
          { kind: 'spreadAilment', ailment: 'burn', radius: 100 },
          { kind: 'addFrost', amount: 0.5, radius: 100 },
        ],
      }),
    ).toEqual([
      `${at} do[0] applyAilment needs an enemy, which target.pick 'player' does not give`,
      `${at} do[1] spreadAilment needs an enemy, which target.pick 'player' does not give`,
    ]);
  });

  it('needs a radius for an order', () => {
    expect(
      triggerIssues({
        on: 'hit',
        do: [
          { kind: 'applyAilment', ailment: 'burn', order: 'nearest' },
          { kind: 'addFrost', amount: 0.2, order: 'id' },
          { kind: 'applyAilment', ailment: 'burn', radius: 100, maxTargets: 2, order: 'nearest' },
          { kind: 'addFrost', amount: 0.2, radius: 100, order: 'nearest' },
          { kind: 'explode', radius: 90, damagePct: 0.5, maxTargets: 3, order: 'nearest' },
        ],
      }),
    ).toEqual([
      `${at} do[0] order 'nearest' sorts the enemies a radius finds; add a radius or drop order`,
      `${at} do[1] order 'id' sorts the enemies a radius finds; add a radius or drop order`,
    ]);
    expect(
      triggerIssues({
        on: 'kill',
        when: [{ victimHas: 'poison' }],
        do: [
          {
            kind: 'spreadAilment',
            ailment: 'poison',
            radius: 100,
            maxTargets: 2,
            order: 'nearest',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('accepts groundZone effects, and inZone conditions where a target is checked', () => {
    const zone = { kind: 'groundZone', radius: 60, durationSec: 2, damagePctPerSec: 0.2 } as const;
    expect(
      triggerIssues(
        { on: 'hit', when: [{ inZone: 'outer.fire' }], do: [zone] },
        { on: 'kill', do: [{ ...zone, damagePctPerSec: 0, ailment: 'poison', ailmentStacks: 2 }] },
        { on: 'periodic', every: 2, do: [{ ...zone, damagePctPerSec: 0, slow: 0.9 }] },
        { on: 'freeze', when: [{ inZone: 'center' }], do: [{ ...zone, addFrostPerSec: 0.5 }] },
        { on: 'crit', when: [{ inZone: 'fusion.fire.ice' }], do: [{ ...zone, radius: 400 }] },
      ),
    ).toEqual([]);
    expect(triggerIssues({ on: 'kill', when: [{ inZone: 'outer.fire' }], do: [explode] })).toEqual([
      `${at} when[0] inZone does not apply to 'kill' events`,
    ]);
  });

  it.each(['outer', 'fusion', 'hub', 'asc'] as const)(
    'rejects inZone on the source class %s, on a trigger and on a modifier (K18)',
    (selector) => {
      const problem = `inZone takes one source id (center, outer.<id>, fusion.<char>.<outer>), not '${selector}'`;
      expect(triggerIssues({ on: 'hit', when: [{ inZone: selector }], do: [explode] })).toEqual([
        `${at} when[0] ${problem}`,
      ]);
      let index = -1;
      expect(
        issuesAfter((d) => {
          const node = talent(d, 'vitality');
          index = node.modifiers.length;
          node.modifiers.push({
            stat: 'damage',
            kind: 'more',
            value: 0.1,
            when: [{ inZone: selector }],
          });
          node.descKey = 'talent.vitality.desc';
        }),
      ).toEqual([`talent 'vitality': modifiers[${index}] when[0] ${problem}`]);
    },
  );

  it('accepts repeatAttack effects of 1 to 4 repeats, now or at the next attack, on any event', () => {
    expect(
      triggerIssues(
        { on: 'hit', do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }] },
        { on: 'kill', do: [{ kind: 'repeatAttack', count: 4, damagePct: 0.2, timing: 'now' }] },
        {
          on: 'nthAttack',
          every: 3,
          do: [{ kind: 'repeatAttack', count: 2, damagePct: 1.5, timing: 'nextAttack' }],
        },
        { on: 'periodic', every: 2, do: [{ kind: 'repeatAttack', count: 3, damagePct: 0.01 }] },
      ),
    ).toEqual([]);
  });

  it('rejects repeatAttack parameters out of range', () => {
    expect(
      triggerIssues({
        on: 'hit',
        do: [
          { kind: 'repeatAttack', count: 0, damagePct: 0 },
          { kind: 'repeatAttack', count: 5, damagePct: -0.5 },
          { kind: 'repeatAttack', count: 1.5, damagePct: 0.5 },
          { kind: 'repeatAttack', count: Number.NaN, damagePct: Number.NaN },
          {
            kind: 'repeatAttack',
            count: 1,
            damagePct: 0.5,
            timing: 'later' as unknown as 'now',
          },
        ],
      }),
    ).toEqual([
      `${at} do[0] count must be an integer in [1, 4] (got 0)`,
      `${at} do[0] damagePct must be > 0 (got 0)`,
      `${at} do[1] count must be an integer in [1, 4] (got 5)`,
      `${at} do[1] damagePct must be > 0 (got -0.5)`,
      `${at} do[2] count must be an integer in [1, 4] (got 1.5)`,
      `${at} do[3] count must be an integer in [1, 4] (got NaN)`,
      `${at} do[3] damagePct must be > 0 (got NaN)`,
      `${at} do[4] timing must be 'now' or 'nextAttack' (got later)`,
    ]);
  });

  it('accepts detonates on a live target, and on a dead one with a radius and its victimHas', () => {
    const burn = { kind: 'detonate', ailment: 'burn' } as const;
    expect(
      triggerIssues(
        { on: 'hit', do: [burn, { ...burn, ailment: 'poison', fraction: 0.5, damage: 2 }] },
        { on: 'crit', do: [{ ...burn, radius: 80, maxTargets: 3, order: 'nearest' }] },
        { on: 'freeze', do: [{ ...burn, ailment: 'bleed', fraction: 1 }] },
        { on: 'kill', when: [{ victimHas: 'burn' }], do: [{ ...burn, radius: 120 }] },
        {
          on: 'diedWithAilment',
          when: [{ victimHas: 'poison' }],
          do: [heal, { kind: 'detonate', ailment: 'poison', radius: 60, damage: 0.5 }],
        },
        {
          on: 'shatter',
          when: [{ victimHas: 'bleed' }],
          do: [{ ...burn, ailment: 'bleed', radius: 90 }],
        },
        { on: 'periodic', every: 2, target: { pick: 'highestHp' }, do: [burn] },
        {
          on: 'hit',
          when: [
            { stacksAtLeast: { ailment: 'burn', stacks: 'max' } },
            { stacksAtLeast: { ailment: 'shock', stacks: 'max' } },
          ],
          do: [burn],
        },
      ),
    ).toEqual([]);
  });

  it('rejects detonate parameters out of range, and maxTargets or order without a radius', () => {
    expect(
      triggerIssues({
        on: 'hit',
        do: [
          { kind: 'detonate', ailment: 'burn', fraction: 0, damage: 0 },
          { kind: 'detonate', ailment: 'burn', fraction: 1.5, radius: -1 },
          { kind: 'detonate', ailment: 'burn', fraction: Number.NaN, radius: 50, maxTargets: 1.5 },
          { kind: 'detonate', ailment: 'poison', maxTargets: 2 },
          { kind: 'detonate', ailment: 'poison', order: 'nearest' },
        ],
      }),
    ).toEqual([
      `${at} do[0] fraction must be in (0, 1] (got 0)`,
      `${at} do[0] damage must be > 0 (got 0)`,
      `${at} do[1] fraction must be in (0, 1] (got 1.5)`,
      `${at} do[1] radius must be > 0 (got -1)`,
      `${at} do[2] fraction must be in (0, 1] (got NaN)`,
      `${at} do[2] maxTargets must be a positive integer (got 1.5)`,
      `${at} do[3] maxTargets and order need a radius`,
      `${at} do[4] maxTargets and order need a radius`,
    ]);
  });

  it('rejects a kill detonate without a radius, its victimHas, or one ailment, or with gainShards', () => {
    const burn = { kind: 'detonate', ailment: 'burn', radius: 100 } as const;
    expect(
      triggerIssues({
        on: 'kill',
        when: [{ victimHas: 'burn' }],
        do: [{ kind: 'detonate', ailment: 'burn' }],
      }),
    ).toEqual([`${at} do[0] detonate needs a radius on 'kill' events, whose enemy is dead`]);
    expect(
      triggerIssues({
        on: 'shatter',
        when: [{ victimHas: 'burn' }],
        do: [{ kind: 'detonate', ailment: 'burn' }],
      }),
    ).toEqual([`${at} do[0] detonate needs a radius on 'shatter' events, whose enemy is dead`]);
    expect(triggerIssues({ on: 'kill', do: [burn] })).toEqual([
      `${at} a kill trigger with detonate needs victimHas 'burn'`,
    ]);
    expect(
      triggerIssues({ on: 'diedWithAilment', when: [{ victimHas: 'poison' }], do: [burn] }),
    ).toEqual([`${at} a kill trigger with detonate needs victimHas 'burn'`]);
    expect(
      triggerIssues({
        on: 'kill',
        when: [{ victimHas: 'burn' }, { victimHas: 'bleed' }],
        do: [burn, { ...burn, ailment: 'bleed' }],
      }),
    ).toEqual([`${at} a kill trigger's detonates must name one ailment (got burn, bleed)`]);
    expect(
      triggerIssues({
        on: 'kill',
        when: [{ victimHas: 'burn' }],
        do: [{ kind: 'gainShards', fraction: 0.5 }, burn],
      }),
    ).toEqual([`${at} gainShards and detonate cannot share a kill trigger`]);
    // On a live target's event, none of these applies.
    expect(triggerIssues({ on: 'hit', do: [{ kind: 'detonate', ailment: 'bleed' }] })).toEqual([]);
  });

  it('rejects a detonate with no enemy to read', () => {
    const burn = { kind: 'detonate', ailment: 'burn' } as const;
    expect(triggerIssues({ on: 'periodic', every: 2, do: [burn] })).toEqual([
      `${at} do[0] detonate needs a target on 'periodic' events; add target {pick}`,
    ]);
    expect(triggerIssues({ on: 'heroHit', do: [{ ...burn, radius: 80 }] })).toEqual([
      `${at} do[0] detonate needs a target on 'heroHit' events; add target {pick}`,
    ]);
    expect(triggerIssues({ on: 'contact', do: [burn] })).toEqual([
      `${at} do[0] detonate needs the event's enemy, which has left by the time it runs`,
    ]);
    expect(
      triggerIssues({ on: 'periodic', every: 2, target: { pick: 'player' }, do: [burn] }),
    ).toEqual([`${at} do[0] detonate needs an enemy, which target.pick 'player' does not give`]);
  });

  it('accepts projectiles of 1 to 64, every aim, from either point, on wired events', () => {
    const shots = { kind: 'projectiles', count: 1, damagePct: 0.5 } as const;
    expect(
      triggerIssues(
        {
          on: 'hit',
          do: [
            { ...shots, aim: 'target' },
            { ...shots, count: 64, aim: 'fan' },
          ],
        },
        { on: 'crit', do: [{ ...shots, aim: 'distinct', from: 'player', pierce: -1 }] },
        { on: 'kill', do: [{ ...shots, count: 4, aim: 'radial', pierce: 2, bounce: 3 }] },
        { on: 'kill', do: [{ ...shots, count: 4, aim: 'radial', pierce: 0, bounce: 0 }] },
        {
          on: 'hit',
          do: [{ ...shots, aim: 'fan', spreadDeg: 60, tags: ['chain'], element: 'cold' }],
        },
        { on: 'periodic', every: 0.2, do: [{ ...shots, count: 12, aim: 'radial' }] },
        {
          on: 'periodic',
          every: 1,
          target: { pick: 'highestHp' },
          do: [
            { ...shots, aim: 'target' },
            { ...shots, aim: 'distinct', damagePct: 0 },
          ],
        },
        { on: 'waveStart', do: [{ ...shots, count: 8, aim: 'radial', from: 'player' }] },
      ),
    ).toEqual([]);
  });

  it('rejects projectiles parameters out of range, and spreadDeg off a fan', () => {
    const shots = { kind: 'projectiles', damagePct: 0.5, aim: 'radial' } as const;
    expect(
      triggerIssues({
        on: 'hit',
        do: [
          { ...shots, count: 0, damagePct: -0.5 },
          { ...shots, count: 65, pierce: -2, bounce: -1 },
          { ...shots, count: 1.5, pierce: 0.5, bounce: 1.5 },
          { ...shots, count: Number.NaN, pierce: Number.NaN, bounce: Number.NaN },
          { ...shots, count: 2, spreadDeg: 30 },
          { ...shots, count: 2, aim: 'target', spreadDeg: 30, tags: ['zone', 'zone'] },
        ],
      }),
    ).toEqual([
      `${at} do[0] count must be an integer in [1, 64] (got 0)`,
      `${at} do[0] damagePct must be >= 0 (got -0.5)`,
      `${at} do[1] count must be an integer in [1, 64] (got 65)`,
      `${at} do[1] pierce must be an integer >= -1 (-1: every enemy) (got -2)`,
      `${at} do[1] bounce must be a non-negative integer (got -1)`,
      `${at} do[2] count must be an integer in [1, 64] (got 1.5)`,
      `${at} do[2] pierce must be an integer >= -1 (-1: every enemy) (got 0.5)`,
      `${at} do[2] bounce must be a non-negative integer (got 1.5)`,
      `${at} do[3] count must be an integer in [1, 64] (got NaN)`,
      `${at} do[3] pierce must be an integer >= -1 (-1: every enemy) (got NaN)`,
      `${at} do[3] bounce must be a non-negative integer (got NaN)`,
      `${at} do[4] spreadDeg only applies to aim 'fan'`,
      `${at} do[5] spreadDeg only applies to aim 'fan'`,
      `${at} do[5] tags must be unique and not empty; omit the field instead`,
    ]);
  });

  it("rejects homing projectiles without a target on targetless events, but not 'radial' or a selector's", () => {
    const shots = { kind: 'projectiles', count: 2, damagePct: 0.5 } as const;
    expect(triggerIssues({ on: 'periodic', every: 1, do: [{ ...shots, aim: 'target' }] })).toEqual([
      `${at} do[0] projectiles aim 'target' needs a target on 'periodic' events; add target {pick} or use aim 'radial'`,
    ]);
    expect(triggerIssues({ on: 'heroHit', do: [{ ...shots, aim: 'distinct' }] })).toEqual([
      `${at} do[0] projectiles aim 'distinct' needs a target on 'heroHit' events; add target {pick} or use aim 'radial'`,
    ]);
    expect(
      triggerIssues({ on: 'waveStart', do: [{ ...shots, aim: 'target', from: 'player' }] }),
    ).toEqual([
      `${at} do[0] projectiles aim 'target' needs a target on 'waveStart' events; add target {pick} or use aim 'radial'`,
    ]);
    expect(
      triggerIssues(
        { on: 'periodic', every: 1, do: [{ ...shots, aim: 'radial' }] },
        { on: 'heroHit', target: { pick: 'nearest' }, do: [{ ...shots, aim: 'distinct' }] },
        {
          on: 'hit',
          do: [
            { ...shots, aim: 'target' },
            { ...shots, aim: 'distinct' },
          ],
        },
      ),
    ).toEqual([]);
  });

  it('accepts slashLine in every direction from either point, and coinHit, on wired events', () => {
    const cut = { kind: 'slashLine', length: 300, width: 24, damagePct: 0.5 } as const;
    expect(
      triggerIssues(
        {
          on: 'hit',
          do: [
            { ...cut, toward: 'outward' },
            { ...cut, toward: 'nearest', from: 'event', alwaysCrit: true, critScale: 1 },
            { ...cut, toward: 'eventTarget', from: 'target', critScale: 0, tags: ['chain'] },
            { kind: 'coinHit', multiplier: 10, ignoreShield: true, ignoreArmour: true },
          ],
        },
        { on: 'kill', do: [{ ...cut, toward: 'nearest' }] },
        { on: 'periodic', every: 1, do: [{ ...cut, toward: 'outward' }] },
        {
          on: 'periodic',
          every: 1,
          target: { pick: 'highestHp' },
          do: [
            { ...cut, toward: 'eventTarget' },
            { kind: 'coinHit', multiplier: 10 },
          ],
        },
        { on: 'heroHit', target: { pick: 'nearest' }, do: [{ kind: 'coinHit', multiplier: 2 }] },
        { on: 'waveStart', do: [{ ...cut, toward: 'nearest' }] },
      ),
    ).toEqual([]);
  });

  it('rejects slashLine and coinHit parameters out of range', () => {
    const cut = { kind: 'slashLine', toward: 'outward' } as const;
    expect(
      triggerIssues({
        on: 'hit',
        do: [
          { ...cut, length: 0, width: -1, damagePct: 0, critScale: -0.5 },
          { ...cut, length: Number.NaN, width: Number.NaN, damagePct: Number.NaN },
          { ...cut, length: 300, width: 24, damagePct: 0.5, tags: ['chain', 'chain'] },
          { kind: 'coinHit', multiplier: 0 },
          { kind: 'coinHit', multiplier: -2 },
        ],
      }),
    ).toEqual([
      `${at} do[0] length must be > 0 (got 0)`,
      `${at} do[0] width must be > 0 (got -1)`,
      `${at} do[0] damagePct must be > 0 (got 0)`,
      `${at} do[0] critScale must be >= 0 (got -0.5)`,
      `${at} do[1] length must be > 0 (got NaN)`,
      `${at} do[1] width must be > 0 (got NaN)`,
      `${at} do[1] damagePct must be > 0 (got NaN)`,
      `${at} do[2] tags must be unique and not empty; omit the field instead`,
      `${at} do[3] multiplier must be > 0 (got 0)`,
      `${at} do[4] multiplier must be > 0 (got -2)`,
    ]);
  });

  it("rejects toward 'flight' until C5, and a direction the simulation does not run", () => {
    const cut = { kind: 'slashLine', length: 300, width: 24, damagePct: 0.5 } as const;
    const toward = (direction: string): SlashLineSpec =>
      ({ ...cut, toward: direction }) as unknown as SlashLineSpec;
    expect(triggerIssues({ on: 'hit', do: [toward('flight'), toward('sideways')] })).toEqual([
      `${at} do[0] toward 'flight' needs a drone direction, which the simulation adds in C5`,
      `${at} do[1] toward must be 'outward', 'nearest', 'eventTarget' or 'along' (got sideways)`,
    ]);
  });

  it("takes toward 'along' on chainJump events alone, whose value is the jump's angle", () => {
    const cut = { kind: 'slashLine', length: 300, width: 24, damagePct: 0.5 } as const;
    expect(triggerIssues({ on: 'chainJump', do: [{ ...cut, toward: 'along' }] })).toEqual([]);
    expect(
      triggerIssues(
        {
          on: 'hit',
          do: [
            { ...cut, toward: 'along' },
            { ...cut, toward: 'along', from: 'target' },
          ],
        },
        { on: 'explode', do: [{ ...cut, toward: 'along' }] },
      ),
    ).toEqual([
      `${at} do[0] toward 'along' follows a chain jump, which only 'chainJump' events have`,
      `${at} do[1] toward 'along' follows a chain jump, which only 'chainJump' events have`,
      "talent 'vitality': triggers[1] do[0] toward 'along' follows a chain jump, which only 'chainJump' events have",
    ]);
  });

  it("rejects toward 'eventTarget' and coinHit without an enemy on targetless events, but not with a selector's", () => {
    const cut = { kind: 'slashLine', length: 300, width: 24, damagePct: 0.5 } as const;
    const coin = { kind: 'coinHit', multiplier: 10 } as const;
    expect(
      triggerIssues({
        on: 'periodic',
        every: 1,
        do: [{ ...cut, toward: 'eventTarget' }, coin, { ...cut, toward: 'outward' }],
      }),
    ).toEqual([
      `${at} do[0] toward 'eventTarget' needs the event's enemy, which 'periodic' events have not`,
      `${at} do[1] coinHit needs a target on 'periodic' events; add target {pick}`,
    ]);
    expect(
      triggerIssues({ on: 'heroHit', do: [{ ...cut, toward: 'eventTarget', from: 'target' }] }),
    ).toEqual([
      `${at} do[0] toward 'eventTarget' needs the event's enemy, which 'heroHit' events have not`,
    ]);
    expect(triggerIssues({ on: 'waveStart', do: [coin] })).toEqual([
      `${at} do[0] coinHit needs a target on 'waveStart' events; add target {pick}`,
    ]);
    expect(
      triggerIssues(
        {
          on: 'periodic',
          every: 2,
          target: { pick: 'farthest' },
          do: [{ ...cut, toward: 'eventTarget' }],
        },
        { on: 'heroHit', target: { pick: 'nearest' }, do: [coin] },
      ),
    ).toEqual([]);
  });

  it("accepts chainBolt from either start, from 'eventTarget' where a live enemy starts it", () => {
    const bolt = { kind: 'chainBolt', jumps: 2, damagePct: 0.5 } as const;
    const near = { ...bolt, from: 'nearestToPoint' } as const;
    expect(
      triggerIssues(
        {
          on: 'hit',
          do: [
            bolt,
            { ...bolt, jumps: 0, shockStacks: 1, from: 'eventTarget' },
            { ...bolt, jumps: 31, damagePct: 0, shockStacks: 3 },
            near,
          ],
        },
        { on: 'ailmentApplied', when: [{ ailment: 'shock' }], do: [bolt] },
        { on: 'freeze', do: [bolt] },
        { on: 'nthAttack', every: 3, do: [bolt] },
        { on: 'kill', do: [near] },
        { on: 'diedWithAilment', do: [near] },
        { on: 'shatter', do: [{ ...near, shockStacks: 2 }] },
        { on: 'contact', do: [near] },
        { on: 'heroHit', do: [near] },
        { on: 'periodic', every: 1, do: [near] },
        { on: 'waveStart', do: [near] },
        { on: 'periodic', every: 1, target: { pick: 'highestHp' }, do: [bolt] },
        { on: 'kill', target: { pick: 'nearest' }, do: [bolt] },
        { on: 'heroHit', target: { pick: 'nearest' }, do: [bolt] },
        { on: 'periodic', every: 1, target: { pick: 'player' }, do: [near] },
      ),
    ).toEqual([]);
  });

  it('rejects chainBolt jumps outside [0, 31] or not whole, a negative damagePct and shockStacks that is not a positive integer', () => {
    const bolt = { kind: 'chainBolt', damagePct: 0.5 } as const;
    expect(
      triggerIssues({
        on: 'hit',
        do: [
          { ...bolt, jumps: 32 },
          { ...bolt, jumps: -1 },
          { ...bolt, jumps: 1.5 },
          { ...bolt, jumps: Number.NaN },
          { ...bolt, jumps: 2, damagePct: -0.5, shockStacks: 0 },
          { ...bolt, jumps: 2, shockStacks: 1.5 },
        ],
      }),
    ).toEqual([
      `${at} do[0] jumps must be an integer in [0, 31] (got 32)`,
      `${at} do[1] jumps must be an integer in [0, 31] (got -1)`,
      `${at} do[2] jumps must be an integer in [0, 31] (got 1.5)`,
      `${at} do[3] jumps must be an integer in [0, 31] (got NaN)`,
      `${at} do[4] damagePct must be >= 0 (got -0.5)`,
      `${at} do[4] shockStacks must be a positive integer (got 0)`,
      `${at} do[5] shockStacks must be a positive integer (got 1.5)`,
    ]);
  });

  it("rejects chainBolt from 'eventTarget' on events without a live enemy, and with a 'player' pick", () => {
    const bolt = { kind: 'chainBolt', jumps: 2, damagePct: 0.5 } as const;
    const problem = (on: string): string =>
      `${at} do[0] chainBolt from 'eventTarget' needs a live enemy; on '${on}' events use from 'nearestToPoint'`;
    const events: TriggerSpec[] = [
      { on: 'periodic', every: 1, do: [bolt] },
      { on: 'waveStart', do: [{ ...bolt, from: 'eventTarget' }] },
      { on: 'heroHit', do: [bolt] },
      { on: 'kill', do: [bolt] },
      { on: 'diedWithAilment', do: [bolt] },
      { on: 'shatter', do: [bolt] },
      { on: 'contact', do: [bolt] },
    ];
    for (const trigger of events) {
      expect(triggerIssues(trigger), trigger.on).toEqual([problem(trigger.on)]);
    }
    expect(
      triggerIssues({
        on: 'periodic',
        every: 1,
        target: { pick: 'player' },
        do: [bolt, { ...bolt, from: 'eventTarget' }, { ...bolt, from: 'nearestToPoint' }],
      }),
    ).toEqual([
      `${at} do[0] chainBolt needs an enemy, which target.pick 'player' does not give`,
      `${at} do[1] chainBolt needs an enemy, which target.pick 'player' does not give`,
    ]);
  });

  it("rejects stacksAtLeast 'max' for poison, on a trigger and on a modifier", () => {
    const problem = "stacksAtLeast 'max' needs a stack cap, which poison has not; give a number";
    const max = { stacksAtLeast: { ailment: 'poison', stacks: 'max' } } as const;
    expect(triggerIssues({ on: 'hit', when: [max], do: [explode] })).toEqual([
      `${at} when[0] ${problem}`,
    ]);
    let index = -1;
    expect(
      issuesAfter((d) => {
        const node = talent(d, 'vitality');
        index = node.modifiers.length;
        node.modifiers.push({ stat: 'damage', kind: 'more', value: 0.1, when: [max] });
        node.descKey = 'talent.vitality.desc';
      }),
    ).toEqual([`talent 'vitality': modifiers[${index}] when[0] ${problem}`]);
  });

  it('rejects groundZone parameters out of range, and a zone that does nothing', () => {
    expect(
      triggerIssues({
        on: 'hit',
        do: [
          { kind: 'groundZone', radius: 0, durationSec: 0.2, damagePctPerSec: -1 },
          { kind: 'groundZone', radius: 401, durationSec: 1, damagePctPerSec: 0 },
          {
            kind: 'groundZone',
            radius: 60,
            durationSec: 1,
            damagePctPerSec: 0.1,
            ailmentStacks: 1.5,
            ailmentDamagePct: 0,
          },
          {
            kind: 'groundZone',
            radius: 60,
            durationSec: 1,
            damagePctPerSec: 0,
            addFrostPerSec: 0,
            slow: 0.95,
          },
          { kind: 'groundZone', radius: 60, durationSec: 1, damagePctPerSec: 0, slow: 0 },
          {
            kind: 'groundZone',
            radius: 1,
            durationSec: 0.25,
            damagePctPerSec: 0.1,
            tags: ['burn'],
          },
        ],
      }),
    ).toEqual([
      `${at} do[0] radius must be in [1, 400] (got 0)`,
      `${at} do[0] durationSec must be >= 0.25, one pulse (got 0.2)`,
      `${at} do[0] damagePctPerSec must be >= 0 (got -1)`,
      `${at} do[1] radius must be in [1, 400] (got 401)`,
      `${at} do[1] groundZone does nothing: give it damagePctPerSec > 0, ailment, addFrostPerSec or slow`,
      `${at} do[2] ailmentStacks must be a positive integer (got 1.5)`,
      `${at} do[2] ailmentDamagePct must be > 0 (got 0)`,
      `${at} do[2] ailmentStacks and ailmentDamagePct need ailment`,
      `${at} do[3] addFrostPerSec must be > 0 (got 0)`,
      `${at} do[3] slow must be in (0, 0.9] (got 0.95)`,
      `${at} do[4] slow must be in (0, 0.9] (got 0)`,
      `${at} do[5] tag 'burn' is not an owner or geometry tag`,
    ]);
  });

  it('requires damagePctPerSec on a groundZone, through the schema and without it (L1)', () => {
    const l1 = 'damagePctPerSec is required; use 0 for a zone that only applies its status terms';
    const zone = { kind: 'groundZone', radius: 60, durationSec: 1, ailment: 'poison' };
    expect(
      triggerIssues({ on: 'hit', do: [zone as unknown as TriggerSpec['do'][number]] }),
    ).toEqual([`${at} do[0] ${l1}`]);
    const data = content();
    talent(data, 'vitality').triggers.push({
      on: 'hit',
      do: [zone],
    } as unknown as Mutable<TriggerSpec>);
    talent(data, 'vitality').descKey = 'talent.vitality.desc';
    expect(() => parseGameData(data)).toThrow(l1);
  });

  it('accepts a keystone whose behaviour is a trigger, and needs a descKey for one', () => {
    expect(
      issuesAfter((d) => {
        const node = talent(d, 'glassCannon');
        node.rules = [];
        node.triggers = [{ on: 'kill', do: [explode] }];
      }),
    ).toEqual([]);
    expect(
      issuesAfter((d) => talent(d, 'vitality').triggers.push({ on: 'kill', do: [explode] })),
    ).toEqual([
      "talent 'vitality': a node with rules, triggers, conversions, emitters or behaviour modifiers needs a descKey",
    ]);
  });
});

describe('conversion validation', () => {
  /** Issues of the real content with `conversions` on 'vitality', which then has its descKey. */
  const conversionIssues = (...conversions: ConversionSpec[]): string[] =>
    issuesAfter((d) => {
      const node = talent(d, 'vitality');
      node.conversions.push(...(conversions as Mutable<ConversionSpec>[]));
      node.descKey = 'talent.vitality.desc';
    });
  const at = "talent 'vitality': conversions";

  it('accepts conversions to every target adding up to at most 1', () => {
    expect(
      conversionIssues(
        { to: 'poison', fraction: 0.3 },
        { tags: ['minion'], to: 'bleed', fraction: 0.2 },
        { tags: ['chain', 'crit'], to: 'cold', fraction: 0.25 },
        { to: 'lightning', fraction: 0.15 },
        { tags: ['hit'], to: 'burn', fraction: 0.1 },
      ),
    ).toEqual([]);
  });

  it("rejects a node's conversions adding up to more than 1", () => {
    expect(
      conversionIssues({ to: 'poison', fraction: 0.6 }, { to: 'bleed', fraction: 0.5 }),
    ).toEqual(["talent 'vitality': conversions add up to 1.1, more than 1"]);
  });

  it('accepts shares that add up to 1 in decimal but not in binary floating point', () => {
    expect(
      conversionIssues(
        { to: 'poison', fraction: 0.34 },
        { to: 'bleed', fraction: 0.56 },
        { to: 'cold', fraction: 0.1 },
      ),
    ).toEqual([]);
  });

  it('rejects a share of 0 or less and tags no hit carries', () => {
    expect(
      conversionIssues(
        { to: 'poison', fraction: 0 },
        { tags: [], to: 'poison', fraction: 0.1 },
        { tags: ['burn', 'projectile', 'projectile'], to: 'cold', fraction: 0.1 },
        { tags: ['poison'], to: 'bleed', fraction: -0.2 },
      ),
    ).toEqual([
      `${at}[0] fraction must be > 0 (got 0)`,
      `${at}[1] tags must be unique and not empty; omit the field instead`,
      `${at}[2] tags must be unique and not empty; omit the field instead`,
      `${at}[2] tag 'burn' is a damage-over-time kind, and only hits convert`,
      `${at}[3] fraction must be > 0 (got -0.2)`,
      `${at}[3] tag 'poison' is a damage-over-time kind, and only hits convert`,
    ]);
  });

  it('accepts a keystone whose behaviour is a conversion, and needs a descKey for one', () => {
    expect(
      issuesAfter((d) => {
        const node = talent(d, 'glassCannon');
        node.rules = [];
        node.conversions = [{ to: 'poison', fraction: 0.5 }];
      }),
    ).toEqual([]);
    expect(
      issuesAfter((d) => talent(d, 'vitality').conversions.push({ to: 'poison', fraction: 0.5 })),
    ).toEqual([
      "talent 'vitality': a node with rules, triggers, conversions, emitters or behaviour modifiers needs a descKey",
    ]);
  });
});

describe('emitter grant validation', () => {
  /**
   * The real content plus two leaf nodes off the start node, `first` and `second`, each with a
   * descKey and these grants.
   */
  type Leaf = { id: string; emitters: EmitterGrant[] };
  const withGrants = (first: Leaf, second: Leaf | null = null): Mutable<GameData> => {
    const d = content();
    const start = d.talents.find((node) => node.kind === 'start') as Mutable<TalentNode>;
    for (const leaf of second === null ? [first] : [first, second]) {
      start.links.push(leaf.id);
      d.talents.push({
        ...smallNode(leaf.id, [start.id]),
        emitters: leaf.emitters,
        descKey: `talent.${leaf.id}.desc`,
      });
    }
    return d;
  };
  const grantIssues = (first: Leaf, second: Leaf | null = null): string[] =>
    validateGameData(withGrants(first, second));

  it('accepts thorns grants, with or without a damage share', () => {
    expect(grantIssues({ id: 'outer.thorns.spikes', emitters: [{ kind: 'thorns' }] })).toEqual([]);
    expect(
      grantIssues({ id: 'outer.thorns.spikes', emitters: [{ kind: 'thorns', damagePct: 0.5 }] }),
    ).toEqual([]);
  });

  it('rejects a damage share that is not above 0', () => {
    expect(
      grantIssues({
        id: 'outer.thorns.spikes',
        emitters: [
          { kind: 'thorns', damagePct: 0 },
          { kind: 'thorns', damagePct: -1 },
        ],
      }),
    ).toEqual([
      "talent 'outer.thorns.spikes': emitters[0] damagePct must be > 0 (got 0)",
      "talent 'outer.thorns.spikes': emitters[1] damagePct must be > 0 (got -1)",
      "talents: emitter thorns '' is granted twice by source 'outer.thorns' with different " +
        'fields; keep it on one node',
    ]);
  });

  it('rejects grants of one kind, source and key that differ, on one node or on two', () => {
    const conflict =
      "talents: emitter thorns '' is granted twice by source 'outer.thorns' with different " +
      'fields; keep it on one node';
    expect(
      grantIssues(
        { id: 'outer.thorns.spikes', emitters: [{ kind: 'thorns' }] },
        { id: 'outer.thorns.barbs', emitters: [{ kind: 'thorns', damagePct: 3 }] },
      ),
    ).toEqual([conflict]);
    expect(
      grantIssues({
        id: 'outer.thorns.spikes',
        emitters: [
          { kind: 'thorns', damagePct: 2 },
          { kind: 'thorns', damagePct: 4 },
        ],
      }),
    ).toEqual([conflict]);
    // A load error.
    const conflicting = withGrants(
      { id: 'outer.thorns.spikes', emitters: [{ kind: 'thorns' }] },
      { id: 'outer.thorns.barbs', emitters: [{ kind: 'thorns', damagePct: 3 }] },
    );
    expect(() => parseGameData(conflicting)).toThrow(conflict);
    // Equal grants are one emitter, and other sources have their own.
    expect(
      grantIssues(
        { id: 'outer.thorns.spikes', emitters: [{ kind: 'thorns', damagePct: 2 }] },
        { id: 'outer.thorns.barbs', emitters: [{ kind: 'thorns', damagePct: 2 }] },
      ),
    ).toEqual([]);
    expect(
      grantIssues(
        { id: 'outer.thorns.spikes', emitters: [{ kind: 'thorns', damagePct: 2 }] },
        { id: 'hub.barbs', emitters: [{ kind: 'thorns', damagePct: 4 }] },
      ),
    ).toEqual([]);
  });

  it('accepts segment grants between shocked enemies, with or without their fields', () => {
    const full: EmitterGrant = {
      kind: 'segment',
      endpoints: 'shocked',
      links: 1,
      range: 150,
      damagePct: 0.3,
      shockStacks: 2,
      periodSec: 0.5,
    };
    for (const grant of [{ kind: 'segment', endpoints: 'shocked' } as const, full]) {
      expect(grantIssues({ id: 'outer.lightning.web', emitters: [grant] })).toEqual([]);
    }
  });

  it('rejects segment links but 1 or 2, a range not above 0, and the endpoints C5 adds', () => {
    const segment = (fields: object): EmitterGrant =>
      ({ kind: 'segment', endpoints: 'shocked', ...fields }) as EmitterGrant;
    expect(
      grantIssues({
        id: 'outer.lightning.web',
        emitters: [
          segment({ links: 3 }),
          segment({ links: 0, range: 0 }),
          segment({ links: 1.5, range: -10 }),
          segment({ endpoints: 'drones' }),
          segment({ endpoints: 'summons', links: 2 }),
          segment({ endpoints: 'enemies' }),
        ],
      }).filter((issue) => !issue.startsWith('talents: emitter segment')),
    ).toEqual([
      "talent 'outer.lightning.web': emitters[0] links must be 1 or 2 (got 3)",
      "talent 'outer.lightning.web': emitters[1] links must be 1 or 2 (got 0)",
      "talent 'outer.lightning.web': emitters[1] range must be > 0 (got 0)",
      "talent 'outer.lightning.web': emitters[2] links must be 1 or 2 (got 1.5)",
      "talent 'outer.lightning.web': emitters[2] range must be > 0 (got -10)",
      "talent 'outer.lightning.web': emitters[3] segment endpoints 'drones' come from drones and " +
        'summons, which the simulation adds in C5',
      "talent 'outer.lightning.web': emitters[4] segment endpoints 'summons' come from drones and " +
        'summons, which the simulation adds in C5',
      "talent 'outer.lightning.web': emitters[5] endpoints must be 'shocked' (got enemies)",
    ]);
  });

  it('keeps one segment emitter per source and endpoints, and rejects two that differ', () => {
    const web = (range: number): Leaf => ({
      id: `outer.lightning.web${range}`,
      emitters: [{ kind: 'segment', endpoints: 'shocked', range }],
    });
    expect(grantIssues(web(150), web(250))).toEqual([
      "talents: emitter segment 'shocked' is granted twice by source 'outer.lightning' with " +
        'different fields; keep it on one node',
    ]);
    expect(grantIssues(web(150), { ...web(250), id: 'hub.web' })).toEqual([]);
  });

  const strike = (fields: object): EmitterGrant =>
    ({
      kind: 'strike',
      name: 'bolt',
      periodSec: 1,
      target: { pick: 'nearest' },
      damagePct: 2,
      ...fields,
    }) as EmitterGrant;

  it('accepts strike grants, with or without their optional fields', () => {
    const full = strike({
      target: { pick: 'highestHp', range: 400, excludeBoss: true },
      radius: 60,
      element: 'lightning',
      chainJumps: 3,
      shockStacks: 2,
    });
    for (const grant of [strike({}), full]) {
      expect(grantIssues({ id: 'outer.lightning.bolt', emitters: [grant] })).toEqual([]);
    }
    // The bounds: one tick, no jump, eight jumps.
    for (const fields of [{ periodSec: 1 / 60 }, { chainJumps: 0 }, { chainJumps: 8 }]) {
      expect(grantIssues({ id: 'outer.lightning.bolt', emitters: [strike(fields)] })).toEqual([]);
    }
  });

  it("rejects a strike period under a tick, jumps outside 0..8 and the 'player' pick", () => {
    expect(
      grantIssues({
        id: 'outer.lightning.bolt',
        emitters: [
          strike({ name: 'a', periodSec: 0.01 }),
          strike({ name: 'b', periodSec: 0 }),
          strike({ name: 'c', chainJumps: 9 }),
          strike({ name: 'd', chainJumps: -1 }),
          strike({ name: 'e', chainJumps: 1.5 }),
          strike({ name: 'f', target: { pick: 'player' } }),
          strike({ name: 'g', periodSec: NaN, chainJumps: 12, target: { pick: 'player' } }),
        ],
      }),
    ).toEqual([
      "talent 'outer.lightning.bolt': emitters[0] periodSec must be >= 1/60 (got 0.01)",
      "talent 'outer.lightning.bolt': emitters[1] periodSec must be >= 1/60 (got 0)",
      "talent 'outer.lightning.bolt': emitters[2] chainJumps must be an integer in [0, 8] (got 9)",
      "talent 'outer.lightning.bolt': emitters[3] chainJumps must be an integer in [0, 8] (got -1)",
      "talent 'outer.lightning.bolt': emitters[4] chainJumps must be an integer in [0, 8] (got 1.5)",
      "talent 'outer.lightning.bolt': emitters[5] target.pick 'player' has no enemy to strike; " +
        'pick an enemy',
      "talent 'outer.lightning.bolt': emitters[6] periodSec must be >= 1/60 (got NaN)",
      "talent 'outer.lightning.bolt': emitters[6] chainJumps must be an integer in [0, 8] (got 12)",
      "talent 'outer.lightning.bolt': emitters[6] target.pick 'player' has no enemy to strike; " +
        'pick an enemy',
    ]);
  });

  it("holds a strike's target to a periodic trigger's selector rules", () => {
    expect(
      grantIssues({
        id: 'outer.lightning.bolt',
        emitters: [
          strike({ name: 'a', target: { pick: 'mostStacks' } }),
          strike({ name: 'b', target: { pick: 'nearest', ailment: 'shock' } }),
          strike({ name: 'c', target: { pick: 'nearest', range: 0 } }),
          strike({ name: 'd', target: { pick: 'nearest', excludeEventTarget: true } }),
          // A scanning pick is fine: a periodic event is not frequent.
          strike({ name: 'e', target: { pick: 'farthest' } }),
          strike({ name: 'f', target: { pick: 'mostStacks', ailment: 'shock' } }),
        ],
      }),
    ).toEqual([
      "talent 'outer.lightning.bolt': emitters[0] target.pick 'mostStacks' needs target.ailment " +
        '(burn, poison or shock)',
      "talent 'outer.lightning.bolt': emitters[1] target.ailment only applies to pick 'mostStacks'",
      "talent 'outer.lightning.bolt': emitters[2] target.range must be > 0 (got 0)",
      "talent 'outer.lightning.bolt': emitters[3] target.excludeEventTarget needs the event's " +
        "enemy, which 'periodic' events have not",
    ]);
  });

  it('keeps one strike per source and name, and rejects two of one name that differ', () => {
    const bolt = (id: string, name: string, damagePct: number): Leaf => ({
      id,
      emitters: [strike({ name, damagePct })],
    });
    expect(
      grantIssues(bolt('outer.lightning.bolt', 'bolt', 2), bolt('outer.lightning.clap', 'bolt', 3)),
    ).toEqual([
      "talents: emitter strike 'bolt' is granted twice by source 'outer.lightning' with " +
        'different fields; keep it on one node',
    ]);
    expect(
      grantIssues(bolt('outer.lightning.bolt', 'bolt', 2), bolt('outer.lightning.clap', 'clap', 3)),
    ).toEqual([]);
    expect(
      grantIssues(bolt('outer.lightning.bolt', 'bolt', 2), bolt('outer.lightning.clap', 'bolt', 2)),
    ).toEqual([]);
  });

  it('accepts drone grants of 1 to 24 summons, drones, turrets or both, with or without their shares and a name', () => {
    for (const grant of [
      { kind: 'drone', drones: 1 },
      { kind: 'drone', drones: 3, damagePct: 0.8 },
      { kind: 'drone', drones: 24, damagePct: 2, name: 'b' },
      // A turret-only grant (D16's D = 0), and both kinds with their shares.
      { kind: 'drone', turrets: 2 },
      { kind: 'drone', drones: 0, turrets: 1 },
      { kind: 'drone', drones: 3, turrets: 1, turretDamagePct: 0.4 },
      { kind: 'drone', drones: 20, turrets: 4, damagePct: 1, turretDamagePct: 2, name: 'c' },
    ] as const) {
      expect(grantIssues({ id: 'outer.summon.drones', emitters: [grant] })).toEqual([]);
    }
    // The schema takes the turret fields, so the content loads a turret grant.
    const turrets = withGrants({
      id: 'outer.summon.drones',
      emitters: [{ kind: 'drone', turrets: 2, turretDamagePct: 0.5 }],
    });
    expect(() => parseGameData(turrets)).not.toThrow();
  });

  it('rejects counts that are not whole numbers, drones + turrets outside 1..24, and a share not above 0', () => {
    const drone = (name: string, fields: object): EmitterGrant =>
      ({ kind: 'drone', name, ...fields }) as EmitterGrant;
    expect(
      grantIssues({
        id: 'outer.summon.drones',
        emitters: [
          drone('a', {}),
          drone('b', { drones: 0 }),
          drone('c', { drones: -1 }),
          drone('d', { drones: 1.5 }),
          drone('e', { drones: 25 }),
          drone('f', { drones: NaN }),
          drone('g', { drones: 3, damagePct: 0 }),
          drone('h', { drones: 3, damagePct: -1 }),
          drone('i', { drones: 20, turrets: 5 }),
          drone('j', { drones: 0, turrets: 0 }),
          drone('k', { drones: 3, turrets: -1 }),
          drone('l', { turrets: 2.5 }),
          drone('m', { turrets: 1, turretDamagePct: 0 }),
          drone('n', { turrets: 1, turretDamagePct: -0.4 }),
          drone('o', { drones: -1, turrets: 0.5 }),
        ],
      }),
    ).toEqual([
      "talent 'outer.summon.drones': emitters[0] drones + turrets must be in [1, 24] (got 0)",
      "talent 'outer.summon.drones': emitters[1] drones + turrets must be in [1, 24] (got 0)",
      "talent 'outer.summon.drones': emitters[2] drones must be an integer >= 0 (got -1)",
      "talent 'outer.summon.drones': emitters[3] drones must be an integer >= 0 (got 1.5)",
      "talent 'outer.summon.drones': emitters[4] drones + turrets must be in [1, 24] (got 25)",
      "talent 'outer.summon.drones': emitters[5] drones must be an integer >= 0 (got NaN)",
      "talent 'outer.summon.drones': emitters[6] damagePct must be > 0 (got 0)",
      "talent 'outer.summon.drones': emitters[7] damagePct must be > 0 (got -1)",
      "talent 'outer.summon.drones': emitters[8] drones + turrets must be in [1, 24] (got 25)",
      "talent 'outer.summon.drones': emitters[9] drones + turrets must be in [1, 24] (got 0)",
      "talent 'outer.summon.drones': emitters[10] turrets must be an integer >= 0 (got -1)",
      "talent 'outer.summon.drones': emitters[11] turrets must be an integer >= 0 (got 2.5)",
      "talent 'outer.summon.drones': emitters[12] turretDamagePct must be > 0 (got 0)",
      "talent 'outer.summon.drones': emitters[13] turretDamagePct must be > 0 (got -0.4)",
      "talent 'outer.summon.drones': emitters[14] drones must be an integer >= 0 (got -1)",
      "talent 'outer.summon.drones': emitters[14] turrets must be an integer >= 0 (got 0.5)",
    ]);
  });

  it('keeps one drone emitter per source and name, and rejects two of one name that differ', () => {
    const drones = (id: string, fields: object): Leaf => ({
      id,
      emitters: [{ kind: 'drone', ...fields } as EmitterGrant],
    });
    // No name is the name ''.
    expect(
      grantIssues(
        drones('outer.summon.drones', { drones: 3 }),
        drones('outer.summon.swarm', { drones: 4 }),
      ),
    ).toEqual([
      "talents: emitter drone '' is granted twice by source 'outer.summon' with different " +
        'fields; keep it on one node',
    ]);
    expect(
      grantIssues(
        drones('outer.summon.drones', { drones: 3, name: 'a' }),
        drones('outer.summon.swarm', { drones: 3, name: 'a', damagePct: 1 }),
      ),
    ).toEqual([
      "talents: emitter drone 'a' is granted twice by source 'outer.summon' with different " +
        'fields; keep it on one node',
    ]);
    // Two names are two emitters; equal grants are one; another source has its own.
    expect(
      grantIssues(
        drones('outer.summon.drones', { drones: 3 }),
        drones('outer.summon.swarm', { drones: 4, name: 'b' }),
      ),
    ).toEqual([]);
    expect(
      grantIssues(
        drones('outer.summon.drones', { drones: 3 }),
        drones('outer.summon.swarm', { drones: 3 }),
      ),
    ).toEqual([]);
    expect(
      grantIssues(
        drones('outer.summon.drones', { drones: 3 }),
        drones('hub.drones', { drones: 4 }),
      ),
    ).toEqual([]);
  });

  it('accepts aura and orbit grants, with or without their fields', () => {
    for (const grant of [
      { kind: 'aura' },
      { kind: 'aura', damagePct: 0.5 },
      { kind: 'aura', everyNth: { n: 2, mult: 2 } },
      { kind: 'aura', everyNth: { n: 4, mult: 4 }, corona: { periodSec: 8, damagePct: 1 } },
      { kind: 'aura', corona: { periodSec: 0.25, damagePct: 0.1 } },
      { kind: 'orbit' },
      { kind: 'orbit', ring: 0, count: 2 },
      { kind: 'orbit', ring: 1, count: 0, damagePct: 0.6, cooldownSec: 1 / 60, orbRadius: 12 },
    ] as EmitterGrant[]) {
      expect(
        grantIssues({ id: 'outer.aura.pulse', emitters: [grant] }),
        JSON.stringify(grant),
      ).toEqual([]);
    }
    // Each ring of a source is an emitter of its own.
    expect(
      grantIssues({
        id: 'outer.aura.orbs',
        emitters: [
          { kind: 'orbit', count: 2 },
          { kind: 'orbit', ring: 1, count: 4, cooldownSec: 1 },
        ],
      }),
    ).toEqual([]);
  });

  it('rejects an everyNth.n below 2 or not whole, a corona under 0.25 s, and aura shares not above 0', () => {
    expect(
      grantIssues({
        id: 'outer.aura.pulse',
        emitters: [
          { kind: 'aura', damagePct: 0 },
          { kind: 'aura', everyNth: { n: 1, mult: 1 } },
          { kind: 'aura', everyNth: { n: 2.5, mult: 2.5 } },
          { kind: 'aura', everyNth: { n: 4, mult: 0 } },
          { kind: 'aura', everyNth: { n: NaN, mult: -1 } },
          { kind: 'aura', corona: { periodSec: 0.2, damagePct: 1 } },
          { kind: 'aura', corona: { periodSec: 8, damagePct: -1 } },
        ],
      }),
    ).toEqual([
      "talent 'outer.aura.pulse': emitters[0] damagePct must be > 0 (got 0)",
      "talent 'outer.aura.pulse': emitters[1] everyNth.n must be an integer >= 2 (got 1)",
      "talent 'outer.aura.pulse': emitters[2] everyNth.n must be an integer >= 2 (got 2.5)",
      "talent 'outer.aura.pulse': emitters[3] everyNth.mult must be > 0 (got 0)",
      "talent 'outer.aura.pulse': emitters[4] everyNth.n must be an integer >= 2 (got NaN)",
      "talent 'outer.aura.pulse': emitters[4] everyNth.mult must be > 0 (got -1)",
      "talent 'outer.aura.pulse': emitters[5] corona.periodSec must be >= 0.25 (got 0.2)",
      "talent 'outer.aura.pulse': emitters[6] corona.damagePct must be > 0 (got -1)",
      // A source has one aura (grantKey ''), so these also conflict.
      "talents: emitter aura '' is granted twice by source 'outer.aura' with different fields; " +
        'keep it on one node',
    ]);
  });

  it('rejects an orbit ring other than 0 or 1, a count that is not whole, a cooldown under a tick, and shares or radii not above 0', () => {
    expect(
      grantIssues({
        id: 'outer.aura.orbs',
        emitters: [
          { kind: 'orbit', ring: 2 },
          { kind: 'orbit', ring: 0.5 },
          { kind: 'orbit', count: -1 },
          { kind: 'orbit', count: 1.5 },
          { kind: 'orbit', damagePct: 0 },
          { kind: 'orbit', cooldownSec: 0.01 },
          { kind: 'orbit', orbRadius: 0 },
        ],
      }),
    ).toEqual([
      "talent 'outer.aura.orbs': emitters[0] ring must be 0 or 1 (got 2)",
      "talent 'outer.aura.orbs': emitters[1] ring must be 0 or 1 (got 0.5)",
      "talent 'outer.aura.orbs': emitters[2] count must be an integer >= 0 (got -1)",
      "talent 'outer.aura.orbs': emitters[3] count must be an integer >= 0 (got 1.5)",
      "talent 'outer.aura.orbs': emitters[4] damagePct must be > 0 (got 0)",
      "talent 'outer.aura.orbs': emitters[5] cooldownSec must be >= 1/60 (got 0.01)",
      "talent 'outer.aura.orbs': emitters[6] orbRadius must be > 0 (got 0)",
      // Without a ring each is ring 0's (grantKey '0'), so these also conflict.
      "talents: emitter orbit '0' is granted twice by source 'outer.aura' with different " +
        'fields; keep it on one node',
    ]);
  });

  it('keeps one orbit emitter per source and ring, ring 0 when it names none', () => {
    const orbit = (id: string, fields: object): Leaf => ({
      id,
      emitters: [{ kind: 'orbit', ...fields } as EmitterGrant],
    });
    expect(
      grantIssues(orbit('outer.aura.orbs', { count: 2 }), orbit('outer.aura.more', { ring: 0 })),
    ).toEqual([
      "talents: emitter orbit '0' is granted twice by source 'outer.aura' with different " +
        'fields; keep it on one node',
    ]);
    expect(
      grantIssues(orbit('outer.aura.orbs', { count: 2 }), orbit('outer.aura.more', { ring: 1 })),
    ).toEqual([]);
    expect(
      grantIssues(orbit('outer.aura.orbs', { count: 2 }), orbit('hub.orbs', { count: 3 })),
    ).toEqual([]);
    // An aura of one source is one emitter however its nodes differ.
    expect(
      grantIssues(
        { id: 'outer.aura.pulse', emitters: [{ kind: 'aura' }] },
        {
          id: 'outer.aura.corona',
          emitters: [{ kind: 'aura', corona: { periodSec: 8, damagePct: 1 } }],
        },
      ),
    ).toEqual([
      "talents: emitter aura '' is granted twice by source 'outer.aura' with different fields; " +
        'keep it on one node',
    ]);
  });

  it('accepts a keystone whose behaviour is a grant, and needs a descKey for one', () => {
    expect(
      issuesAfter((d) => {
        const node = talent(d, 'glassCannon');
        node.rules = [];
        node.emitters = [{ kind: 'thorns' }];
      }),
    ).toEqual([]);
    expect(issuesAfter((d) => talent(d, 'vitality').emitters.push({ kind: 'thorns' }))).toEqual([
      "talent 'vitality': a node with rules, triggers, conversions, emitters or behaviour modifiers needs a descKey",
    ]);
  });
});

describe('starArchetypeIssues (outer board ★, on fixtures)', () => {
  const star = (
    id: string,
    modifiers: Modifier[],
    rules: TalentNode['rules'] = [],
  ): TalentNode => ({
    ...smallNode(id, []),
    kind: 'keystone',
    modifiers,
    rules,
    descKey: `talent.${id}.desc`,
  });

  it('accepts a bonus carrying the board tag with an untagged cost (致死毒素)', () => {
    const node = star('outer.poison.lethalToxin', [
      { stat: 'damage', kind: 'more', value: 1, tags: ['poison'] },
      { stat: 'damage', kind: 'more', value: -0.5, tags: ['hit'] },
    ]);
    expect(starArchetypeIssues(node)).toEqual([]);
  });

  it('accepts a center-scoped cost (聖域) and a bonus scoped to the board', () => {
    const node = star('outer.aura.sanctuary', [
      { stat: 'damage', kind: 'more', value: 0.8, tags: ['aura'] },
      { stat: 'damage', kind: 'more', value: -0.5, scope: 'center' },
    ]);
    expect(starArchetypeIssues(node)).toEqual([]);
    const barrage = star('outer.barrage.storm', [
      { stat: 'damage', kind: 'more', value: 0.5, scope: 'outer.barrage' },
    ]);
    expect(starArchetypeIssues(barrage)).toEqual([]);
  });

  it('rejects an untagged more on an outer ★, its rules included', () => {
    const untagged = { stat: 'damage', kind: 'more', value: 1 } as const;
    expect(starArchetypeIssues(star('outer.fire.inferno', [untagged]))).toEqual([
      `talent 'outer.fire.inferno': ★ damage modifier ${JSON.stringify(untagged)} needs a tag ` +
        "of outer.fire (burn) or scope 'outer.fire'",
    ]);
    expect(
      starArchetypeIssues(star('outer.crit.glass', [], [{ id: 'glassCannon', damageMore: 1 }])),
    ).toHaveLength(1);
    // A center keystone (every M1 node) and a board's notable are exempt.
    expect(starArchetypeIssues(star('glassCannon', [untagged]))).toEqual([]);
    expect(
      starArchetypeIssues({ ...star('outer.fire.notable', [untagged]), kind: 'notable' }),
    ).toEqual([]);
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
