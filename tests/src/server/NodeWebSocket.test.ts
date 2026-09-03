import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
	createNodeWebSocket,
	encodeWebSocketFrame,
	isWebSocketError,
	WEBSOCKET_CLOSE_INVALID,
	WEBSOCKET_CLOSE_NORMAL,
	WEBSOCKET_CLOSE_PROTOCOL,
	WEBSOCKET_CLOSE_REASON_MAX_LENGTH,
	WEBSOCKET_CLOSE_TOO_BIG,
	WEBSOCKET_CLOSE_UNSUPPORTED,
	WEBSOCKET_CONTROL_MAX_LENGTH,
	WEBSOCKET_OPCODE_BINARY,
	WEBSOCKET_OPCODE_CLOSE,
	WEBSOCKET_OPCODE_CONTINUATION,
	WEBSOCKET_OPCODE_PING,
	WEBSOCKET_OPCODE_PONG,
	WEBSOCKET_OPCODE_TEXT,
} from '@src/server'
import { seededRandom } from '@orkestrel/contract'
import { captureError, createRecorder, requireValue, waitForDelay } from '@orkestrel/test'
import {
	duplexPair,
	flushSocket,
	frame,
	randomBuffer,
	readClientFrames,
} from '../../setupServer.js'

// src/server/NodeWebSocket.ts — the wrapper driven END TO END over an in-memory
// `node:stream` Duplex PAIR (two cross-wired PassThroughs, a REAL bidirectional socket,
// not a mock). One end is a server-mode NodeWebSocket; the other is a hand-rolled "client"
// that writes MASKED frames (encodeWebSocketFrame({ masked: true })) and reads the
// server's UNMASKED frames through parseWebSocketFrame. The in-memory Duplex pair + flush
// + client frame reader are the SHARED `duplexPair` / `flushSocket` / `readClientFrames`
// from setupServer.ts — the same harness the MCP WebSocket transport test reuses. Proves:
// the 101 handshake is written, a client text frame → `message`, `send` → a readable frame
// on the client, ping → auto-pong, close → `close` + a close handshake, and observer-error
// isolation (a throwing listener routes to the emitter's `error` handler, never crashes
// the socket).

// The client's `Sec-WebSocket-Key` for the handshake assertions.
const CLIENT_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

describe('NodeWebSocket — handshake', () => {
	it('writes the 101 Switching Protocols upgrade with the computed accept', async () => {
		const [server, client] = duplexPair()
		const received: Buffer[] = []
		client.on('data', (chunk: Buffer) => received.push(chunk))

		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		await flushSocket()

		const handshake = Buffer.concat(received).toString('utf-8')
		expect(handshake).toContain('HTTP/1.1 101 Switching Protocols')
		expect(handshake).toContain('Upgrade: websocket')
		expect(handshake).toContain('Connection: Upgrade')
		// The accept token for this key is the RFC 6455 §1.3 worked example.
		expect(handshake).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
		expect(ws.readyState).toBe(1) // open
		ws.destroy()
	})

	it('echoes a negotiated subprotocol in the handshake', async () => {
		const [server, client] = duplexPair()
		const received: Buffer[] = []
		client.on('data', (chunk: Buffer) => received.push(chunk))

		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY, protocol: 'mcp' })
		await flushSocket()
		expect(Buffer.concat(received).toString('utf-8')).toContain('Sec-WebSocket-Protocol: mcp')
		ws.destroy()
	})

	it('emits open on construction', async () => {
		const [server] = duplexPair()
		let opened = false
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { open: () => (opened = true) },
		})
		await flushSocket()
		expect(opened).toBe(true)
		ws.destroy()
	})
})

describe('NodeWebSocket — option validation', () => {
	it('rejects malformed handshake values before writing to or assuming ownership of the socket', async () => {
		for (const [options, context] of [
			[{ key: 'not-base64' }, { key: 'not-base64' }],
			[
				{ key: CLIENT_KEY, protocol: 'mcp\r\nX-Injected: true' },
				{ protocol: 'mcp\r\nX-Injected: true' },
			],
		] as const) {
			const [server, client] = duplexPair()
			const received: Buffer[] = []
			client.on('data', (chunk: Buffer) => received.push(chunk))

			const caught = captureError(() => createNodeWebSocket({ socket: server, ...options }))
			expect(isWebSocketError(caught) ? caught.code : 'not-websocket').toBe('OPTION')
			expect(isWebSocketError(caught) ? caught.context : undefined).toEqual(context)
			await flushSocket()

			expect(received).toEqual([])
			expect(getEventListeners(server, 'data')).toHaveLength(0)
			expect(getEventListeners(server, 'close')).toHaveLength(0)
			expect(getEventListeners(server, 'error')).toHaveLength(0)
			server.destroy()
			client.destroy()
		}
	})

	it('rejects a subprotocol in client mode because no server handshake can carry it', () => {
		const [socket, peer] = duplexPair()
		const caught = captureError(() => createNodeWebSocket({ socket, protocol: 'mcp' }))
		expect(isWebSocketError(caught) ? caught.code : 'not-websocket').toBe('OPTION')
		expect(isWebSocketError(caught) ? caught.context : undefined).toEqual({ protocol: 'mcp' })
		socket.destroy()
		peer.destroy()
	})

	it('rejects invalid payload and timeout limits before attaching socket listeners', () => {
		for (const options of [
			{ payload: -1 },
			{ payload: 1.5 },
			{ payload: Number.POSITIVE_INFINITY },
			{ timeout: -1 },
			{ timeout: 1.5 },
		]) {
			const [socket, peer] = duplexPair()
			const caught = captureError(() => createNodeWebSocket({ socket, ...options }))
			expect(isWebSocketError(caught) ? caught.code : 'not-websocket').toBe('OPTION')
			expect(isWebSocketError(caught) ? caught.context : undefined).toEqual(options)
			expect(getEventListeners(socket, 'data')).toHaveLength(0)
			expect(getEventListeners(socket, 'close')).toHaveLength(0)
			expect(getEventListeners(socket, 'error')).toHaveLength(0)
			socket.destroy()
			peer.destroy()
		}
	})
})

describe('NodeWebSocket — receiving', () => {
	it('decodes a masked client text frame into a message event', async () => {
		const [server, client] = duplexPair()
		const messages: string[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { message: (text) => messages.push(text) },
		})
		await flushSocket()

		// The client MUST mask its frames (RFC 6455 §5.3).
		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'hello server', { masked: true }))
		await flushSocket()

		expect(messages).toEqual(['hello server'])
		ws.destroy()
	})

	it('reassembles a fragmented text message across continuation frames', async () => {
		const [server, client] = duplexPair()
		const messages: string[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { message: (text) => messages.push(text) },
		})
		await flushSocket()

		const first = frame(WEBSOCKET_OPCODE_TEXT, 'Hel', { masked: true, fin: false })
		const second = frame(WEBSOCKET_OPCODE_CONTINUATION, 'lo!', { masked: true })
		client.write(Buffer.concat([first, second]))
		await flushSocket()

		expect(messages).toEqual(['Hello!'])
		ws.destroy()
	})

	it('handles two frames arriving in one chunk', async () => {
		const [server, client] = duplexPair()
		const messages: string[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { message: (text) => messages.push(text) },
		})
		await flushSocket()

		client.write(
			Buffer.concat([
				encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'one', { masked: true }),
				encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'two', { masked: true }),
			]),
		)
		await flushSocket()
		expect(messages).toEqual(['one', 'two'])
		ws.destroy()
	})
})

describe('NodeWebSocket — sending', () => {
	it('send writes an UNMASKED text frame the client decodes', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		await flushSocket()

		ws.send('hello client')
		await flushSocket()

		const text = frames.find((entry) => entry.opcode === WEBSOCKET_OPCODE_TEXT)
		expect(text?.payload.toString('utf-8')).toBe('hello client')
		ws.destroy()
	})

	it('ignores send before open / after close', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		await flushSocket()
		ws.destroy() // closed
		ws.send('dropped')
		await flushSocket()
		expect(frames.some((entry) => entry.opcode === WEBSOCKET_OPCODE_TEXT)).toBe(false)
	})
})

describe('NodeWebSocket — ping / pong', () => {
	it('auto-answers a client ping with a pong and emits ping', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		let pinged = false
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { ping: () => (pinged = true) },
		})
		await flushSocket()

		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_PING, Buffer.alloc(0), { masked: true }))
		await flushSocket()

		expect(pinged).toBe(true)
		expect(frames.some((entry) => entry.opcode === WEBSOCKET_OPCODE_PONG)).toBe(true)
		ws.destroy()
	})

	it('emits pong when the client answers a server ping', async () => {
		const [server, client] = duplexPair()
		let ponged = false
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { pong: () => (ponged = true) },
		})
		await flushSocket()

		ws.ping()
		await flushSocket()
		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_PONG, Buffer.alloc(0), { masked: true }))
		await flushSocket()

		expect(ponged).toBe(true)
		ws.destroy()
	})
})

describe('NodeWebSocket — close', () => {
	it('a client close frame ends the socket with the echoed close handshake and a close event', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const closes: Array<{ code: number | undefined; reason: string | undefined }> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code, reason) => closes.push({ code, reason }) },
		})
		await flushSocket()

		// A masked client close frame: code 1000 + reason.
		const payload = Buffer.alloc(2 + 3)
		payload.writeUInt16BE(WEBSOCKET_CLOSE_NORMAL, 0)
		payload.write('bye', 2, 'utf-8')
		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, payload, { masked: true }))
		await flushSocket()

		// The server echoed a close frame and transitioned to closed.
		expect(frames.some((entry) => entry.opcode === WEBSOCKET_OPCODE_CLOSE)).toBe(true)
		expect(ws.readyState).toBe(3) // closed
		expect(closes).toEqual([{ code: WEBSOCKET_CLOSE_NORMAL, reason: 'bye' }])
	})

	it('close() writes a close frame carrying the code and reason', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		await flushSocket()

		ws.close(WEBSOCKET_CLOSE_NORMAL, 'done')
		await flushSocket()

		const close = frames.find((entry) => entry.opcode === WEBSOCKET_OPCODE_CLOSE)
		expect(close).toBeDefined()
		expect(close?.payload.readUInt16BE(0)).toBe(WEBSOCKET_CLOSE_NORMAL)
		expect(close?.payload.subarray(2).toString('utf-8')).toBe('done')
		ws.destroy()
	})

	it('destroy is idempotent and leaves the socket closed', async () => {
		const [server] = duplexPair()
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		await flushSocket()
		ws.destroy()
		ws.destroy()
		expect(ws.readyState).toBe(3)
	})

	it('rejects invalid outbound control payloads without writing a frame or changing the open state', async () => {
		const [server, client] = duplexPair()
		const received: Buffer[] = []
		client.on('data', (chunk: Buffer) => received.push(chunk))
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY })
		await flushSocket()
		received.length = 0 // drop the handshake bytes; only the refusals are under test

		const oversize = captureError(() => ws.ping('a'.repeat(126)))
		expect(isWebSocketError(oversize) ? oversize.code : 'not-websocket').toBe('LIMIT')
		expect(isWebSocketError(oversize) ? oversize.context : undefined).toEqual({
			size: 126,
			limit: WEBSOCKET_CONTROL_MAX_LENGTH,
		})

		const fractional = captureError(() => ws.close(1000.5))
		expect(isWebSocketError(fractional) ? fractional.code : 'not-websocket').toBe('CLOSE')
		expect(isWebSocketError(fractional) ? fractional.context : undefined).toEqual({ code: 1000.5 })

		const longReason = captureError(() => ws.close(WEBSOCKET_CLOSE_NORMAL, 'a'.repeat(124)))
		expect(isWebSocketError(longReason) ? longReason.code : 'not-websocket').toBe('LIMIT')
		expect(isWebSocketError(longReason) ? longReason.context : undefined).toEqual({
			size: 124,
			limit: WEBSOCKET_CLOSE_REASON_MAX_LENGTH,
		})

		await flushSocket()
		expect(Buffer.concat(received)).toEqual(Buffer.alloc(0))
		expect(ws.readyState).toBe(1)

		ws.destroy()
	})
})

describe('NodeWebSocket — observer-error isolation', () => {
	it('isolates a throwing message listener and routes to the error handler', async () => {
		const [server, client] = duplexPair()
		const recorder = createRecorder<[error: unknown, event: string]>()
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			// The emitter's `error` handler receives (error, event) — never a domain event.
			error: recorder.handler,
			on: {
				message: () => {
					throw new Error('listener boom')
				},
			},
		})
		await flushSocket()

		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'trigger', { masked: true }))
		await flushSocket()

		// The throw was caught and routed to the error handler; the socket is still open and usable.
		expect(recorder.count).toBe(1)
		const [error, event] = requireValue(recorder.calls[0])
		expect(error).toBeInstanceOf(Error)
		expect(event).toBe('message')
		expect(ws.readyState).toBe(1)

		// A second message still dispatches — the socket did not crash.
		const seen: string[] = []
		ws.emitter.on('message', (text) => seen.push(text))
		// (re-add a non-throwing message listener by reading through the next frame)
		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'again', { masked: true }))
		await flushSocket()
		expect(seen).toContain('again')
		ws.destroy()
	})
})

// The RFC 6455 breach matrix — every distinct validation the hardened `#dispatch` /
// `#decodeClose` / `#onData` gauntlet enforces, each driven end to end over the same
// `duplexPair` harness and asserted on the emitted `close(code)` (the
// engine's single funnel, `#fail`) followed by teardown (`readyState` → CLOSED). Client
// frames are encoded `{ masked: true }` per RFC 6455 §5.3 UNLESS the test IS the
// unmasked-breach case itself.
describe('NodeWebSocket — breach matrix', () => {
	it('an unmasked client frame closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'unmasked'))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
		// The flushed `#fail` close frame is observable by the peer BEFORE hard teardown.
		const close = frames.find((entry) => entry.opcode === WEBSOCKET_OPCODE_CLOSE)
		expect(close).toBeDefined()
		expect(close?.payload.readUInt16BE(0)).toBe(WEBSOCKET_CLOSE_PROTOCOL)
	})

	it('a frame with RSV bits set closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'rsv', { masked: true })
		wire.writeUInt8(wire.readUInt8(0) | 0x10, 0) // set RSV1
		client.write(wire)
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('non-canonical extended lengths close with 1002 as soon as the prefix is complete', async () => {
		const nonMinimal16 = Buffer.from([0x81, 0xfe, 0, 1])
		const nonMinimal64 = Buffer.alloc(10)
		nonMinimal64.writeUInt8(0x81, 0)
		nonMinimal64.writeUInt8(0xff, 1)
		nonMinimal64.writeBigUInt64BE(BigInt(125), 2)
		const highBit64 = Buffer.alloc(10)
		highBit64.writeUInt8(0x81, 0)
		highBit64.writeUInt8(0xff, 1)
		highBit64.writeUInt32BE(0x8000_0000, 2)

		for (const wire of [nonMinimal16, nonMinimal64, highBit64]) {
			const [server, client] = duplexPair()
			const closes: Array<number | undefined> = []
			const ws = createNodeWebSocket({
				socket: server,
				key: CLIENT_KEY,
				on: { close: (code) => closes.push(code) },
			})
			await flushSocket()

			client.write(wire)
			await flushSocket()

			expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
			expect(ws.readyState).toBe(3)
		}
	})

	it('a control frame payload over 125 bytes closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_PING, Buffer.alloc(126), { masked: true }))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('a fragmented control frame (FIN=0 on a ping) closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_PING, Buffer.alloc(0), { masked: true })
		wire.writeUInt8(wire.readUInt8(0) & 0x7f, 0) // controls MUST NOT fragment (§5.5)
		client.write(wire)
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('a continuation frame with no started message closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		client.write(
			encodeWebSocketFrame(WEBSOCKET_OPCODE_CONTINUATION, 'stray continuation', {
				masked: true,
			}),
		)
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('an additional data frame opened mid-message closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		// Start a message (FIN cleared), then send ANOTHER data frame (not a continuation)
		// before it finishes — RFC 6455 §5.4 forbids interleaving a second data frame.
		const start = frame(WEBSOCKET_OPCODE_TEXT, 'first', { masked: true, fin: false })
		client.write(start)
		await flushSocket()
		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'second', { masked: true }))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('a reserved opcode closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		client.write(encodeWebSocketFrame(0x03, 'reserved', { masked: true }))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('an inbound binary message closes with 1003 (unsupported data)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		client.write(
			encodeWebSocketFrame(WEBSOCKET_OPCODE_BINARY, Buffer.from([0x01, 0x02, 0x03]), {
				masked: true,
			}),
		)
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_UNSUPPORTED])
		expect(ws.readyState).toBe(3)
	})

	it('an invalid-UTF-8 text message closes with 1007 (invalid frame payload data)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		// 0xff 0xfe is not a valid UTF-8 sequence.
		client.write(
			encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, Buffer.from([0xff, 0xfe]), { masked: true }),
		)
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_INVALID])
		expect(ws.readyState).toBe(3)
	})

	it('a 1-byte close payload closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		client.write(
			encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, Buffer.from([0x03]), { masked: true }),
		)
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('an invalid close code (1005) closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		const payload = Buffer.alloc(2)
		payload.writeUInt16BE(1005, 0) // "no status" — reserved, MUST NOT appear on the wire
		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, payload, { masked: true }))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('a single frame declaring a length over the payload cap closes with 1009 (message too big)', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 10,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		client.write(
			encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, Buffer.alloc(20, 0x61), { masked: true }),
		)
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOO_BIG])
		expect(ws.readyState).toBe(3)
		// `#fail` flushes the close frame through `socket.end()` before the hard-teardown
		// fallback destroys — the peer harness must observe the 1009 close frame on the wire.
		const close = frames.find((entry) => entry.opcode === WEBSOCKET_OPCODE_CLOSE)
		expect(close).toBeDefined()
		expect(close?.payload.readUInt16BE(0)).toBe(WEBSOCKET_CLOSE_TOO_BIG)
	})

	it('preflights every coalesced frame before buffering its payload', async () => {
		const [server, client] = duplexPair()
		const messages: string[] = []
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 10,
			on: {
				message: (message) => messages.push(message),
				close: (code) => closes.push(code),
			},
		})
		await flushSocket()

		const first = frame(WEBSOCKET_OPCODE_TEXT, 'ok', { masked: true })
		const secondHeader = Buffer.alloc(6)
		secondHeader.writeUInt8(0x81, 0)
		secondHeader.writeUInt8(0x80 | 20, 1)
		client.write(Buffer.concat([first, secondHeader]))
		await flushSocket()

		expect(messages).toEqual(['ok'])
		expect(closes).toEqual([WEBSOCKET_CLOSE_TOO_BIG])
		expect(ws.readyState).toBe(3)
	})

	it('a fragmented message whose reassembled total exceeds the payload cap closes with 1009 (message too big)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 10,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		// Each fragment is within the single-frame cap; the reassembled total (12) is not.
		const first = frame(WEBSOCKET_OPCODE_TEXT, Buffer.alloc(6, 0x61), {
			masked: true,
			fin: false,
		})
		client.write(first)
		await flushSocket()
		expect(ws.readyState).toBe(1) // still open after the first, under-cap fragment

		client.write(
			encodeWebSocketFrame(WEBSOCKET_OPCODE_CONTINUATION, Buffer.alloc(6, 0x62), {
				masked: true,
			}),
		)
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOO_BIG])
		expect(ws.readyState).toBe(3)
	})

	it('a close-handshake timeout auto-destroys the socket when the peer never echoes', async () => {
		const [server] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			timeout: 15,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		ws.close(WEBSOCKET_CLOSE_NORMAL, 'no echo')
		expect(ws.readyState).toBe(2) // closing — waiting on the peer's echo

		// No peer echo arrives; wait past the injected close-handshake timeout.
		await waitForDelay(50)

		expect(closes).toEqual([WEBSOCKET_CLOSE_NORMAL])
		expect(ws.readyState).toBe(3)
	})
})

// Head replay shares `#ingest` with ordinary socket data, so the pre-buffer
// cap check (measure the declared length BEFORE buffering the payload) applies uniformly
// whether the over-cap bytes arrive as ordinary `data` OR bundled as `options.head` (bytes
// already read off the socket before the upgrade handler ran).
describe('NodeWebSocket — head-replay cap parity', () => {
	it('an over-cap frame delivered entirely through options.head closes 1009 without buffering the payload', async () => {
		const [server] = duplexPair()
		const closes: Array<number | undefined> = []
		// A small injected payload cap makes the over-cap breach cheap to construct and
		// proves the head bytes never reach `#drain`/`#dispatch` unbuffered past the cap.
		const head = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, Buffer.alloc(20, 0x61), {
			masked: true,
		})
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 10,
			head,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOO_BIG])
		expect(ws.readyState).toBe(3)
	})

	it('head bytes within the cap still decode through the shared ingest path', async () => {
		const [server] = duplexPair()
		const messages: string[] = []
		const head = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'from head', { masked: true })
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			head,
			on: { message: (text) => messages.push(text) },
		})
		await flushSocket()

		expect(messages).toEqual(['from head'])
		ws.destroy()
	})
})

// The AbortSignal cancellation seam composes with `@orkestrel/abort` /
// `@orkestrel/timeout`'s native AbortSignals, and never leaks an `abort` listener past
// the socket's lifecycle.
describe('NodeWebSocket — AbortSignal lifecycle', () => {
	it('an abort mid-open tears the socket down: readyState CLOSED, close emitted, socket destroyed', async () => {
		const [server] = duplexPair()
		const controller = new AbortController()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			signal: controller.signal,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()
		expect(ws.readyState).toBe(1) // open

		controller.abort()

		expect(ws.readyState).toBe(3) // closed
		expect(closes).toHaveLength(1)
		expect(server.destroyed).toBe(true)
	})

	it('an already-aborted signal tears the socket down immediately after construction', async () => {
		const [server] = duplexPair()
		const controller = new AbortController()
		controller.abort()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			signal: controller.signal,
			on: { close: (code) => closes.push(code) },
		})

		expect(ws.readyState).toBe(3) // closed
		expect(closes).toHaveLength(1)
		expect(server.destroyed).toBe(true)
	})

	it('a long-lived signal never accumulates abort listeners across closed sockets', async () => {
		const controller = new AbortController()
		for (let index = 0; index < 5; index += 1) {
			const [server] = duplexPair()
			const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY, signal: controller.signal })
			await flushSocket()
			ws.destroy()
			// Each `destroy()` removes its own `abort` listener from the shared signal — the
			// listener count never grows across five closed sockets.
			expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
		}
		expect(controller.signal.aborted).toBe(false)
	})

	// A \`head\` that itself terminates the socket during construction
	// (before the abort seam runs) must not leave a leaked \`abort\` listener on the signal.
	// The head-replay \`#ingest\` runs BEFORE the seam is wired, so a complete CLOSE frame (or
	// an RFC violation) in \`head\` can synchronously drive \`#close\`/\`#fail\` -> \`#finish\` ->
	// readyState CLOSED, all before the seam's \`if (aborted) destroy else addEventListener\`
	// runs. Without the \`#readyState\` guard, the seam's else-branch would attach \`#onAbort\`
	// to an already-dead socket — the exact leak this asserts against.
	it('a complete CLOSE frame in options.head + a signal does not leak the abort listener onto the dead socket', async () => {
		const [server] = duplexPair()
		const controller = new AbortController()
		const payload = Buffer.alloc(2 + 3)
		payload.writeUInt16BE(WEBSOCKET_CLOSE_NORMAL, 0)
		payload.write('bye', 2, 'utf-8')
		const head = encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, payload, { masked: true })

		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			head,
			signal: controller.signal,
		})

		expect(ws.readyState).toBe(3) // closed
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
	})

	it('an RFC violation in options.head + a signal does not leak the abort listener onto the dead socket', async () => {
		const [server] = duplexPair()
		const controller = new AbortController()
		// Unmasked frame — the server instance requires masked inbound frames (RFC 6455
		// §5.1), so this routes through \`#fail\` synchronously during the head replay.
		const head = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'unmasked')

		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			head,
			signal: controller.signal,
		})

		expect(ws.readyState).toBe(3) // closed
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
	})
})

describe('NodeWebSocket — terminal socket listeners', () => {
	it('emits an active socket error once and terminates the WebSocket', () => {
		const [server] = duplexPair()
		const events: Array<string | unknown> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: {
				error: (error) => events.push(error),
				close: () => events.push('close'),
			},
		})
		const error = new Error('socket fault')

		server.emit('error', error)

		expect(events).toEqual([error, 'close'])
		expect(ws.readyState).toBe(3)
		expect(server.destroyed).toBe(true)
		expect(getEventListeners(server, 'data')).toHaveLength(0)
		expect(getEventListeners(server, 'close')).toHaveLength(0)
		expect(getEventListeners(server, 'error')).toHaveLength(1)
	})

	it('detaches domain listeners after a clean peer close and absorbs late socket errors', async () => {
		const [server, client] = duplexPair()
		const events: string[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: {
				close: () => events.push('close'),
				error: () => events.push('error'),
			},
		})
		await flushSocket()

		const payload = Buffer.alloc(2 + 3)
		payload.writeUInt16BE(WEBSOCKET_CLOSE_NORMAL, 0)
		payload.write('bye', 2, 'utf-8')
		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, payload, { masked: true }))
		await flushSocket()

		expect(events).toEqual(['close'])
		expect(ws.readyState).toBe(3) // closed
		expect(getEventListeners(server, 'data')).toHaveLength(0)
		expect(getEventListeners(server, 'close')).toHaveLength(0)
		expect(getEventListeners(server, 'error')).toHaveLength(1)

		expect(() => server.emit('error', new Error('late socket error'))).not.toThrow()

		expect(events).toEqual(['close'])
	})

	it('absorbs a late ECONNRESET after destroy on a socket with no harness error sink', () => {
		const [server] = duplexPair()
		const events: string[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: {
				close: () => events.push('close'),
				error: () => events.push('error'),
			},
		})

		ws.destroy()
		expect(events).toEqual(['close'])
		expect(getEventListeners(server, 'data')).toHaveLength(0)
		expect(getEventListeners(server, 'close')).toHaveLength(0)
		expect(getEventListeners(server, 'error')).toHaveLength(1)

		const late = new Error('read ECONNRESET')
		Object.assign(late, { code: 'ECONNRESET' })
		expect(() => server.emit('error', late)).not.toThrow()
		expect(events).toEqual(['close'])
	})

	it('detaches after the underlying socket closes without a WebSocket close frame', async () => {
		const [server] = duplexPair()
		const events: string[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: {
				close: () => events.push('close'),
				error: () => events.push('error'),
			},
		})

		server.destroy()
		await flushSocket()

		expect(ws.readyState).toBe(3) // closed
		expect(events).toEqual(['close'])
		expect(getEventListeners(server, 'data')).toHaveLength(0)
		expect(getEventListeners(server, 'close')).toHaveLength(0)
		expect(getEventListeners(server, 'error')).toHaveLength(1)
		expect(() => server.emit('error', new Error('late socket error'))).not.toThrow()
		expect(events).toEqual(['close'])
	})

	it('preserves caller-owned error listeners while removing the domain listener', () => {
		const [server] = duplexPair()
		const callerErrors: unknown[] = []
		const domainErrors: unknown[] = []
		server.on('error', (error) => callerErrors.push(error))
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { error: (error) => domainErrors.push(error) },
		})

		ws.destroy()
		expect(getEventListeners(server, 'error')).toHaveLength(2)

		const late = new Error('late socket error')
		server.emit('error', late)

		expect(callerErrors).toEqual([late])
		expect(domainErrors).toEqual([])
	})
})

// Reassembly, ping/pong interleaving, cap boundaries, close symmetry, and
// listener-leak hygiene, all driven end to end over the shared `duplexPair` harness.
// Each case is a REAL socket exchange — no mock — asserting the
// engine's observable contract (message content, wire frames, readyState).
describe('NodeWebSocket — stream reassembly and lifecycle', () => {
	it('reassembles a message delivered one byte at a time', async () => {
		const [server, client] = duplexPair()
		const messages: string[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { message: (text) => messages.push(text) },
		})
		await flushSocket()

		const wire = frame(WEBSOCKET_OPCODE_TEXT, 'byte at a time', { masked: true })
		for (let index = 0; index < wire.length; index += 1) {
			client.write(wire.subarray(index, index + 1))
			await flushSocket()
		}

		expect(messages).toEqual(['byte at a time'])
		ws.destroy()
	})

	it('reassembles under every two-way chunk split', async () => {
		const payload = 'every split of this message must still arrive whole'
		const wire = frame(WEBSOCKET_OPCODE_TEXT, payload, { masked: true })
		for (let cut = 0; cut <= wire.length; cut += 1) {
			const [server, client] = duplexPair()
			const messages: string[] = []
			const ws = createNodeWebSocket({
				socket: server,
				key: CLIENT_KEY,
				on: { message: (text) => messages.push(text) },
			})
			await flushSocket()

			client.write(wire.subarray(0, cut))
			await flushSocket()
			client.write(wire.subarray(cut))
			await flushSocket()

			expect(messages).toEqual([payload])
			ws.destroy()
		}
	})

	it('decodes 20 frames packed in one chunk, in order', async () => {
		const [server, client] = duplexPair()
		const messages: string[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { message: (text) => messages.push(text) },
		})
		await flushSocket()

		const frames: Buffer[] = []
		for (let index = 0; index < 20; index += 1) {
			frames.push(frame(WEBSOCKET_OPCODE_TEXT, `msg-${index}`, { masked: true }))
		}
		client.write(Buffer.concat(frames))
		await flushSocket()

		expect(messages).toEqual(Array.from({ length: 20 }, (_, index) => `msg-${index}`))
		ws.destroy()
	})

	it('reassembles 50+ continuation fragments into one message', async () => {
		const [server, client] = duplexPair()
		const messages: string[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { message: (text) => messages.push(text) },
		})
		await flushSocket()

		const frames: Buffer[] = [frame(WEBSOCKET_OPCODE_TEXT, 'a', { masked: true, fin: false })]
		for (let index = 0; index < 49; index += 1) {
			frames.push(frame(WEBSOCKET_OPCODE_CONTINUATION, 'a', { masked: true, fin: false }))
		}
		frames.push(frame(WEBSOCKET_OPCODE_CONTINUATION, 'a', { masked: true, fin: true }))
		client.write(Buffer.concat(frames))
		await flushSocket()

		expect(messages).toEqual(['a'.repeat(51)])
		ws.destroy()
	})

	it('pongs and still reassembles a PING interleaved between continuations (§5.4)', async () => {
		const [server, client] = duplexPair()
		const { frames: outbound } = readClientFrames(client)
		const messages: string[] = []
		let pinged = false
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: {
				message: (text) => messages.push(text),
				ping: () => (pinged = true),
			},
		})
		await flushSocket()

		const start = frame(WEBSOCKET_OPCODE_TEXT, 'Hel', { masked: true, fin: false })
		const ping = frame(WEBSOCKET_OPCODE_PING, Buffer.alloc(4, 0x01), { masked: true, fin: true })
		const cont = frame(WEBSOCKET_OPCODE_CONTINUATION, 'lo!', { masked: true, fin: true })
		client.write(Buffer.concat([start, ping, cont]))
		await flushSocket()

		expect(pinged).toBe(true)
		expect(outbound.some((f) => f.opcode === WEBSOCKET_OPCODE_PONG)).toBe(true)
		expect(messages).toEqual(['Hello!'])
		ws.destroy()
	})

	it('accepts a fragmented total exactly at the payload cap', async () => {
		const [server, client] = duplexPair()
		const messages: string[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 100,
			on: { message: (text) => messages.push(text) },
		})
		await flushSocket()

		const first = frame(WEBSOCKET_OPCODE_TEXT, Buffer.alloc(60, 0x61), { masked: true, fin: false })
		const second = frame(WEBSOCKET_OPCODE_CONTINUATION, Buffer.alloc(40, 0x62), {
			masked: true,
			fin: true,
		})
		client.write(Buffer.concat([first, second]))
		await flushSocket()

		expect(messages).toHaveLength(1)
		expect(messages[0]).toHaveLength(100)
		expect(ws.readyState).toBe(1) // open
		ws.destroy()
	})

	it('closes 1009 when the fragmented total is one over the payload cap', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 100,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		const first = frame(WEBSOCKET_OPCODE_TEXT, Buffer.alloc(60, 0x61), { masked: true, fin: false })
		const second = frame(WEBSOCKET_OPCODE_CONTINUATION, Buffer.alloc(41, 0x62), {
			masked: true,
			fin: true,
		})
		client.write(Buffer.concat([first, second]))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOO_BIG])
		expect(ws.readyState).toBe(3) // closed
	})

	it('accepts a single frame exactly at the payload cap', async () => {
		const [server, client] = duplexPair()
		const messages: string[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 50,
			on: { message: (text) => messages.push(text) },
		})
		await flushSocket()

		client.write(frame(WEBSOCKET_OPCODE_TEXT, Buffer.alloc(50, 0x61), { masked: true }))
		await flushSocket()

		expect(messages).toHaveLength(1)
		expect(messages[0]).toHaveLength(50)
		ws.destroy()
	})

	it('closes 1009 for a single frame one over the payload cap, observed by the peer', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 50,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		client.write(frame(WEBSOCKET_OPCODE_TEXT, Buffer.alloc(51, 0x61), { masked: true }))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOO_BIG])
		expect(ws.readyState).toBe(3) // closed
		const close = frames.find((f) => f.opcode === WEBSOCKET_OPCODE_CLOSE)
		expect(close).toBeDefined()
		expect(close?.payload.readUInt16BE(0)).toBe(WEBSOCKET_CLOSE_TOO_BIG)
	})

	it('completes a we-initiate → peer-echoes close with exactly one close event', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		ws.close(WEBSOCKET_CLOSE_NORMAL, 'bye')
		await flushSocket()
		expect(ws.readyState).toBe(2) // closing — awaiting the peer's echo

		const outgoing = frames.find((f) => f.opcode === WEBSOCKET_OPCODE_CLOSE)
		expect(outgoing).toBeDefined()

		const payload = Buffer.alloc(2 + 3)
		payload.writeUInt16BE(WEBSOCKET_CLOSE_NORMAL, 0)
		payload.write('bye', 2, 'utf-8')
		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, payload, { masked: true }))
		await flushSocket()

		expect(closes).toHaveLength(1)
		expect(ws.readyState).toBe(3) // closed
	})

	it('survives a simultaneous close with exactly one close event, no throw', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		const payload = Buffer.alloc(2 + 3)
		payload.writeUInt16BE(WEBSOCKET_CLOSE_NORMAL, 0)
		payload.write('bye', 2, 'utf-8')
		expect(() => {
			ws.close(WEBSOCKET_CLOSE_NORMAL, 'bye')
			client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, payload, { masked: true }))
		}).not.toThrow()
		await flushSocket()

		expect(closes).toHaveLength(1)
		expect(ws.readyState).toBe(3) // closed
	})

	it('treats send() after close() as a silent no-op', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY, timeout: 1000 })
		await flushSocket()

		ws.close(WEBSOCKET_CLOSE_NORMAL, 'bye')
		await flushSocket()
		expect(ws.readyState).toBe(2) // closing — no peer echo yet

		ws.send('should be dropped')
		await flushSocket()

		expect(frames.some((f) => f.opcode === WEBSOCKET_OPCODE_TEXT)).toBe(false)
		ws.destroy()
	})

	it('treats close() as idempotent — exactly one CLOSE frame on the wire', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY, timeout: 1000 })
		await flushSocket()

		ws.close(WEBSOCKET_CLOSE_NORMAL, 'first')
		ws.close(WEBSOCKET_CLOSE_NORMAL, 'second')
		await flushSocket()

		expect(frames.filter((f) => f.opcode === WEBSOCKET_OPCODE_CLOSE)).toHaveLength(1)
		ws.destroy()
	})

	it('leaks no listeners across 100 construct→destroy churns on a shared signal', async () => {
		const controller = new AbortController()
		for (let index = 0; index < 100; index += 1) {
			const [server] = duplexPair()
			const ws = createNodeWebSocket({ socket: server, key: CLIENT_KEY, signal: controller.signal })
			await flushSocket()
			ws.destroy()

			expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
			expect(getEventListeners(server, 'data')).toHaveLength(0)
			expect(getEventListeners(server, 'close')).toHaveLength(0)
			expect(getEventListeners(server, 'error')).toHaveLength(1)
		}
		expect(controller.signal.aborted).toBe(false)
	})

	it('drives 4 independent sockets concurrently without cross-talk', async () => {
		const pairs = Array.from({ length: 4 }, () => duplexPair())
		const messages: string[][] = [[], [], [], []]
		const sockets = pairs.map(([server], index) =>
			createNodeWebSocket({
				socket: server,
				key: CLIENT_KEY,
				on: { message: (text) => messages[index]?.push(text) },
			}),
		)
		await flushSocket()

		// Interleave writes across all four clients before flushing any.
		for (let round = 0; round < 3; round += 1) {
			for (const [socketIndex, [, client]] of pairs.entries()) {
				client.write(frame(WEBSOCKET_OPCODE_TEXT, `s${socketIndex}-r${round}`, { masked: true }))
			}
		}
		await flushSocket()

		for (let socketIndex = 0; socketIndex < 4; socketIndex += 1) {
			expect(messages[socketIndex]).toEqual([
				`s${socketIndex}-r0`,
				`s${socketIndex}-r1`,
				`s${socketIndex}-r2`,
			])
		}
		for (const ws of sockets) ws.destroy()
	})
})

// Adversarial payload-cap enforcement: fragmentation bombs, header-only
// declared-huge frames, the intentionally-unbounded stalled-partial-frame case, and
// one-close-per-many-violations. Injected small `payload` caps keep every case cheap
// (no large buffer allocation).
describe('NodeWebSocket — resource limits', () => {
	it('bounds a fragmentation bomb to 1009 without OOM', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 64,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		// Hundreds of 1-byte continuation fragments, cumulatively exceeding the 64-byte cap.
		const rng = seededRandom(3)
		const frames: Buffer[] = [
			frame(WEBSOCKET_OPCODE_TEXT, randomBuffer(rng, 1), { masked: true, fin: false }),
		]
		for (let index = 0; index < 199; index += 1) {
			frames.push(
				frame(WEBSOCKET_OPCODE_CONTINUATION, randomBuffer(rng, 1), {
					masked: true,
					fin: false,
				}),
			)
		}
		client.write(Buffer.concat(frames))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOO_BIG])
		expect(ws.readyState).toBe(3) // closed
	})

	it('rejects a declared-huge frame on the header alone, before any payload byte is sent', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 64,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		// A hand-built 127-length-form header declaring 2^40 bytes: FIN+TEXT, MASK+len=127,
		// 8-byte big-endian length, 4-byte mask key — 14 bytes total, NO payload bytes.
		const header = Buffer.alloc(2 + 8 + 4)
		header[0] = 0x81 // FIN=1, opcode=TEXT
		header[1] = 0xff // MASK=1, length code=127
		header.writeBigUInt64BE(BigInt(2) ** BigInt(40), 2)
		header.writeUInt32BE(0x11223344, 10) // an arbitrary mask key
		client.write(header)
		await flushSocket()

		// The cap fires from the declared length alone, before any payload byte arrives:
		// a 1009 close from a payload-less header proves pre-buffer rejection.
		expect(closes).toEqual([WEBSOCKET_CLOSE_TOO_BIG])
		expect(ws.readyState).toBe(3) // closed
	})

	// Intended behavior, not a missing feature: only the payload cap (on a fully-declared
	// length) and the close-handshake timeout bound the socket. A frame whose LENGTH PREFIX
	// itself is still incomplete (fewer than the 2/4/10 header bytes buffered) has no
	// declared length to measure yet, so it sits — a lean wrapper has no idle-byte timeout,
	// by design.
	it('leaves a stalled partial frame bounded with no idle timeout (intended, by design)', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 64,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		client.write(Buffer.from([0x81])) // a single header byte — the length prefix is incomplete
		await flushSocket()
		await waitForDelay(30)

		expect(closes).toEqual([])
		expect(ws.readyState).toBe(1) // still open
		ws.destroy()
	})

	it('yields exactly one close + teardown for many violations stacked in one chunk', async () => {
		const [server, client] = duplexPair()
		const closes: Array<number | undefined> = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		// An unmasked frame (a breach on its own) followed by unrelated garbage bytes, all
		// delivered in a single chunk — the FIRST violation must fire #fail exactly once,
		// and nothing after it can trigger a second close.
		const violation = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'unmasked breach')
		const garbage = randomBuffer(seededRandom(4), 64)
		client.write(Buffer.concat([violation, garbage]))
		await flushSocket()

		expect(closes).toHaveLength(1)
		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3) // closed
	})
})
