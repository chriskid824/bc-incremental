/**
 * The enemies' drawers and views (docs/v3 C7 design §2.9). Its OWN test 1: a hull for every
 * EnemyShape, a symbol for every affix, white geometry only (gd:703), and a view of every type and
 * every affix that builds and draws without an error. Then what the views read (§1.7): M1's
 * polygons and views as they always were, the scale of 增殖's children, the ward's shell until
 * wardBroken clears WARDED, 洋蔥's shells by layersLeft, the symbols by affix bit, 衝刺者's red
 * while CHARGING, 寶藏怪's glow and the shield and facing turned to the center. 守護's ring is
 * drawn at the sim's own radius: the sim's module is mocked here with another GUARD_RADIUS, which
 * the ring must follow.
 */

import { Graphics, Texture } from 'pixi.js';
import type { Container } from 'pixi.js';
import type * as AffixesModule from '../sim/systems/affixes';
import { describe, expect, it, vi } from 'vitest';
import { num } from '../core/num';
import { characterGameData, loadGameData } from '../data';
import { AFFIX_GUARDIAN, AFFIX_IDS, AFFIX_SWIFT, AFFIX_WARD } from '../data/affixes';
import { V3_ENEMIES } from '../data/enemiesV3';
import { ENEMY_SHAPES } from '../data/schema';
import type { EnemyDef, GameData } from '../data/types';
import type { EnemyState, EnemyV3View } from '../sim';
import { GUARD_RADIUS, MULTIPLY_RADIUS } from '../sim/systems/affixes';
import {
  CHARGING,
  createEnemyV3,
  DASHING,
  FLEEING,
  ORBITING,
  SHIELDED,
  STOPPED,
  WARDED,
} from '../sim/systems/enemyRecord';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../sim/types';
import {
  AFFIX_SYMBOLS,
  bossRing,
  guardRing,
  HULLS,
  ONION_CORE,
  ONION_SHELLS,
  SYMBOL_SIZE,
  symbolRow,
} from './enemyShapes';
import { EnemyView, GLOW_FLEE_ALPHA, GLOW_REST_ALPHA, PULSE_AMPLITUDE } from './enemyView';
import { COLORS } from './palette';

interface EnemiesModule {
  readonly EnemyLayer: new (
    data: GameData,
    glow: Texture,
    random?: () => number,
  ) => {
    readonly burnGlow: { readonly particleChildren: readonly { scaleX: number }[] };
    update(
      enemies: readonly EnemyState[],
      alpha: number,
      dtMs: number,
      bursts: { flame(x: number, y: number, radius: number, heat: number): void },
    ): void;
    positionOf(id: number): { x: number; y: number; radius: number } | null;
  };
}

// A computed path: enemies.ts reads bursts.ts' types, which reach fxTextures.ts and the DOM that
// the tools' tsconfig (the tests') leaves out, as restart.test.ts loads it.
const ENEMIES = './enemies';
const { EnemyLayer } = (await import(/* @vite-ignore */ ENEMIES)) as EnemiesModule;

vi.mock('../sim/systems/affixes', async (importOriginal) => ({
  ...(await importOriginal<typeof AffixesModule>()),
  // Not the sim's 160: a ring drawn at a literal 160 would not follow it.
  GUARD_RADIUS: 197,
}));

/** A Graphics' instructions: fill or stroke, its style, and the path's actions and numbers. */
function drawn(g: Graphics): unknown[] {
  return g.context.instructions.map((instruction) => {
    const data = instruction.data as unknown as {
      style: { color: number; alpha: number; width?: number };
      path: { instructions: { action: string; data: unknown[] }[] };
    };
    return [
      instruction.action,
      data.style.color,
      data.style.alpha,
      data.style.width ?? null,
      data.path.instructions.map((op) => [
        op.action,
        ...op.data.filter((arg) => typeof arg === 'number' || typeof arg === 'boolean'),
      ]),
    ];
  });
}

/** M1's six types: every def but the v3 roster's (src/data/enemiesV3.ts). */
const M1_DEFS = Object.values(loadGameData().enemies).filter(
  (def) => !Object.hasOwn(V3_ENEMIES, def.id),
);

/** Every Graphics under `node`, depth first. */
function graphicsOf(node: Container): Graphics[] {
  return [
    ...(node instanceof Graphics ? [node] : []),
    ...node.children.flatMap((child) => graphicsOf(child)),
  ];
}

/** Every color a Graphics fills or strokes with. */
const colors = (g: Graphics): number[] =>
  g.context.instructions.map(
    (i) => (i.data as unknown as { style: { color: number } }).style.color,
  );

/** An enemy of `def` with a v3 record of `affixes` (null: an M1 run's), at (x, y). */
function enemyOf(
  def: EnemyDef,
  v3: Partial<EnemyV3View> | null = {},
  at: { x?: number; y?: number; radius?: number } = {},
): EnemyState {
  const x = at.x ?? 600;
  const y = at.y ?? 300;
  const record =
    v3 === null
      ? null
      : { ...createEnemyV3(def, undefined, 1, v3.affixes ?? 0, num(100), 0), ...v3 };
  return {
    id: 7,
    type: def.id,
    wave: 1,
    x,
    y,
    prevX: x,
    prevY: y,
    hp: num(50),
    maxHp: num(100),
    radius: at.radius ?? def.radius,
    burnStacks: 0,
    alive: true,
    v3: record,
  };
}

describe('the enemy drawers (docs/v3 C7 design §2.9, OWN test 1)', () => {
  it('has a hull for every EnemyShape and a symbol for every affix', () => {
    expect(Object.keys(HULLS).sort()).toEqual([...ENEMY_SHAPES].sort());
    expect(Object.keys(AFFIX_SYMBOLS).sort()).toEqual([...AFFIX_IDS].sort());
    for (const shape of ENEMY_SHAPES) {
      for (const boss of [false, true]) {
        expect(drawn(HULLS[shape](20, boss)).length, `${shape} boss ${boss}`).toBeGreaterThan(0);
      }
    }
    for (const id of AFFIX_IDS) {
      const g = new Graphics();
      AFFIX_SYMBOLS[id](g, SYMBOL_SIZE);
      expect(drawn(g).length, id).toBeGreaterThan(0);
    }
  });

  it('draws M1’s five polygons and the boss ring instruction for instruction as before', () => {
    // M1's hull as src/render/enemies.ts drew it before C7.8, from its SIDES.
    const before = (r: number, sides: number, boss: boolean): Graphics => {
      const g = new Graphics()
        .regularPoly(0, 0, r, sides)
        .fill({ color: 0x000000, alpha: 0.6 })
        .regularPoly(0, 0, r * 1.1, sides)
        .stroke({ width: 10, color: 0xffffff, alpha: 0.16 })
        .regularPoly(0, 0, r, sides)
        .fill({ color: 0xffffff, alpha: 0.28 })
        .stroke({ width: Math.max(3, r * 0.14), color: 0xffffff, alpha: 1 });
      if (!boss) g.regularPoly(0, 0, r * 0.38, sides).fill({ color: 0xffffff, alpha: 0.6 });
      return g;
    };
    const ring = (r: number, sides: number): Graphics =>
      new Graphics()
        .regularPoly(0, 0, r * 0.6, sides, Math.PI / sides)
        .fill({ color: 0xffffff, alpha: 0.25 })
        .stroke({ width: 4, color: 0xffffff, alpha: 0.9 })
        .regularPoly(0, 0, r * 0.25, sides)
        .fill({ color: 0xffffff, alpha: 0.85 });
    const sides = { triangle: 3, square: 4, pentagon: 5, hexagon: 6, octagon: 8 } as const;
    expect(M1_DEFS.map((def) => def.id)).toEqual([
      'triangle',
      'square',
      'pentagon',
      'shard',
      'hexagon',
      'boss',
    ]);
    for (const def of M1_DEFS) {
      const n = sides[def.shape as keyof typeof sides];
      expect(n, def.id).toBeDefined();
      expect(drawn(HULLS[def.shape](def.radius, def.boss)), def.id).toEqual(
        drawn(before(def.radius, n, def.boss)),
      );
      const inner = bossRing(def.shape, def.radius) as Graphics;
      expect(drawn(inner), def.id).toEqual(drawn(ring(def.radius, n)));
    }
    expect(bossRing('onion', 70)).toBeNull();
  });

  it('draws every affix symbol in white geometry, no color (gd:703)', () => {
    const row = symbolRow((1 << AFFIX_IDS.length) - 1);
    const symbols = graphicsOf(row);
    expect(symbols.map((g) => g.label)).toEqual([...AFFIX_IDS]);
    for (const g of symbols) {
      expect(new Set(colors(g)), g.label).toEqual(new Set([0xffffff]));
      expect(g.tint, g.label).toBe(0xffffff);
    }
    expect(row.tint).toBe(0xffffff);
  });

  it('draws 守護’s ring at the sim’s GUARD_RADIUS, whatever it is', () => {
    expect(GUARD_RADIUS).toBe(197);
    const bounds = guardRing().getLocalBounds();
    // The ring's line straddles the radius.
    expect((bounds.maxX - bounds.minX) / 2 - 1).toBeCloseTo(GUARD_RADIUS, 6);
  });

  it.each([
    ['M1', loadGameData()],
    ['v3', characterGameData()],
  ])(
    'builds and draws a view of every type of %s data, with each affix, without an error',
    (_, data) => {
      for (const def of Object.values(data.enemies)) {
        const records: (Partial<EnemyV3View> | null)[] = [
          null,
          {},
          ...AFFIX_IDS.map((_id, i) => ({ affixes: 1 << i })),
          { affixes: (1 << AFFIX_IDS.length) - 1 },
        ];
        for (const record of records) {
          const view = new EnemyView(def);
          const enemy = enemyOf(def, record);
          view.place(enemy);
          view.root.position.set(enemy.x, enemy.y);
          view.body.rotation = view.turn(enemy, 1.5);
          view.draw(enemy, 1.5);
          view.setHp(0.5);
          const parts = graphicsOf(view.root);
          expect(parts.length, def.id).toBeGreaterThan(0);
          for (const g of parts) expect(drawn(g).length, `${def.id} ${g.label}`).toBeGreaterThan(0);
          expect(view.tintOf(enemy), def.id).toBe(def.color);
        }
      }
    },
  );
});

const V3 = characterGameData().enemies;

/** A view of `enemy`'s type drawn for it at the layer's clock `seconds`, as EnemyLayer does. */
function shown(enemy: EnemyState, seconds = 1, view = new EnemyView(V3[enemy.type])): EnemyView {
  view.place(enemy);
  view.root.position.set(enemy.x, enemy.y);
  view.body.rotation = view.turn(enemy, seconds);
  view.draw(enemy, seconds);
  return view;
}

/** The root's part labelled `label`, or undefined. */
const part = (view: EnemyView, label: string): Container | undefined =>
  view.root.children.find((child) => child.label === label);

/** The labels of the symbols above the view, in their order. */
const symbolsOf = (view: EnemyView): string[] =>
  (part(view, 'affixes')?.children ?? []).map((child) => child.label);

/** The angle from (x, y) to the arena's center, where the player stands. */
const toCenter = (x: number, y: number): number =>
  Math.atan2(ARENA_HEIGHT / 2 - y, ARENA_WIDTH / 2 - x);

describe('what an enemy view reads (docs/v3 C7 design §1.7, §2.9)', () => {
  it('draws an M1 enemy part for part as before: no part of the record’s, at scale 1', () => {
    for (const def of M1_DEFS) {
      for (const record of [null, {}]) {
        const view = new EnemyView(def);
        for (const seconds of [0.5, 2.25, 7]) shown(enemyOf(def, record), seconds, view);
        const uids = (nodes: readonly (Container | null)[]): (number | undefined)[] =>
          nodes.map((node) => node?.uid);
        expect(uids(view.root.children), def.id).toEqual(
          uids(def.tough ? [view.body, view.hpBack, view.hpFill] : [view.body]),
        );
        expect(uids(view.body.children), def.id).toEqual(
          uids(def.boss ? [view.hull, view.inner] : [view.hull]),
        );
        expect([view.root.scale.x, view.root.scale.y, view.hull.scale.x], def.id).toEqual([
          1, 1, 1,
        ]);
        expect(view.radius, def.id).toBe(def.radius);
        expect(view.tintOf(enemyOf(def, record)), def.id).toBe(def.color);
      }
    }
  });

  it('scales 增殖’s children by enemy.radius / def.radius, its symbols and ring kept as they are', () => {
    const def = V3.hexagon;
    const radius = def.radius * MULTIPLY_RADIUS;
    const view = shown(enemyOf(def, { affixes: AFFIX_GUARDIAN | AFFIX_SWIFT }, { radius }));
    expect(view.radius).toBe(radius);
    expect(view.root.scale.x).toBeCloseTo(MULTIPLY_RADIUS, 12);
    expect(view.root.scale.y).toBeCloseTo(MULTIPLY_RADIUS, 12);
    const row = part(view, 'affixes') as Container;
    expect(row.scale.x * view.root.scale.x).toBeCloseTo(1, 12);
    // The ring is the sim's reach, not a share of the child's size.
    const guard = part(view, 'guard') as Container;
    expect(guard.scale.x * view.root.scale.x).toBeCloseTo(1, 12);
    // The symbols stay above the scaled hp bar.
    expect(row.y * view.root.scale.y).toBeLessThan(-(radius + 16));
    // A full-size elite after it, from the pool, draws at 1.
    shown(enemyOf(def, { affixes: AFFIX_SWIFT }), 1, view);
    expect([view.root.scale.x, view.radius]).toEqual([1, def.radius]);
  });

  it('re-fits a pooled view’s ring and symbols to each enemy’s scale, its affix bits the same', () => {
    // A guardian child back in the hexagon pool, then a full-size guardian elite from it, and back:
    // the bits match, so only place() can re-fit what the last enemy left at its own scale.
    const def = V3.hexagon;
    const bits = AFFIX_GUARDIAN | AFFIX_SWIFT;
    const child = enemyOf(def, { affixes: bits }, { radius: def.radius * MULTIPLY_RADIUS });
    const elite = enemyOf(def, { affixes: bits });
    const view = shown(child);
    for (const enemy of [elite, child, elite]) {
      shown(enemy, 1, view);
      const scale = view.root.scale.x;
      expect(scale).toBeCloseTo(enemy.radius / def.radius, 12);
      // The ring is the sim's reach at every scale.
      expect((part(view, 'guard') as Container).scale.x * scale).toBeCloseTo(1, 12);
      const row = part(view, 'affixes') as Container;
      expect(row.scale.x * scale).toBeCloseTo(1, 12);
      expect(row.y * scale).toBeLessThan(-(enemy.radius + 16));
      expect(symbolsOf(view)).toEqual(['swift', 'guardian']);
    }
  });

  it('shows 元素護盾’s shell while WARDED, and drops it once wardBroken clears the bit', () => {
    const def = V3.hexagon;
    const view = shown(enemyOf(def, { affixes: AFFIX_WARD, defence: WARDED }));
    expect(part(view, 'ward')?.visible).toBe(true);
    shown(enemyOf(def, { affixes: AFFIX_WARD, defence: 0 }), 1.1, view);
    expect(part(view, 'ward')?.visible).toBe(false);
    // An elite without the affix never has one.
    expect(part(shown(enemyOf(def, { affixes: AFFIX_SWIFT })), 'ward')).toBeUndefined();
  });

  it('draws 洋蔥’s shells from layersLeft, the outermost dropping first', () => {
    const def = V3.onion;
    expect(def.behaviour).toMatchObject({ kind: 'layers', layers: 3 });
    const view = new EnemyView(def);
    const shells = view.body.children.filter((child) => child.label === 'shell');
    expect(shells).toHaveLength(3);
    for (const [left, visible, backing] of [
      [3, [true, true, true], ONION_SHELLS[0]],
      [2, [false, true, true], ONION_SHELLS[1]],
      [1, [false, false, true], ONION_SHELLS[2]],
      [0, [false, false, false], ONION_CORE],
    ] as const) {
      shown(enemyOf(def, { layersLeft: left }), 1, view);
      expect(
        shells.map((shell) => shell.visible),
        `${left} left`,
      ).toEqual(visible);
      expect(view.hull.scale.x, `${left} left`).toBe(backing);
    }
    expect(view.body.children.find((child) => child.label === 'core')?.visible).toBe(true);
  });

  it('reads each affix’s symbol from its own bit, in AFFIX_IDS order, and rebuilds them as they change', () => {
    const def = V3.hexagon;
    const view = new EnemyView(def);
    AFFIX_IDS.forEach((id, i) => {
      expect(symbolsOf(shown(enemyOf(def, { affixes: 1 << i }), 1, view)), id).toEqual([id]);
    });
    const bits = (1 << 7) | (1 << 3) | (1 << 0);
    expect(symbolsOf(shown(enemyOf(def, { affixes: bits }), 1, view))).toEqual([
      AFFIX_IDS[0],
      AFFIX_IDS[3],
      AFFIX_IDS[7],
    ]);
    expect(symbolsOf(shown(enemyOf(def, { affixes: 0 }), 1, view))).toEqual([]);
    expect(part(view, 'affixes')).toBeUndefined();
  });

  it('rings 守護 alone, under its body', () => {
    const def = V3.hexagon;
    const view = shown(enemyOf(def, { affixes: AFFIX_GUARDIAN }));
    expect(view.root.children[0]?.label).toBe('guard');
    expect(view.root.children[0]?.visible).toBe(true);
    shown(enemyOf(def, { affixes: AFFIX_SWIFT }), 1, view);
    expect(part(view, 'guard')?.visible).toBe(false);
  });

  it('turns 衝刺者 red while it charges, and only then', () => {
    const def = V3.dasher;
    const tint = (state: number): number => new EnemyView(def).tintOf(enemyOf(def, { state }));
    expect(tint(0)).toBe(def.color);
    expect(tint(CHARGING | STOPPED)).toBe(COLORS.enemyCharge);
    expect(tint(DASHING)).toBe(def.color);
    expect(COLORS.enemyCharge).not.toBe(def.color);
  });

  it('glows 寶藏怪 in its own gold, brighter once it flees', () => {
    const def = V3.treasure;
    const glow = (state: number): number => {
      const view = shown(enemyOf(def, { state }), 2);
      expect(colors(part(view, 'glow') as Graphics)).toEqual([def.color, def.color]);
      return (part(view, 'glow') as Graphics).alpha;
    };
    expect(glow(FLEEING)).toBeCloseTo(glow(ORBITING) * GLOW_FLEE_ALPHA, 12);
    expect(glow(0)).toBe(glow(ORBITING));
    // Under Pixi's clamp at 1 at every shimmer phase, fleeing too: the brightening shows on screen.
    const alphas = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3].flatMap((seconds) =>
      [ORBITING, FLEEING].map(
        (state) => (part(shown(enemyOf(def, { state }), seconds), 'glow') as Graphics).alpha,
      ),
    );
    expect(Math.max(...alphas)).toBeLessThanOrEqual(1);
    expect(Math.min(...alphas)).toBeGreaterThan(0);
    expect(glow(ORBITING)).toBeLessThan(GLOW_REST_ALPHA * GLOW_FLEE_ALPHA);
  });

  it('turns 盾兵’s shield, 衝刺者 and 射手 to the center, and pulses 再生者', () => {
    const at = { x: 600, y: 300 };
    const shield = shown(enemyOf(V3.shielder, { defence: SHIELDED }, at));
    expect(part(shield, 'shield')?.visible).toBe(true);
    expect(part(shield, 'shield')?.rotation).toBeCloseTo(toCenter(at.x, at.y), 12);
    expect(part(shown(enemyOf(V3.square, {}, at)), 'shield')).toBeUndefined();
    for (const id of ['dasher', 'shooter'] as const) {
      expect(shown(enemyOf(V3[id], {}, at), 3.7).body.rotation, id).toBeCloseTo(
        toCenter(at.x, at.y),
        12,
      );
    }
    const pulses = [0.1, 0.3, 0.5, 0.7].map(
      (seconds) => shown(enemyOf(V3.regenerator, {}, at), seconds).hull.scale.x,
    );
    expect(new Set(pulses).size).toBe(pulses.length);
    for (const scale of pulses) expect(Math.abs(scale - 1)).toBeLessThanOrEqual(PULSE_AMPLITUDE);
  });
});

describe('EnemyLayer with 增殖’s children (docs/v3 C7 design §2.9: views by enemy.radius / def.radius)', () => {
  it('places, glows and burns a child at its own radius', () => {
    const def = V3.hexagon;
    const at = (radius: number) => {
      const layer = new EnemyLayer(characterGameData(), Texture.WHITE, () => 0.5);
      const flames: number[] = [];
      const bursts = {
        flame: (_x: number, _y: number, r: number) => void flames.push(r),
      };
      const enemy = { ...enemyOf(def, { affixes: AFFIX_SWIFT }, { radius }), burnStacks: 2 };
      layer.update([enemy], 1, 1000, bursts);
      const glow = layer.burnGlow.particleChildren[0] as { scaleX: number };
      return { spot: layer.positionOf(enemy.id)?.radius, glow: glow.scaleX, flames };
    };
    const full = at(def.radius);
    const child = at(def.radius * MULTIPLY_RADIUS);
    // The ward's pop and 洋蔥's ring read positionOf's radius.
    expect([full.spot, child.spot]).toEqual([def.radius, def.radius * MULTIPLY_RADIUS]);
    expect(child.glow / full.glow).toBeCloseTo(MULTIPLY_RADIUS, 12);
    expect(full.flames.length).toBeGreaterThan(0);
    expect(child.flames).toEqual(full.flames.map(() => def.radius * MULTIPLY_RADIUS));
  });
});
