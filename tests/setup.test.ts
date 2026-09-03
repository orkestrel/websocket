// Proof of `tests/setup.ts` — the host-independent helpers the workspace's suites share:
// seeded text generation, the integration command vocabulary, and the pure browser
// `WebSocket` helpers. Node 22 ships `WebSocket` and `MessageEvent` as real globals, so
// `connect` and `nextMessage` are driven end to end against the shared `createEchoServer`
// fixture here. `nextClose`'s `CloseEvent` type has no Node runtime constructor, but the
// real `WebSocket` client still dispatches a real close event through the same listener
// path, so it is driven the same way.

import { describe, expect, it } from 'vitest'
import {
	buildText,
	connect,
	INTEGRATION_CLOSE_CUSTOM_REQUEST,
	INTEGRATION_CLOSE_NORMAL_REQUEST,
	INTEGRATION_COUNT_PREFIX,
	INTEGRATION_COUNT_REQUEST,
	nextClose,
	nextMessage,
} from './setup.js'
import { createEchoServer } from './setupServer.js'

describe('buildText', () => {
	it('is deterministic for a given rng and produces the requested code-point length', () => {
		let calls = 0
		const rng = (): number => {
			calls += 1
			return (calls % 97) / 97
		}
		const first = buildText(rng, 12)
		calls = 0
		const second = buildText(rng, 12)
		expect(first).toBe(second)
		expect(Array.from(first).length).toBe(12)
	})

	it('returns an empty string for zero length', () => {
		expect(buildText(() => 0, 0)).toBe('')
	})

	it('shifts a surrogate-range sample into the BMP instead of emitting a lone surrogate', () => {
		// `0xd800 / 0xffff` is the smallest rng() output that floors to 0xd800, the first code
		// point the surrogate range excludes. The documented shift subtracts 0x800.
		const text = buildText(() => 0xd800 / 0xffff, 1)
		const point = text.codePointAt(0)
		expect(point).toBe(0xd000)
		expect(point).toBeLessThan(0xd800)
	})
})

describe('integration command vocabulary', () => {
	it('is a set of distinct non-empty strings the echo fixture routes on', () => {
		const commands = [
			INTEGRATION_CLOSE_NORMAL_REQUEST,
			INTEGRATION_CLOSE_CUSTOM_REQUEST,
			INTEGRATION_COUNT_REQUEST,
			INTEGRATION_COUNT_PREFIX,
		]
		for (const command of commands) expect(command.length).toBeGreaterThan(0)
		expect(new Set(commands).size).toBe(commands.length)
	})
})

describe('connect', () => {
	it('resolves an open WebSocket against a real loopback server', async () => {
		const fixture = await createEchoServer()
		try {
			const ws = await connect(fixture.url)
			try {
				expect(ws.readyState).toBe(WebSocket.OPEN)
			} finally {
				ws.close()
			}
		} finally {
			await fixture.destroy()
		}
	})

	it('rejects when the target refuses the connection', async () => {
		const fixture = await createEchoServer()
		const refusedUrl = fixture.url
		await fixture.destroy()
		await expect(connect(refusedUrl)).rejects.toBeDefined()
	})
})

describe('nextMessage and nextClose', () => {
	it('resolves the next real message event with the server echo', async () => {
		const fixture = await createEchoServer()
		try {
			const ws = await connect(fixture.url)
			ws.send('hello')
			const event = await nextMessage(ws)
			expect(event.data).toBe('echo: hello')
			ws.close()
		} finally {
			await fixture.destroy()
		}
	})

	it('resolves the next real close event with the server-chosen code and reason', async () => {
		const fixture = await createEchoServer()
		try {
			const ws = await connect(fixture.url)
			ws.send(INTEGRATION_CLOSE_CUSTOM_REQUEST)
			const event = await nextClose(ws)
			expect(event.code).toBe(4000)
			expect(event.reason).toBe('app-reason')
		} finally {
			await fixture.destroy()
		}
	})
})
