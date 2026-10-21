/**
 * Entry point of the v3 web content (docs/v3 C6 design D1, §2.2): loadContent(), which validates
 * the registered content on its first call, and the web's vocabulary. src/data/index.ts never
 * re-exports this module, so the M1 web and its consumers stay as they are
 * (src/data/web/isolation.test.ts).
 */

import { CHARACTERS, FIRST_PICK } from '../characters';
import { CALIBRATED } from '../fusion/calibrated';
import { ACCEPTED_FAILS, OVERRIDES } from '../fusion/overrides';
import { HUB } from '../hub';
import { OUTERS } from '../outer';
import type { Content } from './types';
import { contentIssues } from './validate';
import type { ContentIssue, ValidateOptions } from './validate';

export * from './types';
export * from './ids';
export * from './scope';
export * from './assemble';
export * from './layout';
export * from './validate';
export * from './snapshot';
export * from './renames';

/** The content's load-time issues (§4.8), sorted by file; the message lists every one. */
export class ContentError extends Error {
  readonly issues: readonly ContentIssue[];

  constructor(issues: readonly ContentIssue[]) {
    const count = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
    super(`Invalid content (${count}):\n- ${issues.map((issue) => issue.message).join('\n- ')}`);
    this.name = 'ContentError';
    this.issues = issues;
  }
}

/**
 * Runs the load-time checks (V1–V8, V10–V14, V18, V24) over `content` and returns it, or throws
 * one ContentError listing every issue. Uncached: a test that needs a fresh parse calls this.
 */
export function parseContent(content: Content, options: ValidateOptions = {}): Content {
  const issues = contentIssues(content, options);
  if (issues.length > 0) throw new ContentError(issues);
  return content;
}

let cached: Content | undefined;

/** The registered content, validated on the first call and the same object afterwards (P8). */
export function loadContent(): Content {
  cached ??= parseContent(
    {
      characters: CHARACTERS,
      outers: OUTERS,
      hub: HUB,
      overrides: OVERRIDES,
      calibrated: CALIBRATED,
      acceptedFails: ACCEPTED_FAILS,
    },
    { firstPick: FIRST_PICK },
  );
  return cached;
}
