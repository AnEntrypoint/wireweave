import { DEFAULT_VAD_CONFIG, FRAME_MS } from './constants.js';

const stdDev = (values) => {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};

const median = (values) => {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

const PEAK_HALF_WINDOW = 4;
const PEAK_CONTEXT = 8;
const PEAK_PROMINENCE_DB = 4;
const ENVELOPE_FRAMES = 5;

const countEnergyPeaks = (energies) => {
  const env = energies.map((_, i) => {
    const w = energies.slice(Math.max(0, i - ENVELOPE_FRAMES + 1), i + 1);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  let peaks = 0;
  for (let i = PEAK_HALF_WINDOW; i < env.length - PEAK_HALF_WINDOW; i++) {
    let isMax = true;
    for (let k = -PEAK_HALF_WINDOW; k <= PEAK_HALF_WINDOW && isMax; k++) if (env[i + k] > env[i]) isMax = false;
    if (!isMax) continue;
    let floor = env[i];
    for (let k = -PEAK_CONTEXT; k <= PEAK_CONTEXT; k++) if (env[i + k] !== undefined && env[i + k] < floor) floor = env[i + k];
    if (env[i] - floor >= PEAK_PROMINENCE_DB) peaks++;
  }
  return peaks;
};

const semitones = (f0) => 12 * Math.log2(f0 / 100);

export const clipMetrics = (frames, config = DEFAULT_VAD_CONFIG) => {
  const voiced = (f) => f.smoothed >= config.voicedFrameThreshold;
  const first = frames.findIndex(voiced);
  let last = -1;
  for (let i = frames.length - 1; i >= 0; i--) if (voiced(frames[i])) { last = i; break; }
  if (first < 0) return null;
  const span = frames.slice(first, last + 1);
  const voicedFrames = span.filter(voiced);
  const periodic = (f) => f.periodicity >= config.periodicThreshold && f.f0 > 0;
  const periodicVoiced = voicedFrames.filter(periodic);
  const steps = [];
  for (let i = 1; i < span.length; i++) {
    if (periodic(span[i]) && periodic(span[i - 1])) steps.push(Math.abs(semitones(span[i].f0) - semitones(span[i - 1].f0)));
  }
  const voicedEnergies = voicedFrames.map((f) => f.energyDb);
  return {
    meanVoicedEnergyDb: voicedEnergies.reduce((a, b) => a + b, 0) / voicedEnergies.length,
    voicedMs: voicedFrames.length * FRAME_MS,
    voicedRatio: voicedFrames.length / span.length,
    spanMs: span.length * FRAME_MS,
    energyStdDb: stdDev(span.map((f) => f.energyDb)),
    periodicRatio: periodicVoiced.length / voicedFrames.length,
    pitchStdSemitones: stdDev(periodicVoiced.map((f) => semitones(f.f0))),
    pitchStepMedian: median(steps),
    pitchSteps: steps.length,
    energyPeaksPerSecond: countEnergyPeaks(span.map((f) => f.energyDb)) / (span.length * FRAME_MS / 1000)
  };
};

export const applyThresholds = (m, config = DEFAULT_VAD_CONFIG) => {
  if (!m) return { keep: false, reason: 'no-voice', voicedMs: 0, voicedRatio: 0, spanMs: 0 };
  const reject = (reason) => ({ keep: false, reason, ...m });
  if (m.voicedMs < config.minVoicedMs) return reject('too-short');
  if (m.voicedRatio < config.minVoicedRatio) return reject('low-voiced-ratio');
  if (m.meanVoicedEnergyDb < config.minMeanVoicedEnergyDb) return reject('too-quiet');
  if (m.energyStdDb < config.minEnergyStdDb) return reject('flat-energy');
  if (m.energyPeaksPerSecond < config.minEnergyPeaksPerSecond) return reject('unsyllabic');
  if (m.periodicRatio < config.minPeriodicRatio || m.pitchSteps < config.minPitchSteps) return reject('unpitched');
  if (m.periodicRatio > config.maxPeriodicRatio || m.pitchStepMedian < config.minPitchStepMedian) return reject('static-tone');
  if (m.pitchStepMedian > config.maxPitchStepMedian || m.pitchStdSemitones > config.maxPitchStdSemitones) return reject('erratic-pitch');
  return { keep: true, reason: 'voice', ...m };
};

export const judgeClip = (frames, config = DEFAULT_VAD_CONFIG) => applyThresholds(clipMetrics(frames, config), config);
