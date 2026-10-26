/**
 * The nightly's web fuzz, 模糊測試 (docs/v3 C10 design §1.6's global-fuzz shard; impl:463;
 * C10-R41): fuzz:web's builds (src/meta/web/fuzz.ts' runWebFuzz) at the plan's fuzzSeed, which
 * nightly.ts derives from the commit, so the nightly draws builds that CI's `npm run fuzz:web`
 * (WEB_FUZZ_SEED) did not. A unit is one build, run exactly as the full run draws it (runWebFuzz's
 * `only`) under fuzz:web's checks; a failure's repro line names the seed. The pr set keeps its
 * pointer to ci.yml's step (run.ts' ciStep). Like every check, fuzz is noCenter while the content
 * has no web to fuzz (lead ruling U15).
 */

import { characterGameData } from '../../../../src/data';
import type { Content } from '../../../../src/data/web';
import {
  FIXED_WEB_CASES,
  fuzzWebs,
  runWebFuzz,
  WEB_FUZZ_BUILDS,
  WEB_FUZZ_SEED,
  WEB_FUZZ_TICKS,
} from '../../../../src/meta/web/fuzz';
import type { WebFuzzFailure } from '../../../../src/meta/web/fuzz';
import { formatContentRef, resolveContent } from '../content';
import type { ContentRef } from '../content';
import { checkRow, measureResultOf, naRow } from './types';
import type { CheckPlan, CheckResult, PlanUnit, UnitResults } from './types';

/** One build of the fuzz: `<character>.<scope>.<index>`, or a fixed case by name. */
export interface FuzzInput {
  readonly content: ContentRef;
  /** The plan's fuzzSeed. */
  readonly seed: number;
  readonly only: string;
}

export interface FuzzReading {
  readonly name: string;
  readonly runs: number;
  readonly ticks: number;
  /** A run stopped at a failure. */
  readonly stopped: boolean;
  readonly highestWaveCleared: number;
  readonly failures: readonly Pick<WebFuzzFailure, 'kind' | 'text' | 'repro' | 'ids'>[];
}

/**
 * One build or fixed case, as fuzz:web runs it on `content` (the fixture's repro lines carry
 * --fixture, every one carries --seed when the seed is not WEB_FUZZ_SEED), without a clock.
 */
export function measureFuzz(input: FuzzInput): FuzzReading {
  const registered = input.content === 'registered';
  const report = runWebFuzz({
    content: resolveContent(input.content),
    data: characterGameData(),
    builds: WEB_FUZZ_BUILDS,
    ticks: WEB_FUZZ_TICKS,
    seed: input.seed,
    fixture: !registered,
    cases: registered ? FIXED_WEB_CASES : [],
    only: input.only,
  });
  const line = report.builds[0] ?? report.cases[0];
  if (line === undefined) throw new Error(`fuzz '${input.only}': runWebFuzz ran no build`);
  return {
    name: line.name,
    runs: line.runs,
    ticks: line.ticks,
    stopped: line.stopped,
    highestWaveCleared: line.highestWaveCleared,
    failures: report.failures.map(({ kind, text, repro, ids }) => ({ kind, text, repro, ids })),
  };
}

/** The webs fuzz:web deals builds over (fuzz.ts' fuzzWebs), `<character>.<scope>`, in order. */
export const fuzzWebNames = (content: Content): string[] =>
  fuzzWebs(content).map((web) => `${web.character}.${web.scope.name}`);

/** A fuzz unit's id: the build's name. */
export const fuzzUnitId = (name: string): string => `measure:fuzz:${name}`;

/**
 * WEB_FUZZ_BUILDS units dealt over the webs as fuzz:web deals them, then on the registered content
 * the fixed cases (FIXED_WEB_CASES); none without a web.
 */
export function fuzzUnits(content: Content, ref: ContentRef, seed: number): PlanUnit[] {
  const webs = fuzzWebNames(content);
  if (webs.length === 0) return [];
  const names = [
    ...Array.from({ length: WEB_FUZZ_BUILDS }, (_, i) => `${webs[i % webs.length]}.${i}`),
    ...(ref === 'registered' ? FIXED_WEB_CASES.map((at) => at.name) : []),
  ];
  return names.map((only) => ({
    id: fuzzUnitId(only),
    job: { kind: 'measure', measure: 'fuzz', input: { content: ref, seed, only } },
  }));
}

/** Failures printed in a row's evidence; the rest are counted. */
const SHOWN = 10;

export const FUZZ_NIGHTLY_STANDARD =
  `fuzz:web's checks on ${WEB_FUZZ_BUILDS} builds at the plan's fuzzSeed (WEB_FUZZ_SEED ` +
  `${WEB_FUZZ_SEED} + the commit's first six hex digits), ${WEB_FUZZ_TICKS} ticks a run: no failure`;

/** The nightly's fuzz row: every build of the plan's fuzz units run without a failure. */
export function fuzzCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const inputs = plan.units.flatMap((unit) =>
    unit.job.kind === 'measure' && unit.job.measure === 'fuzz'
      ? [{ id: unit.id, input: unit.job.input as FuzzInput }]
      : [],
  );
  const seed = inputs[0]?.input.seed ?? WEB_FUZZ_SEED;
  const target = `${FUZZ_NIGHTLY_STANDARD}; seed ${seed}`;
  if (inputs.length === 0) {
    const detail = `no web to fuzz in the ${formatContentRef(plan.content)} content`;
    return [naRow('fuzz', plan.set, 'all', target, 'noData', detail)];
  }
  const readings = inputs.flatMap(({ id }) => {
    const reading = measureResultOf(results, id, 'fuzz');
    return reading === null ? [] : [reading];
  });
  if (readings.length < inputs.length) {
    const detail = `${readings.length} of ${inputs.length} builds run`;
    return [naRow('fuzz', plan.set, 'all', target, 'noData', detail)];
  }
  const failures = readings.flatMap((reading) => reading.failures);
  const failed = readings.filter((reading) => reading.failures.length > 0);
  const runs = readings.reduce((sum, reading) => sum + reading.runs, 0);
  const ticks = readings.reduce((sum, reading) => sum + reading.ticks, 0);
  const stopped = readings.filter((reading) => reading.stopped).length;
  const kinds = [...new Set(failures.map((failure) => failure.kind))];
  return [
    checkRow('fuzz', plan.set, {
      subject: 'all',
      target,
      measured:
        `${readings.length} builds, ${runs} runs, ${ticks} ticks, ${stopped} stopped early; ` +
        (failures.length === 0
          ? 'no failure'
          : `${failures.length} failures (${kinds.join(', ')}) in ${failed.length} builds`),
      status: failures.length === 0 ? 'pass' : 'FAIL',
      evidence: [
        ...failures.slice(0, SHOWN).map((failure) => `${failure.kind}: ${failure.repro}`),
        ...(failures.length > SHOWN ? [`… and ${failures.length - SHOWN} more`] : []),
      ],
    }),
  ];
}
