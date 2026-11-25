import { registerProtocol } from './registry.js';
import { hexChannelId } from '../channel-hex.js';
import { CATCHUP, createLaneTaps, encodeWav } from '../voice-thread-audio.js';

export const VOICE_THREAD_TYPE = 'voice-thread';
export const VOICE_EVENT_KIND = 42;
export const VOICE_TAG_VALUE = 'voice';

export const THREAD_MODES = Object.freeze({ LIVE: 'live', OWN_TALK: 'own-talk', PLAYING: 'playing', PAUSED: 'paused' });
export const LANE_STATES = Object.freeze({ LIVE: 'live', BEHIND: 'behind', CATCHING_UP: 'catching-up' });

const HISTORY_LIMIT = 50;
const MIN_ARRIVAL = -Infinity;

const laneOrder = (a, b) => a.seq - b.seq || a.arrival - b.arrival;

export class ThreadScheduler extends EventTarget {
  constructor({ player, liveGate = () => {}, ownTalkGraceMs = CATCHUP.ownTalkGraceMs, schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id) }) {
    super();
    if (!player || typeof player.play !== 'function') throw new Error('ThreadScheduler: player required');
    this.player = player;
    this.liveGate = liveGate;
    this.lanes = new Map();
    this.known = new Set();
    this.history = [];
    this.expired = [];
    this.remoteLive = new Map();
    this.current = null;
    this.localTalking = false;
    this.userPaused = false;
    this.gateOpen = true;
    this.arrivals = 0;
    this.playToken = 0;
    this.ownTalkGraceMs = ownTalkGraceMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.talkEnd = null;
  }

  get mode() {
    if (this.localTalking) return THREAD_MODES.OWN_TALK;
    if (this.userPaused && (this.current || this._peek())) return THREAD_MODES.PAUSED;
    if (this.current) return THREAD_MODES.PLAYING;
    return THREAD_MODES.LIVE;
  }

  snapshot() {
    const lanes = [...this.lanes].filter(([, lane]) => lane.seen).map(([speaker, lane]) => ({ speaker, name: lane.name, clips: lane.clips.map((c) => this._view(c)), stretch: this._stretchView(lane) }));
    return {
      mode: this.mode,
      gateOpen: this.gateOpen,
      localTalking: this.localTalking,
      userPaused: this.userPaused,
      current: this.current ? this._view(this.current.clip) : null,
      queueLength: this._queueLength(),
      lagMs: lanes.reduce((m, l) => Math.max(m, l.stretch ? l.stretch.lagMs : 0), 0),
      lanes,
      history: this.history.map((c) => this._view(c)),
      expired: this.expired.map((c) => this._view(c))
    };
  }

  _view(c) { return { id: c.id, speaker: c.speaker, name: c.name, seq: c.seq, durationMs: c.durationMs, source: c.source, expired: !!c.expired, offsetMs: c.offsetMs || 0 }; }

  _queueLength() {
    let n = 0;
    for (const l of this.lanes.values()) n += l.clips.length + (l.ring && l.ring.hasVoiced() ? 1 : 0);
    return n;
  }

  _unheardMs(lane) {
    const cur = this.current;
    if (!cur || !cur.plan || cur.lane !== lane) return 0;
    const heard = cur.plan.heardSource(Math.floor(this._position(cur) / CATCHUP.frameMs));
    return (cur.plan.srcFrames - heard) * CATCHUP.frameMs;
  }

  _position(cur) { return typeof cur.handle.position === 'function' ? cur.handle.position() : 0; }

  _stretchView(lane) {
    const ring = lane.ring;
    if (!ring) return null;
    const playing = this.current && this.current.plan && this.current.lane === lane;
    const state = playing ? LANE_STATES.CATCHING_UP : ring.hasVoiced() ? LANE_STATES.BEHIND : LANE_STATES.LIVE;
    const lagMs = state === LANE_STATES.LIVE ? 0 : ring.backlogMs() + this._unheardMs(lane);
    return { state, lagMs, voicedMs: ring.voicedMs(), rate: playing ? this.current.clip.rate : 1, droppedVoicedMs: ring.dropped.voicedMs, droppedMs: ring.dropped.voicedMs + ring.dropped.unvoicedMs };
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _changed() { this._emit('state', this.snapshot()); }

  _lane(speaker, name, seen = true) {
    let lane = this.lanes.get(speaker);
    if (!lane) { lane = { name: name || speaker.slice(0, 8), clips: [], nextSeq: 1, ring: null, stretchArrival: null, seen }; this.lanes.set(speaker, lane); }
    else { if (name) lane.name = name; if (seen) lane.seen = true; }
    return lane;
  }

  attachRing(speaker, name, ring) {
    const lane = this._lane(speaker, name, false);
    lane.ring = ring;
    ring.setFollow(this.gateOpen);
    ring.onVoiced = () => {
      lane.seen = true;
      if (lane.stretchArrival === null) lane.stretchArrival = this.arrivals++;
      if (!this.current && !this.localTalking && !this.userPaused) this._advance(); else this._changed();
    };
    ring.onDropped = (dropped) => this._emit('backlog-dropped', { speaker, name: lane.name, voicedMs: dropped.voicedMs });
  }

  detachRing(speaker) {
    const lane = this.lanes.get(speaker);
    if (lane) { lane.ring = null; lane.stretchArrival = null; }
  }

  addHistory(clip) {
    if (!clip || !clip.speaker || !clip.id || this.known.has(clip.id)) return false;
    this.known.add(clip.id);
    this._lane(clip.speaker, clip.name);
    if (clip.expired) this.expired.push(clip);
    else this.history.push(clip);
    this._changed();
    return true;
  }

  enqueue(clip) {
    if (!clip || !clip.speaker || !clip.id) return false;
    if (this.known.has(clip.id)) return false;
    this.known.add(clip.id);
    if (clip.expired) {
      this.expired.push(clip);
      this._emit('clip-expired', this._view(clip));
      this._changed();
      return true;
    }
    const lane = this._lane(clip.speaker, clip.name);
    const seq = Number.isFinite(clip.seq) ? clip.seq : lane.nextSeq;
    lane.nextSeq = Math.max(lane.nextSeq, seq + 1);
    const queued = { ...clip, seq, arrival: this.arrivals++ };
    lane.clips.push(queued);
    lane.clips.sort(laneOrder);
    this._emit('clip-queued', this._view(queued));
    this._advance();
    return true;
  }

  _peek() {
    let best = null;
    for (const [speaker, lane] of this.lanes) {
      const head = lane.clips[0];
      const candidate = head ? { kind: 'clip', lane, speaker, clip: head, arrival: head.arrival } : lane.ring && lane.ring.hasVoiced() ? { kind: 'stretch', lane, speaker, arrival: lane.stretchArrival ?? this.arrivals } : null;
      if (candidate && (!best || candidate.arrival < best.arrival)) best = candidate;
    }
    return best;
  }

  _take(clip) {
    const lane = this.lanes.get(clip.speaker);
    lane.clips = lane.clips.filter((c) => c !== clip);
  }

  _setGate(open) {
    if (this.gateOpen === open) return;
    this.gateOpen = open;
    for (const lane of this.lanes.values()) lane.ring?.setFollow(open);
    this.liveGate(open);
    this._emit('gate', { open });
  }

  setLocalTalking(talking) {
    const next = !!talking;
    if (next) {
      if (this.talkEnd !== null) { this.cancel(this.talkEnd); this.talkEnd = null; }
      if (this.localTalking) return;
      this.localTalking = true;
      this._setGate(false);
      this._interrupt();
      this._advance();
      return;
    }
    if (!this.localTalking || this.talkEnd !== null) return;
    if (!this.ownTalkGraceMs) { this.localTalking = false; this._advance(); return; }
    this.talkEnd = this.schedule(() => { this.talkEnd = null; this.localTalking = false; this._advance(); }, this.ownTalkGraceMs);
  }

  _interrupt() {
    const cur = this.current;
    if (!cur) return;
    if (typeof cur.handle.position !== 'function') { cur.handle.pause?.(); return; }
    const position = this._position(cur);
    this.current = null;
    cur.handle.stop?.();
    if (cur.plan) {
      cur.lane.ring.restore(cur.plan, cur.plan.heardSource(Math.floor(position / CATCHUP.frameMs)));
      this._emit('stretch-interrupted', { speaker: cur.clip.speaker, positionMs: position });
    } else {
      cur.lane.clips.unshift({ ...cur.clip, offsetMs: position });
      cur.lane.clips.sort(laneOrder);
      this._emit('clip-interrupted', { ...this._view(cur.clip), offsetMs: position });
    }
  }

  shutdown() {
    if (this.talkEnd !== null) { this.cancel(this.talkEnd); this.talkEnd = null; }
    const cur = this.current;
    this.current = null;
    cur?.handle.stop?.();
  }

  setRemoteSpeaking(speaker, name, speaking) {
    if (speaking) { this.remoteLive.set(speaker, name || speaker.slice(0, 8)); this._lane(speaker, name); }
    else this.remoteLive.delete(speaker);
    this._advance();
  }

  _advance() {
    if (this.localTalking) { this._changed(); return; }
    if (this.current) {
      if (!this.userPaused) this.current.handle.resume?.();
      this._changed();
      return;
    }
    if (this.userPaused) { this._changed(); return; }
    const next = this._peek();
    if (!next) { this._setGate(true); this._changed(); return; }
    if (this.gateOpen && next.kind === 'clip' && this.remoteLive.size) { this._changed(); return; }
    this._setGate(false);
    if (next.kind === 'stretch') this._startStretch(next.lane, next.speaker); else this._start(next.clip);
  }

  _start(clip) {
    this._take(clip);
    const token = ++this.playToken;
    const handle = this.player.play(clip);
    this.current = { clip, handle, token, lane: this.lanes.get(clip.speaker), plan: null };
    this._emit('clip-started', this._view(clip));
    this._changed();
    Promise.resolve(handle.ended).then(() => this._finish(token, 'ended'), () => this._finish(token, 'error'));
  }

  _startStretch(lane, speaker) {
    const ring = lane.ring;
    const rate = ring.backlogMs() > CATCHUP.settleLagMs ? CATCHUP.catchUpRate : 1;
    const plan = ring.take(CATCHUP.planMaxMs);
    if (!plan.outFrames) {
      if (!ring.hasVoiced()) lane.stretchArrival = null;
      this._advance();
      return;
    }
    const seq = lane.nextSeq++;
    const clip = { id: 'live-' + speaker.slice(0, 8) + '-' + seq, speaker, name: lane.name, seq, durationMs: plan.durationMs, pcm: plan.pcm, sampleRate: CATCHUP.sampleRate, rate, skippedMs: plan.skippedMs, source: 'live' };
    const token = ++this.playToken;
    const handle = this.player.play(clip);
    this.current = { clip, handle, token, lane, plan };
    this._emit('clip-started', this._view(clip));
    this._changed();
    Promise.resolve(handle.ended).then(() => this._finish(token, 'ended'), () => this._finish(token, 'error'));
  }

  _finish(token, reason) {
    if (!this.current || this.current.token !== token) return;
    const { clip, plan, lane } = this.current;
    this.current = null;
    if (plan) {
      if (!lane.ring?.hasVoiced()) lane.stretchArrival = null;
    } else {
      this.history.unshift(clip);
      this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
    }
    this._emit('clip-ended', { ...this._view(clip), reason });
    this._advance();
  }

  play() {
    this.userPaused = false;
    this._advance();
  }

  pause() {
    this.userPaused = true;
    this.current?.handle.pause?.();
    this._changed();
  }

  skip() {
    if (this.current) {
      const { handle, token } = this.current;
      handle.stop?.();
      this._finish(token, 'skipped');
      return true;
    }
    const next = this._peek();
    if (!next) return false;
    if (next.kind === 'stretch') {
      next.lane.ring.clear();
      next.lane.stretchArrival = null;
      this._emit('clip-ended', { speaker: next.speaker, name: next.lane.name, reason: 'skipped' });
      this._advance();
      return true;
    }
    this._take(next.clip);
    this.history.unshift(next.clip);
    this._emit('clip-ended', { ...this._view(next.clip), reason: 'skipped' });
    this._advance();
    return true;
  }

  replay(id = null) {
    const clip = id ? this.history.find((c) => c.id === id) : this.history[0];
    if (!clip) return false;
    this.history = this.history.filter((c) => c !== clip);
    const lane = this._lane(clip.speaker, clip.name);
    lane.clips.push({ ...clip, offsetMs: 0, arrival: MIN_ARRIVAL });
    lane.clips.sort(laneOrder);
    this._advance();
    return true;
  }
}

export const createThreadScheduler = (opts) => new ThreadScheduler(opts);

export const createBlobPlayer = ({ AudioCtor = globalThis.Audio, UrlApi = globalThis.URL, BlobCtor = globalThis.Blob } = {}) => ({
  play(clip) {
    const body = clip.pcm ? encodeWav(clip.pcm, clip.sampleRate) : clip.bytes;
    const type = clip.pcm ? 'audio/wav' : clip.mime;
    const objectUrl = body ? UrlApi.createObjectURL(new BlobCtor([body], { type })) : null;
    const audio = new AudioCtor(objectUrl || clip.url);
    audio.preservesPitch = true;
    audio.defaultPlaybackRate = clip.rate || 1;
    audio.playbackRate = clip.rate || 1;
    if (clip.offsetMs) audio.currentTime = clip.offsetMs / 1000;
    let settle;
    const ended = new Promise((resolve) => { settle = resolve; });
    const release = () => { if (objectUrl) UrlApi.revokeObjectURL(objectUrl); settle(); };
    audio.onended = release;
    audio.onerror = release;
    Promise.resolve(audio.play()).catch(release);
    return {
      ended,
      audio,
      position: () => audio.currentTime * 1000,
      pause: () => audio.pause(),
      resume: () => { Promise.resolve(audio.play()).catch(release); },
      stop: () => { audio.pause(); release(); }
    };
  }
});

const SPEAKER_KEY_LENGTH = 12;

export const buildKeepTags = ({ channelHex, url, mime, durationMs, speaker, seq }) => [
  ['e', channelHex, '', 'root'],
  ['t', VOICE_TAG_VALUE],
  ['imeta', 'url ' + url, 'm ' + mime, 'duration ' + Math.round(durationMs), 'speaker ' + speaker, 'seq ' + seq]
];

const imetaFields = (imeta) => Object.fromEntries(imeta.slice(1).map((entry) => { const i = entry.indexOf(' '); return [entry.slice(0, i), entry.slice(i + 1)]; }));

export const parseKeptClipEvent = (event) => {
  if (!event || event.kind !== VOICE_EVENT_KIND) return null;
  const tags = event.tags || [];
  if (!tags.some((t) => t[0] === 't' && t[1] === VOICE_TAG_VALUE)) return null;
  const imeta = tags.find((t) => t[0] === 'imeta');
  const fields = imeta ? imetaFields(imeta) : {};
  const playable = !!fields.url && typeof fields.m === 'string' && fields.m.startsWith('audio/');
  const seq = Number(fields.seq);
  return {
    id: event.id,
    speaker: fields.speaker || event.pubkey,
    seq: Number.isFinite(seq) && fields.seq !== undefined ? seq : null,
    durationMs: Number(fields.duration) || 0,
    mime: playable ? fields.m : null,
    url: playable ? fields.url : null,
    expired: !playable,
    source: 'kept',
    ts: event.created_at
  };
};

export const keptClipsFromEvents = (events) => (events || [])
  .map(parseKeptClipEvent)
  .filter(Boolean)
  .sort((a, b) => a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0));

const defaultProbe = async (url) => {
  const res = await fetch(url, { method: 'HEAD' });
  return res.ok;
};

export const verifyKeptClips = async (clips, probe = defaultProbe) => Promise.all(clips.map(async (clip) => {
  if (clip.expired) return clip;
  let reachable = false;
  try { reachable = await probe(clip.url); } catch { reachable = false; }
  return reachable ? clip : { ...clip, expired: true };
}));

export const fetchKeptClips = ({ relayPool, channelHex, limit = 50, timeoutMs = 6000 }) => new Promise((resolve) => {
  const events = [];
  const subId = 'vt-kept-' + channelHex.slice(0, 12) + '-' + Math.random().toString(36).slice(2, 7);
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    relayPool.unsubscribe(subId);
    resolve(keptClipsFromEvents(events));
  };
  const timer = setTimeout(finish, timeoutMs);
  relayPool.subscribe(subId, [{ kinds: [VOICE_EVENT_KIND], '#e': [channelHex], '#t': [VOICE_TAG_VALUE], limit }], (event) => { if (!events.find((e) => e.id === event.id)) events.push(event); }, finish);
});

const speakerOf = (voice, key) => {
  const entry = voice.participants.get('nostr-' + key.slice(0, SPEAKER_KEY_LENGTH));
  return entry?.identity || key.slice(0, 8);
};

export const bindVoiceThread = ({ voice, thread, taps = null, media = null, channelId = '', keepClips = false, onDropped = null }) => {
  const speakerListener = (e) => {
    const { key, isLocal, speaking } = e.detail;
    if (isLocal) thread.setLocalTalking(speaking);
    else thread.setRemoteSpeaking(key, speakerOf(voice, key), speaking);
  };
  const receivedListener = (e) => {
    const { from, segment } = e.detail;
    thread.enqueue({ id: segment.id, speaker: from, name: segment.name, seq: segment.seq, durationMs: segment.dur, mime: segment.mime, bytes: segment.bytes, source: 'dc' });
  };
  const droppedListener = (e) => onDropped?.(e.detail);
  const finalizedListener = (e) => {
    if (!keepClips || !media || e.detail.kind !== 'outbound') return;
    const { segment } = e.detail;
    const extension = segment.mime.includes('ogg') ? '.ogg' : '.webm';
    const file = new File([segment.bytes], 'voice-' + segment.id + extension, { type: segment.mime });
    media.sendAudioClip(file, { channelId, serverId: voice.serverId, durationMs: segment.dur, speaker: segment.from, seq: segment.seq }).catch(() => {});
  };
  const streamListener = (e) => taps?.open(e.detail.peerPubkey, e.detail.stream);
  voice.addEventListener('remote-stream', streamListener);
  if (taps) for (const key of voice.peers.keys()) taps.open(key, voice.getRemoteStream(key));
  voice.addEventListener('speaker', speakerListener);
  voice.addEventListener('segment-received', receivedListener);
  voice.addEventListener('segment-dropped', droppedListener);
  voice.addEventListener('segment-finalized', finalizedListener);
  voice.requestTransmit();
  return {
    unbind() {
      voice.removeEventListener('remote-stream', streamListener);
      taps?.close();
      thread.shutdown?.();
      voice.removeEventListener('speaker', speakerListener);
      voice.removeEventListener('segment-received', receivedListener);
      voice.removeEventListener('segment-dropped', droppedListener);
      voice.removeEventListener('segment-finalized', finalizedListener);
      voice.releaseTransmit();
      voice.setLivePlayback(true);
    },
    setKeepClips(on) { keepClips = !!on; }
  };
};

export const createVoiceThread = ({ voice, media = null, channelId = '', keepClips = false, player = createBlobPlayer(), vadLoader, vadProfile = null, onDropped = null, onWarning = null }) => {
  if (!vadLoader) throw new Error('createVoiceThread: vadLoader required');
  const thread = new ThreadScheduler({ player, liveGate: (open) => voice.setLivePlayback(open) });
  const taps = createLaneTaps({ voice, thread, loader: vadLoader, profile: vadProfile, nameOf: (key) => speakerOf(voice, key), onWarning });
  const binding = bindVoiceThread({ voice, thread, taps, media, channelId, keepClips, onDropped });
  return { thread, unbind: binding.unbind, setKeepClips: binding.setKeepClips };
};

registerProtocol({
  id: 'voice-thread',
  channelTypes: [VOICE_THREAD_TYPE],
  eventKinds: [VOICE_EVENT_KIND],
  createVoiceThread,
  parseKeptClipEvent,
  keptClipsFromEvents,
  verifyKeptClips,
  fetchKeptClips,
  hexChannelId,
  buildKeepTags
});
