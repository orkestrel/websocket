import type { NodeWebSocketInterface, NodeWebSocketOptions } from './types.js'
import { NodeWebSocket } from './NodeWebSocket.js'

/**
 * Create a server-native WebSocket over a raw upgraded `node:stream` Duplex socket.
 *
 * @remarks
 * The construction entry point for the {@link NodeWebSocketInterface} (AGENTS §8). Pass
 * the upgraded `socket` plus the client's `Sec-WebSocket-Key` as `key` to run in SERVER
 * mode — the wrapper writes the `101 Switching Protocols` handshake and sends unmasked
 * frames; omit `key` for CLIENT mode (no handshake, masked frames). This is the
 * lean-native handle; it speaks only the WebSocket wire protocol — an MCP transport (the
 * later chunk) is built ON it. It is the WebSocket counterpart to
 * `createSQLiteDatabase` / `createIndexedDBDatabase`.
 *
 * @param options - The {@link NodeWebSocketOptions} (`socket`, optional `key` / `head` /
 *   `protocol` / `on`)
 * @returns A typed {@link NodeWebSocketInterface}
 *
 * @example
 * ```ts
 * import { createNodeWebSocket } from '@src/server'
 *
 * // In a node:http 'upgrade' handler — server mode, identified by the client key:
 * server.on('upgrade', (request, socket, head) => {
 * 	const ws = createNodeWebSocket({
 * 		socket,
 * 		key: request.headers['sec-websocket-key'],
 * 		head,
 * 		on: { message: (text) => ws.send(`echo: ${text}`) },
 * 	})
 * })
 * ```
 */
export function createNodeWebSocket(options: NodeWebSocketOptions): NodeWebSocketInterface {
	return new NodeWebSocket(options)
}
