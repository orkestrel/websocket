import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
	createNodeWebSocket,
	encodeWebSocketFrame,
	WEBSOCKET_CLOSE_INVALID,
	WEBSOCKET_CLOSE_NORMAL,
	WEBSOCKET_CLOSE_PROTOCOL,
	WEBSOCKET_CLOSE_TOOBIG,
	WEBSOCKET_CLOSE_UNSUPPORTED,
	WEBSOCKET_OPCODE_BINARY,
	WEBSOCKET_OPCODE_CLOSE,
	WEBSOCKET_OPCODE_PING,
	WEBSOCKET_OPCODE_PONG,
	WEBSOCKET_OPCODE_TEXT,
} from '@src/server'
import { createRandom, waitForDelay } from '../../setup.js'
import {
	duplexPair,
	flushSocket,
	frame,
	randomBuffer,
	readClientFrames,
} from '../../setupServer.js'

// src/server/websocket/NodeWebSocket.ts — the wrapper driven END TO END over an
// in-memory `node:stream` Duplex PAIR (two cross-wired PassThroughs, a REAL bidirectional
// socket, not a mock — AGENTS §16). One end is a server-mode NodeWebSocket; the other is a
// hand-rolled "client" that writes MASKED frames (encodeWebSocketFrame({ masked: true }))
// and reads the server's UNMASKED frames through parseWebSocketFrame. The in-memory Duplex
// pair + flush + client frame reader are the SHARED `duplexPair` / `flushSocket` /
// `readClientFrames` from setupServer.ts (AGENTS §16.1 — the same harness the MCP WebSocket
// transport test reuses). Proves: the 101 handshake is written, a client text frame →
// `message`, `send` → a readable frame on the client, ping → auto-pong, close → `close` + a
// close handshake, and §13 observer-error isolation (a throwing listener routes to the
// emitter's `error` handler, never crashes the socket).

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

		// Fragment 1: text opcode, FIN cleared. Fragment 2: continuation opcode (0x00), FIN set.
		// Build the masked frames by hand-clearing the FIN bit on the first.
		const first = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'Hel', { masked: true })
		first[0] = (first[0] ?? 0) & 0x7f // clear FIN
		const second = encodeWebSocketFrame(0x00, 'lo!', { masked: true }) // continuation, FIN set
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
		ws.destroy() // now closed
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
		const closes: { code: number | undefined; reason: string | undefined }[] = []
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
})

describe('NodeWebSocket — §13 observer-error isolation', () => {
	it('isolates a throwing message listener and routes to the error handler', async () => {
		const [server, client] = duplexPair()
		const errors: (readonly [unknown, string])[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			// The emitter's `error` handler receives (error, event) — never a domain event.
			error: (error, event) => errors.push([error, event]),
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
		expect(errors).toHaveLength(1)
		expect(errors[0][0]).toBeInstanceOf(Error)
		expect(errors[0][1]).toBe('message')
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
// `duplexPair` harness (AGENTS §16.1) and asserted on the emitted `close(code)` (the
// engine's single funnel, `#fail`) followed by teardown (`readyState` → CLOSED). Client
// frames are encoded `{ masked: true }` per RFC 6455 §5.3 UNLESS the test IS the
// unmasked-breach case itself.
describe('NodeWebSocket — breach matrix', () => {
	it('an unmasked client frame closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const closes: (number | undefined)[] = []
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
		const closes: (number | undefined)[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'rsv', { masked: true })
		wire[0] = (wire[0] ?? 0) | 0x10 // set RSV1
		client.write(wire)
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('a control frame payload over 125 bytes closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: (number | undefined)[] = []
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
		const closes: (number | undefined)[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		const wire = encodeWebSocketFrame(WEBSOCKET_OPCODE_PING, Buffer.alloc(0), { masked: true })
		wire[0] = (wire[0] ?? 0) & 0x7f // clear FIN — controls MUST NOT fragment (§5.5)
		client.write(wire)
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('a continuation frame with no started message closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: (number | undefined)[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		client.write(encodeWebSocketFrame(0x00, 'stray continuation', { masked: true }))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('a new data frame opened mid-message closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: (number | undefined)[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		// Start a message (FIN cleared), then send ANOTHER data frame (not a continuation)
		// before it finishes — RFC 6455 §5.4 forbids interleaving a second data frame.
		const start = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'first', { masked: true })
		start[0] = (start[0] ?? 0) & 0x7f
		client.write(start)
		await flushSocket()
		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'second', { masked: true }))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3)
	})

	it('a reserved opcode closes with 1002 (protocol error)', async () => {
		const [server, client] = duplexPair()
		const closes: (number | undefined)[] = []
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
		const closes: (number | undefined)[] = []
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
		const closes: (number | undefined)[] = []
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
		const closes: (number | undefined)[] = []
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
		const closes: (number | undefined)[] = []
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
		const closes: (number | undefined)[] = []
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

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOOBIG])
		expect(ws.readyState).toBe(3)
		// `#fail` flushes the close frame through `socket.end()` before the hard-teardown
		// fallback destroys — the peer harness must observe the 1009 close frame on the wire.
		const close = frames.find((entry) => entry.opcode === WEBSOCKET_OPCODE_CLOSE)
		expect(close).toBeDefined()
		expect(close?.payload.readUInt16BE(0)).toBe(WEBSOCKET_CLOSE_TOOBIG)
	})

	it('a fragmented message whose reassembled total exceeds the payload cap closes with 1009 (message too big)', async () => {
		const [server, client] = duplexPair()
		const closes: (number | undefined)[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 10,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		// Each fragment is within the single-frame cap; the reassembled total (12) is not.
		const first = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, Buffer.alloc(6, 0x61), {
			masked: true,
		})
		first[0] = (first[0] ?? 0) & 0x7f // clear FIN
		client.write(first)
		await flushSocket()
		expect(ws.readyState).toBe(1) // still open after the first, under-cap fragment

		client.write(encodeWebSocketFrame(0x00, Buffer.alloc(6, 0x62), { masked: true }))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOOBIG])
		expect(ws.readyState).toBe(3)
	})

	it('a close-handshake timeout auto-destroys the socket when the peer never echoes', async () => {
		const [server] = duplexPair()
		const closes: (number | undefined)[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			timeout: 15,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		ws.close(WEBSOCKET_CLOSE_NORMAL, 'no echo')
		expect(ws.readyState).toBe(2) // closing — waiting on the peer's echo

		// No peer echo arrives; wait past the injected close-handshake timeout for the
		// timer to fire `destroy()`. A local, single-use wait (no setup-file edit in scope).
		await new Promise<void>((resolve) => setTimeout(resolve, 50))

		expect(closes).toEqual([WEBSOCKET_CLOSE_NORMAL])
		expect(ws.readyState).toBe(3)
	})
})

// FIX 2 — the head-replay ingest path shares `#ingest` with `#onData`, so the pre-buffer
// cap check (measure the declared length BEFORE buffering the payload) applies uniformly
// whether the over-cap bytes arrive as ordinary `data` OR bundled as `options.head` (bytes
// already read off the socket before the upgrade handler ran).
describe('NodeWebSocket — head-replay cap parity (FIX 2)', () => {
	it('an over-cap frame delivered entirely via options.head closes 1009 without buffering the payload', async () => {
		const [server] = duplexPair()
		const closes: (number | undefined)[] = []
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

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOOBIG])
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

// FIX 5 — the AbortSignal cancellation seam: composes with `@orkestrel/abort` /
// `@orkestrel/timeout`'s native AbortSignals, and never leaks an `abort` listener past
// the socket's lifecycle.
describe('NodeWebSocket — AbortSignal seam (FIX 5)', () => {
	it('an abort mid-open tears the socket down: readyState CLOSED, close emitted, socket destroyed', async () => {
		const [server] = duplexPair()
		const controller = new AbortController()
		const closes: (number | undefined)[] = []
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
		const closes: (number | undefined)[] = []
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

	// FIX A regression — a \`head\` that itself terminates the socket during construction
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

// FIX B — the clean peer-close path (\`#close\`) now detaches the socket listeners on the
// same terminal step \`#fail\` does, so a socket \`error\` fired during the post-close \`end()\`
// flush cannot surface AFTER the terminal \`close\` — the exact asymmetry \`#fail\` guarded
// against but \`#close\` previously did not.
describe('NodeWebSocket — clean-close listener symmetry (FIX B)', () => {
	it('a socket error after a clean peer close never surfaces after the terminal close event', async () => {
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

		// A late socket error (e.g. during the post-close end() flush) must not reach the
		// domain error event now that #close detaches #onError on the terminal step.
		server.emit('error', new Error('late socket error'))

		expect(events).toEqual(['close'])
	})
})

// B-ENGINE — reassembly, ping/pong interleaving, cap boundaries, close symmetry, and
// listener-leak hygiene, all driven end to end over the shared `duplexPair` harness
// (AGENTS §16.1). Each case is a REAL socket exchange — no mock — asserting the
// engine's observable contract (message content, wire frames, readyState).
describe('NodeWebSocket — B-ENGINE reassembly', () => {
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
			frames.push(frame(0x00, 'a', { masked: true, fin: false }))
		}
		frames.push(frame(0x00, 'a', { masked: true, fin: true }))
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
		const cont = frame(0x00, 'lo!', { masked: true, fin: true })
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
		const second = frame(0x00, Buffer.alloc(40, 0x62), { masked: true, fin: true })
		client.write(Buffer.concat([first, second]))
		await flushSocket()

		expect(messages).toHaveLength(1)
		expect(messages[0]).toHaveLength(100)
		expect(ws.readyState).toBe(1) // open
		ws.destroy()
	})

	it('closes 1009 when the fragmented total is one over the payload cap', async () => {
		const [server, client] = duplexPair()
		const closes: (number | undefined)[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 100,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		const first = frame(WEBSOCKET_OPCODE_TEXT, Buffer.alloc(60, 0x61), { masked: true, fin: false })
		const second = frame(0x00, Buffer.alloc(41, 0x62), { masked: true, fin: true })
		client.write(Buffer.concat([first, second]))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOOBIG])
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
		const closes: (number | undefined)[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 50,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		client.write(frame(WEBSOCKET_OPCODE_TEXT, Buffer.alloc(51, 0x61), { masked: true }))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOOBIG])
		expect(ws.readyState).toBe(3) // closed
		const close = frames.find((f) => f.opcode === WEBSOCKET_OPCODE_CLOSE)
		expect(close).toBeDefined()
		expect(close?.payload.readUInt16BE(0)).toBe(WEBSOCKET_CLOSE_TOOBIG)
	})

	it('completes a we-initiate → peer-echoes close with exactly one close event', async () => {
		const [server, client] = duplexPair()
		const { frames } = readClientFrames(client)
		const closes: (number | undefined)[] = []
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
		const closes: (number | undefined)[] = []
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
			// `duplexPair()` itself attaches a permanent no-op `error` listener to `server` as
			// a safety net (independent of NodeWebSocket) — so the baseline is 1, not 0; the
			// wrapper's OWN `#onError` is what must be gone, i.e. the count must not exceed
			// that fixed harness baseline.
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

// C-LIMITS — adversarial payload-cap enforcement: fragmentation bombs, header-only
// declared-huge frames, the intentionally-unbounded stalled-partial-frame case, and
// one-close-per-many-violations. Injected small `payload` caps keep every case cheap
// (no large buffer allocation).
describe('NodeWebSocket — C-LIMITS', () => {
	it('bounds a fragmentation bomb to 1009 without OOM', async () => {
		const [server, client] = duplexPair()
		const closes: (number | undefined)[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			payload: 64,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		// Hundreds of 1-byte continuation fragments, cumulatively exceeding the 64-byte cap.
		const rng = createRandom(3)
		const frames: Buffer[] = [
			frame(WEBSOCKET_OPCODE_TEXT, randomBuffer(rng, 1), { masked: true, fin: false }),
		]
		for (let index = 0; index < 199; index += 1) {
			frames.push(frame(0x00, randomBuffer(rng, 1), { masked: true, fin: false }))
		}
		client.write(Buffer.concat(frames))
		await flushSocket()

		expect(closes).toEqual([WEBSOCKET_CLOSE_TOOBIG])
		expect(ws.readyState).toBe(3) // closed
	})

	it('rejects a declared-huge frame on the header alone, before any payload byte is sent', async () => {
		const [server, client] = duplexPair()
		const closes: (number | undefined)[] = []
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
		expect(closes).toEqual([WEBSOCKET_CLOSE_TOOBIG])
		expect(ws.readyState).toBe(3) // closed
	})

	// Intended behavior, not a missing feature: only the payload cap (on a fully-declared
	// length) and the close-handshake timeout bound the socket. A frame whose LENGTH PREFIX
	// itself is still incomplete (fewer than the 2/4/10 header bytes buffered) has no
	// declared length to measure yet, so it simply sits — a lean wrapper has no idle-byte
	// timeout, by design (see AGENTS §16 framing notes).
	it('leaves a stalled partial frame bounded with no idle timeout (intended, by design)', async () => {
		const [server, client] = duplexPair()
		const closes: (number | undefined)[] = []
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
		const closes: (number | undefined)[] = []
		const ws = createNodeWebSocket({
			socket: server,
			key: CLIENT_KEY,
			on: { close: (code) => closes.push(code) },
		})
		await flushSocket()

		// An unmasked frame (a breach on its own) followed by unrelated garbage bytes, all
		// delivered in a single chunk — the FIRST violation must fire #fail exactly once,
		// and nothing after it should trigger a second close.
		const violation = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'unmasked breach')
		const garbage = randomBuffer(createRandom(4), 64)
		client.write(Buffer.concat([violation, garbage]))
		await flushSocket()

		expect(closes).toHaveLength(1)
		expect(closes).toEqual([WEBSOCKET_CLOSE_PROTOCOL])
		expect(ws.readyState).toBe(3) // closed
	})
})
