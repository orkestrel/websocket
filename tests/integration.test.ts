// Live-client WebSocket integration battery — driven by the platform WebSocket client
// (AGENTS §16.2): no `@src/*` or `node:*` import here, only the browser-native `WebSocket`,
// the shared browser helpers from `tests/setup.ts` (env-agnostic, framework-free), and the
// injected `wsUrl` the Node-side `setupGlobal.ts` provides (booting the package's own
// `createNodeWebSocket` server). These prove the wire protocol actually round-trips against a
// real client, not just the in-memory Duplex pair the src:server suite drives. They are slow
// and environment-dependent, so they are kept OUT of the default `test` run and live in this
// dedicated, opt-in `integration` project instead (run via `npm run test:integration`).

import { describe, expect, inject, it } from 'vitest'
import {
	buildText,
	connect,
	createRandom,
	INTEGRATION_CLOSE_CUSTOM_REQUEST,
	INTEGRATION_CLOSE_NORMAL_REQUEST,
	INTEGRATION_COUNT_PREFIX,
	INTEGRATION_COUNT_REQUEST,
	nextClose,
	nextMessage,
	requireValue,
} from './setup.js'

describe('WebSocket integration — live client roundtrip', () => {
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

describe('WebSocket integration — limit & stress battery', () => {
	it('round-trips a 2 MB text message byte-exact', async () => {
		const socket = await connect(inject('wsUrl'))
		const payload = buildText(createRandom(7), 2_000_000)
		const reply = nextMessage(socket)
		socket.send(payload)
		const event = await reply
		expect(String(event.data)).toBe(`echo: ${payload}`)
		socket.close()
		await nextClose(socket)
	})

	it('round-trips a UTF-8 stress string exactly', async () => {
		const socket = await connect(inject('wsUrl'))
		const rng = createRandom(11)
		const sampled = buildText(rng, 200)
		const payload = `${sampled}🔥🧵👩‍👩‍👧‍👦éCJK漢字中文한글`
		const reply = nextMessage(socket)
		socket.send(payload)
		const event = await reply
		expect(String(event.data)).toBe(`echo: ${payload}`)
		socket.close()
		await nextClose(socket)
	})

	it('observes a 1003 close when it sends binary', async () => {
		const socket = await connect(inject('wsUrl'))
		const closed = nextClose(socket)
		socket.send(new Uint8Array([1, 2, 3]))
		const event = await closed
		expect(event.code).toBe(1003)
	})

	it('opens/echoes/closes 25 times sequentially with no server accumulation', async () => {
		for (let index = 0; index < 25; index += 1) {
			const socket = await connect(inject('wsUrl'))
			const reply = nextMessage(socket)
			socket.send(`hello-${index}`)
			expect(String((await reply).data)).toBe(`echo: hello-${index}`)
			const closed = nextClose(socket)
			socket.close()
			await closed
		}

		const final = await connect(inject('wsUrl'))
		const reply = nextMessage(final)
		final.send(INTEGRATION_COUNT_REQUEST)
		const event = await reply
		const countMatch = requireValue(
			new RegExp(`^${INTEGRATION_COUNT_PREFIX}(\\d+)$`).exec(String(event.data)),
		)
		const count = Number(requireValue(countMatch[1]))
		expect(count).toBeLessThanOrEqual(2)
		const closed = nextClose(final)
		final.close()
		await closed
	})

	it('runs 10 concurrent in-page sockets, each isolated, all closing cleanly', async () => {
		const sockets = await Promise.all(Array.from({ length: 10 }, () => connect(inject('wsUrl'))))

		const replies = sockets.map((socket, index) => {
			const reply = nextMessage(socket)
			socket.send(`socket-${index}`)
			return reply
		})

		const events = await Promise.all(replies)
		events.forEach((event, index) => {
			expect(String(event.data)).toBe(`echo: socket-${index}`)
		})

		const closes = sockets.map((socket) => nextClose(socket))
		sockets.forEach((socket) => socket.close())
		await Promise.all(closes)
	})

	it('observes a server-initiated custom-code close', async () => {
		const socket = await connect(inject('wsUrl'))
		const closed = nextClose(socket)
		socket.send(INTEGRATION_CLOSE_CUSTOM_REQUEST)
		const event = await closed
		expect(event.code).toBe(4000)
		expect(event.reason).toBe('app-reason')
	})

	it('reconnects cleanly after a browser custom-code close', async () => {
		const socket = await connect(inject('wsUrl'))
		const closed = nextClose(socket)
		// Browsers only permit client-initiated close codes 1000 or 3000-4999.
		socket.close(4001, 'bye')
		const event = await closed
		expect(event.code).toBe(4001)

		const reconnected = await connect(inject('wsUrl'))
		const reply = nextMessage(reconnected)
		reconnected.send(INTEGRATION_COUNT_REQUEST)
		const countEvent = await reply
		const countMatch = requireValue(
			new RegExp(`^${INTEGRATION_COUNT_PREFIX}(\\d+)$`).exec(String(countEvent.data)),
		)
		const count = Number(requireValue(countMatch[1]))
		expect(count).toBeLessThanOrEqual(2)
		const reconnectedClosed = nextClose(reconnected)
		reconnected.close()
		await reconnectedClosed
	})

	it('receives a 100-message burst in order', async () => {
		const socket = await connect(inject('wsUrl'))
		const messages: string[] = []
		const done = new Promise<void>((resolve) => {
			socket.addEventListener('message', (event) => {
				messages.push(String(event.data))
				if (messages.length === 100) resolve()
			})
		})

		for (let index = 0; index < 100; index += 1) {
			socket.send(String(index))
		}
		await done

		expect(messages).toEqual(Array.from({ length: 100 }, (_, index) => `echo: ${index}`))
		const closed = nextClose(socket)
		socket.close()
		await closed
	})
})
