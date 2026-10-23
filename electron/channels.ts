/**
 * The IPC channels between the Steam build's preload (./preload.ts) and the main process
 * (./ipc.ts), every one synchronous (`ipcRenderer.sendSync`; docs/v3 C9 design §1.3, C9/F16): the
 * page's SaveStorage is synchronous, and only a synchronous call completes during `pagehide`. The
 * bc:check:* channels are the check mode's (`--steam-check`, design §2.2): main answers them only
 * in that mode, and the preload exposes them only then.
 */

export const CHANNELS = {
  /** The shell's ShellInfo (src/platform/steam/bridge.ts), behind bridge.steamInfo(). */
  info: 'bc:info',
  /** A save slot's text, or null. */
  saveRead: 'bc:save:read',
  /** A save slot's new text; answers a SaveWriteResult. */
  saveWrite: 'bc:save:write',
  /** Steam's unlock of one achievement; answers whether it was accepted. */
  achUnlock: 'bc:ach:unlock',
  /** Whether Steam has the achievement unlocked. */
  achIsUnlocked: 'bc:ach:is-unlocked',
  /** Steam's clear of one achievement; answers whether it was accepted. */
  checkClear: 'bc:check:clear',
  /** Opens Steam's overlay on one dialog, `achievements` or `friends`. */
  checkOverlay: 'bc:check:overlay',
  /** The save folder's `*.json` files (SaveFileInfo). */
  checkSaves: 'bc:check:saves',
  /** Shows the save folder in the OS's file manager. */
  checkShowSaves: 'bc:check:show-saves',
  /** Saves a report as `<userData>/steam-check/report-<stamp>.txt`; answers `{ ok, where }`. */
  checkReport: 'bc:check:report',
  /** The ring buffer of the page's recent errors, oldest first. */
  checkErrors: 'bc:check:errors',
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];
