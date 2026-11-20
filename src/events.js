const EVENT_KIND = 31923;
const RSVP_KIND = 31925;
const DELETE_KIND = 5;

const channelTag = async (channelId, serverId) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((serverId || 'default') + ':' + channelId));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, '0')).join('');

export class Events extends EventTarget {
  constructor({ relayPool, auth }) {
    super();
    if (!relayPool || !auth) throw new Error('Events: deps required');
    this.pool = relayPool; this.auth = auth;
  }

  async create(serverId, channelId, { title, about = '', start, end = null, location = '' } = {}) {
    if (!channelId) throw new Error('Events: channelId required');
    const name = String(title || '').trim().slice(0, 60);
    if (!name) throw new Error('Events: title required');
    const begins = Math.floor(Number(start));
    if (!Number.isFinite(begins) || begins <= 0) throw new Error('Events: start must be a unix time in seconds');
    const tags = [['d', randomId()], ['title', name], ['start', String(begins)], ['e', await channelTag(channelId, serverId)]];
    const ends = Math.floor(Number(end));
    if (Number.isFinite(ends) && ends > begins) tags.push(['end', String(ends)]);
    if (location) tags.push(['location', String(location).slice(0, 120)]);
    const signed = await this.auth.sign({ kind: EVENT_KIND, created_at: Math.floor(Date.now() / 1000), tags, content: String(about || '').slice(0, 120) });
    this.pool.publish(signed);
    this.dispatchEvent(new CustomEvent('created', { detail: { channelId, event: signed } }));
    return signed;
  }

  async rsvp(event, accepted) {
    if (!event || !event.id || !event.addr) throw new Error('Events: event id and address required');
    const signed = await this.auth.sign({
      kind: RSVP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', randomId()], ['a', event.addr], ['e', event.id], ['status', accepted ? 'accepted' : 'declined']],
      content: ''
    });
    this.pool.publish(signed);
    return signed;
  }

  async delete(event) {
    if (!event || !event.id || !event.addr) throw new Error('Events: event id and address required');
    const signed = await this.auth.sign({
      kind: DELETE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', event.id], ['a', event.addr]],
      content: 'deleted'
    });
    this.pool.publish(signed);
    return signed;
  }
}

export const createEvents = (opts) => new Events(opts);
