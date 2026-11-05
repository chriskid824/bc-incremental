/**
 * Which Steam app this Electron shell is built for. `BC_RELEASE` at build time
 * (vite.electron.config.ts writes it into main.cjs as __BC_RELEASE__):
 *
 * - unset or `dev`: the C9 check build, run from a terminal on Spacewar (App ID 480) with the
 *   M1 page, as before.
 * - `demo`: Archefuse Demo (App ID 5560180) on the v3 game page; pair it with VITE_FLAVOR=demo.
 * - `full`: Archefuse (App ID 5554510) on the v3 game page; pair it with VITE_FLAVOR=full.
 *
 * tools/steam/package.ts builds and packages the demo and full releases for SteamPipe.
 */

import { APP_FOLDER } from './paths';
import { SPACEWAR_APP_ID } from './steam';

export type Release = 'dev' | 'demo' | 'full';

/** Archefuse's App ID on Steam. */
export const ARCHEFUSE_APP_ID = 5554510;

/** Archefuse Demo's App ID on Steam. */
export const ARCHEFUSE_DEMO_APP_ID = 5560180;

export interface ReleaseSetup {
  readonly release: Release;
  /** The App ID steamworks.js starts Steam with. */
  readonly appId: number;
  /** The page, in dist-steam/, the game window opens. */
  readonly page: 'index.html' | 'game.html';
  /** The name in error dialogs. */
  readonly title: string;
  /**
   * The userData folder under appData, and so the Auto-Cloud path (electron/paths.ts): one per
   * release, so the demo and the full game keep apart saves on one PC and in Steam Cloud.
   */
  readonly folder: string;
}

/** Reads BC_RELEASE; anything other than dev, demo or full is an error. */
export function parseRelease(raw: string | undefined): Release {
  if (raw === undefined || raw === '' || raw === 'dev') return 'dev';
  if (raw === 'demo' || raw === 'full') return raw;
  throw new Error(`BC_RELEASE must be 'dev', 'demo' or 'full' (or unset, for dev), not '${raw}'`);
}

export function releaseSetup(release: Release): ReleaseSetup {
  switch (release) {
    case 'dev':
      return {
        release,
        appId: SPACEWAR_APP_ID,
        page: 'index.html',
        title: 'bc-incremental',
        folder: APP_FOLDER,
      };
    case 'demo':
      return {
        release,
        appId: ARCHEFUSE_DEMO_APP_ID,
        page: 'game.html',
        title: 'Archefuse Demo',
        folder: 'archefuse-demo',
      };
    case 'full':
      return {
        release,
        appId: ARCHEFUSE_APP_ID,
        page: 'game.html',
        title: 'Archefuse',
        folder: 'archefuse',
      };
  }
}

declare const __BC_RELEASE__: string | undefined;

/** This build's release, from the value vite.electron.config.ts wrote in (dev when absent). */
export function builtRelease(): ReleaseSetup {
  return releaseSetup(
    parseRelease(typeof __BC_RELEASE__ === 'string' ? __BC_RELEASE__ : undefined),
  );
}
