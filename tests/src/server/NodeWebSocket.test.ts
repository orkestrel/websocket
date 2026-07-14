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
import { duplexPair, flushSocket, readClientFrames } from '../../setupServer.js'

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

		const text = frames.find((frame) => frame.opcode === WEBSOCKET_OPCODE_TEXT)
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
		expect(frames.some((frame) => frame.opcode === WEBSOCKET_OPCODE_TEXT)).toBe(false)
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
		expect(frames.some((frame) => frame.opcode === WEBSOCKET_OPCODE_PONG)).toBe(true)
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
		expect(frames.some((frame) => frame.opcode === WEBSOCKET_OPCODE_CLOSE)).toBe(true)
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

		const close = frames.find((frame) => frame.opcode === WEBSOCKET_OPCODE_CLOSE)
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
		const close = frames.find((frame) => frame.opcode === WEBSOCKET_OPCODE_CLOSE)
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

		const frame = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'rsv', { masked: true })
		frame[0] = (frame[0] ?? 0) | 0x10 // set RSV1
		client.write(frame)
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

		const frame = encodeWebSocketFrame(WEBSOCKET_OPCODE_PING, Buffer.alloc(0), { masked: true })
		frame[0] = (frame[0] ?? 0) & 0x7f // clear FIN — controls MUST NOT fragment (§5.5)
		client.write(frame)
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
		const close = frames.find((frame) => frame.opcode === WEBSOCKET_OPCODE_CLOSE)
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
