/**
 * The replay's core (docs/v3 C10 design §1.7): a ReplayBuild resolved to its web, progress and
 * run (resolveReplayBuild, which B5's dev start options share), ReplayRun, which plays a spec's
 * run into a view, and rendererView, the view on the game's renderer. A run is seeded and
 * fixed-step, the view draws its effects from a RenderRandom seeded by renderSeedOf at every
 * restart, and a restart re-creates the run from its spec: so in step mode a frame is a function
 * of (build, seed, wave, tick). DOM-free, so the tests reach it; replay.ts gives it a canvas.
 */

import { add } from '../../core/num';
import { createRng, deriveSeed } from '../../core/rng';
import { characterGameData } from '../../data';
import type { CharacterId, OuterId } from '../../data/sources';
import { assembleWeb, loadContent, SCOPES } from '../../data/web';
import type { AssembledWeb, Content, WebScope } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import {
  buy,
  canBuy,
  defaultProgress,
  nextPrice,
  progressFromOrder,
  unlockInvestment,
  webBuild,
  webRunConfig,
} from '../../meta/web';
import type { AccountProgress, CharacterProgress } from '../../meta/web';
import type { RenderRandom } from '../../render/random';
import { createSimulation, NO_INPUT, TICK_RATE } from '../../sim';
import type { SimEvent, SimState, Simulation } from '../../sim';
import type { TestModule } from '../../sim/rules';
import type { RunContext } from '../../sim/systems/context';
import { typicalHitOf } from '../typicalHit';
import { renderStressSetup } from './presets';
import type { ReplayBuild, ReplaySpec, ResolvedBuild, RunSetup } from './types';

/** A replay's account: 奇點 not beaten, as a fresh save's. */
export const REPLAY_ACCOUNT: AccountProgress = { singularityBeaten: false };

/** The run of `progress` on `web`, on the v3 game data (characterGameData). */
function webSetup(web: AssembledWeb, progress: CharacterProgress): RunSetup {
  const run = webBuild(web, progress);
  const waveCap = web.scope.waveCap ?? undefined;
  return {
    data: characterGameData(),
    testModules: [],
    config: (seed, startWave) => webRunConfig(run, seed, startWave, waveCap),
  };
}

/**
 * `id` bought on `progress` as the audits buy (src/meta/web/invest.ts): the wallet credited with
 * its price, then canBuy and buy, so only the rules and the gates refuse. Throws on a refusal.
 */
function auditPurchase(
  web: AssembledWeb,
  progress: CharacterProgress,
  id: string,
): CharacterProgress {
  const price = nextPrice(web, progress, id);
  const { wallet } = progress;
  const credited: CharacterProgress = {
    ...progress,
    wallet: {
      shards: add(wallet.shards, price.shards),
      cores: wallet.cores + price.cores,
      resonance: wallet.resonance + price.resonance,
    },
  };
  const check = canBuy(web, credited, REPLAY_ACCOUNT, id);
  if (!check.ok) throw new Error(`replay: '${id}' refused: ${check.reason}`);
  return buy(web, credited, REPLAY_ACCOUNT, id);
}

/** Fusion c.o's unlock investment (unlockInvestment) and its core. */
function fusionProgress(web: AssembledWeb, outer: OuterId): CharacterProgress {
  const core = web.fusions.get(outer)?.board.nodes.find((node) => node.kind === 'core');
  if (core === undefined) {
    throw new Error(`replay: fusion '${web.character}.${outer}' has no core in the web`);
  }
  return auditPurchase(web, unlockInvestment(web, REPLAY_ACCOUNT, outer), core.id);
}

/** A web build's purchases on `web`. */
function progressOf(
  web: AssembledWeb,
  build: Exclude<ReplayBuild, { readonly kind: 'preset' }>,
): CharacterProgress {
  switch (build.kind) {
    case 'web':
      return progressFromOrder(web, REPLAY_ACCOUNT, build.purchases);
    case 'default':
      return defaultProgress(web, REPLAY_ACCOUNT, build.count);
    case 'fusion':
      return fusionProgress(web, build.key.split('.')[1] as OuterId);
  }
}

/** A preset's run (presets.ts); it has neither web nor progress. */
const presetBuild = (): ResolvedBuild => ({ web: null, progress: null, run: renderStressSetup() });

/**
 * `build`'s web, progress and run in `scope` of `content`. Throws as assembleWeb,
 * progressFromOrder and unlockInvestment do: a character with no center (「製作中」), a refused
 * purchase, a fusion not in the web.
 */
export function resolveReplayBuild(
  build: ReplayBuild,
  content: Content,
  scope: WebScope,
): ResolvedBuild {
  if (build.kind === 'preset') return presetBuild();
  const character: CharacterId =
    build.kind === 'fusion' ? (build.key.split('.')[0] as CharacterId) : build.character;
  const web = assembleWeb(content, character, scope);
  const progress = progressOf(web, build);
  return { web, progress, run: webSetup(web, progress) };
}

/** A spec's build resolved: a preset loads no content; `fixture` is fixtureContent('B5'). */
export function resolveSpec(spec: ReplaySpec): ResolvedBuild {
  if (spec.build.kind === 'preset') return presetBuild();
  const name = spec.scope ?? 'full';
  const scope = SCOPES.find((s) => s.name === name);
  if (scope === undefined) throw new Error(`replay: no scope '${name}'`);
  const content = spec.content === 'fixture' ? fixtureContent('B5') : loadContent();
  return resolveReplayBuild(spec.build, content, scope);
}

/** The renderer's seed of a spec: its renderSeed, else deriveSeed(seed, 'render'). */
export const renderSeedOf = (spec: ReplaySpec): number =>
  spec.renderSeed ?? deriveSeed(spec.seed, 'render');

/** A RenderRandom on a stream of its own seeded with `seed`: each start of a replay's run gets one. */
export function replayRandom(seed: number): RenderRandom {
  const rng = createRng(seed);
  return () => rng.next();
}

/** What a replay draws into: the renderer (replay.ts), or a recording stub in the tests. */
export interface ReplayView {
  /** A run (re)starts: its typical hit (typicalHitOf) and the seed its effects draw from. */
  start(typicalHit: number, renderSeed: number): void;
  /** One tick's events. */
  events(events: readonly SimEvent[]): void;
  /** One frame of `state`, `frameMs` of effect time after the last. */
  frame(state: Readonly<SimState>, alpha: number, frameMs: number): void;
}

/** What rendererView asks of the game's renderer (src/render/renderer.ts' Renderer). */
export interface RestartingRenderer {
  /** beginRun, with the animation clocks and the number slots as a new renderer has them. */
  restart(typicalHit: number): void;
  handleEvents(events: readonly SimEvent[]): void;
  render(state: Readonly<SimState>, alpha: number, frameMs: number): void;
  destroy(): void;
}

/**
 * The game's renderer as a replay's view: one per replay, made by `make` at the first start with
 * a RenderRandom of the replay's own. Each start of the run (the first, a seek, a loop) hands it
 * a new stream seeded with renderSeed and restarts it (Renderer.restart: beginRun alone keeps the
 * animation clocks), so it draws what a new renderer draws without making the textures a new one
 * makes.
 */
export function rendererView(
  make: (random: RenderRandom) => RestartingRenderer,
): ReplayView & { destroy(): void } {
  let stream: RenderRandom | null = null;
  let renderer: RestartingRenderer | null = null;
  return {
    start(typicalHit, renderSeed) {
      renderer ??= make(() => (stream as RenderRandom)());
      // After the renderer is made, so each start's frames draw the stream from its first number.
      stream = replayRandom(renderSeed);
      renderer.restart(typicalHit);
    },
    events(events) {
      renderer?.handleEvents(events);
    },
    frame(state, alpha, frameMs) {
      renderer?.render(state, alpha, frameMs);
    },
    destroy() {
      renderer?.destroy();
      renderer = null;
    },
  };
}

/** The ms of effect time a step-mode frame of `frameTicks` ticks shows. */
export const frameMsOf = (frameTicks: number): number => (frameTicks * 1000) / TICK_RATE;

/** Alive enemies, summons and orbs: the readout's last line (readout.ts). */
export interface ReplayCounts {
  readonly alive: number;
  readonly summons: number;
  readonly orbs: number;
}

/**
 * A spec's run played into a view. A (re)start creates the run from its spec, simulates its
 * warm-up undrawn, re-seeds the view and shows tick 0; the clip then runs durationTicks ticks
 * (fewer if the run ends), and a looping one starts again, unless its run ended inside the
 * warm-up: that clip has no tick to show, so it holds tick 0 as one that does not loop. seek(t)
 * restarts and steps frames to t, so it equals stepping from the start.
 */
export class ReplayRun {
  private sim: Simulation;
  private ctx: RunContext | null = null;
  private tickValue = 0;
  /** The run ended inside its warm-up: a restart would show the same tick 0 again. */
  private endedInWarmup = false;

  constructor(
    private readonly spec: ReplaySpec,
    private readonly setup: RunSetup,
    private readonly view: ReplayView,
    private readonly onLoop: () => void = () => undefined,
  ) {
    this.sim = this.restart();
  }

  /** Ticks since the clip's start, after the warm-up. */
  get tick(): number {
    return this.tickValue;
  }

  /** True once the clip has shown its ticks or its run has ended. */
  get over(): boolean {
    return this.tickValue >= this.spec.durationTicks || this.sim.state.finished;
  }

  /** Runs up to `ticks` ticks into the view; a looping clip restarts at its end, any other stops. */
  advance(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      if (this.over) {
        if (!this.spec.loop || this.endedInWarmup) return;
        this.sim = this.restart();
        this.onLoop();
      }
      this.view.events(this.sim.step(NO_INPUT));
      this.tickValue++;
    }
  }

  /** Draws the state, interpolated by `alpha`, `frameMs` of effect time after the last frame. */
  draw(alpha: number, frameMs: number): void {
    this.view.frame(this.sim.state, alpha, frameMs);
  }

  /** `frames` step-mode frames of `frameTicks` ticks each, each drawn at frameMsOf(frameTicks). */
  stepFrames(frames: number, frameTicks: number): void {
    for (let f = 0; f < frames; f++) {
      this.advance(frameTicks);
      this.draw(1, frameMsOf(frameTicks));
    }
  }

  /** Restarts and steps to `tick`: whole frames of `frameTicks`, then one of the rest. */
  seek(tick: number, frameTicks: number): void {
    this.sim = this.restart();
    const target = Math.max(0, Math.floor(tick));
    const frames = Math.floor(target / frameTicks);
    this.stepFrames(frames, frameTicks);
    const rest = target - frames * frameTicks;
    if (rest > 0) {
      this.advance(rest);
      this.draw(1, frameMsOf(rest));
    }
  }

  counts(): ReplayCounts {
    let alive = 0;
    for (const enemy of this.sim.state.enemies) if (enemy.alive) alive++;
    let orbs = 0;
    for (const em of this.ctx?.emitters ?? []) {
      if (em.spec.kind === 'orbit') orbs += em.orbs?.n ?? 0;
    }
    return { alive, summons: this.sim.state.droneCount, orbs };
  }

  /** A new run of the spec, its warm-up simulated undrawn, shown at tick 0 on a re-seeded view. */
  private restart(): Simulation {
    const { spec, setup } = this;
    const config = setup.config(spec.seed, spec.startWave);
    // Reads the run's emitters for counts(); it hooks a tick and changes nothing.
    const probe: TestModule = (b) => {
      b.hook('tick', (ctx) => {
        this.ctx = ctx;
      });
    };
    this.ctx = null;
    const sim = createSimulation(config, setup.data, [...setup.testModules, probe]);
    for (let i = 0; i < spec.warmupTicks && !sim.state.finished; i++) sim.step(NO_INPUT);
    this.endedInWarmup = sim.state.finished;
    this.tickValue = 0;
    this.view.start(typicalHitOf(config), renderSeedOf(spec));
    this.view.frame(sim.state, 1, 0);
    return sim;
  }
}
