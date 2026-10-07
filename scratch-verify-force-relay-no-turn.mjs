

import * as xstate from 'xstate';
import assert from 'node:assert';
import { createFSM } from './src/fsm.js';
import { VoiceSession, setIceServers, getIceServers } from './src/voice.js';

let passed = 0;
const check = (label, cond) => { assert.ok(cond, label); passed++; console.log('  ok:', label); };

const fsm = createFSM(xstate);
const fakePool = { subscribe() {}, unsubscribe() {}, publish() {} };
const fakeAuth = { pubkey: 'b'.repeat(64), isLoggedIn: () => true, sign: async (e) => e };
const fakeMediaDevices = { getUserMedia: async () => { throw new Error('no mic in test env'); } };

console.log('=== setForceRelay() TURN-availability warning: real VoiceSession verification ===\n');

const originalIceServers = getIceServers();
check('default ICE_SERVERS (module state as shipped) has zero TURN entries -- reproduces the exact bug condition', originalIceServers.every(s => !String(s.urls).startsWith('turn')));

function makeVs() {
  return new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices,
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
  const vs = makeVs();
  const warnings = [];
  vs.addEventListener('media-warning', e => warnings.push(e.detail.message));
  vs.setForceRelay(true);
  check('setForceRelay(true) with no TURN configured emits exactly one media-warning', warnings.length === 1);
  check('warning message names the actual problem (Force TURN + no TURN server)', /Force TURN/.test(warnings[0]) && /TURN server/.test(warnings[0]));
  check('this.forceRelay is still set to true (the setting itself is not silently overridden, only warned about)', vs.forceRelay === true);
}

{
  const vs = makeVs();
  const warnings = [];
  vs.addEventListener('media-warning', e => warnings.push(e.detail.message));
  vs.setForceRelay(false);
  check('setForceRelay(false) never warns', warnings.length === 0);
}

{
  setIceServers([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:example-turn-provider.test:3478', username: 'u', credential: 'p' },
  ]);
  const vs = makeVs();
  const warnings = [];
  vs.addEventListener('media-warning', e => warnings.push(e.detail.message));
  vs.setForceRelay(true);
  check('setForceRelay(true) with a real TURN entry present does NOT warn', warnings.length === 0);
  check('forceRelay is still correctly set to true', vs.forceRelay === true);
}

{
  setIceServers([{ urls: 'turns:example-turn-provider.test:5349?transport=tcp', username: 'u', credential: 'p' }]);
  const vs = makeVs();
  const warnings = [];
  vs.addEventListener('media-warning', e => warnings.push(e.detail.message));
  vs.setForceRelay(true);
  check('turns: (TLS TURN) URL scheme is correctly recognized as TURN-capable', warnings.length === 0);
}

{
  setIceServers([{ urls: ['stun:stun.l.google.com:19302', 'turn:example-turn-provider.test:3478'], username: 'u', credential: 'p' }]);
  const vs = makeVs();
  const warnings = [];
  vs.addEventListener('media-warning', e => warnings.push(e.detail.message));
  vs.setForceRelay(true);
  check('array-shaped urls field with a TURN entry inside it is correctly recognized', warnings.length === 0);
}

{
  setIceServers([{ urls: 'stun:stun.l.google.com:19302' }]);
  let capturedConfig = null;
  const vs = new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices,
    forceRelay: true,
    createPeerConnection: (cfg) => { capturedConfig = cfg; return {
      connectionState: 'new', iceConnectionState: 'new', iceGatheringState: 'new', signalingState: 'stable',
      addTransceiver() { return { receiver: {}, sender: {} }; }, getTransceivers() { return []; },
      getSenders() { return []; }, getReceivers() { return []; },
      createDataChannel() { return { close() {}, send() {} }; },
      onconnectionstatechange: null, onicecandidate: null, onicegatheringstatechange: null,
      ontrack: null, ondatachannel: null,
      restartIce() {}, createOffer() { return Promise.resolve({ sdp: 'v=0\r\n' }); },
      setLocalDescription() { return Promise.resolve(); },
      close() {},
    }; }
  });
  vs.roomId = 'test-room';
  vs._maybeConnect('a'.repeat(64));
  check('real _maybeConnect with constructor-bypassed forceRelay=true and no TURN configured falls back to iceTransportPolicy:all (the original silent-dead-end bug stays closed even via this bypass)', capturedConfig && capturedConfig.iceTransportPolicy === 'all');
}
{
  setIceServers([{ urls: 'turn:example-turn-provider.test:3478', username: 'u', credential: 'p' }]);
  let capturedConfig = null;
  const vs = new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices,
    forceRelay: true,
    createPeerConnection: (cfg) => { capturedConfig = cfg; return {
      connectionState: 'new', iceConnectionState: 'new', iceGatheringState: 'new', signalingState: 'stable',
      addTransceiver() { return { receiver: {}, sender: {} }; }, getTransceivers() { return []; },
      getSenders() { return []; }, getReceivers() { return []; },
      createDataChannel() { return { close() {}, send() {} }; },
      onconnectionstatechange: null, onicecandidate: null, onicegatheringstatechange: null,
      ontrack: null, ondatachannel: null,
      restartIce() {}, createOffer() { return Promise.resolve({ sdp: 'v=0\r\n' }); },
      setLocalDescription() { return Promise.resolve(); },
      close() {},
    }; }
  });
  vs.roomId = 'test-room';
  vs._maybeConnect('a'.repeat(64));
  check('real _maybeConnect with constructor-bypassed forceRelay=true and a real TURN server present correctly still uses iceTransportPolicy:relay (fix does not break the legitimate case)', capturedConfig && capturedConfig.iceTransportPolicy === 'relay');
}

setIceServers(originalIceServers);
check('restored ICE_SERVERS back to the real production STUN-only default after test', getIceServers().length === originalIceServers.length && getIceServers().every((s,i) => s.urls === originalIceServers[i].urls));

console.log(`\n${passed} checks passed.`);
process.exit(0);
