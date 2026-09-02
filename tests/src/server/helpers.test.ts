import { describe, expect, it } from 'vitest'
import {
	computeWebSocketAccept,
	encodeWebSocketFrame,
	isWebSocketError,
	measureWebSocketFrame,
	WEBSOCKET_OPCODE_BINARY,
	WEBSOCKET_OPCODE_TEXT,
} from '@src/server'
import { captureError } from '@orkestrel/test'

// The remaining RFC 6455 codec helpers as pure units (no socket, AGENTS §16) —
// asserted against the spec's OWN worked byte vectors so the bit-level mechanics are
// pinned exactly: the handshake accept token (RFC 6455 §1.3), the unmasked + masked
// "Hello" frame encoding (§5.7), the 7/16/64-bit length-form boundaries, and
// `measureWebSocketFrame` reading the declared length off the header alone. The
// coercers (`parseWebSocketFrame`, `parseWebSocketCanonical`, `parseUTF8`) live in
// `parsers.test.ts`; the boundary guards (`isWebSocketKey`, `isWebSocketProtocol`,
// `isCloseCode`) live in `validators.test.ts`.

const HELLO = Buffer.from('Hello', 'utf-8') // 48 65 6c 6c 6f
const MASK = Buffer.from([0x37, 0xfa, 0x21, 0x3d]) // the RFC §5.7 example mask key

describe('computeWebSocketAccept', () => {
	it('derives the RFC 6455 §1.3 worked example accept token', () => {
		// The canonical handshake vector from the spec.
		expect(computeWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
	})

	it('is deterministic for a given key', () => {
		expect(computeWebSocketAccept('abc')).toBe(computeWebSocketAccept('abc'))
	})
})

describe('encodeWebSocketFrame — RFC byte vectors', () => {
	it('encodes a single-frame UNMASKED text "Hello" as 81 05 48 65 6c 6c 6f', () => {
		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO)
		expect([...wire]).toEqual([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f])
	})

	it('encodes a single-frame MASKED text "Hello" as 81 85 37 fa 21 3d 7f 9f 4d 51 58', () => {
		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO, { masked: true, mask: MASK })
		expect([...wire]).toEqual([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])
	})

	it('accepts a string payload identically to its Buffer', () => {
		expect(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'Hello')).toEqual(
			encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO),
		)
	})

	it('uses the 7-bit length form for a 125-byte payload (no extension bytes)', () => {
		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, Buffer.alloc(125))
		expect(wire[1]).toBe(125) // length fits the 7-bit field directly
		expect(wire.length).toBe(2 + 125)
	})

	it('uses the 126 + 16-bit length form at the 126-byte boundary', () => {
		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, Buffer.alloc(126))
		expect(wire[1]).toBe(126) // the "extended 16-bit length follows" marker
		expect(wire.readUInt16BE(2)).toBe(126)
		expect(wire.length).toBe(4 + 126)
	})

	it('uses the 127 + 64-bit length form at the 65536-byte boundary', () => {
		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, Buffer.alloc(65_536))
		expect(wire[1]).toBe(127) // the "extended 64-bit length follows" marker
		// High 32 bits zero, low 32 bits = 65536.
		expect(wire.readUInt32BE(2)).toBe(0)
		expect(wire.readUInt32BE(6)).toBe(65_536)
		expect(wire.length).toBe(10 + 65_536)
	})

	it('rejects opcodes outside the four-bit wire field with a FRAME WebSocketError', () => {
		for (const opcode of [-1, 16, 1.5]) {
			const caught = captureError(() => encodeWebSocketFrame(opcode, Buffer.alloc(0)))
			expect(isWebSocketError(caught) ? caught.code : 'not-websocket').toBe('FRAME')
			expect(isWebSocketError(caught) ? caught.context : undefined).toEqual({ opcode })
		}
	})

	it('requires an explicit mask to be exactly four bytes and enabled', () => {
		const short = captureError(() =>
			encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO, {
				masked: true,
				mask: Buffer.alloc(3),
			}),
		)
		expect(isWebSocketError(short) ? short.code : 'not-websocket').toBe('FRAME')
		expect(isWebSocketError(short) ? short.context : undefined).toEqual({ size: 3 })

		const unmasked = captureError(() =>
			encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO, { mask: Buffer.alloc(4) }),
		)
		expect(isWebSocketError(unmasked) ? unmasked.code : 'not-websocket').toBe('FRAME')
		expect(isWebSocketError(unmasked) ? unmasked.context : undefined).toBeUndefined()
	})
})

describe('measureWebSocketFrame', () => {
	it('reads the 7-bit length form without needing the payload', () => {
		const header = Buffer.from([0x81, 0x05]) // len 5, no payload bytes present
		expect(measureWebSocketFrame(header)).toBe(5)
	})

	it('reads the 126 + 16-bit extended length form', () => {
		const header = Buffer.alloc(4)
		header[0] = 0x82
		header[1] = 126
		header.writeUInt16BE(300, 2)
		expect(measureWebSocketFrame(header)).toBe(300)
	})

	it('reads the 127 + 64-bit extended length form', () => {
		const header = Buffer.alloc(10)
		header[0] = 0x82
		header[1] = 127
		header.writeUInt32BE(0, 2)
		header.writeUInt32BE(70_000, 6)
		expect(measureWebSocketFrame(header)).toBe(70_000)
	})

	it('returns undefined when fewer than 2 header bytes are buffered', () => {
		expect(measureWebSocketFrame(Buffer.from([0x81]))).toBeUndefined()
	})

	it('returns undefined when the 16-bit extended length is split mid-header', () => {
		expect(measureWebSocketFrame(Buffer.from([0x82, 126, 0x01]))).toBeUndefined()
	})

	it('returns undefined when the 64-bit extended length is split mid-header', () => {
		expect(measureWebSocketFrame(Buffer.from([0x82, 127, 0, 0, 0, 0, 0]))).toBeUndefined()
	})
})
