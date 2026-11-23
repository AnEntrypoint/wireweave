import { RNNOISE_FRAME_SAMPLES, RNNOISE_PCM_SCALE, SILENCE_FLOOR_DB } from './constants.js';

const FLOAT32_BYTES = 4;

export const createRnnoiseLoader = (importFactoryModule) => async () => {
  const factory = (await importFactoryModule()).default;
  const wasm = await factory();
  const inputPtr = wasm._malloc(RNNOISE_FRAME_SAMPLES * FLOAT32_BYTES);
  if (!inputPtr) throw new Error('rnnoise: could not allocate the frame buffer');
  const context = wasm._rnnoise_create();
  if (!context) throw new Error('rnnoise: could not create the denoise state');
  const inputIndex = inputPtr >> 2;
  const score = (frame) => {
    const heap = wasm.HEAPF32;
    for (let i = 0; i < RNNOISE_FRAME_SAMPLES; i++) heap[inputIndex + i] = frame[i] * RNNOISE_PCM_SCALE;
    return wasm._rnnoise_process_frame(context, inputPtr, inputPtr);
  };
  const denoisedEnergyDb = () => {
    const heap = wasm.HEAPF32;
    let sum = 0;
    for (let i = 0; i < RNNOISE_FRAME_SAMPLES; i++) { const v = heap[inputIndex + i] / RNNOISE_PCM_SCALE; sum += v * v; }
    return Math.max(SILENCE_FLOOR_DB, 10 * Math.log10(sum / RNNOISE_FRAME_SAMPLES));
  };
  return { score, denoisedEnergyDb };
};
