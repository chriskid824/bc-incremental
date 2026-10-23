/**
 * The fixes a load applies to a profile (docs/v3 C8 design §1.5; §0.2 items 1 and 2; C6's D24 and
 * R4). Per character, in CHARACTER_IDS order: the renames, where an id renamed to null or merged
 * refunds everything; then any id its web lacks, or an ascendancy its web lacks, refunds
 * everything, since what such an id cost cannot be priced and would sit unseen in spent; then
 * legalize drops what no longer fits and refunds exactly that; then the loadouts lose their removed
 * ids. A character without a web (「製作中」 or outside the scope) gets the renames and their
 * refunds only. profile.ts re-exports this module, which imports it for types only.
 */

import { CHARACTER_IDS } from '../data/sources';
import type { CharacterId } from '../data/sources';
import type { AssembledWeb } from '../data/web/types';
import { legalize, refundAll } from '../meta/web/rules';
import type { AccountProgress, CharacterProgress, Wallet } from '../meta/web/types';
import { accountProgress } from './account';
import type { CharacterSlot, LoadContext, LoadoutRanks, SaveNotice, SaveProfile } from './profile';

type Renames = LoadContext['renames'];

/**
 * `ranks` through the renames (D24), read with Object.hasOwn: an id without an entry stays; one
 * mapped to an id takes its place and keeps its rank; one mapped to null is removed, and so are ids
 * that would end on one id (two renamed onto it, or one renamed onto an id stored as it is), since
 * a merge cannot be priced. `removed` lists them in key order; `ranks` is the same object when
 * nothing is renamed.
 */
function renamed(
  ranks: LoadoutRanks,
  renames: Renames,
): { readonly ranks: LoadoutRanks; readonly removed: readonly string[] } {
  const entries = Object.entries(ranks);
  const targets = entries.map(([id]) => (Object.hasOwn(renames, id) ? (renames[id] ?? null) : id));
  if (targets.every((target, i) => target === entries[i]?.[0])) return { ranks, removed: [] };
  const landing = new Map<string, number>();
  for (const target of targets) {
    if (target !== null) landing.set(target, (landing.get(target) ?? 0) + 1);
  }
  const kept: Record<string, number> = {};
  const removed: string[] = [];
  entries.forEach(([id, rank], i) => {
    const target = targets[i] ?? null;
    if (target === null || (landing.get(target) ?? 0) > 1) removed.push(id);
    else kept[target] = rank;
  });
  return { ranks: kept, removed };
}

/** True when both hold the same ids at the same ranks. */
function sameRanks(a: LoadoutRanks, b: LoadoutRanks): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((id) => b[id] === a[id]);
}

const sameWallet = (a: Wallet, b: Wallet): boolean =>
  a.shards === b.shards && a.cores === b.cores && a.resonance === b.resonance;

/** A loadout through the renames, without removed ids and, with a web, ids it lacks (step 6). */
function fixedLoadout(
  loadout: LoadoutRanks | null,
  web: AssembledWeb | null,
  renames: Renames,
): LoadoutRanks | null {
  if (loadout === null) return null;
  const { ranks } = renamed(loadout, renames);
  const kept =
    web === null
      ? ranks
      : Object.fromEntries(Object.entries(ranks).filter(([id]) => web.byId.has(id)));
  return sameRanks(kept, loadout) ? loadout : kept;
}

/** One character's slot through steps 1–6, with its notices; the same slot when nothing changes. */
function fixedSlot(
  character: CharacterId,
  slot: CharacterSlot,
  web: AssembledWeb | null,
  account: AccountProgress,
  context: LoadContext,
  notices: SaveNotice[],
): CharacterSlot {
  const stored = slot.progress;
  // 1. Renames.
  const { ranks, removed } = renamed(stored.ranks, context.renames);
  // 2. Ids outside the web: a locked board, an unregistered one, an id found nowhere.
  const outside = web === null ? [] : Object.keys(ranks).filter((id) => !web.byId.has(id));
  // 3. An ascendancy the web's character does not have.
  const slugs = web?.def.ascendancies ?? null;
  const lostSlug =
    slugs !== null &&
    stored.ascendancy !== null &&
    !slugs.some((ascendancy) => ascendancy.slug === stored.ascendancy);
  let progress: CharacterProgress =
    ranks === stored.ranks && !lostSlug
      ? stored
      : { ...stored, ranks, ascendancy: lostSlug ? null : stored.ascendancy };
  // 4. Anything marked refunds everything: wallet += spent, spent = 0.
  if (removed.length > 0 || outside.length > 0 || lostSlug) {
    progress = refundAll(progress);
    notices.push({ kind: 'refundedAll', character, ids: [...removed, ...outside] });
  }
  // 5. Legalize, kept only when it changes ranks, wallet or spent.
  if (web !== null) {
    const legal = legalize(web, progress, account, context.economy);
    const after = legal.progress;
    if (
      !sameRanks(after.ranks, progress.ranks) ||
      !sameWallet(after.wallet, progress.wallet) ||
      !sameWallet(after.spent, progress.spent)
    ) {
      const before = progress.ranks;
      const cut = Object.keys(after.ranks).filter(
        (id) => (after.ranks[id] as number) < (before[id] as number),
      );
      notices.push({ kind: 'dropped', character, ids: [...legal.dropped, ...cut] });
      progress = after;
    }
  }
  // 6. Loadouts: renamed, without removed ids or ids outside the web; no currency moves.
  const [a, b, c] = slot.loadouts;
  const loadouts = [
    fixedLoadout(a, web, context.renames),
    fixedLoadout(b, web, context.renames),
    fixedLoadout(c, web, context.renames),
  ] as const;
  const loadoutsKept = loadouts.every((loadout, i) => loadout === slot.loadouts[i]);
  if (progress === stored && loadoutsKept) return slot;
  return { ...slot, progress, loadouts: loadoutsKept ? slot.loadouts : loadouts };
}

/**
 * The profile a load keeps (§1.5): each character through the renames, the refunds of what its web
 * lacks, legalize and its loadouts' fixes, on accountProgress(p) and context.webOf(c). The notices
 * come in character order; `changed` is true when any step changed anything, and then `profile` is
 * a new object; otherwise it is `p` itself, so a clean load writes nothing.
 */
export function fixProfile(
  p: SaveProfile,
  context: LoadContext,
): {
  readonly profile: SaveProfile;
  readonly notices: readonly SaveNotice[];
  readonly changed: boolean;
} {
  const account = accountProgress(p);
  const notices: SaveNotice[] = [];
  let characters = p.characters;
  for (const c of CHARACTER_IDS) {
    const slot = p.characters[c];
    const fixed = fixedSlot(c, slot, context.webOf(c), account, context, notices);
    if (fixed !== slot) characters = { ...characters, [c]: fixed };
  }
  const changed = characters !== p.characters;
  return { profile: changed ? { ...p, characters } : p, notices, changed };
}
