import type { WebSocketReadyState } from './types.js'

// The WebSocket wrapper's wire constants (AGENTS §5 constants file) — the RFC 6455
// magic values the codec and the handshake are built on: the accept GUID, the
// supported protocol version, the frame opcodes, the four ready states, and the
// normal-closure status code. Every member is exported; the codec helpers and the
// `NodeWebSocket` wrapper read them by name rather than re-spelling the bit values.

/**
 * The RFC 6455 GUID concatenated to a client's `Sec-WebSocket-Key` before the SHA-1
 * hash that yields the `Sec-WebSocket-Accept` response value.
 *
 * @remarks
 * A fixed, spec-mandated constant (RFC 6455 §4.2.2) — read only by
 * {@link computeWebSocketAccept}.
 */
export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** The WebSocket protocol version this wrapper speaks (`Sec-WebSocket-Version: 13`). */
export const WEBSOCKET_VERSION = '13'

/** Text frame opcode — a UTF-8 payload (RFC 6455 §5.6). */
export const WEBSOCKET_OPCODE_TEXT = 0x01

/** Binary frame opcode — a raw byte payload (RFC 6455 §5.6). */
export const WEBSOCKET_OPCODE_BINARY = 0x02

/** Continuation frame opcode — the next fragment of an open data message (RFC 6455 §5.4). */
export const WEBSOCKET_OPCODE_CONTINUATION = 0x00

/** Close frame opcode — a control frame ending the connection (RFC 6455 §5.5.1). */
export const WEBSOCKET_OPCODE_CLOSE = 0x08

/** Ping frame opcode — a control frame the peer must answer with a pong (RFC 6455 §5.5.2). */
export const WEBSOCKET_OPCODE_PING = 0x09

/** Pong frame opcode — a control frame answering a ping (RFC 6455 §5.5.3). */
export const WEBSOCKET_OPCODE_PONG = 0x0a

/** Ready state for a connecting WebSocket (before the handshake completes). */
export const WEBSOCKET_READY_CONNECTING: WebSocketReadyState = 0

/** Ready state for an open WebSocket (the handshake completed; frames flow). */
export const WEBSOCKET_READY_OPEN: WebSocketReadyState = 1

/** Ready state for a closing WebSocket (a close frame was sent or received). */
export const WEBSOCKET_READY_CLOSING: WebSocketReadyState = 2

/** Ready state for a closed WebSocket (the socket ended). */
export const WEBSOCKET_READY_CLOSED: WebSocketReadyState = 3

/** Normal-closure status code (RFC 6455 §7.4.1) — the default `close` code. */
export const WEBSOCKET_CLOSE_NORMAL = 1000

/** Protocol-error status code (RFC 6455 §7.4.1) — a framing/state rule was violated. */
export const WEBSOCKET_CLOSE_PROTOCOL = 1002

/** Unsupported-data status code (RFC 6455 §7.4.1) — the endpoint received a data type it cannot accept (e.g. binary on a text-only endpoint). */
export const WEBSOCKET_CLOSE_UNSUPPORTED = 1003

/** Invalid-frame-payload-data status code (RFC 6455 §7.4.1) — e.g. non-UTF-8 text or an unparseable close reason. */
export const WEBSOCKET_CLOSE_INVALID = 1007

/** Message-too-big status code (RFC 6455 §7.4.1) — a reassembled message exceeded the payload cap. */
export const WEBSOCKET_CLOSE_TOOBIG = 1009

/** The default maximum inbound single-frame length AND reassembled-message total byte count (100 MiB — the `ws` package default). */
export const WEBSOCKET_MAX_PAYLOAD = 104_857_600

/** The default close-handshake timeout in milliseconds — how long `close()` waits for the peer's echo before tearing the socket down. */
export const WEBSOCKET_CLOSE_TIMEOUT_MS = 30_000

/** The post-`#fail` flush grace in milliseconds — how long a validation-breach close frame is given to flush through the socket's write buffer before the hard `destroy()` fallback fires (the normal path destroys sooner, on the `end()` flush callback). */
export const WEBSOCKET_FAIL_TIMEOUT_MS = 1_000

/** The maximum control-frame payload length in bytes (RFC 6455 §5.5). */
export const WEBSOCKET_CONTROL_MAXLEN = 125

/** The maximum UTF-8 close-reason length after the two-byte status code. */
export const WEBSOCKET_CLOSE_REASON_MAXLEN = WEBSOCKET_CONTROL_MAXLEN - 2
