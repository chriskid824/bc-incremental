/**
 * Dev-only reference sheet of the four character constructs (docs/v3/game-design-v3.md §11.3,
 * §11.8), served by `npm run dev` at /sheet.html and captured to PNGs by tools/sheets/capture.ts.
 * Each construct is shown idle and attacking toward the right at 3×, and idle at 1× (arena
 * units, as in game) next to two enemy outlines for scale. Poses are frozen at fixed times so
 * captures are repeatable; add `?live` to the URL to watch them animate instead.
 *
 * The text here is for the developer and the capsule artist, not players, so it is plain
 * English and Traditional Chinese literals rather than i18n keys.
 */

import { Application, Container, Graphics } from 'pixi.js';
import { CONSTRUCT_COLORS } from '../render/palette';
import { createConstructView } from '../render/constructs';
import type { ConstructId, ConstructView } from '../render/constructs';

const BIG = 3;
/** Idle poses are frozen this far into the idle loop. */
const IDLE_MS = 2000;
/** Frame step used to advance the views to a pose. */
const STEP_MS = 16;
/** Live mode repeats the attack this often. */
const LIVE_ATTACK_MS = 2200;
/** v3 enemies: white-gray outlines with a faint fill (§11.6). */
const ENEMY_COLOR = 0xc8ccd4;

interface Entry {
  readonly id: ConstructId;
  readonly name: string;
  readonly zh: string;
  readonly school: string;
  readonly build: string;
  readonly idle: string;
  readonly attack: string;
  /** Idle time for this construct's frozen idle pose. */
  readonly idleMs: number;
  /** Attack beats toward the right: [delay before the attack (ms)], then a final hold. */
  readonly beats: readonly number[];
  readonly holdMs: number;
}

const ENTRIES: readonly Entry[] = [
  {
    id: 'magmaCore',
    name: 'Magma Core',
    zh: '熔核',
    school: 'Fire · 火',
    build: 'Solid diamond hearth core; six semi-transparent trapezoid hearth plates around it.',
    idle: 'Plates breathe in and out; embers drift up.',
    attack: 'Plates facing the target swing open, heat escapes, the core flashes white.',
    idleMs: IDLE_MS,
    beats: [0],
    holdMs: 110,
  },
  {
    id: 'frostCrystal',
    name: 'Frost Crystal',
    zh: '霜晶',
    school: 'Ice · 冰',
    build: 'Solid pentagon core; seven asymmetric ice spikes of different lengths.',
    idle: 'Turns slowly; the spikes take turns stretching.',
    attack: 'Spikes facing the target shoot off; the stubs grow back within 0.3 s.',
    idleMs: IDLE_MS,
    beats: [0],
    holdMs: 95,
  },
  {
    id: 'teslaTower',
    name: 'Tesla Tower',
    zh: '雷塔',
    school: 'Lightning · 雷',
    build: 'No body: three coils with white tips on a radius-40 triangle, linked by arcs.',
    idle: 'Faint arcs between the coils flash at irregular times.',
    attack: 'The coil facing the target discharges; the formation then turns 120°.',
    idleMs: 1700,
    beats: [0],
    holdMs: 70,
  },
  {
    id: 'hive',
    name: 'Hive',
    zh: '蜂巢',
    school: 'Summon · 召喚',
    build:
      'Solid 7-cell honeycomb core; a docking ring of kite drones, nose out ' +
      '(six docks drawn; in game the build sets how many drones there are).',
    idle: 'Drones circle slowly on the docking ring.',
    attack: 'Drones leave the nest one by one; docks and comb cells empty behind them.',
    idleMs: IDLE_MS,
    beats: [0, 130, 100],
    holdMs: 70,
  },
];

interface Stage {
  readonly construct: ConstructView;
  readonly entry: Entry;
  readonly attacking: boolean;
  /** Live mode: time into the current attack cycle, and beats fired in it. */
  clockMs: number;
  fired: number;
}

function hex(color: number): string {
  return `#${color.toString(16).toUpperCase().padStart(6, '0')}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className !== '') el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function buildPage(root: HTMLElement): Map<string, HTMLElement> {
  const header = element('header', '');
  header.append(
    element('h1', '', 'Character constructs · 角色構造體'),
    element(
      'p',
      '',
      `Procedural PixiJS views (src/render/constructs), build ${__BUILD_ID__}. ` +
        '3× views are enlarged; 1× is in-game size in arena units (1920 × 1080). ' +
        'Core solid, outer parts semi-transparent (game-design-v3 §11.3).',
    ),
  );
  root.append(header);

  const cells = new Map<string, HTMLElement>();
  for (const entry of ENTRIES) {
    const row = element('section', 'row');
    row.dataset.construct = entry.id;
    const info = element('div', 'info');
    const swatch = element('div', 'swatch');
    const chip = element('span', '');
    const color = hex(CONSTRUCT_COLORS[entry.id].main);
    chip.style.background = color;
    swatch.append(chip, document.createTextNode(color));
    const notes = element('dl', '');
    notes.append(
      element('dt', '', entry.school),
      element('dd', '', entry.build),
      element('dt', '', 'Idle'),
      element('dd', '', entry.idle),
      element('dt', '', 'Attack'),
      element('dd', '', entry.attack),
    );
    info.append(element('h2', '', entry.name), element('div', 'zh', entry.zh), swatch, notes);
    row.append(info);
    for (const [pose, caption] of [
      ['idle', 'Idle · 待機 — 3×'],
      ['attack', 'Attack → · 攻擊 — 3×'],
      ['actual', '1× in game · 實際大小, with two enemies for scale'],
    ] as const) {
      const figure = element('figure', '');
      figure.dataset.pose = pose;
      figure.append(element('figcaption', '', caption));
      row.append(figure);
      cells.set(`${entry.id}:${pose}`, figure);
    }
    root.append(row);
  }
  return cells;
}

/** Advances a view by `ms` in frame-sized steps. */
function advance(view: ConstructView, ms: number): void {
  for (let t = 0; t < ms; t += STEP_MS) view.update(Math.min(STEP_MS, ms - t));
}

/** Plays the entry's attack beats toward the right (angle 0). */
function strike(view: ConstructView, entry: Entry): void {
  for (const delay of entry.beats) {
    advance(view, delay);
    view.attack(0);
  }
  advance(view, entry.holdMs);
}

/** Live mode: fires the stage's attack beats once per LIVE_ATTACK_MS cycle. */
function liveBeats(stage: Stage, dt: number): void {
  stage.clockMs += dt;
  if (stage.clockMs >= LIVE_ATTACK_MS) {
    stage.clockMs -= LIVE_ATTACK_MS;
    stage.fired = 0;
  }
  const { beats } = stage.entry;
  let at = 0;
  for (let i = 0; i <= stage.fired && i < beats.length; i++) at += beats[i] ?? 0;
  if (stage.fired < beats.length && stage.clockMs >= at) {
    stage.construct.attack(0);
    stage.fired++;
  }
}

function enemiesForScale(): Graphics {
  const g = new Graphics();
  g.regularPoly(-28, 0, 16, 3).fill({ color: ENEMY_COLOR, alpha: 0.08 });
  g.regularPoly(-28, 0, 16, 3).stroke({ width: 2, color: ENEMY_COLOR, alpha: 0.9 });
  g.regularPoly(28, 0, 20, 4, Math.PI / 4).fill({ color: ENEMY_COLOR, alpha: 0.08 });
  g.regularPoly(28, 0, 20, 4, Math.PI / 4).stroke({ width: 2, color: ENEMY_COLOR, alpha: 0.9 });
  return g;
}

async function main(root: HTMLElement): Promise<void> {
  const live = new URLSearchParams(window.location.search).has('live');
  const cells = buildPage(root);
  await document.fonts.ready;

  const app = new Application();
  await app.init({
    width: root.offsetWidth,
    height: root.offsetHeight,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio,
    preserveDrawingBuffer: true,
    autoStart: false,
  });
  root.append(app.canvas);

  const stages: Stage[] = [];
  const origin = root.getBoundingClientRect();
  for (const entry of ENTRIES) {
    for (const pose of ['idle', 'attack', 'actual'] as const) {
      const cell = cells.get(`${entry.id}:${pose}`);
      if (cell === undefined) continue;
      const rect = cell.getBoundingClientRect();
      const left = rect.left - origin.left;
      const top = rect.top - origin.top;
      const construct = createConstructView(entry.id);
      advance(construct, entry.idleMs);
      const holder = new Container({ label: `${entry.id}-${pose}` });
      holder.addChild(construct.view);
      // Center the idle silhouette in the cell; attack poses lean right, so their construct
      // sits left of center to leave room.
      const scale = pose === 'actual' ? 1 : BIG;
      const bounds = construct.view.getLocalBounds();
      const x =
        (pose === 'attack' ? left + 170 : left + rect.width / 2) -
        scale * (bounds.x + bounds.width / 2);
      const y =
        top +
        rect.height / 2 +
        (pose === 'actual' ? -30 : 6) -
        scale * (bounds.y + bounds.height / 2);
      construct.view.position.set(x, y);
      construct.view.scale.set(scale);
      if (pose === 'actual') {
        const enemies = enemiesForScale();
        enemies.position.set(left + rect.width / 2, top + rect.height / 2 + 70);
        holder.addChild(enemies);
      }
      app.stage.addChild(holder);
      const attacking = pose === 'attack';
      if (attacking && !live) strike(construct, entry);
      stages.push({ construct, entry, attacking, clockMs: 0, fired: 0 });
    }
  }

  if (!live) {
    app.render();
    document.documentElement.dataset.sheetReady = 'true';
    return;
  }

  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS, 100);
    for (const stage of stages) {
      if (stage.attacking) liveBeats(stage, dt);
      stage.construct.update(dt);
    }
  });
  app.start();
  document.documentElement.dataset.sheetReady = 'true';
}

const root = document.getElementById('sheet');
if (root !== null) void main(root);
