import type { NodeWebSocketInterface, NodeWebSocketOptions } from './types.js'
import { NodeWebSocket } from './NodeWebSocket.js'

/**
 * Creates a server-native WebSocket over a raw upgraded `node:stream` Duplex socket —
 * server mode when a `key` is given, client mode otherwise.
 *
 * @remarks
 * The construction entry point for the {@link NodeWebSocketInterface}. In server mode the
 * wrapper writes the `101 Switching Protocols` handshake and sends unmasked frames; in
 * client mode it writes no handshake and masks every outgoing frame. This is the
 * lean-native handle: it speaks the WebSocket wire protocol and nothing above it, so a
 * message transport is built on it rather than into it.
 *
 * @param options - The {@link NodeWebSocketOptions} (`socket`, optional `key` / `head` /
 *   `protocol` / `on`)
 * @returns A typed {@link NodeWebSocketInterface}
 * @throws A `WebSocketError` coded `OPTION` when `payload`, `timeout`, `key`, or `protocol` is refused, thrown before the wrapper writes to or assumes ownership of the `socket`
 *
 * @example Accept an upgrade and echo messages (server mode)
 * ```ts
 * import { createNodeWebSocket } from '@orkestrel/websocket'
 *
 * server.on('upgrade', (request, socket, head) => {
 * 	const key = request.headers['sec-websocket-key']
 * 	if (typeof key !== 'string') {
 * 		socket.destroy()
 * 		return
 * 	}
 * 	const ws = createNodeWebSocket({
 * 		socket,
 * 		key,
 * 		head, // any bytes already buffered after the upgrade headers
 * 		on: { message: (text) => ws.send(`echo: ${text}`) }, // wired before the first frame arrives
 * 	})
 * 	ws.emitter.on('message', (text) => log('echoed', text)) // a second observer of the same event
 * 	ws.emitter.on('close', (code, reason) => log('closed', code, reason))
 * })
 * ```
 */
export function createNodeWebSocket(options: NodeWebSocketOptions): NodeWebSocketInterface {
	return new NodeWebSocket(options)
}
