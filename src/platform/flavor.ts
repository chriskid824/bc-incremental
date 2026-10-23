/**
 * The build's flavor, `VITE_FLAVOR=demo|full` (docs/ARCHITECTURE.md §7; docs/v3 C9 design §1.6):
 * the demo's content cap (B2), its analytics default and the wishlist button (M3) will read FLAVOR;
 * C9 reads nothing from it. vite.config.ts parses the same variable, so a bad value fails the build
 * before any page could read it.
 */

export type Flavor = 'demo' | 'full';

/** Unset, empty or `full` is the full game, `demo` the demo; anything else throws. */
export function parseFlavor(raw: string | undefined): Flavor {
  if (raw === undefined || raw === '' || raw === 'full') return 'full';
  if (raw === 'demo') return 'demo';
  throw new Error(`VITE_FLAVOR must be 'demo' or 'full' (or unset, for full), not '${raw}'`);
}

/**
 * This build's flavor. Vite writes VITE_FLAVOR into the page; `?.` because vite.config.ts loads
 * this module in Node, where import.meta.env does not exist (the config reads the variable
 * through loadEnv instead).
 */
export const FLAVOR: Flavor = parseFlavor(import.meta.env?.VITE_FLAVOR);
