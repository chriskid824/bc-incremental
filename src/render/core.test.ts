import type { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { DOCK_SLOTS, EMPTY_MS } from './constructs/hive';
import { HiveCoreView } from './core';
import type { CoreView } from './core';
import { PlayerView } from './player';

const player = { x: 960, y: 540, life: 100, maxLife: 100, shield: 0 };

/** The drawn alpha of the hive's six outer comb cells. */
function cellAlphas(core: HiveCoreView): number[] {
  const comb = core.view.getChildByLabel('comb', true) as Container;
  return comb.children.slice(1, 1 + DOCK_SLOTS).map((cell) => cell.alpha);
}

describe('HiveCoreView', () => {
  it("follows the player and sets the comb to the drone layer's docked share every frame", () => {
    const docks = { dockedShare: 1 };
    const core = new HiveCoreView(docks);
    core.update(player, 16);
    expect([core.view.x, core.view.y]).toEqual([960, 540]);
    expect(cellAlphas(core).every((alpha) => alpha === 1)).toBe(true);
    docks.dockedShare = 0;
    core.update(player, EMPTY_MS);
    for (const alpha of cellAlphas(core)) expect(alpha).toBeCloseTo(0.12, 9);
    docks.dockedShare = 2 / 3;
    core.update(player, EMPTY_MS);
    expect(cellAlphas(core).filter((alpha) => alpha < 0.5)).toHaveLength(2);
    core.reset();
    expect(cellAlphas(core).every((alpha) => alpha === 1)).toBe(true);
  });

  it('fades once the player has no life left, as the M1 hexagon does', () => {
    const core = new HiveCoreView({ dockedShare: 1 });
    core.update({ ...player, life: 0 }, 16);
    expect(core.view.alpha).toBeCloseTo(0.35, 9);
    core.update(player, 16);
    expect(core.view.alpha).toBe(1);
  });

  it('comes back to rest on reset: no swell carried into the next run', () => {
    const core = new HiveCoreView({ dockedShare: 1 });
    const hive = core.view.children[0] as Container;
    core.pulse();
    core.update(player, 0);
    expect(hive.scale.x).toBeCloseTo(1.08, 9);
    core.reset();
    core.update(player, 0);
    expect(hive.scale.x).toBe(1);
  });

  it('is a CoreView, as M1’s PlayerView is', () => {
    const views: CoreView[] = [new PlayerView(), new HiveCoreView({ dockedShare: 1 })];
    for (const view of views) {
      view.hit();
      view.pulse();
      view.update(player, 16);
      view.reset();
      expect(view.view.x).toBe(960);
    }
  });
});
