// Real-browser WebSocket roundtrip — runs INSIDE headless Chromium (AGENTS §16.2): no
// `@src/*` or `node:*` import here, only the browser-native `WebSocket` and the
// `wsUrl` the Node-side `setupIntegration.ts` provided (booting the package's
// own `createNodeWebSocket` server). Proves the wire protocol actually round-trips
// against a real client, not just the in-memory Duplex pair the src:server suite drives.

import { describe, expect, inject, it } from 'vitest'
import { connect, INTEGRATION_CLOSE_NORMAL_REQUEST, nextClose, nextMessage } from '../setup.js'

describe('WebSocket integration — real browser roundtrip', () => {
	it('completes the handshake and reaches OPEN', async () => {
		const socket = await connect(inject('wsUrl'))
		expect(socket.readyState).toBe(WebSocket.OPEN)
		socket.close()
		await nextClose(socket)
	})

	it('echoes a text message', async () => {
		const socket = await connect(inject('wsUrl'))
		const reply = nextMessage(socket)
		socket.send('hello')
		expect(String((await reply).data)).toBe('echo: hello')
		socket.close()
		await nextClose(socket)
	})

	it('round-trips a multibyte / emoji payload exactly', async () => {
		const socket = await connect(inject('wsUrl'))
		const payload = 'héllo 世界 🌍✨'
		const reply = nextMessage(socket)
		socket.send(payload)
		expect(String((await reply).data)).toBe(`echo: ${payload}`)
		socket.close()
		await nextClose(socket)
	})

	it('client-initiated close resolves with code 1000 and wasClean true', async () => {
		const socket = await connect(inject('wsUrl'))
		const closed = nextClose(socket)
		socket.close(1000, 'bye')
		const event = await closed
		expect(event.code).toBe(1000)
		expect(event.wasClean).toBe(true)
	})

	it('server-initiated close resolves with code 1000 and reason "done"', async () => {
		const socket = await connect(inject('wsUrl'))
		const closed = nextClose(socket)
		socket.send(INTEGRATION_CLOSE_NORMAL_REQUEST)
		const event = await closed
		expect(event.code).toBe(1000)
		expect(event.reason).toBe('done')
	})

	it('supports multiple sequential connections', async () => {
		const first = await connect(inject('wsUrl'))
		const firstReply = nextMessage(first)
		first.send('first')
		expect(String((await firstReply).data)).toBe('echo: first')
		const firstClosed = nextClose(first)
		first.close()
		await firstClosed

		const second = await connect(inject('wsUrl'))
		expect(second.readyState).toBe(WebSocket.OPEN)
		const secondReply = nextMessage(second)
		second.send('second')
		expect(String((await secondReply).data)).toBe('echo: second')
		second.close()
		await nextClose(second)
	})
})
