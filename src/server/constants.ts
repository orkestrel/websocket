import type { WebSocketReadyState } from './types.js'

// The WebSocket wrapper's wire constants — the RFC 6455
// magic values the codec and the handshake are built on: the accept GUID, the
// supported protocol version, the frame opcodes, the ready states, and the
// normal-closure status code. Every member is exported; the codec helpers and the
// `NodeWebSocket` wrapper read them by name rather than re-spelling the bit values.

/**
 * Names the accept GUID concatenated to a client's `Sec-WebSocket-Key` before the accept
 * hash, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'.
 *
 * @remarks
 * The base64-encoded SHA-1 of that concatenation is the `Sec-WebSocket-Accept` response
 * value. A fixed, spec-mandated constant (RFC 6455 §4.2.2) — read only by
 * {@link computeWebSocketAccept}.
 */
export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * Names the supported protocol version, '13'.
 *
 * @remarks
 * The value this wrapper speaks, carried by the `Sec-WebSocket-Version` handshake header.
 */
export const WEBSOCKET_VERSION = '13'

/**
 * Names the text frame opcode, 0x01.
 *
 * @remarks
 * A UTF-8 payload (RFC 6455 §5.6).
 */
export const WEBSOCKET_OPCODE_TEXT = 0x01

/**
 * Names the binary frame opcode, 0x02.
 *
 * @remarks
 * A raw byte payload (RFC 6455 §5.6).
 */
export const WEBSOCKET_OPCODE_BINARY = 0x02

/**
 * Names the continuation frame opcode, 0x00.
 *
 * @remarks
 * The next fragment of an open data message (RFC 6455 §5.4).
 */
export const WEBSOCKET_OPCODE_CONTINUATION = 0x00

/**
 * Names the close frame opcode, 0x08.
 *
 * @remarks
 * A control frame ending the connection (RFC 6455 §5.5.1).
 */
export const WEBSOCKET_OPCODE_CLOSE = 0x08

/**
 * Names the ping frame opcode, 0x09.
 *
 * @remarks
 * A control frame the peer must answer with a pong (RFC 6455 §5.5.2).
 */
export const WEBSOCKET_OPCODE_PING = 0x09

/**
 * Names the pong frame opcode, 0x0a.
 *
 * @remarks
 * A control frame answering a ping (RFC 6455 §5.5.3).
 */
export const WEBSOCKET_OPCODE_PONG = 0x0a

/**
 * Names the connecting ready state, 0.
 *
 * @remarks
 * The state a WebSocket holds before its handshake completes.
 */
export const WEBSOCKET_READY_CONNECTING: WebSocketReadyState = 0

/**
 * Names the open ready state, 1.
 *
 * @remarks
 * The state a WebSocket holds after the handshake completes and while frames flow.
 */
export const WEBSOCKET_READY_OPEN: WebSocketReadyState = 1

/**
 * Names the closing ready state, 2.
 *
 * @remarks
 * The state a WebSocket holds after a close frame is sent or received.
 */
export const WEBSOCKET_READY_CLOSING: WebSocketReadyState = 2

/**
 * Names the closed ready state, 3.
 *
 * @remarks
 * The state a WebSocket holds after the socket ends.
 */
export const WEBSOCKET_READY_CLOSED: WebSocketReadyState = 3

/**
 * Names the normal-closure status code, 1000.
 *
 * @remarks
 * The default `close` code (RFC 6455 §7.4.1).
 */
export const WEBSOCKET_CLOSE_NORMAL = 1000

/**
 * Names the protocol-error status code, 1002.
 *
 * @remarks
 * Sent when a framing or state rule was violated (RFC 6455 §7.4.1).
 */
export const WEBSOCKET_CLOSE_PROTOCOL = 1002

/**
 * Names the unsupported-data status code, 1003.
 *
 * @remarks
 * Sent when the endpoint received a data type it cannot accept (RFC 6455 §7.4.1), for
 * example binary on a text-only endpoint.
 */
export const WEBSOCKET_CLOSE_UNSUPPORTED = 1003

/**
 * Names the invalid-frame-payload-data status code, 1007.
 *
 * @remarks
 * Sent for non-UTF-8 text or an unparseable close reason (RFC 6455 §7.4.1).
 */
export const WEBSOCKET_CLOSE_INVALID = 1007

/**
 * Names the message-too-big status code, 1009.
 *
 * @remarks
 * Sent when a reassembled message exceeded the payload cap (RFC 6455 §7.4.1).
 */
export const WEBSOCKET_CLOSE_TOO_BIG = 1009

/**
 * Names the default cap on both an inbound frame's declared length and a reassembled
 * message's total byte count, 104,857,600 bytes (100 MiB).
 *
 * @remarks
 * The same value the `ws` package defaults to. Either breach closes
 * {@link WEBSOCKET_CLOSE_TOO_BIG}.
 */
export const WEBSOCKET_MAX_PAYLOAD = 104_857_600

/**
 * Names the default close-handshake timeout, 30,000 milliseconds — how long `close` waits
 * for the peer's echo.
 *
 * @remarks
 * After it expires the wrapper tears the socket down, so a silent peer cannot leak the
 * handle open.
 */
export const WEBSOCKET_CLOSE_TIMEOUT_MS = 30_000

/**
 * Names the flush grace, 1,000 milliseconds, a validation-breach close frame is given
 * before the hard teardown fallback destroys the socket.
 *
 * @remarks
 * Armed after `#fail` writes the close frame, so the frame drains through the socket's
 * write buffer rather than being discarded. The normal path destroys sooner, on the
 * `end()` flush callback.
 */
export const WEBSOCKET_FAIL_TIMEOUT_MS = 1_000

/**
 * Names the maximum control-frame payload length, 125 bytes.
 *
 * @remarks
 * The cap RFC 6455 §5.5 sets on every control frame's payload.
 */
export const WEBSOCKET_CONTROL_MAX_LENGTH = 125

/**
 * Names the maximum UTF-8 close-reason length after the two-byte status code, 123.
 *
 * @remarks
 * What is left of {@link WEBSOCKET_CONTROL_MAX_LENGTH} after the close frame's status
 * code.
 */
export const WEBSOCKET_CLOSE_REASON_MAX_LENGTH = WEBSOCKET_CONTROL_MAX_LENGTH - 2
