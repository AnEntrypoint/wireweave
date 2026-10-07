import assert from 'node:assert';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import * as NostrTools from 'nostr-tools';
import { RelayPool, RelayHealth, NostrAuth, createDataSession, createFSM, DM, Profile, fragment, Reassembler, MTU_DEFAULT } from './src/index.js';
import * as debug from './src/debug.js';
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
import { createEphemeralRelay } from './src/ephemeral-relay.js';
import { createReactions } from './src/reactions.js';
import { createMutes } from './src/mutes.js';
import { createForum } from './src/forum.js';
import { VoiceSession, createVoiceSession, getIceServers as getVoiceIceServers } from './src/voice.js';

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

  const nsec = auth.nsecEncode();
  assert.ok(nsec.startsWith('nsec1'), 'exported key is real bech32 nsec');
  const reimported = new NostrAuth({ nostrTools: NostrTools, storage: store });
  const { pubkey: reimportedPubkey } = reimported.importKey(nsec);
  assert.strictEqual(reimportedPubkey, pubkey, 'exported nsec re-imports to the identical identity');

  auth.logout();
  assert.ok(!auth.isLoggedIn());
  const auth2 = new NostrAuth({ nostrTools: NostrTools, storage: store });
  auth2.generateKey();
  const loaded = new NostrAuth({ nostrTools: NostrTools, storage: store });
  assert.ok(loaded.loadFromStorage());

  const extAuth = new NostrAuth({ nostrTools: NostrTools, extension: { getPublicKey: async () => 'a'.repeat(64) } });
  await extAuth.loginWithExtension();
  assert.strictEqual(extAuth.nsecEncode(), null, 'no privkey to export under extension auth');

  const mixedStorage = new Map();
  const mixedStore = { getItem: (k) => mixedStorage.get(k) || null, setItem: (k, v) => mixedStorage.set(k, v), removeItem: (k) => mixedStorage.delete(k) };
  const localAuth = new NostrAuth({ nostrTools: NostrTools, storage: mixedStore });
  localAuth.generateKey();
  assert.ok(mixedStore.getItem('zn_sk'), 'local key persisted to storage');
  const extAuth2 = new NostrAuth({ nostrTools: NostrTools, storage: mixedStore, extension: { getPublicKey: async () => 'b'.repeat(64) } });
  await extAuth2.loginWithExtension();
  assert.strictEqual(mixedStore.getItem('zn_sk'), null, 'switching to extension auth clears the stale local key from storage');
  const reloadedAfterSwitch = new NostrAuth({ nostrTools: NostrTools, storage: mixedStore });
  assert.strictEqual(reloadedAfterSwitch.loadFromStorage(), false, 'a page reload after switching to extension auth does not silently resurrect the old local identity');
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
  pool.disconnect();
  console.log('  data: shape pass');
}

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
  pool.disconnect();
  console.log('  data: createPeerConnection factory pass');
}

function testIceServerOverrides() {
  const originalIceServers = getIceServers();
  assert.ok(originalIceServers.length > 0);
  assert.ok(originalIceServers.some((s) => /stun/.test(s.urls)));

  const custom = [{ urls: 'stun:example.test:3478' }];
  setIceServers(custom);
  assert.deepStrictEqual(getIceServers(), custom);

  const copy = getIceServers();
  copy.push({ urls: 'stun:should-not-persist:3478' });
  assert.deepStrictEqual(getIceServers(), custom);

  setIceServers(originalIceServers);
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

  assert.strictEqual(wrap.kind, 1059);
  assert.strictEqual(dmB.decrypt(wrap), 'magicwand-dm');

  assert.strictEqual(published.length, 2);
  assert.strictEqual(published[1].kind, 1059);
  assert.strictEqual(dmA.decrypt(published[1]), 'magicwand-dm');

  assert.notStrictEqual(wrap.pubkey, a.pubkey, 'gift-wrap outer pubkey is not the real sender');
  assert.notStrictEqual(wrap.pubkey, b.pubkey, 'gift-wrap outer pubkey is not the recipient either');
  assert.ok(!JSON.stringify(wrap).includes('magicwand-dm'), 'plaintext never appears in the wrap, even serialized');
  const onlyPTag = wrap.tags.every(t => t[0] === 'p');
  assert.ok(onlyPTag && wrap.tags.length === 1, 'wrap carries only the recipient p tag, nothing else');
  assert.strictEqual(wrap.tags[0][1], b.pubkey);

  const rumor = dmB.unwrap(wrap);
  assert.strictEqual(rumor.pubkey, a.pubkey, 'unwrapped rumor reveals the real sender to the addressed recipient');
  assert.strictEqual(rumor.kind, 14);
  console.log('  dm: nip17 gift-wrap round-trip + sender-privacy pass');
}

function testDtag() {

  for (const ns of ['ban', 'timeout', 'kick', 'page', 'channels', 'roles', 'settings']) {
    const s = dtag(ns, 'srv:abc', 'pk123');
    const p = parseDtag(s);
    assert.ok(p, 'parse ' + ns);
    assert.strictEqual(p.ns, ns);
    assert.strictEqual(p.parts[p.parts.length - 1], 'pk123');
  }

  assert.throws(() => dtag('evil', 'x'), /unknown namespace/);

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
  assert.ok(roles.isAdmin(serverId));
  assert.strictEqual(roles.getRole(serverId, owner.pubkey), 'owner');

  const member = newAuth();
  const rolesM = createRoles({ relayPool: mockPool(), auth: member });
  assert.ok(!rolesM.isOwner(serverId));
  assert.ok(!rolesM.isAdmin(serverId));
  assert.strictEqual(rolesM.getRole(serverId, member.pubkey), 'member');
  console.log('  roles: pass');
}

function testBans() {

  const owner = newAuth();
  const serverId = owner.pubkey + ':srv1';
  const pool = mockPool();
  const bans = createBans({ relayPool: pool, auth: owner });
  bans.subscribe(serverId);
  const subId = 'bans-' + serverId;

  const banned = newAuth().pubkey;
  pool.feed(subId, { pubkey: owner.pubkey, tags: [['d', dtag('ban', serverId, banned)], ['server', serverId]], content: JSON.stringify({ action: 'ban', pubkey: banned }) });
  assert.ok(bans.isBanned(serverId, banned), 'ban ingested');

  const ton = newAuth().pubkey;
  const expiry = Math.floor(Date.now() / 1000) + 600;
  pool.feed(subId, { pubkey: owner.pubkey, tags: [['d', dtag('timeout', serverId, ton)], ['server', serverId]], content: JSON.stringify({ action: 'timeout', pubkey: ton, expiry }) });
  assert.ok(bans.isTimedOut(serverId, ton), 'timeout ingested with future expiry');

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

  assert.ok(settings.isOriginAllowed(serverId, 'https://anything.example'));
  console.log('  settings: pass');
}

function testChannels() {
  const owner = newAuth();
  const serverId = owner.pubkey + ':srv1';
  const channels = createChannels({ relayPool: mockPool(), auth: owner });
  let ready = false;
  channels.load(serverId, () => { ready = true; });

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

function testWireweaveDepsGuard() {
  assert.throws(() => createWireweave({ xstate: {}, storage: memStore() }), /wireweave: nostrTools required/, 'missing nostrTools throws');
  assert.throws(() => createWireweave({ nostrTools: NostrTools, storage: memStore() }), /wireweave: xstate required/, 'missing xstate throws');
  assert.throws(() => createWireweave({ nostrTools: NostrTools, xstate: {} }), /wireweave: storage required \(no localStorage/, 'missing storage throws the localStorage-adapter-shaped message');
  console.log('  wireweave deps guard: pass');
}

async function testCompose() {
  const xstate = await import('xstate').catch(() => null);
  if (!xstate) { console.log('  compose: skip (xstate not installed)'); return; }
  const ww = createWireweave({ nostrTools: NostrTools, xstate, storage: memStore(), relays: [], WebSocketImpl: WebSocket });

  assert.strictEqual(typeof ww.ensureDM, 'function', 'ensureDM exposed');
  assert.ok('dm' in ww, 'dm getter exposed');
  ww.auth.generateKey();
  const dm = ww.ensureDM();
  assert.strictEqual(typeof dm.send, 'function');
  assert.strictEqual(ww.ensureDM(), dm, 'ensureDM is idempotent');
  ww.pool.disconnect();
  debug.deregister('wireweave');
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

  await chat.deleteMessage('nonexistent');
  assert.strictEqual(pool.published.length, 1, 'no-op on unknown id');

  await chat.deleteMessage(sentId);
  assert.strictEqual(pool.published.length, 2, 'author delete published kind:5');
  assert.ok(pool.published[1].kind === 5);

  const other = newAuth();
  const otherChat = createChat({ relayPool: pool, auth: other, getChannelContext: () => ({ channelId, serverId }), isAdmin: () => false });
  otherChat.messages = [{ id: 'x', userId: auth.pubkey, content: 'y', timestamp: 0, tags: [] }];
  await assert.rejects(() => otherChat.deleteMessage('x'), /not author or admin/);

  const adminChat = createChat({ relayPool: pool, auth: other, getChannelContext: () => ({ channelId, serverId }), isAdmin: () => true });
  adminChat.messages = [{ id: 'z', userId: auth.pubkey, content: 'y', timestamp: 0, tags: [] }];
  await adminChat.deleteMessage('z');
  assert.ok(pool.published.some(e => e.kind === 5 && e.tags?.[0]?.[1] === 'z'));
  console.log('  chat: pass');
}

async function testChatDeletionPersistsAcrossReload() {
  const author = newAuth();
  const admin = newAuth();
  const serverId = admin.pubkey + ':srv-del';
  const channelId = 'general';
  const pool = mockPool();

  const chat = createChat({ relayPool: pool, auth: author, getChannelContext: () => ({ channelId, serverId }), isAdmin: () => false });
  await chat.loadHistory(channelId);
  const subId = 'chat-' + channelId;
  pool.feed(subId, { id: 'm1', pubkey: author.pubkey, created_at: 100, tags: [['e', 'irrelevant', '', 'root']], content: 'will be deleted' });
  pool.eose(subId);
  assert.strictEqual(chat.messages.length, 1, 'message loaded');

  await chat.deleteMessage('m1');
  assert.strictEqual(chat.messages.length, 0, 'deleted locally');
  assert.ok(pool.published.some((e) => e.kind === 5 && e.tags?.[0]?.[1] === 'm1'));

  const reloadedChat = createChat({ relayPool: pool, auth: author, getChannelContext: () => ({ channelId, serverId }), isAdmin: () => false });
  await reloadedChat.loadHistory(channelId);
  const subId2 = 'chat-' + channelId;
  const delSubId2 = 'chat-deletions-' + channelId;
  pool.feed(delSubId2, { id: 'del1', pubkey: author.pubkey, created_at: 200, tags: [['e', 'm1']], content: 'deleted' });
  pool.feed(subId2, { id: 'm1', pubkey: author.pubkey, created_at: 100, tags: [['e', 'irrelevant', '', 'root']], content: 'will be deleted' });
  pool.eose(subId2);
  assert.strictEqual(reloadedChat.messages.length, 0, 'deleted message does not reappear after reload, even when the relay replays its original kind:42 event');

  const otherChat = createChat({ relayPool: pool, auth: newAuth(), getChannelContext: () => ({ channelId, serverId }), isAdmin: () => false });
  await otherChat.loadHistory(channelId);
  const subId3 = 'chat-' + channelId;
  const delSubId3 = 'chat-deletions-' + channelId;
  pool.feed(subId3, { id: 'm2', pubkey: author.pubkey, created_at: 300, tags: [['e', 'irrelevant', '', 'root']], content: 'still here' });
  pool.eose(subId3);
  const forger = newAuth();
  pool.feed(delSubId3, { id: 'del2', pubkey: forger.pubkey, created_at: 400, tags: [['e', 'm2']], content: 'deleted' });
  assert.strictEqual(otherChat.messages.length, 1, 'a deletion claim from someone who is neither author nor admin is rejected');
  console.log('  chat deletion persists across reload: pass');
}

async function testChatAnnouncementChannelTypeGate() {
  const owner = newAuth();
  const member = newAuth();
  const serverId = owner.pubkey + ':srv-announce';
  const channelId = 'announcements';
  const pool = mockPool();

  const memberChat = createChat({
    relayPool: pool, auth: member,
    getChannelContext: () => ({ channelId, serverId, channelType: 'announcement' }),
    isAdmin: () => false,
  });
  let blocked = false;
  memberChat.addEventListener('send-blocked', (e) => { if (e.detail?.reason === 'announcement-admin-only') blocked = true; });
  await memberChat.send('regular members should not be able to post here');
  assert.strictEqual(pool.published.length, 0, 'non-admin send into an announcement-type channel is rejected even with no explicit announcement flag');
  assert.ok(blocked, 'send-blocked fires with the announcement-admin-only reason');

  const ownerChat = createChat({
    relayPool: pool, auth: owner,
    getChannelContext: () => ({ channelId, serverId, channelType: 'announcement' }),
    isAdmin: (sid) => sid === serverId,
  });
  await ownerChat.send('a real announcement');
  assert.strictEqual(pool.published.length, 1, 'admin can post in an announcement-type channel with a plain send()');
  assert.ok(pool.published[0].tags.some((t) => t[0] === 't' && t[1] === 'announcement'), 'the announcement tag is still applied from channelType alone');

  const textChat = createChat({
    relayPool: pool, auth: member,
    getChannelContext: () => ({ channelId: 'general', serverId, channelType: 'text' }),
    isAdmin: () => false,
  });
  await textChat.send('hello');
  assert.strictEqual(pool.published.length, 2, 'a plain text channel is never gated by the announcement check');
  console.log('  chat announcement channel-type gate: pass');
}

async function testChatBansAndMutesEnforcement() {
  const owner = newAuth();
  const bannedUser = newAuth();
  const mutedUser = newAuth();
  const normalUser = newAuth();
  const serverId = owner.pubkey + ':srv-enforce';
  const channelId = 'general';
  const pool = mockPool();

  const roles = createRoles({ relayPool: pool, auth: owner });
  const bans = createBans({ relayPool: pool, auth: owner, roles });
  bans.store.set(serverId, { banned: [bannedUser.pubkey], timeouts: {}, kicked: [], muted: {} });

  const bannedChat = createChat({ relayPool: pool, auth: bannedUser, getChannelContext: () => ({ channelId, serverId }), bans });
  let blockedEmitted = false;
  bannedChat.addEventListener('send-blocked', () => { blockedEmitted = true; });
  const beforePublishCount = pool.published.length;
  await bannedChat.send('should not send');
  assert.strictEqual(pool.published.length, beforePublishCount, 'banned user cannot publish a chat message');
  assert.ok(blockedEmitted, 'send-blocked event fires for a banned sender');

  const viewerMutes = createMutes({ relayPool: pool, auth: normalUser });
  viewerMutes.muted.add(mutedUser.pubkey);
  viewerMutes._loaded = true;
  const viewerChat = createChat({ relayPool: pool, auth: normalUser, getChannelContext: () => ({ channelId, serverId }), bans, mutes: viewerMutes });
  await viewerChat.loadHistory(channelId);
  const subId = 'chat-' + channelId;

  pool.feed(subId, { id: 'm1', pubkey: bannedUser.pubkey, created_at: 100, tags: [['e', 'irrelevant', '', 'root']], content: 'from banned' });
  pool.feed(subId, { id: 'm2', pubkey: mutedUser.pubkey, created_at: 101, tags: [['e', 'irrelevant', '', 'root']], content: 'from muted' });
  pool.feed(subId, { id: 'm3', pubkey: normalUser.pubkey, created_at: 102, tags: [['e', 'irrelevant', '', 'root']], content: 'from normal' });
  pool.eose(subId);
  assert.strictEqual(viewerChat.messages.length, 1, 'only the normal-user message survives filtering');
  assert.strictEqual(viewerChat.messages[0].content, 'from normal');

  const liveSubId = 'chat-live-' + channelId;
  pool.feed(liveSubId, { id: 'm4', pubkey: bannedUser.pubkey, created_at: 200, tags: [['e', 'irrelevant', '', 'root']], content: 'live from banned' });
  pool.feed(liveSubId, { id: 'm5', pubkey: normalUser.pubkey, created_at: 201, tags: [['e', 'irrelevant', '', 'root']], content: 'live from normal' });
  assert.strictEqual(viewerChat.messages.length, 2, 'live filter also excludes the banned author');
  assert.ok(viewerChat.messages.every((m) => m.content !== 'live from banned'));
  console.log('  chat bans+mutes enforcement: pass');
}

async function testChatPow() {
  const auth = newAuth();
  const pool = mockPool();
  const serverId = newAuth().pubkey + ':srv-pow';
  const channelId = 'general';

  const noPow = createChat({ relayPool: pool, auth, getChannelContext: () => ({ channelId, serverId }), getEventHash: NostrTools.getEventHash });
  await noPow.send('no pow by default');
  assert.strictEqual(noPow.messages[0].tags.some((t) => t[0] === 'nonce'), false, 'difficulty 0 never mines a nonce tag');

  const withPow = createChat({ relayPool: pool, auth, getChannelContext: () => ({ channelId, serverId }), getEventHash: NostrTools.getEventHash });
  withPow.powDifficulty = 8;
  await withPow.send('mined message');
  const minedEvent = pool.published[pool.published.length - 1];
  assert.ok(minedEvent.tags.some((t) => t[0] === 'nonce'), 'mined event carries a nonce tag');
  let leadingZeroBits = 0;
  for (const ch of minedEvent.id) {
    const n = parseInt(ch, 16);
    if (n === 0) { leadingZeroBits += 4; continue; }
    leadingZeroBits += Math.clz32(n) - 28;
    break;
  }
  assert.ok(leadingZeroBits >= 8, `mined id has >= 8 leading zero bits (got ${leadingZeroBits})`);
  assert.strictEqual(minedEvent.id, NostrTools.getEventHash(minedEvent), 'mined id is the real hash of the final signed event');
  console.log('  chat pow: pass');
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
  bans.subscribe(serverA);
  assert.strictEqual(pool.subs.size, 1, 'idempotent subscribe');
  bans.subscribe(serverB);
  assert.strictEqual(pool.subs.size, 2, 'two servers tracked');

  const kicked = newAuth().pubkey;
  pool.feed('bans-' + serverA, { pubkey: owner.pubkey, tags: [['d', dtag('kick', serverA, kicked)], ['server', serverA]], content: '' });
  assert.ok(bans.isKicked(serverA, kicked), 'kicked on serverA');
  assert.ok(!bans.isKicked(serverB, kicked), 'no bleed to serverB');

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
  roles.subscribe(serverId);
  assert.strictEqual(pool.subs.size, 1, 'idempotent subscribe');
  let fired = false;
  roles.addEventListener('updated', () => { fired = true; });

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
  settings.subscribe(serverId);
  assert.strictEqual(pool.subs.size, 1, 'idempotent subscribe');

  const clamped = await settings.setBitrate(serverId, 30000);
  assert.strictEqual(clamped, 24000, 'clamped to nearest valid bitrate');
  assert.ok(pool.published.length > 0, 'publish fired');
  assert.strictEqual(settings.getBitrate(serverId), 24000);

  await settings.setEmbedAllowlist(serverId, 'example.com, *.test.org, *');
  assert.ok(settings.isOriginAllowed(serverId, 'https://example.com'), 'exact domain');
  assert.ok(settings.isOriginAllowed(serverId, 'https://sub.test.org'), 'wildcard domain');

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

  let switched = null;
  servers.addEventListener('switched', (e) => { switched = e.detail.serverId; });
  await servers.create('My Server', '#ff0000');
  assert.strictEqual(servers.servers.length, 1, 'server created');
  assert.strictEqual(servers.servers[0].name, 'My Server');
  assert.ok(switched, 'switchTo fired after create');
  const srvId = servers.servers[0].id;
  assert.strictEqual(storage.getItem('zn_lastServer'), srvId, 'lastServer stored');

  await servers.rename(srvId, 'Renamed', '#00ff00');
  assert.strictEqual(servers.servers[0].name, 'Renamed');
  assert.ok(pool.published.some(e => e.kind === 34550), 'rename published kind:34550');

  const foreignId = newAuth().pubkey + ':foreign';
  await servers.join(foreignId);
  assert.strictEqual(servers.servers.length, 2, 'join added server');

  await servers.delete(foreignId);
  assert.strictEqual(servers.servers.length, 1, 'leave removed server');

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

  let received = null;
  const subId = dmB.subscribe((msg) => { received = msg; });
  const wrap = await dmA.send(b.pubkey, 'hello-sub');
  pool.feed(subId, wrap);
  assert.ok(received, 'onMessage fired');
  assert.strictEqual(received.plaintext, 'hello-sub');
  assert.strictEqual(received.peer, a.pubkey);
  assert.strictEqual(received.rumor.kind, 14);

  dmB.unsubscribe();
  received = null;
  pool.feed(subId, wrap);
  assert.strictEqual(received, null, 'no callback after unsubscribe');

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

  pages.subscribe(serverId);
  pages.subscribe(serverId);
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

  pool.feed('pages-' + serverId, {
    pubkey: owner.pubkey,
    tags: [['d', dtag('page', serverId) + ':home']],
    content: JSON.stringify({ deleted: true })
  });
  assert.strictEqual(pages.getPages(serverId).length, 0, 'page deleted via event');

  const other = createPages({ relayPool: pool, auth: newAuth(), roles: createRoles({ relayPool: pool, auth: newAuth() }) });
  await assert.rejects(() => other.publish(serverId, 'slug', 'Title', '<p>x</p>'), /Admin only/);

  pages.unsubscribe(serverId);
  assert.strictEqual(pool.subs.size, 0, 'unsubscribed');
  console.log('  pages full: pass');
}

async function testComposeFull() {
  const xstate = await import('xstate').catch(() => null);
  if (!xstate) { console.log('  compose full: skip (xstate not installed)'); return; }
  const ww = createWireweave({ nostrTools: NostrTools, xstate, storage: memStore(), relays: [], WebSocketImpl: WebSocket });

  ww.setCurrentChannel('test-ch');
  assert.strictEqual(ww.currentChannelId, 'test-ch', 'currentChannelId getter');

  assert.strictEqual(typeof ww.ensureData, 'function', 'ensureData exposed');
  assert.ok('data' in ww, 'data getter exposed');
  ww.auth.generateKey();
  const ds = ww.ensureData({ namespace: 'test' });
  assert.strictEqual(typeof ds.connect, 'function');
  assert.strictEqual(typeof ds.disconnect, 'function');
  assert.strictEqual(ww.ensureData(), ds, 'ensureData idempotent');
  assert.strictEqual(typeof ww.ensureVoice, 'function', 'ensureVoice callable');
  ww.pool.disconnect();
  debug.deregister('wireweave');
  console.log('  compose full: pass');
}

async function testRelayDisconnectConnecting() {

  const pool = new RelayPool({ relays: RELAYS, verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket });
  pool.connect();

  pool.disconnect();

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
  WS.created[0].triggerClose();
  assert.strictEqual(pool._reconnectTimers.size, 1, 'reconnect timer armed after close');
  pool.disconnect();
  assert.strictEqual(pool._reconnectTimers.size, 0, 'disconnect cleared timers');
  assert.strictEqual(pool._closed, true, 'closed flag set');
  await new Promise(r => setTimeout(r, 1600));
  assert.strictEqual(WS.created.length, 1, 'no relay resurrected after disconnect');
  console.log('  relay reconnect-cancel: pass');
}

async function testRelayPendingCapTtl() {
  const WS = fakeWSImpl();
  const pool = new RelayPool({ relays: ['wss://a'], WebSocketImpl: WS });
  pool.connect();
  for (let i = 0; i < 550; i++) pool.publish({ id: 'e' + i });
  assert.strictEqual(pool.pending.length, 500, 'pending capped at 500');
  assert.strictEqual(pool.pending[0].event.id, 'e50', 'oldest entries dropped, newest kept');
  pool.pending.unshift({ event: { id: 'stale' }, ts: Date.now() - 200000 });
  pool._drainPending();
  assert.ok(!pool.pending.some(p => p.event.id === 'stale'), 'TTL-expired pending dropped on drain');
  pool.disconnect();
  console.log('  relay pending cap/TTL: pass');
}

async function testRelayPendingDedupe() {
  const WS = fakeWSImpl();
  const pool = new RelayPool({ relays: ['wss://a'], WebSocketImpl: WS });
  pool.connect();
  pool.publish({ id: 'dup' });
  pool.publish({ id: 'dup' });
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
  WS.created[0].open();
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

async function testEphemeralRelay() {
  const relay = createEphemeralRelay({ WebSocketServer, verifyEvent: NostrTools.verifyEvent });
  try {
    const pool = new RelayPool({ relays: [relay.url], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket, publishBudget: false });
    const auth = new NostrAuth({ nostrTools: NostrTools });
    auth.generateKey();
    const marker = 'ephemeral-test-' + Math.random().toString(36).slice(2);
    pool.connect();
    await Promise.race([
      new Promise((res) => { const h = (e) => { if (e.detail.status === 'connected') { pool.removeEventListener('relay-status', h); res(); } }; pool.addEventListener('relay-status', h); }),
      timed(TIMEOUT, 'ephemeral connect')
    ]);
    assert.ok(pool.isConnected());
    const event = await auth.sign({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [['t', marker]], content: marker });
    const received = await new Promise((res, rej) => {
      const subId = 'test-' + Math.random().toString(36).slice(2, 10);
      const timer = setTimeout(() => { pool.unsubscribe(subId); rej(new Error('no event')); }, TIMEOUT);
      pool.subscribe(subId, [{ '#t': [marker], kinds: [1] }], (ev) => {
        if (ev.content === marker) { clearTimeout(timer); pool.unsubscribe(subId); res(ev); }
      });
      setTimeout(() => pool.publish(event), 300);
    });
    assert.strictEqual(received.content, marker);
    assert.strictEqual(received.pubkey, auth.pubkey);
    pool.disconnect();
  } finally {
    await relay.close();
  }
  console.log('  ephemeral relay: round-trip pass');
}

async function testRelayPublishBudget() {
  const relay = createEphemeralRelay({ WebSocketServer, verifyEvent: NostrTools.verifyEvent });
  try {
    const pool = new RelayPool({ relays: [relay.url], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket, publishBudget: { burstCap: 2, refillPerSec: 10 } });
    const auth = new NostrAuth({ nostrTools: NostrTools });
    auth.generateKey();
    pool.connect();
    await Promise.race([
      new Promise((res) => { const h = (e) => { if (e.detail.status === 'connected') { pool.removeEventListener('relay-status', h); res(); } }; pool.addEventListener('relay-status', h); }),
      timed(TIMEOUT, 'budget-test connect')
    ]);
    const marker = 'budget-test-' + Math.random().toString(36).slice(2);
    const results = [];
    for (let i = 0; i < 4; i++) {
      const ev = await auth.sign({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [['t', marker]], content: marker + '-' + i });
      results.push(pool.publish(ev));
    }
    assert.strictEqual(results.filter((r) => r === true).length, 2, 'exactly burstCap publishes succeed immediately');
    assert.strictEqual(results.filter((r) => r === false).length, 2, 'the rest are budget-queued, not lost');
    assert.ok(pool.pending.length > 0, 'over-budget events are queued, not dropped');

    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(pool.pending.length, 0, 'budget-queued events eventually drain once tokens refill');
    pool.disconnect();
  } finally {
    await relay.close();
  }
  console.log('  relay publish budget: pass');
}

function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function testRelayHealthScoring() {
  const relay = createEphemeralRelay({ WebSocketServer, verifyEvent: NostrTools.verifyEvent });
  try {
    const pool = new RelayPool({ relays: [relay.url], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket, publishBudget: false });
    const auth = new NostrAuth({ nostrTools: NostrTools });
    auth.generateKey();
    pool.connect();
    await Promise.race([
      new Promise((res) => { const h = (e) => { if (e.detail.status === 'connected') { pool.removeEventListener('relay-status', h); res(); } }; pool.addEventListener('relay-status', h); }),
      timed(TIMEOUT, 'health-test connect')
    ]);

    const marker = 'health-test-' + Math.random().toString(36).slice(2);
    await new Promise((res, rej) => {
      const subId = 'health-' + Math.random().toString(36).slice(2, 10);
      const timer = setTimeout(() => rej(new Error('no eose')), TIMEOUT);
      pool.subscribe(subId, [{ '#t': [marker], kinds: [1] }], null, () => { clearTimeout(timer); pool.unsubscribe(subId); res(); });
    });

    const health = pool._getHealth(relay.url);
    assert.strictEqual(health.attempts, 1, 'one real connect attempt recorded');
    assert.ok(health.connectLatencyMs !== null && health.connectLatencyMs >= 0, 'real connect latency measured: ' + health.connectLatencyMs + 'ms');
    assert.ok(health.eoseLatencyMs !== null && health.eoseLatencyMs >= 0, 'real EOSE latency measured: ' + health.eoseLatencyMs + 'ms');
    assert.ok(health.rank > 50, 'a healthy relay with fast connect+EOSE and no failures ranks above the neutral default: ' + health.rank);

    const report = pool.healthReport();
    assert.strictEqual(report.length, 1);
    assert.strictEqual(report[0].url, relay.url);
    assert.strictEqual(report[0].rank, health.rank, 'healthReport() reflects the live-computed rank');

    pool.disconnect();
  } finally {
    await relay.close();
  }
  console.log('  relay health scoring: pass (real connect+EOSE latency measured)');
}

async function testUnhealthyRelayLowerScore() {
  const relay = createEphemeralRelay({ WebSocketServer, verifyEvent: NostrTools.verifyEvent });
  const deadPort = await freeLocalPort();
  const deadUrl = 'ws://127.0.0.1:' + deadPort;
  try {
    const pool = new RelayPool({ relays: [relay.url, deadUrl], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket, publishBudget: false, autoRotate: false });
    pool.connect();

    await Promise.race([
      new Promise((res) => { const h = (e) => { if (e.detail.url === relay.url && e.detail.status === 'connected') { pool.removeEventListener('relay-status', h); res(); } }; pool.addEventListener('relay-status', h); }),
      timed(TIMEOUT, 'healthy-side connect')
    ]);
    await new Promise((res) => {
      let errorCount = 0;
      const h = (e) => { if (e.detail.url === deadUrl && (e.detail.status === 'error' || e.detail.status === 'closed')) { errorCount++; if (errorCount >= 2) { pool.removeEventListener('relay-status', h); res(); } } };
      pool.addEventListener('relay-status', h);
    });

    const healthyHealth = pool._getHealth(relay.url);
    const deadHealth = pool._getHealth(deadUrl);
    assert.ok(deadHealth.attempts >= 2, 'dead relay accumulated real repeated connect attempts: ' + deadHealth.attempts);
    assert.strictEqual(deadHealth.successes, 0, 'dead relay has zero real sustained-connection successes');
    assert.ok(deadHealth.rank < healthyHealth.rank, 'unreachable relay (' + deadHealth.rank + ') ranks strictly below the healthy relay (' + healthyHealth.rank + ')');
    assert.ok(deadHealth.rank < 50, 'a relay with only real failed attempts and zero successes scores below the neutral default: ' + deadHealth.rank);

    const report = pool.healthReport();
    assert.strictEqual(report[0].url, relay.url, 'healthReport() sorts the healthy relay first');
    assert.strictEqual(report[1].url, deadUrl, 'healthReport() sorts the unhealthy relay last');
    assert.ok(report[0].rank >= report[1].rank, 'healthReport() is sorted best-rank-first');

    pool.disconnect();
  } finally {
    await relay.close();
  }
  console.log('  unhealthy relay lower score: pass (real ECONNREFUSED-driven rank divergence)');
}

async function testAutoRotateAwayFromUnhealthy() {
  const good = createEphemeralRelay({ WebSocketServer, verifyEvent: NostrTools.verifyEvent });
  const spare = createEphemeralRelay({ WebSocketServer, verifyEvent: NostrTools.verifyEvent });
  const deadPort = await freeLocalPort();
  const deadUrl = 'ws://127.0.0.1:' + deadPort;
  try {

    const seedPool = new RelayPool({ relays: [spare.url], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket, publishBudget: false });
    seedPool.connect();
    await Promise.race([
      new Promise((res) => { const h = (e) => { if (e.detail.status === 'connected') { seedPool.removeEventListener('relay-status', h); res(); } }; seedPool.addEventListener('relay-status', h); }),
      timed(TIMEOUT, 'seed connect')
    ]);
    await new Promise((res, rej) => {
      const subId = 'seed-' + Math.random().toString(36).slice(2, 10);
      const timer = setTimeout(() => rej(new Error('no seed eose')), TIMEOUT);
      seedPool.subscribe(subId, [{ kinds: [1], limit: 0 }], null, () => { clearTimeout(timer); seedPool.unsubscribe(subId); res(); });
    });
    const seededHealth = seedPool._getHealth(spare.url).toJSON();
    seedPool.disconnect();

    const store = memStore();
    store.setItem('ww_relay_health', JSON.stringify([seededHealth]));
    const pool = new RelayPool({
      relays: [good.url, deadUrl, good.url + '#filler'],
      verifyEvent: NostrTools.verifyEvent,
      WebSocketImpl: class extends WebSocket { constructor(u) { super(u.replace(/#filler$/, '')); } },
      storage: store,
      fallbackRelays: [spare.url],
      publishBudget: false
    });
    assert.strictEqual(pool._getHealth(spare.url).rank, seededHealth.rank, 'fallback candidate loaded its real pre-seeded rank from persisted storage');

    let rotated = null;
    pool.addEventListener('relay-rotated', (e) => { rotated = e.detail; });
    pool.connect();

    await Promise.race([
      new Promise((res) => { pool.addEventListener('relay-rotated', () => res(), { once: true }); }),
      timed(TIMEOUT, 'rotation to occur')
    ]);

    assert.ok(rotated, 'a relay-rotated event actually fired');
    assert.strictEqual(rotated.out, deadUrl, 'the consistently-unhealthy relay was the one rotated out');
    assert.strictEqual(rotated.in, spare.url, 'the proven-healthier fallback candidate was rotated in');
    assert.ok(!pool.urls.includes(deadUrl), 'dead relay URL no longer in the live pool after rotation');
    assert.ok(pool.urls.includes(spare.url), 'healthier fallback relay URL now in the live pool after rotation');

    pool.disconnect();
  } finally {
    await good.close();
    await spare.close();
  }
  console.log('  auto-rotate away from unhealthy: pass (real relay-rotated event, real URL swap)');
}

async function testNoRotateToUntestedCandidate() {
  const deadPort = await freeLocalPort();
  const deadUrl = 'ws://127.0.0.1:' + deadPort;
  const untestedUrl = 'ws://127.0.0.1:1';
  const good = createEphemeralRelay({ WebSocketServer, verifyEvent: NostrTools.verifyEvent });
  try {
    const pool = new RelayPool({
      relays: [good.url, deadUrl, good.url],
      verifyEvent: NostrTools.verifyEvent,
      WebSocketImpl: WebSocket,
      fallbackRelays: [untestedUrl],
      publishBudget: false
    });
    let rotated = false;
    pool.addEventListener('relay-rotated', () => { rotated = true; });
    pool.connect();

    await new Promise((res) => {
      let deadCloses = 0;
      const h = (e) => { if (e.detail.url === deadUrl && e.detail.status === 'closed') { deadCloses++; if (deadCloses >= 2) { pool.removeEventListener('relay-status', h); res(); } } };
      pool.addEventListener('relay-status', h);
    });
    assert.strictEqual(pool._getHealth(untestedUrl).attempts, 0, 'candidate genuinely never dialed');
    assert.strictEqual(rotated, false, 'no rotation happened toward a candidate with zero real connection history');
    assert.ok(pool.urls.includes(deadUrl), 'unhealthy relay stays in the pool absent a proven-better alternative');
    pool.disconnect();
  } finally {
    await good.close();
  }
  console.log('  no rotate to untested candidate: pass');
}

async function testHealthPersistsAcrossReload() {
  const relay = createEphemeralRelay({ WebSocketServer, verifyEvent: NostrTools.verifyEvent });
  try {
    const store = memStore();
    const pool1 = new RelayPool({ relays: [relay.url], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket, storage: store, publishBudget: false });
    pool1.connect();
    await Promise.race([
      new Promise((res) => { const h = (e) => { if (e.detail.status === 'connected') { pool1.removeEventListener('relay-status', h); res(); } }; pool1.addEventListener('relay-status', h); }),
      timed(TIMEOUT, 'reload-test connect')
    ]);
    const before = pool1._getHealth(relay.url).toJSON();
    assert.ok(before.connectLatencyMs !== null, 'real latency recorded before "reload"');
    pool1.disconnect();

    const persisted = store.getItem('ww_relay_health');
    assert.ok(persisted, 'health was actually written to the storage object');
    const parsed = JSON.parse(persisted);
    assert.ok(Array.isArray(parsed) && parsed.some((e) => e.url === relay.url), 'persisted blob contains the real relay URL');

    const pool2 = new RelayPool({ relays: [relay.url], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket, storage: store, publishBudget: false });
    const reloaded = pool2._getHealth(relay.url);
    assert.strictEqual(reloaded.attempts, before.attempts, 'attempt count survived reload without a new connection');
    assert.strictEqual(reloaded.connectLatencyMs, before.connectLatencyMs, 'connect latency survived reload byte-for-byte');
    assert.strictEqual(reloaded.rank, before.rank, 'rank survived reload byte-for-byte');
    assert.ok(reloaded instanceof RelayHealth, 'reloaded record is a real RelayHealth instance (RelayHealth.fromJSON), not a plain object');
    pool2.disconnect();
  } finally {
    await relay.close();
  }
  console.log('  relay health persists across reload: pass (real storage round-trip)');
}

async function testDebugPanelExposesHealth() {
  const relay = createEphemeralRelay({ WebSocketServer, verifyEvent: NostrTools.verifyEvent });
  try {

    const poolA = new RelayPool({ relays: [relay.url], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket, publishBudget: false });
    assert.strictEqual(debug.get(poolA._debugKey), poolA, 'pool instance registers under its own reported debug key');

    const poolB = new RelayPool({ relays: [relay.url], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket, publishBudget: false });
    assert.notStrictEqual(poolB._debugKey, poolA._debugKey, 'second concurrent instance gets a DISTINCT debug key from the first');
    assert.strictEqual(debug.get(poolB._debugKey), poolB, 'second concurrent instance registers under its own distinct debug key');

    poolA.connect();
    await Promise.race([
      new Promise((res) => { const h = (e) => { if (e.detail.status === 'connected') { poolA.removeEventListener('relay-status', h); res(); } }; poolA.addEventListener('relay-status', h); }),
      timed(TIMEOUT, 'debug-panel-test connect')
    ]);
    const report = debug.get(poolA._debugKey).healthReport();
    assert.ok(Array.isArray(report) && report.length === 1 && report[0].url === relay.url, 'debug.get(key).healthReport() returns the real live-measured report, the exact call a panel makes');

    const keyA = poolA._debugKey, keyB = poolB._debugKey;
    poolA.disconnect();
    assert.strictEqual(debug.get(keyA), undefined, 'disconnect() deregisters the debug key');
    poolB.disconnect();
    assert.strictEqual(debug.get(keyB), undefined, 'second instance deregisters its own key independently');
  } finally {
    await relay.close();
  }
  console.log('  debug panel exposes health: pass (real debug.js registry round-trip)');
}

function testFrameFragmentation() {
  const payload = new Uint8Array(120000).map((_, i) => i % 256);
  const frames = fragment(payload, { messageId: 1, mtu: MTU_DEFAULT });
  assert.ok(frames.length > 1, 'large payload produces multiple fragments');
  const shuffled = [...frames].sort(() => Math.random() - 0.5);
  const reassembler = new Reassembler();
  let out = null;
  for (const f of shuffled) { const r = reassembler.feed(f); if (r) out = r; }
  assert.ok(out, 'reassembles once all fragments arrive in any order');
  assert.strictEqual(Buffer.from(out).equals(Buffer.from(payload)), true, 'reassembled bytes match original exactly');
  console.log('  frame fragmentation: pass');
}

async function testProfile() {
  const auth = newAuth();
  const pool = mockPool();
  const profile = new Profile({ relayPool: pool, auth });
  await profile.publish({ name: 'alice', about: 'testing' });
  assert.strictEqual(pool.published.length, 1);
  assert.strictEqual(pool.published[0].kind, 0);
  const first = JSON.parse(pool.published[0].content);
  assert.strictEqual(first.name, 'alice');

  await profile.publish({ picture: 'https://example/x.png' });
  const merged = JSON.parse(pool.published[1].content);
  assert.strictEqual(merged.name, 'alice', 'partial update preserves prior fields');
  assert.strictEqual(merged.picture, 'https://example/x.png');

  const otherPubkey = 'c'.repeat(64);
  const fetchPromise = profile.fetchOnce(otherPubkey, { timeoutMs: 2000 });
  const subId = [...pool.subs.keys()].find((k) => k.startsWith('profile-once-'));
  pool.feed(subId, { pubkey: otherPubkey, created_at: 1, content: JSON.stringify({ name: 'old' }) });
  pool.feed(subId, { pubkey: otherPubkey, created_at: 2, content: JSON.stringify({ name: 'newest' }) });
  pool.eose(subId);
  const fetched = await fetchPromise;
  assert.strictEqual(fetched.name, 'newest', 'fetchOnce resolves the highest created_at seen before EOSE');

  const malformedNip05 = await profile.verifyNip05('not valid!!', 'x');
  assert.strictEqual(malformedNip05, false, 'malformed NIP-05 identifier returns false, never throws');
  console.log('  profile: pass');
}

function testBansModerationDepth() {
  const owner = newAuth();
  const serverId = owner.pubkey + ':srv-mod';
  const pool = mockPool();
  const roles = { isAdmin: () => true, isMod: () => true };
  const bans = createBans({ relayPool: pool, auth: owner, roles });
  bans.subscribe(serverId);
  const subId = 'bans-' + serverId;
  const target = newAuth().pubkey;

  const banD = dtag('ban', serverId, target);
  pool.feed(subId, { pubkey: owner.pubkey, created_at: 100, tags: [['d', banD], ['server', serverId]], content: JSON.stringify({ action: 'ban', pubkey: target }) });
  assert.ok(bans.isBanned(serverId, target), 'ban applied');

  const unbanD = dtag('unban', serverId, target);
  pool.feed(subId, { pubkey: owner.pubkey, created_at: 200, tags: [['d', unbanD], ['server', serverId]], content: JSON.stringify({ action: 'unban', pubkey: target }) });
  assert.ok(!bans.isBanned(serverId, target), 'unban reverses ban');

  pool.feed(subId, { pubkey: owner.pubkey, created_at: 150, tags: [['d', banD], ['server', serverId]], content: JSON.stringify({ action: 'ban', pubkey: target }) });
  assert.ok(!bans.isBanned(serverId, target), 'stale out-of-order ban replay does not resurrect a newer unban');

  const muteD = dtag('mute', serverId, 'chan1', target);
  pool.feed(subId, { pubkey: owner.pubkey, created_at: 300, tags: [['d', muteD], ['server', serverId], ['channel', 'chan1']], content: JSON.stringify({ action: 'mute', pubkey: target, channelId: 'chan1' }) });
  assert.ok(bans.isMuted(serverId, 'chan1', target), 'channel mute applied');
  pool.feed(subId, { pubkey: owner.pubkey, created_at: 400, tags: [['d', muteD], ['server', serverId], ['channel', 'chan1']], content: JSON.stringify({ action: 'unmute', pubkey: target, channelId: 'chan1' }) });
  assert.ok(!bans.isMuted(serverId, 'chan1', target), 'channel unmute reverses mute');

  const log = bans.getAuditLog(serverId);
  assert.strictEqual(log.length, 5, 'every moderation action is recorded in the audit log');
  assert.strictEqual(log[0].action, 'unmute', 'audit log is most-recent-first');
  console.log('  bans moderation depth: pass');
}

async function testBansCannotTargetOwnerOrAdmin() {
  const owner = newAuth();
  const admin1 = newAuth();
  const admin2 = newAuth();
  const member = newAuth();
  const serverId = owner.pubkey + ':srv-authz';
  const pool = mockPool();
  const roles = createRoles({ relayPool: pool, auth: admin1 });
  roles.store.set(serverId, { admins: [admin1.pubkey, admin2.pubkey], mods: [] });

  const bansAsAdmin1 = createBans({ relayPool: pool, auth: admin1, roles });

  await assert.rejects(bansAsAdmin1.ban(serverId, owner.pubkey), /owner/i, 'admin cannot ban the owner');
  await assert.rejects(bansAsAdmin1.timeout(serverId, admin2.pubkey, 10), /admin/i, 'admin cannot timeout another admin');
  await assert.rejects(bansAsAdmin1.mute(serverId, 'chan1', admin2.pubkey), /admin/i, 'admin cannot mute another admin');

  await bansAsAdmin1.ban(serverId, member.pubkey);
  assert.strictEqual(pool.published.length, 1, 'banning a regular member is allowed and publishes');

  const ownerRoles = createRoles({ relayPool: pool, auth: owner });
  ownerRoles.store.set(serverId, { admins: [admin1.pubkey, admin2.pubkey], mods: [] });
  const bansAsOwner = createBans({ relayPool: pool, auth: owner, roles: ownerRoles });
  await bansAsOwner.ban(serverId, admin1.pubkey);
  assert.strictEqual(pool.published.length, 2, 'owner banning an admin is allowed and publishes');
  console.log('  bans cannot target owner/admin: pass');
}

async function testMutes() {
  const user = newAuth();
  const target1 = newAuth().pubkey;
  const target2 = newAuth().pubkey;
  const pool = mockPool();
  const mutes = createMutes({ relayPool: pool, auth: user });

  await mutes.mute(target1);
  assert.ok(mutes.isMuted(target1));
  assert.strictEqual(pool.published.length, 1);
  assert.strictEqual(pool.published[0].kind, 10000);
  assert.deepStrictEqual(pool.published[0].tags, [['p', target1]]);

  await mutes.mute(target2);
  assert.deepStrictEqual(new Set(pool.published[1].tags.map((t) => t[1])), new Set([target1, target2]));

  await mutes.unmute(target1);
  assert.ok(!mutes.isMuted(target1));
  assert.ok(mutes.isMuted(target2));
  assert.deepStrictEqual(pool.published[2].tags, [['p', target2]]);

  const beforeCount = pool.published.length;
  await mutes.mute(target2);
  await mutes.unmute(target1);
  assert.strictEqual(pool.published.length, beforeCount, 'idempotent mute/unmute does not republish');

  const fresh = createMutes({ relayPool: pool, auth: user });
  fresh.load();
  const subId = 'mutes-' + user.pubkey;
  pool.feed(subId, { pubkey: user.pubkey, created_at: 500, tags: [['p', target2]], content: '' });
  assert.ok(fresh.isMuted(target2), 'load() restores the mute list from a relay-published event');

  const notYetAuth = newAuth();
  notYetAuth.pubkey = '';
  const deferred = createMutes({ relayPool: pool, auth: notYetAuth });
  deferred.load();
  assert.strictEqual(deferred._loaded, false, 'defers _loaded until auth actually resolves');
  notYetAuth.pubkey = user.pubkey;
  notYetAuth.dispatchEvent(new CustomEvent('login', { detail: { pubkey: user.pubkey } }));
  assert.strictEqual(deferred._loaded, true, 'load() retries automatically once login fires');
  console.log('  mutes: pass');
}

async function testForum() {
  const author = newAuth();
  const replier1 = newAuth();
  const replier2 = newAuth();
  const serverId = newAuth().pubkey + ':srv-forum';
  const channelId = 'discussions';
  const pool = mockPool();

  const forum = createForum({ relayPool: pool, auth: author });
  const signed = await forum.createPost(channelId, serverId, 'Hello forum', 'first post body');
  assert.strictEqual(signed.kind, 11);
  assert.ok(signed.tags.some((t) => t[0] === 'title' && t[1] === 'Hello forum'));
  assert.strictEqual(pool.published.length, 1);

  let list = forum.listFor(channelId);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].title, 'Hello forum');
  assert.strictEqual(list[0].replyCount, 0);

  await assert.rejects(() => forum.createPost(channelId, serverId, '  ', 'x'), /title cannot be empty/);

  const forumAsReplier1 = createForum({ relayPool: pool, auth: replier1 });
  const r1 = await forumAsReplier1.reply(signed.id, author.pubkey, 'first reply');
  assert.strictEqual(r1.kind, 1111);
  assert.deepStrictEqual(r1.tags.find((t) => t[0] === 'E'), ['E', signed.id]);
  assert.deepStrictEqual(r1.tags.find((t) => t[0] === 'K'), ['K', '11']);
  forum._applyReply(r1);

  const forumAsReplier2 = createForum({ relayPool: pool, auth: replier2 });
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await forumAsReplier2.reply(signed.id, author.pubkey, 'second reply');
  forum._applyReply(r2);

  list = forum.listFor(channelId);
  assert.strictEqual(list[0].replyCount, 2, 'replyCount reflects both replies');
  const replies = forum.repliesFor(signed.id);
  assert.strictEqual(replies.length, 2);
  assert.strictEqual(replies[0].content, 'first reply', 'replies ordered oldest-first');
  assert.strictEqual(replies[1].content, 'second reply');

  await assert.rejects(() => forumAsReplier1.reply(signed.id, author.pubkey, '   '), /Reply cannot be empty/);

  await forum.createPost(channelId, serverId, 'Second post', 'body2');
  assert.strictEqual(forum.listFor(channelId).length, 2, 'two posts in the same channel');
  await forum.createPost('other-channel', serverId, 'Elsewhere', 'body3');
  assert.strictEqual(forum.listFor(channelId).length, 2, 'posting to a different channel does not bleed in');
  assert.strictEqual(forum.listFor('other-channel').length, 1);
  console.log('  forum: pass');
}

async function testReactions() {
  const alice = newAuth();
  const bob = newAuth();
  const messageAuthor = newAuth();
  const pool = mockPool();
  const targetId = 'msg-' + Math.random().toString(36).slice(2);

  const reactionsAlice = createReactions({ relayPool: pool, auth: alice });
  const signed = await reactionsAlice.react(targetId, messageAuthor.pubkey, '👍');
  assert.strictEqual(signed.kind, 7);
  assert.deepStrictEqual(signed.tags.find((t) => t[0] === 'e'), ['e', targetId]);
  assert.deepStrictEqual(signed.tags.find((t) => t[0] === 'p'), ['p', messageAuthor.pubkey]);
  assert.strictEqual(signed.content, '👍');
  assert.strictEqual(pool.published.length, 1);

  let got = reactionsAlice.getFor(targetId);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].content, '👍');
  assert.strictEqual(got[0].count, 1);
  assert.strictEqual(got[0].mine, true, 'alice sees her own reaction as mine');

  const reactionsBob = createReactions({ relayPool: pool, auth: bob });
  const bobSigned = await reactionsBob.react(targetId, messageAuthor.pubkey, '🎉');
  reactionsAlice._applyReaction(bobSigned);
  got = reactionsAlice.getFor(targetId);
  assert.strictEqual(got.length, 2, 'two distinct emoji present');
  const bobEntry = got.find((r) => r.content === '🎉');
  assert.strictEqual(bobEntry.count, 1);
  assert.strictEqual(bobEntry.mine, false, 'bobs reaction is not alices');

  const changed = await reactionsAlice.react(targetId, messageAuthor.pubkey, '❤️');
  got = reactionsAlice.getFor(targetId);
  assert.strictEqual(got.find((r) => r.content === '👍'), undefined, 'old emoji replaced, not accumulated');
  assert.strictEqual(got.find((r) => r.content === '❤️').count, 1);

  const staleReplay = { ...signed, id: 'stale-old-id', created_at: signed.created_at - 10 };
  reactionsAlice._applyReaction(staleReplay);
  got = reactionsAlice.getFor(targetId);
  assert.strictEqual(got.find((r) => r.content === '👍'), undefined, 'stale out-of-order replay does not resurrect a superseded reaction');

  await reactionsAlice.unreact(targetId);
  const deletionEvent = pool.published[pool.published.length - 1];
  assert.strictEqual(deletionEvent.kind, 5);
  assert.deepStrictEqual(deletionEvent.tags.find((t) => t[0] === 'e'), ['e', changed.id]);
  got = reactionsAlice.getFor(targetId);
  assert.strictEqual(got.find((r) => r.mine), undefined, 'alice no longer shows as reacted after unreact');
  console.log('  reactions: pass');
}

function testVoiceSessionDepsGuard() {
  const xstate = { createMachine: () => ({}), createActor: () => ({}) };
  const fsm = { voiceMachine: {} };
  const pool = mockPool();
  const auth = newAuth();
  const md = { getUserMedia: async () => { throw new Error('no mic in test'); } };
  const base = { fsm, xstate, relayPool: pool, auth, mediaDevices: md };
  for (const missingKey of ['fsm', 'xstate', 'relayPool', 'auth', 'mediaDevices']) {
    const opts = { ...base, [missingKey]: undefined };
    assert.throws(() => new VoiceSession(opts), /VoiceSession: missing deps/, 'missing ' + missingKey + ' throws');
  }
  const session = new VoiceSession(base);
  assert.ok(session instanceof VoiceSession);
  assert.strictEqual(createVoiceSession(base) instanceof VoiceSession, true, 'createVoiceSession factory returns a real VoiceSession');
  console.log('  voice deps guard: pass');
}

function testVoiceSessionSetters() {
  const xstate = { createMachine: () => ({}), createActor: () => ({}) };
  const fsm = { voiceMachine: {} };
  const pool = mockPool();
  const auth = newAuth();
  const md = { getUserMedia: async () => { throw new Error('no mic in test'); } };
  const session = new VoiceSession({ fsm, xstate, relayPool: pool, auth, mediaDevices: md });

  assert.strictEqual(session.pttMode, true, 'pttMode defaults true');
  assert.strictEqual(session.dtx, true, 'dtx defaults true');
  assert.strictEqual(session.fec, true, 'fec defaults true');
  assert.strictEqual(session.audioQuality, 'high', 'audioQuality defaults to high tier');

  session.setPttMode(false);
  assert.strictEqual(session.pttMode, false, 'setPttMode(false) applies');

  session.setDtx(false);
  assert.strictEqual(session.dtx, false, 'setDtx(false) applies');

  session.setFec(false);
  assert.strictEqual(session.fec, false, 'setFec(false) applies');

  const before = session.micSensitivity;
  session.setMicSensitivity(-1);
  assert.strictEqual(session.micSensitivity, before, 'setMicSensitivity ignores a non-positive value');
  session.setMicSensitivity('nope');
  assert.strictEqual(session.micSensitivity, before, 'setMicSensitivity ignores a non-numeric value');
  session.setMicSensitivity(0.09);
  assert.strictEqual(session.micSensitivity, 0.09, 'setMicSensitivity applies a valid value');

  session.setAudioQuality('ultra-max-unknown-tier');
  assert.strictEqual(session.audioQuality, 'high', 'unknown quality tier falls back to default');
  session.setAudioQuality('low');
  assert.strictEqual(session.audioQuality, 'low', 'known quality tier applies');

  assert.strictEqual(session.muted, false, 'muted defaults false pre-connect');
  session.setMuted(true);
  assert.strictEqual(session.muted, true, 'setMuted(true) applies with no localStream');
  session.toggleMic();
  assert.strictEqual(session.muted, false, 'toggleMic flips muted with no localStream');

  console.log('  voice setters: pass');
}

function testVoiceIceServers() {
  const original = getVoiceIceServers();
  assert.ok(original.length > 0, 'voice.js ships a real default ICE server list');
  assert.ok(original.some((s) => /^stun:/.test(s.urls)), 'default list includes at least one STUN server');

  console.log('  voice ice servers: pass');
}

async function testMessageBusOffline() {
  const store = memStore();
  const bus1 = createMessageBus({ storage: store, roomKey: 'test-room' });
  bus1.add('persisted message');
  await new Promise((r) => setTimeout(r, 700));
  const bus2 = createMessageBus({ storage: store, roomKey: 'test-room' });
  assert.strictEqual(bus2.messages.length, 1, 'message persisted across fresh instance');
  assert.strictEqual(bus2.messages[0].text, 'persisted message');

  let online = false;
  const sent = [];
  const bus3 = createMessageBus({ storage: memStore(), roomKey: 'room3', sendFn: (m) => { sent.push(m.text); return true; }, isOnline: () => online });
  bus3.add('queued offline');
  assert.strictEqual(sent.length, 0, 'offline add() does not call sendFn');
  assert.strictEqual(bus3.getOutbox().length, 1, 'offline message queued in outbox');
  online = true;
  const flushResult = bus3.flushOutbox();
  assert.strictEqual(flushResult.sent, 1);
  assert.strictEqual(bus3.getOutbox().length, 0, 'outbox drained after flush');
  assert.strictEqual(sent.length, 1, 'sendFn actually called during flush');
  console.log('  message bus offline: pass');
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
  testWireweaveDepsGuard();
  await testCompose();
  await testDataSession();
  await testDataSessionCreatePeerConnection();
  testIceServerOverrides();
  await testDM();
  await testChat();
  await testChatDeletionPersistsAcrossReload();
  await testChatAnnouncementChannelTypeGate();
  await testChatBansAndMutesEnforcement();
  await testChatPow();
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
  await testEphemeralRelay();
  await testRelayPublishBudget();
  await testRelayHealthScoring();
  await testUnhealthyRelayLowerScore();
  await testAutoRotateAwayFromUnhealthy();
  await testNoRotateToUntestedCandidate();
  await testHealthPersistsAcrossReload();
  await testDebugPanelExposesHealth();
  testFrameFragmentation();
  await testProfile();
  testBansModerationDepth();
  await testBansCannotTargetOwnerOrAdmin();
  await testMutes();
  await testForum();
  await testReactions();
  await testMessageBusOffline();
  testVoiceSessionDepsGuard();
  testVoiceSessionSetters();
  testVoiceIceServers();
  console.log('all pass');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
