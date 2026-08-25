// Proof of `tests/setupServer.ts` — the Node-only fixtures the server source tests share:
// a cross-wired in-memory Duplex pair, a propagation wait, deterministic random bytes, a
// FIN-controllable frame encoder, and a client-frame collector. Real `node:stream` Duplex
// instances drive every case; nothing here is replaced.

import { describe, expect, it } from 'vitest'
import { encodeWebSocketFrame, WEBSOCKET_OPCODE_BINARY, WEBSOCKET_OPCODE_TEXT } from '@src/server'
import { duplexPair, flushSocket, frame, randomBuffer, readClientFrames } from './setupServer.js'

describe('duplexPair', () => {
	it('cross-wires real Duplex ends: each end reads what its partner writes, both directions', async () => {
		const [a, b] = duplexPair()
		const received: Buffer[] = []
		b.on('data', (chunk: Buffer) => received.push(chunk))
		a.write(Buffer.from('to-b'))
		await flushSocket()
		expect(Buffer.concat(received).toString()).toBe('to-b')

		received.length = 0
		a.on('data', (chunk: Buffer) => received.push(chunk))
		b.write(Buffer.from('to-a'))
		await flushSocket()
		expect(Buffer.concat(received).toString()).toBe('to-a')
	})
})

describe('flushSocket', () => {
	it('resolves only after two elapsed setImmediate ticks, not synchronously', async () => {
		let firstTickRan = false
		let secondTickRan = false
		setImmediate(() => {
			firstTickRan = true
			setImmediate(() => {
				secondTickRan = true
			})
		})

		const pending = flushSocket()
		expect(firstTickRan).toBe(false)
		expect(secondTickRan).toBe(false)

		await pending
		expect(firstTickRan).toBe(true)
		expect(secondTickRan).toBe(true)
	})
})

describe('randomBuffer', () => {
	it('returns `length` bytes, each an integer in 0..255, deterministic for a repeated rng', () => {
		let calls = 0
		const rng = (): number => {
			calls += 1
			return (calls % 251) / 251
		}
		const first = randomBuffer(rng, 16)
		calls = 0
		const second = randomBuffer(rng, 16)
		expect(first.length).toBe(16)
		expect(first.equals(second)).toBe(true)
		for (const byte of first) {
			expect(Number.isInteger(byte)).toBe(true)
			expect(byte).toBeGreaterThanOrEqual(0)
			expect(byte).toBeLessThanOrEqual(255)
		}
	})

	it('floors an rng of 0 to byte 0 and an rng just under 1 to byte 255, the documented boundary', () => {
		expect(randomBuffer(() => 0, 4).equals(Buffer.from([0, 0, 0, 0]))).toBe(true)
		expect(randomBuffer(() => 255 / 256, 4).equals(Buffer.from([255, 255, 255, 255]))).toBe(true)
	})

	it('returns an empty buffer for zero length', () => {
		expect(randomBuffer(() => 0.5, 0).length).toBe(0)
	})
})

describe('frame', () => {
	it('matches the real encoder when fin is omitted or true', () => {
		const payload = Buffer.from('hello')
		const baseline = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, payload, { masked: false })
		expect(frame(WEBSOCKET_OPCODE_TEXT, payload, { masked: false }).equals(baseline)).toBe(true)
		expect(
			frame(WEBSOCKET_OPCODE_TEXT, payload, { masked: false, fin: true }).equals(baseline),
		).toBe(true)
	})

	it('clears only the FIN bit of the first byte when fin is false, keeping every other bit', () => {
		const payload = Buffer.from('fragment')
		const baseline = encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, payload, { masked: false })
		const unfinished = frame(WEBSOCKET_OPCODE_BINARY, payload, { masked: false, fin: false })

		expect(unfinished.readUInt8(0) & 0x80).toBe(0)
		expect(unfinished.readUInt8(0) & 0x7f).toBe(baseline.readUInt8(0) & 0x7f)
		expect(unfinished.subarray(1).equals(baseline.subarray(1))).toBe(true)
	})
})

describe('readClientFrames', () => {
	it('strips the handshake response and collects the real frames arriving after it', async () => {
		const [server, client] = duplexPair()
		const collector = readClientFrames(client)

		const handshake = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n')
		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, Buffer.from('echo: hi'), {
			masked: false,
		})

		// One partial write before the handshake terminator collects nothing yet.
		server.write(handshake.subarray(0, handshake.length - 4))
		await flushSocket()
		expect(collector.frames.length).toBe(0)

		server.write(Buffer.concat([handshake.subarray(handshake.length - 4), wire]))
		await flushSocket()

		expect(collector.frames.length).toBe(1)
		const [received] = collector.frames
		expect(received).toBeDefined()
		if (received === undefined) throw new Error('unreachable: length checked above')
		expect(received.opcode).toBe(WEBSOCKET_OPCODE_TEXT)
		expect(received.payload.toString()).toBe('echo: hi')
	})
})
