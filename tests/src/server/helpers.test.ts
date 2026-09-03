import { describe, expect, it } from 'vitest'
import {
	computeWebSocketAccept,
	encodeWebSocketFrame,
	isCloseCode,
	isWebSocketError,
	isWebSocketKey,
	isWebSocketProtocol,
	matchesWebSocketCanonical,
	measureWebSocketFrame,
	WEBSOCKET_OPCODE_BINARY,
	WEBSOCKET_OPCODE_TEXT,
} from '@src/server'
import { captureError } from '@orkestrel/test'

// The RFC 6455 codec helpers and boundary predicates as pure units — no socket, real
// implementations only — asserted against the spec's OWN worked byte vectors so the
// bit-level mechanics are pinned exactly: the handshake accept token (RFC 6455 §1.3), the
// unmasked + masked "Hello" frame encoding (§5.7), the 7/16/64-bit length-form
// boundaries, `measureWebSocketFrame` reading the declared length off the header alone,
// `matchesWebSocketCanonical`'s §5.2 minimal-length-encoding check, and the total
// predicates over caller-supplied handshake and close values. The coercers
// (`parseWebSocketFrame`, `parseUTF8`) live in `parsers.test.ts`.

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

// The RFC 6455 §5.2 minimal-length-encoding predicate as a pure unit (no socket).
// `matchesWebSocketCanonical` answers `undefined` while the length prefix is still
// incomplete, `true` for each shortest form, and `false` for a non-minimal extended
// length or a set 64-bit high bit. The canonical frames come from
// `encodeWebSocketFrame`, which picks the shortest form independently, so the
// assertion compares two mechanisms rather than re-deriving the answer.

describe('matchesWebSocketCanonical', () => {
	it('accepts each shortest length form and waits for an incomplete prefix', () => {
		expect(matchesWebSocketCanonical(Buffer.from([0x81]))).toBeUndefined()
		expect(matchesWebSocketCanonical(Buffer.from([0x81, 125]))).toBe(true)
		expect(
			matchesWebSocketCanonical(encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, Buffer.alloc(126))),
		).toBe(true)
		expect(
			matchesWebSocketCanonical(
				encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, Buffer.alloc(65_536)),
			),
		).toBe(true)
	})

	it('rejects non-minimal extended lengths and a set 64-bit high bit', () => {
		const nonMinimal16 = Buffer.from([0x81, 126, 0, 125])
		const nonMinimal64 = Buffer.alloc(10)
		nonMinimal64.writeUInt8(0x81, 0)
		nonMinimal64.writeUInt8(127, 1)
		nonMinimal64.writeUInt32BE(0, 2)
		nonMinimal64.writeUInt32BE(65_535, 6)
		const highBit = Buffer.alloc(10)
		highBit.writeUInt8(0x81, 0)
		highBit.writeUInt8(127, 1)
		highBit.writeUInt32BE(0x8000_0000, 2)

		expect(matchesWebSocketCanonical(nonMinimal16)).toBe(false)
		expect(matchesWebSocketCanonical(nonMinimal64)).toBe(false)
		expect(matchesWebSocketCanonical(highBit)).toBe(false)
	})

	it('waits for the extended length prefix before ruling', () => {
		expect(matchesWebSocketCanonical(Buffer.from([0x81, 126, 0]))).toBeUndefined()
		expect(matchesWebSocketCanonical(Buffer.from([0x81, 127, 0, 0, 0, 0, 0]))).toBeUndefined()
	})
})

describe('handshake value guards', () => {
	it('accepts only canonical 16-byte Sec-WebSocket-Key values', () => {
		expect(isWebSocketKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe(true)
		expect(isWebSocketKey('abc')).toBe(false)
		expect(isWebSocketKey('dGhlIHNhbXBsZSBub25jZQ=')).toBe(false)
		expect(isWebSocketKey('dGhlIHNhbXBsZSBub25jZQ==\r\n')).toBe(false)
	})

	it('accepts one HTTP token and rejects separators or header injection', () => {
		expect(isWebSocketProtocol('mcp.v1')).toBe(true)
		expect(isWebSocketProtocol('')).toBe(false)
		expect(isWebSocketProtocol('mcp, other')).toBe(false)
		expect(isWebSocketProtocol('mcp\r\nX-Injected: true')).toBe(false)
	})
})

describe('isCloseCode', () => {
	it('accepts valid RFC 6455 receivable codes', () => {
		expect(isCloseCode(1000)).toBe(true)
		expect(isCloseCode(1009)).toBe(true)
		expect(isCloseCode(3000)).toBe(true)
	})

	it('accepts the IANA-registered 1012-1014 interop extension', () => {
		expect(isCloseCode(1012)).toBe(true)
		expect(isCloseCode(1014)).toBe(true)
	})

	it('rejects reserved-for-local-use-only and unassigned codes', () => {
		expect(isCloseCode(1005)).toBe(false)
		expect(isCloseCode(1006)).toBe(false)
		expect(isCloseCode(999)).toBe(false)
		expect(isCloseCode(1004)).toBe(false)
		expect(isCloseCode(1000.5)).toBe(false)
	})
})

describe('codec properties — close-code classification', () => {
	it('classifies every code 999..5000 exactly per RFC 6455 §7.4.1 + the 1012-1014 extension', () => {
		for (let code = 999; code <= 5000; code += 1) {
			const expected =
				(code >= 1000 && code <= 1003) ||
				(code >= 1007 && code <= 1014) ||
				(code >= 3000 && code <= 4999)
			expect(isCloseCode(code)).toBe(expected)
		}
		// Explicit call-outs for the reserved-for-local-use-only / unassigned codes.
		for (const code of [1004, 1005, 1006, 1015]) expect(isCloseCode(code)).toBe(false)
		for (const code of [1016, 2000, 2999]) expect(isCloseCode(code)).toBe(false)
	})
})
