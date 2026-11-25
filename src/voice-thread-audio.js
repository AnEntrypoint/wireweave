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
  followTailMs: 900,
  holeMinMs: 60,
  holeHoldMs: 2500,
  holeRecheckMs: 250,
  holeMatchFrames: 25,
  holeMaxAbs: 4,
  spliceVoicedDb: -55,
  alignSearchMs: 300,
  alignWindowMs: 300,
  alignDefaultShiftMs: 80,
  spliceMarginMeasuredFrames: 5,
  spliceMarginFallbackFrames: 10,
  alignMinCorrelation: 0.4,
  alignDecimate: 4,
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
  constructor({ maxMs = CATCHUP.maxBacklogMs, budget = null, onVoiced = null, onDropped = null, now = () => performance.now() } = {}) {
    this.now = now;
    this.maxFrames = Math.round(maxMs / CATCHUP.frameMs);
    this.budget = budget;
    this.onVoiced = onVoiced;
    this.onDropped = onDropped;
    this.frames = [];
    this.tail = [];
    this.maxTail = Math.round(CATCHUP.followTailMs / CATCHUP.frameMs);
    this.voicedCount = 0;
    this.follow = true;
    this.lastFilled = null;
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
    if (follow) { this.clear(); return; }
    if (!this.frames.length) this.dropped = { voicedMs: 0, unvoicedMs: 0 };
    const unplayed = this.tail;
    this.tail = [];
    let notify = false;
    for (const f of unplayed) { if (this._append(f, false)) notify = true; }
    if (notify) queueMicrotask(() => this.onVoiced?.());
  }

  clear() {
    this.frames = [];
    this.tail = [];
    this.lastFilled = null;
    this.voicedCount = 0;
  }

  dispose() { this.budget?.rings.delete(this); this.clear(); }

  push(data, voiced) {
    const frame = { d: data, v: voiced ? 1 : 0, z: isDigitalSilence(data), t: this.now() };
    if (this.follow) {
      this.tail.push(frame);
      if (this.tail.length > this.maxTail) this.tail.shift();
      return;
    }
    this._append(frame);
  }

  _append(frame, notify = true) {
    this.frames.push(frame);
    const first = !!frame.v && ++this.voicedCount === 1;
    if (first && notify) this.onVoiced?.();
    while (this.frames.length > this.maxFrames) this._evictOne();
    this.budget?.reclaim();
    return first;
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

  silentRuns() {
    const runs = [];
    const min = Math.round(CATCHUP.holeMinMs / CATCHUP.frameMs);
    let from = -1;
    for (let i = 0; i <= this.frames.length; i++) {
      const silent = i < this.frames.length && !this.frames[i].filled && this.frames[i].z;
      if (silent && from < 0) from = i;
      if (!silent && from >= 0) { if (i - from >= min) runs.push([from, i]); from = -1; }
    }
    return runs;
  }

  pickHole(runs, windowMs) {
    const after = this.lastFilled ? this.frames.indexOf(this.lastFilled) : -1;
    const later = runs.filter(([from]) => from > after);
    const pool = later.length ? later : runs;
    if (!Number.isFinite(windowMs)) return pool[pool.length - 1];
    const wanted = windowMs / CATCHUP.frameMs;
    let best = null;
    for (const run of pool) { const miss = Math.abs(run[1] - run[0] - wanted); if (!best || miss < best.miss) best = { run, miss }; }
    return best && best.miss <= CATCHUP.holeMatchFrames ? best.run : null;
  }

  splice({ pcm, muteMs, unmuteMs }) {
    const runs = this.silentRuns();
    if (!runs.length || !Number.isFinite(muteMs)) return null;
    const hole = this.pickHole(runs, Number.isFinite(unmuteMs) ? unmuteMs - muteMs : NaN);
    if (!hole) return null;
    const [from, to] = hole;
    let startSample = from * CATCHUP.frameSamples - Math.round((muteMs / 1000) * CATCHUP.sampleRate);
    const measured = this._alignShift(pcm, startSample, to);
    const shift = measured || { samples: Math.round((CATCHUP.alignDefaultShiftMs / 1000) * CATCHUP.sampleRate), correlation: 0 };
    startSample -= shift.samples;
    const margin = measured ? CATCHUP.spliceMarginMeasuredFrames : CATCHUP.spliceMarginFallbackFrames;
    const replacement = [];
    let filled = 0;
    let voiced = 0;
    let removedVoiced = 0;
    for (let i = from; i < to; i++) if (this.frames[i].v) removedVoiced++;
    for (let k = -margin; k < to - from + margin; k++) {
      const i = from + k;
      const inHole = k >= 0 && k < to - from;
      const at = i * CATCHUP.frameSamples - startSample;
      if (at < 0 || at + CATCHUP.frameSamples > pcm.length) { if (inHole) replacement.push(this.frames[i]); continue; }
      const data = pcm.slice(at, at + CATCHUP.frameSamples);
      const old = inHole ? this.frames[i] : null;
      const v = (old && old.v) || frameDb(data) >= CATCHUP.spliceVoicedDb ? 1 : 0;
      replacement.push({ d: data, v, z: false, filled: true, t: old ? old.t : this.now() });
      filled++;
      if (v) voiced++;
    }
    this.frames.splice(from, to - from, ...replacement);
    this.lastFilled = replacement[replacement.length - 1] || null;
    this.voicedCount += voiced - removedVoiced;
    while (this.frames.length > this.maxFrames) this._evictOne();
    if (filled) this.onVoiced?.();
    return { alignShiftMs: Math.round((shift.samples / CATCHUP.sampleRate) * 1000), alignCorrelation: Number(shift.correlation.toFixed(2)), holeFrames: to - from, holeStart: from, insertedFrames: replacement.length - (to - from), filledFrames: filled, voicedFrames: voiced, leadingUnplacedMs: Math.max(0, Math.round((-startSample / CATCHUP.sampleRate) * 1000)) };
  }

  _alignShift(pcm, startSample, holeEnd) {
    const d = CATCHUP.alignDecimate;
    const windowFrames = Math.round(CATCHUP.alignWindowMs / CATCHUP.frameMs);
    const live = this.frames.slice(holeEnd, holeEnd + windowFrames);
    if (live.length < windowFrames / 2) return null;
    const refLen = Math.floor((live.length * CATCHUP.frameSamples) / d);
    const ref = new Float32Array(refLen);
    for (let i = 0; i < refLen; i++) ref[i] = live[Math.floor((i * d) / CATCHUP.frameSamples)].d[(i * d) % CATCHUP.frameSamples];
    let refEnergy = 0;
    for (let i = 0; i < refLen; i++) refEnergy += ref[i] * ref[i];
    if (Math.sqrt(refEnergy / refLen) < 30) return null;
    const base = holeEnd * CATCHUP.frameSamples - startSample;
    const range = Math.round((CATCHUP.alignSearchMs / 1000) * CATCHUP.sampleRate);
    let best = null;
    for (let s = -range; s <= range; s += d) {
      const at = base + s;
      if (at < 0 || at + refLen * d > pcm.length) continue;
      let dot = 0;
      let energy = 0;
      for (let i = 0; i < refLen; i++) { const v = pcm[at + i * d]; dot += v * ref[i]; energy += v * v; }
      const correlation = dot / Math.sqrt(energy * refEnergy + 1);
      if (!best || correlation > best.correlation) best = { samples: s, correlation };
    }
    if (!best || best.correlation < CATCHUP.alignMinCorrelation) return null;
    let refined = best;
    for (let s = best.samples - d; s <= best.samples + d; s++) {
      const at = base + s;
      if (at < 0 || at + refLen * d > pcm.length) continue;
      let dot = 0;
      let energy = 0;
      for (let i = 0; i < refLen; i++) { const v = pcm[at + i * d]; dot += v * ref[i]; energy += v * v; }
      const correlation = dot / Math.sqrt(energy * refEnergy + 1);
      if (correlation > refined.correlation) refined = { samples: s, correlation };
    }
    return refined;
  }

  holdIndex() {
    const horizon = this.now() - CATCHUP.holeHoldMs;
    for (const [from, to] of this.silentRuns()) if (to < this.frames.length && this.frames[to - 1].t > horizon) return from;
    return this.frames.length;
  }

  hasPlayable() {
    const end = this.holdIndex();
    for (let i = 0; i < end; i++) if (this.frames[i].v) return true;
    return false;
  }

  isHolding() { return this.voicedCount > 0 && !this.hasPlayable(); }

  take(maxMs = CATCHUP.planMaxMs) {
    const n = Math.min(this.holdIndex(), Math.round(maxMs / CATCHUP.frameMs));
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

const isDigitalSilence = (frame) => {
  for (let i = 0; i < frame.length; i++) if (frame[i] > CATCHUP.holeMaxAbs || frame[i] < -CATCHUP.holeMaxAbs) return false;
  return true;
};

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

export const decodeClipPcm = async (ctx, bytes) => {
  const buffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const input = buffer.getChannelData(0);
  const out = [];
  new AreaDownsampler(buffer.sampleRate, CATCHUP.sampleRate).process(input, (v) => out.push(toInt16(v)));
  return Int16Array.from(out);
};

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
