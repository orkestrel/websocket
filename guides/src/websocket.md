# WebSocket

> The server-native bidirectional transport: a lean, typed wrapper over a raw upgraded [`node:stream`](https://nodejs.org/api/stream.html) Duplex socket that speaks **only** the [RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455) WebSocket wire protocol — zero npm dependencies (`node:crypto` for the one handshake hash, nothing else). Once an HTTP server hands you an upgraded socket, this wrapper turns that raw byte stream into a typed, observable connection: it owns the upgrade handshake, the masked/unmasked frame codec, ping/pong, and the close handshake, and surfaces messages through a §13 `emitter`.
>
> What it deliberately is **not**: it has no knowledge of MCP, JSON-RPC, reconnection, heartbeats, or any message schema. Those belong to a _message_ transport built one layer up — this is only the wire. The whole bit-level codec is three pure, exported functions — `computeWebSocketAccept` / `parseWebSocketFrame` / `encodeWebSocketFrame` — pinned against RFC 6455's own worked byte vectors; the [`NodeWebSocket`](#nodewebsocketinterface) class is the thin stateful driver that runs them over a socket. Keeping the codec pure and the wrapper minimal is the same lean-native-wrapper discipline as the [SQLite](sqlite.md) and [IndexedDB](indexeddb.md) wrappers: a small typed surface over native power, the hard parts exported as testable units. Source: [`src/server/websocket`](../../src/server/websocket). Surfaced through the `@src/server` barrel.

## Surface

```ts
import { createServer } from 'node:http'
import { createNodeWebSocket } from '@src/server'

// A node:http server hands every upgrade request a raw socket; this wrapper takes it
// from there. Passing the client's `sec-websocket-key` selects SERVER mode — the
// wrapper writes the 101 handshake, marks the connection open, and decodes frames.
createServer().on('upgrade', (request, socket, head) => {
	const ws = createNodeWebSocket({
		socket,
		key: request.headers['sec-websocket-key'], // present => server mode + 101 handshake
		head, // any bytes that arrived bundled with the upgrade request
		on: { message: (text) => ws.send(`echo: ${text}`) }, // wire listeners at construction (§8)
	})

	ws.emitter.on('close', (code, reason) => console.log('closed', code, reason))
})
```

`send` writes a UTF-8 text frame (unmasked, because this is the server); the peer's reply arrives back as a `message`. Everything is driven off the one `emitter` — there are no callbacks to register beyond it.

### Factories

| API                   | Kind     | Summary                                                                                                                          |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `createNodeWebSocket` | function | Create a server-native WebSocket over a raw upgraded `node:stream` Duplex (server mode when a `key` is given, else client mode). |

### Entities

| API             | Kind  | Summary                                                                                                                |
| --------------- | ----- | ---------------------------------------------------------------------------------------------------------------------- |
| `NodeWebSocket` | class | The WebSocket — the handshake, frame dispatch (text + continuation reassembly), auto-pong, close, and a §13 `emitter`. |

### Codec helpers

| API                      | Kind     | Summary                                                                                                        |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| `computeWebSocketAccept` | function | Derive the `Sec-WebSocket-Accept` token (base64 SHA-1 of the key + `WEBSOCKET_GUID`).                          |
| `parseWebSocketFrame`    | function | Decode one frame off a buffer; `undefined` when the buffer is incomplete (so the caller accumulates).          |
| `encodeWebSocketFrame`   | function | Encode one frame to wire bytes (the inverse of `parseWebSocketFrame`); unmasked by default, optionally masked. |

### Constants

| API                          | Kind  | Summary                                                                |
| ---------------------------- | ----- | ---------------------------------------------------------------------- |
| `WEBSOCKET_GUID`             | const | The RFC 6455 §1.3 accept GUID concatenated to the key before the hash. |
| `WEBSOCKET_VERSION`          | const | The supported protocol version (`'13'`).                               |
| `WEBSOCKET_OPCODE_TEXT`      | const | Text frame opcode (`0x01`).                                            |
| `WEBSOCKET_OPCODE_BINARY`    | const | Binary frame opcode (`0x02`).                                          |
| `WEBSOCKET_OPCODE_CLOSE`     | const | Close frame opcode (`0x08`).                                           |
| `WEBSOCKET_OPCODE_PING`      | const | Ping frame opcode (`0x09`).                                            |
| `WEBSOCKET_OPCODE_PONG`      | const | Pong frame opcode (`0x0a`).                                            |
| `WEBSOCKET_READY_CONNECTING` | const | Ready state `0` (connecting).                                          |
| `WEBSOCKET_READY_OPEN`       | const | Ready state `1` (open).                                                |
| `WEBSOCKET_READY_CLOSING`    | const | Ready state `2` (closing).                                             |
| `WEBSOCKET_READY_CLOSED`     | const | Ready state `3` (closed).                                              |
| `WEBSOCKET_CLOSE_NORMAL`     | const | The normal-closure status code (`1000`) — the default `close` code.    |

### Types

| API                      | Kind      | Summary                                                                                      |
| ------------------------ | --------- | -------------------------------------------------------------------------------------------- |
| `WebSocketReadyState`    | type      | The four browser-compatible ready-state values (`0` \| `1` \| `2` \| `3`).                   |
| `WebSocketCloseCode`     | type      | A WebSocket close status code (`number`).                                                    |
| `WebSocketFrame`         | interface | A parsed frame — `fin` / `opcode` / `payload` / `consumed`.                                  |
| `WebSocketEncodeOptions` | interface | `encodeWebSocketFrame` masking control — `masked` and an optional explicit `mask`.           |
| `WebSocketMessage`       | interface | A decoded text message (`data`).                                                             |
| `WebSocketClose`         | interface | The close metadata — `code` / `reason`.                                                      |
| `NodeWebSocketEventMap`  | type      | The event map — `open` / `message` / `close` / `error` / `ping` / `pong`.                    |
| `NodeWebSocketOptions`   | interface | Options for `createNodeWebSocket` (`socket` / `key` / `head` / `protocol` / `on` / `error`). |
| `NodeWebSocketInterface` | interface | The wrapper contract.                                                                        |

Frame payloads are raw `Buffer`s off the wire; a text frame decodes to a `string` at the boundary, and the untyped socket `data` chunk is narrowed to a `Buffer` with a guard, never an assertion (AGENTS §14).

## Methods

The public methods of the behavioral interface — its `readonly` data members (`emitter` / `readyState`) stay in the Surface rows above. `NodeWebSocket` implements `NodeWebSocketInterface` exactly, so this doubles as the per-instance method surface (AGENTS §22).

#### `NodeWebSocketInterface`

| Method    | Returns | Behavior                                                                                                                                                                                                                                                                                       |
| --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`    | `void`  | Frame `data` as a UTF-8 text frame and write it (masked in client mode, unmasked in server mode). No-op unless `readyState` is open.                                                                                                                                                           |
| `ping`    | `void`  | Write a ping frame with an optional payload; the peer is expected to answer with a pong (surfaced as `pong`). No-op unless open.                                                                                                                                                               |
| `close`   | `void`  | Start the closing handshake: move to `closing`, write a close frame (the 2-byte big-endian `code` — default `WEBSOCKET_CLOSE_NORMAL` — plus optional `reason`), and end the writable side. The final `close` event fires once the peer echoes or the socket ends. A second `close` is a no-op. |
| `destroy` | `void`  | Abort immediately: detach the socket listeners, destroy the socket, emit a final `close`, and tear the emitter down. Idempotent — a hard stop, not a handshake.                                                                                                                                |

## Contract

These invariants hold across `src/server/websocket` ↔ `websocket.md`:

1. **DOC ↔ SOURCE bijection.** Every row in the `## Surface` tables is a real export of the module, and every export appears as a Surface row — exhaustive, both directions (AGENTS §22).
2. **Wire-only, schema-agnostic.** The wrapper speaks the RFC 6455 frame protocol and nothing else — no MCP, no JSON-RPC, no message schema. A higher transport is built _on_ it (the same minimal-interface discipline as the SQLite and IndexedDB wrappers, AGENTS §21).
3. **The codec is pure and exhaustively pinned.** `computeWebSocketAccept` / `parseWebSocketFrame` / `encodeWebSocketFrame` are pure functions tested against RFC 6455's own worked byte vectors. `parseWebSocketFrame` returns `undefined` on an **incomplete** buffer (the caller accumulates across `data` chunks, exactly like the core [`SSEParser`](parsers.md)); `encode` and `parse` are exact inverses.
4. **Server vs. client is the single `key` decision.** A `key` (the client's `Sec-WebSocket-Key`) selects SERVER mode: the wrapper writes the `101 Switching Protocols` handshake with `Sec-WebSocket-Accept: computeWebSocketAccept(key)` and sends **unmasked** frames. No `key` is CLIENT mode: no handshake is written and every outgoing frame is **masked** — RFC 6455 §5.3 mandates client→server masking, and the wrapper enforces it from this one flag, so you never set the mask bit by hand.
5. **One accumulation buffer, drained frame by frame.** Incoming `data` chunks append to a buffer that is decoded with `parseWebSocketFrame` in a loop, slicing each frame's `consumed` bytes off the front and re-parsing until a partial frame remains. Dispatch by opcode: a data frame (text, binary, or a `0x00` continuation) buffers its fragments and emits one `message` (decoded UTF-8) at `fin`; a ping emits `ping` and is **auto-answered with a pong**; a pong emits `pong`; a close is echoed back (RFC 6455 §5.5.1), ends the socket, and emits the final `close`. A WebSocket message is therefore never assumed to be one `data` chunk — the buffer absorbs the split.
6. **Observable, and a faulty listener can never sink the socket (§13).** The wrapper exposes a typed `emitter`; listener isolation is the emitter's job. Two error channels stay distinct: the map's `error` event is a **domain** fault — the underlying socket itself errored — whereas a listener that _throws_ is caught by the emitter and routed to its own `error` handler (the `error` constructor option, an `EmitterErrorHandler`), never re-entered as a domain event. A buggy observer is contained; the connection stays alive.

## Patterns

### Accept an upgrade and echo messages (server mode)

The handle is fully driven through its `emitter` — attach as many observers as you like; a throw in one is isolated and never reaches the socket.

```ts
import { createNodeWebSocket } from '@src/server'

server.on('upgrade', (request, socket, head) => {
	const ws = createNodeWebSocket({
		socket,
		key: request.headers['sec-websocket-key'],
		head, // any bytes already buffered after the upgrade headers
	})
	ws.emitter.on('message', (text) => ws.send(`echo: ${text}`))
	ws.emitter.on('close', (code, reason) => log('closed', code, reason))
})
```

### Stream-decode frames across chunk boundaries

```ts
import { parseWebSocketFrame } from '@src/server'

let buffer = Buffer.alloc(0)
socket.on('data', (chunk: Buffer) => {
	buffer = Buffer.concat([buffer, chunk])
	for (;;) {
		const frame = parseWebSocketFrame(buffer)
		if (frame === undefined) break // incomplete — wait for more bytes
		buffer = buffer.subarray(frame.consumed) // slice the frame off, re-parse the rest
		handle(frame)
	}
})
```

### Encode a frame to the wire (server unmasked, client masked)

```ts
import { encodeWebSocketFrame, WEBSOCKET_OPCODE_TEXT } from '@src/server'

socket.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'hello')) // server→client (unmasked)
socket.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'hello', { masked: true })) // client→server
```

### Compute the handshake accept token

```ts
import { computeWebSocketAccept } from '@src/server'

computeWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ==') // 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' (RFC 6455 §1.3)
```

### Practices

- **Reach for a message transport, not raw frames, when you have a protocol.** This is the wire-level handle the MCP WebSocket transport is built on; drop to it directly only for bespoke framing where no schema applies. If you find yourself hand-rolling request/response correlation on top, you want the layer above.
- **Let the mode handle masking — never set the mask bit yourself.** Server mode sends unmasked, client mode masks; the single `key` choice decides it. Reach for `encodeWebSocketFrame(..., { masked: true })` only when you are feeding the parser a synthetic client frame (e.g. in a test).
- **Drive the parser as a stream, never per-chunk.** Accumulate `data`, loop `parseWebSocketFrame`, slice `consumed` off, and treat `undefined` as "need more bytes". A frame can span chunks and a chunk can hold several frames — the buffer is what reconciles both.
- **Observe everything through the `emitter`.** Wire `message` / `close` / `ping` / `pong` and the domain `error`; a listener that throws is contained by the emitter and surfaced on its own `error` handler (the `error` option), so one bad observer never takes the connection down.

## Tests

- [`tests/guides/parity.test.ts`](../../tests/guides/src/parity.test.ts) — the `## Surface` ↔ `src/server/websocket` bijection and the `## Methods` ↔ interface/class method parity.
- [`tests/src/server/websocket/helpers.test.ts`](../../tests/src/server/websocket/helpers.test.ts) — the RFC 6455 codec as pure units against the spec's own byte vectors: the §1.3 handshake accept token, the unmasked + masked "Hello" frames (§5.7), the 7/16/64-bit length-form boundaries (125 / 126 / 65 536), the control opcodes, an incomplete buffer → `undefined` (split mid-header, mid-mask, mid-payload), a frame with trailing bytes (`consumed` recovers the remainder), and the encode↔parse inverse for masked and unmasked frames.
- [`tests/src/server/websocket/NodeWebSocket.test.ts`](../../tests/src/server/websocket/NodeWebSocket.test.ts) — the wrapper driven end to end over an in-memory `node:stream` Duplex pair (two cross-wired `PassThrough`s — a real bidirectional socket, no mock): the 101 handshake (with subprotocol echo), a masked client text frame → `message`, continuation-fragment reassembly, two frames in one chunk, `send` → an unmasked readable frame, ping → auto-pong, the close handshake + `close` event, `destroy` idempotency, and §13 observer-error isolation.

## See also

- [`sqlite.md`](sqlite.md) — the server SQLite wrapper, the same lean-native-wrapper discipline.
- [`indexeddb.md`](indexeddb.md) — the browser counterpart of that discipline.
- [`http.md`](http.md) — the HTTP server spine over `node:http` (the upgrade seam that hands a socket to this wrapper).
- [`parsers.md`](parsers.md) — the core `SSEParser`, the same incomplete-buffer → `undefined` streaming-decoder contract `parseWebSocketFrame` follows.
- [`AGENTS.md`](../../AGENTS.md) — §13 emitter, §14 untyped-boundary narrowing, §21 minimal interface, §22 documentation-as-contracts.
- [`README.md`](README.md) — the guides index.
