import { dtag, replaceableTs } from './dtag.js';

export const PRESENCE_STATUSES = ['online', 'idle', 'dnd', 'invisible'];
const CUSTOM_CAP = 60;
const HEX_PK = /^[0-9a-f]{64}$/i;

export class Presence extends EventTarget {
  constructor({ relayPool, auth }) {
    super();
    if (!relayPool || !auth) throw new Error('Presence: deps required');
    this.pool = relayPool; this.auth = auth;
    this.byAuthor = new Map();
    this.subId = null;
  }

  statusOf(pubkey) {
    const rec = this.byAuthor.get(pubkey);
    const lapsed = rec && rec.until && rec.until <= Math.floor(Date.now() / 1000);
    return { status: rec ? rec.status : 'online', custom: rec && !lapsed ? rec.custom : '' };
  }

  async set(status, custom = '', { until = 0 } = {}) {
    if (!PRESENCE_STATUSES.includes(status)) throw new Error('Presence: unknown status');
    const text = String(custom || '').trim().slice(0, CUSTOM_CAP);
    const signed = await this.auth.sign({ kind: 30078, created_at: replaceableTs(), tags: [['d', dtag('presence', 'status')]], content: JSON.stringify(until ? { status, custom: text, until } : { status, custom: text }) });
    this.pool.publish(signed);
    this._store(this.auth.pubkey, status, text, signed.created_at, until);
    return { status, custom: text };
  }

  subscribe(pubkeys) {
    const authors = [...new Set((pubkeys || []).map((pk) => String(pk || '').toLowerCase()))].filter((pk) => HEX_PK.test(pk));
    if (this.subId) { this.pool.unsubscribe(this.subId); this.subId = null; }
    if (!authors.length) return;
    const subId = 'presence-' + Date.now();
    this.subId = subId;
    this.pool.subscribe(subId, [{ kinds: [30078], authors, '#d': [dtag('presence', 'status')] }], (event) => {
      let data;
      try { data = JSON.parse(event.content); } catch { return; }
      if (!data || !PRESENCE_STATUSES.includes(data.status)) return;
      this._store(event.pubkey, data.status, String(data.custom || '').slice(0, CUSTOM_CAP), event.created_at, Number(data.until) || 0);
    });
  }

  _store(author, status, custom, ts, until = 0) {
    const prev = this.byAuthor.get(author);
    if (prev && prev.ts > ts) return;
    this.byAuthor.set(author, { status, custom, ts, until });
    this.dispatchEvent(new CustomEvent('updated', { detail: { pubkey: author, status, custom } }));
  }
}

export const createPresence = (opts) => new Presence(opts);
