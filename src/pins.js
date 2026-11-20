import { dtag, replaceableTs } from './dtag.js';

const CAP = 50;

export class Pins extends EventTarget {
  constructor({ relayPool, auth }) {
    super();
    if (!relayPool || !auth) throw new Error('Pins: deps required');
    this.pool = relayPool; this.auth = auth;
    this.byAuthor = new Map();
    this.subs = new Map();
  }

  _key(serverId, channelId) { return serverId + '|' + channelId; }

  ids(serverId, channelId) {
    const authors = this.byAuthor.get(this._key(serverId, channelId));
    if (!authors) return [];
    return [...authors.values()]
      .sort((a, b) => b.ts - a.ts)
      .flatMap((e) => e.ids)
      .filter((id, i, all) => all.indexOf(id) === i)
      .slice(0, CAP);
  }

  async pin(serverId, channelId, messageId) {
    if (!serverId || !channelId || !messageId) throw new Error('Pins: serverId, channelId and messageId required');
    const mine = this.byAuthor.get(this._key(serverId, channelId))?.get(this.auth.pubkey)?.ids || [];
    const next = [messageId, ...mine.filter((id) => id !== messageId)].slice(0, CAP);
    const signed = await this.auth.sign({ kind: 30078, created_at: replaceableTs(), tags: [['d', dtag('pins', serverId, channelId)]], content: JSON.stringify({ ids: next }) });
    this.pool.publish(signed);
    this._store(serverId, channelId, this.auth.pubkey, next, signed.created_at);
    return next;
  }

  subscribe(serverId, channelId) {
    const k = this._key(serverId, channelId);
    if (this.subs.has(k)) return;
    const subId = 'pins-' + k.slice(0, 96);
    this.subs.set(k, subId);
    this.pool.subscribe(subId, [{ kinds: [30078], '#d': [dtag('pins', serverId, channelId)] }], (event) => {
      let data;
      try { data = JSON.parse(event.content); } catch { return; }
      if (!Array.isArray(data.ids)) return;
      this._store(serverId, channelId, event.pubkey, data.ids.filter((x) => typeof x === 'string').slice(0, CAP), event.created_at);
    });
  }

  _store(serverId, channelId, author, ids, ts) {
    const k = this._key(serverId, channelId);
    if (!this.byAuthor.has(k)) this.byAuthor.set(k, new Map());
    const authors = this.byAuthor.get(k);
    const prev = authors.get(author);
    if (prev && prev.ts > ts) return;
    authors.set(author, { ids, ts });
    this.dispatchEvent(new CustomEvent('updated', { detail: { serverId, channelId, ids: this.ids(serverId, channelId) } }));
  }

  unsubscribe(serverId, channelId) {
    const k = this._key(serverId, channelId);
    const subId = this.subs.get(k);
    if (subId) { this.pool.unsubscribe(subId); this.subs.delete(k); }
  }
}

export const createPins = (opts) => new Pins(opts);
