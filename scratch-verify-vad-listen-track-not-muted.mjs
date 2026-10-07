

import * as xstate from 'xstate';
import assert from 'node:assert';
import { createFSM } from './src/fsm.js';
import { VoiceSession } from './src/voice.js';

let passed = 0;
const check = (label, cond) => { assert.ok(cond, label); passed++; console.log('  ok:', label); };

global.AudioContext = class {
  constructor() { this.state = 'running'; this._lastAnalyser = null; }
  createAnalyser() { const a = { fftSize: 512, smoothingTimeConstant: 0.4, _sourceTrack: null, connect() {}, disconnect() {}, getByteTimeDomainData(buf) { const enabled = a._sourceTrack ? a._sourceTrack.enabled : true; const amp = enabled ? 90 : 0; for (let i = 0; i < buf.length; i++) buf[i] = 128 + (i % 2 === 0 ? amp : -amp); } }; this._lastAnalyser = a; return a; }
  createMediaStreamSource(stream) { const track = stream.getAudioTracks()[0]; this._lastAnalyser && (this._lastAnalyser._sourceTrack = track); return { connect() {}, disconnect() {}, _track: track }; }
  createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
  createMediaStreamDestination() { return { stream: new global.MediaStream([]) }; }
};

class FakeMediaStreamTrack {
  constructor(kind, enabled) { this.kind = kind || 'audio'; this.enabled = enabled !== undefined ? enabled : true; }
  clone() { return new FakeMediaStreamTrack(this.kind, this.enabled); }
  stop() {}
}
global.MediaStream = class {
  constructor(tracks) { this._tracks = tracks || [new FakeMediaStreamTrack('audio')]; }
  getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
  getTracks() { return this._tracks; }
};

const fsm = createFSM(xstate);
const fakePool = { subscribe() {}, unsubscribe() {}, publish() {} };
const fakeAuth = { pubkey: 'b'.repeat(64), isLoggedIn: () => true, sign: async (e) => e };
const fakeMediaDevices = { getUserMedia: async () => new global.MediaStream([new FakeMediaStreamTrack('audio', true)]) };

console.log('=== _localListenTrack born-muted fix: real VoiceSession verification ===\n');

function makeVs(pttMode) {
  return new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices, pttMode,
    createPeerConnection: () => ({
      addTransceiver() { return { receiver: {}, sender: {} }; }, getTransceivers() { return []; },
      getSenders() { return []; }, getReceivers() { return []; },
      createDataChannel() { return { close() {}, send() {} }; },
      onconnectionstatechange: null, onicecandidate: null, onicegatheringstatechange: null,
      ontrack: null, ondatachannel: null, connectionState: 'new', signalingState: 'stable', close() {},
    })
  });
}

{
  const vs = makeVs(true);
  await vs.connect('vad-listen-test', { displayName: 'x' });
  check('connect() in PTT mode leaves the session muted (original bug precondition)', vs.muted === true);
  check('original mic track is disabled while muted (expected, unrelated to the bug)', vs.localStream.getAudioTracks()[0].enabled === false);
  check('_localListenTrack is genuinely ENABLED despite the session being muted and the original track being disabled -- the actual fix', vs._localListenTrack.enabled === true);

  const an = vs._activeAnalyzers.get('local').an;
  const buf = new Uint8Array(4);
  an.getByteTimeDomainData(buf);
  const nonSilent = buf.some(b => b !== 128);
  check('AnalyserNode reading the listen track produces non-silent samples while the session is muted (the real end-to-end fix, not just a flag check)', nonSilent);

  await vs.disconnect().catch(() => {});
}

{
  const vs = makeVs(false);
  await vs.connect('vad-listen-test-2', { displayName: 'x' });
  check('open-mic mode starts unmuted', vs.muted === false);
  check('_localListenTrack enabled at connect in open-mic mode too', vs._localListenTrack.enabled === true);

  vs.setMuted(true);
  check('after setMuted(true): original track disabled', vs.localStream.getAudioTracks()[0].enabled === false);
  check('after setMuted(true): _localListenTrack STAYS enabled (defensive re-assert in setMuted)', vs._localListenTrack.enabled === true);

  vs.setMuted(false);
  check('after setMuted(false): original track re-enabled', vs.localStream.getAudioTracks()[0].enabled === true);
  check('after setMuted(false): _localListenTrack still enabled', vs._localListenTrack.enabled === true);

  vs.setMuted(true);
  check('repeated mute cycling never disables the listen track (3rd toggle)', vs._localListenTrack.enabled === true);

  await vs.disconnect().catch(() => {});
}

console.log(`\n${passed} checks passed.`);
process.exit(0);
