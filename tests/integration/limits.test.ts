// Real-browser WebSocket limit/stress battery — runs INSIDE headless Chromium (AGENTS
// §16.2): no `@src/*` or `node:*` import here, only the browser-native `WebSocket` and
// the shared browser helpers from `tests/setup.ts` (env-agnostic, framework-free), plus
// the injected `wsUrl` the Node-side `setupIntegration.ts` provides.

import { describe, expect, inject, it } from 'vitest'
import { buildText, connect, createRandom, nextClose, nextMessage } from '../setup.js'

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
		const payload = `${sampled}🔥🧵👩‍👩‍👧‍👦éCJK漢字中文한글`
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
		final.send('count')
		const event = await reply
		const countMatch = /^count: (\d+)$/.exec(String(event.data))
		expect(countMatch).not.toBeNull()
		const count = countMatch === null ? Number.NaN : Number(countMatch[1])
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
		socket.send('close-4000')
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
		reconnected.send('count')
		const countEvent = await reply
		const countMatch = /^count: (\d+)$/.exec(String(countEvent.data))
		expect(countMatch).not.toBeNull()
		const count = countMatch === null ? Number.NaN : Number(countMatch[1])
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
