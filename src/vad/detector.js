import { DEFAULT_VAD_CONFIG, FRAME_LOG_MS, FRAME_MS, RNNOISE_FRAME_SAMPLES, RNNOISE_SAMPLE_RATE, SILENCE_FLOOR_DB } from './constants.js';
import { FramePipeline } from './frame-pipeline.js';
import { createVoiceScorer } from './rnnoise-score.js';
import { ClipSegmenter } from './segmenter.js';
import { judgeClip } from './clip-filter.js';
import { PitchTracker } from './pitch.js';

const frameEnergyDb = (frame) => {
  let sum = 0;
  for (let i = 0; i < RNNOISE_FRAME_SAMPLES; i++) sum += frame[i] * frame[i];
  return Math.max(SILENCE_FLOOR_DB, 10 * Math.log10(sum / RNNOISE_FRAME_SAMPLES));
};

export const createVoiceDetector = ({ loader, sampleRate = RNNOISE_SAMPLE_RATE, config = {}, keepPcm = false, onClip = null, onFrame = null, now = () => Date.now() }) => {
  const cfg = { ...DEFAULT_VAD_CONFIG, ...config };
  const segmenter = new ClipSegmenter({ config: cfg, keepPcm });
  const frameLog = [];
  const stats = { frames: 0, clipsKept: 0, clipsDropped: 0, droppedBeforeReady: 0 };
  const recent = [];
  const pitch = new PitchTracker();
  let scorer = null;

  const ingest = ({ raw, denoisedDb = null, periodicity, f0, frame = null }, index) => {
    recent.push(raw);
    if (recent.length > cfg.smoothingFrames) recent.shift();
    const smoothed = recent.reduce((x, y) => x + y, 0) / recent.length;
    const t = now();
    const energyDb = denoisedDb ?? (frame ? frameEnergyDb(frame) : SILENCE_FLOOR_DB);
    const feature = { smoothed, energyDb, periodicity, f0, t };
    stats.frames++;
    frameLog.push(feature);
    const cutoff = t - FRAME_LOG_MS;
    while (frameLog.length && frameLog[0].t < cutoff) frameLog.shift();
    onFrame?.({ raw, ...feature, index });
    const clip = segmenter.push(feature, frame, index);
    if (clip) emitClip(clip);
  };

  const handleFrame = (frame, index) => {
    const { raw, denoisedDb, denoised } = scorer.scoreFrame(frame);
    const { periodicity, f0 } = pitch.push(denoised ?? frame);
    ingest({ raw, denoisedDb, periodicity, f0, frame }, index);
  };

  const emitClip = (clip) => {
    if (clip.keep) stats.clipsKept++; else stats.clipsDropped++;
    onClip?.(clip);
  };

  const pipeline = new FramePipeline({ sampleRate, onFrame: handleFrame });
  const ready = createVoiceScorer({ loader, smoothingFrames: cfg.smoothingFrames }).then((s) => { scorer = s; return api; });

  const api = {
    ready,
    config: cfg,
    stats,
    ingest,
    get voiceActive() { return segmenter.liveVoiced; },
    get isReady() { return scorer !== null; },
    push(samples) {
      if (!scorer) { stats.droppedBeforeReady++; return; }
      pipeline.push(samples);
    },
    flush() {
      const clip = segmenter.flush();
      if (clip) emitClip(clip);
      return clip;
    },
    assess(startMs, endMs) {
      const window = frameLog.filter((f) => f.t >= startMs && f.t <= endMs + FRAME_MS);
      return { ...judgeClip(window, cfg), frames: window.length };
    }
  };
  return api;
};
