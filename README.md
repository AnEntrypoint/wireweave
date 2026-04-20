# wireweave

> probably emerging 🌀

serverless nostr + webrtc voice SDK. the networking layer for 247420 projects.

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
  RelayPool, NostrAuth, VoiceSession, Chat, Channels, Servers,
  Bans, Roles, Settings, Media, Pages, MessageBus, createFSM
} from 'wireweave';
```

each also exported via subpath: `wireweave/relay-pool`, `wireweave/voice`, `wireweave/chat`, etc.

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
