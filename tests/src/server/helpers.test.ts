import { describe, expect, it } from 'vitest'
import {
	computeWebSocketAccept,
	encodeWebSocketFrame,
	parseWebSocketFrame,
	WEBSOCKET_OPCODE_BINARY,
	WEBSOCKET_OPCODE_CLOSE,
	WEBSOCKET_OPCODE_PING,
	WEBSOCKET_OPCODE_PONG,
	WEBSOCKET_OPCODE_TEXT,
} from '@src/server'

// The RFC 6455 codec as pure units (no socket, AGENTS §16) — asserted against the
// spec's OWN worked byte vectors so the bit-level mechanics are pinned exactly:
// the handshake accept token (RFC 6455 §1.3), the unmasked + masked "Hello" frames
// (§5.7), the 7/16/64-bit length-form boundaries, the control opcodes, an INCOMPLETE
// buffer returning `undefined` until the frame is whole, a frame followed by trailing
// bytes (so `consumed` lets the caller recover the remainder), and the encode↔parse
// inverse for masked and unmasked frames. Determinism comes from a SUPPLIED mask, so a
// "client" frame is byte-exact.

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
		const frame = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO)
		expect([...frame]).toEqual([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f])
	})

	it('encodes a single-frame MASKED text "Hello" as 81 85 37 fa 21 3d 7f 9f 4d 51 58', () => {
		const frame = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO, { masked: true, mask: MASK })
		expect([...frame]).toEqual([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])
	})

	it('accepts a string payload identically to its Buffer', () => {
		expect(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'Hello')).toEqual(
			encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO),
		)
	})

	it('uses the 7-bit length form for a 125-byte payload (no extension bytes)', () => {
		const frame = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, Buffer.alloc(125))
		expect(frame[1]).toBe(125) // length fits the 7-bit field directly
		expect(frame.length).toBe(2 + 125)
	})

	it('uses the 126 + 16-bit length form at the 126-byte boundary', () => {
		const frame = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, Buffer.alloc(126))
		expect(frame[1]).toBe(126) // the "extended 16-bit length follows" marker
		expect(frame.readUInt16BE(2)).toBe(126)
		expect(frame.length).toBe(4 + 126)
	})

	it('uses the 127 + 64-bit length form at the 65536-byte boundary', () => {
		const frame = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, Buffer.alloc(65_536))
		expect(frame[1]).toBe(127) // the "extended 64-bit length follows" marker
		// High 32 bits zero, low 32 bits = 65536.
		expect(frame.readUInt32BE(2)).toBe(0)
		expect(frame.readUInt32BE(6)).toBe(65_536)
		expect(frame.length).toBe(10 + 65_536)
	})
})

describe('parseWebSocketFrame — RFC byte vectors', () => {
	it('parses the unmasked "Hello" frame', () => {
		const frame = parseWebSocketFrame(Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]))
		expect(frame).toBeDefined()
		expect(frame?.fin).toBe(true)
		expect(frame?.opcode).toBe(WEBSOCKET_OPCODE_TEXT)
		expect(frame?.payload.toString('utf-8')).toBe('Hello')
		expect(frame?.consumed).toBe(7)
	})

	it('parses + unmasks the masked "Hello" frame to "Hello"', () => {
		const frame = parseWebSocketFrame(
			Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]),
		)
		expect(frame?.payload.toString('utf-8')).toBe('Hello')
		expect(frame?.consumed).toBe(11)
	})

	it('decodes the ping / pong / close opcodes', () => {
		for (const opcode of [WEBSOCKET_OPCODE_PING, WEBSOCKET_OPCODE_PONG, WEBSOCKET_OPCODE_CLOSE]) {
			const frame = parseWebSocketFrame(encodeWebSocketFrame(opcode, Buffer.alloc(0)))
			expect(frame?.opcode).toBe(opcode)
			expect(frame?.fin).toBe(true)
		}
	})

	it('reads the FIN=false continuation bit', () => {
		// A non-final text fragment: FIN cleared, opcode TEXT.
		const fragment = Buffer.from([0x01, 0x01, 0x41]) // 0x01 = fin:0|text, len 1, 'A'
		const frame = parseWebSocketFrame(fragment)
		expect(frame?.fin).toBe(false)
		expect(frame?.opcode).toBe(WEBSOCKET_OPCODE_TEXT)
	})
})

describe('parseWebSocketFrame — incomplete buffers return undefined', () => {
	it('returns undefined for fewer than 2 header bytes', () => {
		expect(parseWebSocketFrame(Buffer.from([0x81]))).toBeUndefined()
	})

	it('returns undefined when the 16-bit extended length is split mid-header', () => {
		// Says "126" (16-bit length follows) but only one of the two length bytes present.
		expect(parseWebSocketFrame(Buffer.from([0x82, 0x7e, 0x00]))).toBeUndefined()
	})

	it('returns undefined when the mask key is incomplete', () => {
		// Masked frame, length 5, but only 2 of the 4 mask bytes present.
		expect(parseWebSocketFrame(Buffer.from([0x81, 0x85, 0x37, 0xfa]))).toBeUndefined()
	})

	it('returns undefined when the payload is split mid-body, then parses once complete', () => {
		const full = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO) // 7 bytes
		// Every prefix shorter than the whole frame is incomplete.
		for (let cut = 1; cut < full.length; cut += 1) {
			expect(parseWebSocketFrame(full.subarray(0, cut))).toBeUndefined()
		}
		expect(parseWebSocketFrame(full)?.payload.toString('utf-8')).toBe('Hello')
	})
})

describe('parseWebSocketFrame — trailing bytes', () => {
	it('consumes only its own frame, leaving the remainder for the next parse', () => {
		const first = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, Buffer.from('one'))
		const second = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, Buffer.from('two'))
		const stream = Buffer.concat([first, second])

		const frame = parseWebSocketFrame(stream)
		expect(frame?.payload.toString('utf-8')).toBe('one')
		expect(frame?.consumed).toBe(first.length)

		// The caller slices `consumed` and re-parses the remainder.
		const rest = stream.subarray(frame?.consumed ?? 0)
		expect(parseWebSocketFrame(rest)?.payload.toString('utf-8')).toBe('two')
	})
})

describe('encode ↔ parse are inverses', () => {
	const payloads: readonly Buffer[] = [
		Buffer.alloc(0),
		Buffer.from('short'),
		Buffer.alloc(125, 0x61),
		Buffer.alloc(126, 0x62), // 16-bit length boundary
		Buffer.alloc(200, 0x63),
		Buffer.alloc(65_535, 0x64), // last 16-bit length
		Buffer.alloc(65_536, 0x65), // first 64-bit length
	]

	it('round-trips UNMASKED frames (server→client) at every length form', () => {
		for (const payload of payloads) {
			const frame = parseWebSocketFrame(encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, payload))
			expect(frame?.opcode).toBe(WEBSOCKET_OPCODE_BINARY)
			expect(frame?.fin).toBe(true)
			expect(frame?.payload.equals(payload)).toBe(true)
		}
	})

	it('round-trips MASKED frames (client→server) at every length form', () => {
		for (const payload of payloads) {
			const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, payload, { masked: true })
			const frame = parseWebSocketFrame(wire)
			// The parser unmasks, recovering the original bytes regardless of the random key.
			expect(frame?.payload.equals(payload)).toBe(true)
			expect(frame?.consumed).toBe(wire.length)
		}
	})

	it('a supplied mask makes a masked frame byte-deterministic', () => {
		const a = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO, { masked: true, mask: MASK })
		const b = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO, { masked: true, mask: MASK })
		expect(a.equals(b)).toBe(true)
	})
})
