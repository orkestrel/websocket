// Global setup for the `integration` project (AGENTS §16 live-service exception) — runs
// ONCE in Node, before the client-side tests start, and stays out of the client-side test
// files entirely (they import nothing from `@src/*` or `node:*`). It boots a real
// `node:http` server, upgrades every request to a server-mode `createNodeWebSocket`
// (the package's own public factory — the same wiring shown in its TSDoc example), and
// echoes text frames back as `echo: <text>`; a small centralized command vocabulary
// drives close/count assertions. The listening URL is handed to the browser
// side via `provide('wsUrl', …)`, read back with `inject('wsUrl')` in the test files.

import type { TestProject } from 'vitest/node'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import { createLoopback } from '@orkestrel/test/server'
import { createNodeWebSocket } from '@src/server'
import type { NodeWebSocketInterface } from '@src/server'
import {
	INTEGRATION_CLOSE_CUSTOM_REQUEST,
	INTEGRATION_CLOSE_NORMAL_REQUEST,
	INTEGRATION_COUNT_PREFIX,
	INTEGRATION_COUNT_REQUEST,
} from './setup.js'

declare module 'vitest' {
	export interface ProvidedContext {
		wsUrl: string
	}
}

export async function setup({ provide }: TestProject): Promise<() => Promise<void>> {
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
					if (text === INTEGRATION_CLOSE_NORMAL_REQUEST) {
						ws.close(1000, 'done')
						return
					}
					if (text === INTEGRATION_CLOSE_CUSTOM_REQUEST) {
						ws.close(4000, 'app-reason')
						return
					}
					if (text === INTEGRATION_COUNT_REQUEST) {
						ws.send(`${INTEGRATION_COUNT_PREFIX}${sockets.size}`)
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

	const loopback = await createLoopback(server)

	provide('wsUrl', `ws://127.0.0.1:${loopback.port}`)

	return async () => {
		for (const ws of sockets) ws.destroy()
		sockets.clear()
		await loopback.destroy()
	}
}
