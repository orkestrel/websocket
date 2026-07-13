import type { WebSocketEncodeOptions, WebSocketFrame } from './types.js'
import { createHash, randomBytes } from 'node:crypto'
import { WEBSOCKET_GUID } from './constants.js'

// The RFC 6455 codec — three pure, exported, exhaustively unit-tested functions that
// are the entire bit-level surface of the WebSocket wrapper (AGENTS §5: the codec
// branches are exported helpers, not hidden privates). `computeWebSocketAccept`
// derives the handshake token; `parseWebSocketFrame` decodes ONE frame off a buffer,
// returning `undefined` when the buffer holds an incomplete frame so the caller
// accumulates across `data` chunks (the same streaming-decoder contract as the core
// `SSEParser`); `encodeWebSocketFrame` is the inverse — it builds the wire bytes for a
// frame. `parse` and `encode` are exact inverses, proven by the round-trip tests.
//
// Numeric byte reads are narrowed with `?? 0` rather than `!` (AGENTS §14): a read
// past the buffer is impossible once the length guards pass, and `?? 0` keeps the
// arithmetic total without an assertion.

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

	const firstByte = buffer[0] ?? 0
	const secondByte = buffer[1] ?? 0

	const fin = (firstByte & 0x80) !== 0
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
			payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
		}
	}

	return { fin, opcode, payload, consumed: offset + length }
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
		maskedBody[index] = (body[index] ?? 0) ^ (mask[index % 4] ?? 0)
	}
	return Buffer.concat([header, maskedBody])
}
