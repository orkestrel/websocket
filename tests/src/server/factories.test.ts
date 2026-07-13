import { PassThrough, Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createNodeWebSocket } from '@src/server'

// The WebSocket wrapper factory — that `createNodeWebSocket` returns a working
// `NodeWebSocketInterface` over a real upgraded socket. The full handshake / frame
// dispatch / ping / close behavior lives in NodeWebSocket.test.ts; here we only assert
// the factory wires up a usable handle in each mode (server writes the 101, client does
// not) over a genuine `node:stream` Duplex — no mock (AGENTS §16).

// A minimal real Duplex whose writes land in a `PassThrough` the test reads, so the
// handshake bytes are observable. Reads are unused (the factory only writes here).
class WritableEnd extends Duplex {
	readonly #sink: PassThrough
	constructor(sink: PassThrough) {
		super()
		this.#sink = sink
	}
	override _read(): void {}
	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error) => void,
	): void {
		this.#sink.write(chunk)
		callback()
	}
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve))
}

describe('createNodeWebSocket', () => {
	it('returns an open NodeWebSocketInterface that wrote the 101 handshake in server mode', async () => {
		const sink = new PassThrough()
		const received: Buffer[] = []
		sink.on('data', (chunk: Buffer) => received.push(chunk))
		const socket = new WritableEnd(sink)
		socket.on('error', () => {})

		const ws = createNodeWebSocket({ socket, key: 'dGhlIHNhbXBsZSBub25jZQ==' })
		await flush()

		expect(ws.readyState).toBe(1) // open
		expect(typeof ws.send).toBe('function')
		expect(Buffer.concat(received).toString('utf-8')).toContain('101 Switching Protocols')
		ws.destroy()
	})

	it('writes no handshake in client mode (no key)', async () => {
		const sink = new PassThrough()
		const received: Buffer[] = []
		sink.on('data', (chunk: Buffer) => received.push(chunk))
		const socket = new WritableEnd(sink)
		socket.on('error', () => {})

		const ws = createNodeWebSocket({ socket })
		await flush()

		expect(ws.readyState).toBe(1)
		expect(Buffer.concat(received).toString('utf-8')).not.toContain('Switching Protocols')
		ws.destroy()
	})
})
