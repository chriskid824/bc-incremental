/**
 * The slice of the Web Audio API the audio engine uses (src/audio/engine.ts). A browser's
 * AudioContext satisfies it; the tests pass a fake (./testing.ts), so the engine runs in Node.
 */

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface ScheduledSourceLike extends AudioNodeLike {
  start(when?: number): void;
  stop(when?: number): void;
  onended: (() => unknown) | null;
}

export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle';

export interface OscillatorLike extends ScheduledSourceLike {
  type: Waveform | 'custom';
  readonly frequency: AudioParamLike;
}

export interface AudioBufferLike {
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface BufferSourceLike extends ScheduledSourceLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  readonly playbackRate: AudioParamLike;
}

export type FilterKind = 'lowpass' | 'highpass' | 'bandpass';

export interface BiquadLike extends AudioNodeLike {
  type: FilterKind | 'lowshelf' | 'highshelf' | 'peaking' | 'notch' | 'allpass';
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  resume(): Promise<void>;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorLike;
  createBufferSource(): BufferSourceLike;
  createBiquadFilter(): BiquadLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
}

/** Makes the page's AudioContext, or null where there is none. */
export type AudioContextFactory = () => AudioContextLike | null;

/** The browser's AudioContext (webkit's on old Safari), or null outside a browser. */
export const browserAudioContext: AudioContextFactory = () => {
  const scope = globalThis as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
};
