

import { VoiceSession } from './src/voice.js';

const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

class FakeTrack {
  constructor(kind = 'audio') { this.kind = kind; this.enabled = true; this.readyState = 'live'; this._onended = null; }
  stop() { this.readyState = 'ended'; }
  set onended(fn) { this._onended = fn; }
  get onended() { return this._onended; }
}

class FakeMediaStream {
  constructor() { this._tracks = [new FakeTrack('audio')]; }
  getTracks() { return this._tracks; }
  getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
}

let lastGumConstraints = null;
const fakeMediaDevices = {
  async getUserMedia(constraints) {
    lastGumConstraints = constraints;
    return new FakeMediaStream();
  }
};

class FakeSender {
  constructor(track) {
    this.track = track;
    this._params = { encodings: [{}] };
  }
  getParameters() { return JSON.parse(JSON.stringify(this._params)); }
  async setParameters(p) { this._params = p; lastSetParametersCall = p; return; }
}

let lastSetParametersCall = null;

class FakeReceiver {
  constructor(track) { this.track = track; this.playoutDelayHint = null; }
}

class FakeTransceiver {
  constructor(kind, direction) {
    this.direction = direction;
    this.sender = new FakeSender(direction.includes('send') ? new FakeTrack(kind) : null);
    this.receiver = new FakeReceiver(direction.includes('recv') ? new FakeTrack(kind) : null);
  }
  setCodecPreferences() {}
}

let lastOfferSdp = null;
let lastLocalDescSdp = null;

class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this._transceivers = [];
    this._listeners = {};
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.iceGatheringState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.ondatachannel = null;
  }
  addTransceiver(trackOrKind, opts) {
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    const t = new FakeTransceiver(kind, opts?.direction || 'sendrecv');
    this._transceivers.push(t);
    return t;
  }
  addTrack(track) {
    const s = new FakeSender(track);
    if (!this._transceivers.length) this._transceivers.push({ sender: s, receiver: new FakeReceiver(null), direction: 'sendonly' });
    return s;
  }
  getSenders() { return this._transceivers.map(t => t.sender).filter(Boolean); }
  getReceivers() { return this._transceivers.map(t => t.receiver).filter(Boolean); }
  getTransceivers() { return this._transceivers; }
  createDataChannel(label) {
    return { label, readyState: 'connecting', close() {}, send() {} };
  }
  async createOffer(opts) {
    const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' +
      'a=rtpmap:111 opus/48000/2\r\n' +
      'a=fmtp:111 minptime=10;useinbandfec=1\r\n';
    lastOfferSdp = { sdp, iceRestart: !!opts?.iceRestart };
    return { type: 'offer', sdp };
  }
  async createAnswer() {
    const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' +
      'a=rtpmap:111 opus/48000/2\r\n' +
      'a=fmtp:111 minptime=10;useinbandfec=1\r\n';
    return { type: 'answer', sdp };
  }
  async setLocalDescription(desc) {
    this.localDescription = desc;
    lastLocalDescSdp = desc.sdp;
  }
  async setRemoteDescription(desc) { this.remoteDescription = desc; }
  async addIceCandidate() {}
  async getStats() { return new Map(); }
  restartIce() {}
  close() { this.connectionState = 'closed'; }
}

const makeActor = () => {
  let state = 'idle';
  const listeners = [];
  return {
    subscribe(fn) { listeners.push(fn); return { unsubscribe() {} }; },
    start() {},
    stop() {},
    send(ev) {
      if (ev.type === 'connect') state = 'connecting';
      else if (ev.type === 'connected') state = 'connected';
      else if (ev.type === 'disconnect') state = 'disconnecting';
      else if (ev.type === 'done') state = 'idle';
      else if (ev.type === 'fail') state = 'idle';
      listeners.forEach(fn => fn({ value: state }));
    },
    getSnapshot() {
      return {
        value: state,
        matches: (s) => state === s,
        can: (ev) => {
          if (ev.type === 'connect') return state === 'idle';
          if (ev.type === 'disconnect') return state === 'connected' || state === 'connecting';
          if (ev.type === 'recv_answer') return true;
          if (ev.type === 'recv_offer') return true;
          return true;
        }
      };
    }
  };
};
const fakeXstate = { createActor: () => makeActor() };
const fakeFsm = { voiceMachine: {}, peerMachine: {}, sfuMachine: {} };

const fakeAuth = {
  pubkey: 'a'.repeat(64),
  isLoggedIn: () => true,
  async sign(evt) { return { ...evt, pubkey: this.pubkey, id: 'fakeid', sig: 'fakesig' }; }
};

const fakePool = {
  subscribe() {}, unsubscribe() {},
  publish() {}
};

const vs = new VoiceSession({
  fsm: fakeFsm, xstate: fakeXstate, relayPool: fakePool, auth: fakeAuth,
  mediaDevices: fakeMediaDevices,
  pttMode: false,
  micSensitivity: 0.09,
  noiseSuppression: false,
  echoCancellation: false,
  autoGainControl: false,
  audioQuality: 'low',
  dtx: false
});

check('ctor: pttMode reflected', vs.pttMode === false, `vs.pttMode=${vs.pttMode}`);
check('ctor: micSensitivity reflected', vs.micSensitivity === 0.09, `vs.micSensitivity=${vs.micSensitivity}`);
check('ctor: noiseSuppression reflected', vs.noiseSuppression === false, `vs.noiseSuppression=${vs.noiseSuppression}`);
check('ctor: echoCancellation reflected', vs.echoCancellation === false, `vs.echoCancellation=${vs.echoCancellation}`);
check('ctor: autoGainControl reflected', vs.autoGainControl === false, `vs.autoGainControl=${vs.autoGainControl}`);
check('ctor: audioQuality tier reflected', vs.audioQuality === 'low', `vs.audioQuality=${vs.audioQuality}`);
check('ctor: dtx reflected', vs.dtx === false, `vs.dtx=${vs.dtx}`);
check('ctor: _targetBitrate derived from ladder (low=16000)', vs._targetBitrate === 16000, `vs._targetBitrate=${vs._targetBitrate}`);

await vs.connect('general', { displayName: 'Tester' });

check('connect(): getUserMedia was called with an object', !!lastGumConstraints, JSON.stringify(lastGumConstraints));
check('connect(): echoCancellation constraint passed through = false',
  lastGumConstraints?.audio?.echoCancellation === false, JSON.stringify(lastGumConstraints));
check('connect(): noiseSuppression constraint passed through = false',
  lastGumConstraints?.audio?.noiseSuppression === false, JSON.stringify(lastGumConstraints));
check('connect(): autoGainControl constraint passed through = false',
  lastGumConstraints?.audio?.autoGainControl === false, JSON.stringify(lastGumConstraints));

check('pttMode=false (VAD/open-mic): starts UNmuted', vs.muted === false, `vs.muted=${vs.muted}`);
check('pttMode=false: local audio track.enabled=true', vs.localStream.getAudioTracks()[0].enabled === true,
  `track.enabled=${vs.localStream.getAudioTracks()[0].enabled}`);

vs.setMuted(true);
check('setMuted(true) flips real track.enabled=false', vs.localStream.getAudioTracks()[0].enabled === false,
  `track.enabled=${vs.localStream.getAudioTracks()[0].enabled}`);
vs.toggleMic();
check('toggleMic() flips back to unmuted / track.enabled=true', vs.muted === false && vs.localStream.getAudioTracks()[0].enabled === true,
  `muted=${vs.muted} track.enabled=${vs.localStream.getAudioTracks()[0].enabled}`);

await vs.disconnect();

const vsPtt = new VoiceSession({
  fsm: fakeFsm, xstate: fakeXstate, relayPool: fakePool, auth: fakeAuth,
  mediaDevices: fakeMediaDevices,
  pttMode: true
});
await vsPtt.connect('general', { displayName: 'Tester2' });
check('pttMode=true (default PTT): starts MUTED', vsPtt.muted === true, `vsPtt.muted=${vsPtt.muted}`);
check('pttMode=true: local audio track.enabled=false at join', vsPtt.localStream.getAudioTracks()[0].enabled === false,
  `track.enabled=${vsPtt.localStream.getAudioTracks()[0].enabled}`);

vsPtt.setPttMode(false);
check('setPttMode(false) live-updates vs.pttMode', vsPtt.pttMode === false, `vsPtt.pttMode=${vsPtt.pttMode}`);

await vsPtt.disconnect();

const vsQ = new VoiceSession({
  fsm: fakeFsm, xstate: fakeXstate, relayPool: fakePool, auth: fakeAuth,
  mediaDevices: fakeMediaDevices, createPeerConnection: (cfg) => new FakePeerConnection(cfg),
  pttMode: false, audioQuality: 'high'
});
await vsQ.connect('general', { displayName: 'Q' });

const fakePc = new FakePeerConnection({});
fakePc.addTransceiver(vsQ.localStream.getAudioTracks()[0], { direction: 'sendrecv' });
vsQ.peers.set('peerA', { pc: fakePc });

vsQ._applyAudioHints(fakePc);
check('applyAudioHints(high=48000): setParameters called', !!lastSetParametersCall, JSON.stringify(lastSetParametersCall));
check('applyAudioHints(high): maxBitrate=48000 reached real setParameters()',
  lastSetParametersCall?.encodings?.[0]?.maxBitrate === 48000, JSON.stringify(lastSetParametersCall));

vsQ.setAudioQuality('max');
check('setAudioQuality(max) updates _targetBitrate to 64000', vsQ._targetBitrate === 64000, `_targetBitrate=${vsQ._targetBitrate}`);
check('setAudioQuality(max) RE-APPLIED live to connected peer via setParameters (maxBitrate=64000)',
  lastSetParametersCall?.encodings?.[0]?.maxBitrate === 64000, JSON.stringify(lastSetParametersCall));

vsQ.setAudioQuality('low');
check('setAudioQuality(low) RE-APPLIED live (maxBitrate=16000)',
  lastSetParametersCall?.encodings?.[0]?.maxBitrate === 16000, JSON.stringify(lastSetParametersCall));

vsQ.setAudioQuality('nonexistent-tier');
check('setAudioQuality(invalid tier) falls back to DEFAULT_AUDIO_QUALITY (high=48000), does not crash',
  vsQ.audioQuality === 'high' && lastSetParametersCall?.encodings?.[0]?.maxBitrate === 48000,
  `audioQuality=${vsQ.audioQuality} bitrate=${lastSetParametersCall?.encodings?.[0]?.maxBitrate}`);

vsQ.dtx = true;
const sdpWithDtxOn = vsQ._mungeDtx('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n');
check('DTX=true: usedtx=1 ADDED to real fmtp line', sdpWithDtxOn.includes('usedtx=1'), sdpWithDtxOn);

vsQ.setDtx(false);
check('setDtx(false) updates vs.dtx', vsQ.dtx === false, `vsQ.dtx=${vsQ.dtx}`);
const sdpWithDtxOff = vsQ._mungeDtx(sdpWithDtxOn);
check('DTX=false: usedtx=1 REMOVED from real fmtp line on next munge', !sdpWithDtxOff.includes('usedtx=1'), sdpWithDtxOff);

vsQ.setDtx(true);
const offerDesc = await fakePc.createOffer();
offerDesc.sdp = vsQ._mungeDtx(offerDesc.sdp);
await fakePc.setLocalDescription(offerDesc);
check('DTX reaches real setLocalDescription() call site with usedtx=1 present',
  lastLocalDescSdp.includes('usedtx=1'), lastLocalDescSdp);

await vsQ.disconnect();

const vsVad = new VoiceSession({
  fsm: fakeFsm, xstate: fakeXstate, relayPool: fakePool, auth: fakeAuth,
  mediaDevices: fakeMediaDevices, pttMode: false, micSensitivity: 0.5
});
await vsVad.connect('general', { displayName: 'VadTester' });

vsVad._activeAnalyzers = new Map();
let simulatedAmplitude = 0;
const fakeAnalyserNode = {
  getByteTimeDomainData(buf) {

    for (let i = 0; i < buf.length; i++) {
      const v = (i % 2 === 0 ? simulatedAmplitude : -simulatedAmplitude);
      buf[i] = Math.round(128 + v * 128);
    }
  }
};
vsVad._activeAnalyzers.set('local', { an: fakeAnalyserNode, lastActive: 0, speaking: false });
vsVad.participants.set('local', { identity: 'VadTester', isSpeaking: false, isMuted: false, isLocal: true, hasVideo: false, connectionQuality: 'good' });

simulatedAmplitude = 0.1;
vsVad._pollActivity();
check('VAD: amplitude 0.1 BELOW micSensitivity=0.5 -> isSpeaking stays false',
  vsVad.participants.get('local').isSpeaking === false, `isSpeaking=${vsVad.participants.get('local').isSpeaking}`);

simulatedAmplitude = 0.9;
vsVad._pollActivity();
check('VAD: amplitude 0.9 ABOVE micSensitivity=0.5 -> real _pollActivity flips isSpeaking=true',
  vsVad.participants.get('local').isSpeaking === true, `isSpeaking=${vsVad.participants.get('local').isSpeaking}`);

vsVad.setMicSensitivity(0.95);
check('setMicSensitivity(0.95) updates the live threshold', vsVad.micSensitivity === 0.95, `micSensitivity=${vsVad.micSensitivity}`);

vsVad._activeAnalyzers.get('local').lastActive = 0;
simulatedAmplitude = 0.9;
vsVad._pollActivity();
check('setMicSensitivity raised threshold: same 0.9 amplitude now reads NOT speaking (0.9<0.95), proving the real live threshold is used',
  vsVad.participants.get('local').isSpeaking === false, `isSpeaking=${vsVad.participants.get('local').isSpeaking}`);

await vsVad.disconnect();

const vsSfu = new VoiceSession({
  fsm: fakeFsm, xstate: fakeXstate, relayPool: fakePool, auth: fakeAuth,
  mediaDevices: fakeMediaDevices, pttMode: false
});
await vsSfu.connect('general', { displayName: 'SfuTester' });

const loud = 'b'.repeat(64);
const quiet = 'c'.repeat(64);
vsSfu.sfu.capacityMatrix = new Map([
  [loud, { _self: 5000 }],
  [quiet, { _self: 50 }]
]);
vsSfu.sfu.rttMatrix = new Map([
  [vsSfu.auth.pubkey, {}],
]);
const ranked = vsSfu._sfuRankCandidates();
const rankedLoud = ranked.find(r => r.pubkey === loud);
const rankedQuiet = ranked.find(r => r.pubkey === quiet);
check('SFU ranking: high-uplink candidate scores strictly higher than low-uplink candidate',
  rankedLoud.score > rankedQuiet.score, `loud.score=${rankedLoud.score} quiet.score=${rankedQuiet.score}`);
check('SFU ranking: high-uplink candidate is the TOP candidate (would become hub -> gets full fan-out bandwidth)',
  ranked[0].pubkey === loud, `ranked[0].pubkey===loud? ${ranked[0].pubkey === loud} top=${ranked[0].pubkey.slice(0,8)}`);

let replaceTrackCalls = [];
class FakeSenderRT extends FakeSender {
  async replaceTrack(track) { replaceTrackCalls.push(track); this.track = track; }
}
class FakePcForFanout extends FakePeerConnection {
  addTransceiver(trackOrKind, opts) {
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    const t = new FakeTransceiver(kind, opts?.direction || 'sendrecv');
    t.sender = new FakeSenderRT(t.sender.track);
    this._transceivers.push(t);
    return t;
  }
}
const hubPcSrc = new FakePcForFanout({});
hubPcSrc.addTransceiver('audio', { direction: 'recvonly' });
const srcTrack = new FakeTrack('audio');
hubPcSrc._transceivers[0].receiver.track = srcTrack;

const hubPcDst = new FakePcForFanout({});
hubPcDst.addTransceiver('audio', { direction: 'sendrecv' });

vsSfu.peers.set('srcPeer', { pc: hubPcSrc });
vsSfu.peers.set('dstPeer', { pc: hubPcDst });
vsSfu._sfuBecomeHub();
check('_sfuBecomeHub: real replaceTrack() called to fan out one peer\'s audio to the other (SFU zero-copy forward)',
  replaceTrackCalls.length === 1 && replaceTrackCalls[0] === srcTrack,
  `replaceTrackCalls.length=${replaceTrackCalls.length}`);

await vsSfu.disconnect();

const failed = results.filter(r => !r.pass);
console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failedDetail: failed,
  allResults: results
}, null, 2));

if (failed.length) process.exitCode = 1;
