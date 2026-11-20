import { dtag, replaceableTs } from './dtag.js';

const MAX_OPTIONS = 5;

export class Polls extends EventTarget {
  constructor({ relayPool, auth }) {
    super();
    if (!relayPool || !auth) throw new Error('Polls: deps required');
    this.pool = relayPool; this.auth = auth;
    this.votes = new Map();
    this.subs = new Map();
  }

  tally(pollId, optionCount) {
    const counts = new Array(optionCount).fill(0);
    let mine = -1;
    for (const [author, v] of this.votes.get(pollId) || []) {
      const valid = v.i >= 0 && v.i < optionCount;
      if (valid) counts[v.i] += 1;
      if (author === this.auth.pubkey) mine = valid ? v.i : -1;
    }
    return { counts, total: counts.reduce((n, c) => n + c, 0), mine };
  }

  async vote(pollId, optionIndex, optionCount) {
    if (!pollId || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= MAX_OPTIONS) throw new Error('Polls: pollId and a valid option index required');
    const next = this.tally(pollId, optionCount).mine === optionIndex ? -1 : optionIndex;
    const created = replaceableTs();
    const signed = await this.auth.sign({ kind: 30078, created_at: created, tags: [['d', dtag('polls', pollId)]], content: JSON.stringify({ i: next }) });
    this.pool.publish(signed);
    this._store(pollId, this.auth.pubkey, next, created);
    return signed;
  }

  subscribe(pollId) {
    if (!pollId || this.subs.has(pollId)) return;
    const subId = 'polls-' + pollId.slice(0, 48);
    this.subs.set(pollId, subId);
    this.pool.subscribe(subId, [{ kinds: [30078], '#d': [dtag('polls', pollId)] }], (ev) => {
      let data;
      try { data = JSON.parse(ev.content); } catch { return; }
      if (!Number.isInteger(data.i)) return;
      this._store(pollId, ev.pubkey, data.i, ev.created_at);
    });
  }

  _store(pollId, author, i, ts) {
    if (!this.votes.has(pollId)) this.votes.set(pollId, new Map());
    const byAuthor = this.votes.get(pollId);
    const prev = byAuthor.get(author);
    if (prev && prev.ts > ts) return;
    byAuthor.set(author, { i, ts });
    this.dispatchEvent(new CustomEvent('updated', { detail: { pollId } }));
  }

  unsubscribe(pollId) {
    const subId = this.subs.get(pollId);
    if (subId) { this.pool.unsubscribe(subId); this.subs.delete(pollId); }
  }
}

export const createPolls = (opts) => new Polls(opts);
