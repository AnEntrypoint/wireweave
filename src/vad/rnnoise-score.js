import { RNNOISE_FRAME_SAMPLES, SMOOTHING_FRAMES } from './constants.js';

export const createVoiceScorer = async ({ loader, smoothingFrames = SMOOTHING_FRAMES }) => {
  if (typeof loader !== 'function') throw new Error('createVoiceScorer: loader required');
  const engine = await loader();
  if (!engine || typeof engine.score !== 'function') throw new Error('createVoiceScorer: loader must resolve { score(frame) }');
  const recent = [];
  const scoreFrame = (frame) => {
    if (frame.length !== RNNOISE_FRAME_SAMPLES) throw new Error('voice scorer needs ' + RNNOISE_FRAME_SAMPLES + ' samples, got ' + frame.length);
    const raw = engine.score(frame);
    recent.push(raw);
    if (recent.length > smoothingFrames) recent.shift();
    const smoothed = recent.reduce((a, b) => a + b, 0) / recent.length;
    return { raw, smoothed, denoisedDb: engine.denoisedEnergyDb ? engine.denoisedEnergyDb() : null, denoised: engine.denoisedFrame ? engine.denoisedFrame() : null };
  };
  const reset = () => { recent.length = 0; };
  return { scoreFrame, reset };
};
