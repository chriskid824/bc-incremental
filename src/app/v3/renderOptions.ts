/**
 * The one place the v3 page tells the renderer which character it draws. Today's RendererOptions
 * knows only `construct: 'hive'` (蜂巢's comb, drones and turrets); every other character gets
 * M1's center until the renderer draws v3 constructs and arenas, when this maps CharacterDef's
 * construct (and arena) to that option instead.
 */

import type { CharacterDef } from '../../data/web';
import type { RendererOptions } from '../../render';

export function characterRendererOptions(def: CharacterDef): Pick<RendererOptions, 'construct'> {
  return def.construct === 'hive' ? { construct: 'hive' } : {};
}
