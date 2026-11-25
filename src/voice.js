import { replaceableTs } from './dtag.js';
import { createStreamTap } from './vad/stream-tap.js';
import { deriveRoomId } from './voice-room-id.js';


const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];
let ICE_SERVERS = DEFAULT_ICE_SERVERS;
export const setIceServers = (list) => { if (Array.isArray(list) && list.length) ICE_SERVERS = list; };
export const getIceServers = () => ICE_SERVERS.slice();
const hasTurnServer = () => ICE_SERVERS.some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => typeof u === 'string' && (u.startsWith('turn:') || u.startsWith('turns:'))));

const PRESENCE_LIVE_MS = 30000;
const PEER_STALE_MS = 15000;
const HUB_DISCONNECT_MS = 3000;
const HUB_ROUTE_TIMEOUT_MS = 10000;
const HUB_SILENCE_MS = 4000;
const HUB_PING_MS = 1000;
const OFFER_RETRY_MS = 2500;
const OFFER_RETRIES = 3;
const HEARTBEAT = 5000;
const STALL_CHECK = 5000;
const DISCONNECT_GRACE = 8000;

const CONNECT_TIMEOUT = 8000;
const OUTBOUND_START_WAIT_MS = 120;
const OUTBOUND_POST_ROLL_MS = 500;

const SPEAKER_ACTIVE_RMS = 0.045;
const SPEAKER_HOLD_MS = 350;
const SPEAKER_POLL_MS = 80;
const LEVEL_METER_CEILING = 0.35;
const QUEUE_MAX_SEGMENT_MS = 30000;
const QUEUE_MIME_PREFS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
const DC_LABEL = 'wireweave-queue';
const DC_CHUNK_MAX = 14000;
const DC_HEADER = 'WW1';

const OPUS_BITRATE_LADDER = {
  low: 16000,
  medium: 32000,
  high: 48000,
  max: 64000
};
const DEFAULT_AUDIO_QUALITY = 'high';

const defaultCreatePeerConnection = (config) => new RTCPeerConnection(config);

export class VoiceSession extends EventTarget {
  constructor({
    fsm, xstate, relayPool, auth, mediaDevices, bans = null, serverId = '',
    onAudioTrack = null, onVideoTrack = null, createPeerConnection = defaultCreatePeerConnection,
    pttMode = true, micSensitivity = SPEAKER_ACTIVE_RMS, noiseSuppression = true,
    echoCancellation = true, autoGainControl = true, audioQuality = DEFAULT_AUDIO_QUALITY, dtx = true, fec = true,
    forceRelay = false, createClipVad = null
  }) {
    super();
    if (!fsm || !xstate || !relayPool || !auth || !mediaDevices) throw new Error('VoiceSession: missing deps');
    this.fsm = fsm; this.xstate = xstate; this.pool = relayPool; this.auth = auth; this.md = mediaDevices; this.bans = bans;
    this.serverId = serverId;
    this.onAudioTrack = onAudioTrack; this.onVideoTrack = onVideoTrack;
    this.createPeerConnection = createPeerConnection;
    this.actor = null;
    this.channelName = ''; this.roomId = '';
    this.peers = new Map(); this.relayed = new Map(); this.participants = new Map();
    this.localStream = null; this.cameraStream = null; this.screenSharing = false;
    this.heartbeat = null; this.joinTs = 0;
    this.muted = false; this.deafened = false;
    this.sfu = { mode: 'mesh', hub: null, hubLostAt: null, rttMatrix: new Map(), electionTimer: null, statsInterval: null, actor: null, seen: new Map(), suspect: new Map(), pubkeyByShortId: new Map(), routeTimer: null, routeFor: null, myClass: undefined };
    this.retrySchedule = {};
    this._epoch = 0;

    this.pttMode = !!pttMode;

    this.micSensitivity = typeof micSensitivity === 'number' && micSensitivity > 0 ? micSensitivity : SPEAKER_ACTIVE_RMS;

    this.noiseSuppression = !!noiseSuppression;
    this.echoCancellation = !!echoCancellation;
    this.autoGainControl = !!autoGainControl;
    this.deviceId = null;

    this.setAudioQuality(audioQuality);
    this.dtx = !!dtx;

    this.fec = !!fec;

    this.forceRelay = !!forceRelay;

    this.createClipVad = createClipVad;
    this.clipVad = null;
    this._clipTap = null;
    this._clipSeq = 0;
    this.livePlaybackOpen = true;
  }

  setForceRelay(on) {
    this.forceRelay = !!on;

    if (this.forceRelay && !hasTurnServer()) this._emit('media-warning', { message: 'Force TURN is enabled but no TURN server is configured -- voice connections will fail to establish. Disable Force TURN or configure a TURN server via setIceServers().' });
  }

  setMicSensitivity(rms) {
    if (typeof rms !== 'number' || !(rms > 0)) return;
    this.micSensitivity = rms;
  }

  setFec(on) { this.fec = !!on; }

  setAudioConstraints({ deviceId, noiseSuppression, autoGainControl, echoCancellation } = {}) {
    if (deviceId !== undefined) this.deviceId = deviceId || null;
    if (noiseSuppression !== undefined) this.noiseSuppression = !!noiseSuppression;
    if (autoGainControl !== undefined) this.autoGainControl = !!autoGainControl;
    if (echoCancellation !== undefined) this.echoCancellation = !!echoCancellation;
  }

  setPttMode(on) { this.pttMode = !!on; }

  setAudioQuality(tier) {
    const kbps = OPUS_BITRATE_LADDER[tier];
    this.audioQuality = kbps ? tier : DEFAULT_AUDIO_QUALITY;
    this._targetBitrate = kbps || OPUS_BITRATE_LADDER[DEFAULT_AUDIO_QUALITY];
    for (const [, peer] of this.peers) if (peer.pc) this._applyAudioHints(peer.pc);
  }

  setDtx(on) { this.dtx = !!on; }

  _initActor() {
    this.actor = this.xstate.createActor(this.fsm.voiceMachine);
    this.actor.subscribe((snap) => this.dispatchEvent(new CustomEvent('state', { detail: { value: snap.value } })));
    this.actor.start();
  }

  _releaseLocalMedia() {
    if (this._localListenTrack) { this._localListenTrack.stop(); this._localListenTrack = null; }
    if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null; }
    if (this._activeAnalyzers) { for (const k of Array.from(this._activeAnalyzers.keys())) this._detachAnalyzer(k); }
    if (this.roomId) { this.pool.unsubscribe('voice-presence-' + this.roomId); this.pool.unsubscribe('voice-signals-' + this.roomId); }
  }

  async connect(channelName, { displayName = 'Guest' } = {}) {
    if (!this.actor) this._initActor();
    if (!this.actor.getSnapshot().can({ type: 'connect' })) await this.disconnect();
    const epoch = ++this._epoch;
    this.actor.send({ type: 'connect' });
    this.channelName = channelName;
    this.joinTs = Math.floor(Date.now() / 1000);
    this.userMuted = false;
    this.displayName = displayName;
    try {
      const roomId = await deriveRoomId(this.serverId, channelName);
      if (epoch !== this._epoch) return;

      let stream = null;
      try {
        stream = await this.md.getUserMedia({ audio: {
          echoCancellation: this.echoCancellation, noiseSuppression: this.noiseSuppression, autoGainControl: this.autoGainControl,
          ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {})
        } });
      } catch (mediaErr) {
        this._emit('media-warning', { message: 'joined listen-only: ' + mediaErr.message });
      }
      if (epoch !== this._epoch) { if (stream) stream.getTracks().forEach(t => t.stop()); return; }
      this.roomId = roomId;
      this.localStream = stream;

      this.muted = this.pttMode;
      if (this.localStream) this.localStream.getAudioTracks().forEach(t => t.enabled = !this.pttMode);
      this.participants.clear();
      this.participants.set('local', { identity: displayName, isSpeaking: false, isMuted: this.pttMode, isLocal: true, hasVideo: false, connectionQuality: 'good' });

      if (this.localStream) {
        const track = this.localStream.getAudioTracks()[0];
        this._localListenTrack = track ? track.clone() : null;
        if (this._localListenTrack) this._localListenTrack.enabled = true;
        const listenStream = this._localListenTrack ? new MediaStream([this._localListenTrack]) : this.localStream;
        this._attachAnalyzer('local', listenStream);
        this._startClipVad(listenStream);
      }
      this.actor.send({ type: 'connected' });
      this._subscribeSignals();
      this._subscribePresence();
      await this._publishPresence('join');
      if (epoch !== this._epoch) return;
      this._startHeartbeat();
      this._sfuStart();
      this._subscribeBanEnforcement();
      this._emit('connected', { roomId: this.roomId, channelName });
    } catch (e) {
      if (epoch !== this._epoch) return;
      this._releaseLocalMedia();
      const snap = () => this.actor.getSnapshot();
      if (snap().can({ type: 'fail' })) this.actor.send({ type: 'fail' });
      else if (snap().can({ type: 'disconnect' })) { this.actor.send({ type: 'disconnect' }); if (snap().can({ type: 'done' })) this.actor.send({ type: 'done' }); }
      this._emit('error', { message: 'connect failed: ' + e.message });
      throw e;
    }
  }

  async disconnect() {
    if (!this.actor || this.actor.getSnapshot().matches('idle')) return;
    if (!this.actor.getSnapshot().can({ type: 'disconnect' })) return;
    ++this._epoch;
    this.actor.send({ type: 'disconnect' });
    try { await this._publishPresence('leave'); } catch {}
    this._stopHeartbeat();
    this._sfuStop();
    for (const pk of Array.from(this.peers.keys())) this._closePeer(pk);
    this.peers.clear();
    for (const pk of Array.from(this.relayed.keys())) this._dropRelayed(pk);
    for (const pk of Object.keys(this.retrySchedule)) this._cancelReconnect(pk);
    if (this._activityTimer) { clearInterval(this._activityTimer); this._activityTimer = null; }
    if (this._activeAnalyzers) { for (const k of Array.from(this._activeAnalyzers.keys())) this._detachAnalyzer(k); }
    this._stopClipVad();
    if (this._outboundRec) { try { this._outboundRec.rec.stop(); } catch {} this._outboundRec = null; }
    if (this._actx && this._actx.state !== 'closed') { try { this._actx.close(); } catch {} this._actx = null; }
    if (this.cameraStream) { this.cameraStream.getTracks().forEach(t => t.stop()); this.cameraStream = null; }
    if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null; }
    if (this._localListenTrack) { this._localListenTrack.stop(); this._localListenTrack = null; }
    if (this.roomId) { this.pool.unsubscribe('voice-presence-' + this.roomId); this.pool.unsubscribe('voice-signals-' + this.roomId); }
    this._unsubscribeBanEnforcement();
    this.participants.clear();
    this.roomId = ''; this.channelName = '';
    this.muted = false; this.deafened = false; this.livePlaybackOpen = true;
    this.actor.send({ type: 'done' });
    if (this.cameraStream) { this.cameraStream.getTracks().forEach(t => t.stop()); this.cameraStream = null; }
    this._emit('disconnected', {});
  }

  toggleMic() { const r = this.setMuted(!this.muted); this.userMuted = this.muted; this._scheduleMutePresence(); return r; }

  async setCamera(on) {
    const want = !!on;
    if (want === !!this.cameraStream) return;
    if (!want) {
      this.cameraStream.getTracks().forEach(t => t.stop());
      this.cameraStream = null;
      for (const [pk, peer] of this.peers) this._detachCamera(peer, pk);
      this._setLocalVideo(false);
      return;
    }
    let stream;
    try { stream = await this.md.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 } } }); }
    catch (e) { this._emit('media-warning', { message: 'camera unavailable: ' + e.message }); return; }
    this.cameraStream = stream;
    const track = stream.getVideoTracks()[0];
    track.onended = () => { if (this.cameraStream === stream) this.setCamera(false); };
    this._setLocalVideo(true);
    for (const [pk, peer] of this.peers) this._attachCamera(peer, pk);
  }

  async setScreen(on) {
    const want = !!on;
    if (want === !!this.screenSharing) return;
    if (!want) {
      this.screenSharing = false;
      if (this.cameraStream) await this.setCamera(false);
      return;
    }
    if (!this.md || typeof this.md.getDisplayMedia !== 'function') { this._emit('media-warning', { message: 'screen sharing is not available in this browser' }); return; }
    if (this.cameraStream) await this.setCamera(false);
    let stream;
    try { stream = await this.md.getDisplayMedia({ video: { frameRate: 15 }, audio: false }); }
    catch (e) { this._emit('media-warning', { message: 'screen sharing was not started: ' + e.message }); return; }
    this.cameraStream = stream;
    this.screenSharing = true;
    stream.getVideoTracks()[0].onended = () => { if (this.cameraStream === stream) this.setScreen(false); };
    this._setLocalVideo(true);
    for (const [pk, peer] of this.peers) this._attachCamera(peer, pk);
  }

  _setLocalVideo(on) {
    const local = this.participants.get('local'); if (local) local.hasVideo = on;
    for (const peer of this.peers.values()) this._dcSendJSON(peer, { type: 'video', on: !!on });
    this._emit('local-video', { stream: on ? this.cameraStream : null });
    this._emit('participants', { list: this.getParticipants() });
  }

  _detachCamera(peer, peerPubkey) {
    const tr = peer.pc?.getTransceivers().find(t => t.receiver.track.kind === 'video' && t.sender.track && !peer.relayTxs?.has(t));
    if (!tr) return;
    tr.sender.replaceTrack(null).catch(() => {});
    tr.direction = 'recvonly';
    this._renegotiate(peerPubkey, peer);
  }

  _attachCamera(peer, peerPubkey) {
    const pc = peer.pc; if (!pc || !this.cameraStream) return;
    const track = this.cameraStream.getVideoTracks()[0];
    const tr = pc.getTransceivers().find(t => t.receiver.track.kind === 'video' && !t.stopped && !peer.relayTxs?.has(t));
    if (tr) { tr.direction = 'sendrecv'; tr.sender.replaceTrack(track).catch(() => {}); }
    else pc.addTrack(track, this.cameraStream);
    this._renegotiate(peerPubkey, peer);
  }

  _setRemoteVideo(peerPubkey, on) {
    const p = this.participants.get('nostr-' + peerPubkey.slice(0, 12));
    if (!p || !!p.hasVideo === on) return;
    p.hasVideo = on;
    this._emit('participants', { list: this.getParticipants() });
  }

  setMuted(want) {
    const next = !!want;
    if (this.muted === next) return;
    this.muted = next;
    if (this.localStream) this.localStream.getAudioTracks().forEach(t => t.enabled = !this.muted);

    if (this._localListenTrack) this._localListenTrack.enabled = true;
    const local = this.participants.get('local'); if (local) local.isMuted = this.muted;
    if (this.muted) this._localActivityClear();
    this._emit('mic', { muted: this.muted });
    this._emit('participants', { list: this.getParticipants() });
  }

  _ensureAudioCtx() {
    if (this._actx && this._actx.state !== 'closed') return this._actx;
    const Ctx = (typeof AudioContext !== 'undefined') ? AudioContext : (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext : null;
    if (!Ctx) return null;
    this._actx = new Ctx();
    this._activeAnalyzers = new Map();
    this._mixedDest = this._actx.createMediaStreamDestination();
    this._mixedGain = this._actx.createGain();
    this._mixedGain.gain.value = 1.0;
    this._mixedGain.connect(this._mixedDest);
    if (!this._activityTimer) this._activityTimer = setInterval(() => this._pollActivity(), SPEAKER_POLL_MS);
    return this._actx;
  }

  _attachAnalyzer(key, stream, { tap = false } = {}) {
    const ctx = this._ensureAudioCtx(); if (!ctx || !stream) return;
    if (this._activeAnalyzers.has(key)) return;
    try {
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.4;
      src.connect(an);
      let tapNode = null;
      if (tap) { tapNode = ctx.createGain(); tapNode.gain.value = 1.0; src.connect(tapNode); tapNode.connect(this._mixedGain); }
      this._activeAnalyzers.set(key, { src, an, tapNode, lastActive: 0, speaking: false });
    } catch {}
  }

  _detachAnalyzer(key) {
    const a = this._activeAnalyzers?.get(key); if (!a) return;
    try { a.tapNode?.disconnect(); } catch {}
    try { a.an?.disconnect(); } catch {}
    try { a.src?.disconnect(); } catch {}
    this._activeAnalyzers.delete(key);
    this._setSpeaking(key, false);
  }

  _pollActivity() {
    if (!this._activeAnalyzers || !this._activeAnalyzers.size) return;
    const buf = new Uint8Array(256);
    const now = Date.now();
    for (const [key, a] of this._activeAnalyzers) {
      a.an.getByteTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const active = (key === 'local' && this.clipVad?.isReady) ? this.clipVad.voiceActive : rms > this.micSensitivity;
      if (active) a.lastActive = now;
      const stillSpeaking = active || (now - a.lastActive) < SPEAKER_HOLD_MS;
      if (stillSpeaking !== a.speaking) { a.speaking = stillSpeaking; this._setSpeaking(key, stillSpeaking); }
      if (key === 'local') {

        const level = Math.max(0, Math.min(1, rms / LEVEL_METER_CEILING));
        this._emit('local-level', { level, rms });
      }
    }
    this._maybeAutoTransmit();
  }

  async _startClipVad(stream) {
    if (!this.createClipVad || this.clipVad) return;
    const ctx = this._ensureAudioCtx(); if (!ctx) return;
    const epoch = this._epoch;
    try {
      const vad = this.createClipVad({ sampleRate: ctx.sampleRate });
      await vad.ready;
      const tap = await createStreamTap({ ctx, stream, onSamples: (samples) => vad.push(samples) });
      if (epoch !== this._epoch) { tap.close(); return; }
      this.clipVad = vad; this._clipTap = tap;
    } catch (e) { this._emit('media-warning', { message: 'voice detector unavailable, using the energy gate: ' + e.message }); }
  }

  _stopClipVad() {
    try { this._clipTap?.close(); } catch {}
    this._clipTap = null; this.clipVad = null;
  }

  _setSpeaking(key, val) {
    const isLocal = key === 'local';
    if (isLocal) {
      const p = this.participants.get('local'); if (p && p.isSpeaking !== val) { p.isSpeaking = val; this._emit('participants', { list: this.getParticipants() }); this._emit('speaker', { key: 'local', isLocal: true, speaking: val }); }
    } else {
      const shortId = 'nostr-' + key.slice(0, 12);
      const p = this.participants.get(shortId);
      if (p && p.isSpeaking !== val) { p.isSpeaking = val; this._emit('participants', { list: this.getParticipants() }); this._emit('speaker', { key, isLocal: false, speaking: val }); }
    }
  }

  _localActivityClear() {
    const a = this._activeAnalyzers?.get('local'); if (a) { a.lastActive = 0; if (a.speaking) { a.speaking = false; this._setSpeaking('local', false); } }
  }

  anyRemoteSpeaking() {
    if (!this._activeAnalyzers) return false;
    for (const [k, a] of this._activeAnalyzers) if (k !== 'local' && a.speaking) return true;
    return false;
  }

  requestTransmit() {
    if (!this.localStream) { this._emit('transmit-denied', { reason: 'no-microphone' }); return false; }
    this._wantsTransmit = true;
    if (!this.anyRemoteSpeaking()) { this.setMuted(false); this._emit('transmit', { mode: 'live' }); return true; }

    this._beginOutboundCapture();
    this._emit('transmit', { mode: 'queued' });
    return false;
  }

  releaseTransmit() {
    this._wantsTransmit = false;
    if (this._outboundRec) this._finalizeOutboundCapture();

    if (this.pttMode && !this.muted) this.setMuted(true);
    this._emit('transmit', { mode: 'idle' });
  }

  _maybeAutoTransmit() {
    if (!this._wantsTransmit) return;

    if (this._outboundRec && !this._outboundRec.releasing && !this.anyRemoteSpeaking()) {
      this.setMuted(false);
      this._releaseOutboundCapture();
      this._emit('transmit', { mode: 'live' });
    }

    else if (!this.muted && this.anyRemoteSpeaking()) {
      this._beginOutboundCapture(() => { this.setMuted(true); const o = this._outboundRec; if (o && o.muteAt === null) o.muteAt = performance.now(); });
      this._emit('transmit', { mode: 'queued' });
    }
  }

  _pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const m of QUEUE_MIME_PREFS) if (MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }

  _beginOutboundCapture(onRecording = () => {}) {
    if (this._outboundRec && this._outboundRec.releasing) this._finalizeOutboundCapture();
    if (this._outboundRec) { onRecording(); return; }
    if (!this.localStream || this.userMuted) { onRecording(); return; }
    const mime = this._pickMime(); if (mime === null) { onRecording(); return; }
    const source = this._localListenTrack ? new MediaStream([this._localListenTrack.clone()]) : this.localStream;
    const segId = (this.auth.pubkey?.slice(0, 8) || 'me') + '-' + Date.now();
    const chunks = [];
    let rec;
    try { rec = new MediaRecorder(source, mime ? { mimeType: mime } : undefined); } catch { source.getTracks().forEach(t => t.stop()); onRecording(); return; }
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const o = { rec, source, chunks, segId, mime: mime || rec.mimeType, ts: Date.now(), startedAt: performance.now(), muteAt: null, unmuteAt: null, releasing: false, releaseTimer: null, capLimit: setTimeout(() => this._finalizeOutboundCapture(), QUEUE_MAX_SEGMENT_MS) };
    let announced = false;
    const announce = () => { if (announced) return; announced = true; o.startedAt = performance.now(); onRecording(); };
    rec.onstart = announce;
    this._outboundRec = o;
    rec.start(250);
    setTimeout(announce, OUTBOUND_START_WAIT_MS);
    this._emit('segment-start', { kind: 'outbound', segId });
  }

  _releaseOutboundCapture() {
    const o = this._outboundRec; if (!o || o.releasing) return;
    o.releasing = true;
    o.unmuteAt = performance.now();
    o.releaseTimer = setTimeout(() => { o.releaseTimer = null; if (this._outboundRec === o) this._finalizeOutboundCapture(); }, OUTBOUND_POST_ROLL_MS);
  }

  async _finalizeOutboundCapture() {
    const o = this._outboundRec; if (!o) return;
    this._outboundRec = null;
    clearTimeout(o.capLimit);
    clearTimeout(o.releaseTimer);
    if (o.rec.state !== 'inactive') {
      const stopped = new Promise(r => o.rec.onstop = r);
      try { o.rec.stop(); } catch {}
      await stopped;
    }
    if (o.source !== this.localStream) o.source.getTracks().forEach(t => t.stop());
    if (!o.chunks.length) return;
    const blob = new Blob(o.chunks, { type: o.mime });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const end = Date.now();
    const segment = { id: o.segId, seq: ++this._clipSeq, from: this.auth.pubkey, name: this.displayName || 'Me', mime: o.mime, ts: o.ts, dur: end - o.ts, muteMs: o.muteAt === null ? null : Math.round(o.muteAt - o.startedAt), unmuteMs: o.unmuteAt === null ? null : Math.round(o.unmuteAt - o.startedAt), bytes: buf };
    const verdict = this.clipVad?.assess(o.ts, end, { fragment: true });
    if (verdict && verdict.frames > 0 && !verdict.keep) { this._emit('segment-dropped', { kind: 'outbound', segment: { ...segment, bytes: null }, verdict }); return; }
    this._emit('segment-finalized', { kind: 'outbound', segment });
    this._broadcastSegment(segment);
  }

  _ensureDataChannel(peer, peerPubkey, isOfferer) {
    if (peer.dc) return;
    if (isOfferer) {
      try {
        const dc = peer.pc.createDataChannel(DC_LABEL, { ordered: true });
        peer.dc = dc; this._wireDataChannel(dc, peer, peerPubkey);
      } catch {}
    } else {
      peer.pc.ondatachannel = (ev) => { if (ev.channel.label === DC_LABEL) { peer.dc = ev.channel; this._wireDataChannel(peer.dc, peer, peerPubkey); } };
    }
  }

  _wireDataChannel(dc, peer, peerPubkey) {
    dc.binaryType = 'arraybuffer';
    peer._dcInbox = new Map();
    dc.onmessage = (e) => this._dcOnMessage(e.data, peer, peerPubkey);
    dc.onopen = () => this._emit('dc-open', { peerPubkey });
    dc.onclose = () => this._emit('dc-close', { peerPubkey });
  }

  _dcSendJSON(peer, obj) {
    if (!peer.dc || peer.dc.readyState !== 'open') return false;
    try { peer.dc.send(DC_HEADER + 'J' + JSON.stringify(obj)); return true; } catch { return false; }
  }
  _dcSendBytes(peer, segId, idx, total, bytes) {
    if (!peer.dc || peer.dc.readyState !== 'open') return false;
    const head = new TextEncoder().encode(DC_HEADER + 'B' + segId + ':' + idx + '/' + total + ':');
    const buf = new Uint8Array(head.length + bytes.length);
    buf.set(head, 0); buf.set(bytes, head.length);
    try { peer.dc.send(buf.buffer); return true; } catch { return false; }
  }

  async _broadcastSegment(seg, exceptPk = null) {
    const open = [];
    for (const [pk, peer] of this.peers) if (pk !== exceptPk && peer.dc?.readyState === 'open') open.push([pk, peer]);
    if (!open.length) return;
    const meta = { type: 'seg-meta', segId: seg.id, from: seg.from, name: seg.name, mime: seg.mime, ts: seg.ts, dur: seg.dur, seq: seg.seq, muteMs: seg.muteMs, unmuteMs: seg.unmuteMs, total: Math.ceil(seg.bytes.length / DC_CHUNK_MAX), bytes: seg.bytes.length };
    for (const [, peer] of open) this._dcSendJSON(peer, meta);
    let idx = 0;
    for (let off = 0; off < seg.bytes.length; off += DC_CHUNK_MAX, idx++) {
      const slice = seg.bytes.subarray(off, Math.min(off + DC_CHUNK_MAX, seg.bytes.length));
      for (const [, peer] of open) this._dcSendBytes(peer, seg.id, idx, meta.total, slice);
    }
    for (const [, peer] of open) this._dcSendJSON(peer, { type: 'seg-end', segId: seg.id });
  }

  _dcOnMessage(data, peer, peerPubkey) {
    if (typeof data === 'string') {
      if (!data.startsWith(DC_HEADER)) return;
      const tag = data[3]; const body = data.slice(4);
      if (tag !== 'J') return;
      let obj; try { obj = JSON.parse(body); } catch { return; }
      if (obj.type === 'hb') peer.lastHb = Date.now();
      else if (obj.type === 'video') {
        const source = obj.src && this.sfu.hub === peerPubkey ? obj.src : peerPubkey;
        if (source === peerPubkey) peer.videoOn = !!obj.on;
        this._setRemoteVideo(source, !!obj.on);
        if (source === peerPubkey && this.sfu.hub === this.auth.pubkey) {
          for (const [pk, other] of this.peers) if (pk !== peerPubkey) this._dcSendJSON(other, { type: 'video', on: !!obj.on, src: peerPubkey });
          this._sfuRelayAll();
        }
      }
      else if (obj.type === 'seg-meta') {
        peer._dcInbox.set(obj.segId, { meta: obj, parts: new Array(obj.total), received: 0 });
      } else if (obj.type === 'seg-end') {
        const inbox = peer._dcInbox.get(obj.segId); if (!inbox) return;
        peer._dcInbox.delete(obj.segId);
        if (inbox.received < inbox.meta.total) return;
        const total = inbox.parts.reduce((n, p) => n + (p?.length || 0), 0);
        const buf = new Uint8Array(total); let off = 0;
        for (const p of inbox.parts) { buf.set(p, off); off += p.length; }
        const segment = { id: inbox.meta.segId, from: inbox.meta.from || peerPubkey, name: inbox.meta.name, mime: inbox.meta.mime, ts: inbox.meta.ts, dur: inbox.meta.dur, seq: inbox.meta.seq, muteMs: inbox.meta.muteMs ?? null, unmuteMs: inbox.meta.unmuteMs ?? null, bytes: buf };
        this._emit('segment-received', { kind: 'inbound', from: segment.from, segment });
        if (this.sfu.hub === this.auth.pubkey && segment.from === peerPubkey) this._broadcastSegment(segment, peerPubkey);
      }
      return;
    }

    const view = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
    if (view.length < 6) return;
    if (view[0] !== 0x57 || view[1] !== 0x57 || view[2] !== 0x31) return;
    if (view[3] !== 0x42) return;
    let h = 4; let colons = 0; let metaEnd = -1;
    for (; h < view.length && h < 80; h++) {
      if (view[h] === 0x3A) { colons++; if (colons === 2) { metaEnd = h; break; } }
    }
    if (metaEnd < 0) return;
    const headerStr = new TextDecoder().decode(view.subarray(4, metaEnd));

    const [segId, rest] = headerStr.split(':');
    const [idxStr, totalStr] = rest.split('/');
    const idx = +idxStr, total = +totalStr;
    const inbox = peer._dcInbox.get(segId); if (!inbox) return;
    if (!inbox.parts[idx]) { inbox.parts[idx] = view.subarray(metaEnd + 1); inbox.received++; }
  }

  toggleDeafen() {
    this.deafened = !this.deafened;
    this._applyPlaybackMute();
    this._emit('deafen', { deafened: this.deafened });
  }

  _applyPlaybackMute() {
    for (const [, peer] of [...this.peers, ...this.relayed]) if (peer.audioEl) peer.audioEl.muted = this.deafened || !this.livePlaybackOpen;
  }

  setLivePlayback(open) {
    const next = !!open;
    if (this.livePlaybackOpen === next) return;
    this.livePlaybackOpen = next;
    this._applyPlaybackMute();
    this._emit('live-playback', { open: next });
  }

  audioContext() { return this._ensureAudioCtx(); }

  getRemoteStream(peerPubkey) { return this.peers.get(peerPubkey)?.remoteStream || this.relayed.get(peerPubkey)?.remoteStream || null; }

  remoteKeys() { return [...this.peers.keys(), ...this.relayed.keys()]; }

  getParticipants() { return Array.from(this.participants, ([key, p]) => ({ ...p, key })); }

  async _publishPresence(action) {
    if (!this.auth.isLoggedIn() || !this.roomId) return;
    const isHb = action === 'heartbeat';
    const rttScores = isHb ? this._rttScores() : {};
    const capScores = isHb ? this._capScores() : {};
    const reflexive = isHb ? this._reflexiveAddrs() : [];
    const uplinkKbps = this._estimateUplinkKbps();
    const uplinkClass = this._sfuUplinkClass();
    const signed = await this.auth.sign({
      kind: 30078, created_at: replaceableTs(),
      tags: [['d', 'zellous-voice:' + this.roomId], ['action', action], ['channel', this.channelName], ['server', this.serverId]],
      content: JSON.stringify({ action, name: this.displayName, channel: this.channelName, muted: !!this.userMuted, ts: Date.now(), rttScores, capScores, reflexive, uplinkKbps, uplinkClass, hub: this.sfu.hub || null })
    });
    this.pool.publish(signed);
  }

  _estimateUplinkKbps() {
    let best = 0;
    for (const [, peer] of this.peers) {
      if (!peer.pc || peer.pc.connectionState !== 'connected') continue;
      const v = peer._lastAvailOutKbps || 0;
      if (v > best) best = v;
    }
    return best;
  }

  _capScores() {
    const out = {};
    for (const [pk, peer] of this.peers) {
      if (peer._lastAvailOutKbps != null) out[pk] = peer._lastAvailOutKbps;
    }
    return out;
  }

  _reflexiveAddrs() {
    return this._lastReflexive ? [this._lastReflexive] : [];
  }

  _scheduleMutePresence() {
    if (!this.roomId) return;
    clearTimeout(this._mutePresenceTimer);
    this._mutePresenceTimer = setTimeout(() => { if (this.roomId) this._publishPresence('mute').catch(() => {}); }, 400);
  }

  _startHeartbeat() { this._stopHeartbeat(); this.heartbeat = setInterval(() => { if (this.actor?.getSnapshot().matches('connected')) this._publishPresence('heartbeat'); }, HEARTBEAT); }
  _stopHeartbeat() { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } }

  _subscribePresence() {
    this.pool.subscribe('voice-presence-' + this.roomId,
      [{ kinds: [30078], '#d': ['zellous-voice:' + this.roomId] }],
      (event) => this._onPresence(event));
  }

  _subscribeBanEnforcement() {
    if (!this.bans || this._banEnforceHandler) return;
    this._banEnforceHandler = () => this._enforceBans();
    this.bans.addEventListener('updated', this._banEnforceHandler);
  }

  _unsubscribeBanEnforcement() {
    if (this._banEnforceHandler) { this.bans?.removeEventListener('updated', this._banEnforceHandler); this._banEnforceHandler = null; }
  }

  _enforceBans() {
    if (!this.bans || !this.serverId) return;
    const selfBlocked = this.bans.isBanned(this.serverId, this.auth.pubkey) || this.bans.isTimedOut(this.serverId, this.auth.pubkey) || this.bans.isKicked?.(this.serverId, this.auth.pubkey);
    if (selfBlocked) { this.disconnect(); return; }
    for (const pk of Array.from(this.peers.keys())) {
      if (this.bans.isBanned(this.serverId, pk) || this.bans.isTimedOut(this.serverId, pk) || this.bans.isKicked?.(this.serverId, pk)) this._closePeer(pk);
    }
  }

  _onPresence(event) {
    if (event.pubkey === this.auth.pubkey) return;
    let data; try { data = JSON.parse(event.content); } catch { return; }
    if (Date.now() - (data.ts || 0) > PRESENCE_LIVE_MS) return;
    const shortId = 'nostr-' + event.pubkey.slice(0, 12);
    if (data.action === 'leave') { this.sfu.seen.delete(event.pubkey); this.sfu.suspect.delete(event.pubkey); }
    else this.sfu.seen.set(event.pubkey, { at: Date.now(), claim: data.hub || null, cls: typeof data.uplinkClass === 'number' ? data.uplinkClass : 0 });
    if (data.rttScores) this.sfu.rttMatrix.set(event.pubkey, data.rttScores);
    if (data.capScores || data.uplinkKbps != null) {
      if (!this.sfu.capacityMatrix) this.sfu.capacityMatrix = new Map();
      this.sfu.capacityMatrix.set(event.pubkey, { ...(data.capScores || {}), _self: data.uplinkKbps || 0 });
    }
    if (data.reflexive && Array.isArray(data.reflexive) && data.reflexive.length) {
      if (!this.sfu.reflexiveByPeer) this.sfu.reflexiveByPeer = new Map();
      this.sfu.reflexiveByPeer.set(event.pubkey, data.reflexive);
    }
    if (data.action === 'leave') {
      this.participants.delete(shortId);
      this.sfu.pubkeyByShortId.delete(shortId);
      this._closePeer(event.pubkey);
      this._dropRelayed(event.pubkey);
      this._sfuMaybeElect();
    }
    else if (!this.participants.has(shortId)) {
      this.participants.set(shortId, { identity: data.name || event.pubkey.slice(0, 8), isSpeaking: false, isMuted: false, isLocal: false, hasVideo: false, connectionQuality: 'connecting' });
      this.sfu.pubkeyByShortId.set(shortId, event.pubkey);
      this._sfuMaybeElect();
      this._maybeConnect(event.pubkey);
    } else {
      if (!this.sfu.pubkeyByShortId.has(shortId)) this.sfu.pubkeyByShortId.set(shortId, event.pubkey);
      this._sfuMaybeElect();
      if (this._sfuShouldHaveConnectionTo(event.pubkey) && !this.peers.has(event.pubkey)) this._maybeConnect(event.pubkey);
    }
    const remote = this.participants.get(shortId);
    if (remote && typeof data.muted === 'boolean' && data.action !== 'leave') remote.isMuted = data.muted;
    this._emit('participants', { list: this.getParticipants() });
  }

  _sfuShouldHaveConnectionTo(peerPubkey) {
    if (!this.sfu.hub) return false;
    if (this.sfu.hub === this.auth.pubkey) return true;
    return peerPubkey === this.sfu.hub;
  }

  _subscribeSignals() {
    this.pool.subscribe('voice-signals-' + this.roomId,
      [{ kinds: [30078], '#p': [this.auth.pubkey], '#r': [this.roomId] }],
      (event) => this._handleSignal(event));
  }

  _maybeConnect(peerPubkey, force = false) {
    if (!peerPubkey || peerPubkey === this.auth.pubkey || this.peers.has(peerPubkey)) return;
    if (this.bans && this.serverId && (this.bans.isBanned?.(this.serverId, peerPubkey) || this.bans.isTimedOut?.(this.serverId, peerPubkey) || this.bans.isKicked?.(this.serverId, peerPubkey))) return;

    if (!force && !this._sfuShouldHaveConnectionTo(peerPubkey)) return;
    this._cancelReconnect(peerPubkey);
    const fsmActor = this.xstate.createActor(this.fsm.peerMachine);
    fsmActor.subscribe((snap) => { const p = this.peers.get(peerPubkey); if (p) p.state = snap.value; });
    fsmActor.start();
    const peer = { pc: null, audioEl: null, pendingCandidates: [], bufferedCandidates: [], iceTimer: null, disconnectTimer: null, connectTimer: null, failCount: 0, state: 'new', fsm: fsmActor, _stallInterval: null, remoteDescSet: false, trackEndedRestart: false };
    this.peers.set(peerPubkey, peer);

    const relayRequested = this.forceRelay && hasTurnServer();
    const pc = this.createPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 4, iceTransportPolicy: relayRequested ? 'relay' : 'all' });
    peer.pc = pc;

    peer.connectTimer = setTimeout(() => {
      peer.connectTimer = null;
      if (pc.connectionState === 'connected') return;
      this._doIceRestart(peer, peerPubkey, fsmActor);
    }, CONNECT_TIMEOUT);
    const isOfferer = this.auth.pubkey > peerPubkey;
    if (isOfferer) {
      if (this.localStream) this.localStream.getTracks().forEach(t => pc.addTransceiver(t, { direction: 'sendrecv', streams: [this.localStream] }));
      else pc.addTransceiver('audio', { direction: 'recvonly' });
      if (this.cameraStream) pc.addTransceiver(this.cameraStream.getVideoTracks()[0], { direction: 'sendrecv', streams: [this.cameraStream] });
    }
    this._wirePeer(peer, peerPubkey, fsmActor, isOfferer);

    const known = this.sfu.reflexiveByPeer?.get(peerPubkey);
    if (known && known.length) {
      for (const r of known) {
        if (!r?.addr || !r?.port) continue;
        const proto = (r.protocol || 'udp').toLowerCase();
        const typ = r.type === 'relay' ? 'relay' : 'srflx';
        const sdp = `candidate:0 1 ${proto} 1685987071 ${r.addr} ${r.port} typ ${typ}`;
        peer.bufferedCandidates.push({ candidate: sdp, sdpMid: '0', sdpMLineIndex: 0 });
      }
    }
  }

  _wirePeer(peer, peerPubkey, fsmActor, isOfferer) {
    const pc = peer.pc;
    pc.onsignalingstatechange = () => { if (pc.signalingState === 'stable' && peer._renegotiate) { peer._renegotiate = false; this._renegotiate(peerPubkey, peer); } };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      if (ev.track.kind === 'audio' && peer.remoteStream && stream.id !== peer.remoteStream.id) {
        const source = peer.relayMap?.get(stream.id);
        if (source) this._attachRelayed(peerPubkey, source, ev, stream);
        else (peer.pendingRelay ||= new Map()).set(stream.id, { ev, stream });
        return;
      }
      if (ev.track.kind === 'video') {
        const attachVideo = (source) => {
          ev.track.onunmute = () => this._setRemoteVideo(source, true);
          ev.track.onmute = () => this._setRemoteVideo(source, false);
          ev.track.onended = () => this._setRemoteVideo(source, false);
          this.onVideoTrack?.({ peerPubkey: source, track: ev.track, stream });
        };
        if (!peer.relayTxs?.has(ev.transceiver)) { peer.remoteVideoTrack = ev.track; this._sfuRelayAll(); }
        const via = peer.relayMap?.get(stream.id);
        if (via) attachVideo(via);
        else if (this.sfu.hub && this.sfu.hub !== this.auth.pubkey && this.sfu.hub === peerPubkey) {
          (peer.pendingRelay ||= new Map()).set(stream.id, { ev, stream, attachVideo });
          setTimeout(() => { const pending = peer.pendingRelay?.get(stream.id); if (pending) { peer.pendingRelay.delete(stream.id); attachVideo(peerPubkey); } }, 1500);
        } else attachVideo(peerPubkey);
        return;
      }
      this.onAudioTrack?.({ peerPubkey, track: ev.track, stream, peer });
      this._applyPlaybackMute();
      peer.remoteStream = stream;
      peer.remoteTrack = ev.track;
      this._attachAnalyzer(peerPubkey, stream);
      this._sfuRelayAll();
      this._emit('remote-stream', { peerPubkey, stream });
      try { ev.receiver.playoutDelayHint = 0.02; } catch {}
      ev.track.onended = () => { if (peer.fsm.getSnapshot().matches('connected')) this._doIceRestart(peer, peerPubkey, fsmActor); };
      if (!peer._stallInterval) peer._stallInterval = setInterval(() => this._checkStall(peer, peerPubkey, fsmActor), STALL_CHECK);
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const cand = ev.candidate.toJSON();

      const cstr = cand.candidate || '';
      const isDirect = cstr.includes(' typ host') || cstr.includes(' typ srflx') || cstr.includes(' typ prflx');
      if (isDirect) {
        this._publishSignal(peerPubkey, 'ice', [cand]);
        return;
      }
      peer.pendingCandidates.push(cand);
      if (peer.iceTimer) clearTimeout(peer.iceTimer);
      peer.iceTimer = setTimeout(() => { if (peer.pendingCandidates.length) { this._publishSignal(peerPubkey, 'ice', peer.pendingCandidates.splice(0)); peer.iceTimer = null; } }, 100);
    };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { if (peer.iceTimer) { clearTimeout(peer.iceTimer); peer.iceTimer = null; } if (peer.pendingCandidates.length) this._publishSignal(peerPubkey, 'ice', peer.pendingCandidates.splice(0)); } };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        peer.failCount = 0; this._cancelReconnect(peerPubkey);
        if (peer.hubTimer) { clearTimeout(peer.hubTimer); peer.hubTimer = null; }
        if (fsmActor.getSnapshot().can({ type: 'recv_answer' })) fsmActor.send({ type: 'recv_answer' });
        if (peer.disconnectTimer) { clearTimeout(peer.disconnectTimer); peer.disconnectTimer = null; }
        if (peer.connectTimer) { clearTimeout(peer.connectTimer); peer.connectTimer = null; }
        this._applyAudioHints(pc);
        this._setConnectionQuality(peerPubkey, 'good');
        this._sfuRelayAll();
      }

      if (pc.connectionState === 'disconnected' && this.sfu.hub === peerPubkey && !peer.hubTimer) peer.hubTimer = setTimeout(() => { peer.hubTimer = null; this._sfuOnHubLost(); }, HUB_DISCONNECT_MS);
      if (pc.connectionState === 'disconnected') { if (peer.connectTimer) { clearTimeout(peer.connectTimer); peer.connectTimer = null; } fsmActor.send({ type: 'disconnect' }); peer.disconnectTimer = setTimeout(() => this._doIceRestart(peer, peerPubkey, fsmActor), DISCONNECT_GRACE); this._setConnectionQuality(peerPubkey, 'poor'); }
      if (pc.connectionState === 'failed') this._doIceRestart(peer, peerPubkey, fsmActor);
      if (pc.connectionState === 'closed') { this._closePeer(peerPubkey); if (this.sfu.hub === peerPubkey) this._sfuOnHubLost(); }
      if (pc.connectionState === 'failed' && this.sfu.hub === peerPubkey) this._sfuOnHubLost();
    };
    this._ensureDataChannel(peer, peerPubkey, isOfferer);
    if (isOfferer) {
      fsmActor.send({ type: 'offer' });
      pc.createOffer().then(o => { o.sdp = this._mungeDtx(o.sdp); return pc.setLocalDescription(o).then(() => { this._publishSignal(peerPubkey, 'offer', o); this._armOfferRetry(peer, peerPubkey, o, 1); }); }).catch(() => {});
    }
  }

  _armOfferRetry(peer, peerPubkey, offer, attempt) {
    if (peer.offerTimer) clearTimeout(peer.offerTimer);
    peer.offerTimer = setTimeout(() => {
      peer.offerTimer = null;
      if (this.peers.get(peerPubkey) !== peer || peer.pc.signalingState !== 'have-local-offer' || attempt > OFFER_RETRIES) return;
      this._publishSignal(peerPubkey, 'offer', offer);
      this._armOfferRetry(peer, peerPubkey, offer, attempt + 1);
    }, OFFER_RETRY_MS);
  }

  _mungeDtx(sdp) {
    if (!sdp) return sdp;
    const lines = sdp.split('\r\n');
    const opusPts = new Set();
    for (const line of lines) {
      const m = /^a=rtpmap:(\d+)\s+opus\//i.exec(line);
      if (m) opusPts.add(m[1]);
    }
    if (!opusPts.size) return sdp;
    const out = lines.map(line => {
      const m = /^a=fmtp:(\d+)\s+(.*)$/.exec(line);
      if (!m || !opusPts.has(m[1])) return line;
      const params = m[2].split(';').map(p => p.trim()).filter(p => p && !/^usedtx=/i.test(p) && !/^useinbandfec=/i.test(p));
      if (this.dtx) params.push('usedtx=1');
      if (this.fec) params.push('useinbandfec=1');
      return 'a=fmtp:' + m[1] + ' ' + params.join(';');
    });
    return out.join('\r\n');
  }

  _applyAudioHints(pc) {
    try {
      pc.getSenders().forEach(s => {
        if (!s.track || s.track.kind !== 'audio') return;
        const p = s.getParameters(); if (!p.encodings?.length) return;
        p.encodings[0].networkPriority = 'high';

        p.encodings[0].maxBitrate = this._targetBitrate || OPUS_BITRATE_LADDER[DEFAULT_AUDIO_QUALITY];
        p.encodings[0].priority = 'high';
        s.setParameters(p).catch(() => {});
      });
      pc.getReceivers().forEach(r => { if (r.track?.kind !== 'audio') return; try { r.playoutDelayHint = 0.02; } catch {} });

      pc.getTransceivers().forEach(t => {
        if (t.receiver?.track?.kind !== 'audio' && t.sender?.track?.kind !== 'audio') return;
        if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
        const caps = RTCRtpSender.getCapabilities('audio'); if (!caps?.codecs) return;
        const opus = caps.codecs.filter(c => /opus/i.test(c.mimeType));
        const others = caps.codecs.filter(c => !/opus/i.test(c.mimeType));
        try { t.setCodecPreferences([...opus, ...others]); } catch {}
      });
    } catch {}
  }

  _checkStall(peer, peerPubkey, fsmActor) {
    if (!peer.audioEl?.srcObject || !peer.fsm.getSnapshot().matches('connected') || peer.trackEndedRestart) return;
    const allEnded = peer.audioEl.srcObject.getTracks().every(t => t.readyState === 'ended');
    if (!allEnded) return;
    peer.trackEndedRestart = true;
    this._doIceRestart(peer, peerPubkey, fsmActor);
  }

  _doIceRestart(peer, peerPubkey, fsmActor) {
    const pc = peer.pc;
    if (peer.disconnectTimer) { clearTimeout(peer.disconnectTimer); peer.disconnectTimer = null; }
    if (peer.connectTimer) { clearTimeout(peer.connectTimer); peer.connectTimer = null; }
    peer.failCount++;
    this._setConnectionQuality(peerPubkey, 'poor');
    if (peer.failCount <= 1 && this.auth.pubkey > peerPubkey) {
      fsmActor.send({ type: 'restart' }); pc.restartIce();

      peer.connectTimer = setTimeout(() => {
        peer.connectTimer = null;
        if (pc.connectionState === 'connected') return;
        this._doIceRestart(peer, peerPubkey, fsmActor);
      }, CONNECT_TIMEOUT);
      pc.createOffer({ iceRestart: true }).then(o => { o.sdp = this._mungeDtx(o.sdp); return pc.setLocalDescription(o).then(() => this._publishSignal(peerPubkey, 'offer', o)); }).catch(() => this._closePeer(peerPubkey));
    } else { this._closePeer(peerPubkey); this._scheduleReconnect(peerPubkey, peer.failCount); }
  }

  _handleSignal(event) {
    const from = event.pubkey; if (from === this.auth.pubkey) return;
    let data; try { data = JSON.parse(event.content); } catch { return; }
    if (!data?.type) return;
    if (!this.peers.has(from)) {
      if (!this.participants.has('nostr-' + from.slice(0, 12))) return;
      this._maybeConnect(from, data.type === 'offer');
    }
    const peer = this.peers.get(from); if (!peer) return;
    const pc = peer.pc; const fsmActor = peer.fsm;
    const addCands = (cands) => cands.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
    const drainBuf = () => { addCands(peer.bufferedCandidates); peer.bufferedCandidates = []; };
    const doAnswer = async () => {
      if (fsmActor.getSnapshot().can({ type: 'recv_offer' })) fsmActor.send({ type: 'recv_offer' });
      await pc.setRemoteDescription(new RTCSessionDescription(data.data));
      peer.remoteDescSet = true; drainBuf();
      const hasAudioTx = pc.getTransceivers().some(t => t.receiver.track?.kind === 'audio' && !peer.relayTxs?.has(t));
      if (!hasAudioTx) pc.addTransceiver('audio', { direction: this.localStream ? 'sendrecv' : 'recvonly' });
      if (this.localStream) { const hasSender = pc.getSenders().some(s => s.track?.kind === 'audio'); if (!hasSender) this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream)); }
      if (this.cameraStream) { const vt = pc.getTransceivers().find(t => t.receiver.track.kind === 'video' && !t.stopped && !t.sender.track && !peer.relayTxs?.has(t)); if (vt) { vt.direction = 'sendrecv'; vt.sender.replaceTrack(this.cameraStream.getVideoTracks()[0]).catch(() => {}); } }
      const a = await pc.createAnswer(); a.sdp = this._mungeDtx(a.sdp); await pc.setLocalDescription(a); fsmActor.send({ type: 'sent_answer' }); this._publishSignal(from, 'answer', a);
    };
    if (data.type === 'offer') {
      const polite = this.auth.pubkey < from; const collision = pc.signalingState !== 'stable';
      if (collision && !polite) return;
      if (collision && polite) { pc.setLocalDescription({ type: 'rollback' }).then(doAnswer).catch(() => {}); return; }
      doAnswer().catch(() => {});
    } else if (data.type === 'answer' && pc.signalingState === 'have-local-offer') {
      pc.setRemoteDescription(new RTCSessionDescription(data.data)).then(() => { peer.remoteDescSet = true; drainBuf(); }).catch(() => {});
    } else if (data.type === 'relay') {
      (peer.relayMap ||= new Map()).set(data.data.streamId, data.data.src);
      const pending = peer.pendingRelay?.get(data.data.streamId);
      if (pending) { peer.pendingRelay.delete(data.data.streamId); if (pending.attachVideo) pending.attachVideo(data.data.src); else this._attachRelayed(from, data.data.src, pending.ev, pending.stream); }
    } else if (data.type === 'ice') {
      const cands = Array.isArray(data.data) ? data.data : [data.data];
      if (peer.remoteDescSet) addCands(cands); else peer.bufferedCandidates.push(...cands);
    }
  }

  _setConnectionQuality(peerPubkey, quality) {
    const shortId = 'nostr-' + peerPubkey.slice(0, 12);
    const p = this.participants.get(shortId);
    if (!p || p.connectionQuality === quality) return;
    p.connectionQuality = quality;
    this._emit('participants', { list: this.getParticipants() });
  }

  async _publishSignal(toPubkey, type, data) {
    if (!this.auth.pubkey || !this.roomId) return;
    const d = 'zellous-rtc:' + this.roomId + ':' + this.auth.pubkey + ':' + toPubkey + ':' + type + ':' + (type === 'ice' ? Date.now() : 'sdp');
    const signed = await this.auth.sign({ kind: 30078, created_at: replaceableTs(), tags: [['d', d], ['p', toPubkey], ['r', this.roomId]], content: JSON.stringify({ type, data }) });
    this.pool.publish(signed);
  }

  _closePeer(peerPubkey) {
    const peer = this.peers.get(peerPubkey); if (!peer) return;
    if (peer.iceTimer) clearTimeout(peer.iceTimer);
    if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
    if (peer.connectTimer) clearTimeout(peer.connectTimer);
    if (peer._stallInterval) clearInterval(peer._stallInterval);
    try { peer.dc?.close(); } catch {}
    try { peer.pc?.close(); } catch {}
    if (peer.audioEl) { peer.audioEl.srcObject = null; peer.audioEl.remove(); }
    try { peer.fsm?.stop?.(); } catch {}
    this._detachAnalyzer(peerPubkey);
    for (const [src, entry] of Array.from(this.relayed)) if (entry.via === peerPubkey) this._dropRelayed(src);
    if (peer.hubTimer) clearTimeout(peer.hubTimer);
    if (peer.offerTimer) clearTimeout(peer.offerTimer);
    if (this.sfu.hub === this.auth.pubkey) {
      for (const [targetPk, target] of this.peers) {
        if (targetPk === peerPubkey || !target.relays) continue;
        let dropped = false;
        for (const key of [peerPubkey, peerPubkey + '#v']) {
          const relayed = target.relays.get(key);
          if (!relayed) continue;
          try { relayed.tx.direction = 'inactive'; } catch {}
          target.relayTxs?.delete(relayed.tx);
          target.relays.delete(key);
          dropped = true;
        }
        if (dropped) this._renegotiate(targetPk, target);
      }
    }
    this.peers.delete(peerPubkey);
    this._emit('peer-closed', { peerPubkey });
    if (this.sfu.hub && this.sfu.hub !== this.auth.pubkey && this.sfu.hub === peerPubkey) this._sfuOnHubLost();
  }

  _attachRelayed(hubPubkey, source, ev, stream) {
    let entry = this.relayed.get(source);
    if (!entry) { entry = { audioEl: null, via: hubPubkey }; this.relayed.set(source, entry); }
    entry.remoteStream = stream;
    this.onAudioTrack?.({ peerPubkey: source, track: ev.track, stream, peer: entry });
    this._applyPlaybackMute();
    this._attachAnalyzer(source, stream);
    this._emit('remote-stream', { peerPubkey: source, stream });
  }

  _dropRelayed(source) {
    const entry = this.relayed.get(source); if (!entry) return;
    if (entry.audioEl) { entry.audioEl.srcObject = null; entry.audioEl.remove(); }
    this._detachAnalyzer(source);
    this.relayed.delete(source);
  }

  _renegotiate(peerPubkey, peer) {
    const pc = peer.pc; if (!pc) return;
    if (pc.signalingState !== 'stable') { peer._renegotiate = true; return; }
    pc.createOffer().then((o) => { o.sdp = this._mungeDtx(o.sdp); return pc.setLocalDescription(o).then(() => this._publishSignal(peerPubkey, 'offer', o)); }).catch(() => {});
  }

  _sfuRelayAll() {
    if (this.sfu.hub !== this.auth.pubkey) return;
    for (const [sourcePk, source] of this.peers) {
      const feeds = [[sourcePk, source.remoteTrack, true], [sourcePk + '#v', source.remoteVideoTrack, source.videoOn]];
      for (const [feedKey, track, wanted] of feeds) {
        if (!track || !wanted || track.readyState !== 'live') continue;
        for (const [targetPk, target] of this.peers) {
          if (targetPk === sourcePk || target.pc?.connectionState !== 'connected') continue;
          target.relays ||= new Map();
          target.relayTxs ||= new Set();
          const existing = target.relays.get(feedKey);
          if (existing) { if (existing.track !== track) { existing.tx.sender.replaceTrack(track).catch(() => {}); existing.track = track; } continue; }
          const stream = new MediaStream();
          const tx = target.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
          target.relays.set(feedKey, { tx, track });
          target.relayTxs.add(tx);
          this._publishSignal(targetPk, 'relay', { streamId: stream.id, src: sourcePk });
          this._renegotiate(targetPk, target);
        }
      }
    }
  }

  _cancelReconnect(pk) { const e = this.retrySchedule[pk]; if (e) { clearTimeout(e.timer); delete this.retrySchedule[pk]; } }
  _scheduleReconnect(pk, attempt) {
    const a = attempt || 0;
    if (a >= 6) {

      this._setConnectionQuality(pk, 'failed');
      this._emit('peer-connect-failed', { peerPubkey: pk, attempts: a });
      return;
    }
    this._cancelReconnect(pk);
    const timer = setTimeout(() => { delete this.retrySchedule[pk]; if (!this.peers.has(pk) && this.roomId) this._maybeConnect(pk); }, Math.min(2 ** a * 2000, 30000));
    this.retrySchedule[pk] = { attempt: a, timer };
  }

  _sfuStart() {
    this.sfu.actor = this.xstate.createActor(this.fsm.sfuMachine);
    this.sfu.actor.start();
    this.sfu.hub = null;
    this.sfu.myClass = undefined;
    this.sfu.capacityMatrix = new Map();
    this.sfu.reflexiveByPeer = new Map();
    this._sfuStopStats();
    this.sfu.statsInterval = setInterval(() => this._sfuPoll(), 2500);
    this.sfu.watchdog = setInterval(() => this._sfuWatchdog(), HUB_PING_MS);
    this._sfuMaybeElect();
  }

  _sfuWatchdog() {
    if (!this.sfu.hub) return;
    if (this.sfu.hub === this.auth.pubkey) {
      for (const [, peer] of this.peers) this._dcSendJSON(peer, { type: 'hb' });
      return;
    }
    const hubPeer = this.peers.get(this.sfu.hub);
    if (hubPeer && hubPeer.lastHb && Date.now() - hubPeer.lastHb > HUB_SILENCE_MS) this._sfuOnHubLost(true);
  }
  _sfuStop() {
    this._sfuStopStats();
    if (this.sfu.routeTimer) { clearTimeout(this.sfu.routeTimer); this.sfu.routeTimer = null; }
    this.sfu.routeFor = null;
    this.sfu.actor?.send({ type: 'dissolve' });
    this.sfu.hub = null;
    this.sfu.rttMatrix.clear();
    this.sfu.capacityMatrix?.clear();
    this.sfu.reflexiveByPeer?.clear();
    this.sfu.seen.clear();
    this.sfu.suspect.clear();
    this.sfu.pubkeyByShortId.clear();
    this._lastReflexive = null;
  }
  _sfuStopStats() { if (this.sfu.watchdog) { clearInterval(this.sfu.watchdog); this.sfu.watchdog = null; } if (this.sfu.statsInterval) { clearInterval(this.sfu.statsInterval); this.sfu.statsInterval = null; } if (this.sfu.electionTimer) { clearTimeout(this.sfu.electionTimer); this.sfu.electionTimer = null; } }
  async _sfuPoll() {
    const rttScores = {};
    const tasks = [];
    for (const [pk, peer] of this.peers) {
      if (!peer.pc || peer.pc.connectionState !== 'connected') continue;
      tasks.push(peer.pc.getStats().then(stats => {
        let pairRtt = null, availOut = null, lossFrac = 0, reflex = null;
        stats.forEach(r => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) {
            if (r.currentRoundTripTime != null) pairRtt = r.currentRoundTripTime;
            if (r.availableOutgoingBitrate != null) availOut = r.availableOutgoingBitrate;

            const localId = r.localCandidateId; if (localId) {
              const local = stats.get?.(localId); if (local && (local.candidateType === 'srflx' || local.candidateType === 'prflx' || local.candidateType === 'relay')) {
                reflex = { addr: local.address || local.ip, port: local.port, type: local.candidateType, protocol: local.protocol };
              }
            }
          }
          if (r.type === 'remote-inbound-rtp' && r.kind === 'audio' && r.fractionLost != null) {
            lossFrac = Math.max(lossFrac, r.fractionLost);
          }
        });
        if (pairRtt != null) rttScores[pk] = Math.round(pairRtt * 1000);

        let capKbps = null;
        if (availOut != null && availOut > 0) capKbps = Math.round(availOut / 1000);
        else if (pairRtt != null) {
          const rttMs = pairRtt * 1000;
          capKbps = Math.round(2000 * Math.max(0, 1 - rttMs / 400) * Math.max(0, 1 - lossFrac * 4));
        }
        if (capKbps != null) peer._lastAvailOutKbps = capKbps;
        if (reflex && reflex.addr && reflex.port) this._lastReflexive = reflex;
      }).catch(() => {}));
    }
    await Promise.all(tasks);
    this.sfu.rttMatrix.set(this.auth.pubkey, rttScores);
    this._sfuPruneStale();
    this._sfuRelayAll();
    this._sfuMaybeElect();
  }

  _sfuPruneStale() {
    const now = Date.now();
    let changed = false;
    for (const shortId of Array.from(this.participants.keys())) {
      if (shortId === 'local') continue;
      const pk = this.sfu.pubkeyByShortId.get(shortId);
      if (!pk) continue;
      const seen = this.sfu.seen.get(pk);
      if (seen && now - seen.at <= PEER_STALE_MS) continue;
      if (seen && this.peers.get(pk)?.pc?.connectionState === 'connected' && now - seen.at <= PEER_STALE_MS * 2) continue;
      this.participants.delete(shortId);
      this.sfu.pubkeyByShortId.delete(shortId);
      this.sfu.seen.delete(pk);
      this._closePeer(pk);
      this._dropRelayed(pk);
      changed = true;
    }
    if (changed) this._emit('participants', { list: this.getParticipants() });
  }

  _sfuMaybeElect() {
    if (this.sfu.electionTimer) return;
    this.sfu.electionTimer = setTimeout(() => { this.sfu.electionTimer = null; this._sfuElect(); }, 600);
  }

  _sfuUplinkClass() {
    const raw = Math.round(Math.log2(this._estimateUplinkKbps() + 1));
    if (this.sfu.myClass === undefined || raw > this.sfu.myClass) this.sfu.myClass = raw;
    return this.sfu.myClass;
  }

  _sfuLiveSet() {
    const now = Date.now();
    const live = new Map();
    live.set(this.auth.pubkey, { claim: this.sfu.hub, cls: this.sfu.myClass || 0 });
    for (const [pk, seen] of this.sfu.seen) {
      if (now - seen.at > PEER_STALE_MS) continue;
      const suspectedAt = this.sfu.suspect.get(pk);
      if (suspectedAt && seen.at <= suspectedAt) continue;
      live.set(pk, { claim: seen.claim, cls: seen.cls });
    }
    return live;
  }

  _sfuPick(live) {
    const tally = new Map();
    for (const [, v] of live) if (v.claim && live.has(v.claim)) tally.set(v.claim, (tally.get(v.claim) || 0) + 1);
    const pool = tally.size ? [...tally.keys()] : [...live.keys()];
    pool.sort((a, b) => ((tally.get(b) || 0) - (tally.get(a) || 0)) || (live.get(b).cls - live.get(a).cls) || (a > b ? -1 : 1));
    return pool[0];
  }

  _sfuElect() {
    const live = this._sfuLiveSet();
    const winner = this._sfuPick(live);
    if (!winner) return;
    if (winner === this.sfu.hub) { this._sfuApplyTopology(winner); return; }
    const previous = this.sfu.hub;
    this.sfu.hub = winner;
    this.sfu.routeFor = null;
    try { this.sfu.actor?.send({ type: 'elect' }); } catch {}
    this.sfu.actor?.send({ type: 'elected' });
    this._emit('hub-changed', { hub: winner, previous, uplink: live.get(winner).cls, voters: live.size });
    this._publishPresence('hub').catch(() => {});
    this._sfuApplyTopology(winner);
  }

  _sfuApplyTopology(hubPk) {
    if (hubPk !== this.auth.pubkey) {
      for (const pk of Array.from(this.peers.keys())) if (pk !== hubPk) this._closePeer(pk);
      if (!this.peers.has(hubPk)) this._maybeConnect(hubPk);
      this._sfuWatchRoute(hubPk);
      return;
    }
    for (const pk of this._sfuLiveSet().keys()) if (pk !== this.auth.pubkey && !this.peers.has(pk)) this._maybeConnect(pk);
    this._sfuRelayAll();
  }

  _sfuWatchRoute(hubPk) {
    if (this.sfu.routeFor === hubPk) return;
    this.sfu.routeFor = hubPk;
    if (this.sfu.routeTimer) clearTimeout(this.sfu.routeTimer);
    this.sfu.routeTimer = setTimeout(() => {
      this.sfu.routeTimer = null;
      if (this.sfu.hub !== hubPk) return;
      if (this.peers.get(hubPk)?.pc?.connectionState === 'connected') return;
      this.sfu.routeFor = null;
      this._sfuOnHubLost();
    }, HUB_ROUTE_TIMEOUT_MS);
  }

  _sfuOnHubLost(silent = false) {
    const lost = this.sfu.hub;
    if (!lost || lost === this.auth.pubkey) return;
    if (!silent && this.peers.get(lost)?.pc?.connectionState === 'connected') return;
    this.sfu.suspect.set(lost, Date.now());
    this.sfu.hub = null;
    this.sfu.routeFor = null;
    this._emit('hub-lost', { hub: lost, silent });
    if (silent) { this._closePeer(lost); this._dropRelayed(lost); }
    this._sfuElect();
  }

  _rttScores() { return this.sfu.rttMatrix.get(this.auth.pubkey) || {}; }

  debug() {
    const peers = [];
    for (const [pk, peer] of this.peers) peers.push({ pubkey: pk.slice(0, 12), fsmState: peer.fsm?.getSnapshot().value, iceState: peer.pc?.iceConnectionState, connState: peer.pc?.connectionState, candidates: peer.pendingCandidates.length, buffered: peer.bufferedCandidates.length });
    const rttMatrix = {}; for (const [k, v] of this.sfu.rttMatrix) rttMatrix[k.slice(0, 12)] = v;
    return { fsm: this.actor?.getSnapshot().value, peers, participants: this.getParticipants(), sfu: { mode: this.sfu.actor?.getSnapshot().value || 'mesh', hub: this.sfu.hub?.slice(0, 12) || null, rttMatrix }, retrySchedule: this.retrySchedule };
  }

  heal() {
    if (!this.roomId) return;
    const bad = { disconnected: 1, failed: 1, closed: 1 };
    for (const [pk, peer] of this.peers) if (bad[peer.pc?.connectionState]) { this._closePeer(pk); this._scheduleReconnect(pk, 0); }
  }

  _emit(t, d) { this.dispatchEvent(new CustomEvent(t, { detail: d })); }
}

export const createVoiceSession = (opts) => new VoiceSession(opts);
