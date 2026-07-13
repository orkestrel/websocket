import type { Duplex } from 'node:stream'
import type {
	NodeWebSocketEventMap,
	NodeWebSocketInterface,
	NodeWebSocketOptions,
	WebSocketReadyState,
} from './types.js'
import type { EmitterInterface } from '@orkestrel/emitter'
import { Emitter } from '@orkestrel/emitter'
import { computeWebSocketAccept, encodeWebSocketFrame, parseWebSocketFrame } from './helpers.js'
import {
	WEBSOCKET_CLOSE_NORMAL,
	WEBSOCKET_OPCODE_BINARY,
	WEBSOCKET_OPCODE_CLOSE,
	WEBSOCKET_OPCODE_PING,
	WEBSOCKET_OPCODE_PONG,
	WEBSOCKET_OPCODE_TEXT,
	WEBSOCKET_READY_CLOSED,
	WEBSOCKET_READY_CLOSING,
	WEBSOCKET_READY_CONNECTING,
	WEBSOCKET_READY_OPEN,
} from './constants.js'

/**
 * A server-native WebSocket over a raw upgraded `node:stream` Duplex — the lean
 * wrapper around the RFC 6455 wire protocol.
 *
 * @remarks
 * Created by `createNodeWebSocket`. When given a client `key` it runs in SERVER mode —
 * it writes the `101 Switching Protocols` handshake (`computeWebSocketAccept(key)`) and
 * emits `open`; given no key it runs in CLIENT mode (no handshake, frames masked). It
 * then listens on the socket's `data`, accumulating bytes in `#buffer` and decoding
 * every complete frame with {@link parseWebSocketFrame} (slicing `consumed` and
 * re-parsing the remainder): a TEXT frame — reassembling continuation fragments across
 * `fin: false` frames — decodes to UTF-8 and emits `message`; a PING is auto-answered
 * with a PONG and emits `ping`; a PONG emits `pong`; a CLOSE is echoed and ends the
 * socket, emitting `close`. `send` writes a text frame, `ping` a ping, `close` a close
 * frame; `destroy` tears down immediately. It owns a typed `#emitter` (AGENTS §13) that
 * isolates a throwing listener and routes the error to its own `error` handler (the `error`
 * option) — the socket never crashes. The untyped socket `data` is narrowed to a `Buffer`
 * with a guard, never an assertion (AGENTS §14).
 */
export class NodeWebSocket implements NodeWebSocketInterface {
	readonly #emitter: Emitter<NodeWebSocketEventMap>
	readonly #socket: Duplex
	readonly #protocol: string | undefined
	readonly #masked: boolean
	#buffer: Buffer = Buffer.alloc(0)
	#readyState: WebSocketReadyState = WEBSOCKET_READY_CONNECTING
	#code: number | undefined = undefined
	#reason: string | undefined = undefined
	#fragments: Buffer[] = []
	#destroyed = false

	// The socket listeners are bound fields so `destroy` can detach exactly these.
	readonly #onData = (chunk: unknown): void => {
		if (this.#readyState === WEBSOCKET_READY_CLOSED) return
		const bytes = this.#bytes(chunk)
		if (bytes === undefined) return
		this.#buffer = Buffer.concat([this.#buffer, bytes])
		this.#drain()
	}

	readonly #onClose = (): void => {
		this.#finish()
	}

	readonly #onError = (error: unknown): void => {
		this.#emitter.emit('error', error)
	}

	constructor(options: NodeWebSocketOptions) {
		this.#emitter = new Emitter({ on: options.on, error: options.error })
		this.#socket = options.socket
		this.#protocol = options.protocol
		// Server mode is identified by a client key (it writes the handshake + sends
		// unmasked frames); without one this is a client (no handshake, masked frames).
		this.#masked = options.key === undefined

		if (options.key !== undefined) {
			const protocol =
				this.#protocol === undefined ? '' : `Sec-WebSocket-Protocol: ${this.#protocol}\r\n`
			this.#socket.write(
				'HTTP/1.1 101 Switching Protocols\r\n' +
					'Upgrade: websocket\r\n' +
					'Connection: Upgrade\r\n' +
					`Sec-WebSocket-Accept: ${computeWebSocketAccept(options.key)}\r\n` +
					protocol +
					'\r\n',
			)
		}

		this.#readyState = WEBSOCKET_READY_OPEN
		this.#socket.on('data', this.#onData)
		this.#socket.on('close', this.#onClose)
		this.#socket.on('error', this.#onError)
		this.#emitter.emit('open')

		// Replay any bytes buffered after the upgrade headers through the same path.
		const head = options.head
		if (head !== undefined && head.length > 0) {
			this.#buffer = Buffer.concat([this.#buffer, head])
			this.#drain()
		}
	}

	get emitter(): EmitterInterface<NodeWebSocketEventMap> {
		return this.#emitter
	}

	get readyState(): WebSocketReadyState {
		return this.#readyState
	}

	send(data: string): void {
		if (this.#readyState !== WEBSOCKET_READY_OPEN) return
		this.#write(WEBSOCKET_OPCODE_TEXT, Buffer.from(data, 'utf-8'))
	}

	ping(data?: string): void {
		if (this.#readyState !== WEBSOCKET_READY_OPEN) return
		this.#write(
			WEBSOCKET_OPCODE_PING,
			data === undefined ? Buffer.alloc(0) : Buffer.from(data, 'utf-8'),
		)
	}

	close(code?: number, reason?: string): void {
		if (
			this.#readyState === WEBSOCKET_READY_CLOSING ||
			this.#readyState === WEBSOCKET_READY_CLOSED
		) {
			return
		}
		this.#readyState = WEBSOCKET_READY_CLOSING
		this.#code = code ?? WEBSOCKET_CLOSE_NORMAL
		this.#reason = reason === undefined || reason.length === 0 ? undefined : reason
		this.#write(WEBSOCKET_OPCODE_CLOSE, this.#encodeClose(this.#code, this.#reason))
		// End the writable side after the close frame; the peer's echo (or the socket
		// `close`) drives the final state transition through `#finish`.
		this.#socket.end()
	}

	destroy(): void {
		if (this.#destroyed) return
		this.#destroyed = true
		this.#socket.off('data', this.#onData)
		this.#socket.off('close', this.#onClose)
		this.#socket.off('error', this.#onError)
		if (!this.#socket.destroyed) this.#socket.destroy()
		this.#finish()
		this.#emitter.destroy()
	}

	// Decode every complete frame currently in the buffer, dispatching each and slicing
	// it off; stops when a partial frame remains (parse returns `undefined`).
	#drain(): void {
		for (;;) {
			const frame = parseWebSocketFrame(this.#buffer)
			if (frame === undefined) return
			this.#buffer = this.#buffer.subarray(frame.consumed)
			this.#dispatch(frame.fin, frame.opcode, frame.payload)
			if (this.#readyState === WEBSOCKET_READY_CLOSED) return
		}
	}

	// Route one decoded frame by opcode. Text/binary data frames (and continuation
	// frames, opcode 0) accumulate fragments until FIN, then emit one `message`;
	// control frames (ping/pong/close) act immediately.
	#dispatch(fin: boolean, opcode: number, payload: Buffer): void {
		if (opcode === WEBSOCKET_OPCODE_TEXT || opcode === WEBSOCKET_OPCODE_BINARY || opcode === 0x00) {
			this.#fragments.push(payload)
			if (!fin) return
			const message = Buffer.concat(this.#fragments).toString('utf-8')
			this.#fragments = []
			this.#emitter.emit('message', message)
			return
		}

		if (opcode === WEBSOCKET_OPCODE_PING) {
			this.#write(WEBSOCKET_OPCODE_PONG, payload)
			this.#emitter.emit('ping')
			return
		}

		if (opcode === WEBSOCKET_OPCODE_PONG) {
			this.#emitter.emit('pong')
			return
		}

		if (opcode === WEBSOCKET_OPCODE_CLOSE) {
			this.#decodeClose(payload)
			if (this.#readyState === WEBSOCKET_READY_OPEN) {
				// Echo the peer's close frame before ending, per RFC 6455 §5.5.1.
				this.#readyState = WEBSOCKET_READY_CLOSING
				this.#write(WEBSOCKET_OPCODE_CLOSE, payload)
			}
			this.#socket.end()
			this.#finish()
		}
	}

	// Write one frame to the socket — masked in client mode, unmasked in server mode.
	// A destroyed socket silently drops the write (the lifecycle is already ending).
	#write(opcode: number, payload: Buffer): void {
		if (this.#socket.destroyed) return
		this.#socket.write(encodeWebSocketFrame(opcode, payload, { masked: this.#masked }))
	}

	// Build a close-frame payload: the 2-byte big-endian code, then the optional UTF-8
	// reason. An undefined code yields an empty payload (a bare close).
	#encodeClose(code: number | undefined, reason: string | undefined): Buffer {
		if (code === undefined) return Buffer.alloc(0)
		const text = reason === undefined ? Buffer.alloc(0) : Buffer.from(reason, 'utf-8')
		const payload = Buffer.alloc(2 + text.length)
		payload.writeUInt16BE(code, 0)
		text.copy(payload, 2)
		return payload
	}

	// Read a peer close-frame payload into `#code` / `#reason` (a payload under 2 bytes
	// is a bare close — no code).
	#decodeClose(payload: Buffer): void {
		if (payload.length < 2) {
			this.#code = undefined
			this.#reason = undefined
			return
		}
		this.#code = payload.readUInt16BE(0)
		const reason = payload.length > 2 ? payload.subarray(2).toString('utf-8') : ''
		this.#reason = reason.length === 0 ? undefined : reason
	}

	// Transition to CLOSED once (idempotent) and emit the final `close` with the last
	// known code/reason.
	#finish(): void {
		if (this.#readyState === WEBSOCKET_READY_CLOSED) return
		this.#readyState = WEBSOCKET_READY_CLOSED
		this.#emitter.emit('close', this.#code, this.#reason)
	}

	// Narrow an untyped socket `data` chunk to a `Buffer` (AGENTS §14) — a `node:net`
	// socket without an explicit encoding yields Buffers, but the listener parameter is
	// `unknown`, so it crosses through this guard, never an assertion. A non-Buffer
	// chunk (a string from a mis-encoded socket) is normalized; anything else is dropped.
	#bytes(chunk: unknown): Buffer | undefined {
		if (Buffer.isBuffer(chunk)) return chunk
		if (typeof chunk === 'string') return Buffer.from(chunk, 'utf-8')
		return undefined
	}
}
