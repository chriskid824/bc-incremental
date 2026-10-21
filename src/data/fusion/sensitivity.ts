/**
 * A fusion's coefficient range (docs/v3 C6 design §4.2, D10; F6): the bracket calibration
 * bisects in and the fuzz runs the ends of, inside which every effect of the core stays legal,
 * read from what the coef scales on the core: its triggers' COEF fields and chances, and its
 * rules' RULE_COEF_FIELDS. null when the coef moves nothing there (insensitive, a FAIL).
 */

import { RULE_COEF_FIELDS } from '../rules';
import type { CoefFieldKind } from '../rules';
import { COEF_FIELDS, COEF_MAX, COEF_MIN } from '../triggers';
import type { EffectSpec, TriggerSpec } from '../triggers';
import type { FusionDef } from '../web/types';

/**
 * The chance a chainJump trigger fires at before its coef: src/sim/effects/types.ts'
 * CHAIN_JUMP_CHANCE, which src/data does not import (sensitivity.test.ts pins the two equal).
 */
const CHAIN_JUMP_CHANCE = 0.3;
/** A transfer's effect × coef stays below 1 (V8; ARCH:238): effect e caps coef at 0.99 / e. */
const TRANSFER_TOP = 0.99;

/** [lo, hi], COEF_MIN ≤ lo ≤ hi ≤ COEF_MAX. */
export type CoefRange = readonly [lo: number, hi: number];

/** A trigger's chance before its coef, as compileTrigger reads it: its last chance condition. */
function chanceOf(trigger: TriggerSpec): number {
  let chance = trigger.on === 'chainJump' ? CHAIN_JUMP_CHANCE : 1;
  for (const condition of trigger.when ?? []) if ('chance' in condition) chance = condition.chance;
  return chance;
}

/**
 * True when the effect has a COEF field whose value, 1 when left out, is above 0. A zone's
 * ailmentDamagePct counts only with its ailment: without one it scales nothing (a 0-damage zone
 * is insensitive, §4.2).
 */
function scalesDamage(effect: EffectSpec): boolean {
  const values = effect as unknown as Readonly<Record<string, number | undefined>>;
  const idle = (field: string): boolean =>
    effect.kind === 'groundZone' && field === 'ailmentDamagePct' && effect.ailment === undefined;
  return (COEF_FIELDS[effect.kind] as readonly string[]).some(
    (field) => !idle(field) && (values[field] ?? 1) > 0,
  );
}

/**
 * The fusion's coef range from its core (§4.2's table, in order): [COEF_MIN, COEF_MAX] with a
 * COEF field above 0 or a pct or mult rule field, its top lowered to 0.99 / e by each transfer of
 * effect e; else [COEF_MIN, 1 / p] with a trigger's chance p < 1 (a chance condition, chainJump's
 * 0.3) or a rule's chance field p, p the largest; else [COEF_MIN, COEF_MAX] under
 * coefScalesBonus, which scales the bonus and r3; else null. A rule field counts when its spec
 * holds it, as scaleRuleSpec scales it (`fields` defaults to RULE_COEF_FIELDS). Never outside
 * [COEF_MIN, COEF_MAX].
 */
export function coefRange(
  fusion: FusionDef,
  fields: typeof RULE_COEF_FIELDS = RULE_COEF_FIELDS,
): CoefRange | null {
  const core = fusion.board.nodes.find((node) => node.kind === 'core');
  if (core === undefined) return null;
  let damage = false;
  let chance: number | null = null;
  let top = COEF_MAX;
  for (const trigger of core.effects.triggers) {
    const p = chanceOf(trigger);
    if (p < 1) chance = Math.max(chance ?? p, p);
    for (const effect of trigger.do) {
      if (scalesDamage(effect)) damage = true;
      if (effect.kind === 'spreadAilment') top = Math.min(top, TRANSFER_TOP / (effect.effect ?? 1));
    }
  }
  for (const rule of core.effects.rules) {
    const entry = fields[rule.id] as Readonly<Record<string, CoefFieldKind>> | undefined;
    const values: Readonly<Record<string, unknown>> = rule;
    for (const [field, kind] of Object.entries(entry ?? {})) {
      const value = values[field];
      if (typeof value !== 'number') continue; // a field the spec leaves out stays out
      if (kind === 'chance') chance = Math.max(chance ?? value, value);
      else damage = true;
    }
  }
  const hi = damage
    ? COEF_MAX
    : chance !== null
      ? 1 / chance
      : fusion.coefScalesBonus
        ? COEF_MAX
        : null;
  if (hi === null) return null;
  return [COEF_MIN, Math.max(COEF_MIN, Math.min(hi, top))]; // top ≤ COEF_MAX from its start
}
