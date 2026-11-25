import { createVoiceDetector, createStreamTap, STOP_THRESHOLD } from './vad/index.js';

export const CATCHUP = Object.freeze({
  sampleRate: 24000,
  frameMs: 10,
  frameSamples: 240,
  maxBacklogMs: 300000,
  budgetBytes: 96 * 1024 * 1024,
  catchUpRate: 1.5,
  settleLagMs: 300,
  ownTalkGraceMs: 300,
  prePadMs: 300,
  postPadMs: 200,
  minSkipMs: 200,
  planMaxMs: 20000,
  voicedLabelThreshold: STOP_THRESHOLD,
  keepAboveDb: -45,
  keepBelowPeakDb: 25,
  noiseFloorDb: -65,
  peakDecayDbPerFrame: 0.02
});

const FRAME_BYTES = CATCHUP.frameSamples * 2;
const QUEUE_LIMIT = 200;

export class PcmBudget {
  constructor(maxBytes = CATCHUP.budgetBytes) {
    this.maxBytes = maxBytes;
    this.rings = new Set();
  }

  get bytes() { let n = 0; for (const r of this.rings) n += r.bytes; return n; }

  reclaim() {
    while (this.bytes > this.maxBytes) {
      let largest = null;
      for (const r of this.rings) if (r.length && (!largest || r.length > largest.length)) largest = r;
      if (!largest) return;
      largest._evictOne();
    }
  }
}

export class PcmRing {
  constructor({ maxMs = CATCHUP.maxBacklogMs, budget = null, onVoiced = null, onDropped = null } = {}) {
    this.maxFrames = Math.round(maxMs / CATCHUP.frameMs);
    this.budget = budget;
    this.onVoiced = onVoiced;
    this.onDropped = onDropped;
    this.frames = [];
    this.voicedCount = 0;
    this.follow = true;
    this.dropped = { voicedMs: 0, unvoicedMs: 0 };
    budget?.rings.add(this);
  }

  get length() { return this.frames.length; }
  get bytes() { return this.frames.length * FRAME_BYTES; }
  backlogMs() { return this.frames.length * CATCHUP.frameMs; }
  voicedMs() { return this.voicedCount * CATCHUP.frameMs; }
  hasVoiced() { return this.voicedCount > 0; }

  setFollow(follow) {
    if (this.follow === follow) return;
    this.follow = follow;
    if (follow) this.clear();
    else if (!this.frames.length) this.dropped = { voicedMs: 0, unvoicedMs: 0 };
  }

  clear() {
    this.frames = [];
    this.voicedCount = 0;
  }

  dispose() { this.budget?.rings.delete(this); this.clear(); }

  push(data, voiced) {
    if (this.follow) return;
    this.frames.push({ d: data, v: voiced ? 1 : 0 });
    if (voiced && ++this.voicedCount === 1) this.onVoiced?.();
    while (this.frames.length > this.maxFrames) this._evictOne();
    this.budget?.reclaim();
  }

  _evictOne() {
    const i = this.frames.findIndex((f) => !f.v);
    if (i >= 0) {
      this.frames.splice(i, 1);
      this.dropped.unvoicedMs += CATCHUP.frameMs;
      return;
    }
    if (!this.frames.length) return;
    this.frames.shift();
    this.voicedCount--;
    this.dropped.voicedMs += CATCHUP.frameMs;
    this.onDropped?.(this.dropped);
  }

  take(maxMs = CATCHUP.planMaxMs) {
    const n = Math.min(this.frames.length, Math.round(maxMs / CATCHUP.frameMs));
    const src = this.frames.splice(0, n);
    for (const f of src) if (f.v) this.voicedCount--;
    return buildPlan(src);
  }

  restore(plan, heardSourceFrames) {
    const rest = plan.src.slice(heardSourceFrames);
    this.frames.unshift(...rest);
    for (const f of rest) if (f.v) this.voicedCount++;
    while (this.frames.length > this.maxFrames) this._evictOne();
  }
}

const buildPlan = (src) => {
  const prePad = Math.round(CATCHUP.prePadMs / CATCHUP.frameMs);
  const postPad = Math.round(CATCHUP.postPadMs / CATCHUP.frameMs);
  const minSkip = Math.round(CATCHUP.minSkipMs / CATCHUP.frameMs);
  const n = src.length;
  const keep = new Uint8Array(n);
  let last = -Infinity;
  for (let i = 0; i < n; i++) { if (src[i].v) last = i; if (i - last <= postPad) keep[i] = 1; }
  let next = Infinity;
  for (let i = n - 1; i >= 0; i--) { if (src[i].v) next = i; if (next - i <= prePad) keep[i] = 1; }
  const segments = [];
  let i = 0;
  let out = 0;
  let skipped = 0;
  while (i < n) {
    let j = i;
    while (j < n && keep[j] === keep[i]) j++;
    const run = j - i;
    if (keep[i] || run < minSkip) {
      const prev = segments[segments.length - 1];
      if (prev && prev.src + prev.len === i) prev.len += run;
      else segments.push({ src: i, out, len: run });
      out += run;
    } else skipped += run;
    i = j;
  }
  const pcm = new Int16Array(out * CATCHUP.frameSamples);
  for (const seg of segments) for (let k = 0; k < seg.len; k++) pcm.set(src[seg.src + k].d, (seg.out + k) * CATCHUP.frameSamples);
  return {
    src,
    segments,
    pcm,
    srcFrames: n,
    outFrames: out,
    skippedMs: skipped * CATCHUP.frameMs,
    durationMs: out * CATCHUP.frameMs,
    sourceMs: n * CATCHUP.frameMs,
    heardSource(outFramesHeard) {
      for (const seg of segments) if (outFramesHeard < seg.out + seg.len) return seg.src + Math.max(0, outFramesHeard - seg.out);
      return n;
    }
  };
};

export const encodeWav = (pcm, sampleRate = CATCHUP.sampleRate) => {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset, s) => { for (let k = 0; k < s.length; k++) view.setUint8(offset + k, s.charCodeAt(k)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(bytes.buffer, 44, pcm.length).set(pcm);
  return bytes;
};

class AreaDownsampler {
  constructor(fromRate, toRate) {
    this.ratio = fromRate / toRate;
    this.acc = 0;
    this.filled = 0;
  }

  process(input, emit) {
    for (let i = 0; i < input.length; i++) {
      let weight = 1;
      while (weight > 1e-9) {
        const take = Math.min(weight, this.ratio - this.filled);
        this.acc += input[i] * take;
        this.filled += take;
        weight -= take;
        if (this.filled >= this.ratio - 1e-9) { emit(this.acc / this.ratio); this.acc = 0; this.filled = 0; }
      }
    }
  }
}

export class SpeechGuard {
  constructor() { this.peakDb = -Infinity; }

  protects(db, labelledVoiced) {
    if (labelledVoiced) this.peakDb = Math.max(this.peakDb, db);
    else this.peakDb -= CATCHUP.peakDecayDbPerFrame;
    return labelledVoiced || db >= CATCHUP.keepAboveDb || (db >= CATCHUP.noiseFloorDb && db >= this.peakDb - CATCHUP.keepBelowPeakDb);
  }
}

export const frameDb = (frame) => {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return 20 * Math.log10(Math.sqrt(sum / frame.length) / 32768 + 1e-9);
};

const toInt16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));

export const createLaneTap = async ({ ctx, stream, ring, loader, profile = null }) => {
  const frameQueue = [];
  const labelQueue = [];
  const detector = createVoiceDetector({
    loader,
    sampleRate: ctx.sampleRate,
    profile,
    onFrame: (f) => labelQueue.push(f.smoothed >= CATCHUP.voicedLabelThreshold)
  });
  await detector.ready;
  const down = new AreaDownsampler(ctx.sampleRate, CATCHUP.sampleRate);
  const guard = new SpeechGuard();
  let frame = new Int16Array(CATCHUP.frameSamples);
  let filled = 0;
  const tap = await createStreamTap({
    ctx,
    stream,
    onSamples: (samples) => {
      detector.push(samples);
      down.process(samples, (v) => {
        frame[filled++] = toInt16(v);
        if (filled === CATCHUP.frameSamples) { frameQueue.push(frame); frame = new Int16Array(CATCHUP.frameSamples); filled = 0; }
      });
      while (frameQueue.length && labelQueue.length) {
        const pcm = frameQueue.shift();
        ring.push(pcm, guard.protects(frameDb(pcm), labelQueue.shift()));
      }
      if (frameQueue.length > QUEUE_LIMIT) frameQueue.splice(0, frameQueue.length - QUEUE_LIMIT);
      if (labelQueue.length > QUEUE_LIMIT) labelQueue.splice(0, labelQueue.length - QUEUE_LIMIT);
    }
  });
  return { close: () => tap.close() };
};

export const createLaneTaps = ({ voice, thread, loader, profile = null, budget = new PcmBudget(), nameOf = (key) => key.slice(0, 8), onWarning = null }) => {
  const entries = new Map();
  const open = async (key, stream) => {
    if (!stream) return;
    const existing = entries.get(key);
    if (existing && existing.stream === stream) return;
    const ctx = voice.audioContext();
    if (!ctx) return;
    const entry = existing || { ring: null, tap: null, stream: null };
    entry.stream = stream;
    if (!entry.ring) {
      entry.ring = new PcmRing({ budget });
      entries.set(key, entry);
      thread.attachRing(key, nameOf(key), entry.ring);
    }
    entry.tap?.close();
    entry.tap = null;
    try {
      const tap = await createLaneTap({ ctx, stream, ring: entry.ring, loader, profile });
      if (entry.stream !== stream || !entries.has(key)) tap.close();
      else entry.tap = tap;
    } catch (e) { onWarning?.('catch-up capture unavailable for a speaker: ' + e.message); }
  };
  return {
    open,
    ring: (key) => entries.get(key)?.ring || null,
    close() {
      for (const [key, entry] of entries) { entry.tap?.close(); entry.ring.dispose(); thread.detachRing(key); }
      entries.clear();
    }
  };
};
