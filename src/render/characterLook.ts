/**
 * What the renderer needs to draw a v3 character run (docs/v3/implementation-plan-v3.md §7 每個
 * 角色 item 3): the character's construct, arena and colour (CharacterDef.construct, .arena,
 * .color) and the fusion cores the build owns with their skins (FusionDef.skin), whose looks
 * come in within 2 s of the core (the 2-second rule). The caller (src/app/replay) reads them off
 * the run's web and progress; the renderer never sees the web.
 */

import type { OuterId } from '../data/sources';
import type { ConstructId, Skin } from '../data/web/types';
import { mixColor } from './palette';

export interface FusionLook {
  readonly outer: OuterId;
  readonly skin: Skin;
}

export interface CharacterLook {
  readonly construct: ConstructId;
  /** CharacterDef.arena: the backdrop's key (createArenaBackdrop). */
  readonly arena: string;
  /** CharacterDef.color, 0xRRGGBB. */
  readonly color: number;
  /** The owned fusion cores, in any order. */
  readonly fusions: readonly FusionLook[];
  /**
   * The owned cores' outers in fusion-slot order (fusionSlotOrder, src/meta/web/rules.ts):
   * 蜂巢's drones take their fill from slot 1's skin, their trail from slot 2's and their impact
   * from slot 3's (gd §5.3). Left out: `fusions` in their order.
   */
  readonly slots?: readonly OuterId[];
  /** The build owns a node that places drones or turrets (the summon outer's grants). */
  readonly summons: boolean;
}

/** The skin of the owned fusion with `outer`, or null when the build does not own its core. */
export function fusionSkin(look: CharacterLook, outer: OuterId): Skin | null {
  for (const fusion of look.fusions) if (fusion.outer === outer) return fusion.skin;
  return null;
}

/**
 * The owned fusions' skins in fusion-slot order (CharacterLook.slots, else `fusions` in their
 * order); a slot whose outer has no owned fusion is skipped.
 */
export function slotSkins(look: CharacterLook): Skin[] {
  if (look.slots === undefined) return look.fusions.map((fusion) => fusion.skin);
  const skins: Skin[] = [];
  for (const outer of look.slots) {
    const skin = fusionSkin(look, outer);
    if (skin !== null) skins.push(skin);
  }
  return skins;
}

/**
 * Hit numbers' colour on a character run: the character colour lifted a quarter toward white, so
 * a number stays readable on the character's dark arena (gd §11.6).
 */
export function hitNumberColor(look: CharacterLook): number {
  return mixColor(look.color, 0xffffff, 0.25);
}
