/**
 * Browser entry point: creates the PixiJS application, loads game data, and wires the session,
 * renderer, DOM overlay and game loop together.
 */

import { Application } from 'pixi.js';
import { loadGameData } from '../data';
import { createMetaState } from '../meta';
import { MAX_RUN_SECONDS, TICK_RATE } from '../sim';
import { Renderer } from '../render';
import { Hud } from '../ui/hud';
import type { HudInfo } from '../ui/hud';
import { ResultPanel } from '../ui/result';
import type { ResultInfo } from '../ui/result';
import { STRINGS, fill } from '../ui/strings';
import { injectStyle } from '../ui/style';
import { bindSpeedKeys } from './input';
import { GameLoop, SPEEDS } from './loop';
import type { Speed } from './loop';
import { Session } from './session';
import type { ActiveRun, RunReport } from './session';

/** Becomes a settings toggle later (docs/ARCHITECTURE.md §10). */
const REDUCED_MOTION = false;

async function main(root: HTMLElement): Promise<void> {
  injectStyle(document);

  const app = new Application();
  await app.init({
    resizeTo: window,
    background: 0x0b0d12,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio,
  });
  root.appendChild(app.canvas);

  const data = loadGameData();
  const meta = createMetaState();
  const renderer = new Renderer(app, data, { reducedMotion: REDUCED_MOTION });

  const setSpeed = (speed: Speed): void => {
    loop.speed = speed;
  };
  const hud = new Hud(document, SPEEDS, setSpeed);
  const results = new ResultPanel(document, () => session.skipResults());
  root.append(hud.root, results.root);

  const session = new Session(data, meta, {
    runStarted(run) {
      renderer.beginRun(run.typicalHit);
      results.hide();
      loop.resetClock();
    },
    runFinished(report) {
      results.show(toResultInfo(report));
      results.setTimeLeft(session.resultTimeLeftMs);
    },
  });

  const loop = new GameLoop({
    isRunning: () => session.phase === 'running',
    step: () => renderer.handleEvents(session.step()),
    frame: (alpha, elapsedMs, speed) => {
      session.update(elapsedMs);
      const run = session.run;
      renderer.render(run.sim.state, alpha, elapsedMs);
      hud.update(toHudInfo(run, speed));
      if (session.phase === 'results') results.setTimeLeft(session.resultTimeLeftMs);
    },
  });

  bindSpeedKeys(window, setSpeed);
  session.start();
  app.ticker.add((ticker) => loop.tick(ticker.elapsedMS));
}

function toHudInfo(run: ActiveRun, speed: number): HudInfo {
  const state = run.sim.state;
  return {
    runNumber: run.number,
    startWave: run.config.startWave,
    wave: state.wave,
    life: state.player.life,
    maxLife: state.player.maxLife,
    shards: state.shards,
    cores: state.cores,
    elapsedSec: state.tick / TICK_RATE,
    limitSec: (run.config.maxTicks ?? MAX_RUN_SECONDS * TICK_RATE) / TICK_RATE,
    speed,
  };
}

function toResultInfo(report: RunReport): ResultInfo {
  const { result, settlement } = report;
  return {
    runNumber: report.run.number,
    endReason: result.endReason,
    startWave: result.startWave,
    highestWave: result.highestWaveReached,
    kills: result.kills,
    shardsFromRun: settlement.shardsFromRun,
    coresFromRun: settlement.coresFromRun,
    clearedStartWave: result.clearedStartWave,
    skipShards: settlement.skipShards,
    skipCores: settlement.skipCores,
    purchases: report.purchases,
  };
}

function showFatal(root: HTMLElement, error: unknown): void {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const box = document.createElement('div');
  box.className = 'bc-error';
  box.textContent = fill(STRINGS.error.init, { message });
  root.replaceChildren(box);
}

const root = document.getElementById('app');
if (root === null) throw new Error('Missing #app element');
main(root).catch((error: unknown) => showFatal(root, error));
