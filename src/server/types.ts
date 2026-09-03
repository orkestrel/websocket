import type { Duplex } from 'node:stream'
import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'

// The lean server-native WebSocket surface — a typed wrapper over a raw upgraded
// `node:stream` Duplex socket that speaks ONLY the RFC 6455 wire protocol. It
// exposes the WebSocket framing the rest of the codebase cannot express — the
// handshake, masked/unmasked frames, ping/pong, close — and nothing above it: this
// wrapper has NO knowledge of MCP, JSON-RPC, or any message schema (that is the
// transport one layer up). It is the lean-native-wrapper sibling of the SQLite and
// IndexedDB wrappers: a minimal interface over native power, errors surfaced through
// the emitter, the codec a set of pure, exported, unit-tested helpers. This file is the
// source of truth for the public contracts.
//
// Frame payloads are raw `Buffer`s off the wire; text frames decode to a `string` at
// the boundary, and the untyped socket `data` is narrowed with a guard, never an
// assertion.

// === Ready state

/**
 * Represents a WebSocket ready state — the four browser-compatible lifecycle values.
 *
 * @remarks
 * `0` connecting, `1` open, `2` closing, `3` closed — the same numbering the DOM
 * `WebSocket.readyState` uses, so the wrapper reads like the platform API. The named
 * `WEBSOCKET_READY_*` constants spell each value.
 */
export type WebSocketReadyState = 0 | 1 | 2 | 3

// === Frame

/**
 * Represents a parsed RFC 6455 frame — the structured result of decoding one frame off the wire.
 *
 * @remarks
 * `fin` is the final-fragment bit (false for a continued fragment); `opcode`
 * identifies the frame kind (one of the `WEBSOCKET_OPCODE_*` values); `payload` is
 * the already-unmasked application data; `consumed` is the total byte count the frame
 * occupied (header + mask + payload), so the caller slices it off the front of its
 * accumulation buffer and re-parses the remainder. `masked` is the mask bit off byte 1
 * (client→server frames MUST be masked, RFC 6455 §5.1); `rsv` is the three reserved
 * bits off byte 0 packed into a single 0–7 value (RFC 6455 §5.2) — non-zero means an
 * extension the wrapper does not negotiate, so the caller rejects it. Produced by
 * {@link parseWebSocketFrame}.
 */
export interface WebSocketFrame {
	readonly fin: boolean
	readonly opcode: number
	readonly payload: Buffer
	readonly consumed: number
	readonly masked: boolean
	readonly rsv: number
}

/**
 * Represents the options for {@link encodeWebSocketFrame} — how a frame is masked on the wire.
 *
 * @remarks
 * `masked` toggles the mask bit (server→client frames are NOT masked, the default;
 * client→server frames MUST be, RFC 6455 §5.3). `mask` supplies an explicit 4-byte
 * mask key (deterministic, for tests); when `masked` is true and `mask` is omitted a
 * random key is generated.
 */
export interface WebSocketEncodeOptions {
	readonly masked?: boolean
	readonly mask?: Buffer
}

// === Errors

/**
 * Represents the subject an {@link import('./errors.js').WebSocketError} names as refused.
 *
 * @remarks
 * `OPTION` — a {@link NodeWebSocketOptions} member was refused at construction
 * (`payload`, `timeout`, `key`, `protocol`, or a `protocol` given without a server
 * `key`). `LIMIT` — an outbound control-frame payload exceeded its RFC 6455 §5.5 cap
 * (a `ping` payload past `WEBSOCKET_CONTROL_MAX_LENGTH`, a `close` reason past
 * `WEBSOCKET_CLOSE_REASON_MAX_LENGTH`). `CLOSE` — a close status code `isCloseCode` refuses
 * was passed to `close`. `FRAME` — an `encodeWebSocketFrame` frame-header argument was
 * refused (an opcode outside the four-bit wire field, a mask that is not 4 bytes, or a
 * mask supplied without `masked: true`).
 */
export type WebSocketErrorCode = 'OPTION' | 'LIMIT' | 'CLOSE' | 'FRAME'

// === Events

/**
 * Represents the event map of a {@link NodeWebSocketInterface}.
 *
 * @remarks
 * `open` — the handshake completed and the socket is ready. `message` — a text frame
 * arrived (its decoded UTF-8 string). `close` — the connection ended, carrying the
 * labeled `[code, reason]` tuple (each `undefined` when the peer sent none). `error` —
 * the underlying socket faulted (a DOMAIN event and then terminates the wrapper).
 * `ping` / `pong` — a control frame arrived (a ping is auto-answered with a pong).
 * Listener isolation is the emitter's: a listener throw is routed to the emitter's
 * `error` handler (the `error` option), never onto this map, so a buggy observer
 * never breaks the socket.
 */
export type NodeWebSocketEventMap = {
	readonly open: readonly []
	readonly message: readonly [message: string]
	readonly close: readonly [code: number | undefined, reason: string | undefined]
	readonly error: readonly [error: unknown]
	readonly ping: readonly []
	readonly pong: readonly []
}

// === Options

/**
 * Represents the options for `createNodeWebSocket`.
 *
 * @remarks
 * `socket` is the upgraded `node:stream` Duplex (the raw TCP stream after the HTTP
 * upgrade). `key` is the client's `Sec-WebSocket-Key`: present it to run in SERVER
 * mode — the wrapper writes the `101 Switching Protocols` handshake and sends UNMASKED
 * frames; omit it for CLIENT mode — no handshake is written and frames are MASKED (RFC
 * 6455 §5.3). `head` is any bytes buffered after the upgrade headers (replayed through
 * the parser). `protocol` is a negotiated subprotocol to echo in the handshake. `on`
 * wires initial listeners at construction — the reserved `on` option; `error` is the
 * emitter's listener-error handler, where a listener throw routes. `payload` caps
 * both a single inbound frame's declared length AND the total bytes of a reassembled
 * fragmented message (default `WEBSOCKET_MAX_PAYLOAD`) — a breach closes 1009. `timeout`
 * is how long the wrapper waits, after sending a close frame, for the peer's echo before
 * it gives up and tears the socket down (default `WEBSOCKET_CLOSE_TIMEOUT_MS`). `signal`
 * is the external cancellation seam — on abort the socket destroys; composes with the
 * line's `@orkestrel/abort` and `@orkestrel/timeout` primitives, which expose native
 * `AbortSignal`s. An already-aborted signal tears the socket down immediately after
 * construction. A refused member throws an `OPTION`-coded `WebSocketError` before the
 * wrapper writes to or assumes ownership of the `socket`.
 */
export interface NodeWebSocketOptions {
	readonly socket: Duplex
	readonly key?: string
	readonly head?: Buffer
	readonly protocol?: string
	readonly on?: EmitterHooks<NodeWebSocketEventMap>
	/** Holds the emitter's listener-error handler — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly payload?: number
	readonly timeout?: number
	readonly signal?: AbortSignal
}

// === Wrapper

/**
 * Represents a server-native WebSocket over a raw upgraded socket — the behavioral contract.
 *
 * @remarks
 * Created by `createNodeWebSocket`. In server mode it writes the RFC 6455 handshake
 * and emits `open`; thereafter it buffers incoming `data`, decodes each frame, and
 * dispatches: a text frame (reassembling continuation fragments) emits `message`; a
 * ping is auto-answered with a pong and emits `ping`; a pong emits `pong`; a close
 * frame is echoed and ends the socket, emitting `close`. `send` writes a text frame;
 * `ping` writes a ping; `close` writes a close frame (the 2-byte code + optional
 * reason); `destroy` tears the socket down immediately. `readyState` tracks the
 * lifecycle. It owns a typed `emitter` by composition and never throws on a faulty
 * listener — the emitter routes it to its `error` handler (the `error` option).
 * `ping` throws a `LIMIT`-coded `WebSocketError` when its UTF-8 payload exceeds
 * `WEBSOCKET_CONTROL_MAX_LENGTH`; `close` throws a `CLOSE`-coded one for a status code
 * `isCloseCode` refuses and a `LIMIT`-coded one for a reason past
 * `WEBSOCKET_CLOSE_REASON_MAX_LENGTH`, in each case without changing `readyState`.
 */
export interface NodeWebSocketInterface {
	readonly emitter: EmitterInterface<NodeWebSocketEventMap>
	readonly readyState: WebSocketReadyState
	send(message: string): void
	ping(payload?: string): void
	close(code?: number, reason?: string): void
	destroy(): void
}
