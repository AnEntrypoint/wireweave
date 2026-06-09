import assert from 'node:assert';
import WebSocket from 'ws';
import * as NostrTools from 'nostr-tools';
import { RelayPool, NostrAuth, createDataSession, createFSM, DM } from './src/index.js';
import { dtag, parseDtag } from './src/dtag.js';
import { createMessageBus } from './src/message.js';
import { createRoles } from './src/roles.js';
import { createBans } from './src/bans.js';
import { createSettings } from './src/settings.js';
import { createChannels } from './src/channels.js';
import { createServers } from './src/servers.js';
import { createChat } from './src/chat.js';
import { createMedia } from './src/media.js';
import { createWireweave } from './src/wireweave.js';

// A mock relay pool: captures published events and lets a test push events back
// into a named subscription's onEvent. No network — these are deterministic
// state/authority tests, the multi-relay path is covered by testRelay below.
function mockPool() {
  const subs = new Map();
  return {
    published: [],
    publish(e) { this.published.push(e); return true; },
    subscribe(id, filters, onEvent, onEose) { subs.set(id, { filters, onEvent, onEose }); return id; },
    unsubscribe(id) { subs.delete(id); },
    feed(id, event) { subs.get(id)?.onEvent?.(event); },
    eose(id) { subs.get(id)?.onEose?.(); },
    subs
  };
}
const memStore = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
const newAuth = () => { const a = new NostrAuth({ nostrTools: NostrTools }); a.generateKey(); return a; };

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'];
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
  const pool = new RelayPool({ relays: RELAYS, verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket });
  const auth = new NostrAuth({ nostrTools: NostrTools });
  auth.generateKey();
  const marker = 'magicwand-test-' + Math.random().toString(36).slice(2);
  pool.connect();
  await Promise.race([
    new Promise(r => {
      const handler = (e) => { if (e.detail.status === 'connected') { pool.removeEventListener('relay-status', handler); r(); } };
      pool.addEventListener('relay-status', handler);
    }),
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

async function testDM() {
  const a = new NostrAuth({ nostrTools: NostrTools }); a.generateKey();
  const b = new NostrAuth({ nostrTools: NostrTools }); b.generateKey();
  const pool = { publish: () => true, subscribe: () => 'x', unsubscribe: () => {} };
  const dmA = new DM({ relayPool: pool, auth: a, nostrTools: NostrTools });
  const dmB = new DM({ relayPool: pool, auth: b, nostrTools: NostrTools });
  const signed = await dmA.send(b.pubkey, 'magicwand-dm');
  assert.strictEqual(signed.kind, 14);
  assert.strictEqual(dmB.decrypt(signed), 'magicwand-dm');
  assert.strictEqual(dmA.decrypt(signed), 'magicwand-dm');
  console.log('  dm: nip44 round-trip pass');
}

function testDtag() {
  // round-trip: every namespace survives dtag -> parseDtag
  for (const ns of ['ban', 'timeout', 'kick', 'page', 'channels', 'roles', 'settings']) {
    const s = dtag(ns, 'srv:abc', 'pk123');
    const p = parseDtag(s);
    assert.ok(p, 'parse ' + ns);
    assert.strictEqual(p.ns, ns);
    assert.strictEqual(p.parts[p.parts.length - 1], 'pk123');
  }
  // unknown namespace throws (adversarial — make invalid namespaces unrepresentable)
  assert.throws(() => dtag('evil', 'x'), /unknown namespace/);
  // parse rejects foreign / malformed prefixes (no PREFIX/slice drift)
  assert.strictEqual(parseDtag('not-zellous:ban:x'), null);
  assert.strictEqual(parseDtag('zellous-evil:x'), null);
  assert.strictEqual(parseDtag(123), null);
  console.log('  dtag: pass');
}

function testMessageBus() {
  const bus = createMessageBus({ maxMessages: 3 });
  let last = null;
  bus.addEventListener('message', (e) => { last = e.detail; });
  for (let i = 0; i < 5; i++) bus.add('m' + i);
  assert.strictEqual(bus.messages.length, 3, 'trimmed to max');
  assert.strictEqual(bus.messages[0].text, 'm2');
  assert.strictEqual(last.text, 'm4');
  let handled = null;
  bus.register('ping', (m) => { handled = m; });
  bus.handle({ type: 'ping', v: 1 });
  assert.strictEqual(handled.v, 1);
  console.log('  message: pass');
}

function testRoles() {
  const owner = newAuth();
  const serverId = owner.pubkey + ':srv1';
  const roles = createRoles({ relayPool: mockPool(), auth: owner });
  assert.ok(roles.isOwner(serverId));
  assert.ok(roles.isAdmin(serverId));   // owner is admin
  assert.strictEqual(roles.getRole(serverId, owner.pubkey), 'owner');
  // a non-owner cannot be owner/admin until granted
  const member = newAuth();
  const rolesM = createRoles({ relayPool: mockPool(), auth: member });
  assert.ok(!rolesM.isOwner(serverId));
  assert.ok(!rolesM.isAdmin(serverId));
  assert.strictEqual(rolesM.getRole(serverId, member.pubkey), 'member');
  console.log('  roles: pass');
}

function testBans() {
  // exercise the timeout ingestion path that the shadowed-var fix touched
  const owner = newAuth();
  const serverId = owner.pubkey + ':srv1';
  const pool = mockPool();
  const bans = createBans({ relayPool: pool, auth: owner });
  bans.subscribe(serverId);
  const subId = 'bans-' + serverId;
  // ban event from creator
  const banned = newAuth().pubkey;
  pool.feed(subId, { pubkey: owner.pubkey, tags: [['d', dtag('ban', serverId, banned)], ['server', serverId]], content: JSON.stringify({ action: 'ban', pubkey: banned }) });
  assert.ok(bans.isBanned(serverId, banned), 'ban ingested');
  // timeout event (the fixed branch): future expiry => timed out
  const ton = newAuth().pubkey;
  const expiry = Math.floor(Date.now() / 1000) + 600;
  pool.feed(subId, { pubkey: owner.pubkey, tags: [['d', dtag('timeout', serverId, ton)], ['server', serverId]], content: JSON.stringify({ action: 'timeout', pubkey: ton, expiry }) });
  assert.ok(bans.isTimedOut(serverId, ton), 'timeout ingested with future expiry');
  // forged authority: event NOT from creator is ignored
  const attacker = newAuth();
  const victim = newAuth().pubkey;
  pool.feed(subId, { pubkey: attacker.pubkey, tags: [['d', dtag('ban', serverId, victim)], ['server', serverId]], content: JSON.stringify({ action: 'ban', pubkey: victim }) });
  assert.ok(!bans.isBanned(serverId, victim), 'forged ban rejected');
  console.log('  bans: pass');
}

function testSettings() {
  const owner = newAuth();
  const serverId = owner.pubkey + ':srv1';
  const settings = createSettings({ relayPool: mockPool(), auth: owner, roles: createRoles({ relayPool: mockPool(), auth: owner }) });
  assert.strictEqual(settings.getBitrate(serverId), 24000, 'default bitrate');
  // empty allowlist => allow-all (documented honest default)
  assert.ok(settings.isOriginAllowed(serverId, 'https://anything.example'));
  console.log('  settings: pass');
}

function testChannels() {
  const owner = newAuth();
  const serverId = owner.pubkey + ':srv1';
  const channels = createChannels({ relayPool: mockPool(), auth: owner });
  let ready = false;
  channels.load(serverId, () => { ready = true; });
  // no event fed; trigger EOSE -> defaults seeded
  channels.pool.eose('channels-' + serverId);
  assert.ok(ready, 'onReady fired');
  assert.ok(channels.channels.length > 0, 'default channels seeded');
  assert.ok(channels.channels.some(c => c.type === 'text'), 'has a text channel');
  console.log('  channels: pass');
}

function testServers() {
  const auth = newAuth();
  const storage = memStore();
  const servers = createServers({ relayPool: mockPool(), auth, storage });
  assert.deepStrictEqual(servers.servers, []);
  servers._persist();
  // storage-format contract: persisted under zn_servers, reloads identically
  servers.servers = [{ id: auth.pubkey + ':a', name: 'A', iconColor: '#fff' }];
  servers._persist();
  const servers2 = createServers({ relayPool: mockPool(), auth, storage });
  servers2.load();
  assert.strictEqual(servers2.servers.length, 1);
  assert.strictEqual(servers2.servers[0].name, 'A');
  console.log('  servers: pass');
}

function testMediaPure() {
  const media = createMedia({ relayPool: mockPool(), auth: newAuth() });
  assert.strictEqual(media.isMedia('http://x/a.png'), 'image');
  assert.strictEqual(media.isMedia('http://x/a.MP4?q=1'), 'video');
  assert.strictEqual(media.isMedia('http://x/a.txt'), null);
  assert.strictEqual(media.isMedia(42), null);
  const urls = media.extractUrls('see https://a.com/x and http://b.org/y!');
  assert.strictEqual(urls.length, 2);
  console.log('  media: pass');
}

async function testPagesSanitizer() {
  const owner = newAuth();
  const serverId = owner.pubkey + ':srv1';
  const { createPages } = await import('./src/pages.js');
  const pages = createPages({ relayPool: mockPool(), auth: owner, roles: createRoles({ relayPool: mockPool(), auth: owner }) });
  await pages.publish(serverId, 'home', 'Home', '<p onclick="evil()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><b>ok</b>');
  const out = pages.getPages(serverId)[0].html;
  assert.ok(!/onclick/i.test(out), 'on* attr stripped');
  assert.ok(!/<script/i.test(out), 'script tag stripped');
  assert.ok(!/javascript:/i.test(out), 'javascript: url stripped');
  assert.ok(/<b>ok<\/b>/.test(out), 'safe markup preserved');
  console.log('  pages: sanitizer pass');
}

async function testCompose() {
  const xstate = await import('xstate').catch(() => null);
  if (!xstate) { console.log('  compose: skip (xstate not installed)'); return; }
  const ww = createWireweave({ nostrTools: NostrTools, xstate, storage: memStore(), relays: [], WebSocketImpl: WebSocket });
  // DM must be reachable from the composed SDK (was previously unwired)
  assert.strictEqual(typeof ww.ensureDM, 'function', 'ensureDM exposed');
  assert.ok('dm' in ww, 'dm getter exposed');
  ww.auth.generateKey();
  const dm = ww.ensureDM();
  assert.strictEqual(typeof dm.send, 'function');
  assert.strictEqual(ww.ensureDM(), dm, 'ensureDM is idempotent');
  console.log('  compose: pass');
}

async function main() {
  console.log('magicwand test.js');
  await testAuth();
  testDtag();
  testMessageBus();
  testRoles();
  testBans();
  testSettings();
  testChannels();
  testServers();
  testMediaPure();
  await testPagesSanitizer();
  await testCompose();
  await testDataSession();
  await testDM();
  await testRelay();
  console.log('all pass');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
