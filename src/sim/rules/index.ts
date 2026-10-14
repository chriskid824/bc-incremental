/**
 * The rule module of every RuleSpec id (src/data/rules.ts). The mapped type makes a rule id
 * without a module, or a module for the wrong id, a type error.
 */

import type { RuleId, RuleSpec } from '../../data/rules';
import { eternalFlame } from './eternalFlame';
import { glassCannon } from './glassCannon';
import type { RuleModule } from './module';
import { overload } from './overload';
import { pandemicLegacy } from './pandemicLegacy';
import { steadyAim } from './steadyAim';

export type { BuildCompiler, HookName, Hooks, KillScratch, RuleModule, TestModule } from './module';

export const RULE_MODULES: {
  readonly [K in RuleId]: RuleModule<Extract<RuleSpec, { id: K }>>;
} = {
  steadyAim,
  pandemic: pandemicLegacy,
  eternalFlame,
  overload,
  glassCannon,
};
