import type { Duplex } from 'node:stream'
import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'

// The lean server-native WebSocket surface — a typed wrapper over a raw upgraded
// `node:stream` Duplex socket that speaks ONLY the RFC 6455 wire protocol. It
// exposes the WebSocket framing the rest of the codebase cannot express — the
// handshake, masked/unmasked frames, ping/pong, close — and nothing above it: this
// wrapper has NO knowledge of MCP, JSON-RPC, or any message schema (that is the
// transport one layer up). It is the lean-native-wrapper sibling of the SQLite and
// IndexedDB wrappers: a minimal interface over native power, errors surfaced through
// the emitter, the codec a set of pure, exported, unit-tested helpers. Types are the
// source of truth (AGENTS §2).
//
// Frame payloads are raw `Buffer`s off the wire; text frames decode to a `string` at
// the boundary, and the untyped socket `data` is narrowed with a guard, never an
// assertion (AGENTS §14).

// === Ready state

/**
 * A WebSocket ready state — the four browser-compatible lifecycle values.
 *
 * @remarks
 * `0` connecting, `1` open, `2` closing, `3` closed — the same numbering the DOM
 * `WebSocket.readyState` uses, so the wrapper reads like the platform API. The named
 * `WEBSOCKET_READY_*` constants spell each value.
 */
export type WebSocketReadyState = 0 | 1 | 2 | 3

/** A WebSocket close status code (RFC 6455 §7.4) — e.g. `WEBSOCKET_CLOSE_NORMAL` (1000). */
export type WebSocketCloseCode = number

// === Frame

/**
 * A parsed RFC 6455 frame — the structured result of decoding one frame off the wire.
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
 * Options for {@link encodeWebSocketFrame} — how a frame is masked on the wire.
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

// === Message + close

/** A decoded text message received from, or to send to, a WebSocket peer. */
export interface WebSocketMessage {
	readonly data: string
}

/**
 * The metadata of a closed WebSocket — why the connection ended.
 *
 * @remarks
 * `code` is the RFC 6455 close status code (undefined when the peer closed with no
 * payload); `reason` is the optional UTF-8 reason text (undefined when empty).
 */
export interface WebSocketClose {
	readonly code: number | undefined
	readonly reason: string | undefined
}

// === Events

/**
 * The event map of a {@link NodeWebSocketInterface} (AGENTS §13).
 *
 * @remarks
 * `open` — the handshake completed and the socket is ready. `message` — a text frame
 * arrived (its decoded UTF-8 string). `close` — the connection ended (its
 * {@link WebSocketClose} metadata). `error` — the underlying socket faulted (a DOMAIN
 * event and then terminates the wrapper). `ping` / `pong` — a control frame arrived
 * (a ping is auto-answered with a pong).
 * Listener isolation is the emitter's (AGENTS §13): a listener throw is routed to the
 * emitter's `error` handler (the `error` option), never onto this map, so a buggy observer
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
 * Options for `createNodeWebSocket`.
 *
 * @remarks
 * `socket` is the upgraded `node:stream` Duplex (the raw TCP stream after the HTTP
 * upgrade). `key` is the client's `Sec-WebSocket-Key`: present it to run in SERVER
 * mode — the wrapper writes the `101 Switching Protocols` handshake and sends UNMASKED
 * frames; omit it for CLIENT mode — no handshake is written and frames are MASKED (RFC
 * 6455 §5.3). `head` is any bytes buffered after the upgrade headers (replayed through
 * the parser). `protocol` is a negotiated subprotocol to echo in the handshake. `on`
 * wires initial listeners at construction (AGENTS §8 reserved option); `error` is the
 * emitter's listener-error handler (§13 — a listener throw routes here). `payload` caps
 * both a single inbound frame's declared length AND the total bytes of a reassembled
 * fragmented message (default `WEBSOCKET_MAX_PAYLOAD`) — a breach closes 1009. `timeout`
 * is how long the wrapper waits, after sending a close frame, for the peer's echo before
 * it gives up and tears the socket down (default `WEBSOCKET_CLOSE_TIMEOUT_MS`). `signal`
 * is the external cancellation seam — on abort the socket destroys; composes with the
 * line's `@orkestrel/abort` and `@orkestrel/timeout` primitives, which expose native
 * `AbortSignal`s. An already-aborted signal tears the socket down immediately after
 * construction.
 */
export interface NodeWebSocketOptions {
	readonly socket: Duplex
	readonly key?: string
	readonly head?: Buffer
	readonly protocol?: string
	readonly on?: EmitterHooks<NodeWebSocketEventMap>
	/** The emitter's listener-error handler (AGENTS §13) — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly payload?: number
	readonly timeout?: number
	readonly signal?: AbortSignal
}

// === Wrapper

/**
 * A server-native WebSocket over a raw upgraded socket — the behavioral contract.
 *
 * @remarks
 * Created by `createNodeWebSocket`. In server mode it writes the RFC 6455 handshake
 * and emits `open`; thereafter it buffers incoming `data`, decodes each frame, and
 * dispatches: a text frame (reassembling continuation fragments) emits `message`; a
 * ping is auto-answered with a pong and emits `ping`; a pong emits `pong`; a close
 * frame is echoed and ends the socket, emitting `close`. `send` writes a text frame;
 * `ping` writes a ping; `close` writes a close frame (the 2-byte code + optional
 * reason); `destroy` tears the socket down immediately. `readyState` tracks the
 * lifecycle. It owns a typed `emitter` (AGENTS §13) and never throws on a faulty
 * listener — the emitter routes it to its `error` handler (the `error` option).
 */
export interface NodeWebSocketInterface {
	readonly emitter: EmitterInterface<NodeWebSocketEventMap>
	readonly readyState: WebSocketReadyState
	send(data: string): void
	ping(data?: string): void
	close(code?: number, reason?: string): void
	destroy(): void
}
