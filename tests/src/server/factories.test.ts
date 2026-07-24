import { describe, expect, it } from 'vitest'
import { createNodeWebSocket } from '@src/server'
import { duplexPair, flushSocket } from '../../setupServer.js'

// The WebSocket wrapper factory — that `createNodeWebSocket` returns a working
// `NodeWebSocketInterface` over a real upgraded socket. The full handshake / frame
// dispatch / ping / close behavior lives in NodeWebSocket.test.ts; here we only assert
// the factory wires up a usable handle in each mode (server writes the 101, client does
// not) over a genuine `node:stream` Duplex — no mock (AGENTS §16).

describe('createNodeWebSocket', () => {
	it('returns an open NodeWebSocketInterface that wrote the 101 handshake in server mode', async () => {
		const [socket, peer] = duplexPair()
		const received: Buffer[] = []
		peer.on('data', (chunk: Buffer) => received.push(chunk))

		const ws = createNodeWebSocket({ socket, key: 'dGhlIHNhbXBsZSBub25jZQ==' })
		await flushSocket()

		expect(ws.readyState).toBe(1) // open
		expect(typeof ws.send).toBe('function')
		expect(Buffer.concat(received).toString('utf-8')).toContain('101 Switching Protocols')
		ws.destroy()
	})

	it('writes no handshake in client mode (no key)', async () => {
		const [socket, peer] = duplexPair()
		const received: Buffer[] = []
		peer.on('data', (chunk: Buffer) => received.push(chunk))

		const ws = createNodeWebSocket({ socket })
		await flushSocket()

		expect(ws.readyState).toBe(1)
		expect(Buffer.concat(received).toString('utf-8')).not.toContain('Switching Protocols')
		ws.destroy()
	})
})
