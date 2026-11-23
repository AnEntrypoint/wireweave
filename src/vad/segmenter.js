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
    this.features = [];
    this.pcm = [];
    this.belowStop = 0;
    this.voicedCount = 0;
    this.energySum = 0;
    this.energySumSquares = 0;
    this.startIndex = 0;
  }

  _track(feature) {
    if (feature.smoothed >= this.config.voicedFrameThreshold) this.voicedCount++;
    this.energySum += feature.energyDb;
    this.energySumSquares += feature.energyDb * feature.energyDb;
  }

  get _energyStdDb() {
    const n = this.features.length;
    if (!n) return Infinity;
    const mean = this.energySum / n;
    return Math.sqrt(Math.max(0, this.energySumSquares / n - mean * mean));
  }

  get liveVoiced() {
    if (!this.active) return false;
    const core = this.features.length - this.belowStop;
    if (core <= 0) return false;
    const voicedLongEnough = this.voicedCount * FRAME_MS >= this.config.liveMinVoicedMs && this.voicedCount / core >= this.config.minVoicedRatio;
    const settled = core * FRAME_MS >= this.config.liveStdAfterMs;
    return voicedLongEnough && (!settled || this._energyStdDb >= this.config.minEnergyStdDb);
  }

  push(feature, frame, frameIndex) {
    const copy = this.keepPcm ? Float32Array.from(frame) : null;
    return this.active ? this._active(feature, copy) : this._idle(feature, copy, frameIndex);
  }

  _idle(feature, copy, frameIndex) {
    if (this.keepPcm) {
      this.preroll.push(copy);
      if (this.preroll.length > this.prerollFrames) this.preroll.shift();
    }
    this.confirm = feature.smoothed >= this.config.startThreshold ? this.confirm + 1 : 0;
    if (this.confirm < this.config.startConfirmFrames) return null;
    this.active = true;
    this.belowStop = 0;
    this.features = [feature];
    this.voicedCount = 0;
    this.energySum = 0;
    this.energySumSquares = 0;
    this._track(feature);
    this.pcm = this.keepPcm ? this.preroll.slice() : [];
    this.startIndex = frameIndex;
    this.preroll = [];
    return null;
  }

  _active(feature, copy) {
    this.features.push(feature);
    this._track(feature);
    if (this.keepPcm) this.pcm.push(copy);
    this.belowStop = feature.smoothed < this.config.stopThreshold ? this.belowStop + 1 : 0;
    if (this.belowStop >= this.hangoverFrames || this.features.length >= this.maxClipFrames) return this._finish();
    return null;
  }

  flush() {
    return this.active ? this._finish() : null;
  }

  _finish() {
    const core = this.features.slice(0, this.features.length - this.belowStop);
    const clip = {
      ...judgeClip(core, this.config),
      startFrame: this.startIndex,
      endFrame: this.startIndex + core.length,
      durationMs: core.length * FRAME_MS,
      frames: core,
      pcm: this.keepPcm ? joinFrames(this.pcm) : null
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
