/**
 * The audio engine: plays the cues of ./cues.ts through one master gain, under strict limits so a
 * big wave does not turn into noise: a per-cue cooldown, a per-cue voice cap and an overall voice
 * cap (high-priority cues pass the last). The AudioContext is made on the first unlock(), which
 * the page calls from a user gesture, as browsers require; until then, and while muted, plays are
 * skipped. A cue with a file plays the decoded file once it has loaded, its recipe until then.
 */

import type {
  AudioBufferLike,
  AudioContextFactory,
  AudioContextLike,
  AudioNodeLike,
  GainNodeLike,
  ScheduledSourceLike,
} from './context';
import { CUE_IDS, CUES } from './cues';
import type { CueDef, CueId, SynthLayer } from './cues';

/** Voices of all normal-priority cues that may sound at once. */
export const MAX_VOICES = 12;
/** The default master volume, kept moderate. */
export const DEFAULT_VOLUME = 0.4;
/** Seconds of white noise the noise layers loop over. */
const NOISE_SECONDS = 1;
/** Envelope floor: exponential ramps cannot reach 0. */
const SILENT = 0.0001;
const MIN_ATTACK = 0.001;

export interface PlayOptions {
  /** Gain on top of the cue's volume, clamped to [0, 2]. */
  readonly gain?: number;
  /** Frequency (or playback rate) multiplier, clamped to [0.25, 4]. */
  readonly pitch?: number;
}

export interface AudioEngineOptions {
  readonly createContext: AudioContextFactory;
  readonly volume?: number;
  readonly muted?: boolean;
  /** Files that replace cues' recipes (a licensed pack), over CUES' own `file`s. */
  readonly files?: Partial<Record<CueId, string>>;
  /** Fetches a cue file; the page's fetch by default. */
  readonly fetchFile?: (url: string) => Promise<ArrayBuffer>;
  /** Pitch jitter's randomness; Math.random by default (audio is not part of the sim). */
  readonly random?: () => number;
  /** The registry; tests pass their own. */
  readonly cues?: Readonly<Record<CueId, CueDef>>;
}

export interface AudioStats {
  readonly played: Record<CueId, number>;
  /** Plays the cooldowns and voice caps dropped. */
  dropped: number;
  /** Plays skipped before unlock, while muted, or with no audio. */
  skipped: number;
}

function zeroCounts(): Record<CueId, number> {
  const counts = {} as Record<CueId, number>;
  for (const id of CUE_IDS) counts[id] = 0;
  return counts;
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

async function defaultFetch(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.arrayBuffer();
}

export class AudioEngine {
  readonly stats: AudioStats = { played: zeroCounts(), dropped: 0, skipped: 0 };
  private readonly createContext: AudioContextFactory;
  private readonly cues: Readonly<Record<CueId, CueDef>>;
  private readonly files: Partial<Record<CueId, string>>;
  private readonly fetchFile: (url: string) => Promise<ArrayBuffer>;
  private readonly random: () => number;
  private ctx: AudioContextLike | null = null;
  private master: GainNodeLike | null = null;
  private noise: AudioBufferLike | null = null;
  private readonly buffers = new Map<CueId, AudioBufferLike>();
  /** Each cue's sounding voices, as the context times they end. */
  private readonly voices = new Map<CueId, number[]>();
  private readonly lastAt = new Map<CueId, number>();
  private volumeValue: number;
  private mutedValue: boolean;
  private contextFailed = false;

  constructor(options: AudioEngineOptions) {
    this.createContext = options.createContext;
    this.cues = options.cues ?? CUES;
    this.volumeValue = clamp(options.volume ?? DEFAULT_VOLUME, 0, 1);
    this.mutedValue = options.muted ?? false;
    this.random = options.random ?? Math.random;
    this.fetchFile = options.fetchFile ?? defaultFetch;
    const files: Partial<Record<CueId, string>> = {};
    for (const id of CUE_IDS) {
      const file = options.files?.[id] ?? this.cues[id].file;
      if (file !== undefined) files[id] = file;
    }
    this.files = files;
  }

  get muted(): boolean {
    return this.mutedValue;
  }

  set muted(on: boolean) {
    this.mutedValue = on;
    this.applyVolume();
  }

  get volume(): number {
    return this.volumeValue;
  }

  set volume(value: number) {
    this.volumeValue = clamp(value, 0, 1);
    this.applyVolume();
  }

  /** Whether plays can sound now: unlocked, running and not muted. */
  get live(): boolean {
    return !this.mutedValue && this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * Makes the AudioContext on the first call and resumes it; call from a user gesture. Later
   * calls only resume a suspended context. A page with no Web Audio stays silent.
   */
  unlock(): void {
    if (this.ctx === null && !this.contextFailed) {
      const ctx = this.createContext();
      if (ctx === null) {
        this.contextFailed = true;
        return;
      }
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.applyVolume();
      this.noise = this.makeNoise(ctx);
      this.loadFiles(ctx);
    }
    if (this.ctx !== null && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => undefined);
    }
  }

  /** Plays `cue` unless a limit drops it; answers whether it sounded. */
  play(cue: CueId, options: PlayOptions = {}): boolean {
    const ctx = this.ctx;
    const master = this.master;
    if (this.mutedValue || ctx === null || master === null || ctx.state !== 'running') {
      this.stats.skipped++;
      return false;
    }
    const def = this.cues[cue];
    const now = ctx.currentTime;
    const last = this.lastAt.get(cue);
    if (last !== undefined && (now - last) * 1000 < def.cooldownMs) {
      this.stats.dropped++;
      return false;
    }
    const mine = this.prune(cue, now);
    if (mine.length >= def.maxVoices) {
      this.stats.dropped++;
      return false;
    }
    if (def.priority === 'normal' && this.activeVoices(now) >= MAX_VOICES) {
      this.stats.dropped++;
      return false;
    }
    const gain = def.volume * clamp(options.gain ?? 1, 0, 2);
    const jitter = def.pitchJitter > 0 ? 1 + (this.random() * 2 - 1) * def.pitchJitter : 1;
    const pitch = clamp((options.pitch ?? 1) * jitter, 0.25, 4);
    const buffer = this.buffers.get(cue);
    const end =
      buffer !== undefined
        ? this.playBuffer(ctx, master, buffer, now, gain, pitch)
        : this.playRecipe(ctx, master, def.layers, now, gain, pitch);
    mine.push(end);
    this.lastAt.set(cue, now);
    this.stats.played[cue]++;
    return true;
  }

  /** Voices sounding at the context's time `now`, across all cues. */
  activeVoices(now = this.ctx?.currentTime ?? 0): number {
    let count = 0;
    for (const id of CUE_IDS) count += this.prune(id, now).length;
    return count;
  }

  private prune(cue: CueId, now: number): number[] {
    let list = this.voices.get(cue);
    if (list === undefined) {
      list = [];
      this.voices.set(cue, list);
    }
    let kept = 0;
    for (const end of list) if (end > now) list[kept++] = end;
    list.length = kept;
    return list;
  }

  private applyVolume(): void {
    if (this.master === null || this.ctx === null) return;
    this.master.gain.setValueAtTime(this.mutedValue ? 0 : this.volumeValue, this.ctx.currentTime);
  }

  private makeNoise(ctx: AudioContextLike): AudioBufferLike {
    const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private loadFiles(ctx: AudioContextLike): void {
    for (const id of CUE_IDS) {
      const url = this.files[id];
      if (url === undefined) continue;
      this.fetchFile(url)
        .then((data) => ctx.decodeAudioData(data))
        .then((buffer) => this.buffers.set(id, buffer))
        .catch((error: unknown) => console.warn(`Audio cue ${id}: ${url} did not load`, error));
    }
  }

  private playBuffer(
    ctx: AudioContextLike,
    master: AudioNodeLike,
    buffer: AudioBufferLike,
    now: number,
    gain: number,
    pitch: number,
  ): number {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(pitch, now);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, now);
    source.connect(amp);
    amp.connect(master);
    const end = now + buffer.duration / pitch;
    this.schedule(source, [source, amp], now, end);
    return end;
  }

  private playRecipe(
    ctx: AudioContextLike,
    master: AudioNodeLike,
    layers: readonly SynthLayer[],
    now: number,
    gain: number,
    pitch: number,
  ): number {
    let cueEnd = now;
    for (const layer of layers) {
      const start = now + (layer.delay ?? 0);
      const attack = Math.max(MIN_ATTACK, layer.attack);
      const end = start + attack + layer.decay;
      cueEnd = Math.max(cueEnd, end);
      const nodes: AudioNodeLike[] = [];
      let source: ScheduledSourceLike;
      if (layer.wave === 'noise') {
        const noise = ctx.createBufferSource();
        noise.buffer = this.noise;
        noise.loop = true;
        noise.playbackRate.setValueAtTime(layer.freq * pitch, start);
        source = noise;
      } else {
        const osc = ctx.createOscillator();
        osc.type = layer.wave;
        osc.frequency.setValueAtTime(layer.freq * pitch, start);
        if (layer.freqEnd !== undefined) {
          osc.frequency.exponentialRampToValueAtTime(layer.freqEnd * pitch, end);
        }
        source = osc;
      }
      nodes.push(source);
      let tail: AudioNodeLike = source;
      if (layer.filter !== undefined) {
        const filter = ctx.createBiquadFilter();
        filter.type = layer.filter.type;
        filter.frequency.setValueAtTime(layer.filter.freq * pitch, start);
        if (layer.filter.freqEnd !== undefined) {
          filter.frequency.exponentialRampToValueAtTime(layer.filter.freqEnd * pitch, end);
        }
        filter.Q.setValueAtTime(layer.filter.q ?? 1, start);
        tail.connect(filter);
        tail = filter;
        nodes.push(filter);
      }
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(SILENT, start);
      amp.gain.linearRampToValueAtTime(Math.max(SILENT, layer.gain * gain), start + attack);
      amp.gain.exponentialRampToValueAtTime(SILENT, end);
      tail.connect(amp);
      amp.connect(master);
      nodes.push(amp);
      this.schedule(source, nodes, start, end);
    }
    return cueEnd;
  }

  /** Starts `source` at `start`, stops it after `end`, and frees its nodes when it ends. */
  private schedule(
    source: ScheduledSourceLike,
    nodes: readonly AudioNodeLike[],
    start: number,
    end: number,
  ): void {
    source.onended = () => {
      for (const node of nodes) node.disconnect();
    };
    source.start(start);
    source.stop(end + 0.02);
  }
}
