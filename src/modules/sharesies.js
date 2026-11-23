import { registerProtocol } from './registry.js';
import { createDataSession } from '../data.js';

export const SHARESIES_NAMESPACE = 'sharesies';
export const SHARESIES_RUN_COMMAND = 'npx github:AnEntrypoint/sharesies';
export const SHARESIES_WEB_BASE = 'https://anentrypoint.github.io/sharesies/';
export const SHARESIES_HOST_NAME = 'host';
export const SHARESIES_GUEST_NAME = 'guest';
export const SHARESIES_SEED_BYTES = 32;
export const SHARESIES_RECONNECT_WINDOW_MS = 30000;

export const FRAME = Object.freeze({ STDIN: 0, STDOUT: 1, STDERR: 2, EXIT: 3, RESIZE: 4 });

const SEED_PATTERN = /^[0-9a-fA-F]{16,}$/;
const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const isSeed = (value) => typeof value === 'string' && SEED_PATTERN.test(value);

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const defaultHashHex = async (text) => toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text))));

export const deriveRoom = async (seed, hashHex = defaultHashHex) => {
  if (!isSeed(seed)) throw new Error('sharesies seed must be at least 16 hexadecimal characters');
  const digest = await hashHex('sharesies:' + seed);
  return String(digest).slice(0, 32);
};

export const generateSeed = (randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) => toHex(randomBytes(SHARESIES_SEED_BYTES));

export const inviteUrl = (seed, base = SHARESIES_WEB_BASE) => {
  if (!isSeed(seed)) throw new Error('sharesies seed must be at least 16 hexadecimal characters');
  return base + '#' + seed;
};

const quoteWord = (word) => SAFE_SHELL_WORD.test(word) ? word : "'" + word.replace(/'/g, "'\\''") + "'";

const appWords = (app) => {
  const words = Array.isArray(app) ? app.map(String) : String(app || '').split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('sharesies host command needs an app to share');
  return words;
};

export const hostCommand = ({ seed, app, web = true, runCommand = SHARESIES_RUN_COMMAND } = {}) => {
  if (!isSeed(seed)) throw new Error('sharesies seed must be at least 16 hexadecimal characters');
  const parts = [runCommand];
  if (web) parts.push('--web');
  parts.push('--key', seed, ...appWords(app).map(quoteWord));
  return parts.join(' ');
};

export const connectCommand = ({ seed, runCommand = SHARESIES_RUN_COMMAND } = {}) => {
  if (!isSeed(seed)) throw new Error('sharesies seed must be at least 16 hexadecimal characters');
  return runCommand + ' --connect ' + seed;
};

export const createHostInvite = ({ app, randomBytes, hashHex, web = true, webBase, runCommand } = {}) => {
  const seed = generateSeed(randomBytes);
  return {
    seed,
    command: hostCommand({ seed, app, web, runCommand }),
    url: inviteUrl(seed, webBase),
    connect: connectCommand({ seed, runCommand }),
    room: deriveRoom(seed, hashHex)
  };
};

const tokenize = (line) => {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(line))) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
};

const seedFromUrl = (text) => {
  let url;
  try { url = new URL(text); } catch { return null; }
  const hash = url.hash.replace(/^#/, '');
  const candidate = hash ? decodeURIComponent(hash) : (url.searchParams.get('key') || url.searchParams.get('seed') || '');
  return isSeed(candidate) ? candidate : null;
};

const seedFromCommand = (text) => {
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length - 1; i++) {
    if ((tokens[i] === '--key' || tokens[i] === '--connect') && isSeed(tokens[i + 1])) return tokens[i + 1];
  }
  return tokens.length > 1 ? tokens.slice(1).find(isSeed) || null : null;
};

export const parseInvite = (input) => {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (isSeed(text)) return { seed: text, source: 'seed' };
  const fromUrl = /^https?:\/\//i.test(text) ? seedFromUrl(text) : null;
  if (fromUrl) return { seed: fromUrl, source: 'url' };
  const fromCommand = seedFromCommand(text);
  return fromCommand ? { seed: fromCommand, source: 'command' } : null;
};

export const encodeFrame = (type, payload) => {
  if (type === FRAME.EXIT) {
    const buf = new Uint8Array(5);
    buf[0] = type;
    new DataView(buf.buffer).setUint32(1, payload >>> 0, false);
    return buf;
  }
  if (type === FRAME.RESIZE) {
    const buf = new Uint8Array(9);
    buf[0] = type;
    const view = new DataView(buf.buffer);
    view.setUint32(1, payload.width >>> 0, false);
    view.setUint32(5, payload.height >>> 0, false);
    return buf;
  }
  const bytes = payload instanceof Uint8Array ? payload : encoder.encode(String(payload));
  const buf = new Uint8Array(1 + bytes.length);
  buf[0] = type;
  buf.set(bytes, 1);
  return buf;
};

export const decodeFrame = (data) => {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
  if (!bytes.length) return null;
  const type = bytes[0];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === FRAME.EXIT) return bytes.length >= 5 ? { type, payload: view.getUint32(1, false) } : null;
  if (type === FRAME.RESIZE) return bytes.length >= 9 ? { type, payload: { width: view.getUint32(1, false), height: view.getUint32(5, false) } } : null;
  return { type, payload: bytes.subarray(1) };
};

export const decodeText = (payload) => decoder.decode(payload);

export const SESSION_STATE = Object.freeze({
  IDLE: 'idle',
  JOINING: 'joining',
  WAITING: 'waiting-host',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ENDED: 'ended',
  LEFT: 'left'
});

export class SharesiesSession extends EventTarget {
  constructor({ dataSession, fsm, xstate, relayPool, auth, hashHex, namespace = SHARESIES_NAMESPACE, createPeerConnection, displayName = SHARESIES_GUEST_NAME, reconnectWindowMs = SHARESIES_RECONNECT_WINDOW_MS } = {}) {
    super();
    const deps = createPeerConnection ? { createPeerConnection } : {};
    this.data = dataSession || createDataSession({ fsm, xstate, relayPool, auth, namespace, ...deps });
    this.hashHex = hashHex;
    this.displayName = displayName;
    this.reconnectWindowMs = reconnectWindowMs;
    this.state = SESSION_STATE.IDLE;
    this.hostPubkey = null;
    this.size = null;
    this.exitCode = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.listeners = [];
  }

  async join(seedOrInvite) {
    if (this.state !== SESSION_STATE.IDLE && this.state !== SESSION_STATE.LEFT && this.state !== SESSION_STATE.ENDED) throw new Error('sharesies session already joined');
    const invite = parseInvite(seedOrInvite);
    if (!invite) throw new Error('not a valid sharesies seed or invite');
    this.seed = invite.seed;
    this.exitCode = null;
    this.hostPubkey = null;
    this.reconnectAttempts = 0;
    this.room = await deriveRoom(invite.seed, this.hashHex);
    this._setState(SESSION_STATE.JOINING);
    this._attach();
    try {
      await this.data.connect(this.room, { displayName: this.displayName });
    } catch (error) {
      this._detach();
      this._setState(SESSION_STATE.IDLE);
      throw error;
    }
    if (this.state === SESSION_STATE.JOINING) this._setState(SESSION_STATE.WAITING);
    return this.room;
  }

  get participants() {
    return this.data.getParticipants().map((p) => ({ ...p, isHost: p.identity === SHARESIES_HOST_NAME }));
  }

  get connected() { return this.state === SESSION_STATE.CONNECTED; }

  stdin(input) {
    if (!this.connected) return false;
    return this.data.send(this.hostPubkey, encodeFrame(FRAME.STDIN, input));
  }

  resize(cols, rows) {
    const width = Math.max(1, Math.floor(cols));
    const height = Math.max(1, Math.floor(rows));
    this.size = { width, height };
    if (!this.connected) return false;
    return this.data.send(this.hostPubkey, encodeFrame(FRAME.RESIZE, this.size));
  }

  async leave() {
    this._clearReconnect();
    this._detach();
    const wasActive = this.state !== SESSION_STATE.IDLE && this.state !== SESSION_STATE.LEFT;
    this.hostPubkey = null;
    this._setState(SESSION_STATE.LEFT);
    await this.data.disconnect();
    if (wasActive) this._emit('disconnected', { reason: 'left', exitCode: this.exitCode });
  }

  _on(target, type, handler) {
    target.addEventListener(type, handler);
    this.listeners.push(() => target.removeEventListener(type, handler));
  }

  _attach() {
    this._detach();
    this._on(this.data, 'peer-open', (e) => this._onPeerOpen(e.detail));
    this._on(this.data, 'peer-close', (e) => this._onPeerClose(e.detail));
    this._on(this.data, 'data', (e) => this._onData(e.detail));
    this._on(this.data, 'participants', (e) => this._emit('participants', { list: this.participants }));
    this._on(this.data, 'error', (e) => this._emit('error', e.detail));
  }

  _detach() {
    for (const off of this.listeners) off();
    this.listeners = [];
  }

  _isHost(pubkey) {
    return this.data.participants.get('nostr-' + pubkey.slice(0, 12))?.identity === SHARESIES_HOST_NAME;
  }

  _onPeerOpen({ peerPubkey, unreliable }) {
    if (unreliable || !this._isHost(peerPubkey)) return;
    this.hostPubkey = peerPubkey;
    this._clearReconnect();
    const resumed = this.reconnectAttempts > 0;
    this.reconnectAttempts = 0;
    this._setState(SESSION_STATE.CONNECTED);
    if (this.size) this.data.send(peerPubkey, encodeFrame(FRAME.RESIZE, this.size));
    this._emit('connected', { host: peerPubkey, resumed });
  }

  _onPeerClose({ peerPubkey, unreliable }) {
    if (unreliable || peerPubkey !== this.hostPubkey) return;
    this.hostPubkey = null;
    if (this.state === SESSION_STATE.ENDED) {
      this._emit('disconnected', { reason: 'exit', exitCode: this.exitCode });
      return;
    }
    this._setState(SESSION_STATE.RECONNECTING);
    this._armReconnect();
  }

  _armReconnect() {
    this.reconnectAttempts += 1;
    this._emit('reconnecting', { attempt: this.reconnectAttempts, windowMs: this.reconnectWindowMs });
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state !== SESSION_STATE.RECONNECTING) return;
      this._setState(SESSION_STATE.LEFT);
      this._emit('disconnected', { reason: 'host-lost', exitCode: this.exitCode });
    }, this.reconnectWindowMs);
  }

  _clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  _onData({ peerPubkey, data, unreliable }) {
    if (unreliable || peerPubkey !== this.hostPubkey) return;
    const frame = decodeFrame(data);
    if (!frame) return;
    if (frame.type === FRAME.STDOUT) this._emit('stdout', { data: frame.payload });
    else if (frame.type === FRAME.STDERR) this._emit('stderr', { data: frame.payload });
    else if (frame.type === FRAME.RESIZE) this._emit('resize', frame.payload);
    else if (frame.type === FRAME.EXIT) {
      this.exitCode = frame.payload;
      this._clearReconnect();
      this._setState(SESSION_STATE.ENDED);
      this._emit('exit', { code: frame.payload });
    }
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._emit('state', { state });
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

export const createSharesiesSession = (opts) => new SharesiesSession(opts);

registerProtocol({
  id: 'sharesies',
  channelTypes: [],
  eventKinds: [],
  namespace: SHARESIES_NAMESPACE,
  isSeed,
  parseInvite,
  deriveRoom,
  generateSeed,
  hostCommand,
  createHostInvite,
  createSession: createSharesiesSession
});
