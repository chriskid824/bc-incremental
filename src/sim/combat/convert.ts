/**
 * Conversion (docs/v3/implementation-plan-v3.md §2.7): part of a hit's damage turns into another
 * damage type before modifiers. A hit whose ModTable row has conversion parts
 * (ModTable.convCount) splits its base damage among them: the share no conversion takes stays a
 * hit, on the hit's row, and each conversion's share takes the row of its converted tags
 * (convertMask, src/data/tags.ts) under the hit's source. A part thus keeps the hit's delivery
 * tags, crit and source, and the modifiers of its new kind apply to it: a drone's poison part
 * still takes the [minion] bonuses. The parts are one hit: one hp loss, one hit event, and a tally
 * per part, damage over time by its kind (src/sim/combat/hit.ts). A converted part applies no
 * ailment; the hit's own rolls on its own row do. Making a part an ailment application instead is
 * the open alternative, and would change only this file.
 */

import type { Num } from '../../core/num';
import { add, mul, ZERO } from '../../core/num';
import { statAt } from '../build/eval';
import type { EvalInput } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { SOURCE_SHIFT } from '../build/sources';
import type { RunContext } from '../systems/context';

const DAMAGE = SCOPED_INDEX.damage;

/** The tag bits of a row key. */
const TAG_BITS = (1 << SOURCE_SHIFT) - 1;

/**
 * The damage of a hit of `base` (crit and chain retention applied) whose ModTable row `row`
 * converts: each part's share of `base` × its own row's damage multiplier for the instance `ev`,
 * added up in the row's part order. The parts go to RunContext.hitParts for the tallies.
 */
export function convertHit(ctx: RunContext, row: number, base: Num, ev: Readonly<EvalInput>): Num {
  const table = ctx.table;
  const parts = ctx.hitParts;
  const start = table.convStart[row] as number;
  const count = table.convCount[row] as number;
  let total = ZERO;
  for (let i = 0; i < count; i++) {
    const j = start + i;
    // Look the part's row up first: filling it may grow, and so replace, the table's arrays.
    const partRow = table.partRow(j);
    const amount = mul(base, (table.convShare[j] as number) * statAt(table, partRow, DAMAGE, ev));
    parts.mask[i] = (table.convKey[j] as number) & TAG_BITS;
    parts.amount[i] = amount;
    total = i === 0 ? amount : add(total, amount);
  }
  parts.n = count;
  parts.total = total;
  return total;
}
