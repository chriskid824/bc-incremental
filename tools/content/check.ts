/**
 * The content check (docs/v3 C6 design §4.8, §4.11, D23; S-3): every check of §4.8 but the fuzz
 * (V23), through the functions the tests and the viewer call, and a summary per scope and
 * character: the nodes each web holds and the scope's total, FULL_SCOPE's against BATCH_COUNTS
 * when the registered blocks are a batch's; the keys missing in each locale (V17); the fusions
 * uncalibrated, stale or failing (V9); the nodes no legal order reaches (V15).
 *
 *   npm run content -- [--fixture] [--stubs]
 *
 * Without a flag it checks the registered content with the shipped text and the snapshots in
 * src/data/web/snapshots/, and exits 1 on any issue. --fixture checks fixtureContent() with the
 * fixture's text (fixtureLookups) and snapshots/fixture/ instead, so the tool can be seen working
 * before B1 (the lead's ruling R8): the fixture has no CALIBRATED entries, so V9 reports each of
 * its fusions uncalibrated, which the run prints as expected and does not count as an issue.
 * --stubs also writes a TODO stub into each web JSON file for every key V17 finds missing there,
 * for the registered content only (it refuses --fixture); V17 fails on each TODO until the text is
 * written.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CHARACTERS, FIRST_PICK } from '../../src/data/characters';
import { CALIBRATED } from '../../src/data/fusion/calibrated';
import { ACCEPTED_FAILS, OVERRIDES } from '../../src/data/fusion/overrides';
import { HUB } from '../../src/data/hub';
import { OUTERS } from '../../src/data/outer';
import { CHARACTER_IDS, OUTER_IDS } from '../../src/data/sources';
import {
  assembleWeb,
  BATCH_COUNTS,
  batchOf,
  calibrationIssues,
  contentIssues,
  FULL_SCOPE,
  ID_RENAMES,
  SCOPES,
  scopeHolds,
} from '../../src/data/web';
import type { AssembledWeb, Content, ContentIssue } from '../../src/data/web';
import { fixtureContent } from '../../src/data/web/testing';
import { LOCALES, MESSAGES } from '../../src/i18n';
import type { Locale } from '../../src/i18n';
import {
  buyabilityIssues,
  DEFAULT_WEB_ECONOMY,
  economyIssues,
  orderIssues,
} from '../../src/meta/web';
import { textIssues } from '../../src/ui/web/check';
import { fixtureLookups } from '../../src/ui/web/testing';
import { messageLookup } from '../../src/ui/web/text';
import type { TextLookup } from '../../src/ui/web/text';
import { snapshotIssues } from './snapshots';
import type { StoredText } from './snapshots';

/** What a run checks: the content as written (not yet validated), its text and its snapshots. */
export interface CheckSource {
  readonly name: string;
  readonly content: Content;
  readonly firstPick: string;
  readonly lookups: Readonly<Record<Locale, TextLookup>>;
  readonly stored: StoredText;
  readonly renames: Readonly<Record<string, string | null>>;
  /** The fixture, whose V9 missing entries are expected (R8). */
  readonly fixture: boolean;
}

export interface ContentCheck {
  /** Every issue, check by check, each once. */
  readonly issues: readonly string[];
  /** The fixture's V9 missing entries: it has no CALIBRATED entries (R8). Not issues. */
  readonly expected: readonly string[];
  readonly summary: readonly string[];
  /** The keys V17 finds missing, by the web JSON file each is missing in. */
  readonly missing: ReadonlyMap<string, readonly string[]>;
}

const MISSING = /^key '([^']+)' is missing in (src\/i18n\/web\.[A-Za-z-]+\.json); /;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** `issuesOf`'s issues, or one naming the check when it throws. */
function guarded<T>(name: string, issuesOf: () => readonly T[], failed: (text: string) => T): T[] {
  try {
    return [...issuesOf()];
  } catch (error) {
    return [failed(`${name} failed: ${errorText(error)}`)];
  }
}

const guardedText = (name: string, issuesOf: () => readonly string[]): string[] =>
  guarded(name, issuesOf, (text) => text);

/** The keys V17's messages say are missing, by the file they are missing in. */
export function missingKeys(issues: readonly string[]): Map<string, string[]> {
  const missing = new Map<string, string[]>();
  for (const issue of issues) {
    const match = MISSING.exec(issue);
    if (match === null) continue;
    const [, key, file] = match as unknown as [string, string, string];
    missing.set(file, [...(missing.get(file) ?? []), key]);
  }
  return missing;
}

/** A web JSON file's text with a TODO stub after its keys for each of `keys` it lacks. */
export function stubbedText(text: string, keys: readonly string[]): string {
  const messages = JSON.parse(text) as Record<string, string>;
  for (const key of keys) if (!Object.hasOwn(messages, key)) messages[key] = 'TODO';
  return `${JSON.stringify(messages, null, 2)}\n`;
}

/** How V9 judged a fusion, from its message (src/data/web/validate.ts). */
const v9Kind = (message: string): 'uncalibrated' | 'stale' | 'failing' =>
  message.includes(': has no CALIBRATED entry;')
    ? 'uncalibrated'
    : message.includes(': calibrated for digest ')
      ? 'stale'
      : 'failing';

/** One web's line of the summary. */
function webLine(
  web: AssembledWeb,
  v9: readonly ContentIssue[],
  unbuyable: number,
  lookups: Readonly<Record<Locale, TextLookup>>,
): string {
  const mine = v9.filter((issue) => issue.node !== null && web.byId.has(issue.node));
  const count = (kind: ReturnType<typeof v9Kind>): number =>
    mine.filter((issue) => v9Kind(issue.message) === kind).length;
  const missing = missingKeys(guardedText('textIssues', () => textIssues([web], lookups)));
  const keys = LOCALES.map((locale) => {
    const file = [...missing.keys()].find((name) => name.endsWith(`web.${locale}.json`));
    return `${locale} ${file === undefined ? 0 : (missing.get(file) ?? []).length}`;
  });
  return (
    `  ${web.character}: ${plural(web.nodes.length, 'node')}, ` +
    `${plural(web.fusions.size, 'fusion')} (${count('uncalibrated')} uncalibrated, ` +
    `${count('stale')} stale, ${count('failing')} failing), missing keys ${keys.join(', ')}, ` +
    `${plural(unbuyable, 'unbuyable node')}`
  );
}

/** FULL_SCOPE's total against BATCH_COUNTS, when the registered blocks are a batch's (V14). */
function batchText(content: Content, total: number): string {
  const batch = batchOf({
    centers: CHARACTER_IDS.filter((c) => content.characters[c].center !== null),
    hub: content.hub !== null,
    outers: OUTER_IDS.filter((o) => content.outers[o] !== undefined),
    ascendancies: CHARACTER_IDS.filter((c) => content.characters[c].ascendancies !== null),
  });
  if (batch === null) return "the registered blocks are no batch's (V14 checks gd §2.1's formula)";
  const counted = BATCH_COUNTS[batch];
  return (
    `the registered blocks are ${batch}'s, which BATCH_COUNTS counts ${counted}` +
    (counted === total ? '' : ` (not ${total})`)
  );
}

/**
 * The checks of §4.8 but V23 over `source`: the load-time ones (contentIssues), V9 in every scope,
 * V15 and V25 on every web, V16, V17, V19 and V20 over every web, V21 and V22 on the snapshots,
 * with the summary.
 */
export function checkContent(source: CheckSource): ContentCheck {
  const { content, lookups } = source;
  const issues: string[] = guardedText('contentIssues', () =>
    contentIssues(content, { firstPick: source.firstPick }).map((issue) => issue.message),
  );
  const expected: string[] = [];
  const summary: string[] = [];
  const webs: AssembledWeb[] = [];
  const v9Seen = new Set<string>();
  for (const scope of SCOPES) {
    const lines: string[] = [];
    const held: AssembledWeb[] = [];
    for (const c of CHARACTER_IDS) {
      if (!scopeHolds(scope.characters, c)) continue;
      if (content.characters[c].center === null) {
        lines.push(`  ${c}: no center yet, so no web (N-6)`);
        continue;
      }
      try {
        held.push(assembleWeb(content, c, scope));
      } catch (error) {
        issues.push(`web '${c}' (scope '${scope.name}'): ${errorText(error)}`);
        lines.push(`  ${c}: not assembled`);
      }
    }
    const v9 = guarded(
      'calibrationIssues',
      () => calibrationIssues(content, scope),
      (message): ContentIssue => ({ file: null, node: null, message }),
    );
    for (const { message } of v9) {
      if (v9Seen.has(message)) continue;
      v9Seen.add(message);
      if (source.fixture && v9Kind(message) === 'uncalibrated') expected.push(message);
      else issues.push(message);
    }
    for (const web of held) {
      const unbuyable = guardedText('buyabilityIssues', () => buyabilityIssues(web));
      issues.push(...unbuyable, ...guardedText('orderIssues', () => orderIssues(web)));
      lines.push(webLine(web, v9, unbuyable.length, lookups));
    }
    webs.push(...held);
    const total = new Set(held.flatMap((web) => web.nodes.map((node) => node.id))).size;
    const cap = scope.waveCap === null ? 'no wave cap' : `wave cap ${scope.waveCap}`;
    summary.push(
      `scope '${scope.name}' (${cap}): ${plural(held.length, 'web')}, ` +
        `${plural(total, 'node')} in all` +
        (scope === FULL_SCOPE ? `; ${batchText(content, total)}` : ''),
      ...lines,
    );
  }
  issues.push(...guardedText('economyIssues', () => economyIssues(DEFAULT_WEB_ECONOMY)));
  const text = guardedText('textIssues', () => textIssues(webs, lookups));
  issues.push(...text);
  issues.push(
    ...guardedText('snapshotIssues', () => snapshotIssues(content, source.stored, source.renames)),
  );
  return { issues: [...new Set(issues)], expected, summary, missing: missingKeys(text) };
}

const SNAPSHOTS = new URL('../../src/data/web/snapshots/', import.meta.url);
const REPO = new URL('../../', import.meta.url);

const storedIn =
  (dir: URL): StoredText =>
  (name) => {
    const file = new URL(name, dir);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };

/** The registered content as written, which loadContent would validate, with the shipped text. */
const registered = (): CheckSource => ({
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
  stored: storedIn(SNAPSHOTS),
  renames: ID_RENAMES,
  fixture: false,
});

/** The full fixture with its text and snapshots/fixture/ (R8); its ids reach no save. */
const fixture = (): CheckSource => ({
  name: 'fixture (src/data/web/testing.ts)',
  content: fixtureContent(),
  firstPick: 'fire',
  lookups: fixtureLookups(),
  stored: storedIn(new URL('fixture/', SNAPSHOTS)),
  renames: {},
  fixture: true,
});

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      fixture: { type: 'boolean', default: false },
      stubs: { type: 'boolean', default: false },
    },
  });
  if (values.stubs && values.fixture) {
    console.log(
      'npm run content: --stubs writes stubs for the registered content only; drop --fixture',
    );
    process.exitCode = 1;
    return;
  }
  const source = values.fixture ? fixture() : registered();
  const checked = checkContent(source);
  console.log(`npm run content: ${source.name}`);
  for (const line of checked.summary) console.log(line);
  if (checked.expected.length > 0) {
    console.log(
      `V9: ${plural(checked.expected.length, 'fusion has', 'fusions have')} no CALIBRATED entry, ` +
        'as the fixture has none; expected, not an issue of the content or a failure of the tool ' +
        `(R8), e.g. ${checked.expected[0] as string}`,
    );
  }
  if (checked.issues.length > 0) {
    console.log(`${source.name}: ${plural(checked.issues.length, 'issue')}:`);
    for (const issue of checked.issues) console.log(`- ${issue}`);
    process.exitCode = 1;
  } else {
    console.log(`${source.name}: no issues`);
  }
  if (!values.stubs) return;
  if (checked.missing.size === 0) console.log('--stubs: no key is missing; nothing written');
  for (const [file, keys] of checked.missing) {
    const url = new URL(file, REPO);
    writeFileSync(url, stubbedText(readFileSync(url, 'utf8'), keys));
    console.log(`--stubs: wrote ${plural(keys.length, 'TODO stub')} to ${file}`);
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
