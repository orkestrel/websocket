// Global setup for the `integration` project (AGENTS §16 live-service exception) — runs
// ONCE in Node, before headless Chromium starts, and stays out of the browser-side test
// files entirely (they import nothing from `@src/*` or `node:*`). It boots a real
// `node:http` server, upgrades every request to a server-mode `createNodeWebSocket`
// (the package's own public factory — the same wiring shown in its TSDoc example), and
// echoes text frames back as `echo: <text>`; the sentinel text `'close-me'` triggers a
// server-initiated close instead of an echo. The listening URL is handed to the browser
// side via `provide('wsUrl', …)`, read back with `inject('wsUrl')` in the test files.

import type { TestProject } from 'vitest/node'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import { createNodeWebSocket } from '@src/server'
import type { NodeWebSocketInterface } from '@src/server'

declare module 'vitest' {
	export interface ProvidedContext {
		wsUrl: string
	}
}

export default async function setup({ provide }: TestProject): Promise<() => Promise<void>> {
	const sockets = new Set<NodeWebSocketInterface>()

	const server: Server = createServer((_request, response) => {
		response.writeHead(404)
		response.end()
	})

	server.on('upgrade', (request, socket: Socket, head) => {
		const key = request.headers['sec-websocket-key']
		if (typeof key !== 'string') {
			socket.destroy()
			return
		}
		const ws = createNodeWebSocket({
			socket,
			key,
			head,
			on: {
				message: (text) => {
					if (text === 'close-me') {
						ws.close(1000, 'done')
						return
					}
					if (text === 'close-4000') {
						ws.close(4000, 'app-reason')
						return
					}
					if (text === 'count') {
						ws.send(`count: ${sockets.size}`)
						return
					}
					ws.send(`echo: ${text}`)
				},
				close: () => {
					sockets.delete(ws)
				},
			},
		})
		sockets.add(ws)
	})

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

	const address = server.address()
	const port = address !== null && typeof address === 'object' ? address.port : undefined
	if (port === undefined) throw new Error('Integration server failed to bind a port')

	provide('wsUrl', `ws://127.0.0.1:${port}`)

	return async () => {
		for (const ws of sockets) ws.destroy()
		sockets.clear()
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()))
		})
	}
}
