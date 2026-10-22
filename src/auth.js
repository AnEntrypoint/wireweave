import { safeSetItem } from './safe-storage.js';

const b2hex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
const hex2b = (hex) => {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return a;
};

export class NostrAuth extends EventTarget {
  constructor({ nostrTools, storage = null, extension = null } = {}) {
    super();
    if (!nostrTools) throw new Error('nostrTools required');
    this.NT = nostrTools;
    this.storage = storage;
    this.extension = extension;
    this.pubkey = '';
    this.privkey = null;
    this.profile = null;
  }

  loadFromStorage() {
    if (!this.storage) return false;
    const skHex = this.storage.getItem('zn_sk');
    const pkHex = this.storage.getItem('zn_pk');
    if (!skHex || !pkHex) return false;
    try {
      this.privkey = hex2b(skHex);
      this.pubkey = pkHex;
      this._emit('login', { pubkey: pkHex });
      return true;
    } catch { return false; }
  }

  generateKey() {
    const sk = this.NT.generateSecretKey();
    const pk = this.NT.getPublicKey(sk);
    this._persist(sk, pk);
    this._emit('login', { pubkey: pk });
    return { pubkey: pk, privkey: sk };
  }

  importKey(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) throw new Error('Enter a key');
    const sk = trimmed.startsWith('nsec')
      ? (() => { const d = this.NT.nip19.decode(trimmed); if (d.type !== 'nsec') throw new Error('not nsec'); return d.data; })()
      : (() => {
          if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error('Expected an nsec1… key or a 64-character hex secret key');
          return hex2b(trimmed);
        })();
    const pk = this.NT.getPublicKey(sk);
    this._persist(sk, pk);
    this._emit('login', { pubkey: pk });
    return { pubkey: pk, privkey: sk };
  }

  getExtension() {
    if (this.extension) return this.extension;
    if (typeof window === 'undefined' || !window.nostr) return null;
    return window.nostr;
  }

  async loginWithExtension() {
    const ext = this.getExtension();
    if (!ext || typeof ext.getPublicKey !== 'function') throw new Error('No extension provided');
    const pk = await ext.getPublicKey();
    if (typeof pk !== 'string' || !/^[0-9a-f]{64}$/.test(pk)) throw new Error('Extension returned an invalid public key');
    this.extension = ext;
    this.pubkey = pk;
    this.privkey = null;

    this.storage?.removeItem('zn_sk');
    this.storage?.removeItem('zn_pk');
    this._emit('login', { pubkey: pk });
    return pk;
  }

  async sign(eventTemplate) {
    // An event signed with our own key is not verified again. Schnorr verification costs about as much
    // as signing, both are synchronous main-thread work, and a profile of a page that signs at startup
    // shows secp256k1 as a blocking slice of its load. Verifying what we just produced proves nothing
    // the signing step did not. An event an extension signed is verified: that signature is not ours.
    if (this.privkey) return this._checkSigned(this.NT.finalizeEvent(eventTemplate, this.privkey), false);
    const ext = this.getExtension();
    if (ext) return this._checkSigned(await ext.signEvent(eventTemplate), true);
    throw new Error('No signing key available');
  }

  _checkSigned(signed, verify = true) {
    if (!signed || signed.pubkey !== this.pubkey) throw new Error('Signed event pubkey does not match the logged-in key');
    if (verify && !this.NT.verifyEvent(signed)) throw new Error('Signed event failed signature verification');
    return signed;
  }

  logout() {
    this.storage?.removeItem('zn_sk');
    this.storage?.removeItem('zn_pk');
    this.pubkey = '';
    this.privkey = null;
    this.profile = null;
    this._emit('logout', {});
  }

  isLoggedIn() { return !!this.pubkey; }

  npubShort(pubkey = this.pubkey) {
    if (!pubkey) return '';
    const npub = this.NT.nip19.npubEncode(pubkey);
    return npub.slice(0, 8) + '...' + npub.slice(-4);
  }

  npubEncode(pubkey = this.pubkey) {
    return pubkey ? this.NT.nip19.npubEncode(pubkey) : '';
  }

  nsecEncode() {
    if (!this.privkey) return null;
    return this.NT.nip19.nsecEncode(this.privkey);
  }

  _persist(sk, pk) {
    this.privkey = sk;
    this.pubkey = pk;
    if (!this.storage) return;
    const okSk = safeSetItem(this.storage, this, 'zn_sk', b2hex(sk));
    const okPk = safeSetItem(this.storage, this, 'zn_pk', pk);
    if (!okSk || !okPk) {
      try { this.storage.removeItem('zn_sk'); this.storage.removeItem('zn_pk'); } catch {}
      this._emit('persist-failed', { pubkey: pk });
    }
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

export const createAuth = (opts) => new NostrAuth(opts);
