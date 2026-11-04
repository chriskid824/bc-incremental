/**
 * The one place the v3 page tells the renderer which character it draws: the character's looks
 * (RendererOptions.character, src/render/characterLook.ts) from its web and the run's progress,
 * the owned fusion cores' skins included, read as the replay reads them (characterLookOf).
 */

import type { AssembledWeb } from '../../data/web';
import type { CharacterProgress } from '../../meta/web';
import type { RendererOptions } from '../../render';
import { characterLookOf } from '../replay/build';

export function characterRendererOptions(
  web: AssembledWeb,
  progress: CharacterProgress,
): Pick<RendererOptions, 'character'> {
  const look = characterLookOf({ web, progress });
  return look === null ? {} : { character: look };
}
