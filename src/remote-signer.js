const STORE_KEY = 'zn_bunker';
const HEX64 = /^[0-9a-f]{64}$/;

const b2hex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
const hex2b = (hex) => { const a = new Uint8Array(hex.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return a; };
const fail = (message) => { throw new Error(message); };

const withTimeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

export class RemoteSigner extends EventTarget {
  constructor({ auth, nostrTools, nip46, storage = null } = {}) {
    super();
    if (!auth || !nostrTools || !nip46) throw new Error('RemoteSigner: auth + nostrTools + nip46 required');
    this.auth = auth; this.NT = nostrTools; this.nip46 = nip46; this.storage = storage;
    this.signer = null; this.pending = null;
    this.auth.addEventListener('logout', () => this._forget());
  }

  _emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  active() { return !!this.signer; }

  describe() {
    const saved = this._saved();
    return saved ? { remote: saved.bp.pubkey, relays: saved.bp.relays } : null;
  }

  _saved() {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(STORE_KEY);
      const v = raw ? JSON.parse(raw) : null;
      return v && HEX64.test(v.pk || '') && /^[0-9a-f]{64}$/.test(v.sk || '') && v.bp && HEX64.test(v.bp.pubkey || '') ? v : null;
    } catch { return null; }
  }

  _shim(signer) {
    return {
      getPublicKey: () => signer.getPublicKey(),
      signEvent: (event) => signer.signEvent(event),
      nip44: { encrypt: (pk, text) => signer.nip44Encrypt(pk, text), decrypt: (pk, payload) => signer.nip44Decrypt(pk, payload) }
    };
  }

  async _adopt(signer, clientSk, bp) {
    const pk = await withTimeout(signer.getPublicKey(), 20000, 'The signer did not return your public key');
    this.signer = signer;
    this.auth.extension = this._shim(signer);
    await this.auth.loginWithExtension();
    if (this.storage) this.storage.setItem(STORE_KEY, JSON.stringify({ sk: b2hex(clientSk), pk, bp: { pubkey: bp.pubkey, relays: bp.relays || [], secret: bp.secret || null } }));
    this._emit('connected', { pubkey: pk });
    return pk;
  }

  async connectBunker(input, { timeoutMs = 45000 } = {}) {
    const text = String(input || '').trim();
    if (!text) fail('Paste a bunker:// address or a NIP-05 name');
    let bp;
    try { bp = await withTimeout(this.nip46.parseBunkerInput(text), 12000, 'Could not look that name up'); } catch (e) { fail(e.message); }
    if (!bp || !bp.relays || !bp.relays.length) fail('That is not a valid bunker address (it needs a signer key and at least one relay)');
    const sk = this.NT.generateSecretKey();
    const signer = this.nip46.BunkerSigner.fromBunker(sk, bp, { onauth: (url) => this._emit('auth', { url }) });
    try { await withTimeout(signer.connect(), timeoutMs, 'The signer did not answer. Check the address and that the signer app is online.'); }
    catch (e) { try { await signer.close(); } catch {} throw e; }
    return this._adopt(signer, sk, signer.bp || bp);
  }

  startQr({ relays, name = 'Zellous', url = '', maxWaitMs = 180000 } = {}) {
    if (!relays || !relays.length) fail('No relay to meet the signer on');
    this.cancelQr();
    const sk = this.NT.generateSecretKey();
    const secret = b2hex(this.NT.generateSecretKey()).slice(0, 32);
    const uri = this.nip46.createNostrConnectURI({ clientPubkey: this.NT.getPublicKey(sk), relays, secret, name, url: url || undefined, perms: ['sign_event', 'nip44_encrypt', 'nip44_decrypt'] });
    const ctl = { cancelled: false };
    const promise = this.nip46.BunkerSigner.fromURI(sk, uri, { onauth: (u) => this._emit('auth', { url: u }) }, maxWaitMs)
      .then(async (signer) => { if (ctl.cancelled) { try { await signer.close(); } catch {} throw new Error('cancelled'); } return this._adopt(signer, sk, signer.bp); });
    this.pending = ctl;
    return { uri, promise };
  }

  cancelQr() { if (this.pending) { this.pending.cancelled = true; this.pending = null; } }

  async restore() {
    const saved = this._saved();
    if (!saved || this.auth.pubkey) return false;
    const sk = hex2b(saved.sk);
    const signer = this.nip46.BunkerSigner.fromBunker(sk, saved.bp, { onauth: (url) => this._emit('auth', { url }) });
    this.signer = signer;
    this.auth.extension = this._shim(signer);
    this.auth.pubkey = saved.pk; this.auth.privkey = null;
    this.auth._emit('login', { pubkey: saved.pk });
    return true;
  }

  async _forget() {
    const s = this.signer; this.signer = null;
    if (this.storage) { try { this.storage.removeItem(STORE_KEY); } catch {} }
    if (s) { try { await s.close(); } catch {} }
  }
}

export const createRemoteSigner = (opts) => new RemoteSigner(opts);
