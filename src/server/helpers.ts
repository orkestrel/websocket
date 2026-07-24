import type { WebSocketEncodeOptions, WebSocketFrame } from './types.js'
import { createHash, randomBytes } from 'node:crypto'
import { WEBSOCKET_GUID } from './constants.js'

// The RFC 6455 codec and boundary guards — pure, exported, and exhaustively tested.
// `computeWebSocketAccept` derives the handshake token; the `isWebSocket*` guards
// validate upgrade/header invariants; `measureWebSocketFrame` and
// `parseWebSocketFrame` decode the next frame incrementally; `encodeWebSocketFrame`
// builds the inverse wire representation.
//
/**
 * Compute the `Sec-WebSocket-Accept` response value for an RFC 6455 upgrade.
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
 * if (!isWebSocketProtocol(protocol)) throw new RangeError('invalid protocol')
 * ```
 */
export function isWebSocketProtocol(protocol: string): boolean {
	return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol)
}

/**
 * Decode a single RFC 6455 frame from the front of a buffer.
 *
 * @remarks
 * Reads the FIN bit and opcode (byte 0), the mask bit and 7-bit payload length (byte
 * 1) — extended to a 16-bit length when the 7-bit field is `126`, or a 64-bit length
 * when it is `127` — the optional 4-byte mask key, then the payload, XOR-unmasking it
 * against the key when the mask bit is set (client→server frames MUST be masked, RFC
 * 6455 §5.3; an unmasked frame still decodes, leaving the payload as-is, so the caller
 * can enforce policy). Returns `undefined` the moment the buffer is too short for the
 * part it is up to (the length prefix, the mask, or the full payload) — the signal to
 * the caller to read more bytes and retry, exactly like {@link SSEParser} on a partial
 * line. `consumed` is the total bytes the frame occupied, so the caller slices the
 * remainder. Pure; never throws on a short buffer.
 *
 * @param buffer - The accumulation buffer to decode the next frame from
 * @returns The parsed {@link WebSocketFrame}, or `undefined` when the buffer is incomplete
 */
export function parseWebSocketFrame(buffer: Buffer): WebSocketFrame | undefined {
	if (buffer.length < 2) return undefined

	const firstByte = buffer.readUInt8(0)
	const secondByte = buffer.readUInt8(1)

	const fin = (firstByte & 0x80) !== 0
	const rsv = (firstByte & 0x70) >> 4
	const opcode = firstByte & 0x0f
	const masked = (secondByte & 0x80) !== 0
	let length = secondByte & 0x7f
	let offset = 2

	if (length === 126) {
		if (buffer.length < offset + 2) return undefined
		length = buffer.readUInt16BE(offset)
		offset += 2
	} else if (length === 127) {
		if (buffer.length < offset + 8) return undefined
		// Split into two 32-bit reads — a payload past 2^53 is beyond any real frame,
		// and this keeps the arithmetic in safe-integer range.
		const high = buffer.readUInt32BE(offset)
		const low = buffer.readUInt32BE(offset + 4)
		length = high * 0x1_0000_0000 + low
		offset += 8
	}

	let mask: Buffer | undefined
	if (masked) {
		if (buffer.length < offset + 4) return undefined
		mask = buffer.subarray(offset, offset + 4)
		offset += 4
	}

	if (buffer.length < offset + length) return undefined

	const payload = Buffer.alloc(length)
	buffer.copy(payload, 0, offset, offset + length)

	if (mask !== undefined) {
		for (let index = 0; index < length; index += 1) {
			payload[index] = payload.readUInt8(index) ^ mask.readUInt8(index % 4)
		}
	}

	return { fin, opcode, payload, consumed: offset + length, masked, rsv }
}

/**
 * Read the declared payload length off the front of a buffer, without buffering or
 * reading the payload itself.
 *
 * @remarks
 * Decodes only byte 1's 7-bit length field, extended by the 16-bit (`126`) or 64-bit
 * (`127`) form exactly like {@link parseWebSocketFrame} — but stops there, so a caller
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
 * if (declared !== undefined && declared > limit) fail(WEBSOCKET_CLOSE_TOOBIG)
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
 * Whether the next frame uses the shortest valid RFC 6455 payload-length encoding.
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
 * if (isWebSocketFrameCanonical(buffer) === false) fail(WEBSOCKET_CLOSE_PROTOCOL)
 * ```
 */
export function isWebSocketFrameCanonical(buffer: Buffer): boolean | undefined {
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
 * Decode a byte sequence as strict UTF-8, or signal it is malformed.
 *
 * @remarks
 * Wraps `TextDecoder('utf-8', { fatal: true })` in a try/catch so a malformed sequence
 * returns `undefined` instead of throwing (AGENTS §14 — a guard-adjacent coercer never
 * throws on bad input). Pure.
 *
 * @param bytes - The raw bytes to decode
 * @returns The decoded string, or `undefined` when `bytes` is not valid UTF-8
 *
 * @example
 * ```ts
 * const text = parseUTF8(payload)
 * if (text === undefined) fail(WEBSOCKET_CLOSE_INVALID)
 * ```
 */
export function parseUTF8(bytes: Buffer): string | undefined {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		return undefined
	}
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

/**
 * Encode a single RFC 6455 frame to its wire bytes — the inverse of
 * {@link parseWebSocketFrame}.
 *
 * @remarks
 * Builds a final (FIN-set) frame: byte 0 is `0x80 | opcode`; the payload length uses
 * the 7-bit form below 126, the `126` + 16-bit form below 65 536, or the `127` +
 * 64-bit form beyond; when `masked` is set the mask bit is set, a 4-byte key (supplied
 * via `options.mask`, else random) is written, and the payload is XOR-masked. Server→
 * client frames are unmasked (the default); pass `masked: true` to encode a CLIENT
 * frame (e.g. to feed the parser in a test). A `string` payload is encoded as UTF-8.
 * Returns one contiguous `Buffer` (header + payload), so the wrapper writes it with a
 * single `socket.write`. Pure.
 *
 * @param opcode - The frame opcode (a `WEBSOCKET_OPCODE_*` value)
 * @param payload - The payload, a `Buffer` or a UTF-8 `string`
 * @param options - Masking control ({@link WebSocketEncodeOptions}); defaults to unmasked
 * @returns The complete frame as wire bytes
 */
export function encodeWebSocketFrame(
	opcode: number,
	payload: Buffer | string,
	options?: WebSocketEncodeOptions,
): Buffer {
	if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0x0f) {
		throw new RangeError('opcode must be an integer between 0 and 15')
	}
	if (options?.mask !== undefined && options.mask.length !== 4) {
		throw new RangeError('mask must contain exactly 4 bytes')
	}
	if (options?.mask !== undefined && options.masked !== true) {
		throw new RangeError('mask requires masked: true')
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
