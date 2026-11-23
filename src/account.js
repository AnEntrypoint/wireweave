import { dtag, replaceableTs } from './dtag.js';
import { normalizeRelayUrl } from './relay-pool.js';

const HEX64 = /^[0-9a-f]{64}$/;
const USERNAME_RE = /^[a-z0-9_.-]{2,24}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const COLOUR_RE = /^#[0-9a-f]{6}$/i;
const IMAGE_URL_RE = /^(https:\/\/[^\s"'<>()\\]{3,1900}|data:image\/(png|jpeg|webp|gif|svg\+xml);(base64|utf8),[^\s"'<>\\]{8,60000})$/i;
const RELAYS_KEY = 'zn_relays';
const SYNC_D = () => dtag('account', 'self');
const NICK_D = (serverId) => dtag('nick', serverId);
const DM_POLICIES = ['everyone', 'known', 'nobody'];
const BIRTHDAY_VIS = ['hidden', 'day', 'full'];
const BANNER_MODES = ['auto', 'colour', 'gradient', 'image'];
const STATUS_DURATIONS = [0, 1800, 3600, 14400, 86400];
const LIMITS = { name: 32, about: 190, pronouns: 40, location: 60, website: 200, linkLabel: 24, linkUrl: 200, links: 5, nick: 32, custom: 60 };

export const DEFAULT_PRIVATE = () => ({
  v: 1,
  updatedAt: 0,
  privacy: { dm: 'everyone', presence: true, activity: true, receipts: false, everyonePings: true },
  birthday: { date: '', visibility: 'hidden' },
  customStatus: { text: '', emoji: '', expiresAt: 0 },
  perServer: {},
  nip05: { id: '', ok: false, at: 0, reason: '' },
  prefs: {}
});

const CONFUSABLE = { '0': 'o', '1': 'l', 'i': 'l', '|': 'l', '5': 's', '$': 's', '3': 'e', '@': 'a', '4': 'a', '7': 't', '8': 'b', '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y', '\u0456': 'l', '\u0455': 's', '\u03bf': 'o', '\u03b1': 'a' };

export const skeleton = (text) => String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s._\-]+/g, '').split('').map((c) => CONFUSABLE[c] || c).join('').replace(/[^a-z0-9\u0400-\u04ff\u0370-\u03ff\u3040-\u30ff\u4e00-\u9fff]/g, '');

const editDistance = (a, b) => {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return row[b.length];
};

export const safeImageUrl = (u) => (typeof u === 'string' && IMAGE_URL_RE.test(u.trim()) ? u.trim() : '');

const fail = (message) => { throw new Error(message); };
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

export class Account extends EventTarget {
  constructor({ relayPool, auth, presence, mutes, chat = null, nostrTools, storage = null, fetchImpl = null, prefsIO = null } = {}) {
    super();
    if (!relayPool || !auth || !nostrTools) throw new Error('Account: relayPool + auth + nostrTools required');
    this.pool = relayPool; this.auth = auth; this.presence = presence; this.mutes = mutes; this.chat = chat;
    this.NT = nostrTools; this.storage = storage;
    this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.prefsIO = prefsIO;
    this.pub = {}; this.pubAt = 0;
    this.priv = DEFAULT_PRIVATE(); this.privAt = 0;
    this.relayListAt = 0;
    this.nicks = new Map();
    this.nickSubs = new Map();
    this._loadedFor = '';
    this._pushTimer = null;
    this._tick = null;
    this._applyStoredRelays();
    this.auth.addEventListener('login', () => this.load());
    this.auth.addEventListener('logout', () => this._reset());
  }

  _emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _reset() {
    this._loadedFor = '';
    this.pub = {}; this.pubAt = 0; this.priv = DEFAULT_PRIVATE(); this.privAt = 0; this.relayListAt = 0;
    if (this._pushTimer) { clearTimeout(this._pushTimer); this._pushTimer = null; }
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    this._emit('updated');
  }

  _applyStoredRelays() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(RELAYS_KEY);
      const list = raw ? JSON.parse(raw) : null;
      if (Array.isArray(list) && list.length) this.pool.setRelays(list);
    } catch {}
  }

  _storeRelays() {
    if (!this.storage) return;
    try { this.storage.setItem(RELAYS_KEY, JSON.stringify(this.pool.relayList())); } catch {}
  }

  load() {
    const pk = this.auth.pubkey;
    if (!pk || this._loadedFor === pk) return;
    this._loadedFor = pk;
    const subId = 'profile-account-' + pk.slice(0, 12);
    this.pool.subscribe(subId, [
      { kinds: [0, 10002], authors: [pk] },
      { kinds: [30078], authors: [pk], '#d': [SYNC_D()] }
    ], (event) => this._ingest(event).catch(() => {}));
    if (!this._tick) this._tick = setInterval(() => this._expireStatus().catch(() => {}), 15000);
    this.watchServerNicks();
  }

  async _ingest(event) {
    if (event.pubkey !== this.auth.pubkey) return;
    if (event.kind === 0) {
      if (event.created_at < this.pubAt) return;
      let data; try { data = JSON.parse(event.content); } catch { return; }
      if (!data || typeof data !== 'object') return;
      this.pubAt = event.created_at; this.pub = data;
      if (this.chat) this.chat.updateProfile(this.auth.pubkey, data);
      this._emit('updated');
    } else if (event.kind === 10002) {
      if (event.created_at < this.relayListAt) return;
      this.relayListAt = event.created_at;
      const urls = (event.tags || []).filter((t) => t[0] === 'r').map((t) => normalizeRelayUrl(t[1])).filter(Boolean);
      if (urls.length) { try { this.pool.setRelays(urls); this._storeRelays(); } catch {} }
      this._emit('updated');
    } else if (event.kind === 30078) {
      if (event.created_at < this.privAt) return;
      let data;
      try { data = JSON.parse(await this._decrypt(event.content)); } catch { return; }
      if (!data || typeof data !== 'object') return;
      this.privAt = event.created_at;
      this.priv = this._mergePrivate(DEFAULT_PRIVATE(), data);
      if (this.prefsIO && data.prefs) this.prefsIO.write(data.prefs);
      this._applyPresence().catch(() => {});
      this._emit('updated');
    }
  }

  async _encrypt(text) {
    if (this.auth.privkey) return this.NT.nip44.v2.encrypt(text, this.NT.nip44.v2.utils.getConversationKey(this.auth.privkey, this.auth.pubkey));
    const ext = this.auth.getExtension();
    if (ext && ext.nip44 && typeof ext.nip44.encrypt === 'function') return ext.nip44.encrypt(this.auth.pubkey, text);
    return fail('This sign-in method cannot encrypt to yourself (NIP-44), so settings cannot sync.');
  }

  async _decrypt(payload) {
    if (this.auth.privkey) return this.NT.nip44.v2.decrypt(payload, this.NT.nip44.v2.utils.getConversationKey(this.auth.privkey, this.auth.pubkey));
    const ext = this.auth.getExtension();
    if (ext && ext.nip44 && typeof ext.nip44.decrypt === 'function') return ext.nip44.decrypt(this.auth.pubkey, payload);
    return fail('This sign-in method cannot decrypt synced settings.');
  }

  _mergePrivate(base, patch) {
    const out = { ...base };
    if (patch.privacy && typeof patch.privacy === 'object') {
      const p = patch.privacy;
      const next = { ...base.privacy };
      if (p.dm !== undefined) { if (!DM_POLICIES.includes(p.dm)) fail('Choose who can message you: everyone, people you know, or nobody'); next.dm = p.dm; }
      for (const k of ['presence', 'activity', 'receipts', 'everyonePings']) if (p[k] !== undefined) next[k] = !!p[k];
      out.privacy = next;
    }
    if (patch.birthday && typeof patch.birthday === 'object') {
      const b = patch.birthday;
      const next = { ...base.birthday };
      if (b.date !== undefined) {
        const d = String(b.date || '').trim();
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) fail('Birthday must be a date');
        if (d) { const t = new Date(d + 'T00:00:00Z'); if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) fail('That date does not exist'); if (t.getTime() > Date.now()) fail('Birthday cannot be in the future'); if (t.getUTCFullYear() < 1900) fail('Birthday year must be 1900 or later'); }
        next.date = d;
      }
      if (b.visibility !== undefined) { if (!BIRTHDAY_VIS.includes(b.visibility)) fail('Birthday visibility must be hidden, day only, or full'); next.visibility = b.visibility; }
      out.birthday = next;
    }
    if (patch.customStatus && typeof patch.customStatus === 'object') {
      const c = patch.customStatus;
      out.customStatus = { text: clean(c.text, LIMITS.custom), emoji: clean(c.emoji, 8), expiresAt: Math.max(0, Math.floor(Number(c.expiresAt) || 0)) };
    }
    if (patch.perServer && typeof patch.perServer === 'object') {
      const next = {};
      for (const [sid, v] of Object.entries(patch.perServer)) {
        if (!v || typeof v !== 'object') continue;
        const nick = clean(v.nick, LIMITS.nick); const avatar = safeImageUrl(v.avatar || '');
        if (nick || avatar) next[String(sid).slice(0, 200)] = { nick, avatar };
      }
      out.perServer = next;
    }
    if (patch.nip05 && typeof patch.nip05 === 'object') out.nip05 = { id: clean(patch.nip05.id, 120), ok: !!patch.nip05.ok, at: Math.floor(Number(patch.nip05.at) || 0), reason: clean(patch.nip05.reason, 160) };
    if (patch.prefs && typeof patch.prefs === 'object') {
      const prefs = {};
      for (const [k, v] of Object.entries(patch.prefs)) if (/^[a-z0-9_.:-]{1,80}$/i.test(k) && typeof v === 'string' && v.length <= 4000) prefs[k] = v;
      out.prefs = prefs;
    }
    if (patch.updatedAt) out.updatedAt = Math.floor(Number(patch.updatedAt)) || 0;
    return out;
  }

  validatePublic(fields) {
    const out = {};
    const f = fields || {};
    if (f.name !== undefined) { const n = clean(f.name, LIMITS.name); if (!n) fail('Display name cannot be empty'); out.name = n; out.display_name = n; }
    if (f.username !== undefined) { const u = String(f.username || '').trim().toLowerCase(); if (u && !USERNAME_RE.test(u)) fail('Username must be 2 to 24 characters: letters, numbers, dot, dash, underscore'); out.username = u; }
    if (f.about !== undefined) out.about = clean(f.about, LIMITS.about).replace(/\r/g, '');
    if (f.pronouns !== undefined) out.pronouns = clean(f.pronouns, LIMITS.pronouns);
    if (f.location !== undefined) out.location = clean(f.location, LIMITS.location);
    if (f.website !== undefined) {
      const w = clean(f.website, LIMITS.website);
      if (w) { let u; try { u = new URL(w); } catch { fail('Website must be a full address like https://example.com'); } if (u.protocol !== 'https:' && u.protocol !== 'http:') fail('Website must start with https://'); }
      out.website = w;
    }
    if (f.picture !== undefined) { const p = String(f.picture || '').trim(); if (p && !safeImageUrl(p)) fail('Picture must be an https:// image address or an uploaded image'); out.picture = p; }
    if (f.accent !== undefined) { const c = String(f.accent || '').trim(); if (c && !COLOUR_RE.test(c)) fail('Account colour must look like #5865f2'); out.accent = c.toLowerCase(); }
    if (f.nip05 !== undefined) { const id = String(f.nip05 || '').trim().toLowerCase(); if (id) this._parseNip05(id); out.nip05 = id; }
    if (f.links !== undefined) {
      if (!Array.isArray(f.links)) fail('Links must be a list');
      if (f.links.length > LIMITS.links) fail('At most ' + LIMITS.links + ' links');
      out.links = f.links.map((l) => {
        const label = clean(l && l.label, LIMITS.linkLabel); const url = clean(l && l.url, LIMITS.linkUrl);
        if (!label || !url) fail('Each link needs a label and an address');
        let u; try { u = new URL(url); } catch { fail('"' + label + '" needs a full address like https://example.com'); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') fail('"' + label + '" must start with https://');
        return { label, url };
      });
    }
    if (f.banner !== undefined) {
      const b = f.banner || {};
      const mode = BANNER_MODES.includes(b.mode) ? b.mode : fail('Banner type must be automatic, colour, gradient or image');
      const nb = { mode };
      if (mode === 'colour' || mode === 'gradient') { if (!COLOUR_RE.test(b.a || '')) fail('Pick a banner colour'); nb.a = b.a.toLowerCase(); }
      if (mode === 'gradient') { if (!COLOUR_RE.test(b.b || '')) fail('Pick a second banner colour'); nb.b = b.b.toLowerCase(); nb.angle = Math.min(360, Math.max(0, Math.round(Number(b.angle) || 135))); }
      if (mode === 'image') { const u = String(b.url || '').trim(); if (!safeImageUrl(u)) fail('Banner image must be an https:// address or an uploaded image'); nb.url = u; }
      out.zbanner = nb;
      out.banner = mode === 'image' ? nb.url : '';
    }
    return out;
  }

  publicProfile() { return this.pub; }

  async setPublic(fields, { extra = {} } = {}) {
    if (!this.auth.isLoggedIn()) fail('Sign in first');
    const next = { ...this.pub, ...this.validatePublic(fields), ...extra };
    if (next.birthday !== undefined && this.priv.birthday.visibility === 'hidden') delete next.birthday;
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] === undefined || (Array.isArray(next[k]) && !next[k].length)) delete next[k];
    const signed = await this.auth.sign({ kind: 0, created_at: Math.max(Math.floor(Date.now() / 1000), this.pubAt + 1), tags: [], content: JSON.stringify(next) });
    this.pool.publish(signed);
    this.pubAt = signed.created_at; this.pub = next;
    if (this.chat) this.chat.updateProfile(this.auth.pubkey, next);
    this._emit('updated');
    return next;
  }

  _publicBirthday() {
    const b = this.priv.birthday;
    if (!b.date || b.visibility === 'hidden') return '';
    return b.visibility === 'day' ? b.date.slice(5) : b.date;
  }

  async setBirthday({ date, visibility }) {
    const prev = this.priv.birthday;
    await this.setPrivate({ birthday: { date: date === undefined ? prev.date : date, visibility: visibility === undefined ? prev.visibility : visibility } });
    const shown = this._publicBirthday();
    const next = { ...this.pub };
    if (shown) next.birthday = shown; else delete next.birthday;
    const signed = await this.auth.sign({ kind: 0, created_at: Math.max(Math.floor(Date.now() / 1000), this.pubAt + 1), tags: [], content: JSON.stringify(next) });
    this.pool.publish(signed);
    this.pubAt = signed.created_at; this.pub = next;
    if (this.chat) this.chat.updateProfile(this.auth.pubkey, next);
    this._emit('updated');
  }

  async setPrivate(patch, { immediate = true } = {}) {
    if (!this.auth.isLoggedIn()) fail('Sign in first');
    this.priv = this._mergePrivate(this.priv, patch);
    this._emit('updated');
    if (immediate) await this.pushSync(); else this._schedulePush();
    return this.priv;
  }

  _schedulePush() {
    if (this._pushTimer) clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => { this._pushTimer = null; this.pushSync().catch(() => {}); }, 1200);
  }

  async pushSync() {
    if (!this.auth.isLoggedIn()) fail('Sign in first');
    if (this.prefsIO) this.priv.prefs = this._mergePrivate(DEFAULT_PRIVATE(), { prefs: this.prefsIO.read() }).prefs;
    const ts = replaceableTs();
    this.priv.updatedAt = ts;
    const content = await this._encrypt(JSON.stringify(this.priv));
    const signed = await this.auth.sign({ kind: 30078, created_at: ts, tags: [['d', SYNC_D()]], content });
    this.privAt = signed.created_at;
    const ok = await this.pool.publishAndWait(signed);
    this._emit('updated');
    return { ok, at: signed.created_at };
  }

  async pullSync({ timeoutMs = 6000 } = {}) {
    if (!this.auth.isLoggedIn()) fail('Sign in first');
    const pk = this.auth.pubkey;
    const found = await this._collect([{ kinds: [30078], authors: [pk], '#d': [SYNC_D()], limit: 5 }], timeoutMs);
    const best = found.sort((a, b) => b.created_at - a.created_at)[0];
    if (!best) return { found: false };
    this.privAt = 0;
    await this._ingest(best);
    return { found: true, at: best.created_at };
  }

  _collect(filters, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const out = []; let done = false;
      const subId = 'account-collect-' + Math.random().toString(36).slice(2, 9);
      const finish = () => { if (done) return; done = true; clearTimeout(timer); this.pool.unsubscribe(subId); resolve(out); };
      const timer = setTimeout(finish, timeoutMs);
      this.pool.subscribe(subId, filters, (event) => { if (!out.find((e) => e.id === event.id)) out.push(event); }, finish);
    });
  }

  _parseNip05(id) {
    const m = /^(?:([a-z0-9_.+-]{1,64})@)?([a-z0-9.-]{1,253})$/i.exec(id);
    if (!m) return fail('NIP-05 looks like name@example.com');
    const name = (m[1] || '_').toLowerCase(); const domain = m[2].toLowerCase();
    if (!DOMAIN_RE.test(domain)) fail('"' + domain + '" is not a valid domain');
    return { name, domain };
  }

  async verifyNip05(id) {
    const { name, domain } = this._parseNip05(String(id || '').trim().toLowerCase());
    if (!this.fetch) fail('No network available to check NIP-05');
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
    let result;
    try {
      const res = await this.fetch('https://' + domain + '/.well-known/nostr.json?name=' + encodeURIComponent(name), { signal: ctl && ctl.signal, redirect: 'error', credentials: 'omit' });
      if (!res.ok) result = { ok: false, reason: domain + ' answered ' + res.status };
      else {
        const body = await res.json();
        const got = body && body.names && typeof body.names === 'object' ? String(body.names[name] || '').toLowerCase() : '';
        if (!got) result = { ok: false, reason: domain + ' has no entry for "' + name + '"' };
        else if (!HEX64.test(got)) result = { ok: false, reason: 'the entry is not a public key' };
        else if (got !== this.auth.pubkey) result = { ok: false, reason: 'that name points to a different key' };
        else result = { ok: true, reason: '' };
      }
    } catch (e) {
      result = { ok: false, reason: e && e.name === 'AbortError' ? domain + ' did not answer in time' : 'could not reach ' + domain + ' (it may block browsers, or the address is wrong)' };
    } finally { if (timer) clearTimeout(timer); }
    const record = { id: id.trim().toLowerCase(), ok: result.ok, at: Math.floor(Date.now() / 1000), reason: result.reason };
    await this.setPrivate({ nip05: record });
    return record;
  }

  setStatusDuration(seconds) { return STATUS_DURATIONS.includes(seconds) ? seconds : 0; }

  async setStatus({ status, text = '', emoji = '', durationSec = 0 }) {
    if (!this.presence) fail('Presence is unavailable');
    const t = clean(text, LIMITS.custom); const e = clean(emoji, 8);
    const expiresAt = durationSec > 0 && (t || e) ? Math.floor(Date.now() / 1000) + durationSec : 0;
    await this.setPrivate({ customStatus: { text: t, emoji: e, expiresAt } });
    await this._applyPresence(status);
    return { status: this.presence.statusOf(this.auth.pubkey).status, expiresAt };
  }

  async _applyPresence(status) {
    if (!this.presence || !this.auth.isLoggedIn()) return;
    const cs = this.priv.customStatus; const pr = this.priv.privacy;
    const current = status || this._wantedStatus || this.presence.statusOf(this.auth.pubkey).status;
    this._wantedStatus = current;
    const expired = cs.expiresAt && cs.expiresAt <= Math.floor(Date.now() / 1000);
    const text = pr.activity && !expired ? (cs.emoji ? cs.emoji + ' ' : '') + cs.text : '';
    const wire = pr.presence ? current : 'invisible';
    await this.presence.set(wire, text.trim(), { until: cs.expiresAt || 0 });
    this._emit('updated');
  }

  async _expireStatus() {
    const cs = this.priv.customStatus;
    if (!cs.expiresAt || cs.expiresAt > Math.floor(Date.now() / 1000) || !this.auth.isLoggedIn()) return;
    await this.setPrivate({ customStatus: { text: '', emoji: '', expiresAt: 0 } });
    await this._applyPresence();
  }

  wantedStatus() { return this._wantedStatus || (this.presence ? this.presence.statusOf(this.auth.pubkey).status : 'online'); }

  relays() {
    const live = new Map(this.pool.status().map((r) => [r.url, r]));
    return this.pool.relayList().map((url) => {
      const r = live.get(url);
      return { url, status: r ? r.status : 'connecting', latencyMs: r ? r.latencyMs : null };
    });
  }

  defaultRelays() { return this.pool.defaultRelays(); }

  async publishRelayList() {
    if (!this.auth.isLoggedIn()) return null;
    const tags = this.pool.relayList().map((u) => ['r', u]);
    const signed = await this.auth.sign({ kind: 10002, created_at: Math.max(Math.floor(Date.now() / 1000), this.relayListAt + 1), tags, content: '' });
    this.relayListAt = signed.created_at;
    return this.pool.publishAndWait(signed);
  }

  async addRelay(url) {
    const clean0 = normalizeRelayUrl(url);
    if (!clean0) fail('A relay address starts with wss://');
    if (/^ws:\/\//.test(clean0) && !/^ws:\/\/(localhost|127\.|\[::1\])/.test(clean0)) fail('Use wss:// (encrypted) for remote relays');
    if (this.pool.relayList().includes(clean0)) fail('That relay is already in your list');
    if (this.pool.relayList().length >= 30) fail('At most 30 relays');
    this.pool.addRelay(clean0);
    this._storeRelays();
    const ok = await this.publishRelayList();
    this._emit('updated');
    return { url: clean0, published: ok };
  }

  async removeRelay(url) {
    this.pool.removeRelay(url);
    this._storeRelays();
    const ok = await this.publishRelayList();
    this._emit('updated');
    return { published: ok };
  }

  async resetRelays() {
    this.pool.setRelays(this.pool.defaultRelays());
    this._storeRelays();
    const ok = await this.publishRelayList();
    this._emit('updated');
    return { published: ok };
  }

  blocked() { return this.mutes ? this.mutes.list() : []; }

  async block(input) {
    let pk = String(input || '').trim();
    if (pk.startsWith('npub')) { try { const d = this.NT.nip19.decode(pk); pk = d.type === 'npub' ? d.data : ''; } catch { pk = ''; } }
    pk = pk.toLowerCase();
    if (!HEX64.test(pk)) fail('Enter an npub1… address or a 64-character hex key');
    if (pk === this.auth.pubkey) fail('You cannot block yourself');
    await this.mutes.mute(pk);
    return pk;
  }

  async unblock(pk) { await this.mutes.unmute(pk); }

  allowsDm(peer, { knownPeers = new Set() } = {}) {
    const policy = this.priv.privacy.dm;
    if (this.mutes && this.mutes.isMuted(peer)) return false;
    if (policy === 'everyone') return true;
    if (knownPeers.has(peer)) return true;
    if (policy === 'nobody') return false;
    return !!(this.chat && this.chat.profiles.has(peer));
  }

  receiptsOn() { return !!this.priv.privacy.receipts; }

  everyonePings() { return !!this.priv.privacy.everyonePings; }

  watchServerNicks(serverId) {
    const sid = serverId || (this._lastServer || '');
    if (serverId) this._lastServer = serverId;
    if (!sid || this.nickSubs.has(sid)) return;
    const subId = 'nicks-' + sid.slice(0, 40);
    this.nickSubs.set(sid, subId);
    this.pool.subscribe(subId, [{ kinds: [30078], '#d': [NICK_D(sid)], limit: 500 }], (event) => {
      let data; try { data = JSON.parse(event.content); } catch { return; }
      if (!data || typeof data !== 'object') return;
      const key = sid + '|' + event.pubkey;
      const prev = this.nicks.get(key);
      if (prev && prev.at > event.created_at) return;
      this.nicks.set(key, { nick: clean(data.nick, LIMITS.nick), avatar: safeImageUrl(data.avatar || ''), at: event.created_at });
      this._emit('nick', { serverId: sid, pubkey: event.pubkey });
    });
  }

  accountNameOf(pubkey) {
    const p = pubkey === this.auth.pubkey ? this.pub : this.chat && this.chat.profiles.get(pubkey);
    return p && p.name ? String(p.name) : '';
  }

  checkNick(serverId, nick, memberPks = []) {
    const want = skeleton(nick);
    if (!want) return [];
    const found = [];
    const seen = new Set();
    const pks = new Set(memberPks);
    for (const key of this.nicks.keys()) if (key.startsWith(serverId + '|')) pks.add(key.slice(serverId.length + 1));
    for (const pk of pks) {
      if (pk === this.auth.pubkey || seen.has(pk)) continue;
      const names = [this.nickFor(pk, serverId), this.accountNameOf(pk)].filter(Boolean);
      for (const name of names) {
        const sk = skeleton(name);
        if (!sk) continue;
        const exact = String(nick).trim().toLowerCase() === name.trim().toLowerCase();
        const same = sk === want;
        const near = !same && Math.min(sk.length, want.length) >= 5 && editDistance(sk, want) <= 1;
        if (exact || same || near) { found.push({ pubkey: pk, name, kind: exact ? 'exact' : 'similar' }); seen.add(pk); break; }
      }
    }
    return found;
  }

  nickFor(pubkey, serverId) { const r = this.nicks.get((serverId || '') + '|' + pubkey); return r ? r.nick : ''; }
  serverAvatarFor(pubkey, serverId) { const r = this.nicks.get((serverId || '') + '|' + pubkey); return r ? r.avatar : ''; }

  avatarOf(pubkey, serverId) {
    const own = this.serverAvatarFor(pubkey, serverId);
    if (own) return own;
    const p = this.chat && this.chat.profiles.get(pubkey);
    return p ? safeImageUrl(p.picture || '') : '';
  }

  profileOf(pubkey) {
    if (pubkey === this.auth.pubkey) return this.pub;
    return (this.chat && this.chat.profiles.get(pubkey)) || {};
  }

  async setServerProfile(serverId, { nick = '', avatar = '' }) {
    if (!serverId) fail('Open a server first');
    const n = clean(nick, LIMITS.nick).replace(/\s+/g, ' '); const a = avatar ? (safeImageUrl(avatar) || fail('Server picture must be an https:// image address or an uploaded image')) : '';
    const perServer = { ...this.priv.perServer };
    if (n || a) perServer[serverId] = { nick: n, avatar: a }; else delete perServer[serverId];
    this.priv = { ...this.priv, perServer };
    const signed = await this.auth.sign({ kind: 30078, created_at: replaceableTs(), tags: [['d', NICK_D(serverId)]], content: JSON.stringify({ nick: n, avatar: a }) });
    this.pool.publish(signed);
    this.nicks.set(serverId + '|' + this.auth.pubkey, { nick: n, avatar: a, at: signed.created_at });
    await this.pushSync();
    this._emit('nick', { serverId, pubkey: this.auth.pubkey });
    return { nick: n, avatar: a };
  }

  async requestDeletion({ reason = '', kinds = null } = {}) {
    if (!this.auth.isLoggedIn()) fail('Sign in first');
    const pk = this.auth.pubkey;
    const filter = { authors: [pk], limit: 1000 };
    if (kinds && kinds.length) filter.kinds = kinds;
    const events = (await this._collect([filter], 9000)).filter((e) => e.kind !== 5);
    if (!events.length) return { requested: 0, batches: 0 };
    const isAddressable = (k) => k === 0 || k === 3 || (k >= 10000 && k < 20000) || (k >= 30000 && k < 40000);
    const tagFor = (e) => {
      if (isAddressable(e.kind)) { const d = (e.tags.find((t) => t[0] === 'd') || [])[1] || ''; return ['a', e.kind + ':' + pk + ':' + d]; }
      return ['e', e.id];
    };
    const uniq = new Map(); for (const e of events) { const t = tagFor(e); uniq.set(t.join('|'), { t, kind: e.kind }); }
    const items = [...uniq.values()];
    let batches = 0;
    for (let i = 0; i < items.length; i += 100) {
      const chunk = items.slice(i, i + 100);
      const kindsSeen = [...new Set(chunk.map((c) => String(c.kind)))].map((k) => ['k', k]);
      const signed = await this.auth.sign({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [...chunk.map((c) => c.t), ...kindsSeen], content: clean(reason, 200) });
      this.pool.publish(signed);
      batches++;
    }
    return { requested: items.length, batches };
  }

  async rotateKey() {
    if (!this.auth.isLoggedIn()) fail('Sign in first');
    if (!this.auth.privkey) fail('This account signs with a browser extension. Rotate the key inside the extension instead.');
    const oldSk = this.auth.privkey; const oldPk = this.auth.pubkey;
    const newSk = this.NT.generateSecretKey(); const newPk = this.NT.getPublicKey(newSk);
    const newNpub = this.NT.nip19.npubEncode(newPk); const oldNpub = this.NT.nip19.npubEncode(oldPk);
    const now = Math.floor(Date.now() / 1000);
    const note = this.NT.finalizeEvent({ kind: 1, created_at: now, tags: [['p', newPk, '', 'migrated-to'], ['t', 'zellous-key-migration']], content: 'I am moving to a new key. My new public key is ' + newNpub + '. This note is signed by my old key (' + oldNpub + ').' }, oldSk);
    const acked = await this.pool.publishAndWait(note);
    if (!acked) fail('No relay accepted the migration note, so nothing was changed. Check your relays and try again.');
    const oldProfile = { ...this.pub, moved_to: newNpub };
    const oldMeta = this.NT.finalizeEvent({ kind: 0, created_at: Math.max(now, this.pubAt + 1), tags: [], content: JSON.stringify(oldProfile) }, oldSk);
    this.pool.publish(oldMeta);
    const oldNsec = this.NT.nip19.nsecEncode(oldSk);
    this.auth._persist(newSk, newPk);
    this.auth._emit('login', { pubkey: newPk });
    const back = await this.auth.sign({ kind: 1, created_at: now + 1, tags: [['p', oldPk, '', 'migrated-from'], ['t', 'zellous-key-migration']], content: 'This is my new key. I moved from ' + oldNpub + '. My old key signed the announcement.' });
    this.pool.publish(back);
    const carried = { ...this.pub }; delete carried.moved_to; carried.migrated_from = oldNpub;
    this._loadedFor = '';
    this.pub = {}; this.pubAt = 0; this.privAt = 0;
    await this.setPublic({}, { extra: carried });
    this.priv = this._mergePrivate(DEFAULT_PRIVATE(), this.priv);
    await this.pushSync();
    this.load();
    return { oldNsec, oldNpub, newNpub, newPk };
  }

  exportJson() {
    return JSON.stringify({
      format: 'zellous-account', version: 1, exportedAt: new Date().toISOString(),
      npub: this.NT.nip19.npubEncode(this.auth.pubkey),
      public: this.pub,
      personalization: { ...this.priv, prefs: this.prefsIO ? this.prefsIO.read() : this.priv.prefs },
      relays: this.pool.relayList(),
      blocked: this.blocked().map((pk) => this.NT.nip19.npubEncode(pk))
    }, null, 2);
  }

  async importJson(text) {
    if (!this.auth.isLoggedIn()) fail('Sign in first');
    let data; try { data = JSON.parse(String(text || '')); } catch { fail('That file is not valid JSON'); }
    if (!data || data.format !== 'zellous-account') fail('That is not a Zellous account export');
    if (data.version !== 1) fail('Unsupported export version ' + data.version);
    const pub = data.public && typeof data.public === 'object' ? data.public : {};
    const fields = {};
    for (const k of ['name', 'username', 'about', 'pronouns', 'location', 'website', 'picture', 'accent', 'nip05', 'links']) if (pub[k] !== undefined) fields[k] = pub[k];
    if (pub.zbanner) fields.banner = pub.zbanner;
    await this.setPublic(fields);
    const pers = data.personalization && typeof data.personalization === 'object' ? { ...data.personalization } : {};
    delete pers.updatedAt;
    this.priv = this._mergePrivate(this.priv, pers);
    if (this.prefsIO && pers.prefs) this.prefsIO.write(this.priv.prefs);
    await this.pushSync();
    const relays = Array.isArray(data.relays) ? data.relays : [];
    if (relays.length) { this.pool.setRelays(relays); this._storeRelays(); await this.publishRelayList(); }
    this._emit('updated');
    return { fields: Object.keys(fields).length, relays: relays.length };
  }
}

export const createAccount = (opts) => new Account(opts);
