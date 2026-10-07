# wireweave

> probably emerging 🌀

serverless nostr + webrtc voice + binary-data SDK. the networking layer for 247420 projects.

- **voice** — perfect-negotiation mesh + SFU election (audio, video, recorded segments).
- **data** — peer-to-peer binary `RTCDataChannel` over the same nostr signaling. game frames, structured payloads, anything `Uint8Array`-shaped.

site: https://anentrypoint.github.io/wireweave/  
source: https://github.com/AnEntrypoint/wireweave

```
npm i github:AnEntrypoint/wireweave
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

`ww` exposes: `pool`, `auth`, `fsm`, `message`, `bans`, `roles`, `settings`, `pages`, `media`, `channels`, `servers`, `chat`, `voice` (lazy via `ensureVoice()`), `dm` (lazy via `ensureDM()`), `setCurrentChannel()`, `currentChannelId`, `currentServerId`.

every submodule is an `EventTarget`. subscribe with `addEventListener('event', ...)`.

`message` is a standalone in-memory `MessageBus` (bounded ring + typed handler dispatch). It is provided for apps that want a local message store; no other wireweave module depends on it, so ignore it if you don't need it.

### node / non-browser environments

`createWireweave` and `NostrAuth`/`Servers` need a `storage` adapter outside the browser — pass `{ getItem, setItem, removeItem }`. Without it `createWireweave` throws `wireweave: storage required` up front (in the browser it defaults to `localStorage`). On-relay `d`-tags use a frozen `zellous-` prefix and storage keys use `zn_*`; these are published wire/storage contracts kept stable across the rename to wireweave — do not change them without a migration path.

## direct messages (encrypted)

```js
const dm = ww.ensureDM();
dm.subscribe(({ peer, plaintext }) => console.log(peer, plaintext));
await dm.send(peerPubkey, 'hello');
```

**Caveat:** nip44 encryption derives a conversation key from your **private key**, so DM requires a privkey-backed signer (`generateKey`/`importKey`). It does **not** work with extension signing (NIP-07), which never exposes the privkey — `dm.send` throws `DM: privkey required` in that case.

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

await session.connect('lobby-7');
session.broadcast(new Uint8Array(payload));
session.send(somePeerPubkey, new Uint8Array(p));
```

Options: `dataChannelOptions` (default `{ ordered: true }`), `iceServers` (override the default STUN/TURN list for this session only), and `createPeerConnection` (see below). Construct multiple `DataSession`s in the same page to use distinct rooms / channel configurations.

`setIceServers(list)` / `getIceServers()` (also exported from `wireweave/data` and `wireweave/voice`) override the module-wide default ICE server list for every session created afterward — useful for pointing at your own TURN infrastructure once, instead of passing `iceServers` to each session.

## Node hosts behind NAT: `createPeerConnection`

Both `DataSession` and `VoiceSession` accept a `createPeerConnection(config)` option. It defaults to a plain `new RTCPeerConnection(config)` (browser-shaped, works as-is with any WebRTC-polyfilled `globalThis`) — wireweave itself never imports a Node-specific WebRTC binding. A Node host that is itself likely to sit behind a restrictive NAT (a CLI tool, a headless server) can instead construct its own natively-tuned peer and hand it back:

```js
import * as ndc from 'node-datachannel';
import { RTCPeerConnection as PolyfillRTCPeerConnection } from 'node-datachannel/polyfill';

const session = createDataSession({
  fsm, xstate, relayPool: pool, auth, namespace: 'mygame',
  createPeerConnection: (config) => {
    const nativePc = new ndc.PeerConnection('peer', {
      iceServers: config.iceServers.map(s => s.urls),
      enableIceUdpMux: true,
    });
    return new PolyfillRTCPeerConnection({ peerConnection: nativePc });
  }
});
```

This is opt-in and additive — omit `createPeerConnection` and Node hosts behave exactly as before (a plain polyfilled `RTCPeerConnection`).

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
  onVideoTrack: ({ peerPubkey, stream }) => { attachVideoTrack(peerPubkey, stream); }
});
await voice.connect('general-voice', { displayName: 'you' });
voice.toggleMic();
voice.toggleDeafen();
voice.addEventListener('participants', e => console.log(e.detail.list));
```

Voice carries every empirically-discovered reliability pattern: perfect negotiation (RFC 8840), ICE restart on disconnect, track-stall detection, SFU hub election (mesh→star at 3+ peers), exponential-backoff reconnect.

### voice quality/input settings

`VoiceSession` (and `ensureVoice`) accepts real, constructor-configurable options for input mode, mic sensitivity, echo/noise handling, and Opus quality — every one of them threaded into an actual `getUserMedia`/`RTCRtpSender`/SDP call site, not just stored:

```js
const voice = ww.ensureVoice({
  serverId: 'abc:xyz',
  displayName: 'you',
  pttMode: true,
  micSensitivity: 0.045,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  audioQuality: 'high',
  dtx: true
});
```

- **`pttMode`** (push-to-talk vs. voice-activity/open-mic): `true` (default) starts the session muted; the caller opens the mic via `setMuted(false)`/`requestTransmit()`. `false` starts unmuted — the mic stays live and the speaker-activity detector (RMS threshold) drives the `isSpeaking` UI flag instead of gating transmission. Live-togglable: `voice.setPttMode(false)`.
- **`micSensitivity`** — the RMS level (0–1) above which a stream counts as "speaking" in the speaker-activity poller. Live-togglable: `voice.setMicSensitivity(0.09)`.
- **`noiseSuppression` / `echoCancellation` / `autoGainControl`** — real [`MediaTrackConstraints`](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints) passed straight into the `getUserMedia({ audio: {...} })` call `connect()` makes.
- **`audioQuality`** — an Opus bitrate ladder tier (`low`/`medium`/`high`/`max`, mapping to 16/32/48/64 kbps) applied via the real `RTCRtpSender.setParameters()` call on every connected peer's audio sender. Live-togglable and re-applies immediately to every open connection: `voice.setAudioQuality('low')`.
- **`dtx`** — discontinuous transmission (silence suppression), negotiated per the real WebRTC spec via the Opus `a=fmtp` SDP line (`usedtx=1`), not an `RTCRtpEncodingParameters` field (that isn't where DTX lives in the real spec). Applied at every offer/answer/ICE-restart. Live-togglable: `voice.setDtx(false)` (takes effect on the next SDP exchange for already-open peers).
- **Per-room bandwidth shaping for large rooms** — this module is audio-only (no video sender exists anywhere in it), so real per-layer RTP simulcast (which is video-only in every browser implementation) doesn't apply. The honest, reachable analog is what's already built: SFU hub election (`_sfuElect`/`_sfuRankCandidates`) picks the highest-uplink participant as the hub and fans out audio to everyone via zero-copy `replaceTrack`, so bandwidth concentrates on whoever the room is actually routing through, combined with the per-connection Opus bitrate ladder above.

## node usage (relay + auth only)

```js
import WebSocket from 'ws';
import { RelayPool, NostrAuth } from 'wireweave';
import * as NostrTools from 'nostr-tools';

const pool = new RelayPool({ relays: ['wss://relay.damus.io'], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket });
const auth = new NostrAuth({ nostrTools: NostrTools });
```

## Public page feedback and developer tools

The Wireweave landing page prepares GitHub messages with page context and custom JSON metadata. Visitors review and post through GitHub; developers and existing tools use the repository issue inbox. For automation, use `gh issue list --repo AnEntrypoint/wireweave --json number,title,body,state,url`, then `gh issue view NUMBER --repo AnEntrypoint/wireweave --comments`. Authorized tools can follow up with the normal GitHub issue APIs.


For SDK consumers, feedback is a public, relay-backed inbox per server, with page-scoped threads. Visitors can leave messages without creating an account. Their browser retains a local signing identity so they can follow up. Developers can reply, assign threads and set `open`, `in_progress`, `resolved` or `closed`.

All messages, names, contact details and metadata are public. Include only information intended for publication; avoid secrets and personal diagnostics. Metadata is a bounded JSON object, suitable for category, version, reproduction steps, attachment URLs or an issue reference.

Mount the form on any page:

```js
import { mountFeedbackForm } from 'wireweave/feedback-form';

const feedback = ww.ensureFeedback({ serverId });
const form = mountFeedbackForm({
  container: document.querySelector('#feedback'),
  feedback,
  pageId: 'getting-started',
  storage: localStorage,
  metadata: { category: 'documentation', version: '1.0' }
});
await form.ready;
```

Use the same `serverId` and relay list in the page and developer tools. Its leading public key identifies the inbox owner, as with existing Wireweave servers. The owner, admins and moderators can triage; only the visitor who opened a thread and authorized developers can reply. The form preserves its thread reference across reloads when storage is supplied. Retain the visitor signing key to keep the ability to reply; losing browser storage loses that identity.

```js
import { createFeedbackTools } from 'wireweave/feedback-tools';

const tools = createFeedbackTools({ feedback });
console.log(tools.definitions);
const inbox = await tools.call('feedback_list', { status: 'open', limit: 50 });
const thread = await tools.call('feedback_get', { threadId: inbox[0].id });
await tools.call('feedback_reply', {
  threadId: thread.id,
  message: 'Thanks. Please share the steps to reproduce.',
  metadata: { issue: 'https://github.com/your-org/your-app/issues/123' }
});
await tools.call('feedback_update', {
  threadId: thread.id,
  status: 'in_progress',
  assignee: developerPubkey
});
```

The adapter exports JSON Schema tool definitions and `callTool({ name, arguments })`, returning MCP-shaped text content and `isError` on failure. Register these in your existing tool server. Reads refresh relay history before returning; writes require the actual developer signer. JSON metadata and visitor text remain untrusted data when shown to an agent or rendered in a UI.

For Node tools, import the feedback subpath directly; it does not need xstate or a browser:

```js
import WebSocket from 'ws';
import * as nostrTools from 'nostr-tools';
import { RelayPool } from 'wireweave/relay-pool';
import { NostrAuth } from 'wireweave/auth';
import { Roles } from 'wireweave/roles';
import { createFeedback } from 'wireweave/feedback';

const pool = new RelayPool({ relays, verifyEvent: nostrTools.verifyEvent, WebSocketImpl: WebSocket });
const auth = new NostrAuth({ nostrTools });
auth.importKey(process.env.WIREWEAVE_FEEDBACK_KEY);
const roles = new Roles({ relayPool: pool, auth });
const feedback = createFeedback({ relayPool: pool, auth, roles, serverId });
pool.connect();
try {
  const inbox = await feedback.fetchOnce();
  console.log(JSON.stringify(inbox));
} finally {
  feedback.unsubscribe();
  roles.unsubscribe(serverId);
  pool.disconnect();
}
```

For read-only access, omit `auth` and `roles`. `fetchOnce()` waits for feedback and role history from an available relay and rejects on timeout. Set `requireAllRelays: true` to require all queried relays. `historyStatus` reports queried and completed relays and `completeAcrossRelays`; tool envelopes include this scope in `structuredContent.history`. `subscribe({ pageId })` returns a cleanup function and emits `feedback` events for live threads. `list({ pageId, status, assignee, limit })` and `get(threadId)` return snapshots. Writes resolve only after a relay accepts the signed event; a timeout means delivery is unconfirmed, so inspect the inbox before retrying. If publication succeeds but history refresh fails, tools return `FEEDBACK_ACCEPTED_HISTORY_UNAVAILABLE` with `accepted: true`, `eventId` and `threadId`; retain that reference rather than submitting again. Relay retention determines how long history remains available. Each cached history scope retains at most 2,000 events by default (`maxEvents`, configurable up to 10,000 through `createFeedback` or `ensureFeedback`). At most eight server, page or thread scopes are retained. Overflow raises `FEEDBACK_HISTORY_INCOMPLETE` so tools cannot mistake partial history for a complete result. A fresh page or `fetchOnce({ threadId })` read recovers a narrower scope; developer tools load only the selected thread for follow-up. Pass `signal` to cancel a pending history read.

The command-line adapter accepts a JSON tool call on stdin:

```sh
printf '%s' '{"name":"feedback_list","arguments":{"status":"open"}}' | WIREWEAVE_FEEDBACK_SERVER='OWNER_PUBLIC_KEY:server' wireweave-feedback
```

Set `WIREWEAVE_FEEDBACK_RELAYS` to a JSON array of relay URLs, and `WIREWEAVE_FEEDBACK_KEY` only for writes. The package includes `ws`; install the `nostr-tools` peer dependency in the consuming Node project. The CLI returns one JSON MCP result and a nonzero exit code for errors.

## test

```
npm test
```

hits `wss://relay.damus.io` for a real publish → subscribe round-trip.

## license

MIT © AnEntrypoint — read the source.
