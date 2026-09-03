import type { WebSocketEncodeOptions } from './types.js'
import { createHash, randomBytes } from 'node:crypto'
import { WEBSOCKET_GUID } from './constants.js'
import { WebSocketError } from './errors.js'

// The RFC 6455 codec helpers and boundary predicates — pure, exported, and exhaustively
// tested. `computeWebSocketAccept` derives the handshake token; `measureWebSocketFrame`
// reads a frame's declared payload length off the header alone and
// `matchesWebSocketCanonical` reads whether that length uses the shortest valid encoding;
// `encodeWebSocketFrame` builds the wire representation and refuses an unrepresentable
// frame header with a `FRAME`-coded `WebSocketError`; `isWebSocketKey`,
// `isWebSocketProtocol`, and `isCloseCode` are total predicates over caller-supplied
// handshake and wire values. The coercers (`parseWebSocketFrame`, `parseUTF8`) live in
// `parsers.ts` — this file keeps every pure read and predicate that coerces nothing.

/**
 * Computes the `Sec-WebSocket-Accept` response value for an RFC 6455 upgrade.
 *
 * @remarks
 * The base64-encoded SHA-1 of the client's `Sec-WebSocket-Key` concatenated with the
 * fixed {@link WEBSOCKET_GUID} (RFC 6455 §4.2.2) — the proof the server understood the
 * handshake. Pure and deterministic.
 *
 * @param key - The client's `Sec-WebSocket-Key` header value
 * @returns The base64 accept token to send back as `Sec-WebSocket-Accept`
 */
export function computeWebSocketAccept(key: string): string {
	return createHash('sha1')
		.update(key + WEBSOCKET_GUID)
		.digest('base64')
}

/**
 * Reads the declared payload length off the front of a buffer, without buffering or
 * reading the payload itself.
 *
 * @remarks
 * Decodes only byte 1's 7-bit length field, extended by the 16-bit (`126`) or 64-bit
 * (`127`) form exactly like `parseWebSocketFrame` — but stops there, so a caller
 * can reject an over-cap frame the moment its length is known, before the payload
 * bytes have even arrived. Returns `undefined` until the length field itself is fully
 * buffered (mirrors the parser's incomplete-buffer contract). Pure; never throws.
 *
 * @param buffer - The accumulation buffer to read the next frame's length from
 * @returns The declared payload length, or `undefined` when the buffer is too short to know it yet
 *
 * @example
 * ```ts
 * const declared = measureWebSocketFrame(buffer)
 * if (declared !== undefined && declared > limit) fail(WEBSOCKET_CLOSE_TOO_BIG)
 * ```
 */
export function measureWebSocketFrame(buffer: Buffer): number | undefined {
	if (buffer.length < 2) return undefined

	const secondByte = buffer.readUInt8(1)
	let length = secondByte & 0x7f
	const offset = 2

	if (length === 126) {
		if (buffer.length < offset + 2) return undefined
		length = buffer.readUInt16BE(offset)
	} else if (length === 127) {
		if (buffer.length < offset + 8) return undefined
		const high = buffer.readUInt32BE(offset)
		const low = buffer.readUInt32BE(offset + 4)
		length = high * 0x1_0000_0000 + low
	}

	return length
}

/**
 * Checks whether the next frame uses the shortest valid RFC 6455 payload-length encoding.
 *
 * @remarks
 * Returns `undefined` until the complete length prefix is buffered. The 16-bit form
 * is canonical only for lengths at least 126; the 64-bit form only for lengths at
 * least 65,536 and with its most-significant bit clear (RFC 6455 §5.2). Reads the same
 * length prefix as {@link measureWebSocketFrame}, under the same incomplete-buffer
 * contract. Pure; never throws.
 *
 * @param buffer - The accumulation buffer containing the next frame header
 * @returns Its canonicality, or `undefined` while the length prefix is incomplete
 *
 * @example
 * ```ts
 * if (matchesWebSocketCanonical(buffer) === false) fail(WEBSOCKET_CLOSE_PROTOCOL)
 * ```
 */
export function matchesWebSocketCanonical(buffer: Buffer): boolean | undefined {
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

/**
 * Encodes a single RFC 6455 frame to its wire bytes — the inverse of
 * `parseWebSocketFrame`.
 *
 * @remarks
 * Builds a final (FIN-set) frame: byte 0 is `0x80 | opcode`; the payload length uses
 * the 7-bit form below 126, the `126` + 16-bit form below 65 536, or the `127` +
 * 64-bit form beyond; when `masked` is set the mask bit is set, a 4-byte key (supplied
 * through `options.mask`, else random) is written, and the payload is XOR-masked. Server→
 * client frames are unmasked (the default); pass `masked: true` to encode a CLIENT
 * frame (for example to feed the parser in a test). A `string` payload is encoded as
 * UTF-8. Returns one contiguous `Buffer` (header + payload), so the wrapper writes it
 * with a single `socket.write`. Pure.
 *
 * @param opcode - The frame opcode (a `WEBSOCKET_OPCODE_*` value)
 * @param payload - The payload, a `Buffer` or a UTF-8 `string`
 * @param options - Masking control ({@link WebSocketEncodeOptions}); defaults to unmasked
 * @returns The complete frame as wire bytes
 * @throws A {@link WebSocketError} coded `FRAME` when `opcode` is outside the four-bit wire field, when `options.mask` is not 4 bytes, or when `options.mask` is supplied without `masked: true`
 */
export function encodeWebSocketFrame(
	opcode: number,
	payload: Buffer | string,
	options?: WebSocketEncodeOptions,
): Buffer {
	if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0x0f) {
		throw new WebSocketError('FRAME', 'opcode must be an integer between 0 and 15', { opcode })
	}
	if (options?.mask !== undefined && options.mask.length !== 4) {
		throw new WebSocketError('FRAME', 'mask must contain exactly 4 bytes', {
			size: options.mask.length,
		})
	}
	if (options?.mask !== undefined && options.masked !== true) {
		throw new WebSocketError('FRAME', 'mask requires masked: true')
	}
	const body = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload
	const length = body.length
	const masked = options?.masked === true
	const mask = masked ? (options?.mask ?? randomBytes(4)) : undefined
	const maskBit = masked ? 0x80 : 0

	// The header size: 2 base bytes + the extended-length bytes (0 / 2 / 8) + the mask
	// key (0 / 4). The length prefix and the mask key write into this header.
	const extended = length < 126 ? 0 : length < 65_536 ? 2 : 8
	const header = Buffer.alloc(2 + extended + (mask !== undefined ? 4 : 0))
	header[0] = 0x80 | opcode

	if (length < 126) {
		header[1] = maskBit | length
	} else if (length < 65_536) {
		header[1] = maskBit | 126
		header.writeUInt16BE(length, 2)
	} else {
		header[1] = maskBit | 127
		header.writeUInt32BE(Math.floor(length / 0x1_0000_0000), 2)
		header.writeUInt32BE(length % 0x1_0000_0000, 6)
	}

	if (mask === undefined) return Buffer.concat([header, body])

	mask.copy(header, header.length - 4)
	const maskedBody = Buffer.alloc(length)
	for (let index = 0; index < length; index += 1) {
		maskedBody[index] = body.readUInt8(index) ^ mask.readUInt8(index % 4)
	}
	return Buffer.concat([header, maskedBody])
}

/**
 * Checks whether a value is a canonical RFC 6455 `Sec-WebSocket-Key`.
 *
 * @remarks
 * A valid key is exactly 16 random bytes encoded as 24 characters of base64, ending
 * in `==` (RFC 6455 §4.1). This predicate is suitable at an HTTP upgrade boundary:
 * malformed or non-canonical encodings return `false`; nothing is thrown.
 *
 * @param key - The proposed `Sec-WebSocket-Key` header value
 * @returns True if `key` is the canonical base64 encoding of 16 bytes; false otherwise
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
 * Checks whether a value is one valid WebSocket subprotocol token.
 *
 * @remarks
 * Subprotocols use the HTTP `token` grammar. Whitespace, separators, commas, and
 * control characters are rejected, preventing an untrusted value from injecting a
 * second handshake header.
 *
 * @param protocol - The negotiated subprotocol to validate
 * @returns True if `protocol` is one non-empty HTTP token; false otherwise
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
 * Checks whether a numeric value is a valid RFC 6455 close status code to RECEIVE (§7.4.1).
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
 * @returns True if `code` is a valid RFC 6455 close code; false otherwise
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
