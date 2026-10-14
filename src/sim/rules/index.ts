/**
 * The rule module of every RuleSpec id and the signature module of every SignatureSpec id
 * (src/data/rules.ts). The mapped types make an id without a module, or a module for the wrong
 * id, a type error.
 */

import type { RuleId, RuleSpec, SignatureId, SignatureSpec } from '../../data/rules';
import { eternalFlame } from './eternalFlame';
import { glassCannon } from './glassCannon';
import { m1Volley } from './m1Volley';
import type { RuleModule, SignatureModule } from './module';
import { overload } from './overload';
import { pandemicLegacy } from './pandemicLegacy';
import { steadyAim } from './steadyAim';

export type {
  BuildCompiler,
  HookName,
  Hooks,
  KillScratch,
  RuleModule,
  ShotScratch,
  SignatureModule,
  TestModule,
} from './module';

export const RULE_MODULES: {
  readonly [K in RuleId]: RuleModule<Extract<RuleSpec, { id: K }>>;
} = {
  steadyAim,
  pandemic: pandemicLegacy,
  eternalFlame,
  overload,
  glassCannon,
};

export const SIGNATURES: {
  readonly [K in SignatureId]: SignatureModule<Extract<SignatureSpec, { id: K }>>;
} = {
  m1Volley,
};
