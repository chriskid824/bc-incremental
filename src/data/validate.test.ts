import { describe, expect, it } from 'vitest';
import { ENEMIES } from './enemies';
import { loadGameData, parseGameData } from './index';
import { TALENTS } from './talents';
import { isBehaviourModifier } from './stats';
import type { Modifier } from './stats';
import type { TriggerSpec } from './triggers';
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
      "talent 'vitality': a node with rules, triggers or behaviour modifiers needs a descKey",
    ]);
    expect(
      issuesAfter((d) => {
        const node = talent(d, 'glassCannon');
        node.rules = [];
        delete node.descKey;
      }),
    ).toEqual(["talent 'glassCannon': keystone needs a rule, a trigger or a behaviour modifier"]);
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
      "talent 'searingCrits': keystone needs a rule, a trigger or a behaviour modifier",
      "talent 'searingCrits': descKey describes rules, triggers and behaviour modifiers; this node has none",
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
      "talent 'pandemic': keystone needs a rule, a trigger or a behaviour modifier",
      "talent 'pandemic': descKey describes rules, triggers and behaviour modifiers; this node has none",
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
      "talent 'glassCannon': a node with rules, triggers or behaviour modifiers needs a descKey",
      "talent 'vitality': descKey describes rules, triggers and behaviour modifiers; this node has none",
      "talent 'keenEye': a node with rules, triggers or behaviour modifiers needs a descKey",
      "talent 'precision': a node with rules, triggers or behaviour modifiers needs a descKey",
      "talent 'kindling': a node with rules, triggers or behaviour modifiers needs a descKey",
      "talent 'staticFocus': a node with rules, triggers or behaviour modifiers needs a descKey",
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

  it('rejects an event the simulation does not raise yet', () => {
    expect(triggerIssues({ on: 'freeze', do: [explode] })).toEqual([
      `${at} event 'freeze' is not raised by the simulation yet`,
    ]);
    expect(triggerIssues({ on: 'shatter', do: [heal] })).toEqual([
      `${at} event 'shatter' is not raised by the simulation yet`,
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
      "talent 'vitality': a node with rules, triggers or behaviour modifiers needs a descKey",
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
