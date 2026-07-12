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

## RelayPool reconnect lifecycle must not resurrect after disconnect

`RelayPool` tracks a `_closed` flag and a `_reconnectTimers` Map. `disconnect()`
sets `_closed = true` and clears every tracked reconnect timer; `_open()` and the
`onclose` handler early-return when `_closed`. This is load-bearing: `onclose`
schedules `setTimeout(_open, ...)`, so without the flag a teardown leaves an
in-flight timer that resurrects the relay. `connect()` resets `_closed = false`
(`heal()` only re-opens dead sockets and is a no-op while `_closed`). Reconnect
backoff is jittered +-25% via `jitter(ms)` to avoid lockstep thundering-herd
reconnects. The offline publish queue (`this.pending`) stores `{event, ts}`,
caps at `PENDING_MAX` (500, drop-oldest), and drops entries older than
`PENDING_TTL_MS` (120s) on drain — never let it grow unbounded or replay stale
events. Covered by `testRelayReconnectCancel` + `testRelayPendingCapTtl` (fake-WS).

## RelayPool publish-ack and pending dedupe

`publish(event)` is still fire-and-forget (returns a `sent` boolean). For
delivery confidence use `publishAndWait(event, { timeoutMs = 8000 })`: it sends
then resolves `true` on the first relay `OK <id> true`, `false` on a relay
reject (`OK <id> false`), and `false` on timeout. It keys pending ack records
by `event.id` in `this._acks` (a `{resolve, timer}` Map); `_settleAck` resolves
and `disconnect()` flushes every outstanding ack to `false` so no promise hangs.
The `_handle` OK branch now emits both an `ok` and a `reject` event (previously
only `reject`) and settles the ack. An event with no `id` cannot be acked, so
`publishAndWait` falls back to resolving the `sent` boolean.

The offline queue is deduped by `event.id` via `this._pendingIds` (a Set kept in
lockstep with `this.pending`): `_queuePending` skips an id already queued, the
cap-drop path removes the dropped id from the Set, and `_drainPending` clears the
Set before re-publishing. This prevents a reconnect drain from double-publishing
the same event. Covered by `testRelayPendingDedupe` + `testRelayPublishAck`
(fake-WS, offline).

## CI

`.github/workflows/ci.yml` runs `node --check src/*.js` then installs `ws` +
`nostr-tools` (`--no-save`) and runs `node test.js` on every push/PR. The
real-relay phases tolerate single-relay flake via the multi-relay `RELAYS`
array; `compose`/`data` tests skip when `xstate` is absent (not installed in
CI) — that is expected, not a failure.

## test.js size cap

The single integration witness (`test.js`) grows as coverage expands. The previous <=200 line cap is superseded: the file may grow freely as long as it remains a single file at repo root, mock-free for network tests, and real-services only for the relay round-trip. Current size: ~620 lines (26 tests). Do not split into a `test/` directory.

@.gm/next-step.md
