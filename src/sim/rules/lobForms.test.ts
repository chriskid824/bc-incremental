import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import { TAG } from '../../data/tags';
import { compileBuild } from '../build/compile';
import { moduleTrigger, SHATTER_TRIGGER } from '../effects/types';
import { centerTriggers, makeStats } from '../testing';
import { farThrow } from './lobForms';
import type { TestModule } from './module';

const MAGMA: SignatureSpec = { id: 'magmaBomb' };
const FAR: RuleSpec = { id: 'farThrow', every: 4 };
const VOLCANO: RuleSpec = { id: 'volcano', periodSec: 3, radiusMult: 3, damageMult: 5 };
const CHAIN_BLAST: RuleSpec = { id: 'chainBlast', radius: 40, damagePct: 0.5, perBomb: 2 };

describe('lob forms', () => {
  it('leave the lob params neutral without a form, and set one member each', () => {
    const neutral = { farThrowEvery: 0, volcano: null, chainBlast: null, zone: { slow: 0 } };
    expect(compileBuild(makeStats(), [], MAGMA).signature.lob).toEqual(neutral);
    expect(compileBuild(makeStats(), [FAR], MAGMA).signature.lob).toEqual({
      ...neutral,
      farThrowEvery: 4,
    });
    expect(compileBuild(makeStats(), [VOLCANO], MAGMA).signature.lob).toEqual({
      ...neutral,
      volcano: { periodSec: 3, radiusMult: 3, damageMult: 5 },
    });
    expect(compileBuild(makeStats(), [CHAIN_BLAST], MAGMA).signature.lob).toMatchObject({
      ...neutral,
      chainBlast: { radius: 40, damagePct: 0.5, perBomb: 2 },
    });
  });

  it('merge their instances: 遠投 the smallest every, 火山 and 連環爆 the first instance', () => {
    const rules: RuleSpec[] = [
      { id: 'farThrow', every: 6 },
      { id: 'volcano', periodSec: 2, radiusMult: 4, damageMult: 6 },
      { id: 'chainBlast', radius: 30, damagePct: 0.25, perBomb: 3 },
      { id: 'farThrow', every: 3 },
      VOLCANO,
      CHAIN_BLAST,
      { id: 'farThrow', every: 5 },
    ];
    const build = compileBuild(makeStats(), rules, MAGMA);
    expect(build.signature.lob).toMatchObject({
      farThrowEvery: 3,
      volcano: { periodSec: 2, radiusMult: 4, damageMult: 6 },
      chainBlast: { radius: 30, damagePct: 0.25, perBomb: 3 },
    });
    // One explode for the first instance, not one per instance.
    expect(build.effects.map((fx) => fx.spec)).toEqual([
      { kind: 'explode', radius: 30, damagePct: 0.25 },
    ]);
  });

  it.each([FAR, VOLCANO, CHAIN_BLAST])(
    "makes $id in a run of another signature a compile error naming that signature's id",
    (rule) => {
      expect(() => compileBuild(makeStats(), [rule])).toThrow(
        `rule '${rule.id}' tunes the magmaBomb signature, but this run's signature is 'm1Volley'`,
      );
      expect(() => compileBuild(makeStats(), [rule], MAGMA)).not.toThrow();
    },
  );

  it("names the run's signature from SignatureParams.id, which compileBuild sets", () => {
    let seen = '';
    const spy: TestModule = (b) => {
      seen = b.signature().id;
    };
    compileBuild(makeStats(), [], MAGMA, [spy]);
    expect(seen).toBe('magmaBomb');
    expect(compileBuild(makeStats(), [], MAGMA).signature.id).toBe('magmaBomb');
    expect(compileBuild(makeStats(), []).signature.id).toBe('m1Volley');
    // The error names SignatureParams.id: a magmaBomb run whose lob params a test module nulls
    // names itself.
    const noLob: TestModule = (b, source) => {
      b.signature().lob = null;
      farThrow.compile(b, [{ id: 'farThrow', every: 4 }], source);
    };
    expect(() => compileBuild(makeStats(), [], MAGMA, [noLob])).toThrow(
      "rule 'farThrow' tunes the magmaBomb signature, but this run's signature is 'magmaBomb'",
    );
  });

  it('compiles 連環爆 as an explode of 40 at 50%, hit, trigger and area, credited to the center', () => {
    const heal = centerTriggers([{ on: 'kill', do: [{ kind: 'heal', lifePct: 0.01 }] }]);
    const build = compileBuild(makeStats({ damage: 10 }, [], heal), [CHAIN_BLAST], MAGMA);
    const chainBlast = build.signature.lob?.chainBlast;
    expect(chainBlast).toBeDefined();
    // After the data trigger's effect.
    expect(chainBlast?.effect).toBe(1);
    const fx = build.effects[chainBlast?.effect ?? -1];
    expect(fx).toMatchObject({
      kind: 'explode',
      spec: { kind: 'explode', radius: 40, damagePct: 0.5 },
      source: 0,
      radiusSq: 1600,
      tags: TAG.hit | TAG.trigger | TAG.area,
    });
    expect(fx === undefined ? NaN : toNumber(fx.baseDamage)).toBe(5);
    // Its own trigger, after the build's data trigger: an entry that listens to no event.
    expect(chainBlast?.trigger).toBe(SHATTER_TRIGGER + 2);
    expect(build.triggers[SHATTER_TRIGGER + 2]).toEqual(moduleTrigger(SHATTER_TRIGGER + 2, 0));
    expect(build.triggers).toHaveLength(SHATTER_TRIGGER + 3);
    expect(Object.values(build.hooks).every((list) => list.length === 0)).toBe(true);
  });
});

describe('BuildCompiler.instanceTrigger (L3)', () => {
  it('takes the instance one trigger index, shared with its hooks, without adding a hook', () => {
    const seen: number[] = [];
    const tick = (): void => undefined;
    const first: TestModule = (b) => {
      seen.push(b.instanceTrigger(), b.instanceTrigger());
      seen.push(b.hook('tick', tick), b.hook('onKill', tick));
      seen.push(b.instanceTrigger());
    };
    const second: TestModule = (b) => {
      seen.push(b.hook('tick', tick), b.instanceTrigger());
    };
    const none: TestModule = () => undefined;
    const triggers = centerTriggers([{ on: 'kill', do: [{ kind: 'heal', lifePct: 0.01 }] }]);
    const build = compileBuild(makeStats({}, [], triggers), [], undefined, [first, none, second]);
    const T = SHATTER_TRIGGER + 2;
    expect(seen).toEqual([T, T, T, T, T, T + 1, T + 1]);
    expect(build.triggers.slice(T)).toEqual([moduleTrigger(T, 0), moduleTrigger(T + 1, 0)]);
    expect(build.hookOwners.tick).toEqual([T, T + 1]);
    expect(build.hookOwners.onKill).toEqual([T]);
  });

  it('adds no hook and leaves an instance that never calls it without a trigger', () => {
    const lone: TestModule = (b) => void b.instanceTrigger();
    const build = compileBuild(makeStats(), [], undefined, [lone, () => undefined]);
    expect(build.triggers).toHaveLength(SHATTER_TRIGGER + 2);
    expect(Object.values(build.hooks).every((list) => list.length === 0)).toBe(true);
  });

  it('gives a test module its own source', () => {
    const outer = Object.assign((b: Parameters<TestModule>[0]) => void b.instanceTrigger(), {
      source: 'outer.fire',
    });
    const build = compileBuild(makeStats(), [], undefined, [outer]);
    expect(build.triggers[SHATTER_TRIGGER + 1]).toEqual(
      moduleTrigger(SHATTER_TRIGGER + 1, build.sources.index('outer.fire')),
    );
  });
});
