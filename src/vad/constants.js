export const RNNOISE_SAMPLE_RATE = 48000;
export const RNNOISE_FRAME_SAMPLES = 480;
export const RNNOISE_PCM_SCALE = 32768;
export const FRAME_MS = (RNNOISE_FRAME_SAMPLES / RNNOISE_SAMPLE_RATE) * 1000;

export const SMOOTHING_FRAMES = 3;
export const START_THRESHOLD = 0.6;
export const STOP_THRESHOLD = 0.4;
export const VOICED_FRAME_THRESHOLD = 0.95;
export const START_CONFIRM_FRAMES = 1;

export const HANGOVER_MS = 1000;
export const PREROLL_MS = 200;
export const MAX_CLIP_MS = 30000;

export const MIN_VOICED_MS = 300;
export const MIN_VOICED_RATIO = 0.5;
export const MIN_ENERGY_STD_DB = 7;
export const MIN_MEAN_VOICED_ENERGY_DB = -42;
export const PERIODIC_THRESHOLD = 0.5;
export const MIN_ENERGY_PEAKS_PER_SECOND = 2.5;
export const MIN_PERIODIC_RATIO = 0.45;
export const MAX_PERIODIC_RATIO = 0.99;
export const MIN_PITCH_STEPS = 0;
export const MIN_PITCH_STEP_MEDIAN = 0;
export const MAX_PITCH_STEP_MEDIAN = Infinity;
export const MAX_PITCH_STD_SEMITONES = 9;
export const LIVE_MIN_VOICED_MS = 250;
export const LIVE_STD_AFTER_MS = 400;
export const SILENCE_FLOOR_DB = -120;

export const FRAME_LOG_MS = 60000;

export const DEFAULT_VAD_PROFILE = 'balanced';

export const VAD_PROFILES = Object.freeze({
  strict: Object.freeze({ maxPitchStdSemitones: 8, minMeanVoicedEnergyDb: -38, minVoicedRatio: 0.55 }),
  balanced: Object.freeze({ maxPitchStdSemitones: MAX_PITCH_STD_SEMITONES, minMeanVoicedEnergyDb: MIN_MEAN_VOICED_ENERGY_DB, minVoicedRatio: MIN_VOICED_RATIO }),
  lenient: Object.freeze({ maxPitchStdSemitones: 10, minMeanVoicedEnergyDb: MIN_MEAN_VOICED_ENERGY_DB, minVoicedRatio: 0.4, minEnergyPeaksPerSecond: 2 })
});

export const VAD_PROFILE_MEASURED = Object.freeze({
  strict: Object.freeze({ speechKeptPct: 91.2, hotMicKeptPct: 1.1 }),
  balanced: Object.freeze({ speechKeptPct: 96.2, hotMicKeptPct: 2.3 }),
  lenient: Object.freeze({ speechKeptPct: 97.5, hotMicKeptPct: 3.2 })
});

export const resolveVadProfile = (id) => VAD_PROFILES[id] || VAD_PROFILES[DEFAULT_VAD_PROFILE];

export const msToFrames = (ms) => Math.max(0, Math.round(ms / FRAME_MS));

export const DEFAULT_VAD_CONFIG = Object.freeze({
  smoothingFrames: SMOOTHING_FRAMES,
  startThreshold: START_THRESHOLD,
  stopThreshold: STOP_THRESHOLD,
  voicedFrameThreshold: VOICED_FRAME_THRESHOLD,
  startConfirmFrames: START_CONFIRM_FRAMES,
  hangoverMs: HANGOVER_MS,
  prerollMs: PREROLL_MS,
  maxClipMs: MAX_CLIP_MS,
  minVoicedMs: MIN_VOICED_MS,
  minVoicedRatio: MIN_VOICED_RATIO,
  minEnergyStdDb: MIN_ENERGY_STD_DB,
  minMeanVoicedEnergyDb: MIN_MEAN_VOICED_ENERGY_DB,
  periodicThreshold: PERIODIC_THRESHOLD,
  minEnergyPeaksPerSecond: MIN_ENERGY_PEAKS_PER_SECOND,
  minPeriodicRatio: MIN_PERIODIC_RATIO,
  maxPeriodicRatio: MAX_PERIODIC_RATIO,
  minPitchSteps: MIN_PITCH_STEPS,
  minPitchStepMedian: MIN_PITCH_STEP_MEDIAN,
  maxPitchStepMedian: MAX_PITCH_STEP_MEDIAN,
  maxPitchStdSemitones: MAX_PITCH_STD_SEMITONES,
  liveMinVoicedMs: LIVE_MIN_VOICED_MS,
  liveStdAfterMs: LIVE_STD_AFTER_MS
});
