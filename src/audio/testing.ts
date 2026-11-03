/**
 * A fake AudioContext for the tests: no sound, a clock the test moves, and a log of the sources
 * it started, so the engine's limits can be checked in Node.
 */

import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadLike,
  BufferSourceLike,
  GainNodeLike,
  OscillatorLike,
} from './context';

class FakeParam implements AudioParamLike {
  value = 0;
  readonly calls: string[] = [];
  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.calls.push(`set ${value} @${time}`);
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.calls.push(`lin ${value} @${time}`);
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.calls.push(`exp ${value} @${time}`);
  }
}

class FakeNode implements AudioNodeLike {
  readonly outputs: AudioNodeLike[] = [];
  disconnected = false;
  connect(destination: AudioNodeLike): AudioNodeLike {
    this.outputs.push(destination);
    return destination;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeSource extends FakeNode {
  onended: (() => unknown) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  constructor(private readonly log: FakeSource[]) {
    super();
  }
  start(when = 0): void {
    this.startedAt = when;
    this.log.push(this);
  }
  stop(when = 0): void {
    this.stoppedAt = when;
  }
}

class FakeOscillator extends FakeSource implements OscillatorLike {
  type: OscillatorLike['type'] = 'sine';
  readonly frequency = new FakeParam();
}

class FakeBufferSource extends FakeSource implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  readonly playbackRate = new FakeParam();
}

class FakeGain extends FakeNode implements GainNodeLike {
  readonly gain = new FakeParam();
}

class FakeBiquad extends FakeNode implements BiquadLike {
  type: BiquadLike['type'] = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
}

export class FakeAudioContext implements AudioContextLike {
  currentTime = 0;
  readonly sampleRate = 8000;
  state = 'suspended';
  readonly destination = new FakeNode();
  readonly started: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  resumes = 0;

  resume(): Promise<void> {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  }
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createOscillator(): FakeOscillator {
    return new FakeOscillator(this.started);
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource(this.started);
  }
  createBiquadFilter(): FakeBiquad {
    return new FakeBiquad();
  }
  createBuffer(_channels: number, length: number): AudioBufferLike {
    const data = new Float32Array(length);
    return { duration: length / this.sampleRate, getChannelData: () => data };
  }
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    const samples = new Float32Array(Math.max(1, data.byteLength));
    return Promise.resolve({ duration: 0.5, getChannelData: () => samples });
  }
}
