/**
 * The game's sound: procedural cues now, a licensed pack's files later (./cues.ts). Web Audio is
 * the same in a browser and in the Electron shell, so no platform interface is needed for it.
 */

export { browserAudioContext } from './context';
export type { AudioContextFactory, AudioContextLike } from './context';
export { CUE_IDS, CUES } from './cues';
export type { CueDef, CueId, SynthLayer } from './cues';
export { AudioEngine, DEFAULT_VOLUME, MAX_VOICES } from './engine';
export type { AudioEngineOptions, AudioStats, PlayOptions } from './engine';
export { readMuted, writeMuted, MUTED_KEY } from './prefs';
export { SimAudio, explosionOptions, EXPLOSION_RADIUS_REF } from './simAudio';
export type { CuePlayer, KillTierOf } from './simAudio';
