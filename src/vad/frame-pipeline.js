import { RNNOISE_FRAME_SAMPLES, RNNOISE_SAMPLE_RATE } from './constants.js';

class LinearResampler {
  constructor(fromRate, toRate) {
    this.step = fromRate / toRate;
    this.position = 0;
    this.carry = null;
  }

  process(input) {
    const src = this.carry ? concat(this.carry, input) : input;
    const out = [];
    let pos = this.position;
    while (pos + 1 < src.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      out.push(src[i] * (1 - frac) + src[i + 1] * frac);
      pos += this.step;
    }
    const consumed = Math.floor(pos);
    this.carry = src.subarray(consumed);
    this.position = pos - consumed;
    return Float32Array.from(out);
  }
}

const concat = (a, b) => {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export class FramePipeline {
  constructor({ sampleRate = RNNOISE_SAMPLE_RATE, onFrame }) {
    if (typeof onFrame !== 'function') throw new Error('FramePipeline: onFrame required');
    this.onFrame = onFrame;
    this.resampler = sampleRate === RNNOISE_SAMPLE_RATE ? null : new LinearResampler(sampleRate, RNNOISE_SAMPLE_RATE);
    this.pending = new Float32Array(RNNOISE_FRAME_SAMPLES);
    this.filled = 0;
    this.framesEmitted = 0;
  }

  push(samples) {
    const mono = this.resampler ? this.resampler.process(samples) : samples;
    let read = 0;
    while (read < mono.length) {
      const take = Math.min(RNNOISE_FRAME_SAMPLES - this.filled, mono.length - read);
      this.pending.set(mono.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;
      if (this.filled === RNNOISE_FRAME_SAMPLES) {
        this.onFrame(this.pending, this.framesEmitted++);
        this.filled = 0;
      }
    }
  }
}
