const WORKLET_SOURCE = `
class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('wireweave-vad-tap', TapProcessor);
`;

const SCRIPT_PROCESSOR_BLOCK = 4096;

const loadedModules = new WeakMap();

const loadTapModule = (ctx) => {
  let loading = loadedModules.get(ctx);
  if (!loading) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    loading = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loadedModules.set(ctx, loading);
  }
  return loading;
};

export const createStreamTap = async ({ ctx, stream, onSamples }) => {
  const source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  let node;
  if (ctx.audioWorklet && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
    await loadTapModule(ctx);
    node = new AudioWorkletNode(ctx, 'wireweave-vad-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e) => onSamples(e.data);
  } else {
    node = ctx.createScriptProcessor(SCRIPT_PROCESSOR_BLOCK, 1, 1);
    node.onaudioprocess = (e) => onSamples(Float32Array.from(e.inputBuffer.getChannelData(0)));
  }
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  return {
    close() {
      try { source.disconnect(); } catch {}
      try { node.disconnect(); } catch {}
      try { sink.disconnect(); } catch {}
      if (node.port) node.port.onmessage = null;
    }
  };
};
