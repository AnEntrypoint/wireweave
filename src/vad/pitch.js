import { RNNOISE_FRAME_SAMPLES, SILENCE_FLOOR_DB } from './constants.js';

const DECIMATION = 6;
const DECIMATED_RATE = 8000;
const WINDOW_FRAMES = 3;
const FRAME_DECIMATED = RNNOISE_FRAME_SAMPLES / DECIMATION;
const WINDOW_SAMPLES = FRAME_DECIMATED * WINDOW_FRAMES;
const MIN_LAG = 20;
const MAX_LAG = 133;
const MIN_ENERGY_DB = -75;

export class PitchTracker {
  constructor() {
    this.window = new Float32Array(WINDOW_SAMPLES);
    this.squares = new Float64Array(WINDOW_SAMPLES + 1);
  }

  push(frame) {
    this.window.copyWithin(0, FRAME_DECIMATED);
    const offset = WINDOW_SAMPLES - FRAME_DECIMATED;
    for (let i = 0; i < FRAME_DECIMATED; i++) {
      let sum = 0;
      for (let k = 0; k < DECIMATION; k++) sum += frame[i * DECIMATION + k];
      this.window[offset + i] = sum / DECIMATION;
    }
    return this._analyse();
  }

  _analyse() {
    const x = this.window;
    for (let i = 0; i < WINDOW_SAMPLES; i++) this.squares[i + 1] = this.squares[i] + x[i] * x[i];
    const meanSquare = this.squares[WINDOW_SAMPLES] / WINDOW_SAMPLES;
    if (10 * Math.log10(meanSquare + 1e-12) < Math.max(MIN_ENERGY_DB, SILENCE_FLOOR_DB)) return { periodicity: 0, f0: 0 };
    let best = 0;
    let bestLag = 0;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      let cross = 0;
      for (let i = 0; i + lag < WINDOW_SAMPLES; i++) cross += x[i] * x[i + lag];
      const head = this.squares[WINDOW_SAMPLES - lag];
      const tail = this.squares[WINDOW_SAMPLES] - this.squares[lag];
      const r = cross / Math.sqrt(head * tail + 1e-12);
      if (r > best) { best = r; bestLag = lag; }
    }
    return { periodicity: best, f0: bestLag ? DECIMATED_RATE / bestLag : 0 };
  }
}
