import { DEFAULT_VAD_CONFIG, FRAME_LOG_MS, FRAME_MS, RNNOISE_FRAME_SAMPLES, RNNOISE_SAMPLE_RATE, SILENCE_FLOOR_DB } from './constants.js';
import { FramePipeline } from './frame-pipeline.js';
import { createVoiceScorer } from './rnnoise-score.js';
import { ClipSegmenter } from './segmenter.js';
import { judgeClip } from './clip-filter.js';

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
  let scorer = null;

  const handleFrame = (frame, index) => {
    const { raw, smoothed, denoisedDb } = scorer.scoreFrame(frame);
    const t = now();
    const energyDb = denoisedDb ?? frameEnergyDb(frame);
    stats.frames++;
    frameLog.push({ t, smoothed, energyDb });
    const cutoff = t - FRAME_LOG_MS;
    while (frameLog.length && frameLog[0].t < cutoff) frameLog.shift();
    onFrame?.({ raw, smoothed, energyDb, t, index });
    const clip = segmenter.push(smoothed, frame, index, energyDb);
    if (clip) emitClip(clip);
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
      const recent = frameLog.filter((f) => f.t >= startMs && f.t <= endMs + FRAME_MS);
      const verdict = judgeClip(recent.map((f) => f.smoothed), cfg, recent.map((f) => f.energyDb));
      return { ...verdict, frames: recent.length };
    }
  };
  return api;
};
