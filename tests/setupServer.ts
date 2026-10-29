// Node-only fixtures shared by the server source tests, the `setup` suite, and the
// `integration` project's global setup. The `integration` project's own test file imports
// `tests/setup.ts` instead and reaches nothing under `node:*` or `@src/*`, so the
// platform-WebSocket client side stays free of Node primitives.

import type { NodeWebSocketInterface, WebSocketFrame } from '@src/server'
import type { LoopbackInterface } from '@orkestrel/test/server'
import type { Socket } from 'node:net'
import { createServer } from 'node:http'
import { Duplex, PassThrough } from 'node:stream'
import { createLoopback } from '@orkestrel/test/server'
import { createNodeWebSocket, encodeWebSocketFrame, parseWebSocketFrame } from '@src/server'
import {
	INTEGRATION_CLOSE_CUSTOM_REQUEST,
	INTEGRATION_CLOSE_NORMAL_REQUEST,
	INTEGRATION_COUNT_PREFIX,
	INTEGRATION_COUNT_REQUEST,
} from './setup.js'

// One endpoint of a cross-wired in-memory socket pair. Writes enter the partner's
// inbound channel; reads are push-driven by this endpoint's own channel.
class DuplexEnd extends Duplex {
	readonly #inbound: PassThrough
	readonly #outbound: PassThrough

	constructor(inbound: PassThrough, outbound: PassThrough) {
		super()
		this.#inbound = inbound
		this.#outbound = outbound
		this.#inbound.on('data', (chunk: Buffer) => {
			this.push(chunk)
		})
		this.#inbound.on('end', () => {
			this.push(null)
		})
	}

	override _read(): void {}

	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error) => void,
	): void {
		this.#outbound.write(chunk)
		callback()
	}
}

/** Creates a real, cross-wired in-memory Duplex pair without harness error sinks. */
export function duplexPair(): readonly [Duplex, Duplex] {
	const toServer = new PassThrough()
	const toClient = new PassThrough()
	return [new DuplexEnd(toServer, toClient), new DuplexEnd(toClient, toServer)]
}

/** Waits for frame writes to propagate across a {@link duplexPair}. */
export function flushSocket(): Promise<void> {
	return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

/** Options for {@link encodeTestFrame}, adding explicit FIN control to the public encoder. */
export interface TestFrameOptions {
	readonly masked?: boolean
	readonly fin?: boolean
	readonly mask?: Buffer
}

/** Represents the live echo fixture: the URL clients dial, the sockets it holds, and its teardown. */
export interface EchoServerInterface {
	readonly url: string
	readonly sockets: ReadonlySet<NodeWebSocketInterface>
	destroy(): Promise<void>
}

/** Builds deterministic pseudo-random bytes from a seeded generator. */
export function randomBuffer(rng: () => number, length: number): Buffer {
	const buffer = Buffer.alloc(length)
	for (const [index] of buffer.entries()) buffer[index] = Math.floor(rng() * 256)
	return buffer
}

/**
 * Builds the frame-payload corpus that spans every RFC 6455 length form: the 7-bit form
 * (0, 1, 125), the 126 + 16-bit boundary (126, 127, 65 535), the 127 + 64-bit boundary
 * (65 536), then large payloads up to 200 KB.
 *
 * @param rng - A seeded generator (see `seededRandom` from `@orkestrel/contract`), which fixes every byte, so one seed yields one corpus
 * @returns The payloads, the repeated short forms first and the large payloads last
 */
export function buildCorpus(rng: () => number): readonly Buffer[] {
	const lengths = [0, 1, 125, 126, 127, 65_535, 65_536]
	const large = [70_000, 90_000, 120_000, 150_000, 200_000]
	return [
		...lengths.flatMap((length) => Array.from({ length: 25 }, () => randomBuffer(rng, length))),
		...large.map((length) => randomBuffer(rng, length)),
	]
}

/** Encodes one RFC 6455 frame for tests, optionally clearing FIN for fragmentation cases. */
export function encodeTestFrame(
	opcode: number,
	payload: Buffer | string,
	options?: TestFrameOptions,
): Buffer {
	const wire = encodeWebSocketFrame(opcode, payload, options)
	if (options?.fin === false) {
		wire.writeUInt8(wire.readUInt8(0) & 0x7f, 0)
	}
	return wire
}

/**
 * Collects frames written to a pair's client endpoint after stripping the HTTP upgrade
 * response. The returned array grows as complete frames arrive.
 */
export function readClientFrames(client: Duplex): { readonly frames: readonly WebSocketFrame[] } {
	return new ClientFrames(client)
}

class ClientFrames {
	readonly #frames: WebSocketFrame[] = []
	#buffer: Buffer = Buffer.alloc(0)
	#handshook = false
	readonly #terminator = Buffer.from('\r\n\r\n')

	constructor(client: Duplex) {
		client.on('data', (chunk: Buffer) => this.#receive(chunk))
	}

	get frames(): readonly WebSocketFrame[] {
		return this.#frames
	}

	#receive(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk])
		if (!this.#handshook) {
			const index = this.#buffer.indexOf(this.#terminator)
			if (index < 0) return
			this.#buffer = this.#buffer.subarray(index + this.#terminator.length)
			this.#handshook = true
		}
		for (;;) {
			const parsed = parseWebSocketFrame(this.#buffer)
			if (parsed === undefined) return
			this.#buffer = this.#buffer.subarray(parsed.consumed)
			this.#frames.push(parsed)
		}
	}
}

// The listening half of the echo fixture: it holds the loopback and the live socket set
// that `createEchoServer` wires, and tears both down. The wiring stays in the factory
// because the upgrade handler is where a socket joins the set.
class EchoServer implements EchoServerInterface {
	readonly #loopback: LoopbackInterface
	readonly #sockets: Set<NodeWebSocketInterface>

	constructor(loopback: LoopbackInterface, sockets: Set<NodeWebSocketInterface>) {
		this.#loopback = loopback
		this.#sockets = sockets
	}

	get url(): string {
		return `ws://127.0.0.1:${this.#loopback.port}`
	}

	get sockets(): ReadonlySet<NodeWebSocketInterface> {
		return this.#sockets
	}

	async destroy(): Promise<void> {
		for (const ws of this.#sockets) ws.destroy()
		this.#sockets.clear()
		await this.#loopback.destroy()
	}
}

/**
 * Starts a real loopback `node:http` server that upgrades every WebSocket request to a
 * server-mode `createNodeWebSocket` and echoes each text frame back as `echo: <text>`.
 *
 * @returns The listening fixture — its `ws://` URL, its live sockets, and its teardown
 *
 * @remarks
 * Routing reads the integration command vocabulary `tests/setup.ts` centralizes:
 * `INTEGRATION_CLOSE_NORMAL_REQUEST` closes `1000` with `done`,
 * `INTEGRATION_CLOSE_CUSTOM_REQUEST` closes `4000` with `app-reason`, and
 * `INTEGRATION_COUNT_REQUEST` answers `INTEGRATION_COUNT_PREFIX` plus the live socket
 * total. A plain request answers `404`, and an upgrade request carrying no string
 * `sec-websocket-key` header has its socket destroyed.
 */
export async function createEchoServer(): Promise<EchoServerInterface> {
	const sockets = new Set<NodeWebSocketInterface>()
	const server = createServer((_request, response) => {
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
	return new EchoServer(await createLoopback(server), sockets)
}
