import { describe, expect, it } from 'vitest';
import { num } from '../../core/num';
import { assembleWeb, FULL_SCOPE, layoutWeb } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import { buy, emptyProgress } from '../../meta/web';
import type { AccountProgress, CharacterProgress } from '../../meta/web';
import { SHAPE_OF } from '../web/svg';
import { fixtureLookups } from '../web/testing';
import { webModel } from './model';
import { iconSvg, nodeColors, outerLabelAt, renderWeb } from './render';
import { SHAPE_IDS } from '../../data/web/types';

const web = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);
const layout = layoutWeb(web);
const account: AccountProgress = { singularityBeaten: false };
const zh = fixtureLookups()['zh-TW'];
const start: CharacterProgress = {
  ...emptyProgress('fire'),
  wallet: { shards: num(1e15), cores: 100, resonance: 0 },
};
const first = (web.neighbours.get(web.root) ?? [])[0] as string;
const owning = buy(web, start, account, first);

const count = (markup: string, pattern: RegExp): number => markup.match(pattern)?.length ?? 0;

describe('renderWeb (gd §3, §8 items 2, 9)', () => {
  it('draws each node in its kind’s shape with its state', () => {
    const model = webModel(web, layout, owning, account);
    const markup = renderWeb(web, model, { level: 1, scale: 0.4, lookup: zh });
    expect(count(markup, /class="v3p-node"/g)).toBe(model.nodes.length);
    for (const node of model.nodes.slice(0, 20)) {
      expect(markup).toContain(
        `data-id="${node.id}" data-state="${node.state}" data-kind="${node.kind}"`,
      );
    }
    expect(SHAPE_OF.keystone).toBe('star');
    expect(markup).toContain(`data-id="${first}" data-state=`);
  });

  it("rings the death review's suggested nodes (gd §8 item 8), but not a maxed one", () => {
    const model = webModel(web, layout, start, account);
    const other = (web.neighbours.get(web.root) ?? [])[1] as string;
    const markup = renderWeb(web, model, {
      level: 1,
      scale: 0.4,
      lookup: zh,
      suggested: new Set([first, other]),
    });
    expect(count(markup, /class="v3p-suggested"/g)).toBe(2);
    expect(markup).toContain(`data-id="${first}" data-state="buyable"`);
    expect(renderWeb(web, model, { level: 1, scale: 0.4, lookup: zh })).not.toContain(
      'v3p-suggested',
    );
  });

  it('draws hidden outers as 「？」 and collapsed ones with their name', () => {
    const model = webModel(web, layout, start, account);
    const markup = renderWeb(web, model, { level: 0, scale: 0.2, lookup: zh });
    expect(count(markup, /data-state="hidden"/g)).toBe(8);
    expect(markup).toContain('>？</text>');
    expect(markup).toContain('>暴擊</text>');
    expect(markup).toContain('data-outer="crit" data-state="collapsed"');
  });

  it('shows the spoke progress at every level, branch names from mid, node labels near', () => {
    const model = webModel(web, layout, owning, account);
    const far = renderWeb(web, model, { level: 0, scale: 0.2, lookup: zh });
    const mid = renderWeb(web, model, { level: 1, scale: 0.4, lookup: zh });
    const near = renderWeb(web, model, { level: 2, scale: 0.8, lookup: zh });
    for (const markup of [far, mid, near]) expect(markup).toContain('中心 1/8・暴擊 0/6');
    expect(far).not.toContain('>甲系</text>');
    expect(mid).toContain('>甲系</text>');
    expect(mid).not.toMatch(/>1\/\d<\/text>/);
    expect(near).toMatch(/>1\/\d<\/text>/);
  });

  it('sizes text in screen pixels whatever the level', () => {
    const model = webModel(web, layout, start, account);
    const at = (scale: number): string | undefined =>
      /font-size="([\d.]+)"/.exec(renderWeb(web, model, { level: 0, scale, lookup: zh }))?.[1];
    expect(Number(at(0.2))).toBeCloseTo(Number(at(0.4)) * 2, 0);
  });

  it('outlines a planned path', () => {
    const model = webModel(web, layout, start, account);
    const markup = renderWeb(web, model, {
      level: 1,
      scale: 0.4,
      lookup: zh,
      path: new Set([first]),
    });
    expect(count(markup, /data-path="true"/g)).toBe(1);
  });

  it('fills an owned node with its board’s colour and outlines a buyable one in it', () => {
    const model = webModel(web, layout, owning, account);
    const owned = model.nodes.find((node) => node.id === first);
    const buyable = model.nodes.find((node) => node.state === 'buyable');
    if (owned === undefined || buyable === undefined) throw new Error('no node');
    expect(nodeColors(web, owned).fill).toBe(`#${web.def.color.toString(16).padStart(6, '0')}`);
    expect(nodeColors(web, buyable).fill).not.toBe(nodeColors(web, buyable).stroke);
  });

  it('puts an open outer’s name beyond its board and draws every skin icon', () => {
    const model = webModel(web, layout, start, account, new Set(['crit']));
    const crit = model.outers.find((outer) => outer.outer === 'crit');
    if (crit === undefined) throw new Error('no crit');
    const label = outerLabelAt(crit, 0.4);
    expect(Math.hypot(label.x, label.y)).toBeGreaterThan(Math.hypot(crit.circle.x, crit.circle.y));
    for (const shape of SHAPE_IDS)
      expect(iconSvg(shape, 10, '#fff')).toMatch(/^<(path|circle|rect)/);
  });
});
