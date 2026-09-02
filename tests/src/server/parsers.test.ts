import { describe, expect, it } from 'vitest'
import {
	encodeWebSocketFrame,
	measureWebSocketFrame,
	parseUTF8,
	parseWebSocketCanonical,
	parseWebSocketFrame,
	WEBSOCKET_OPCODE_BINARY,
	WEBSOCKET_OPCODE_CLOSE,
	WEBSOCKET_OPCODE_PING,
	WEBSOCKET_OPCODE_PONG,
	WEBSOCKET_OPCODE_TEXT,
} from '@src/server'
import { seededRandom } from '@orkestrel/contract'
import { requireValue } from '@orkestrel/test'
import { buildText } from '../../setup.js'
import { frame, randomBuffer } from '../../setupServer.js'

// The RFC 6455 coercers as pure units (no socket, AGENTS §16) — asserted against the
// spec's OWN worked byte vectors so the bit-level mechanics are pinned exactly: the
// unmasked + masked "Hello" frames (§5.7), the 7/16/64-bit length-form boundaries, the
// control opcodes, an INCOMPLETE buffer returning `undefined` until the frame is
// whole, a frame followed by trailing bytes (so `consumed` lets the caller recover the
// remainder), the encode↔parse inverse for masked and unmasked frames, valid and
// malformed UTF-8, and the §5.2 minimal-length-encoding check. Determinism comes from
// a SUPPLIED mask, so a "client" frame is byte-exact.

const HELLO = Buffer.from('Hello', 'utf-8') // 48 65 6c 6c 6f
const MASK = Buffer.from([0x37, 0xfa, 0x21, 0x3d]) // the RFC §5.7 example mask key

describe('parseWebSocketFrame — RFC byte vectors', () => {
	it('parses the unmasked "Hello" frame', () => {
		const parsed = parseWebSocketFrame(Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]))
		expect(parsed).toBeDefined()
		expect(parsed?.fin).toBe(true)
		expect(parsed?.opcode).toBe(WEBSOCKET_OPCODE_TEXT)
		expect(parsed?.payload.toString('utf-8')).toBe('Hello')
		expect(parsed?.consumed).toBe(7)
	})

	it('parses + unmasks the masked "Hello" frame to "Hello"', () => {
		const parsed = parseWebSocketFrame(
			Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]),
		)
		expect(parsed?.payload.toString('utf-8')).toBe('Hello')
		expect(parsed?.consumed).toBe(11)
	})

	it('decodes the ping / pong / close opcodes', () => {
		for (const opcode of [WEBSOCKET_OPCODE_PING, WEBSOCKET_OPCODE_PONG, WEBSOCKET_OPCODE_CLOSE]) {
			const parsed = parseWebSocketFrame(encodeWebSocketFrame(opcode, Buffer.alloc(0)))
			expect(parsed?.opcode).toBe(opcode)
			expect(parsed?.fin).toBe(true)
		}
	})

	it('reads the FIN=false continuation bit', () => {
		// A non-final text fragment: FIN cleared, opcode TEXT.
		const fragment = Buffer.from([0x01, 0x01, 0x41]) // 0x01 = fin:0|text, len 1, 'A'
		const parsed = parseWebSocketFrame(fragment)
		expect(parsed?.fin).toBe(false)
		expect(parsed?.opcode).toBe(WEBSOCKET_OPCODE_TEXT)
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

		const parsed = parseWebSocketFrame(stream)
		expect(parsed?.payload.toString('utf-8')).toBe('one')
		expect(parsed?.consumed).toBe(first.length)

		// The caller slices `consumed` and re-parses the remainder.
		const rest = stream.subarray(requireValue(parsed).consumed)
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
			const parsed = parseWebSocketFrame(encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, payload))
			expect(parsed?.opcode).toBe(WEBSOCKET_OPCODE_BINARY)
			expect(parsed?.fin).toBe(true)
			expect(parsed?.payload.equals(payload)).toBe(true)
		}
	})

	it('round-trips MASKED frames (client→server) at every length form', () => {
		for (const payload of payloads) {
			const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, payload, { masked: true })
			const parsed = parseWebSocketFrame(wire)
			// The parser unmasks, recovering the original bytes regardless of the random key.
			expect(parsed?.payload.equals(payload)).toBe(true)
			expect(parsed?.consumed).toBe(wire.length)
		}
	})

	it('a supplied mask makes a masked frame byte-deterministic', () => {
		const a = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO, { masked: true, mask: MASK })
		const b = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO, { masked: true, mask: MASK })
		expect(a.equals(b)).toBe(true)
	})
})

describe('parseWebSocketFrame — masked / rsv surfaced', () => {
	it('surfaces masked: true and rsv: 0 for a masked frame with no extension bits', () => {
		const parsed = parseWebSocketFrame(
			encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO, { masked: true }),
		)
		expect(parsed?.masked).toBe(true)
		expect(parsed?.rsv).toBe(0)
	})

	it('surfaces masked: false for an unmasked frame', () => {
		const parsed = parseWebSocketFrame(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO))
		expect(parsed?.masked).toBe(false)
	})

	it('surfaces a non-zero rsv decoded from byte 0 bits 4-6 (>> 4, not >> 3)', () => {
		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, HELLO, { masked: true })
		wire.writeUInt8(wire.readUInt8(0) | 0x70, 0) // set RSV1+RSV2+RSV3
		const parsed = parseWebSocketFrame(wire)
		expect(parsed?.rsv).toBe(7)
	})
})

describe('parseUTF8', () => {
	it('decodes a valid UTF-8 byte sequence', () => {
		expect(parseUTF8(Buffer.from('héllo wörld', 'utf-8'))).toBe('héllo wörld')
	})

	it('decodes an empty buffer to an empty string', () => {
		expect(parseUTF8(Buffer.alloc(0))).toBe('')
	})

	it('returns undefined for a lone continuation byte (invalid UTF-8)', () => {
		expect(parseUTF8(Buffer.from([0x80]))).toBeUndefined()
	})

	it('returns undefined for a truncated multi-byte sequence', () => {
		expect(parseUTF8(Buffer.from([0xff, 0xfe]))).toBeUndefined()
	})
})

// ── A-CODEC — seeded fuzz/property battery over the pure coercers ────────────
//
// Every case here asserts the REAL invariant (round-trip equality, exact undefined,
// ordering between `measure` and `parse`) rather than a "does not throw" placeholder.
// A failure here is a potential codec bug, not a test to loosen (AGENTS §16 / the
// battery spec's recorder-not-mock discipline extends to fuzz assertions too).

// A bounded corpus spanning every length-form boundary: the 7-bit form (0, 1, 125),
// the 126 + 16-bit boundary (126, 127, 65535), the 127 + 64-bit boundary (65536), plus
// ~5 large payloads up to 200 KB — ~180 payloads total from a single seeded generator.
function buildCorpus(): readonly Buffer[] {
	const rng = seededRandom(1)
	const lengths = [0, 1, 125, 126, 127, 65_535, 65_536]
	const large = [70_000, 90_000, 120_000, 150_000, 200_000]
	const corpus: Buffer[] = []
	for (const length of lengths) {
		for (let index = 0; index < 25; index += 1) corpus.push(randomBuffer(rng, length))
	}
	for (const length of large) corpus.push(randomBuffer(rng, length))
	return corpus
}

describe('codec properties — seeded round trips', () => {
	const corpus = buildCorpus()

	it('round-trips a seeded random corpus at every length form (unmasked)', () => {
		for (const payload of corpus) {
			const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, payload)
			const parsed = parseWebSocketFrame(wire)
			expect(parsed).toBeDefined()
			expect(parsed?.fin).toBe(true)
			expect(parsed?.opcode).toBe(WEBSOCKET_OPCODE_BINARY)
			expect(parsed?.payload.equals(payload)).toBe(true)
		}
	})

	it('round-trips the same corpus masked (client→server)', () => {
		for (const payload of corpus) {
			const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, payload, { masked: true })
			const parsed = parseWebSocketFrame(wire)
			expect(parsed?.payload.equals(payload)).toBe(true)
			expect(parsed?.consumed).toBe(wire.length)
		}
	})
})

describe('codec properties — incomplete input', () => {
	it('never throws on every truncation of a valid frame (returns undefined, never a partial)', () => {
		const rng = seededRandom(3)
		const wires = [
			frame(WEBSOCKET_OPCODE_TEXT, randomBuffer(rng, 5)), // 7-bit form, unmasked
			frame(WEBSOCKET_OPCODE_TEXT, randomBuffer(rng, 5), { masked: true }), // 7-bit form, masked
			frame(WEBSOCKET_OPCODE_BINARY, randomBuffer(rng, 126)), // 126 + 16-bit form, unmasked
			frame(WEBSOCKET_OPCODE_BINARY, randomBuffer(rng, 126), { masked: true }), // 126 + 16-bit, masked
			frame(WEBSOCKET_OPCODE_BINARY, randomBuffer(rng, 65_536)), // 127 + 64-bit form, unmasked
			frame(WEBSOCKET_OPCODE_BINARY, randomBuffer(rng, 65_536), { masked: true }), // 127 + 64-bit, masked
		]
		for (const wire of wires) {
			// Iterate EVERY truncation offset, but aggregate to a single assertion per
			// wire (instead of one expect() per offset) so the ~131k-call matcher
			// overhead doesn't blow the test timeout — full byte-level coverage is
			// preserved, and a failure still reports the offending offset.
			let firstThrow: number | undefined
			let firstDefined: number | undefined
			for (let cut = 0; cut < wire.length; cut += 1) {
				try {
					const result = parseWebSocketFrame(wire.subarray(0, cut))
					if (result !== undefined && firstDefined === undefined) firstDefined = cut
				} catch {
					if (firstThrow === undefined) firstThrow = cut
				}
			}
			expect(firstThrow).toBeUndefined()
			expect(firstDefined).toBeUndefined()
			// The whole wire parses.
			expect(parseWebSocketFrame(wire)).toBeDefined()
		}
	})

	it('never throws on arbitrary random buffers — result is undefined or well-formed', () => {
		const rng = seededRandom(2)
		for (let index = 0; index < 1000; index += 1) {
			const length = Math.floor(rng() * 301)
			const buffer = randomBuffer(rng, length)
			expect(() => parseWebSocketFrame(buffer)).not.toThrow()
			const parsed = parseWebSocketFrame(buffer)
			if (parsed === undefined) continue
			expect(parsed.consumed).toBeLessThanOrEqual(buffer.length)
			expect(parsed.payload.length).toBeGreaterThanOrEqual(0)
			expect(typeof parsed.fin).toBe('boolean')
			expect(typeof parsed.opcode).toBe('number')
		}
	})
})

describe('codec properties — measurement and parsing agree', () => {
	it('measures the declared length across forms and agrees with parse', () => {
		const rng = seededRandom(4)
		const cases: ReadonlyArray<{ readonly length: number; readonly masked: boolean }> = [
			{ length: 10, masked: false },
			{ length: 10, masked: true },
			{ length: 200, masked: false },
			{ length: 200, masked: true },
			{ length: 70_000, masked: false },
			{ length: 70_000, masked: true },
		]
		for (const { length, masked } of cases) {
			const payload = randomBuffer(rng, length)
			const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, payload, { masked })
			const measured = measureWebSocketFrame(wire)
			const parsed = requireValue(parseWebSocketFrame(wire))
			expect(measured).toBe(parsed.payload.length)
			const headerWidth = parsed.consumed - parsed.payload.length
			const expectedWidths = masked ? [6, 8, 14] : [2, 4, 10]
			expect(expectedWidths).toContain(headerWidth)
		}
	})

	it('resolves the declared length as soon as the length PREFIX is buffered — earlier than parse', () => {
		const rng = seededRandom(5)
		const payload = randomBuffer(rng, 300)
		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, payload, { masked: true }) // 126-form + mask

		// Only 1 header byte: neither measure nor parse can know the length yet.
		expect(measureWebSocketFrame(wire.subarray(0, 1))).toBeUndefined()
		expect(parseWebSocketFrame(wire.subarray(0, 1))).toBeUndefined()

		// Exactly the 4-byte length prefix (2 base + 2 extended) buffered: measure now
		// resolves the declared length, but parse is still undefined (mask + payload
		// bytes are absent) — measure resolves strictly earlier than parse.
		expect(measureWebSocketFrame(wire.subarray(0, 4))).toBe(300)
		expect(parseWebSocketFrame(wire.subarray(0, 4))).toBeUndefined()

		// The full wire: parse now agrees with what measure already reported.
		expect(parseWebSocketFrame(wire)?.payload.length).toBe(300)
	})
})

describe('codec properties — mask XOR is an involution', () => {
	it('masking then unmasking with the same key recovers the original bytes', () => {
		const rng = seededRandom(6)
		for (let index = 0; index < 100; index += 1) {
			const length = Math.floor(rng() * 200)
			const buf = randomBuffer(rng, length)
			const mask = randomBuffer(rng, 4)
			const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, buf, { masked: true, mask })
			const parsed = parseWebSocketFrame(wire)
			expect(parsed?.payload.equals(buf)).toBe(true)

			// Direct XOR involution over the corpus: (b^m)^m === b.
			const once = Buffer.alloc(length)
			const twice = Buffer.alloc(length)
			for (let byte = 0; byte < length; byte += 1) {
				const b = buf.readUInt8(byte)
				const m = mask.readUInt8(byte % 4)
				once[byte] = b ^ m
				twice[byte] = once.readUInt8(byte) ^ m
			}
			expect(twice.equals(buf)).toBe(true)
		}
	})
})

describe('codec properties — UTF-8 acceptance', () => {
	it('decodes a valid UTF-8 corpus (buildText samples + known multibyte) exactly', () => {
		const rng = seededRandom(7)
		for (let index = 0; index < 20; index += 1) {
			const text = buildText(rng, Math.floor(rng() * 40))
			const bytes = Buffer.from(text, 'utf-8')
			expect(parseUTF8(bytes)).toBe(text)
		}
		const known = ['héllo wörld', '日本語', '🎉multi-byte🎉', 'naïve café', 'Ω≈ç√∫']
		for (const text of known) {
			expect(parseUTF8(Buffer.from(text, 'utf-8'))).toBe(text)
		}
	})

	it('rejects malformed UTF-8: overlong, lone surrogate bytes, truncated multibyte, stray continuation', () => {
		const malformed = [
			Buffer.from([0xc0, 0x80]), // overlong encoding of NUL
			Buffer.from([0xe0, 0x80, 0x80]), // overlong 3-byte encoding
			Buffer.from([0xed, 0xa0, 0x80]), // lone surrogate (U+D800) encoded as UTF-8 bytes
			Buffer.from([0xe4, 0xb8]), // truncated 3-byte multibyte sequence
			Buffer.from([0x80]), // stray continuation byte with no lead byte
		]
		for (const bytes of malformed) {
			expect(parseUTF8(bytes)).toBeUndefined()
		}
	})
})

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
