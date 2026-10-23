/**
 * The Steam build's preload (docs/v3 C9 design §1.3): it runs sandboxed, as CommonJS that may
 * require only `electron`, before the page, and puts one frozen NativeBridge on the page's global
 * object under bcNative (src/platform/steam/bridge.ts; ARCH §11's minimal API: storage,
 * achievements, steamInfo). Each function sends exactly its declared arguments on its own channel
 * (./channels.ts) and returns the main process's answer; the page gets no ipcRenderer, no channel
 * of its choosing and no listener.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_VERSION, NATIVE_BRIDGE_KEY } from '../src/platform/steam/bridge';
import type { NativeBridge, SaveWriteResult, ShellInfo } from '../src/platform/steam/bridge';
import type { SaveSlot } from '../src/platform/storage';
import { CHANNELS } from './channels';

const bridge: NativeBridge = Object.freeze({
  version: BRIDGE_VERSION,
  steamInfo: (): ShellInfo => ipcRenderer.sendSync(CHANNELS.info),
  storage: Object.freeze({
    read: (slot: SaveSlot): string | null => ipcRenderer.sendSync(CHANNELS.saveRead, slot),
    write: (slot: SaveSlot, text: string): SaveWriteResult =>
      ipcRenderer.sendSync(CHANNELS.saveWrite, slot, text),
  }),
  achievements: Object.freeze({
    unlock: (id: string): boolean => ipcRenderer.sendSync(CHANNELS.achUnlock, id),
    isUnlocked: (id: string): boolean => ipcRenderer.sendSync(CHANNELS.achIsUnlocked, id),
  }),
  // C9.2b adds `check` (CheckBridge) here, only when one sendSync(CHANNELS.info) says checkMode.
});

contextBridge.exposeInMainWorld(NATIVE_BRIDGE_KEY, bridge);
