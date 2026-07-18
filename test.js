import assert from 'node:assert';
import WebSocket from 'ws';
import * as NostrTools from 'nostr-tools';
import { RelayPool, NostrAuth, createDataSession, createFSM, DM } from './src/index.js';
import { getIceServers, setIceServers } from './src/data.js';
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

// createPeerConnection lets a Node host inject a natively-tuned peer (e.g.
// node-datachannel with ICE/UDP muxing, a fixed port range, or a proxy)
// without wireweave depending on any Node WebRTC binding. Verifies: (1) the
// default path still constructs a real, working session with no factory
// supplied; (2) a custom factory is actually invoked, receives the hardened
// ICE config (iceCandidatePoolSize, iceTransportPolicy, the full ICE server
// list), and its returned object is what the session operates on.
async function testDataSessionCreatePeerConnection() {
  const xstate = await import('xstate').catch(() => null);
  if (!xstate) { console.log('  data: createPeerConnection skip (xstate not installed)'); return; }
  const fsm = createFSM(xstate);
  const auth = new NostrAuth({ nostrTools: NostrTools });
  auth.generateKey();
  const pool = new RelayPool({ relays: [], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket });

  let factoryCalls = 0;
  let capturedConfig = null;
  const mockPc = {
    onicecandidate: null, onicegatheringstatechange: null, onconnectionstatechange: null, ondatachannel: null,
    createDataChannel: () => ({ binaryType: '', onopen: null, onclose: null, onmessage: null, onerror: null }),
    createOffer: async () => ({}),
    setLocalDescription: async () => {},
    close: () => {}
  };
  const createPeerConnection = (config) => { factoryCalls++; capturedConfig = config; return mockPc; };

  const session = createDataSession({ fsm, xstate, relayPool: pool, auth, namespace: 'wwtest', createPeerConnection });
  session._maybeConnect('b'.repeat(64));

  assert.strictEqual(factoryCalls, 1);
  assert.strictEqual(capturedConfig.iceCandidatePoolSize, 4);
  assert.strictEqual(capturedConfig.iceTransportPolicy, 'all');
  assert.ok(Array.isArray(capturedConfig.iceServers) && capturedConfig.iceServers.length > 0);
  assert.strictEqual(session.peers.get('b'.repeat(64)).pc, mockPc);
  console.log('  data: createPeerConnection factory pass');
}

function testIceServerOverrides() {
  const originalIceServers = getIceServers();
  assert.ok(originalIceServers.length > 0);
  assert.ok(originalIceServers.some((s) => /stun/.test(s.urls)));

  const custom = [{ urls: 'stun:example.test:3478' }];
  setIceServers(custom);
  assert.deepStrictEqual(getIceServers(), custom);

  // getIceServers returns a copy, not the live array — mutating it must not
  // affect subsequent reads.
  const copy = getIceServers();
  copy.push({ urls: 'stun:should-not-persist:3478' });
  assert.deepStrictEqual(getIceServers(), custom);

  setIceServers(originalIceServers); // restore for any later test in this run
  console.log('  data: setIceServers/getIceServers override pass');
}

async function testDM() {
  const a = new NostrAuth({ nostrTools: NostrTools }); a.generateKey();
  const b = new NostrAuth({ nostrTools: NostrTools }); b.generateKey();
  const published = [];
  const pool = { publish: (e) => { published.push(e); return true; }, subscribe: () => 'x', unsubscribe: () => {} };
  const dmA = new DM({ relayPool: pool, auth: a, nostrTools: NostrTools });
  const dmB = new DM({ relayPool: pool, auth: b, nostrTools: NostrTools });
  const wrap = await dmA.send(b.pubkey, 'magicwand-dm');
  // wire event is a NIP-17 gift-wrap (kind 1059), not the bare kind:14 rumor
  assert.strictEqual(wrap.kind, 1059);
  assert.strictEqual(dmB.decrypt(wrap), 'magicwand-dm');
  // sender self-copy is also published, separately wrapped for A's own key
  assert.strictEqual(published.length, 2);
  assert.strictEqual(published[1].kind, 1059);
  assert.strictEqual(dmA.decrypt(published[1]), 'magicwand-dm');

  // NIP-17 privacy property: the outer gift-wrap leaks neither sender nor
  // recipient identity to a relay-level observer. The wrap's pubkey is a
  // fresh single-use random key (not A's real pubkey), and the wrap event
  // itself carries no plaintext content nor the real sender pubkey anywhere
  // in its cleartext fields — only the addressed 'p' tag (the recipient) is
  // visible, same as bare nip44 already left visible, but the SENDER is now
  // hidden (nip44-only kind:14 signed the real event with A's real pubkey).
  assert.notStrictEqual(wrap.pubkey, a.pubkey, 'gift-wrap outer pubkey is not the real sender');
  assert.notStrictEqual(wrap.pubkey, b.pubkey, 'gift-wrap outer pubkey is not the recipient either');
  assert.ok(!JSON.stringify(wrap).includes('magicwand-dm'), 'plaintext never appears in the wrap, even serialized');
  const onlyPTag = wrap.tags.every(t => t[0] === 'p');
  assert.ok(onlyPTag && wrap.tags.length === 1, 'wrap carries only the recipient p tag, nothing else');
  assert.strictEqual(wrap.tags[0][1], b.pubkey);

  // unwrap() exposes the real rumor-level sender identity (only to the holder
  // of the recipient privkey) alongside the plaintext.
  const rumor = dmB.unwrap(wrap);
  assert.strictEqual(rumor.pubkey, a.pubkey, 'unwrapped rumor reveals the real sender to the addressed recipient');
  assert.strictEqual(rumor.kind, 14);
  console.log('  dm: nip17 gift-wrap round-trip + sender-privacy pass');
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

async function testChat() {
  const auth = newAuth();
  const pool = mockPool();
  const serverId = newAuth().pubkey + ':srv1';
  const channelId = 'general';
  const chat = createChat({ relayPool: pool, auth, getChannelContext: () => ({ channelId, serverId }), isAdmin: () => false });
  await chat.send('hello');
  assert.strictEqual(pool.published.length, 1, 'send published');
  assert.strictEqual(pool.published[0].kind, 42);
  assert.strictEqual(chat.messages.length, 1);
  const sentId = chat.messages[0].id;
  // unknown id is no-op (no publish)
  await chat.deleteMessage('nonexistent');
  assert.strictEqual(pool.published.length, 1, 'no-op on unknown id');
  // author can delete own message
  await chat.deleteMessage(sentId);
  assert.strictEqual(pool.published.length, 2, 'author delete published kind:5');
  assert.ok(pool.published[1].kind === 5);
  // non-author non-admin throws
  const other = newAuth();
  const otherChat = createChat({ relayPool: pool, auth: other, getChannelContext: () => ({ channelId, serverId }), isAdmin: () => false });
  otherChat.messages = [{ id: 'x', userId: auth.pubkey, content: 'y', timestamp: 0, tags: [] }];
  await assert.rejects(() => otherChat.deleteMessage('x'), /not author or admin/);
  // admin can delete
  const adminChat = createChat({ relayPool: pool, auth: other, getChannelContext: () => ({ channelId, serverId }), isAdmin: () => true });
  adminChat.messages = [{ id: 'z', userId: auth.pubkey, content: 'y', timestamp: 0, tags: [] }];
  await adminChat.deleteMessage('z');
  assert.ok(pool.published.some(e => e.kind === 5 && e.tags?.[0]?.[1] === 'z'));
  console.log('  chat: pass');
}

async function testChannelsMutations() {
  const owner = newAuth();
  const serverId = owner.pubkey + ':srv1';
  const pool = mockPool();
  const ch = createChannels({ relayPool: pool, auth: owner });
  ch.load(serverId); ch.pool.eose('channels-' + serverId);
  const before = ch.channels.length;
  await ch.create('testing', 'text', 'general');
  assert.strictEqual(ch.channels.length, before + 1);
  const newCh = ch.channels.find(c => c.name === 'testing');
  assert.ok(newCh, 'channel created');
  await ch.rename(newCh.id, 'renamed');
  assert.strictEqual(ch.channels.find(c => c.id === newCh.id).name, 'renamed');
  await ch.update(newCh.id, { topic: 'test topic' });
  assert.strictEqual(ch.channels.find(c => c.id === newCh.id).topic, 'test topic');
  await ch.remove(newCh.id);
  assert.ok(!ch.channels.find(c => c.id === newCh.id), 'channel removed');
  // non-owner throws
  const other = createChannels({ relayPool: pool, auth: newAuth() });
  other.serverId = serverId; other.channels = ch.channels.slice();
  await assert.rejects(() => other.create('x'), /owner only/);
  console.log('  channels mutations: pass');
}

function testBansFull() {
  const owner = newAuth();
  const serverA = owner.pubkey + ':srvA';
  const serverB = owner.pubkey + ':srvB';
  const pool = mockPool();
  const bans = createBans({ relayPool: pool, auth: owner });
  bans.subscribe(serverA);
  bans.subscribe(serverA); // idempotent — should not double-subscribe
  assert.strictEqual(pool.subs.size, 1, 'idempotent subscribe');
  bans.subscribe(serverB);
  assert.strictEqual(pool.subs.size, 2, 'two servers tracked');
  // kick event on serverA
  const kicked = newAuth().pubkey;
  pool.feed('bans-' + serverA, { pubkey: owner.pubkey, tags: [['d', dtag('kick', serverA, kicked)], ['server', serverA]], content: '' });
  assert.ok(bans.isKicked(serverA, kicked), 'kicked on serverA');
  assert.ok(!bans.isKicked(serverB, kicked), 'no bleed to serverB');
  // unsubscribe removes sub
  bans.unsubscribe(serverA);
  assert.strictEqual(pool.subs.size, 1, 'serverA sub removed');
  console.log('  bans full: pass');
}

function testRolesRelay() {
  const owner = newAuth();
  const serverId = owner.pubkey + ':srv1';
  const member = newAuth();
  const pool = mockPool();
  const roles = createRoles({ relayPool: pool, auth: owner });
  roles.subscribe(serverId);
  roles.subscribe(serverId); // idempotent
  assert.strictEqual(pool.subs.size, 1, 'idempotent subscribe');
  let fired = false;
  roles.addEventListener('updated', () => { fired = true; });
  // feed a kind:30078 roles event granting member admin
  pool.feed('roles-' + serverId, {
    pubkey: owner.pubkey,
    tags: [['d', dtag('roles', serverId)]],
    content: JSON.stringify({ admins: [member.pubkey], mods: [] })
  });
  assert.ok(fired, 'updated event fired');
  const memberRoles = createRoles({ relayPool: pool, auth: member });
  memberRoles.store.set(serverId, roles.store.get(serverId));
  assert.strictEqual(memberRoles.getRole(serverId, member.pubkey), 'admin');
  assert.ok(memberRoles.isAdmin(serverId));
  roles.unsubscribe(serverId);
  assert.strictEqual(pool.subs.size, 0, 'unsubscribed');
  console.log('  roles relay: pass');
}

async function testSettingsFull() {
  const owner = newAuth();
  const serverId = owner.pubkey + ':srv1';
  const pool = mockPool();
  const roles = createRoles({ relayPool: pool, auth: owner });
  const settings = createSettings({ relayPool: pool, auth: owner, roles });
  settings.subscribe(serverId);
  settings.subscribe(serverId); // idempotent
  assert.strictEqual(pool.subs.size, 1, 'idempotent subscribe');
  // setBitrate clamps and publishes
  const clamped = await settings.setBitrate(serverId, 30000);
  assert.strictEqual(clamped, 24000, 'clamped to nearest valid bitrate');
  assert.ok(pool.published.length > 0, 'publish fired');
  assert.strictEqual(settings.getBitrate(serverId), 24000);
  // setEmbedAllowlist
  await settings.setEmbedAllowlist(serverId, 'example.com, *.test.org, *');
  assert.ok(settings.isOriginAllowed(serverId, 'https://example.com'), 'exact domain');
  assert.ok(settings.isOriginAllowed(serverId, 'https://sub.test.org'), 'wildcard domain');
  // subscribe feed updates store
  let updated = false;
  settings.addEventListener('updated', () => { updated = true; });
  pool.feed('settings-' + serverId, {
    pubkey: owner.pubkey,
    tags: [['d', dtag('settings', serverId)]],
    content: JSON.stringify({ opusBitrate: 48000 })
  });
  assert.ok(updated, 'updated event fired');
  assert.strictEqual(settings.getBitrate(serverId), 48000, 'store updated from relay');
  settings.unsubscribe(serverId);
  assert.strictEqual(pool.subs.size, 0, 'unsubscribed');
  console.log('  settings full: pass');
}

async function testServersLifecycle() {
  const auth = newAuth();
  const storage = memStore();
  const pool = mockPool();
  const servers = createServers({ relayPool: pool, auth, storage });
  // create() adds server + calls switchTo
  let switched = null;
  servers.addEventListener('switched', (e) => { switched = e.detail.serverId; });
  await servers.create('My Server', '#ff0000');
  assert.strictEqual(servers.servers.length, 1, 'server created');
  assert.strictEqual(servers.servers[0].name, 'My Server');
  assert.ok(switched, 'switchTo fired after create');
  const srvId = servers.servers[0].id;
  assert.strictEqual(storage.getItem('zn_lastServer'), srvId, 'lastServer stored');
  // rename
  await servers.rename(srvId, 'Renamed', '#00ff00');
  assert.strictEqual(servers.servers[0].name, 'Renamed');
  assert.ok(pool.published.some(e => e.kind === 34550), 'rename published kind:34550');
  // join foreign server
  const foreignId = newAuth().pubkey + ':foreign';
  await servers.join(foreignId);
  assert.strictEqual(servers.servers.length, 2, 'join added server');
  // leave removes it
  await servers.delete(foreignId);
  assert.strictEqual(servers.servers.length, 1, 'leave removed server');
  // saveOrder + sorted
  const srv2 = newAuth().pubkey + ':s2';
  servers.servers = [servers.servers[0], { id: srv2, name: 'S2', iconColor: '#fff' }];
  servers.saveOrder([srv2, srvId]);
  const ord = servers.sorted();
  assert.strictEqual(ord[0].id, srv2, 'sorted respects order');
  console.log('  servers lifecycle: pass');
}

async function testDMSubscribe() {
  const a = new NostrAuth({ nostrTools: NostrTools }); a.generateKey();
  if (!NostrTools.nip44) { console.log('  dm subscribe: skip (nip44 missing)'); return; }
  const b = new NostrAuth({ nostrTools: NostrTools });
  b.generateKey();
  const pool = mockPool();
  const dmA = new DM({ relayPool: pool, auth: a, nostrTools: NostrTools });
  const dmB = new DM({ relayPool: pool, auth: b, nostrTools: NostrTools });
  // subscribe B, feed signed event from A
  let received = null;
  const subId = dmB.subscribe((msg) => { received = msg; });
  const wrap = await dmA.send(b.pubkey, 'hello-sub');
  pool.feed(subId, wrap);
  assert.ok(received, 'onMessage fired');
  assert.strictEqual(received.plaintext, 'hello-sub');
  assert.strictEqual(received.peer, a.pubkey);
  assert.strictEqual(received.rumor.kind, 14);
  // unsubscribe then feed: no callback
  dmB.unsubscribe();
  received = null;
  pool.feed(subId, wrap);
  assert.strictEqual(received, null, 'no callback after unsubscribe');
  // bad ciphertext emits error event, not throw
  const dmB2 = new DM({ relayPool: pool, auth: b, nostrTools: NostrTools });
  let errFired = false;
  dmB2.addEventListener('error', () => { errFired = true; });
  const subId2 = dmB2.subscribe(() => {});
  pool.feed(subId2, { pubkey: NostrTools.getPublicKey(NostrTools.generateSecretKey()), kind: 1059, tags: [['p', b.pubkey]], content: 'not-valid-ciphertext', id: 'x', sig: 'y' });
  assert.ok(errFired, 'error event emitted on bad ciphertext');
  console.log('  dm subscribe: pass');
}

async function testPagesFull() {
  const owner = newAuth();
  const serverId = owner.pubkey + ':srv1';
  const pool = mockPool();
  const { createPages } = await import('./src/pages.js');
  const roles = createRoles({ relayPool: pool, auth: owner });
  const pages = createPages({ relayPool: pool, auth: owner, roles });
  // subscribe + feed event
  pages.subscribe(serverId);
  pages.subscribe(serverId); // idempotent
  assert.strictEqual(pool.subs.size, 1, 'idempotent subscribe');
  let updated = false;
  pages.addEventListener('updated', () => { updated = true; });
  pool.feed('pages-' + serverId, {
    pubkey: owner.pubkey,
    tags: [['d', dtag('page', serverId) + ':home']],
    content: JSON.stringify({ title: 'Home', html: '<b>hi</b>' })
  });
  assert.ok(updated, 'updated event fired');
  assert.strictEqual(pages.getPages(serverId).length, 1, 'page stored');
  // deletePage via relay event
  pool.feed('pages-' + serverId, {
    pubkey: owner.pubkey,
    tags: [['d', dtag('page', serverId) + ':home']],
    content: JSON.stringify({ deleted: true })
  });
  assert.strictEqual(pages.getPages(serverId).length, 0, 'page deleted via event');
  // non-admin publish throws
  const other = createPages({ relayPool: pool, auth: newAuth(), roles: createRoles({ relayPool: pool, auth: newAuth() }) });
  await assert.rejects(() => other.publish(serverId, 'slug', 'Title', '<p>x</p>'), /Admin only/);
  // unsubscribe
  pages.unsubscribe(serverId);
  assert.strictEqual(pool.subs.size, 0, 'unsubscribed');
  console.log('  pages full: pass');
}

async function testComposeFull() {
  const xstate = await import('xstate').catch(() => null);
  if (!xstate) { console.log('  compose full: skip (xstate not installed)'); return; }
  const ww = createWireweave({ nostrTools: NostrTools, xstate, storage: memStore(), relays: [], WebSocketImpl: WebSocket });
  // setCurrentChannel updates getter
  ww.setCurrentChannel('test-ch');
  assert.strictEqual(ww.currentChannelId, 'test-ch', 'currentChannelId getter');
  // ensureData exposed
  assert.strictEqual(typeof ww.ensureData, 'function', 'ensureData exposed');
  assert.ok('data' in ww, 'data getter exposed');
  ww.auth.generateKey();
  const ds = ww.ensureData({ namespace: 'test' });
  assert.strictEqual(typeof ds.connect, 'function');
  assert.strictEqual(typeof ds.disconnect, 'function');
  assert.strictEqual(ww.ensureData(), ds, 'ensureData idempotent');
  assert.strictEqual(typeof ww.ensureVoice, 'function', 'ensureVoice callable');
  console.log('  compose full: pass');
}

async function testRelayDisconnectConnecting() {
  // Exercises the ws-close-CONNECTING fix documented in AGENTS.md
  const pool = new RelayPool({ relays: RELAYS, verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket });
  pool.connect();
  // disconnect immediately before any socket reaches OPEN state
  pool.disconnect();
  // If the fix is absent, Node emits an unhandled EventEmitter error that crashes
  // the process before this assertion can run. Give it 500ms to confirm no crash.
  await new Promise(r => setTimeout(r, 500));
  assert.ok(true, 'no crash on immediate disconnect after connect');
  console.log('  relay disconnect-connecting: pass');
}

function fakeWSImpl() {
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.onopen = this.onclose = this.onerror = this.onmessage = null; FakeWS.created.push(this); }
    send() {}
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen && this.onopen(); }
    triggerClose() { this.readyState = 3; this.onclose && this.onclose(); }
  }
  FakeWS.created = [];
  return FakeWS;
}

async function testRelayReconnectCancel() {
  const WS = fakeWSImpl();
  const pool = new RelayPool({ relays: ['wss://a'], WebSocketImpl: WS });
  pool.connect();
  WS.created[0].open();
  WS.created[0].triggerClose();           // schedules a reconnect timer
  assert.strictEqual(pool._reconnectTimers.size, 1, 'reconnect timer armed after close');
  pool.disconnect();                       // must cancel it
  assert.strictEqual(pool._reconnectTimers.size, 0, 'disconnect cleared timers');
  assert.strictEqual(pool._closed, true, 'closed flag set');
  await new Promise(r => setTimeout(r, 1600));
  assert.strictEqual(WS.created.length, 1, 'no relay resurrected after disconnect');
  console.log('  relay reconnect-cancel: pass');
}

async function testRelayPendingCapTtl() {
  const WS = fakeWSImpl();
  const pool = new RelayPool({ relays: ['wss://a'], WebSocketImpl: WS });
  pool.connect();                          // socket stays CONNECTING -> publishes queue
  for (let i = 0; i < 550; i++) pool.publish({ id: 'e' + i });
  assert.strictEqual(pool.pending.length, 500, 'pending capped at 500');
  assert.strictEqual(pool.pending[0].event.id, 'e50', 'oldest entries dropped, newest kept');
  pool.pending.unshift({ event: { id: 'stale' }, ts: Date.now() - 200000 });
  pool._drainPending();                    // no open relay: re-queues fresh, drops TTL-expired
  assert.ok(!pool.pending.some(p => p.event.id === 'stale'), 'TTL-expired pending dropped on drain');
  pool.disconnect();
  console.log('  relay pending cap/TTL: pass');
}

async function testRelayPendingDedupe() {
  const WS = fakeWSImpl();
  const pool = new RelayPool({ relays: ['wss://a'], WebSocketImpl: WS });
  pool.connect();                          // CONNECTING -> publishes queue
  pool.publish({ id: 'dup' });
  pool.publish({ id: 'dup' });             // same id must not double-queue
  pool.publish({ id: 'other' });
  assert.strictEqual(pool.pending.length, 2, 'pending deduped by event.id');
  assert.strictEqual(pool._pendingIds.size, 2, 'pendingIds tracks unique ids');
  pool.disconnect();
  console.log('  relay pending dedupe: pass');
}

async function testRelayPublishAck() {
  const WS = fakeWSImpl();
  const pool = new RelayPool({ relays: ['wss://a'], WebSocketImpl: WS });
  pool.connect();
  WS.created[0].open();                     // readyState 1 -> publish sends
  const okP = pool.publishAndWait({ id: 'acc' }, { timeoutMs: 1000 });
  WS.created[0].onmessage({ data: JSON.stringify(['OK', 'acc', true, '']) });
  assert.strictEqual(await okP, true, 'publishAndWait resolves true on accepted OK');

  const rejP = pool.publishAndWait({ id: 'rej' }, { timeoutMs: 1000 });
  WS.created[0].onmessage({ data: JSON.stringify(['OK', 'rej', false, 'blocked']) });
  assert.strictEqual(await rejP, false, 'publishAndWait resolves false on relay reject');

  const toP = pool.publishAndWait({ id: 'tmo' }, { timeoutMs: 30 });
  assert.strictEqual(await toP, false, 'publishAndWait resolves false on timeout');
  assert.strictEqual(pool._acks.size, 0, 'ack records cleaned up after settle');
  pool.disconnect();
  console.log('  relay publish ack: pass');
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
  await testDataSessionCreatePeerConnection();
  testIceServerOverrides();
  await testDM();
  await testChat();
  await testChannelsMutations();
  testBansFull();
  testRolesRelay();
  await testSettingsFull();
  await testServersLifecycle();
  await testDMSubscribe();
  await testPagesFull();
  await testComposeFull();
  await testRelayDisconnectConnecting();
  await testRelayReconnectCancel();
  await testRelayPendingCapTtl();
  await testRelayPendingDedupe();
  await testRelayPublishAck();
  await testRelay();
  console.log('all pass');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
