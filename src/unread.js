import { hexChannelId } from './channel-hex.js';

const nowSec = () => Math.floor(Date.now() / 1000);

const trySetItem = (storage, key, value) => {
  try { storage.setItem(key, value); return true; } catch { return false; }
};

export class Unread extends EventTarget {
  constructor({ relayPool, auth, storage = null }) {
    super();
    if (!relayPool || !auth) throw new Error('Unread: relayPool + auth required');
    this.pool = relayPool;
    this.auth = auth;
    this.storage = storage;
    this.counts = {};
    this.pings = {};
    this.pingTest = null;
    this.lastRead = {};
    this.boundaries = {};
    this.activeChannelId = null;
    this.serverId = null;
    this.hexToChannel = new Map();
    this._emitTimer = null;
    this._load();
  }

  _lk(channelId) { return this.serverId + '|' + channelId; }

  _key() { return 'wireweave.unread.' + (this.auth.pubkey || 'anon'); }

  _load() {
    this.lastRead = {};
    try {
      const raw = this.storage && this.storage.getItem(this._key());
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') this.lastRead = parsed;
    } catch { this.lastRead = {}; }
  }

  _save() {
    if (this.storage) trySetItem(this.storage, this._key(), JSON.stringify(this.lastRead));
  }

  _emit() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.dispatchEvent(new CustomEvent('unread', { detail: { counts: this.countsFor() } }));
    }, 120);
  }

  setPingTest(fn) { this.pingTest = typeof fn === 'function' ? fn : null; }

  countsFor() { return { ...this.counts }; }

  pingsFor() { return { ...this.pings }; }

  countFor(channelId) { return this.counts[channelId] || 0; }

  boundaryFor(channelId) { return this.boundaries[channelId] || null; }

  setActive(channelId) {
    if (channelId && !this.serverId) return;
    if (channelId && channelId !== this.activeChannelId) this.boundaries[channelId] = this.lastRead[this._lk(channelId)] || null;
    this.activeChannelId = channelId || null;
    if (!channelId) return;
    this.counts[channelId] = 0;
    this.pings[channelId] = 0;
    this.lastRead[this._lk(channelId)] = Math.max(this.lastRead[this._lk(channelId)] || 0, nowSec());
    this._save();
    this._emit();
  }

  markRead(channelId) {
    if (!channelId || !this.serverId) return;
    delete this.boundaries[channelId];
    this.counts[channelId] = 0;
    this.pings[channelId] = 0;
    this.lastRead[this._lk(channelId)] = Math.max(this.lastRead[this._lk(channelId)] || 0, nowSec());
    this._save();
    this._emit();
  }

  markUnread(channelId, atSec) {
    if (!channelId || !this.serverId) return;
    const at = Math.max(1, Math.floor(atSec || 0));
    this.lastRead[this._lk(channelId)] = at;
    this.boundaries[channelId] = at;
    this.counts[channelId] = Math.max(1, this.counts[channelId] || 0);
    this._save();
    this._emit();
  }

  async start(serverId, channels = []) {
    if (!serverId) return this.stop();
    const text = (channels || []).filter((c) => c && c.id && c.type !== 'voice');
    if (!text.length) return this.stop();
    this.stop();
    this.serverId = serverId;
    this.counts = {};
    this.pings = {};
    this.hexToChannel = new Map();
    const hexes = [];
    for (const c of text) {
      const hex = await hexChannelId(c.id, serverId);
      this.hexToChannel.set(hex, c.id);
      hexes.push(hex);
    }
    let since = nowSec();
    for (const c of text) {
      const lr = this.lastRead[this._lk(c.id)] || 0;
      if (lr && lr < since) since = lr;
    }
    this.pool.subscribe('unread-' + serverId,
      [{ kinds: [42], '#e': hexes, since }],
      (event) => this._onEvent(event));
    this._emit();
  }

  stop() {
    if (this.serverId) this.pool.unsubscribe('unread-' + this.serverId);
    this.serverId = null;
    this.hexToChannel = new Map();
  }

  _onEvent(event) {
    const tags = event.tags || [];
    const hex = tags.find((t) => t[0] === 'e')?.[1];
    const channelId = hex && this.hexToChannel.get(hex);
    if (!channelId) return;
    if (channelId === this.activeChannelId) {
      if ((event.created_at || 0) > (this.lastRead[this._lk(channelId)] || 0)) {
        this.lastRead[this._lk(channelId)] = event.created_at;
        this._save();
      }
      return;
    }
    if ((event.created_at || 0) <= (this.lastRead[this._lk(channelId)] || 0)) return;
    this.counts[channelId] = (this.counts[channelId] || 0) + 1;
    if (this.pingTest && event.pubkey !== this.auth.pubkey && this.pingTest(event)) this.pings[channelId] = (this.pings[channelId] || 0) + 1;
    this._emit();
  }
}

export const createUnread = (opts) => new Unread(opts);
