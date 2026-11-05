/**
 * The rule module of every RuleSpec id and the signature module of every SignatureSpec id
 * (src/data/rules.ts). The mapped types make an id without a module, or a module for the wrong
 * id, a type error.
 */

import type { RuleId, RuleSpec, SignatureId, SignatureSpec } from '../../data/rules';
import { absoluteZero } from './absoluteZero';
import { blastSpirit } from './blastSpirit';
import { eternalFlame } from './eternalFlame';
import { icicle, prism } from './fanForms';
import { pyreChain, zoneTune } from './fireAscendancy';
import { frostflame } from './frostflame';
import { gigantism } from './gigantism';
import { glassCannon } from './glassCannon';
import { iceFan } from './iceFan';
import { chainBlast, farThrow, volcano } from './lobForms';
import { m1Volley } from './m1Volley';
import { magmaBomb } from './magmaBomb';
import type { RuleModule, SignatureModule } from './module';
import { overload } from './overload';
import { poisonSlow } from './poisonSlow';
import { sixCoils } from './sixCoils';
import { steadyAim } from './steadyAim';
import { swarm } from './swarm';
import {
  breed,
  colossus,
  hiveBuild,
  queenRole,
  hammerRole,
  focusFire,
  outpost,
  selfDestruct,
  interceptors,
  swarmSurge,
  hiveExpand,
  hiveSplit,
  motherFactory,
  royalJelly,
  swarmTune,
} from './hive';
import { frostSentry, superconduct, thermalShock } from './frostFusions';
import { hemorrhage } from './hemorrhage';
import { bulletRain } from './bulletRain';
import { frozenNoSplit, shatterChain } from './shatterFlags';
import { bulletHell } from './bulletHell';
import { barrageFan, barrageFocus, barrageRing, clusterShot } from './barrageNodes';
import { flameBee, frostBee } from './hiveFusions';
import { plasma, stormWeb } from './lightningFusions';
import { bugSea, cannon, lockBeacon, teslaTower } from './summonPolicies';
import { triphaseArc } from './triphaseArc';

export type {
  BuildCompiler,
  CenterEventScratch,
  HitScratch,
  HookName,
  Hooks,
  KillScratch,
  RuleModule,
  ShotScratch,
  SignatureModule,
  TestModule,
} from './module';
export { enqueueModuleEffect } from './api';
export type { ModuleEvent } from './api';

export const RULE_MODULES: {
  readonly [K in RuleId]: RuleModule<Extract<RuleSpec, { id: K }>>;
} = {
  steadyAim,
  eternalFlame,
  overload,
  glassCannon,
  farThrow,
  volcano,
  chainBlast,
  icicle,
  prism,
  sixCoils,
  frostflame,
  absoluteZero,
  gigantism,
  blastSpirit,
  poisonSlow,
  lockBeacon,
  cannon,
  teslaTower,
  bugSea,
  hiveSplit,
  swarmTune,
  colossus,
  hiveExpand,
  hiveBuild,
  queenRole,
  hammerRole,
  focusFire,
  outpost,
  selfDestruct,
  interceptors,
  swarmSurge,
  royalJelly,
  breed,
  motherFactory,
  pyreChain,
  zoneTune,
  flameBee,
  frostBee,
  thermalShock,
  superconduct,
  frostSentry,
  plasma,
  stormWeb,
  hemorrhage,
  bulletRain,
  shatterChain,
  bulletHell,
  barrageFan,
  barrageRing,
  clusterShot,
  barrageFocus,
  frozenNoSplit,
};

export const SIGNATURES: {
  readonly [K in SignatureId]: SignatureModule<Extract<SignatureSpec, { id: K }>>;
} = {
  m1Volley,
  magmaBomb,
  iceFan,
  triphaseArc,
  swarm,
};
