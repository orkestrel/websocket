import type { WebSocketFrame } from './types.js'

// The RFC 6455 coercers — pure reads off a wire buffer that answer `undefined` while
// the bytes they need are still incomplete, so the caller accumulates and retries.
// A coercion producing `T | undefined` is a `parse*`, never a guard: it answers about
// bytes that may not be there yet, where a guard is total. The pure reads and
// predicates that coerce nothing — `measureWebSocketFrame`, `matchesWebSocketCanonical`,
// `isWebSocketKey`, `isWebSocketProtocol`, `isCloseCode` — live in `helpers.ts`.

/**
 * Decodes a single RFC 6455 frame from the front of a buffer.
 *
 * @remarks
 * Reads the FIN bit and opcode (byte 0), the mask bit and 7-bit payload length (byte
 * 1) — extended to a 16-bit length when the 7-bit field is `126`, or a 64-bit length
 * when it is `127` — the optional 4-byte mask key, then the payload, XOR-unmasking it
 * against the key when the mask bit is set (client→server frames MUST be masked, RFC
 * 6455 §5.3; an unmasked frame still decodes, leaving the payload as-is, so the caller
 * can enforce policy). Returns `undefined` the moment the buffer is too short for the
 * part it is up to (the length prefix, the mask, or the full payload) — the signal to
 * the caller to read more bytes and retry. `consumed` is the total bytes the frame
 * occupied, so the caller slices the remainder. Pure; never throws on a short buffer.
 *
 * @param buffer - The accumulation buffer to decode the next frame from
 * @returns The parsed {@link WebSocketFrame}, or `undefined` when the buffer is incomplete
 *
 * @example
 * ```ts
 * const frame = parseWebSocketFrame(buffer)
 * if (frame === undefined) return // incomplete — wait for more bytes
 * ```
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
 * Decodes a byte sequence as strict UTF-8, or signals it is malformed.
 *
 * @remarks
 * Wraps `TextDecoder('utf-8', { fatal: true })` in a try/catch so a malformed sequence
 * returns `undefined` instead of throwing — a guard-adjacent coercer never throws on bad
 * input. Pure.
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
