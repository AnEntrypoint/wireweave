import { dtag, replaceableTs } from './dtag.js';

const CAP = 16;

export class SelfRoles extends EventTarget {
  constructor({ relayPool, auth }) {
    super();
    if (!relayPool || !auth) throw new Error('SelfRoles: deps required');
    this.pool = relayPool; this.auth = auth;
    this.byServer = new Map();
    this.subs = new Map();
  }

  roles(serverId, pubkey) {
    return [...(this.byServer.get(serverId)?.get(pubkey)?.roles || [])];
  }

  holders(serverId, roleId) {
    let n = 0;
    for (const { roles } of (this.byServer.get(serverId)?.values() || [])) if (roles.includes(roleId)) n++;
    return n;
  }

  async set(serverId, roleIds) {
    if (!serverId) throw new Error('SelfRoles: serverId required');
    const next = [...new Set((roleIds || []).filter((x) => typeof x === 'string'))].slice(0, CAP);
    const signed = await this.auth.sign({ kind: 30078, created_at: replaceableTs(), tags: [['d', dtag('selfroles', serverId)]], content: JSON.stringify({ roles: next }) });
    this.pool.publish(signed);
    this._store(serverId, this.auth.pubkey, next, signed.created_at);
    return next;
  }

  subscribe(serverId) {
    if (!serverId || this.subs.has(serverId)) return;
    const subId = 'selfroles-' + serverId.slice(0, 96);
    this.subs.set(serverId, subId);
    this.pool.subscribe(subId, [{ kinds: [30078], '#d': [dtag('selfroles', serverId)] }], (event) => {
      let data;
      try { data = JSON.parse(event.content); } catch { return; }
      if (!Array.isArray(data.roles)) return;
      this._store(serverId, event.pubkey, data.roles.filter((x) => typeof x === 'string').slice(0, CAP), event.created_at);
    });
  }

  _store(serverId, author, roles, ts) {
    if (!this.byServer.has(serverId)) this.byServer.set(serverId, new Map());
    const authors = this.byServer.get(serverId);
    const prev = authors.get(author);
    if (prev && prev.ts > ts) return;
    authors.set(author, { roles, ts });
    this.dispatchEvent(new CustomEvent('updated', { detail: { serverId, pubkey: author, roles } }));
  }

  unsubscribe(serverId) {
    const subId = this.subs.get(serverId);
    if (subId) { this.pool.unsubscribe(subId); this.subs.delete(serverId); }
  }
}

export const createSelfRoles = (opts) => new SelfRoles(opts);
