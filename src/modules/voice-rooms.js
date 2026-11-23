import { registerProtocol } from './registry.js';
import { dtag, replaceableTs } from '../dtag.js';
import { deriveRoomId } from '../voice-room-id.js';

export const VOICE_ROOMS_KIND = 30078;
export const OCCUPANT_FRESH_MS = 20000;
export const SOUND_FRESH_MS = 6000;
export const SOUND_COOLDOWN_MS = 2500;
const SWEEP_MS = 5000;
const PRESENCE_PREFIX = 'zellous-voice:';
const SOUND_PREFIX = dtag('sound', '');
const RADIO_PREFIX = dtag('radio', '');

export const createVoiceRooms = ({ relayPool, auth, now = () => Date.now() }) => {
  const listeners = new Set();
  const watches = new Map();
  const rooms = new Map();
  const seen = new Set();
  let lastSoundAt = 0;
  let sweeper = null;

  const notify = (type, detail) => listeners.forEach((fn) => fn(type, detail));
  const roomOf = (roomId) => rooms.get(roomId) || null;
  const stateOf = (room) => { if (!room.occupants) { room.occupants = new Map(); room.radio = { on: false, by: null, at: 0 }; } return room; };

  const fresh = (o) => !o.left && now() - o.ts < OCCUPANT_FRESH_MS;

  const ingestPresence = (room, event, data) => {
    const prev = room.occupants.get(event.pubkey);
    if (prev && prev.created > event.created_at) return;
    room.occupants.set(event.pubkey, { name: String(data.name || event.pubkey.slice(0, 8)), muted: !!data.muted, ts: Number(data.ts) || event.created_at * 1000, created: event.created_at, left: data.action === 'leave' });
    notify('occupants', { serverId: room.serverId, channelName: room.channelName });
  };

  const ingestSound = (room, event, data) => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    if (now() - event.created_at * 1000 > SOUND_FRESH_MS) return;
    notify('sound', { serverId: room.serverId, channelName: room.channelName, soundId: String(data.id || ''), by: event.pubkey, at: event.created_at * 1000, self: event.pubkey === auth.pubkey });
  };

  const ingestRadio = (room, event, data) => {
    if (room.radio.at > event.created_at) return;
    const on = !!data.on;
    const changed = room.radio.on !== on;
    room.radio = { on, by: event.pubkey, at: event.created_at };
    if (changed) notify('radio', { serverId: room.serverId, channelName: room.channelName, on });
  };

  const onEvent = (event) => {
    const d = ((event.tags || []).find((t) => t[0] === 'd') || [])[1] || '';
    let roomId = null;
    let handler = null;
    if (d.startsWith(PRESENCE_PREFIX)) { roomId = d.slice(PRESENCE_PREFIX.length); handler = ingestPresence; }
    else if (d.startsWith(SOUND_PREFIX)) { roomId = d.slice(SOUND_PREFIX.length); handler = ingestSound; }
    else if (d.startsWith(RADIO_PREFIX)) { roomId = d.slice(RADIO_PREFIX.length); handler = ingestRadio; }
    const room = roomId && roomOf(roomId);
    if (!room) return;
    let data;
    try { data = JSON.parse(event.content); } catch { return; }
    if (!data || typeof data !== 'object') return;
    handler(stateOf(room), event, data);
  };

  const sweep = () => {
    for (const w of watches.values()) notify('occupants', { serverId: w.serverId, channelName: null });
  };
  const ensureSweeper = () => { if (!sweeper && watches.size) sweeper = setInterval(sweep, SWEEP_MS); };
  const stopSweeperIfIdle = () => { if (sweeper && !watches.size) { clearInterval(sweeper); sweeper = null; } };

  const roomIdFor = (serverId, channelName) => deriveRoomId(serverId, channelName);

  const findRoom = (serverId, channelName) => {
    for (const room of rooms.values()) if (room.serverId === serverId && room.channelName === channelName) return stateOf(room);
    return null;
  };

  const publish = async (d, content) => {
    if (!auth.isLoggedIn()) throw new Error('Sign in first');
    const signed = await auth.sign({ kind: VOICE_ROOMS_KIND, created_at: replaceableTs(), tags: [['d', d]], content: JSON.stringify(content) });
    relayPool.publish(signed);
    onEvent(signed);
    return signed;
  };

  return {
    async watch(serverId, channelNames) {
      const names = [...new Set(channelNames)].sort();
      const key = names.join('\n');
      const existing = watches.get(serverId);
      if (existing && existing.key === key) return;
      const ids = await Promise.all(names.map((name) => roomIdFor(serverId, name)));
      const current = watches.get(serverId);
      if (current && current.key === key) return;
      if (current) for (const id of current.roomIds) rooms.delete(id);
      const subId = 'voice-rooms-' + String(serverId).slice(0, 40);
      watches.set(serverId, { serverId, key, roomIds: ids, subId });
      ids.forEach((id, i) => rooms.set(id, stateOf({ serverId, channelName: names[i], roomId: id })));
      if (!ids.length) { relayPool.unsubscribe(subId); watches.delete(serverId); stopSweeperIfIdle(); return; }
      const d = ids.flatMap((id) => [PRESENCE_PREFIX + id, dtag('sound', id), dtag('radio', id)]);
      relayPool.subscribe(subId, [{ kinds: [VOICE_ROOMS_KIND], '#d': d, limit: 200 }], onEvent);
      ensureSweeper();
      notify('occupants', { serverId, channelName: null });
    },
    unwatch(serverId) {
      const w = watches.get(serverId);
      if (!w) return;
      relayPool.unsubscribe(w.subId);
      for (const id of w.roomIds) rooms.delete(id);
      watches.delete(serverId);
      stopSweeperIfIdle();
    },
    occupants(serverId, channelName) {
      const room = findRoom(serverId, channelName);
      if (!room) return [];
      return [...room.occupants].filter(([, o]) => fresh(o)).map(([pubkey, o]) => ({ pubkey, name: o.name, muted: o.muted, self: pubkey === auth.pubkey })).sort((a, b) => a.pubkey < b.pubkey ? -1 : 1);
    },
    radioOn(serverId, channelName) {
      const room = findRoom(serverId, channelName);
      if (!room || !room.radio.on) return false;
      return [...room.occupants.values()].some(fresh);
    },
    async playSound(serverId, channelName, soundId) {
      if (now() < lastSoundAt + SOUND_COOLDOWN_MS) return false;
      lastSoundAt = now();
      await publish(dtag('sound', await roomIdFor(serverId, channelName)), { id: soundId });
      return true;
    },
    async setRadio(serverId, channelName, on) {
      await publish(dtag('radio', await roomIdFor(serverId, channelName)), { on: !!on });
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
};

registerProtocol({ id: 'voice-rooms', channelTypes: [], eventKinds: [VOICE_ROOMS_KIND], createVoiceRooms });
