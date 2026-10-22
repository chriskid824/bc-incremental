/**
 * Dev-only viewer of the v3 webs (docs/v3 C6 design §4.11; F29, F55), served by `npm run dev` at
 * /viewer.html and never built, as sheet.html is: each registered character's web as an SVG
 * (src/ui/web/svg.ts) in every scope, expanded or collapsed, with every load-time issue and every
 * test-time check but V23, the fuzz, beside the node it names (V21 and V22 on the snapshots
 * loaded with `?raw`); hovering a node shows describeNode in both languages, clicking an outer
 * its preview card. `?fixture` shows fixtureContent() through the fixture's text instead (the
 * lead's ruling R2). Vite reloads the page when a content file is saved.
 *
 * URL parameters pick the view: `scope` (full, demoA, demoB), `character`, `collapsed`,
 * `labels=zh-TW`, `node=<id>` and `outer=<o>` (what hover and click show).
 *
 * The text here is for developers, not players, so it is plain English and Traditional Chinese
 * literals rather than i18n keys (like src/app/sheet.ts).
 */

import { CHARACTERS, FIRST_PICK } from '../data/characters';
import { CALIBRATED } from '../data/fusion/calibrated';
import { ACCEPTED_FAILS, OVERRIDES } from '../data/fusion/overrides';
import { HUB } from '../data/hub';
import { OUTERS } from '../data/outer';
import { CHARACTER_IDS, OUTER_IDS } from '../data/sources';
import type { CharacterId, OuterId } from '../data/sources';
import {
  assembleWeb,
  contentIds,
  contentIssues,
  idSnapshotIssues,
  layoutIssues,
  layoutWeb,
  SCOPES,
  scopeHolds,
} from '../data/web';
import type { AssembledWeb, Content, WebScope } from '../data/web';
import { fixtureContent } from '../data/web/testing';
import { LOCALES, MESSAGES } from '../i18n';
import type { Locale } from '../i18n';
import {
  buyabilityIssues,
  DEFAULT_WEB_ECONOMY,
  economyIssues,
  emptyProgress,
  orderIssues,
} from '../meta/web';
import { previewCard } from '../ui/web/card';
import type { PreviewCard } from '../ui/web/card';
import { textIssues } from '../ui/web/check';
import { webSvg } from '../ui/web/svg';
import type { SvgIssue } from '../ui/web/svg';
import { fixtureLookups } from '../ui/web/testing';
import { describeNode, messageLookup } from '../ui/web/text';
import type { TextLookup } from '../ui/web/text';

/** What the viewer shows: the registered content, or the fixture with its text. */
interface Source {
  readonly name: string;
  readonly content: Content;
  readonly firstPick: string;
  readonly lookups: Readonly<Record<Locale, TextLookup>>;
  readonly ids: string;
  readonly layouts: Readonly<Record<CharacterId, string>>;
}

const params = new URLSearchParams(window.location.search);

/**
 * The snapshots' text by path, through Vite's `?raw`: one glob rather than an import per file, as
 * src/sim/systems/systemState.test.ts resolves every import of src/ as a module file.
 */
const SNAPSHOTS = import.meta.glob<string>('../data/web/snapshots/**/*.txt', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The id and layout snapshots in `dir`: '' for the registered content's, 'fixture/'. */
function snapshots(dir: string): Pick<Source, 'ids' | 'layouts'> {
  const text = (file: string): string => {
    const found = SNAPSHOTS[`../data/web/snapshots/${dir}${file}`];
    if (found === undefined) throw new Error(`no snapshot src/data/web/snapshots/${dir}${file}`);
    return found;
  };
  const layouts = Object.fromEntries(CHARACTER_IDS.map((c) => [c, text(`layout-${c}.txt`)]));
  return { ids: text('ids.txt'), layouts: layouts as Record<CharacterId, string> };
}

function source(): Source {
  if (params.has('fixture')) {
    return {
      name: 'fixture (src/data/web/testing.ts)',
      content: fixtureContent(),
      firstPick: 'fire',
      lookups: fixtureLookups(),
      ...snapshots('fixture/'),
    };
  }
  return {
    name: 'registered content',
    content: {
      characters: CHARACTERS,
      outers: OUTERS,
      hub: HUB,
      overrides: OVERRIDES,
      calibrated: CALIBRATED,
      acceptedFails: ACCEPTED_FAILS,
    },
    firstPick: FIRST_PICK,
    lookups: { en: messageLookup(MESSAGES.en), 'zh-TW': messageLookup(MESSAGES['zh-TW']) },
    ...snapshots(''),
  };
}

const webKey = (scope: WebScope, character: CharacterId): string => `${scope.name}/${character}`;
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Every web the content assembles, and the issues of the whole content. */
interface Checked {
  readonly webs: ReadonlyMap<string, AssembledWeb>;
  /** Load-time issues (with their node), V16, V17–V20 over every web, V21, assembly failures. */
  readonly issues: readonly SvgIssue[];
}

function check(src: Source): Checked {
  const issues: SvgIssue[] = contentIssues(src.content, { firstPick: src.firstPick }).map(
    ({ node, message }) => ({ node, message }),
  );
  const webs = new Map<string, AssembledWeb>();
  for (const scope of SCOPES) {
    for (const c of CHARACTER_IDS) {
      if (src.content.characters[c].center === null || !scopeHolds(scope.characters, c)) continue;
      try {
        webs.set(webKey(scope, c), assembleWeb(src.content, c, scope));
      } catch (error) {
        issues.push({ node: null, message: `web '${webKey(scope, c)}': ${errorText(error)}` });
      }
    }
  }
  const run = (name: string, issuesOf: () => readonly string[]): void => {
    try {
      for (const message of issuesOf()) issues.push({ node: null, message });
    } catch (error) {
      issues.push({ node: null, message: `${name} failed: ${errorText(error)}` });
    }
  };
  run('economyIssues', () => economyIssues(DEFAULT_WEB_ECONOMY));
  run('idSnapshotIssues', () => idSnapshotIssues(contentIds(src.content), src.ids));
  run('textIssues', () => textIssues([...webs.values()], src.lookups));
  return { webs, issues };
}

/** V15, V25 and V22 of one web, computed when it is first shown. */
const webIssueCache = new Map<string, readonly SvgIssue[]>();
function webIssues(key: string, web: AssembledWeb, src: Source): readonly SvgIssue[] {
  const cached = webIssueCache.get(key);
  if (cached !== undefined) return cached;
  const issues: SvgIssue[] = [];
  const checks: readonly (readonly [string, () => readonly string[]])[] = [
    ['buyabilityIssues', () => buyabilityIssues(web)],
    ['orderIssues', () => orderIssues(web)],
    ['layoutIssues', () => layoutIssues(layoutWeb(web), web, src.layouts[web.character])],
  ];
  for (const [name, issuesOf] of checks) {
    try {
      for (const message of issuesOf()) issues.push({ node: null, message });
    } catch (error) {
      issues.push({ node: null, message: `${name} failed: ${errorText(error)}` });
    }
  }
  webIssueCache.set(key, issues);
  return issues;
}

/** The node or board of `web` a quoted token names: an id, a key's id, a fusion key or an outer. */
function idOfToken(token: string, web: AssembledWeb, boards: ReadonlySet<string>): string | null {
  const candidates = [token];
  const key = /^web\.(node|fusion|outer|asc|branch)\.(.+?)(?:\.(name|desc|title))?$/.exec(token);
  if (key !== null) {
    const [, kind, rest] = key as unknown as [string, string, string];
    if (kind === 'node') candidates.push(rest);
    if (kind === 'fusion') candidates.push(`fusion.${rest}`);
    if (kind === 'outer') candidates.push(`outer.${rest}`);
    if (kind === 'asc') candidates.push(rest.replace('.', '.asc.'));
    if (kind === 'branch') candidates.push(rest.slice(0, rest.lastIndexOf('.')));
  }
  if (/^[a-z]+\.[a-z]+$/.test(token)) candidates.push(`fusion.${token}`);
  if ((OUTER_IDS as readonly string[]).includes(token)) candidates.push(`outer.${token}`);
  return candidates.find((id) => web.byId.has(id) || boards.has(id)) ?? null;
}

/** An issue placed on `web`: its node, else the first quoted token naming a node or board. */
function place(issue: SvgIssue, web: AssembledWeb, boards: ReadonlySet<string>): string | null {
  if (issue.node !== null && (web.byId.has(issue.node) || boards.has(issue.node))) {
    return issue.node;
  }
  for (const match of issue.message.matchAll(/'([^']+)'/g)) {
    const id = idOfToken(match[1] as string, web, boards);
    if (id !== null) return id;
  }
  return null;
}

const esc = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Lines joined into sentences, as the card prints a rule. */
const sentences = (lines: readonly string[], locale: Locale): string =>
  lines
    .map((line) =>
      locale === 'zh-TW'
        ? line.endsWith('。')
          ? line
          : `${line}。`
        : /[.!?]$/.test(line)
          ? line
          : `${line}.`,
    )
    .join(locale === 'zh-TW' ? '' : ' ');

function cardHtml(card: PreviewCard, outer: OuterId, locale: Locale): string {
  const zh = locale === 'zh-TW';
  const rows: string[] = [];
  if (card.entry.length > 0) {
    rows.push(`${zh ? '入口：' : 'Entry: '}${esc(card.entry.join(zh ? '；' : '; '))}`);
  }
  if (card.fusion === null) {
    rows.push(zh ? '這個範圍沒有這條融合' : 'No fusion in this scope');
  } else {
    const { name, title, hand, rule } = card.fusion;
    const head = zh ? `${name}「${title}」` : `${name} "${title}"`;
    const kind = hand ? (zh ? '（手工）' : ' (hand-made)') : '';
    rows.push(`<b>${esc(head)}</b>${kind}${zh ? '：' : ': '}${esc(sentences(rule, locale))}`);
  }
  const { answer, helps } = card.covers;
  if (answer.length + helps.length > 0) {
    const join = zh ? '、' : ', ';
    const answered =
      answer.length === 0 ? '' : `${answer.join(join)}${zh ? '（答案）' : ' (answers)'}`;
    const parts = [answered, helps.join(join)].filter((part) => part !== '');
    rows.push(`${zh ? '能補：' : 'Covers: '}${esc(parts.join(zh ? '；' : '; '))}`);
  }
  const { center, centerNeed, outer: count, outerNeed } = card.gate;
  rows.push(
    zh
      ? `融合解鎖：中心 ${center}/${centerNeed}・${esc(card.outer)} ${count ?? 0}/${outerNeed ?? 0}`
      : `Fusion unlock: center ${center}/${centerNeed} · ${esc(card.outer)} ${count ?? 0}/${outerNeed ?? 0}`,
  );
  const body = rows.map((row) => `<div>${row}</div>`).join('');
  return `<div class="text" data-card="${outer}" data-locale="${locale}"><div class="name">${esc(card.outer)}</div>${body}</div>`;
}

function nodeHtml(web: AssembledWeb, id: string, lookups: Source['lookups']): string {
  return LOCALES.map((locale) => {
    const text = describeNode(web, id, 1, lookups[locale]);
    const lines = text.lines.map((line) => `<div>${esc(line)}</div>`).join('');
    return (
      `<div class="text" data-node="${esc(id)}" data-locale="${locale}"><div class="name">${esc(text.name)}</div>` +
      `<div class="kind">${esc(text.kind)} · <span class="id">${esc(id)}</span></div>${lines}</div>`
    );
  }).join('');
}

const issueList = (issues: readonly SvgIssue[]): string =>
  issues.length === 0
    ? '<p class="empty">none</p>'
    : `<ul class="issues">${issues.map((issue) => `<li>${esc(issue.message)}</li>`).join('')}</ul>`;

/** The outer a board or node id belongs to: `outer.<o>…` or `fusion.<c>.<o>…`. */
function outerOfId(id: string): OuterId | null {
  const [head, first, second] = id.split('.');
  const outer = head === 'outer' ? first : head === 'fusion' ? second : undefined;
  return (OUTER_IDS as readonly (string | undefined)[]).includes(outer) ? (outer as OuterId) : null;
}

function start(root: HTMLElement): void {
  const src = source();
  const checked = check(src);
  const state = {
    scope: SCOPES.find((scope) => scope.name === params.get('scope')) ?? (SCOPES[0] as WebScope),
    character: (params.get('character') ?? '') as CharacterId,
    collapsed: params.has('collapsed'),
    labels: (params.get('labels') === 'zh-TW' ? 'zh-TW' : 'en') as Locale,
    node: params.get('node'),
    outer: params.get('outer') as OuterId | null,
  };

  const render = (): void => {
    const held = CHARACTER_IDS.filter((c) => checked.webs.has(webKey(state.scope, c)));
    if (!held.includes(state.character)) state.character = held[0] ?? 'fire';
    const key = webKey(state.scope, state.character);
    const web = checked.webs.get(key);
    const scopeOptions = SCOPES.map(
      (scope) =>
        `<option value="${scope.name}"${scope === state.scope ? ' selected' : ''}>${scope.name}</option>`,
    ).join('');
    const characterOptions = held
      .map((c) => `<option value="${c}"${c === state.character ? ' selected' : ''}>${c}</option>`)
      .join('');
    const all =
      web === undefined ? checked.issues : [...checked.issues, ...webIssues(key, web, src)];
    const boards = new Set<string>(web?.boards.map((board) => board.id) ?? []);
    const placed: SvgIssue[] = [];
    const unplaced: SvgIssue[] = [];
    for (const issue of all) {
      const node = web === undefined ? null : place(issue, web, boards);
      if (node === null) unplaced.push(issue);
      else placed.push({ node, message: issue.message });
    }
    root.innerHTML =
      `<header><h1>v3 web viewer · ${esc(src.name)}</h1>` +
      `<label>scope <select id="scope">${scopeOptions}</select></label>` +
      `<label>character <select id="character">${characterOptions}</select></label>` +
      `<label><input type="checkbox" id="collapsed"${state.collapsed ? ' checked' : ''}> collapsed</label>` +
      `<label>labels <select id="labels">${LOCALES.map((l) => `<option${l === state.labels ? ' selected' : ''}>${l}</option>`).join('')}</select></label>` +
      `<span class="summary">${all.length} issue(s), ${placed.length} beside their nodes · ${checked.webs.size} web(s)</span></header>` +
      `<section id="web">${
        web === undefined
          ? `<p class="empty">No character has a center in this scope yet (製作中). Open <a href="?fixture">?fixture</a> for the fixture's webs.</p>`
          : webSvg(layoutWeb(web), web, placed, {
              lookup: src.lookups[state.labels],
              collapsed: state.collapsed,
            })
      }</section>` +
      `<aside><h2>Node</h2><div id="node">${
        web !== undefined && state.node !== null && web.byId.has(state.node)
          ? nodeHtml(web, state.node, src.lookups)
          : '<p class="empty">hover a node</p>'
      }</div>` +
      `<h2>Preview card</h2><div id="card">${
        web !== undefined && state.outer !== null
          ? LOCALES.map((locale) =>
              cardHtml(
                previewCard(
                  web,
                  emptyProgress(web.character),
                  state.outer as OuterId,
                  src.lookups[locale],
                ),
                state.outer as OuterId,
                locale,
              ),
            ).join('')
          : '<p class="empty">click an outer</p>'
      }</div>` +
      `<h2>Issues not beside a node</h2>${issueList(unplaced)}` +
      `<h2>Issues beside nodes</h2>${issueList(placed)}</aside>`;

    const select = (id: string): HTMLSelectElement =>
      root.querySelector(`#${id}`) as HTMLSelectElement;
    select('scope').onchange = (event) => {
      const name = (event.target as HTMLSelectElement).value;
      state.scope = SCOPES.find((scope) => scope.name === name) ?? state.scope;
      render();
    };
    select('character').onchange = (event) => {
      state.character = (event.target as HTMLSelectElement).value as CharacterId;
      render();
    };
    select('labels').onchange = (event) => {
      state.labels = (event.target as HTMLSelectElement).value as Locale;
      render();
    };
    (root.querySelector('#collapsed') as HTMLInputElement).onchange = (event) => {
      state.collapsed = (event.target as HTMLInputElement).checked;
      render();
    };
    const svg = root.querySelector('#web svg');
    if (web === undefined || svg === null) return;
    svg.addEventListener('mouseover', (event) => {
      const node = (event.target as Element).closest('.node');
      const id = node?.getAttribute('data-id');
      if (id === null || id === undefined || id === state.node) return;
      state.node = id;
      (root.querySelector('#node') as HTMLElement).innerHTML = nodeHtml(web, id, src.lookups);
    });
    svg.addEventListener('click', (event) => {
      const target = (event.target as Element).closest('[data-id], [data-board]');
      const id = target?.getAttribute('data-id') ?? target?.getAttribute('data-board') ?? null;
      const outer = id === null ? null : outerOfId(id);
      if (outer === null) return;
      state.outer = outer;
      render();
    });
  };

  render();
  document.documentElement.dataset.viewerReady = 'true';
}

const root = document.getElementById('viewer');
if (root !== null) start(root);
