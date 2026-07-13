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
