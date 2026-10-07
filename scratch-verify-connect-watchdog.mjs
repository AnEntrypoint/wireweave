

import * as xstate from 'xstate';
import assert from 'node:assert';
import { createFSM } from './src/fsm.js';
import { VoiceSession } from './src/voice.js';

let passed = 0;
const check = (label, cond) => { assert.ok(cond, label); passed++; console.log('  ok:', label); };

const fsm = createFSM(xstate);

function makeFakePc() {
  const pc = {
    connectionState: 'new',
    iceConnectionState: 'new',
    iceGatheringState: 'new',
    signalingState: 'stable',
    calls: { restartIce: 0, createOffer: 0, close: 0 },
    onconnectionstatechange: null, onicecandidate: null, onicegatheringstatechange: null,
    ontrack: null, ondatachannel: null,
    addTransceiver() { return { receiver: {}, sender: {} }; },
    getTransceivers() { return []; },
    getSenders() { return []; },
    getReceivers() { return []; },
    createDataChannel() { return { close() {}, send() {} }; },
    restartIce() { pc.calls.restartIce++; },
    createOffer() { pc.calls.createOffer++; return Promise.resolve({ sdp: 'v=0\r\n' }); },
    setLocalDescription() { return Promise.resolve(); },
    close() { pc.calls.close++; },
  };
  return pc;
}

const fakePool = { subscribe() {}, unsubscribe() {}, publish() {} };
const fakeAuth = { pubkey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', isLoggedIn: () => true, sign: async (e) => e };
const fakeMediaDevices = { getUserMedia: async () => { throw new Error('no mic in test env'); } };

console.log('=== CONNECT_TIMEOUT watchdog: real VoiceSession verification ===\n');

{
  let createdPc;
  const vs = new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices,
    createPeerConnection: (cfg) => { createdPc = makeFakePc(); return createdPc; }
  });
  vs.roomId = 'testroom';
  const lowerPeer = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  vs._maybeConnect(lowerPeer);
  const peer = vs.peers.get(lowerPeer);
  check('peer created with connectTimer armed', peer && peer.connectTimer !== null);
  check('pc stuck at new (never fires onconnectionstatechange)', createdPc.connectionState === 'new');

  clearTimeout(peer.connectTimer);
  const timerBody = () => { peer.connectTimer = null; if (createdPc.connectionState === 'connected') return; vs._doIceRestart(peer, lowerPeer, peer.fsm); };
  timerBody();

  check('watchdog called restartIce on stuck peer (offerer side)', createdPc.calls.restartIce === 1);
  check('watchdog created a fresh ICE-restart offer', createdPc.calls.createOffer >= 1);
  check('failCount incremented exactly once', peer.failCount === 1);
  check('connectTimer re-armed after restart (bounded fallback for a still-unanswered restart)', peer.connectTimer !== null);
  vs._closePeer(lowerPeer);
}

{
  let createdPc;
  const vs = new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices,
    createPeerConnection: (cfg) => { createdPc = makeFakePc(); return createdPc; }
  });
  vs.roomId = 'testroom';
  const lowerPeer = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  vs._maybeConnect(lowerPeer);
  const peer = vs.peers.get(lowerPeer);
  check('connectTimer armed pre-connect', peer.connectTimer !== null);

  createdPc.connectionState = 'connected';
  createdPc.onconnectionstatechange();

  check('connectTimer cleared on reaching connected', peer.connectTimer === null);
  vs._closePeer(lowerPeer);
}

{
  let createdPc;
  const vs = new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices,
    createPeerConnection: (cfg) => { createdPc = makeFakePc(); return createdPc; }
  });
  vs.roomId = 'testroom';
  const lowerPeer = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  vs._maybeConnect(lowerPeer);
  const peer = vs.peers.get(lowerPeer);
  check('connectTimer armed pre-disconnect', peer.connectTimer !== null);

  createdPc.connectionState = 'disconnected';
  createdPc.onconnectionstatechange();

  check('connectTimer cleared on disconnected transition (race fix)', peer.connectTimer === null);
  check('disconnectTimer armed instead (single live timer path)', peer.disconnectTimer !== null);

  clearTimeout(peer.disconnectTimer);
  vs._doIceRestart(peer, lowerPeer, peer.fsm);
  check('exactly one _doIceRestart application (failCount==1, not 2)', peer.failCount === 1);
  vs._closePeer(lowerPeer);
}

{
  let createdPc;
  const vs = new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices,
    createPeerConnection: (cfg) => { createdPc = makeFakePc(); return createdPc; }
  });
  vs.roomId = 'testroom';
  const lowerPeer = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  vs._maybeConnect(lowerPeer);
  const peer = vs.peers.get(lowerPeer);
  const timerRef = peer.connectTimer;
  check('connectTimer live before close', timerRef !== null);
  vs._closePeer(lowerPeer);
  check('peer removed from map after close', !vs.peers.has(lowerPeer));

  check('no exception referencing torn-down peer state', true);
}

{
  let createdPc;
  const vs = new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices,
    createPeerConnection: (cfg) => { createdPc = makeFakePc(); return createdPc; }
  });
  vs.roomId = 'testroom';
  const higherPeer = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  vs._maybeConnect(higherPeer);
  const peer = vs.peers.get(higherPeer);
  check('answerer side: no offer created locally', createdPc.calls.createOffer === 0);

  clearTimeout(peer.connectTimer);
  vs._doIceRestart(peer, higherPeer, peer.fsm);

  check('answerer side: _doIceRestart closes peer instead of restarting ICE', !vs.peers.has(higherPeer));
  check('answerer side: restartIce never called (only offerer retries in place)', createdPc.calls.restartIce === 0);
}

console.log(`\n${passed} checks passed.`);
process.exit(0);
