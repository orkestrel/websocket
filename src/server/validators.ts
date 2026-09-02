// The RFC 6455 boundary guards — pure, total predicates over caller-supplied
// handshake and wire values. A predicate that always answers `true` or `false`,
// never `undefined`, is a guard and belongs here, never in `parsers.ts`.

/**
 * Whether a value is a canonical RFC 6455 `Sec-WebSocket-Key`.
 *
 * @remarks
 * A valid key is exactly 16 random bytes encoded as 24 characters of base64, ending
 * in `==` (RFC 6455 §4.1). This predicate is suitable at an HTTP upgrade boundary:
 * malformed or non-canonical encodings return `false`; nothing is thrown.
 *
 * @param key - The proposed `Sec-WebSocket-Key` header value
 * @returns `true` when `key` is the canonical base64 encoding of 16 bytes
 *
 * @example
 * ```ts
 * const key = request.headers['sec-websocket-key']
 * if (typeof key !== 'string' || !isWebSocketKey(key)) socket.destroy()
 * ```
 */
export function isWebSocketKey(key: string): boolean {
	if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return false
	return Buffer.from(key, 'base64').length === 16
}

/**
 * Whether a value is one valid WebSocket subprotocol token.
 *
 * @remarks
 * Subprotocols use the HTTP `token` grammar. Whitespace, separators, commas, and
 * control characters are rejected, preventing an untrusted value from injecting a
 * second handshake header.
 *
 * @param protocol - The negotiated subprotocol to validate
 * @returns `true` when `protocol` is one non-empty HTTP token
 *
 * @example
 * ```ts
 * if (!isWebSocketProtocol(protocol)) socket.destroy()
 * ```
 */
export function isWebSocketProtocol(protocol: string): boolean {
	return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol)
}

/**
 * Whether a numeric value is a valid RFC 6455 close status code to RECEIVE (§7.4.1).
 *
 * @remarks
 * True for `1000`–`1003`, `1007`–`1014`, and the application range `3000`–`4999`; false
 * for anything below `1000`, the reserved-for-local-use-only codes `1004`–`1006` and
 * `1015`, and the unassigned `1016`–`2999` range. The `1012`–`1014` extension of the
 * strict RFC 6455 receivable set is a deliberate IANA-interop choice: those three codes
 * (Service Restart, Try Again Later, Bad Gateway) are IANA-registered in the WebSocket
 * Close Code Number Registry and accepted by the `ws` ecosystem and modern conformance
 * suites, so a peer sending one is not treated as a protocol violation. Pure predicate,
 * never throws.
 *
 * @param code - The close status code to validate
 * @returns `true` when `code` is a valid RFC 6455 close code
 *
 * @example
 * ```ts
 * if (!isCloseCode(code)) fail(WEBSOCKET_CLOSE_PROTOCOL)
 * ```
 */
export function isCloseCode(code: number): boolean {
	if (!Number.isInteger(code)) return false
	if (code >= 1000 && code <= 1003) return true
	if (code >= 1007 && code <= 1014) return true
	if (code >= 3000 && code <= 4999) return true
	return false
}
