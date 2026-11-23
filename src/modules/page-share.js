import { registerProtocol } from './registry.js';
import { dtag, replaceableTs } from '../dtag.js';

export const PAGE_SHARE_KIND = 30078;
const MAX_URL = 1000;

export const normalizePageUrl = (input) => {
  const text = String(input || '').trim();
  if (!text) throw new Error('Enter the page address to share');
  if (text.length > MAX_URL) throw new Error('That address is too long');
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : 'https://' + text); } catch { throw new Error('That is not a web address'); }
  if (url.protocol !== 'https:') throw new Error('Only https:// pages can be shared');
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') throw new Error('That address needs a domain name');
  return url.href;
};

export const createPageShare = ({ relayPool, auth }) => {
  const shares = new Map();
  const listeners = new Set();
  const subs = new Map();

  const keyOf = (serverId, channelId) => serverId + '|' + channelId;
  const notify = (serverId, channelId) => listeners.forEach((fn) => fn(serverId, channelId));

  const ingest = (serverId, channelId, event) => {
    let data;
    try { data = JSON.parse(event.content); } catch { return; }
    if (!data || typeof data !== 'object') return;
    const key = keyOf(serverId, channelId);
    const prev = shares.get(key);
    if (prev && prev.at > event.created_at) return;
    let url = '';
    try { url = data.url ? normalizePageUrl(data.url) : ''; } catch { url = ''; }
    shares.set(key, { url, by: event.pubkey, at: event.created_at });
    notify(serverId, channelId);
  };

  const send = async (serverId, channelId, url) => {
    if (!auth.isLoggedIn()) throw new Error('Sign in first');
    const signed = await auth.sign({ kind: PAGE_SHARE_KIND, created_at: replaceableTs(), tags: [['d', dtag('pageshare', serverId, channelId)]], content: JSON.stringify({ url }) });
    relayPool.publish(signed);
    ingest(serverId, channelId, signed);
    return signed;
  };

  return {
    current: (serverId, channelId) => shares.get(keyOf(serverId, channelId)) || null,
    watch(serverId, channelId) {
      const key = keyOf(serverId, channelId);
      if (subs.has(key)) return;
      const subId = 'pageshare-' + key.slice(0, 60);
      subs.set(key, subId);
      relayPool.subscribe(subId, [{ kinds: [PAGE_SHARE_KIND], '#d': [dtag('pageshare', serverId, channelId)], limit: 20 }], (event) => ingest(serverId, channelId, event));
    },
    unwatch(serverId, channelId) {
      const key = keyOf(serverId, channelId);
      const subId = subs.get(key);
      if (subId) { relayPool.unsubscribe(subId); subs.delete(key); }
    },
    start: (serverId, channelId, input) => send(serverId, channelId, normalizePageUrl(input)),
    stop: (serverId, channelId) => send(serverId, channelId, ''),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
};

registerProtocol({ id: 'page-share', channelTypes: [], eventKinds: [PAGE_SHARE_KIND], createPageShare, normalizePageUrl });
