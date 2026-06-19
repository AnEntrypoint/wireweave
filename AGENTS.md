# AGENTS.md

Non-obvious caveats for agents working in this repo.

## createWireweave requires explicit storage in non-browser envs

`createWireweave({ storage })` MUST receive a storage instance in Node/test
environments. If storage is missing, the failure surfaces deep in the Servers
constructor as a cryptic `Servers: deps required` error, not at the
createWireweave call site. An upfront guard in `src/wireweave.js` now throws
`wireweave: storage required ...` early — keep it there.

## Tests must use multiple relays, not a single hardcoded one

`test.js` uses a `RELAYS` array (damus + nos.lol + primal + nostr.band) so
`RelayPool`'s multi-relay fallback masks the inevitable flake of any one public
relay. Do not collapse this back to a single `wss://relay.damus.io` — the
auth/data/dm/round-trip phases will go red intermittently.

## ws close on CONNECTING socket emits post-close error

Calling `ws.close()` while readyState is CONNECTING (0) makes the Node `ws`
package emit an EventEmitter `'error'` event AFTER close with message
"WebSocket was closed before the connection was established". Unhandled, this
crashes the process. DOM-style handlers (`ws.onerror = null` etc.) are a
separate channel and do NOT remove EventEmitter listeners. Before closing a
connecting socket: clear DOM handlers, call `ws.removeAllListeners()`, then
attach a noop `ws.on('error', () => {})` to absorb the trailing error. See
`src/relay-pool.js` disconnect() (commit 18d45b2). Only reproduces with a
multi-relay pool where some sockets are still connecting at disconnect time.

## test.js size cap

The single integration witness (`test.js`) grows as coverage expands. The previous <=200 line cap is superseded: the file may grow freely as long as it remains a single file at repo root, mock-free for network tests, and real-services only for the relay round-trip. Current size: ~441 lines (19 tests). Do not split into a `test/` directory.

## Learning audit

- 2026-04-30: checked 2 items, removed 0, refined 2 (storage-required, multi-relay-tests — recall missed, ingested refined versions).
- 2026-04-30: checked 3 items (storage-required, multi-relay-tests, ws-close-CONNECTING), removed 0, refined 3 — all three have no recall hits, kept in AGENTS.md, ingested refined versions to rs-learn.
- 2026-06-19: added test.js size-cap section; cap lifted from <=200 to uncapped single-file.

@.gm/next-step.md
