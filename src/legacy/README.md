# legacy/

browser-globals port of the full zellous networking + voice stack. these files are the original scripts copied verbatim from `zellous/docs/js/`. they assign to `window.*` (`window.nostrNet`, `window.nostrVoice`, `window.auth`, etc.) and expect co-resident globals (`state`, `XState`, `NostrTools`, `ui`, `auth`, `message`).

this is the honest "move everything" checkpoint. the SDK-shaped ES-module exports in `../` are the forward path — `relay-pool.js` + `auth.js` today, voice / chat / channels / servers to follow.

## load order

scripts must load in this order (same order zellous uses):

```
nostr-state-patch.js
nostr-fsm.js
nostr-network.js
nostr-auth.js
nostr-message.js
nostr-bans.js
nostr-roles.js
nostr-settings.js
nostr-voice.js
nostr-voice-rtc.js
nostr-voice-sfu.js
nostr-voice-camera.js
nostr-chat.js
nostr-channels.js
nostr-servers.js
nostr-media.js
nostr-pages.js
```

## prerequisites already on window

- `window.state`, `window.stateSignals`, `window.config` (zellous/state.js or equivalent)
- `window.XState` — `{ createMachine, createActor }` from xstate v5
- `window.NostrTools` — `nostr-tools` (generateSecretKey, getPublicKey, nip19, finalizeEvent, verifyEvent)
- preact signals for reactive state
- `window.ui` bindings (optional for headless)

## files

| file | bytes | assigns |
|---|---|---|
| nostr-state-patch.js | 507 | state signal patches |
| nostr-fsm.js | 1018 | `voiceMachine`, `peerMachine` |
| nostr-network.js | 7595 | `nostrNet` relay pool |
| nostr-auth.js | 8501 | `auth` key mgmt |
| nostr-message.js | 529 | `message` system msg dispatch |
| nostr-bans.js | 2422 | `nostrBans` moderation |
| nostr-roles.js | 3077 | `serverRoles` |
| nostr-settings.js | 4231 | `serverSettings` encoder config |
| nostr-voice.js | 13458 | `nostrVoice` session |
| nostr-voice-rtc.js | 11636 | `nostrVoiceRtc` perfect-negotiation |
| nostr-voice-sfu.js | 4773 | `nostrVoiceSfu` hub election |
| nostr-voice-camera.js | 2355 | `nostrVoiceCamera` |
| nostr-chat.js | 6513 | `chat` kind-28 messaging |
| nostr-channels.js | 5369 | `channelManager` |
| nostr-servers.js | 10718 | `serverManager` communities |
| nostr-media.js | 3524 | `nostrMedia` blossom uploads |
| nostr-pages.js | 7909 | `serverPages` |

## CDN load (via jsDelivr)

```html
<script src="https://cdn.jsdelivr.net/npm/magicwand@latest/src/legacy/nostr-fsm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/magicwand@latest/src/legacy/nostr-network.js"></script>
<!-- etc in order above -->
```

## status

probably emerging 🌀
