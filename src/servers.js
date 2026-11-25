import { replaceableTs } from './dtag.js';
import { safeSetItem } from './safe-storage.js';
import { hexChannelId } from './channel-hex.js';
import { dtag } from './dtag.js';

const SERVER_KIND = 34550;
const ZERO_OWNER = '0'.repeat(64);
const OWN_DTAG_NAMESPACES = ['channels', 'roles', 'settings', 'selfroles', 'discover'];
const MEMBER_KINDS = [42, 7];

export const isTombstone = (event) => !!event && event.kind === SERVER_KIND && Array.isArray(event.tags) && event.tags.some((t) => t[0] === 'deleted' && t[1] === '1');

const splitId = (serverId) => {
  const parts = typeof serverId === 'string' ? serverId.split(':') : [];
  return parts.length === 2 && /^[0-9a-f]{64}$/.test(parts[0]) && parts[1] ? { owner: parts[0], d: parts[1] } : null;
};

export class Servers extends EventTarget {
  constructor({ relayPool, auth, storage, onSwitch = null }) {
    super();
    if (!relayPool) throw new Error('Servers: relayPool required');
    if (!auth) throw new Error('Servers: auth required');
    if (!storage) throw new Error('Servers: storage required (no localStorage in this env — pass a {getItem,setItem,removeItem} adapter)');
    this.pool = relayPool; this.auth = auth; this.storage = storage; this.onSwitch = onSwitch;
    this.servers = []; this.currentServerId = null;
    this.deleted = new Map();
    this._watch = new Map(); this._watchTimer = null; this._watchKey = '';
  }

  isDeleted(serverId) { return this.deleted.has(serverId); }
  deletedIds() { return [...this.deleted.keys()]; }

  load() {
    try { this.servers = JSON.parse(this.storage.getItem('zn_servers') || '[]'); } catch { this.servers = []; }
    try { (JSON.parse(this.storage.getItem('zn_deleted_servers') || '[]')).forEach((id) => this.deleted.set(id, { at: 0 })); } catch {}
    this.servers = this.servers.filter((s) => !this.deleted.has(s.id));
    if (this.auth.pubkey) {
      this.pool.subscribe('my-servers', [{ kinds: [34550], authors: [this.auth.pubkey] }], (ev) => { if (ev.pubkey === this.auth.pubkey) this._handleEvent(ev); });
    }
    try {
      const joined = JSON.parse(this.storage.getItem('zn_joined_servers') || '[]').filter((sid) => !this.deleted.has(sid));
      joined.forEach(sid => { if (!this.servers.find(s => s.id === sid)) this.servers = [...this.servers, { id: sid, name: sid.slice(0, 8), iconColor: '#5865F2' }]; });
      const unresolved = joined.filter(sid => { const p = sid.split(':'); return p.length === 2 && p[0] !== this.auth.pubkey; });
      const byAuthor = {};
      unresolved.forEach(sid => { const [author, dTag] = sid.split(':'); (byAuthor[author] = byAuthor[author] || []).push(dTag); });
      Object.keys(byAuthor).forEach(author => {
        this.pool.subscribe('joined-server-' + author.slice(0, 8),
          [{ kinds: [34550], authors: [author], '#d': byAuthor[author] }],
          (ev) => { if (ev.pubkey === author) this._handleEvent(ev); });
      });
    } catch {}
    this._emit('updated', { servers: this.servers });
  }

  _handleEvent(event) {
    const nameTag = event.tags.find(t => t[0] === 'name');
    const colorTag = event.tags.find(t => t[0] === 'color');
    const dTag = event.tags.find(t => t[0] === 'd');
    if (!dTag) return;
    const serverId = event.pubkey + ':' + dTag[1];
    if (isTombstone(event)) { this._applyTombstone(serverId, event); return; }
    if (this.deleted.has(serverId)) return;
    const name = nameTag ? nameTag[1] : serverId.slice(0, 8);
    const iconColor = colorTag && /^#[0-9a-fA-F]{6}$/.test(colorTag[1]) ? colorTag[1] : '#5865F2';
    const existing = this.servers.find(s => s.id === serverId);
    if (existing) { existing.name = name; existing.iconColor = iconColor; existing.ownerId = event.pubkey; this.servers = [...this.servers]; }
    else this.servers = [...this.servers, { id: serverId, name, iconColor, ownerId: event.pubkey }];
    this._persist();
    this._emit('updated', { servers: this.servers });
  }

  _applyTombstone(serverId, event) {
    if (this.deleted.has(serverId) && this.deleted.get(serverId).at) return;
    const known = this.servers.find((s) => s.id === serverId);
    const name = (event.tags.find((t) => t[0] === 'name') || [])[1] || (known && known.name) || serverId.slice(0, 8);
    const wasListed = !!known || this.currentServerId === serverId;
    this.deleted.set(serverId, { at: event.created_at, name });
    safeSetItem(this.storage, this, 'zn_deleted_servers', JSON.stringify([...this.deleted.keys()]));
    this.servers = this.servers.filter((s) => s.id !== serverId);
    this._persist();
    try {
      const joined = JSON.parse(this.storage.getItem('zn_joined_servers') || '[]');
      safeSetItem(this.storage, this, 'zn_joined_servers', JSON.stringify(joined.filter((id) => id !== serverId)));
    } catch {}
    this._emit('updated', { servers: this.servers });
    if (this.currentServerId === serverId) this.switchTo(null);
    this._emit('deleted', { serverId, name, wasListed });
  }

  watchTombstone(serverId) {
    const id = splitId(serverId);
    if (!id || id.owner === ZERO_OWNER || this.deleted.has(serverId)) return;
    const set = this._watch.get(id.owner) || new Set();
    if (set.has(id.d)) return;
    set.add(id.d); this._watch.set(id.owner, set);
    if (this._watchTimer) return;
    this._watchTimer = setTimeout(() => {
      this._watchTimer = null;
      const filters = [...this._watch].map(([owner, ds]) => ({ kinds: [SERVER_KIND], authors: [owner], '#d': [...ds].sort() }));
      const key = JSON.stringify(filters);
      if (key === this._watchKey) return;
      this._watchKey = key;
      this.pool.subscribe('server-tombstones', filters, (ev) => { if (isTombstone(ev)) this._handleEvent(ev); });
    }, 150);
  }

  _collect(filters, timeoutMs) {
    return new Promise((resolve) => {
      const out = []; const eosed = new Set();
      const subId = 'srv-collect-' + Math.random().toString(36).slice(2, 8);
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); this.pool.unsubscribe(subId); resolve(out); };
      const timer = setTimeout(finish, timeoutMs);
      this.pool.subscribe(subId, filters, (ev) => out.push(ev), (url) => { eosed.add(url); if (eosed.size >= Math.max(1, this.pool.connectedCount())) finish(); });
    });
  }

  async checkDeleted(serverId, timeoutMs = 2000) {
    if (this.deleted.has(serverId)) return true;
    const id = splitId(serverId);
    if (!id || id.owner === ZERO_OWNER) return false;
    const events = await this._collect([{ kinds: [SERVER_KIND], authors: [id.owner], '#d': [id.d] }], timeoutMs);
    events.filter(isTombstone).forEach((ev) => this._handleEvent(ev));
    return this.deleted.has(serverId);
  }

  async deleteForEveryone(serverId, { channelIds = [] } = {}) {
    const id = splitId(serverId);
    if (!id || id.owner !== this.auth.pubkey) throw new Error('Only the owner can delete a server for everyone');
    if (this.deleted.has(serverId)) return { alreadyDeleted: true };
    const known = this.servers.find((s) => s.id === serverId);
    const name = (known && known.name) || serverId.slice(0, 8);
    const signed = await this.auth.sign({ kind: SERVER_KIND, created_at: replaceableTs(), tags: [['d', id.d], ['name', name], ['deleted', '1']], content: '' });
    const acked = await this.pool.publishAndWait(signed, { timeoutMs: 4000 });
    this._applyTombstone(serverId, signed);
    let removed = 0;
    try { removed = await this._retractOwn(serverId, id, channelIds); } catch {}
    return { acked, retracted: removed };
  }

  async _retractOwn(serverId, id, channelIds) {
    const hexes = await Promise.all(channelIds.map((c) => hexChannelId(c, serverId)));
    const filters = [{ kinds: [30078], authors: [id.owner], '#d': OWN_DTAG_NAMESPACES.map((ns) => dtag(ns, serverId)) }];
    if (hexes.length) filters.push({ kinds: MEMBER_KINDS, authors: [id.owner], '#e': hexes, limit: 1000 });
    const events = await this._collect(filters, 4000);
    const tags = new Map();
    for (const ev of events) {
      if (ev.kind === 30078) { const d = (ev.tags.find((t) => t[0] === 'd') || [])[1]; if (d) tags.set('a:' + d, { tag: ['a', '30078:' + id.owner + ':' + d], kind: 30078 }); }
      else tags.set('e:' + ev.id, { tag: ['e', ev.id], kind: ev.kind });
    }
    const list = [...tags.values()];
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const kinds = [...new Set(chunk.map((t) => String(t.kind)))].map((k) => ['k', k]);
      const signed = await this.auth.sign({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [...chunk.map((t) => t.tag), ...kinds], content: 'server deleted by its owner' });
      this.pool.publish(signed);
    }
    return list.length;
  }

  async rename(serverId, name, iconColor = '#5865F2') {
    if (!serverId?.startsWith(this.auth.pubkey + ':')) throw new Error('Only owner can rename');
    if (this.deleted.has(serverId)) throw new Error('This server was deleted');
    name = (name || '').trim();
    if (!name) throw new Error('server name cannot be empty');
    const dTag = serverId.split(':')[1];
    const signed = await this.auth.sign({ kind: 34550, created_at: replaceableTs(), tags: [['d', dTag], ['name', name], ['color', iconColor]], content: '' });
    this.pool.publish(signed);
    const s = this.servers.find(x => x.id === serverId);
    if (s) { s.name = name; s.iconColor = iconColor; this.servers = [...this.servers]; this._persist(); this._emit('updated', { servers: this.servers }); }
  }

  async create(name, iconColor = '#5865F2') {
    const dTag = Math.random().toString(36).slice(2, 10);
    const serverId = this.auth.pubkey + ':' + dTag;
    const signed = await this.auth.sign({ kind: 34550, created_at: replaceableTs(), tags: [['d', dTag], ['name', name], ['color', iconColor]], content: '' });
    this.pool.publish(signed);
    this.servers = [...this.servers, { id: serverId, name, iconColor, ownerId: this.auth.pubkey }];
    this._persist();
    await this.switchTo(serverId);
  }

  async join(serverId, { name = null, iconColor = '#5865F2', select = true } = {}) {
    const alreadyKnown = this.servers.some((s) => s.id === serverId);
    if (this.deleted.has(serverId) || (!alreadyKnown && await this.checkDeleted(serverId))) throw new Error('This server was deleted by its owner');
    try {
      const joined = JSON.parse(this.storage.getItem('zn_joined_servers') || '[]');
      if (!joined.includes(serverId)) { joined.push(serverId); safeSetItem(this.storage, this, 'zn_joined_servers', JSON.stringify(joined)); }
    } catch {}
    if (!this.servers.find(s => s.id === serverId)) { this.servers = [...this.servers, { id: serverId, name: name || serverId.slice(0, 8), iconColor }]; this._persist(); this._emit('updated', { servers: this.servers }); }
    if (select) await this.switchTo(serverId);
  }

  async delete(serverId) {
    this.servers = this.servers.filter(s => s.id !== serverId);
    this._persist();
    try {
      const joined = JSON.parse(this.storage.getItem('zn_joined_servers') || '[]');
      safeSetItem(this.storage, this, 'zn_joined_servers', JSON.stringify(joined.filter(id => id !== serverId)));
    } catch {}
    this._emit('updated', { servers: this.servers });
    if (this.currentServerId === serverId) await this.switchTo(null);
  }

  async leave(serverId) { return this.delete(serverId); }

  async switchTo(serverId) {
    if (serverId && this.deleted.has(serverId)) serverId = null;
    this.currentServerId = serverId;
    if (serverId) safeSetItem(this.storage, this, 'zn_lastServer', serverId); else this.storage.removeItem('zn_lastServer');
    this._emit('switched', { serverId });
    await this.onSwitch?.(serverId);
  }

  init() {
    this.load();
    const last = this.storage.getItem('zn_lastServer');
    if (last && this.servers.find(s => s.id === last)) this.switchTo(last);
    else if (this.servers.length) this.switchTo(this.servers[0].id);
  }

  getOrder() { try { return JSON.parse(this.storage.getItem('zn_serverOrder') || '[]'); } catch { return []; } }
  saveOrder(ids) { safeSetItem(this.storage, this, 'zn_serverOrder', JSON.stringify(ids)); this._emit('updated', { servers: this.servers }); }
  sorted() {
    const order = this.getOrder();
    if (!order.length) return this.servers;
    const idx = {}; order.forEach((id, i) => idx[id] = i);
    return this.servers.slice().sort((a, b) => (idx[a.id] ?? Infinity) - (idx[b.id] ?? Infinity));
  }

  _persist() { safeSetItem(this.storage, this, 'zn_servers', JSON.stringify(this.servers)); }
  _emit(t, d) { this.dispatchEvent(new CustomEvent(t, { detail: d })); }
}

export const createServers = (opts) => new Servers(opts);
