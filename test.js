import assert from 'node:assert';
import WebSocket from 'ws';
import * as NostrTools from 'nostr-tools';
import { RelayPool, NostrAuth, createDataSession, createFSM } from './src/index.js';

const RELAY = 'wss://relay.damus.io';
const TIMEOUT = 15000;

const timed = (ms, label) => new Promise((_, rej) =>
  setTimeout(() => rej(new Error('timeout: ' + label)), ms));

async function testAuth() {
  const storage = new Map();
  const store = { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  const auth = new NostrAuth({ nostrTools: NostrTools, storage: store });
  const { pubkey, privkey } = auth.generateKey();
  assert.strictEqual(typeof pubkey, 'string');
  assert.strictEqual(pubkey.length, 64);
  assert.strictEqual(privkey.length, 32);
  assert.ok(auth.isLoggedIn());
  const signed = await auth.sign({ kind: 1, created_at: Math.floor(Date.now()/1000), tags: [], content: 'magicwand test' });
  assert.ok(signed.sig);
  assert.ok(NostrTools.verifyEvent(signed));
  auth.logout();
  assert.ok(!auth.isLoggedIn());
  const auth2 = new NostrAuth({ nostrTools: NostrTools, storage: store });
  auth2.generateKey();
  const loaded = new NostrAuth({ nostrTools: NostrTools, storage: store });
  assert.ok(loaded.loadFromStorage());
  console.log('  auth: pass');
}

async function testRelay() {
  const pool = new RelayPool({ relays: [RELAY], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket });
  const auth = new NostrAuth({ nostrTools: NostrTools });
  auth.generateKey();
  const marker = 'magicwand-test-' + Math.random().toString(36).slice(2);
  pool.connect();
  await Promise.race([
    new Promise(r => pool.addEventListener('relay-status', e => { if (e.detail.status === 'connected') r(); }, { once: true })),
    timed(TIMEOUT, 'connect')
  ]);
  assert.ok(pool.isConnected());
  const event = await auth.sign({ kind: 1, created_at: Math.floor(Date.now()/1000), tags: [['t', marker]], content: marker });
  const received = new Promise((res, rej) => {
    const subId = 'test-' + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => { pool.unsubscribe(subId); rej(new Error('no event')); }, TIMEOUT);
    pool.subscribe(subId, [{ '#t': [marker], kinds: [1] }], (ev) => {
      if (ev.content === marker) { clearTimeout(timer); pool.unsubscribe(subId); res(ev); }
    });
    setTimeout(() => pool.publish(event), 500);
  });
  const got = await received;
  assert.strictEqual(got.content, marker);
  assert.strictEqual(got.pubkey, auth.pubkey);
  pool.disconnect();
  console.log('  relay: round-trip pass');
}

async function testDataSession() {
  const xstate = await import('xstate').catch(() => null);
  if (!xstate) { console.log('  data: skip (xstate not installed)'); return; }
  const fsm = createFSM(xstate);
  const auth = new NostrAuth({ nostrTools: NostrTools });
  auth.generateKey();
  const pool = new RelayPool({ relays: [], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket });
  const session = createDataSession({ fsm, xstate, relayPool: pool, auth, namespace: 'wwtest' });
  assert.ok(session);
  assert.strictEqual(typeof session.connect, 'function');
  assert.strictEqual(typeof session.disconnect, 'function');
  assert.strictEqual(typeof session.send, 'function');
  assert.strictEqual(typeof session.broadcast, 'function');
  assert.strictEqual(typeof session.debug, 'function');
  assert.strictEqual(session.peers.size, 0);
  assert.strictEqual(session.broadcast(new Uint8Array([1, 2, 3])), 0);
  assert.strictEqual(session.send('deadbeef', new Uint8Array([1])), false);
  const dbg = session.debug();
  assert.ok(Array.isArray(dbg.peers));
  assert.strictEqual(dbg.peers.length, 0);
  console.log('  data: shape pass');
}

async function main() {
  console.log('magicwand test.js');
  await testAuth();
  await testDataSession();
  await testRelay();
  console.log('all pass');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
