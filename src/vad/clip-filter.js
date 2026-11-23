import { DEFAULT_VAD_CONFIG, FRAME_MS } from './constants.js';

const stdDev = (values) => {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};

export const judgeClip = (smoothedScores, config = DEFAULT_VAD_CONFIG, energiesDb = null) => {
  const voiced = (s) => s >= config.voicedFrameThreshold;
  const first = smoothedScores.findIndex(voiced);
  let last = -1;
  for (let i = smoothedScores.length - 1; i >= 0; i--) if (voiced(smoothedScores[i])) { last = i; break; }
  if (first < 0) return { keep: false, reason: 'no-voice', voicedMs: 0, voicedRatio: 0, spanMs: 0 };
  const span = last - first + 1;
  let voicedFrames = 0;
  for (let i = first; i <= last; i++) if (voiced(smoothedScores[i])) voicedFrames++;
  const voicedMs = voicedFrames * FRAME_MS;
  const voicedRatio = voicedFrames / span;
  const spanMs = span * FRAME_MS;
  const spanEnergies = energiesDb ? energiesDb.slice(first, last + 1) : [];
  const energyStdDb = stdDev(spanEnergies);
  if (voicedMs < config.minVoicedMs) return { keep: false, reason: 'too-short', voicedMs, voicedRatio, spanMs, energyStdDb };
  if (voicedRatio < config.minVoicedRatio) return { keep: false, reason: 'low-voiced-ratio', voicedMs, voicedRatio, spanMs, energyStdDb };
  if (energiesDb && energyStdDb < config.minEnergyStdDb) return { keep: false, reason: 'flat-energy', voicedMs, voicedRatio, spanMs, energyStdDb };
  return { keep: true, reason: 'voice', voicedMs, voicedRatio, spanMs, energyStdDb };
};
