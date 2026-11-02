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
}

/** The skin of the owned fusion with `outer`, or null when the build does not own its core. */
export function fusionSkin(look: CharacterLook, outer: OuterId): Skin | null {
  for (const fusion of look.fusions) if (fusion.outer === outer) return fusion.skin;
  return null;
}

/**
 * Hit numbers' colour on a character run: the character colour lifted a quarter toward white, so
 * a number stays readable on the character's dark arena (gd §11.6).
 */
export function hitNumberColor(look: CharacterLook): number {
  return mixColor(look.color, 0xffffff, 0.25);
}
