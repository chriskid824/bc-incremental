/**
 * The IPC channels between the Steam build's preload (./preload.ts) and the main process
 * (./ipc.ts), every one synchronous (`ipcRenderer.sendSync`; docs/v3 C9 design §1.3, C9/F16): the
 * page's SaveStorage is synchronous, and only a synchronous call completes during `pagehide`.
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
  // C9.2b adds the check mode's six bc:check:* channels here.
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];
