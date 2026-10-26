import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveSeed } from '../../core/rng';
import { assembleWeb, FULL_SCOPE } from '../../data/web';
import type { Content } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import { GATED_KINDS } from '../../meta/web/counts';
import type { RenderRandom } from '../../render/random';
import { createSimulation, NO_INPUT } from '../../sim';
import type { SimEvent, SimState } from '../../sim';
import { createRunHash } from '../../sim/testing';
import { typicalHitOf } from '../typicalHit';
import {
  frameMsOf,
  rendererView,
  renderSeedOf,
  replayRandom,
  ReplayRun,
  resolveReplayBuild,
  resolveSpec,
} from './build';
import type { ReplayView, RestartingRenderer } from './build';
import { fusionClipSpec, previewSpec, renderStressSpec } from './specs';
import type { ReplaySpec } from './types';

/** What a view saw: each start, each tick's events and each frame, in order. */
type Seen =
  | readonly ['start', number, number]
  | readonly ['events', string]
  | readonly ['frame', string, number, number];

/** The parts of a state a frame shows: tick, wave, enemies, projectiles, summons, zones. */
const stateKey = (state: Readonly<SimState>): string =>
  JSON.stringify([
    state.tick,
    state.wave,
    state.enemies.map((e) => [e.id, e.x, e.y, e.hp, e.alive]),
    state.projectiles.map((p) => [p.id, p.x, p.y]),
    state.droneCount,
    state.shotCount,
    state.zoneCount,
  ]);

/** A view that records what a run shows it. */
class RecordingView implements ReplayView {
  readonly seen: Seen[] = [];
  start(typicalHit: number, renderSeed: number): void {
    this.seen.push(['start', typicalHit, renderSeed]);
  }
  events(events: readonly SimEvent[]): void {
    this.seen.push(['events', JSON.stringify(events)]);
  }
  frame(state: Readonly<SimState>, alpha: number, frameMs: number): void {
    this.seen.push(['frame', stateKey(state), alpha, frameMs]);
  }
  /** The hash of everything seen so far. */
  hash(): string {
    const hash = createRunHash();
    for (const entry of this.seen) hash.update(JSON.stringify(entry));
    return hash.digest();
  }
  /** What it saw since its last start. */
  sinceStart(): Seen[] {
    const last = this.seen.map((entry) => entry[0]).lastIndexOf('start');
    return this.seen.slice(last);
  }
}

/**
 * 熔核's 霜焰 clip on the fixture content from wave 1: a character run with a fusion core, quick in
 * node, that lives through its 300 warm-up ticks and 900 more (the fixture's synthetic numbers end
 * the wall's own wave-18 run of it within 90 ticks, which would loop the clip).
 */
const SPEC = fusionClipSpec('fire.ice', { content: 'fixture', startWave: 1, durationTicks: 900 });

function replay(spec: ReplaySpec, onLoop?: () => void): { run: ReplayRun; view: RecordingView } {
  const view = new RecordingView();
  return { run: new ReplayRun(spec, resolveSpec(spec).run, view, onLoop), view };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the replay core (docs/v3 C10 design §1.7, OWN test 1)', () => {
  it('shows a spec the same way twice: equal hashes at ticks 60, 300 and 600', () => {
    const hashes = [Date.UTC(2026, 9, 27, 9), Date.UTC(2026, 9, 27, 21, 0, 0, 1)].map((time) => {
      // Two runs at two wall-clock times: nothing of the clock may reach a frame.
      vi.setSystemTime(time);
      const { run, view } = replay(SPEC);
      const at: string[] = [];
      for (const tick of [60, 300, 600]) {
        run.stepFrames(tick - run.tick, 1);
        expect(run.tick).toBe(tick);
        at.push(view.hash());
      }
      return at;
    });
    expect(hashes[1]).toEqual(hashes[0]);
    expect(new Set(hashes[0]).size).toBe(3);
  });

  it('seek(300) re-creates the run and steps to tick 300: it shows what stepping there shows', () => {
    const { run, view } = replay(SPEC);
    run.stepFrames(450, 1);
    vi.setSystemTime(Date.UTC(2026, 9, 28));
    run.seek(300, 1);
    expect(run.tick).toBe(300);
    const fresh = replay(SPEC);
    fresh.run.stepFrames(300, 1);
    expect(view.sinceStart()).toEqual(fresh.view.seen);
    // In step mode's frames of 2 ticks, an odd tick ends on a frame of 1.
    run.seek(301, 2);
    const odd = replay(SPEC);
    odd.run.stepFrames(150, 2);
    odd.run.advance(1);
    odd.run.draw(1, frameMsOf(1));
    expect(view.sinceStart()).toEqual(odd.view.seen);
  });

  it('simulates the warm-up undrawn: the view gets one start and one frame of its last tick', () => {
    const { run, view } = replay(SPEC);
    const config = resolveSpec(SPEC).run.config(SPEC.seed, SPEC.startWave);
    expect(run.tick).toBe(0);
    expect(view.seen.map((entry) => entry[0])).toEqual(['start', 'frame']);
    expect(view.seen[0]).toEqual(['start', typicalHitOf(config), renderSeedOf(SPEC)]);
    expect(view.seen[1]?.slice(2)).toEqual([1, 0]);
    expect(JSON.parse((view.seen[1] as readonly ['frame', string, number, number])[1])[0]).toBe(
      SPEC.warmupTicks,
    );
  });

  it('seeds the view with renderSeed, or deriveSeed(seed, render) without one', () => {
    expect(renderSeedOf(SPEC)).toBe(deriveSeed(SPEC.seed, 'render'));
    expect(renderSeedOf({ ...SPEC, renderSeed: 7 })).toBe(7);
    const { view } = replay({ ...SPEC, renderSeed: 7 });
    expect(view.seen[0]?.[2]).toBe(7);
    // Each start's stream: the same seed draws the same numbers again.
    const random = replayRandom(7);
    const first = [random(), random()];
    const again = replayRandom(7);
    expect([again(), again()]).toEqual(first);
    expect(replayRandom(8)()).not.toBe(first[0]);
  });

  it('steps frames of frameTicks ticks, each drawn at alpha 1 and frameMsOf(frameTicks)', () => {
    const { run, view } = replay(SPEC);
    run.stepFrames(3, 2);
    expect(run.tick).toBe(6);
    const shown = view.seen.slice(2);
    expect(shown.map((entry) => entry[0])).toEqual([
      ...['events', 'events', 'frame'],
      ...['events', 'events', 'frame'],
      ...['events', 'events', 'frame'],
    ]);
    expect(frameMsOf(2)).toBeCloseTo(1000 / 30, 9);
    for (const entry of shown.filter((e) => e[0] === 'frame')) {
      expect(entry.slice(2)).toEqual([1, frameMsOf(2)]);
    }
  });

  it('restarts a looping clip at its end with the same frames, and stops one that does not loop', () => {
    let loops = 0;
    const clip = { ...SPEC, durationTicks: 30 };
    const { run, view } = replay(clip, () => loops++);
    run.stepFrames(30, 1);
    const first = [...view.seen];
    expect([run.tick, run.over, loops]).toEqual([30, true, 0]);
    run.stepFrames(30, 1);
    expect([run.tick, loops]).toEqual([30, 1]);
    // The second loop shows what the first did: its start, its tick 0 and the same 30 frames.
    expect(view.seen).toHaveLength(2 * first.length);
    expect(view.sinceStart()).toEqual(first);

    const once = replay({ ...clip, loop: false });
    once.run.stepFrames(40, 1);
    expect(once.run.tick).toBe(30);
    expect(once.view.seen.filter((entry) => entry[0] === 'start')).toHaveLength(1);
  });

  it('holds a looping clip whose run ends inside its warm-up, as one that does not loop', () => {
    // The wall's wave-18 fire.ice run on the fixture ends within 90 ticks of its 300 warm-up
    // ticks, so 600 warm-up ticks hold all of it.
    let loops = 0;
    const clip = fusionClipSpec('fire.ice', { content: 'fixture', warmupTicks: 600 });
    const { run, view } = replay(clip, () => loops++);
    expect([run.tick, run.over]).toEqual([0, true]);
    run.stepFrames(30, 2);
    expect([run.tick, run.over, loops]).toEqual([0, true, 0]);
    // One start and its tick 0, then 30 frames of that same state: no restart, no event.
    expect(view.seen.map((entry) => entry[0])).toEqual([
      'start',
      ...Array<string>(31).fill('frame'),
    ]);
    expect(new Set(view.seen.slice(1).map((entry) => entry[1])).size).toBe(1);
    run.seek(40, 2);
    expect([run.tick, loops]).toEqual([0, 0]);
  });

  it('adds a probe that changes nothing: the clip’s events are the run’s own after its warm-up', () => {
    const { run, view } = replay(SPEC);
    run.advance(120);
    const setup = resolveSpec(SPEC).run;
    const sim = createSimulation(
      setup.config(SPEC.seed, SPEC.startWave),
      setup.data,
      setup.testModules,
    );
    for (let i = 0; i < SPEC.warmupTicks; i++) sim.step(NO_INPUT);
    const own: string[] = [];
    for (let i = 0; i < 120; i++) own.push(JSON.stringify(sim.step(NO_INPUT)));
    expect(view.seen.filter((entry) => entry[0] === 'events').map((entry) => entry[1])).toEqual(
      own,
    );
  });

  it('counts renderStress’s alive, its 32 summons and its 8 orbs', () => {
    const spec = renderStressSpec({ warmupTicks: 60 });
    const { run } = replay(spec);
    const counts = run.counts();
    expect([counts.summons, counts.orbs]).toEqual([32, 8]);
    expect(counts.alive).toBeGreaterThan(0);
  });
});

/**
 * A renderer that records what the view asks of it, and the numbers its frames' effects draw
 * from the RenderRandom it was made with, one list per restart. It has a beginRun, as the game's
 * renderer has, which the view must not call alone.
 */
class StubRenderer implements RestartingRenderer {
  readonly calls: string[] = [];
  readonly drawn: number[][] = [];
  constructor(private readonly random: RenderRandom) {}
  beginRun(typicalHit: number): void {
    this.calls.push(`beginRun ${typicalHit}`);
  }
  restart(typicalHit: number): void {
    this.calls.push(`restart ${typicalHit}`);
    this.drawn.push([]);
  }
  handleEvents(): void {}
  render(): void {
    this.drawn[this.drawn.length - 1]?.push(this.random());
  }
  destroy(): void {
    this.calls.push('destroy');
  }
}

describe('the renderer view (Renderer.restart, docs/v3 C10 design §1.7)', () => {
  it('makes one renderer and restarts it at each start, its effects on a new stream of renderSeed', () => {
    const made: StubRenderer[] = [];
    const view = rendererView((random) => {
      const renderer = new StubRenderer(random);
      made.push(renderer);
      return renderer;
    });
    const clip = { ...SPEC, durationTicks: 30, renderSeed: 7 };
    const run = new ReplayRun(clip, resolveSpec(clip).run, view);
    // The first start's frame and 30 more; a seek's frame and 10 more, then 20 to the clip's end;
    // the loop's start and its first 5 frames.
    run.stepFrames(30, 1);
    run.seek(10, 1);
    run.stepFrames(25, 1);
    expect(made).toHaveLength(1);
    const hit = typicalHitOf(resolveSpec(clip).run.config(clip.seed, clip.startWave));
    expect(made[0]?.calls).toEqual([`restart ${hit}`, `restart ${hit}`, `restart ${hit}`]);
    // Each start's frames draw a new stream seeded with renderSeed from its first number.
    const random = replayRandom(7);
    const stream = Array.from({ length: 31 }, () => random());
    expect(made[0]?.drawn).toEqual([stream, stream, stream.slice(0, 6)]);
    view.destroy();
    expect(made[0]?.calls.at(-1)).toBe('destroy');
  });
});

/**
 * `content` with a defaultOrder for 熔核, whose fixture has none (F26): its center's first 12
 * nodes breadth-first from the root, never a gated kind.
 */
function withDefaultOrder(content: Content): Content {
  const web = assembleWeb(content, 'fire', FULL_SCOPE);
  const order: string[] = [];
  const seen = new Set([web.root]);
  for (let level = [web.root]; level.length > 0 && order.length < 12;) {
    const next: string[] = [];
    for (const id of level) {
      for (const other of web.neighbours.get(id) ?? []) {
        const node = web.byId.get(other);
        if (seen.has(other) || node === undefined) continue;
        if (node.board !== 'fire.center' || GATED_KINDS.has(node.kind)) continue;
        seen.add(other);
        next.push(other);
      }
    }
    order.push(...next);
    level = next;
  }
  const fire = { ...content.characters.fire, defaultOrder: order.slice(0, 12) };
  return { ...content, characters: { ...content.characters, fire } };
}

describe('resolveReplayBuild (docs/v3 C10 design §1.7; B5’s dev start options)', () => {
  const content = fixtureContent('B5');

  it('resolves purchases in order, a default prefix and a fusion’s unlock and core', () => {
    const ordered = withDefaultOrder(content);
    const order = ordered.characters.fire.defaultOrder;
    expect(order).toHaveLength(12);
    const prefix = resolveReplayBuild(
      { kind: 'default', character: 'fire', count: 10 },
      ordered,
      FULL_SCOPE,
    );
    const web = resolveReplayBuild(
      { kind: 'web', character: 'fire', purchases: order.slice(0, 10) },
      ordered,
      FULL_SCOPE,
    );
    expect(Object.keys(web.progress?.ranks ?? {}).length).toBeGreaterThanOrEqual(10);
    expect(prefix.progress?.ranks).toEqual(web.progress?.ranks);
    // Without a count, all of it; the fixture's own empty defaultOrder buys nothing.
    const all = resolveReplayBuild({ kind: 'default', character: 'fire' }, ordered, FULL_SCOPE);
    expect(all.progress?.ranks).toEqual(
      resolveReplayBuild({ kind: 'web', character: 'fire', purchases: order }, ordered, FULL_SCOPE)
        .progress?.ranks,
    );
    expect(
      resolveReplayBuild({ kind: 'default', character: 'fire', count: 10 }, content, FULL_SCOPE)
        .progress?.ranks,
    ).toEqual(
      resolveReplayBuild({ kind: 'web', character: 'fire', purchases: [] }, content, FULL_SCOPE)
        .progress?.ranks,
    );

    const fusion = resolveReplayBuild({ kind: 'fusion', key: 'fire.ice' }, content, FULL_SCOPE);
    const core = fusion.web?.fusions.get('ice')?.board.nodes.find((node) => node.kind === 'core');
    expect(core).toBeDefined();
    expect(fusion.progress?.ranks[core?.id ?? '']).toBe(1);
    expect(fusion.run.config(3, 18)).toMatchObject({ seed: 3, startWave: 18 });
    expect(fusion.run.config(3, 18).character?.id).toBe('fire');
  });

  it('runs a preset on its own data, and refuses a character with no center (製作中)', () => {
    const preset = resolveReplayBuild({ kind: 'preset', id: 'renderStress' }, content, FULL_SCOPE);
    expect([preset.web, preset.progress]).toEqual([null, null]);
    expect(preset.run.testModules).toHaveLength(4);
    expect(() => resolveSpec(previewSpec('fire'))).toThrow(/製作中/);
    expect(resolveSpec(fusionClipSpec('ice.fire', { content: 'fixture' })).web?.character).toBe(
      'ice',
    );
  });
});
