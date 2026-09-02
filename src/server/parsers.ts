// The RFC 6455 coercers — pure reads off a wire buffer that answer `undefined` while
// the bytes they need are still incomplete, so the caller accumulates and retries.
// A coercion producing `T | undefined` is a `parse*`, never a guard: it answers about
// bytes that may not be there yet, where a guard is total.

/**
 * Reads whether the next frame uses the shortest valid RFC 6455 payload-length encoding.
 *
 * @remarks
 * Returns `undefined` until the complete length prefix is buffered. The 16-bit form
 * is canonical only for lengths at least 126; the 64-bit form only for lengths at
 * least 65,536 and with its most-significant bit clear (RFC 6455 §5.2).
 *
 * @param buffer - The accumulation buffer containing the next frame header
 * @returns Its canonicality, or `undefined` while the length prefix is incomplete
 *
 * @example
 * ```ts
 * if (parseWebSocketCanonical(buffer) === false) fail(WEBSOCKET_CLOSE_PROTOCOL)
 * ```
 */
export function parseWebSocketCanonical(buffer: Buffer): boolean | undefined {
	if (buffer.length < 2) return undefined

	const lengthCode = buffer.readUInt8(1) & 0x7f
	if (lengthCode < 126) return true
	if (lengthCode === 126) {
		if (buffer.length < 4) return undefined
		return buffer.readUInt16BE(2) >= 126
	}
	if (buffer.length < 10) return undefined
	const high = buffer.readUInt32BE(2)
	const low = buffer.readUInt32BE(6)
	if ((high & 0x8000_0000) !== 0) return false
	return high > 0 || low >= 65_536
}
