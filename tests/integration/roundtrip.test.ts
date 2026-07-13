// Real-browser WebSocket roundtrip — runs INSIDE headless Chromium (AGENTS §16.2): no
// `@src/*` or `node:*` import here, only the browser-native `WebSocket` and the
// `wsUrl` the Node-side `setupIntegration.ts` provided (booting the package's
// own `createNodeWebSocket` server). Proves the wire protocol actually round-trips
// against a real client, not just the in-memory Duplex pair the src:server suite drives.

import { describe, expect, inject, it } from 'vitest'

// Open a fresh browser-native WebSocket to the injected server URL and resolve once the
// handshake completes (`onopen`), or reject if the connection errors first.
function connect(): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(inject('wsUrl'))
		socket.addEventListener('open', () => resolve(socket), { once: true })
		socket.addEventListener('error', () => reject(new Error('WebSocket connect failed')), {
			once: true,
		})
	})
}

// Resolve with the next `message` event's decoded text.
function nextMessage(socket: WebSocket): Promise<string> {
	return new Promise((resolve) => {
		socket.addEventListener(
			'message',
			(event) => {
				resolve(String(event.data))
			},
			{ once: true },
		)
	})
}

// Resolve with the `close` event once it fires.
function nextClose(socket: WebSocket): Promise<CloseEvent> {
	return new Promise((resolve) => {
		socket.addEventListener('close', (event) => resolve(event), { once: true })
	})
}

describe('WebSocket integration — real browser roundtrip', () => {
	it('completes the handshake and reaches OPEN', async () => {
		const socket = await connect()
		expect(socket.readyState).toBe(WebSocket.OPEN)
		socket.close()
		await nextClose(socket)
	})

	it('echoes a text message', async () => {
		const socket = await connect()
		const reply = nextMessage(socket)
		socket.send('hello')
		expect(await reply).toBe('echo: hello')
		socket.close()
		await nextClose(socket)
	})

	it('round-trips a multibyte / emoji payload exactly', async () => {
		const socket = await connect()
		const payload = 'héllo 世界 🌍✨'
		const reply = nextMessage(socket)
		socket.send(payload)
		expect(await reply).toBe(`echo: ${payload}`)
		socket.close()
		await nextClose(socket)
	})

	it('client-initiated close resolves with code 1000 and wasClean true', async () => {
		const socket = await connect()
		const closed = nextClose(socket)
		socket.close(1000, 'bye')
		const event = await closed
		expect(event.code).toBe(1000)
		expect(event.wasClean).toBe(true)
	})

	it('server-initiated close (sentinel text) resolves with code 1000 and reason "done"', async () => {
		const socket = await connect()
		const closed = nextClose(socket)
		socket.send('close-me')
		const event = await closed
		expect(event.code).toBe(1000)
		expect(event.reason).toBe('done')
	})

	it('supports multiple sequential connections', async () => {
		const first = await connect()
		const firstReply = nextMessage(first)
		first.send('first')
		expect(await firstReply).toBe('echo: first')
		const firstClosed = nextClose(first)
		first.close()
		await firstClosed

		const second = await connect()
		expect(second.readyState).toBe(WebSocket.OPEN)
		const secondReply = nextMessage(second)
		second.send('second')
		expect(await secondReply).toBe('echo: second')
		second.close()
		await nextClose(second)
	})
})
