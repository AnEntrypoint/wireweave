# wireweave

> probably emerging 🌀

serverless nostr + webrtc voice + binary-data SDK. the networking layer for 247420 projects.

- **voice** — perfect-negotiation mesh + SFU election (audio, video, recorded segments).
- **data** — peer-to-peer binary `RTCDataChannel` over the same nostr signaling. game frames, structured payloads, anything `Uint8Array`-shaped.

site: https://anentrypoint.github.io/wireweave/  
npm: https://www.npmjs.com/package/wireweave

```
npm i wireweave
```

## one-liner setup

```js
import { createWireweave } from 'wireweave';
import * as NostrTools from 'nostr-tools';
import * as XState from 'xstate';

const ww = createWireweave({ nostrTools: NostrTools, xstate: XState });
ww.pool.connect();
ww.auth.loadFromStorage() || ww.auth.generateKey();
ww.servers.init();
```

`ww` exposes: `pool`, `auth`, `fsm`, `message`, `bans`, `roles`, `settings`, `pages`, `media`, `channels`, `servers`, `chat`, `voice` (lazy via `ensureVoice()`), `setCurrentChannel()`.

every submodule is an `EventTarget`. subscribe with `addEventListener('event', ...)`.

## modules

```js
import {
  RelayPool, NostrAuth, VoiceSession, DataSession, Chat, Channels, Servers,
  Bans, Roles, Settings, Media, Pages, MessageBus, createFSM
} from 'wireweave';
```

each also exported via subpath: `wireweave/relay-pool`, `wireweave/voice`, `wireweave/data`, `wireweave/chat`, etc.

## data sessions (binary p2p)

`DataSession` mirrors `VoiceSession`'s perfect-negotiation peer setup but carries **only** an ordered binary `RTCDataChannel` — no media, no mic prompt, no SFU. Use it for game state, file sync, anything `ArrayBuffer`-friendly.

```js
import { createDataSession, createFSM, NostrAuth, RelayPool } from 'wireweave';
import * as NostrTools from 'nostr-tools';
import * as xstate from 'xstate';

const fsm = createFSM(xstate);
const auth = new NostrAuth({ nostrTools: NostrTools });
auth.loadFromStorage() || auth.generateKey();
const pool = new RelayPool({ verifyEvent: NostrTools.verifyEvent });
pool.connect();

const session = createDataSession({ fsm, xstate, relayPool: pool, auth, namespace: 'mygame' });
session.addEventListener('peer-open',  (e) => console.log('peer up', e.detail.peerPubkey));
session.addEventListener('data',       (e) => handleFrame(e.detail.peerPubkey, e.detail.data));
session.addEventListener('peer-close', (e) => console.log('peer down', e.detail.peerPubkey));

await session.connect('lobby-7'); // any room name; URL-hash works fine
session.broadcast(new Uint8Array(payload));     // → all open peers
session.send(somePeerPubkey, new Uint8Array(p)); // → one peer
```

Options: `dataChannelOptions` (default `{ ordered: true }`) and `iceServers` (override the default STUN/TURN list). Construct multiple `DataSession`s in the same page to use distinct rooms / channel configurations.

## game / 3-mode usage pattern

For projects (e.g. multiplayer games) that need three transport flavours:

| mode | wireweave usage |
|---|---|
| singleplayer (in-page) | `VoiceSession` keyed by `location.hash` so people on the same URL voice-chat; game state stays in a Worker |
| webrtc host & join     | `DataSession` for game frames, `VoiceSession` for voice — both signaled through the same nostr relays |
| self-hosted server     | server runs its own transport for state; `DataSession` adds player↔player p2p (voice + side-channel data) over nostr |

`namespace` partitions rooms across deployments (e.g. `'spoint-prod'` vs `'spoint-dev'`).

## voice (webrtc mesh + sfu hub election)

```js
const voice = ww.ensureVoice({
  serverId: 'abc:xyz',
  displayName: 'you',
  onAudioTrack: ({ peer, stream }) => {
    const a = new Audio();
    a.srcObject = stream;
    a.autoplay = true;
    document.body.appendChild(a);
    peer.audioEl = a;
  },
  onVideoTrack: ({ peerPubkey, stream }) => { /* attach to <video> */ }
});
await voice.connect('general-voice', { displayName: 'you' });
voice.toggleMic();
voice.toggleDeafen();
voice.addEventListener('participants', e => console.log(e.detail.list));
```

Voice carries every empirically-discovered reliability pattern: perfect negotiation (RFC 8840), ICE restart on disconnect, track-stall detection, SFU hub election (mesh→star at 3+ peers), exponential-backoff reconnect.

## node usage (relay + auth only)

```js
import WebSocket from 'ws';
import { RelayPool, NostrAuth } from 'wireweave';
import * as NostrTools from 'nostr-tools';

const pool = new RelayPool({ relays: ['wss://relay.damus.io'], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket });
const auth = new NostrAuth({ nostrTools: NostrTools });
```

## test

```
npm test
```

hits `wss://relay.damus.io` for a real publish → subscribe round-trip.

## license

MIT © AnEntrypoint — read the source.
