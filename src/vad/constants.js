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

export const MIN_VOICED_MS = 550;
export const MIN_VOICED_RATIO = 0.5;
export const MIN_ENERGY_STD_DB = 7;
export const LIVE_MIN_VOICED_MS = 250;
export const LIVE_STD_AFTER_MS = 400;
export const SILENCE_FLOOR_DB = -120;

export const FRAME_LOG_MS = 60000;

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
  liveMinVoicedMs: LIVE_MIN_VOICED_MS,
  liveStdAfterMs: LIVE_STD_AFTER_MS
});
