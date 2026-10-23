/**
 * The content character sessions run on (docs/v3 C10 design §1.1): the registered content or a
 * fixture variant (src/data/web/testing.ts), each made once per process, so once per worker; the
 * characters whose center is written; and each character's web in a scope, assembled once. The
 * balance tools reach the v3 web only through tools/balance/v3/ (src/data/web/isolation.test.ts).
 */

import { CHARACTER_IDS } from '../../../src/data/sources';
import type { CharacterId } from '../../../src/data/sources';
import {
  assembleWeb,
  BATCH_COUNTS,
  DEMO_SCOPE_A,
  DEMO_SCOPE_B,
  FULL_SCOPE,
  loadContent,
  scopeHolds,
} from '../../../src/data/web';
import type { AssembledWeb, Batch, Content, FusionKey, WebScope } from '../../../src/data/web';
import { fixtureContent } from '../../../src/data/web/testing';

/** The C10 tools' seed (初始值): the next after 1028 summons, 1029 the web fuzz, 1030 calibration. */
export const C10_SEED = 1031;

/** Where a session's content comes from: the registered blocks, or the fixture after a batch. */
export type ContentRef = 'registered' | { readonly fixture: Batch };

export const SCOPE_NAMES = ['full', 'demoA', 'demoB'] as const;
export type ScopeName = (typeof SCOPE_NAMES)[number];

/** The web scopes by name (src/data/web/scope.ts). */
export const SCOPE_BY_NAME: Readonly<Record<ScopeName, WebScope>> = {
  full: FULL_SCOPE,
  demoA: DEMO_SCOPE_A,
  demoB: DEMO_SCOPE_B,
};

const BATCHES = Object.keys(BATCH_COUNTS) as Batch[];

/** Parses `registered`, `fixture` (the full fixture, fixture:B5) or `fixture:B1` … `fixture:B5`. */
export function parseContentRef(text: string): ContentRef {
  if (text === 'registered') return 'registered';
  if (text === 'fixture') return { fixture: 'B5' };
  const batch = /^fixture:(.+)$/.exec(text)?.[1];
  if (batch !== undefined && (BATCHES as readonly string[]).includes(batch)) {
    return { fixture: batch as Batch };
  }
  throw new Error(
    `Invalid content '${text}': use registered, fixture or fixture:<batch> ` +
      `(${BATCHES.join(', ')})`,
  );
}

export const formatContentRef = (ref: ContentRef): string =>
  ref === 'registered' ? 'registered' : `fixture:${ref.fixture}`;

export const isScopeName = (text: string): text is ScopeName =>
  (SCOPE_NAMES as readonly string[]).includes(text);

const fixtures = new Map<Batch, Content>();

/** loadContent(), or fixtureContent(batch) made once per process. */
export function resolveContent(ref: ContentRef): Content {
  if (ref === 'registered') return loadContent();
  let content = fixtures.get(ref.fixture);
  if (content === undefined) {
    content = fixtureContent(ref.fixture);
    fixtures.set(ref.fixture, content);
  }
  return content;
}

/** The characters whose center is written (the others are 製作中 and have no web), in order. */
export function builtCharacters(content: Content): CharacterId[] {
  return CHARACTER_IDS.filter((c) => content.characters[c].center !== null);
}

/** Whether `scope` lists `character`. */
export const scopeLists = (scope: ScopeName, character: CharacterId): boolean =>
  scopeHolds(SCOPE_BY_NAME[scope].characters, character);

/** The built characters `scope` lists: the ones `--character all` runs. */
export function sessionCharacters(content: Content, scope: ScopeName): CharacterId[] {
  return builtCharacters(content).filter((c) => scopeLists(scope, c));
}

const webs = new Map<string, AssembledWeb>();

/**
 * assembleWeb(content, c, scope, { coefs }), made once per content, character, scope and coefs;
 * it throws, as assembleWeb does, for a character without a center or outside the scope.
 */
export function webOf(
  ref: ContentRef,
  character: CharacterId,
  scope: ScopeName,
  coefs?: Readonly<Partial<Record<FusionKey, number>>>,
): AssembledWeb {
  const coefKey =
    coefs === undefined
      ? ''
      : JSON.stringify(Object.entries(coefs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const key = [formatContentRef(ref), character, scope, coefKey].join('|');
  let web = webs.get(key);
  if (web === undefined) {
    web = assembleWeb(
      resolveContent(ref),
      character,
      SCOPE_BY_NAME[scope],
      coefs === undefined ? {} : { coefs },
    );
    webs.set(key, web);
  }
  return web;
}
