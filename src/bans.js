export class Bans extends EventTarget {
  constructor({ relayPool }) {
    super();
    if (!relayPool) throw new Error('Bans: relayPool required');
    this.pool = relayPool;
    this.store = new Map();
    this.sub = null;
  }

  isBanned(serverId, pubkey) { return !!(this.store.get(serverId)?.banned || []).includes(pubkey); }

  isTimedOut(serverId, pubkey) {
    const t = this.store.get(serverId)?.timeouts?.[pubkey];
    return !!t && t.expiry > Math.floor(Date.now() / 1000);
  }

  subscribe(serverId) {
    if (this.sub) { this.pool.unsubscribe(this.sub); this.sub = null; }
    if (!serverId) return;
    const creator = serverId.split(':')[0];
    if (!creator) return;
    this.sub = 'bans-' + serverId;
    this.pool.subscribe(this.sub,
      [{ kinds: [30078], authors: [creator], '#d': ['zellous-ban:' + serverId, 'zellous-timeout:' + serverId] }],
      (event) => {
        if (event.pubkey !== creator) return;
        try {
          const dTag = event.tags.find(t => t[0] === 'd');
          if (!dTag?.[1]) return;
          const [prefix, , pubkey] = dTag[1].split(':');
          const data = this.store.get(serverId) || { banned: [], timeouts: {} };
          if (prefix === 'zellous-ban' && pubkey && !data.banned.includes(pubkey)) data.banned.push(pubkey);
          else if (prefix === 'zellous-timeout' && pubkey) {
            const parsed = JSON.parse(event.content);
            if (parsed.expiry > Math.floor(Date.now() / 1000)) (data.timeouts = data.timeouts || {})[pubkey] = { expiry: parsed.expiry };
            else if (data.timeouts?.[pubkey]) delete data.timeouts[pubkey];
          }
          this.store.set(serverId, data);
          this.dispatchEvent(new CustomEvent('updated', { detail: { serverId, data } }));
        } catch {}
      });
  }
}

export const createBans = (opts) => new Bans(opts);
