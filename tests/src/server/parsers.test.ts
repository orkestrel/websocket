import { describe, expect, it } from 'vitest'
import { encodeWebSocketFrame, parseWebSocketCanonical, WEBSOCKET_OPCODE_BINARY } from '@src/server'

// The RFC 6455 §5.2 minimal-length-encoding coercer as a pure unit (no socket, AGENTS
// §16). `parseWebSocketCanonical` answers `undefined` while the length prefix is still
// incomplete, `true` for each shortest form, and `false` for a non-minimal extended
// length or a set 64-bit high bit. The canonical frames come from
// `encodeWebSocketFrame`, which picks the shortest form independently, so the
// assertion compares two mechanisms rather than re-deriving the answer.

describe('parseWebSocketCanonical', () => {
	it('accepts each shortest length form and waits for an incomplete prefix', () => {
		expect(parseWebSocketCanonical(Buffer.from([0x81]))).toBeUndefined()
		expect(parseWebSocketCanonical(Buffer.from([0x81, 125]))).toBe(true)
		expect(
			parseWebSocketCanonical(encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, Buffer.alloc(126))),
		).toBe(true)
		expect(
			parseWebSocketCanonical(encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, Buffer.alloc(65_536))),
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

		expect(parseWebSocketCanonical(nonMinimal16)).toBe(false)
		expect(parseWebSocketCanonical(nonMinimal64)).toBe(false)
		expect(parseWebSocketCanonical(highBit)).toBe(false)
	})

	it('waits for the extended length prefix before ruling', () => {
		expect(parseWebSocketCanonical(Buffer.from([0x81, 126, 0]))).toBeUndefined()
		expect(parseWebSocketCanonical(Buffer.from([0x81, 127, 0, 0, 0, 0, 0]))).toBeUndefined()
	})
})
