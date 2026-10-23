/// <reference types="vite/client" />
/**
 * The platform of this build (docs/ARCHITECTURE.md §7; docs/v3 C9 design §1.1, §1.7, C9/F9):
 * `vite build --mode steam` makes the Steam build's, every other mode the web build's. MODE is a
 * literal once Vite has built the page, so Rollup drops the other platform's modules; neither
 * runs anything on import. (The reference above types import.meta.env for the tools' tsconfig too,
 * which compiles this module through the tests.)
 */

import type { Platform, PlatformSetup } from './platform';
import { createSteamPlatform } from './steam';
import { createWebPlatform } from './web';

export { openKeyValueStore } from './platform';
export type { AnalyticsPolicy, Platform, PlatformId, PlatformSetup } from './platform';

export function createPlatform(setup: PlatformSetup): Platform {
  return import.meta.env.MODE === 'steam' ? createSteamPlatform(setup) : createWebPlatform(setup);
}
