// Node-only fixtures shared by the server source tests. The browser integration
// project loads `tests/setup.ts` instead, so `node:*` primitives stay isolated here.

import type { WebSocketFrame } from '@src/server'
import { Duplex, PassThrough } from 'node:stream'
import { encodeWebSocketFrame, parseWebSocketFrame } from '@src/server'

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

/** Create a real, cross-wired in-memory Duplex pair without harness error sinks. */
export function duplexPair(): readonly [Duplex, Duplex] {
	const toServer = new PassThrough()
	const toClient = new PassThrough()
	return [new DuplexEnd(toServer, toClient), new DuplexEnd(toClient, toServer)]
}

/** Wait for frame writes to propagate across a {@link duplexPair}. */
export function flushSocket(): Promise<void> {
	return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

/** Options for {@link frame}, adding explicit FIN control to the public encoder. */
export interface TestFrameOptions {
	readonly masked?: boolean
	readonly fin?: boolean
	readonly mask?: Buffer
}

/** Build deterministic pseudo-random bytes from a seeded generator. */
export function randomBuffer(rng: () => number, length: number): Buffer {
	const buffer = Buffer.alloc(length)
	for (let index = 0; index < length; index += 1) buffer[index] = Math.floor(rng() * 256)
	return buffer
}

/** Encode one test frame, optionally clearing FIN for fragmentation cases. */
export function frame(
	opcode: number,
	payload: Buffer | string,
	options?: TestFrameOptions,
): Buffer {
	const wire = encodeWebSocketFrame(opcode, payload, {
		masked: options?.masked,
		mask: options?.mask,
	})
	if (options?.fin === false) {
		wire.writeUInt8(wire.readUInt8(0) & 0x7f, 0)
	}
	return wire
}

/**
 * Collect frames written to a pair's client endpoint after stripping the HTTP upgrade
 * response. The returned array grows as complete frames arrive.
 */
export function readClientFrames(client: Duplex): { readonly frames: readonly WebSocketFrame[] } {
	const frames: WebSocketFrame[] = []
	let buffer = Buffer.alloc(0)
	let handshook = false
	const handshakeEnd = Buffer.from('\r\n\r\n')
	client.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk])
		if (!handshook) {
			const index = buffer.indexOf(handshakeEnd)
			if (index < 0) return
			buffer = buffer.subarray(index + handshakeEnd.length)
			handshook = true
		}
		for (;;) {
			const parsed = parseWebSocketFrame(buffer)
			if (parsed === undefined) return
			buffer = buffer.subarray(parsed.consumed)
			frames.push(parsed)
		}
	})
	return { frames }
}
