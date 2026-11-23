import { registerProtocol } from './registry.js';
import { dtag, parseDtag, replaceableTs } from '../dtag.js';

export const DISCOVERY_KIND = 30078;
export const DISCOVERY_TAG = 'zellous-discover';
export const DISCOVERY_DRAFT_TAG = 'zellous-discover-draft';
export const CATEGORIES = ['gaming', 'music', 'art', 'technology', 'science', 'education', 'community', 'creative', 'social', 'other'];
export const LANGUAGES = [['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'], ['it', 'Italiano'], ['ja', '日本語'], ['ko', '한국어'], ['zh', '中文'], ['ru', 'Русский'], ['ar', 'العربية'], ['hi', 'हिन्दी']];

const LIMITS = { name: 100, description: 500, icon: 500, tags: 8, tag: 24 };
const STATUSES = ['draft', 'listed', 'unlisted'];
const ROLES_BATCH = 40;

const clip = (value, max) => String(value == null ? '' : value).trim().slice(0, max);

export const normalizeTags = (input) => {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const seen = [];
  for (const raw of list) {
    const tag = String(raw).toLowerCase().replace(/^#/, '').replace(/[^a-z0-9-]/g, '').slice(0, LIMITS.tag);
    if (tag && !seen.includes(tag)) seen.push(tag);
    if (seen.length >= LIMITS.tags) break;
  }
  return seen;
};

export const cleanIcon = (input) => {
  const text = clip(input, LIMITS.icon);
  if (!text) return '';
  try { const url = new URL(text); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
};

export const cleanFields = (input = {}) => ({
  name: clip(input.name, LIMITS.name),
  description: clip(input.description, LIMITS.description),
  icon: cleanIcon(input.icon),
  category: CATEGORIES.includes(input.category) ? input.category : '',
  tags: normalizeTags(input.tags),
  language: LANGUAGES.some(([code]) => code === input.language) ? input.language : '',
  guidelines: input.guidelines === true
});

export const requirementsFor = ({ fields, textChannels = 0, rulesPages = 0, appointedAdmins = 0 }) => [
  { id: 'name', label: 'A server name', ok: !!fields.name },
  { id: 'description', label: 'A description', ok: !!fields.description },
  { id: 'icon', label: 'An icon (https image address)', ok: !!fields.icon },
  { id: 'channel', label: 'At least one text channel', ok: textChannels > 0 },
  { id: 'rules', label: 'A rules page', ok: rulesPages > 0 },
  { id: 'admin', label: 'At least one admin besides the owner', ok: appointedAdmins > 0 },
  { id: 'guidelines', label: 'Community guidelines acknowledged', ok: !!fields.guidelines }
];

export const serverIdOfDtag = (d, ns) => {
  const parsed = parseDtag(d);
  return parsed && parsed.ns === ns && parsed.parts.length ? parsed.parts.join(':') : null;
};

const ownerOf = (serverId) => (typeof serverId === 'string' && serverId.includes(':') ? serverId.split(':')[0].toLowerCase() : null);
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

export const adminsFromRoleEvents = (serverId, events) => {
  const owner = ownerOf(serverId);
  let admins = [];
  for (const event of [...events].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))) {
    let data;
    try { data = JSON.parse(event.content); } catch { continue; }
    const next = Array.isArray(data && data.admins) ? data.admins.filter((p) => typeof p === 'string') : [];
    if (event.pubkey === owner || (admins.includes(event.pubkey) && sameSet(next, admins))) admins = next;
  }
  return { owner, admins: owner ? admins.filter((p) => p !== owner) : [] };
};

export const parseListing = (event) => {
  if (!event || event.kind !== DISCOVERY_KIND || !Array.isArray(event.tags)) return null;
  const d = (event.tags.find((t) => t[0] === 'd') || [])[1];
  const serverId = serverIdOfDtag(d, 'discover');
  if (!serverId) return null;
  let data;
  try { data = JSON.parse(event.content); } catch { return null; }
  if (!data || data.serverId !== serverId || !STATUSES.includes(data.status)) return null;
  if (data.by && data.by !== event.pubkey) return null;
  return { id: event.id, serverId, status: data.status, action: clip(data.action, 20), fields: cleanFields(data), by: event.pubkey, at: event.created_at };
};

export const createServersDiscovery = ({ relayPool, auth }) => {
  if (!relayPool || !auth) throw new Error('servers-discovery: relayPool and auth required');
  const listings = new Map();
  const superseded = new Map();
  const roleEvents = new Map();
  const listeners = new Set();
  const watching = new Set();
  let browsing = false;
  let rolesTimer = null;
  let rolesKey = '';

  const notify = () => listeners.forEach((fn) => fn());

  const ingestListing = (event) => {
    const parsed = parseListing(event);
    if (!parsed) return;
    const byAuthor = listings.get(parsed.serverId) || new Map();
    const prev = byAuthor.get(parsed.by);
    if (prev && (prev.at > parsed.at || prev.id === parsed.id)) return;
    if (prev && parsed.by === auth.pubkey) superseded.set(parsed.serverId, [...(superseded.get(parsed.serverId) || []), prev.id]);
    byAuthor.set(parsed.by, parsed);
    listings.set(parsed.serverId, byAuthor);
    notify();
  };

  const ingestRoles = (event) => {
    const d = (event.tags.find((t) => t[0] === 'd') || [])[1];
    const serverId = serverIdOfDtag(d, 'roles');
    if (!serverId) return;
    const byId = roleEvents.get(serverId) || new Map();
    if (byId.has(event.id)) return;
    byId.set(event.id, event);
    roleEvents.set(serverId, byId);
    notify();
  };

  const onEvent = (event) => {
    if (!event || event.kind !== DISCOVERY_KIND) return;
    const d = (event.tags.find((t) => t[0] === 'd') || [])[1] || '';
    if (d.startsWith('zellous-roles:')) ingestRoles(event); else ingestListing(event);
  };

  const rolesFor = (serverId) => adminsFromRoleEvents(serverId, [...(roleEvents.get(serverId) || new Map()).values()]);

  const view = (serverId) => {
    const { owner, admins } = rolesFor(serverId);
    const signers = new Set([owner, ...admins].filter(Boolean));
    const all = [...(listings.get(serverId) || new Map()).values()].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    const valid = all.filter((l) => signers.has(l.by));
    const invalid = all.filter((l) => !signers.has(l.by));
    const latest = valid[0] || null;
    const marked = valid.find((l) => l.status !== 'draft') || null;
    const current = marked || latest;
    return {
      serverId, owner, appointedAdmins: admins,
      status: marked && marked.status === 'listed' ? 'discoverable' : 'undiscoverable',
      fields: current ? current.fields : cleanFields({}),
      latest, log: valid.filter((l) => l.action).slice(0, 10), invalid
    };
  };

  const watchRoles = () => {
    const ids = [...new Set([...listings.keys(), ...watching])].sort();
    const key = ids.join('|');
    if (key === rolesKey) return;
    rolesKey = key;
    if (!ids.length) { relayPool.unsubscribe('discover-roles'); return; }
    const filters = [];
    for (let i = 0; i < ids.length; i += ROLES_BATCH) filters.push({ kinds: [DISCOVERY_KIND], '#d': ids.slice(i, i + ROLES_BATCH).map((id) => dtag('roles', id)) });
    relayPool.subscribe('discover-roles', filters, onEvent);
  };

  const scheduleRoles = () => { if (rolesTimer) return; rolesTimer = setTimeout(() => { rolesTimer = null; watchRoles(); }, 150); };
  listeners.add(scheduleRoles);

  const publish = async (serverId, status, action, input) => {
    if (!auth.isLoggedIn()) throw new Error('Sign in first');
    const { owner, admins } = rolesFor(serverId);
    if (auth.pubkey !== owner && !admins.includes(auth.pubkey)) throw new Error('Only the owner and admins can change discovery');
    const fields = cleanFields(input);
    const tag = status === 'draft' ? DISCOVERY_DRAFT_TAG : DISCOVERY_TAG;
    const signed = await auth.sign({
      kind: DISCOVERY_KIND, created_at: replaceableTs(),
      tags: [['d', dtag('discover', serverId)], ['t', tag]],
      content: JSON.stringify({ v: 1, serverId, status, action, by: auth.pubkey, ...fields })
    });
    relayPool.publish(signed);
    ingestListing(signed);
    return signed;
  };

  const retract = async (serverId) => {
    const ids = (superseded.get(serverId) || []).slice(-50);
    if (!ids.length) return null;
    const signed = await auth.sign({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [...ids.map((id) => ['e', id]), ['k', String(DISCOVERY_KIND)]], content: 'discovery listing removed' });
    relayPool.publish(signed);
    superseded.set(serverId, []);
    return signed;
  };

  return {
    view,
    watch(serverId) {
      if (!serverId || watching.has(serverId)) return;
      watching.add(serverId);
      relayPool.subscribe('discover-watch-' + serverId.slice(0, 40), [{ kinds: [DISCOVERY_KIND], '#d': [dtag('discover', serverId), dtag('roles', serverId)] }], onEvent);
    },
    unwatch(serverId) {
      if (!watching.delete(serverId)) return;
      relayPool.unsubscribe('discover-watch-' + serverId.slice(0, 40));
    },
    browse() {
      if (browsing) return;
      browsing = true;
      relayPool.subscribe('discover-browse', [{ kinds: [DISCOVERY_KIND], '#t': [DISCOVERY_TAG], limit: 500 }], onEvent);
    },
    stopBrowse() {
      if (!browsing) return;
      browsing = false;
      relayPool.unsubscribe('discover-browse');
    },
    listed() {
      return [...listings.keys()]
        .map(view)
        .filter((v) => v.status === 'discoverable')
        .map((v) => ({ serverId: v.serverId, ...v.fields, by: v.latest.by, at: v.latest.at }))
        .sort((a, b) => b.at - a.at);
    },
    save: (serverId, fields) => publish(serverId, view(serverId).latest ? view(serverId).latest.status : 'draft', 'save', fields),
    async promote(serverId, fields, context) {
      const clean = cleanFields(fields);
      const unmet = requirementsFor({ fields: clean, ...context }).filter((r) => !r.ok);
      if (unmet.length) throw new Error('Not ready for Discover: ' + unmet.map((r) => r.label.toLowerCase()).join(', '));
      return publish(serverId, 'listed', 'promote', clean);
    },
    async remove(serverId, fields) {
      const signed = await publish(serverId, 'unlisted', 'remove', fields);
      await retract(serverId);
      return signed;
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
};

registerProtocol({ id: 'servers-discovery', channelTypes: [], eventKinds: [DISCOVERY_KIND, 5], createServersDiscovery, requirementsFor, cleanFields, normalizeTags, parseListing, adminsFromRoleEvents, CATEGORIES, LANGUAGES });
