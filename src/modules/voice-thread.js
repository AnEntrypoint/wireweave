import { registerProtocol } from './registry.js';

export const VOICE_THREAD_TYPE = 'voice-thread';
export const VOICE_EVENT_KIND = 42;
export const VOICE_TAG_VALUE = 'voice';

export const THREAD_MODES = Object.freeze({ LIVE: 'live', OWN_TALK: 'own-talk', PLAYING: 'playing', PAUSED: 'paused' });

const HISTORY_LIMIT = 50;
const MIN_ARRIVAL = -Infinity;

const laneOrder = (a, b) => a.seq - b.seq || a.arrival - b.arrival;

export class ThreadScheduler extends EventTarget {
  constructor({ player, liveGate = () => {}, capture = null }) {
    super();
    if (!player || typeof player.play !== 'function') throw new Error('ThreadScheduler: player required');
    this.player = player;
    this.liveGate = liveGate;
    this.capture = capture;
    this.lanes = new Map();
    this.known = new Set();
    this.history = [];
    this.remoteLive = new Map();
    this.captures = new Map();
    this.pendingCaptures = 0;
    this.current = null;
    this.localTalking = false;
    this.userPaused = false;
    this.gateOpen = true;
    this.arrivals = 0;
    this.playToken = 0;
  }

  get mode() {
    if (this.localTalking) return THREAD_MODES.OWN_TALK;
    if (this.userPaused && (this.current || this._peek())) return THREAD_MODES.PAUSED;
    if (this.current) return THREAD_MODES.PLAYING;
    return THREAD_MODES.LIVE;
  }

  snapshot() {
    return {
      mode: this.mode,
      gateOpen: this.gateOpen,
      localTalking: this.localTalking,
      userPaused: this.userPaused,
      current: this.current ? this._view(this.current.clip) : null,
      queueLength: this._queueLength(),
      lanes: [...this.lanes].map(([speaker, lane]) => ({ speaker, name: lane.name, clips: lane.clips.map((c) => this._view(c)) })),
      history: this.history.map((c) => this._view(c))
    };
  }

  _view(c) { return { id: c.id, speaker: c.speaker, name: c.name, seq: c.seq, durationMs: c.durationMs, source: c.source, expired: !!c.expired }; }
  _queueLength() { let n = 0; for (const l of this.lanes.values()) n += l.clips.length; return n; }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _changed() { this._emit('state', this.snapshot()); }

  _lane(speaker, name) {
    let lane = this.lanes.get(speaker);
    if (!lane) { lane = { name: name || speaker.slice(0, 8), clips: [], nextSeq: 1 }; this.lanes.set(speaker, lane); }
    else if (name) lane.name = name;
    return lane;
  }

  enqueue(clip) {
    if (!clip || !clip.speaker || !clip.id) return false;
    if (this.known.has(clip.id)) return false;
    this.known.add(clip.id);
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
    for (const lane of this.lanes.values()) {
      const head = lane.clips[0];
      if (head && (!best || head.arrival < best.arrival)) best = head;
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
    this.liveGate(open);
    this._emit('gate', { open });
  }

  setLocalTalking(talking) {
    const next = !!talking;
    if (this.localTalking === next) return;
    this.localTalking = next;
    if (next) {
      this._setGate(false);
      this.current?.handle.pause?.();
      this._syncCaptures();
    } else {
      this._endAllCaptures();
    }
    this._advance();
  }

  setRemoteSpeaking(speaker, name, speaking) {
    if (speaking) this.remoteLive.set(speaker, name || speaker.slice(0, 8));
    else this.remoteLive.delete(speaker);
    if (speaking) this._syncCaptures();
    else this._endCapture(speaker);
    this._advance();
  }

  _syncCaptures() {
    if (this.gateOpen || !this.capture) return;
    for (const [speaker, name] of this.remoteLive) {
      if (this.captures.has(speaker)) continue;
      const handle = this.capture.begin(speaker, name);
      if (handle) this.captures.set(speaker, { handle, name });
    }
  }

  _endAllCaptures() { for (const speaker of [...this.captures.keys()]) this._endCapture(speaker); }

  _endCapture(speaker) {
    const entry = this.captures.get(speaker);
    if (!entry) return;
    this.captures.delete(speaker);
    this.pendingCaptures++;
    Promise.resolve(this.capture.end(entry.handle)).then((result) => {
      this.pendingCaptures--;
      if (result && result.bytes?.length) {
        const lane = this._lane(speaker, entry.name);
        this.enqueue({ id: 'live-' + speaker.slice(0, 8) + '-' + lane.nextSeq + '-' + this.arrivals, speaker, name: entry.name, seq: lane.nextSeq, durationMs: result.durationMs, mime: result.mime, bytes: result.bytes, source: 'live' });
      } else this._advance();
    }).catch(() => { this.pendingCaptures--; this._advance(); });
  }

  _advance() {
    if (this.localTalking) { this._changed(); return; }
    if (this.current) {
      if (!this.userPaused) this.current.handle.resume?.();
      this._changed();
      return;
    }
    if (this.userPaused) { this._changed(); return; }
    this._endAllCaptures();
    if (this.pendingCaptures > 0) { this._changed(); return; }
    const next = this._peek();
    if (!next) { this._setGate(true); this._changed(); return; }
    if (this.gateOpen && this.remoteLive.size) { this._changed(); return; }
    this._setGate(false);
    this._start(next);
  }

  _start(clip) {
    this._take(clip);
    const token = ++this.playToken;
    const handle = this.player.play(clip);
    this.current = { clip, handle, token };
    this._syncCaptures();
    this._emit('clip-started', this._view(clip));
    this._changed();
    Promise.resolve(handle.ended).then(() => this._finish(token, 'ended'), () => this._finish(token, 'error'));
  }

  _finish(token, reason) {
    if (!this.current || this.current.token !== token) return;
    const { clip } = this.current;
    this.current = null;
    this.history.unshift(clip);
    this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
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
    this._take(next);
    this.history.unshift(next);
    this._emit('clip-ended', { ...this._view(next), reason: 'skipped' });
    this._advance();
    return true;
  }

  replay(id = null) {
    const clip = id ? this.history.find((c) => c.id === id) : this.history[0];
    if (!clip) return false;
    this.history = this.history.filter((c) => c !== clip);
    const lane = this._lane(clip.speaker, clip.name);
    lane.clips.push({ ...clip, arrival: MIN_ARRIVAL });
    lane.clips.sort(laneOrder);
    this._advance();
    return true;
  }
}

export const createThreadScheduler = (opts) => new ThreadScheduler(opts);

export const createBlobPlayer = ({ AudioCtor = globalThis.Audio, UrlApi = globalThis.URL, BlobCtor = globalThis.Blob } = {}) => ({
  play(clip) {
    const objectUrl = clip.bytes ? UrlApi.createObjectURL(new BlobCtor([clip.bytes], { type: clip.mime })) : null;
    const audio = new AudioCtor(objectUrl || clip.url);
    let settle;
    const ended = new Promise((resolve) => { settle = resolve; });
    const release = () => { if (objectUrl) UrlApi.revokeObjectURL(objectUrl); settle(); };
    audio.onended = release;
    audio.onerror = release;
    Promise.resolve(audio.play()).catch(release);
    return {
      ended,
      pause: () => audio.pause(),
      resume: () => { Promise.resolve(audio.play()).catch(release); },
      stop: () => { audio.pause(); release(); }
    };
  }
});

export const createRemoteCapture = ({ voice, RecorderCtor = globalThis.MediaRecorder, now = () => Date.now() }) => ({
  begin(speaker) {
    const stream = voice.getRemoteStream(speaker);
    if (!stream || !RecorderCtor) return null;
    const chunks = [];
    const recorder = new RecorderCtor(stream);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(250);
    return { recorder, chunks, startedAt: now() };
  },
  async end(handle) {
    const { recorder, chunks, startedAt } = handle;
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    if (!chunks.length) return null;
    const blob = new Blob(chunks, { type: recorder.mimeType });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: recorder.mimeType, durationMs: now() - startedAt };
  }
});

const SPEAKER_KEY_LENGTH = 12;

export const buildKeepTags = ({ channelHex, url, mime, durationMs, speaker, seq }) => [
  ['e', channelHex, '', 'root'],
  ['t', VOICE_TAG_VALUE],
  ['imeta', 'url ' + url, 'm ' + mime, 'duration ' + Math.round(durationMs), 'speaker ' + speaker, 'seq ' + seq]
];

export const parseKeptClipEvent = (event) => {
  if (!event || event.kind !== VOICE_EVENT_KIND) return null;
  const tags = event.tags || [];
  if (!tags.some((t) => t[0] === 't' && t[1] === VOICE_TAG_VALUE)) return null;
  const imeta = tags.find((t) => t[0] === 'imeta');
  if (!imeta) return null;
  const fields = Object.fromEntries(imeta.slice(1).map((entry) => { const i = entry.indexOf(' '); return [entry.slice(0, i), entry.slice(i + 1)]; }));
  if (!fields.url || !fields.m || !fields.m.startsWith('audio/')) return null;
  return {
    id: event.id,
    speaker: fields.speaker || event.pubkey,
    seq: Number(fields.seq),
    durationMs: Number(fields.duration) || 0,
    mime: fields.m,
    url: fields.url,
    source: 'keep',
    ts: event.created_at
  };
};

const speakerOf = (voice, key) => {
  const entry = voice.participants.get('nostr-' + key.slice(0, SPEAKER_KEY_LENGTH));
  return entry?.identity || key.slice(0, 8);
};

export const bindVoiceThread = ({ voice, thread, media = null, channelId = '', keepClips = false, onDropped = null }) => {
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
    const file = new File([segment.bytes], 'voice-' + segment.id + '.webm', { type: segment.mime });
    media.sendAudioClip(file, { channelId, serverId: voice.serverId, durationMs: segment.dur, speaker: segment.from, seq: segment.seq }).catch(() => {});
  };
  voice.addEventListener('speaker', speakerListener);
  voice.addEventListener('segment-received', receivedListener);
  voice.addEventListener('segment-dropped', droppedListener);
  voice.addEventListener('segment-finalized', finalizedListener);
  voice.requestTransmit();
  return {
    unbind() {
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

export const createVoiceThread = ({ voice, media = null, channelId = '', keepClips = false, player = createBlobPlayer(), RecorderCtor, onDropped = null }) => {
  const capture = createRemoteCapture({ voice, RecorderCtor });
  const thread = new ThreadScheduler({ player, capture, liveGate: (open) => voice.setLivePlayback(open) });
  const binding = bindVoiceThread({ voice, thread, media, channelId, keepClips, onDropped });
  return { thread, unbind: binding.unbind, setKeepClips: binding.setKeepClips };
};

registerProtocol({
  id: 'voice-thread',
  channelTypes: [VOICE_THREAD_TYPE],
  eventKinds: [VOICE_EVENT_KIND],
  createVoiceThread,
  parseKeptClipEvent,
  buildKeepTags
});
