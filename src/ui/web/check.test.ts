/**
 * check.ts (docs/v3 C6 design §4.8, S-3, F45): V17, V19 and V20 pass on the fixture in every
 * scope through its lookups, and each planted fault gives its message (D23's form).
 */

import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, OUTER_IDS } from '../../data/sources';
import { inc } from '../../data/templates';
import type { TriggerSpec } from '../../data/triggers';
import { assembleWeb, FULL_SCOPE, SCOPES, scopeHolds } from '../../data/web';
import type { AssembledWeb, FusionKey, WebNode } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import { getLocale, setLocale } from '../../i18n';
import type { Locale } from '../../i18n';
import { textIssues } from './check';
import { fixtureLookups, fixtureMessages } from './testing';

const content = fixtureContent();
const webs: AssembledWeb[] = SCOPES.flatMap((scope) =>
  CHARACTER_IDS.filter((c) => scopeHolds(scope.characters, c)).map((c) =>
    assembleWeb(content, c, scope),
  ),
);
const fire = webs[0] as AssembledWeb;
const summon = webs[3] as AssembledWeb;

type Patch = Partial<Record<Locale, Readonly<Record<string, string | null>>>>;

/** The fixture's messages with `patch` applied (null deletes a key), as lookups. */
function patched(patch: Patch) {
  const messages = fixtureMessages();
  for (const [locale, keys] of Object.entries(patch) as [Locale, Record<string, string | null>][]) {
    for (const [key, text] of Object.entries(keys)) {
      if (text === null) delete messages[locale][key];
      else messages[locale][key] = text;
    }
  }
  return fixtureLookups(messages);
}

const issuesWith = (patch: Patch, on: readonly AssembledWeb[] = [fire]): string[] =>
  textIssues(on, patched(patch));

const EN = 'src/i18n/web.en.json';
const ZH = 'src/i18n/web.zh-TW.json';

describe('textIssues on the fixture (§4.8, F45)', () => {
  it('passes every web of every scope', () => {
    expect(webs.map((web) => web.character)).toEqual([
      'fire',
      'ice',
      'lightning',
      'summon',
      'fire',
      'summon',
      'fire',
      'ice',
    ]);
    expect(textIssues(webs, fixtureLookups())).toEqual([]);
  });

  it('passes the shipped messages alone, and leaves the locale as it is', () => {
    setLocale('zh-TW');
    expect(textIssues([])).toEqual([]);
    expect(getLocale()).toBe('zh-TW');
    setLocale('en');
  });

  it('reports the shipped messages without the content keys on each key the content needs', () => {
    const issues = textIssues([fire]);
    expect(issues).toContain(
      "key 'web.fusion.fire.poison.title' is missing in src/i18n/web.en.json; npm run content -- --stubs writes a TODO stub for each missing key",
    );
    expect(issues).toContain(
      `key 'web.node.fire.center.main.star-one.desc' is missing in ${ZH}; npm run content -- --stubs writes a TODO stub for each missing key`,
    );
  });

  it("reads each locale's own merged messages by default (R6): only content keys are missing", () => {
    const issues = textIssues([fire]);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue).toMatch(
        /^key 'web\.[^']+' is missing in src\/i18n\/web\.(en|zh-TW)\.json; npm run content -- --stubs writes a TODO stub for each missing key$/,
      );
    }
  });

  it('passes every web of every scope with every fusion at coef 0.45 and at 2.3: recalibration needs no text edit (D22)', () => {
    const keys = CHARACTER_IDS.flatMap((c) =>
      OUTER_IDS.filter((o) => o !== c).map((o): FusionKey => `${c}.${o}`),
    );
    for (const coef of [0.45, 2.3]) {
      const coefs: Partial<Record<FusionKey, number>> = Object.fromEntries(
        keys.map((key) => [key, coef]),
      );
      const moved = SCOPES.flatMap((scope) =>
        CHARACTER_IDS.filter((c) => scopeHolds(scope.characters, c)).map((c) =>
          assembleWeb(content, c, scope, { coefs }),
        ),
      );
      const fusions = moved.flatMap((web) => [...web.fusions.values()]);
      expect(new Set(fusions.map((fusion) => fusion.coef))).toEqual(new Set([coef]));
      expect(textIssues(moved, fixtureLookups())).toEqual([]);
    }
  });
});

describe('V17', () => {
  it('reports a key the content needs, missing in one locale', () => {
    expect(issuesWith({ 'zh-TW': { 'web.node.fire.center.main.star-one.name': null } })).toEqual([
      `key 'web.node.fire.center.main.star-one.name' is missing in ${ZH}; npm run content -- --stubs writes a TODO stub for each missing key`,
    ]);
  });

  it("needs a hand core's description while its rule is not written yet", () => {
    // contentIssues refuses such content ('a hand-made fusion needs its rule'); V17 still asks.
    const key = 'web.node.fusion.fire.ice.core.desc';
    const nodes = fire.nodes.map((node): WebNode =>
      node.id === 'fusion.fire.ice.core'
        ? { ...node, effects: { ...node.effects, rules: [] } }
        : node,
    );
    const ruleless = { ...fire, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
    expect(issuesWith({ en: { [key]: null }, 'zh-TW': { [key]: null } }, [ruleless])).toEqual([
      `key '${key}' is missing in ${EN}; npm run content -- --stubs writes a TODO stub for each missing key`,
      `key '${key}' is missing in ${ZH}; npm run content -- --stubs writes a TODO stub for each missing key`,
    ]);
  });

  it('reports a web key in one locale only', () => {
    expect(issuesWith({ en: { 'web.answers.extra': 'Extra' } })).toEqual([
      `key 'web.answers.extra' is missing in ${ZH}; npm run content -- --stubs writes a TODO stub for each missing key`,
    ]);
  });

  it('reports an orphan web.node.* or web.fusion.* key in each locale holding it', () => {
    const both = (key: string) => ({ en: { [key]: 'x' }, 'zh-TW': { [key]: 'x' } });
    expect(issuesWith(both('web.node.outer.poison.alpha.alpha-uno.name'))).toEqual([
      `key 'web.node.outer.poison.alpha.alpha-uno.name' (${EN}): names no node or fusion of the content; did you mean 'web.node.outer.poison.alpha.alpha-one.name'?`,
      `key 'web.node.outer.poison.alpha.alpha-uno.name' (${ZH}): names no node or fusion of the content; did you mean 'web.node.outer.poison.alpha.alpha-one.name'?`,
    ]);
    expect(issuesWith({ en: { 'web.node.fire.center.alpha.r1.name': 'x' } })).toEqual([
      `key 'web.node.fire.center.alpha.r1.name' (${EN}): node 'fire.center.alpha.r1' is a ranked node, which text.ts names; remove it`,
    ]);
    expect(issuesWith(both('web.node.nothing'))).toContain(
      `key 'web.node.nothing' (${EN}): names no node or fusion of the content; remove it`,
    );
    expect(issuesWith(both('web.fusion.fire.fire.title'))).toHaveLength(2);
    expect(issuesWith(both('web.node.fire.center.main.star-one.blurb'))).toHaveLength(2);
  });

  it('reports a web.fusion.* key that is not a title', () => {
    const key = 'web.fusion.fire.poison.name';
    expect(issuesWith({ en: { [key]: 'x' }, 'zh-TW': { [key]: 'x' } })).toEqual([
      `key '${key}' (${EN}): names no node or fusion of the content; remove it`,
      `key '${key}' (${ZH}): names no node or fusion of the content; remove it`,
    ]);
  });

  it("reports a key on an ascendancy board its character's web does not have", () => {
    const key = 'web.node.fire.asc.old-path.n1.name';
    const issues = issuesWith({ en: { [key]: 'x' }, 'zh-TW': { [key]: 'x' } });
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue).toMatch(
        /^key 'web\.node\.fire\.asc\.old-path\.n1\.name' \(src\/i18n\/web\.(en|zh-TW)\.json\): names no node or fusion of the content; /,
      );
    }
  });

  it('reports the keys of an outer the content does not hold (absent, as after a cut)', () => {
    const outers = Object.fromEntries(
      Object.entries(content.outers).filter(([outer]) => outer !== 'greed'),
    );
    const cut = assembleWeb({ ...content, outers }, 'fire', FULL_SCOPE);
    const issues = textIssues([cut], fixtureLookups());
    for (const key of [
      'web.node.outer.greed.alpha.alpha-one.name',
      'web.fusion.fire.greed.title',
    ]) {
      expect(
        issues.filter(
          (issue) =>
            issue.startsWith(`key '${key}' (`) &&
            issue.includes('names no node or fusion of the content'),
        ),
      ).toHaveLength(2);
    }
  });

  it('leaves a key on a board no given web holds open to the webs that hold it', () => {
    const demo = webs.slice(4, 6);
    const key = 'web.node.outer.lightning.alpha.alpha-uno.name';
    expect(issuesWith({ en: { [key]: 'x' }, 'zh-TW': { [key]: 'x' } }, demo)).toEqual([]);
  });

  /** The statuses the webs `on` that list board `id` give it. */
  const statuses = (on: readonly AssembledWeb[], id: string) =>
    new Set(
      on.flatMap((web) => web.boards.filter((board) => board.id === id)).map((b) => b.status),
    );

  it('judges a key by the nodes of a board one given web holds open and another locked', () => {
    expect(statuses(webs, 'outer.lightning')).toEqual(new Set(['open', 'locked']));
    const key = 'web.node.outer.lightning.alpha.alpha-uno.name';
    expect(issuesWith({ en: { [key]: 'x' }, 'zh-TW': { [key]: 'x' } }, webs)).toEqual([
      `key '${key}' (${EN}): names no node or fusion of the content; did you mean 'web.node.outer.lightning.alpha.alpha-one.name'?`,
      `key '${key}' (${ZH}): names no node or fusion of the content; did you mean 'web.node.outer.lightning.alpha.alpha-one.name'?`,
    ]);
  });

  it("reports a cut outer's keys over every scope's webs, listed absent by one and locked by another", () => {
    const outers = Object.fromEntries(
      Object.entries(content.outers).filter(([outer]) => outer !== 'greed'),
    );
    const cut = { ...content, outers };
    const all = SCOPES.flatMap((scope) =>
      CHARACTER_IDS.filter((c) => scopeHolds(scope.characters, c)).map((c) =>
        assembleWeb(cut, c, scope),
      ),
    );
    expect(statuses(all, 'outer.greed')).toEqual(new Set(['absent', 'locked']));
    const issues = textIssues(all, fixtureLookups());
    for (const key of [
      'web.node.outer.greed.alpha.alpha-one.name',
      'web.fusion.fire.greed.title',
    ]) {
      expect(
        issues.filter(
          (issue) =>
            issue.startsWith(`key '${key}' (`) &&
            issue.includes('names no node or fusion of the content'),
        ),
      ).toHaveLength(2);
    }
  });

  it('reports a TODO stub', () => {
    expect(issuesWith({ en: { 'web.branch.fire.center.alpha': 'TODO' } })).toEqual([
      `key 'web.branch.fire.center.alpha' (${EN}): the text is a TODO stub; write it`,
    ]);
  });

  it('reports placeholders that differ between the locales', () => {
    const issues = issuesWith({ 'zh-TW': { 'web.answers': '答案：{enemy}' } });
    expect(issues[0]).toBe(
      `key 'web.answers' (${ZH}): placeholders {enemy} differ from en's {enemies}; use the same placeholders in both locales`,
    );
    // V19 then traces the hole to the key on every node with answers.
    expect(issues).toContain(
      "node 'outer.poison.main.counter' (zh-TW): the text has an unfilled {enemy}; check web.answers",
    );
    for (const issue of issues.slice(1)) {
      expect(issue).toMatch(
        /^node '[^']+' \(zh-TW\): the text has an unfilled \{enemy\}; check web\.answers$/,
      );
    }
  });

  it('reports a hand description whose numbers drift from the data', () => {
    const key = 'web.node.fusion.fire.ice.core.desc';
    expect(
      issuesWith({
        en: {
          [key]:
            'Every 4th shot is a guaranteed crit and the crit multiplier ×1.5; no random crits.',
        },
      }),
    ).toEqual([
      `key '${key}' (${EN}): does not quote 3; a hand description quotes every number of its node's rules, triggers and behaviour modifiers`,
    ]);
    expect(issuesWith({ 'zh-TW': { [key]: '每第 3 發必定暴擊；不會隨機暴擊。' } })).toEqual([
      `key '${key}' (${ZH}): does not quote ×1.5; a hand description quotes every number of its node's rules, triggers and behaviour modifiers`,
    ]);
  });

  /** `c`'s FULL_SCOPE web with its aura fusion (冰光, 雷光) at coef 2.3. */
  const aura = (c: 'ice' | 'lightning') =>
    assembleWeb(content, c, FULL_SCOPE, { coefs: { [`${c}.aura`]: 2.3 } });

  it("asks for a template core's bonus under coefScalesBonus as {bonus}: neither the data value nor the run's (D12)", () => {
    const key = 'web.node.fusion.ice.aura.core.desc';
    const ice = aura('ice');
    expect(ice.fusions.get('aura')?.coefScalesBonus).toBe(true);
    /** 冰光's description with its bonus written as `en` and `zh`. */
    const bonus = (en: string, zh: string): Patch => ({
      en: {
        [key]: `On each freeze, a 2 s pulse zone at the target; enemies in it take ${en} center damage. Every 3rd shot is a guaranteed crit and the crit multiplier ×1.5; no random crits.`,
      },
      'zh-TW': {
        [key]: `凍結時在目標留下 2 秒脈衝區，區內的敵人受到中心傷害${zh}；每第 3 發必定暴擊，暴擊倍率 ×1.5；不會隨機暴擊。`,
      },
    });
    expect(issuesWith(bonus('{bonus}', ' {bonus}'), [ice])).toEqual([]);
    expect(issuesWith(bonus('+20%', ' +20%'), [ice])).toEqual([
      `key '${key}' (${EN}): quotes +20%, which the fusion's coef scales; write {bonus} in its place`,
      `key '${key}' (${ZH}): quotes +20%, which the fusion's coef scales; write {bonus} in its place`,
    ]);
    expect(issuesWith(bonus('+46%', ' +46%'), [ice])).toEqual([
      `key '${key}' (${EN}): quotes +46%, which the fusion's coef scales; write {bonus} in its place`,
      `key '${key}' (${ZH}): quotes +46%, which the fusion's coef scales; write {bonus} in its place`,
    ]);
    expect(issuesWith(bonus('more', '更多'), [ice])).toEqual([
      `key '${key}' (${EN}): lacks {bonus}, which the fusion's coef scales; write it where the number goes`,
      `key '${key}' (${ZH}): lacks {bonus}, which the fusion's coef scales; write it where the number goes`,
    ]);
  });

  it('needs the bonus written out on a template core without coefScalesBonus, where it never moves (D12)', () => {
    const key = 'web.node.fusion.fire.poison.core.desc';
    const poison = assembleWeb(content, 'fire', FULL_SCOPE, { coefs: { 'fire.poison': 1.5 } });
    expect(poison.fusions.get('poison')?.coefScalesBonus).toBe(false);
    const desc = (bonus: string): Patch => {
      const text = `Each explosion: 2 poison stacks. Poisoned enemies take ${bonus} center damage. Burn kills spread the stacks at {effect}.`;
      return { en: { [key]: text }, 'zh-TW': { [key]: text } };
    };
    expect(issuesWith(desc('+20%'), [poison])).toEqual([]);
    expect(issuesWith(desc('{bonus}'), [poison])).toEqual([
      `key '${key}' (${EN}): does not quote +20%; a hand description quotes every number of its node's rules, triggers and behaviour modifiers`,
      `key '${key}' (${ZH}): does not quote +20%; a hand description quotes every number of its node's rules, triggers and behaviour modifiers`,
    ]);
  });

  it('keeps every other behaviour modifier of a template core under coefScalesBonus a literal (D12)', () => {
    const key = 'web.node.fusion.ice.aura.core.desc';
    const base = aura('ice');
    const extra = inc('damage', 0.1, { scope: 'center', when: [{ targetHas: 'frozen' }] });
    const nodes = base.nodes.map((node): WebNode =>
      node.id === 'fusion.ice.aura.core'
        ? { ...node, effects: { ...node.effects, modifiers: [...node.effects.modifiers, extra] } }
        : node,
    );
    const ice = { ...base, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
    expect(issuesWith({}, [ice])).toEqual([
      `key '${key}' (${EN}): does not quote +10%; a hand description quotes every number of its node's rules, triggers and behaviour modifiers`,
      `key '${key}' (${ZH}): does not quote +10%; a hand description quotes every number of its node's rules, triggers and behaviour modifiers`,
    ]);
    const text = fixtureMessages();
    const quoted: Patch = {
      en: { [key]: `${text.en[key]} Frozen enemies take +10% center damage.` },
      'zh-TW': { [key]: `${text['zh-TW'][key]}凍結的敵人受到中心傷害 +10%。` },
    };
    expect(issuesWith(quoted, [ice])).toEqual([]);
  });

  it("asks for chainJump's chance as {chance} on a fusion board, and for nothing off it (D11)", () => {
    const key = 'web.node.fusion.lightning.aura.core.desc';
    const lightning = aura('lightning');
    /** 雷光's description with its chance written as `en` and `zh`. */
    const jump = (en: string, zh: string): Patch => ({
      en: {
        [key]: `Each jump has ${en} to leave a 2 s pulse zone at the target; enemies in it take {bonus} center damage. Chain count ×2 and chain hits deal ×4.5 damage; chain retention −20 percentage points.`,
      },
      'zh-TW': {
        [key]: `每跳有${zh}機率在目標留下 2 秒脈衝區，區內的敵人受到中心傷害 {bonus}；連鎖次數 ×2，連鎖擊中的傷害 ×4.5；保留率 −20 個百分點。`,
      },
    });
    expect(issuesWith(jump('a {chance} chance', ' {chance} '), [lightning])).toEqual([]);
    expect(issuesWith(jump('a 30% chance', ' 30% '), [lightning])).toEqual([
      `key '${key}' (${EN}): quotes 30%, which the fusion's coef scales; write {chance} in its place`,
      `key '${key}' (${ZH}): quotes 30%, which the fusion's coef scales; write {chance} in its place`,
    ]);
    expect(issuesWith(jump('a 69% chance', ' 69% '), [lightning])).toEqual([
      `key '${key}' (${EN}): quotes 69%, which the fusion's coef scales; write {chance} in its place`,
      `key '${key}' (${ZH}): quotes 69%, which the fusion's coef scales; write {chance} in its place`,
    ]);
    expect(issuesWith(jump('a chance', ''), [lightning])).toEqual([
      `key '${key}' (${EN}): lacks {chance}, which the fusion's coef scales; write it where the number goes`,
      `key '${key}' (${ZH}): lacks {chance}, which the fusion's coef scales; write it where the number goes`,
    ]);
    // Off fusion boards the coef never moves it: a keystone's chainJump trigger asks for nothing.
    const star = 'lightning.center.main.star-one';
    const push: TriggerSpec = { on: 'chainJump', do: [{ kind: 'push', distance: 20, radius: 60 }] };
    const base = webs[2] as AssembledWeb;
    const nodes = base.nodes.map((node): WebNode =>
      node.id === star ? { ...node, effects: { ...node.effects, triggers: [push] } } : node,
    );
    const jumping = { ...base, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
    expect(issuesWith({}, [jumping])).toEqual([]);
  });
});

describe('V19', () => {
  it('reports an unfilled placeholder with the key that left it', () => {
    const issues = issuesWith({
      en: { 'web.bonus.inPayload': "this fusion takes the {outer} board's bonuses{crit}" },
      'zh-TW': { 'web.bonus.inPayload': '這條融合吃{outer}外盤的加成{crit}' },
    });
    expect(issues).toContain(
      "node 'fusion.fire.crit.core' (zh-TW): the text has an unfilled {crit}; check web.bonus.inPayload",
    );
    expect(issues).toContain(
      "node 'fusion.fire.barrage.core' (en): the text has an unfilled {crit}; check web.bonus.inPayload",
    );
    for (const issue of issues) expect(issue).toMatch(/; check web\.bonus\.inPayload$/);
  });

  it("reports a preview card's empty line", () => {
    expect(issuesWith({ 'zh-TW': { 'web.enemy.triangle': '' } })).toContain(
      "outer 'poison' (character 'fire', zh-TW): the preview card has an empty line; check web.enemy.triangle",
    );
  });

  it('reports NaN and undefined with the key that wrote them', () => {
    const issues = issuesWith({
      en: {
        'web.node.fire.center.main.star-one.desc': 'Deals NaN damage.',
        'web.node.fire.center.main.star-two.desc': 'Lasts undefined s.',
      },
    });
    expect(issues).toEqual([
      "node 'fire.center.main.star-one' (en): the text has 'NaN'; check web.node.fire.center.main.star-one.desc",
      "node 'fire.center.main.star-two' (en): the text has 'undefined'; check web.node.fire.center.main.star-two.desc",
    ]);
  });

  it('reports Infinity with the key that wrote it', () => {
    expect(
      issuesWith({
        'zh-TW': { 'web.node.fire.center.main.star-one.desc': '造成 Infinity 傷害。' },
      }),
    ).toEqual([
      "node 'fire.center.main.star-one' (zh-TW): the text has 'Infinity'; check web.node.fire.center.main.star-one.desc",
    ]);
  });
});

describe('V20', () => {
  it("reports a fusion name that is not gd §5.4's", () => {
    expect(issuesWith({ 'zh-TW': { 'web.hivePrefix.crit': '暴' } }, [summon])).toEqual([
      "fusion 'summon.crit': name '暴召喚', gd §5.4 says '暴擊召喚'; check web.hivePrefix.crit",
    ]);
    expect(issuesWith({ 'zh-TW': { 'web.abbr.aura': '環' } })).toEqual([
      "fusion 'fire.aura': name '火環', gd §5.4 says '火光'; check web.abbr.fire and web.abbr.aura",
    ]);
  });

  it('reports an empty English fusion name', () => {
    expect(issuesWith({ en: { 'web.abbr.fire': '', 'web.abbr.poison': '' } })).toEqual([
      "outer 'poison' (character 'fire', en): the preview card has an empty line; check web.abbr.fire",
      `fusion 'fire.poison' (${EN}): the English name is empty; check web.abbr.fire and web.abbr.poison`,
    ]);
  });

  it('reports a title of the wrong length', () => {
    expect(issuesWith({ 'zh-TW': { 'web.fusion.fire.poison.title': '瘟疫爆' } })).toEqual([
      `fusion 'fire.poison' (${ZH}): title '瘟疫爆' has 3 characters; a template fusion's title has 2 (gd §5.1)`,
    ]);
    expect(issuesWith({ 'zh-TW': { 'web.fusion.fire.ice.title': '霜焰之心' } })).toEqual([
      `fusion 'fire.ice' (${ZH}): title '霜焰之心' has 4 characters; a hand fusion's title has 2 or 3 (gd §5.1)`,
    ]);
    expect(issuesWith({ 'zh-TW': { 'web.fusion.fire.ice.title': '霜焰心' } })).toEqual([]);
  });

  it('reports a title another fusion of the character has', () => {
    expect(issuesWith({ 'zh-TW': { 'web.fusion.fire.bleed.title': '瘟爆' } })).toEqual([
      `fusion 'fire.bleed' (${ZH}): title '瘟爆' is also fusion 'fire.poison''s; titles are unique per character`,
    ]);
    expect(issuesWith({ en: { 'web.fusion.fire.bleed.title': '' } })).toEqual([
      "outer 'bleed' (character 'fire', en): the preview card has an empty line; check web.fusion.fire.bleed.title",
      `fusion 'fire.bleed' (${EN}): the title is empty; write it`,
    ]);
    expect(issuesWith({ en: { 'web.fusion.fire.bleed.title': 'Plague Bomb' } })).toEqual([
      `fusion 'fire.bleed' (${EN}): title 'Plague Bomb' is also fusion 'fire.poison''s; titles are unique per character`,
    ]);
  });
});
