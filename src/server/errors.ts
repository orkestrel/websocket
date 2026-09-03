import type { WebSocketErrorCode } from './types.js'

// Errors for the WebSocket wrapper. A single `WebSocketError` carries a
// machine-readable `code` naming the subject that was refused, so a `catch` branches
// on `error.code` rather than parsing a message. Every refusal is a caller-supplied
// value the RFC 6455 wire protocol cannot carry — a malformed option, an over-cap
// control payload, an unsendable close code, an unrepresentable frame header — and
// each throws before it writes a byte: an OPTION before the wrapper assumes ownership
// of the socket, a LIMIT and a CLOSE without writing a frame or moving `readyState`,
// and a FRAME out of the pure encoder, which touches no socket. A PEER's protocol
// violation is not an error: it closes the connection with the matching
// `WEBSOCKET_CLOSE_*` status code instead.

/**
 * Represents an error thrown by the WebSocket wrapper for a refused caller-supplied value.
 *
 * @remarks
 * Carries a {@link WebSocketErrorCode} and an optional `context` record holding the
 * refused value under a key naming it: an `'OPTION'` carries the offending option
 * (`payload`, `timeout`, `key`, or `protocol`), a `'LIMIT'` carries `size` and the
 * `limit` it exceeded, a `'CLOSE'` carries the refused close `code`, and a `'FRAME'`
 * carries `opcode` or the mask's `size`. Narrow a caught value with
 * {@link isWebSocketError}.
 *
 * @example
 * ```ts
 * import { createNodeWebSocket, isWebSocketError } from '@src/server'
 *
 * try {
 * 	createNodeWebSocket({ socket, key: 'not-base64' })
 * } catch (error) {
 * 	if (isWebSocketError(error) && error.code === 'OPTION') socket.destroy()
 * }
 * ```
 */
export class WebSocketError extends Error {
	readonly code: WebSocketErrorCode
	readonly context?: Readonly<Record<string, unknown>>

	/**
	 * Creates a WebSocket error carrying a machine-readable code.
	 *
	 * @param code - The machine-readable {@link WebSocketErrorCode} a `catch` branches on
	 * @param message - The human-readable description, carried as the `Error` message
	 * @param context - The refused value keyed by name; omitted leaves `context` `undefined`
	 */
	constructor(
		code: WebSocketErrorCode,
		message: string,
		context?: Readonly<Record<string, unknown>>,
	) {
		super(message)
		this.name = 'WebSocketError'
		this.code = code
		if (context !== undefined) this.context = context
	}
}

/**
 * Checks whether a value is a {@link WebSocketError}.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns True if `value` is a `WebSocketError`; false otherwise
 *
 * @example
 * ```ts
 * import { isWebSocketError } from '@src/server'
 *
 * try {
 * 	ws.close(1000.5)
 * } catch (error) {
 * 	if (isWebSocketError(error) && error.code === 'CLOSE') ws.close()
 * }
 * ```
 */
export function isWebSocketError(value: unknown): value is WebSocketError {
	return value instanceof WebSocketError
}
