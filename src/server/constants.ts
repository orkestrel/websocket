import type { WebSocketReadyState } from './types.js'

// The WebSocket wrapper's wire constants — the RFC 6455
// magic values the codec and the handshake are built on: the accept GUID, the
// supported protocol version, the frame opcodes, the four ready states, and the
// normal-closure status code. Every member is exported; the codec helpers and the
// `NodeWebSocket` wrapper read them by name rather than re-spelling the bit values.

/**
 * Names the RFC 6455 GUID concatenated to a client's `Sec-WebSocket-Key` before the
 * accept hash.
 *
 * @remarks
 * The base64-encoded SHA-1 of that concatenation is the `Sec-WebSocket-Accept` response
 * value. A fixed, spec-mandated constant (RFC 6455 §4.2.2) — read only by
 * {@link computeWebSocketAccept}.
 */
export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Names the WebSocket protocol version this wrapper speaks (`Sec-WebSocket-Version: 13`). */
export const WEBSOCKET_VERSION = '13'

/** Names the text frame opcode — a UTF-8 payload (RFC 6455 §5.6). */
export const WEBSOCKET_OPCODE_TEXT = 0x01

/** Names the binary frame opcode — a raw byte payload (RFC 6455 §5.6). */
export const WEBSOCKET_OPCODE_BINARY = 0x02

/** Names the continuation frame opcode — the next fragment of an open data message (RFC 6455 §5.4). */
export const WEBSOCKET_OPCODE_CONTINUATION = 0x00

/** Names the close frame opcode — a control frame ending the connection (RFC 6455 §5.5.1). */
export const WEBSOCKET_OPCODE_CLOSE = 0x08

/** Names the ping frame opcode — a control frame the peer must answer with a pong (RFC 6455 §5.5.2). */
export const WEBSOCKET_OPCODE_PING = 0x09

/** Names the pong frame opcode — a control frame answering a ping (RFC 6455 §5.5.3). */
export const WEBSOCKET_OPCODE_PONG = 0x0a

/** Names the ready state for a connecting WebSocket (before the handshake completes). */
export const WEBSOCKET_READY_CONNECTING: WebSocketReadyState = 0

/** Names the ready state for an open WebSocket (the handshake completed; frames flow). */
export const WEBSOCKET_READY_OPEN: WebSocketReadyState = 1

/** Names the ready state for a closing WebSocket (a close frame was sent or received). */
export const WEBSOCKET_READY_CLOSING: WebSocketReadyState = 2

/** Names the ready state for a closed WebSocket (the socket ended). */
export const WEBSOCKET_READY_CLOSED: WebSocketReadyState = 3

/** Names the normal-closure status code (RFC 6455 §7.4.1) — the default `close` code. */
export const WEBSOCKET_CLOSE_NORMAL = 1000

/** Names the protocol-error status code (RFC 6455 §7.4.1) — a framing/state rule was violated. */
export const WEBSOCKET_CLOSE_PROTOCOL = 1002

/**
 * Names the unsupported-data status code (RFC 6455 §7.4.1) — the endpoint received a data
 * type it cannot accept.
 *
 * @remarks
 * For example binary on a text-only endpoint.
 */
export const WEBSOCKET_CLOSE_UNSUPPORTED = 1003

/** Names the invalid-frame-payload-data status code (RFC 6455 §7.4.1) — for example non-UTF-8 text or an unparseable close reason. */
export const WEBSOCKET_CLOSE_INVALID = 1007

/** Names the message-too-big status code (RFC 6455 §7.4.1) — a reassembled message exceeded the payload cap. */
export const WEBSOCKET_CLOSE_TOO_BIG = 1009

/**
 * Names the default cap on both an inbound frame's declared length and a reassembled
 * message's total byte count (100 MiB).
 *
 * @remarks
 * The same value the `ws` package defaults to. Either breach closes
 * {@link WEBSOCKET_CLOSE_TOO_BIG}.
 */
export const WEBSOCKET_MAX_PAYLOAD = 104_857_600

/**
 * Names the default close-handshake timeout in milliseconds — how long `close` waits for
 * the peer's echo.
 *
 * @remarks
 * After it expires the wrapper tears the socket down, so a silent peer cannot leak the
 * handle open.
 */
export const WEBSOCKET_CLOSE_TIMEOUT_MS = 30_000

/**
 * Names the flush grace in milliseconds a validation-breach close frame is given before
 * the hard teardown fallback destroys the socket.
 *
 * @remarks
 * Armed after `#fail` writes the close frame, so the frame drains through the socket's
 * write buffer rather than being discarded. The normal path destroys sooner, on the
 * `end()` flush callback.
 */
export const WEBSOCKET_FAIL_TIMEOUT_MS = 1_000

/** Names the maximum control-frame payload length in bytes (RFC 6455 §5.5). */
export const WEBSOCKET_CONTROL_MAX_LENGTH = 125

/** Names the maximum UTF-8 close-reason length after the two-byte status code. */
export const WEBSOCKET_CLOSE_REASON_MAX_LENGTH = WEBSOCKET_CONTROL_MAX_LENGTH - 2
