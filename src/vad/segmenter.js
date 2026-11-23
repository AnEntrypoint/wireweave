import { DEFAULT_VAD_CONFIG, FRAME_MS, msToFrames, RNNOISE_FRAME_SAMPLES } from './constants.js';
import { judgeClip } from './clip-filter.js';

export class ClipSegmenter {
  constructor({ config = DEFAULT_VAD_CONFIG, keepPcm = false } = {}) {
    this.config = config;
    this.keepPcm = keepPcm;
    this.hangoverFrames = msToFrames(config.hangoverMs);
    this.prerollFrames = msToFrames(config.prerollMs);
    this.maxClipFrames = msToFrames(config.maxClipMs);
    this.reset();
  }

  reset() {
    this.active = false;
    this.preroll = [];
    this.confirm = 0;
    this.scores = [];
    this.energies = [];
    this.frames = [];
    this.belowStop = 0;
    this.voicedCount = 0;
    this.energySum = 0;
    this.energySumSquares = 0;
    this.energyCount = 0;
    this.startIndex = 0;
  }

  _trackEnergy(energyDb) {
    if (energyDb === null) return;
    this.energySum += energyDb;
    this.energySumSquares += energyDb * energyDb;
    this.energyCount++;
  }

  get _energyStdDb() {
    if (!this.energyCount) return Infinity;
    const mean = this.energySum / this.energyCount;
    return Math.sqrt(Math.max(0, this.energySumSquares / this.energyCount - mean * mean));
  }

  get liveVoiced() {
    if (!this.active) return false;
    const core = this.scores.length - this.belowStop;
    if (core <= 0) return false;
    const voicedLongEnough = this.voicedCount * FRAME_MS >= this.config.liveMinVoicedMs && this.voicedCount / core >= this.config.minVoicedRatio;
    const settled = core * FRAME_MS >= this.config.liveStdAfterMs;
    return voicedLongEnough && (!settled || this._energyStdDb >= this.config.minEnergyStdDb);
  }

  push(smoothed, frame, frameIndex, energyDb = null) {
    const copy = this.keepPcm ? Float32Array.from(frame) : null;
    if (!this.active) return this._idle(smoothed, copy, frameIndex, energyDb);
    return this._active(smoothed, copy, energyDb);
  }

  _idle(smoothed, copy, frameIndex, energyDb) {
    if (this.keepPcm) {
      this.preroll.push(copy);
      if (this.preroll.length > this.prerollFrames) this.preroll.shift();
    }
    this.confirm = smoothed >= this.config.startThreshold ? this.confirm + 1 : 0;
    if (this.confirm < this.config.startConfirmFrames) return null;
    this.active = true;
    this.belowStop = 0;
    this.scores = [smoothed];
    this.voicedCount = smoothed >= this.config.voicedFrameThreshold ? 1 : 0;
    this.energies = [energyDb];
    this._trackEnergy(energyDb);
    this.frames = this.keepPcm ? this.preroll.slice() : [];
    this.startIndex = frameIndex;
    this.preroll = [];
    return null;
  }

  _active(smoothed, copy, energyDb) {
    this.scores.push(smoothed);
    this.energies.push(energyDb);
    this._trackEnergy(energyDb);
    if (smoothed >= this.config.voicedFrameThreshold) this.voicedCount++;
    if (this.keepPcm) this.frames.push(copy);
    this.belowStop = smoothed < this.config.stopThreshold ? this.belowStop + 1 : 0;
    if (this.belowStop >= this.hangoverFrames || this.scores.length >= this.maxClipFrames) return this._finish();
    return null;
  }

  flush() {
    return this.active ? this._finish() : null;
  }

  _finish() {
    const core = this.scores.slice(0, this.scores.length - this.belowStop);
    const coreEnergies = this.energies.slice(0, core.length);
    const verdict = judgeClip(core, this.config, coreEnergies.every((e) => e !== null) ? coreEnergies : null);
    const clip = {
      ...verdict,
      startFrame: this.startIndex,
      endFrame: this.startIndex + core.length,
      durationMs: core.length * FRAME_MS,
      scores: core,
      pcm: this.keepPcm ? joinFrames(this.frames) : null
    };
    this.reset();
    return clip;
  }
}

const joinFrames = (frames) => {
  const out = new Float32Array(frames.length * RNNOISE_FRAME_SAMPLES);
  frames.forEach((f, i) => out.set(f, i * RNNOISE_FRAME_SAMPLES));
  return out;
};
