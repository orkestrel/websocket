import type { Duplex } from 'node:stream'
import type {
	NodeWebSocketEventMap,
	NodeWebSocketInterface,
	NodeWebSocketOptions,
	WebSocketReadyState,
} from './types.js'
import type { EmitterInterface } from '@orkestrel/emitter'
import { Emitter } from '@orkestrel/emitter'
import {
	computeWebSocketAccept,
	encodeWebSocketFrame,
	isCloseCode,
	isWebSocketFrameCanonical,
	isWebSocketKey,
	isWebSocketProtocol,
	measureWebSocketFrame,
	parseUTF8,
	parseWebSocketFrame,
} from './helpers.js'
import {
	WEBSOCKET_CLOSE_INVALID,
	WEBSOCKET_CLOSE_NORMAL,
	WEBSOCKET_CLOSE_PROTOCOL,
	WEBSOCKET_CLOSE_REASON_MAXLEN,
	WEBSOCKET_CLOSE_TIMEOUT_MS,
	WEBSOCKET_CLOSE_TOOBIG,
	WEBSOCKET_CLOSE_UNSUPPORTED,
	WEBSOCKET_CONTROL_MAXLEN,
	WEBSOCKET_FAIL_TIMEOUT_MS,
	WEBSOCKET_MAX_PAYLOAD,
	WEBSOCKET_OPCODE_BINARY,
	WEBSOCKET_OPCODE_CLOSE,
	WEBSOCKET_OPCODE_CONTINUATION,
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
 * option) — the socket never crashes. An underlying socket error emits the domain
 * `error` event and terminates the wrapper. The untyped socket `data` is narrowed to a
 * `Buffer` with a guard, never an assertion (AGENTS §14).
 */
export class NodeWebSocket implements NodeWebSocketInterface {
	readonly #emitter: Emitter<NodeWebSocketEventMap>
	readonly #socket: Duplex
	readonly #masked: boolean
	readonly #payload: number
	readonly #timeout: number
	readonly #signal: AbortSignal | undefined
	readonly #dataListener: (chunk: unknown) => void
	readonly #closeListener: () => void
	readonly #errorListener: (error: unknown) => void
	readonly #abortListener: () => void
	#buffer: Buffer = Buffer.alloc(0)
	#readyState: WebSocketReadyState = WEBSOCKET_READY_CONNECTING
	#code: number | undefined
	#reason: string | undefined
	#fragments: Buffer[] = []
	#messageOpcode: number | undefined
	#fragmentBytes = 0
	#closeTimer: ReturnType<typeof setTimeout> | undefined
	#destroyed = false
	#detached = false

	constructor(options: NodeWebSocketOptions) {
		const payload = options.payload ?? WEBSOCKET_MAX_PAYLOAD
		if (!Number.isSafeInteger(payload) || payload < 0) {
			throw new RangeError('payload must be a non-negative safe integer')
		}
		const timeout = options.timeout ?? WEBSOCKET_CLOSE_TIMEOUT_MS
		if (!Number.isSafeInteger(timeout) || timeout < 0) {
			throw new RangeError('timeout must be a non-negative safe integer')
		}
		if (options.key !== undefined && !isWebSocketKey(options.key)) {
			throw new RangeError('key must be the canonical base64 encoding of 16 bytes')
		}
		if (options.protocol !== undefined && !isWebSocketProtocol(options.protocol)) {
			throw new RangeError('protocol must be a valid WebSocket subprotocol token')
		}
		if (options.protocol !== undefined && options.key === undefined) {
			throw new RangeError('protocol requires a server key')
		}

		this.#emitter = new Emitter({
			...(options.on === undefined ? {} : { on: options.on }),
			...(options.error === undefined ? {} : { error: options.error }),
		})
		this.#socket = options.socket
		// Server mode is identified by a client key (it writes the handshake + sends
		// unmasked frames); without one this is a client (no handshake, masked frames).
		this.#masked = options.key === undefined
		this.#payload = payload
		this.#timeout = timeout
		this.#signal = options.signal
		// Retain each bound listener so terminal paths detach only this wrapper's callbacks.
		this.#dataListener = this.#handleData.bind(this)
		this.#closeListener = this.#finish.bind(this)
		this.#errorListener = this.#handleError.bind(this)
		this.#abortListener = this.destroy.bind(this)

		if (options.key !== undefined) {
			const headers = [
				'HTTP/1.1 101 Switching Protocols',
				'Upgrade: websocket',
				'Connection: Upgrade',
				`Sec-WebSocket-Accept: ${computeWebSocketAccept(options.key)}`,
			]
			if (options.protocol !== undefined) {
				headers.push(`Sec-WebSocket-Protocol: ${options.protocol}`)
			}
			this.#socket.write(`${headers.join('\r\n')}\r\n\r\n`)
		}

		this.#readyState = WEBSOCKET_READY_OPEN
		this.#socket.on('data', this.#dataListener)
		this.#socket.on('close', this.#closeListener)
		this.#socket.on('error', this.#errorListener)
		this.#emitter.emit('open')

		// Replay any bytes buffered after the upgrade headers through the same ingest path
		// as `#handleData`, so the pre-buffer cap check applies uniformly (AGENTS §5 dedup).
		const head = options.head
		if (head !== undefined && head.length > 0) {
			this.#ingest(head)
		}

		// The external cancellation seam (composes with `@orkestrel/abort` /
		// `@orkestrel/timeout`'s native AbortSignals) — wired last so an already-aborted
		// signal tears the socket down only after the rest of construction has run. The
		// head-replay above can itself synchronously terminate the socket (a complete
		// CLOSE frame or an RFC violation routes through `#fail`/`#close` -> `#finish`),
		// which flushes the close frame GRACEFULLY via `#socket.end()`. In that case skip
		// the seam entirely: forcing `destroy()` would discard that flushing frame (the
		// loss `#fail` is engineered to avoid), and there is no live socket to attach to.
		if (this.#readyState !== WEBSOCKET_READY_CLOSED) {
			if (this.#signal?.aborted === true) {
				this.destroy()
			} else {
				this.#signal?.addEventListener('abort', this.#abortListener, { once: true })
			}
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
		if (data !== undefined && Buffer.byteLength(data, 'utf-8') > WEBSOCKET_CONTROL_MAXLEN) {
			throw new RangeError('ping payload exceeds 125 bytes')
		}
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
		if (code !== undefined && !isCloseCode(code)) throw new RangeError('invalid close code')
		if (
			reason !== undefined &&
			Buffer.byteLength(reason, 'utf-8') > WEBSOCKET_CLOSE_REASON_MAXLEN
		) {
			throw new RangeError(`close reason exceeds ${WEBSOCKET_CLOSE_REASON_MAXLEN} bytes`)
		}
		this.#readyState = WEBSOCKET_READY_CLOSING
		this.#code = code ?? WEBSOCKET_CLOSE_NORMAL
		this.#reason = reason === undefined || reason.length === 0 ? undefined : reason
		this.#write(WEBSOCKET_OPCODE_CLOSE, this.#encodeClose(this.#code, this.#reason))
		// End the writable side after the close frame; the peer's echo (or the socket
		// `close`) drives the final state transition through `#finish`.
		this.#socket.end()
		this.#closeTimer = setTimeout(() => this.destroy(), this.#timeout)
		this.#closeTimer.unref()
	}

	destroy(): void {
		if (this.#destroyed) return
		this.#destroyed = true
		// Detach before destroy so a destroy-time error reaches the terminal sink.
		this.#detach()
		this.#signal?.removeEventListener('abort', this.#abortListener)
		// `#finish` no-ops once already CLOSED (e.g. after `#fail` armed the hard-teardown
		// fallback), so the timer is cleared here unconditionally rather than relying on it.
		clearTimeout(this.#closeTimer)
		this.#closeTimer = undefined
		if (!this.#socket.destroyed) this.#socket.destroy()
		this.#finish()
		this.#emitter.destroy()
	}

	// Decode every complete frame currently in the buffer, dispatching each and slicing
	// it off; stops when a partial frame remains (parse returns `undefined`).
	#drain(): void {
		for (;;) {
			const canonical = isWebSocketFrameCanonical(this.#buffer)
			if (canonical === false) {
				this.#fail(WEBSOCKET_CLOSE_PROTOCOL)
				return
			}
			const declared = measureWebSocketFrame(this.#buffer)
			if (declared !== undefined && declared > this.#payload) {
				this.#fail(WEBSOCKET_CLOSE_TOOBIG)
				return
			}
			const frame = parseWebSocketFrame(this.#buffer)
			if (frame === undefined) return
			this.#buffer = this.#buffer.subarray(frame.consumed)
			this.#dispatch(frame.fin, frame.opcode, frame.payload, frame.masked, frame.rsv)
			if (this.#readyState === WEBSOCKET_READY_CLOSED) return
		}
	}

	// Route one decoded frame through the RFC 6455 validation gauntlet, then the
	// fragmentation state machine. Any validity breach funnels through `#fail`, which
	// closes with the specified code and tears the socket down.
	#dispatch(fin: boolean, opcode: number, payload: Buffer, masked: boolean, rsv: number): void {
		if (rsv !== 0) {
			this.#fail(WEBSOCKET_CLOSE_PROTOCOL)
			return
		}
		// Server mode sends unmasked and requires masked input; client mode is the inverse.
		if (masked === this.#masked) {
			this.#fail(WEBSOCKET_CLOSE_PROTOCOL)
			return
		}

		if (
			opcode === WEBSOCKET_OPCODE_CLOSE ||
			opcode === WEBSOCKET_OPCODE_PING ||
			opcode === WEBSOCKET_OPCODE_PONG
		) {
			if (!fin || payload.length > WEBSOCKET_CONTROL_MAXLEN) {
				this.#fail(WEBSOCKET_CLOSE_PROTOCOL)
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
			this.#close(payload)
			return
		}

		if (opcode === WEBSOCKET_OPCODE_TEXT || opcode === WEBSOCKET_OPCODE_BINARY) {
			if (this.#messageOpcode !== undefined) {
				this.#fail(WEBSOCKET_CLOSE_PROTOCOL)
				return
			}
			this.#messageOpcode = opcode
		} else if (opcode === WEBSOCKET_OPCODE_CONTINUATION) {
			if (this.#messageOpcode === undefined) {
				this.#fail(WEBSOCKET_CLOSE_PROTOCOL)
				return
			}
		} else {
			// Reserved data (0x3–0x7) or reserved control (0xB–0xF) opcodes.
			this.#fail(WEBSOCKET_CLOSE_PROTOCOL)
			return
		}

		this.#fragments.push(payload)
		this.#fragmentBytes += payload.length
		if (this.#fragmentBytes > this.#payload) {
			this.#fail(WEBSOCKET_CLOSE_TOOBIG)
			return
		}
		if (!fin) return

		if (this.#messageOpcode === WEBSOCKET_OPCODE_BINARY) {
			this.#fail(WEBSOCKET_CLOSE_UNSUPPORTED)
			return
		}
		const text = parseUTF8(Buffer.concat(this.#fragments))
		if (text === undefined) {
			this.#fail(WEBSOCKET_CLOSE_INVALID)
			return
		}
		this.#emitter.emit('message', text)
		this.#messageOpcode = undefined
		this.#fragments = []
		this.#fragmentBytes = 0
	}

	// Handle a validated CLOSE frame: decode it (which itself may `#fail` on an invalid
	// code/reason), then — if still OPEN — echo the peer's payload verbatim and end.
	#close(payload: Buffer): void {
		const valid = this.#decodeClose(payload)
		if (!valid) return
		if (this.#readyState === WEBSOCKET_READY_OPEN) {
			// Echo the peer's close frame before ending, per RFC 6455 §5.5.1.
			this.#readyState = WEBSOCKET_READY_CLOSING
			this.#write(WEBSOCKET_OPCODE_CLOSE, payload)
		}
		// The echo is queued; detach before `end()` can surface a socket error.
		this.#detach()
		this.#socket.end()
		this.#finish()
	}

	// The single funnel for every RFC 6455 validation breach: close with `code`, `#detach`
	// the domain listeners (the connection is protocol-dead — RFC 6455 permits discarding
	// further input after sending close, and this also stops a post-fail socket `error`
	// emitting AFTER the terminal `close` event), write the close frame, then flush + half
	// -close via `end()` (never a synchronous `destroy()`, which can discard the buffered
	// close frame and leave the peer seeing 1006 instead of the intended code) before
	// finishing. The hard-teardown fallback is armed AFTER `#finish` so `#finish`'s
	// `clearTimeout` cannot kill it; the normal path destroys the moment the write buffer
	// flushes (the `end()` callback), the unref'd timer is only the malicious-peer backstop.
	#fail(code: number, reason?: string): void {
		if (
			this.#readyState === WEBSOCKET_READY_CLOSING ||
			this.#readyState === WEBSOCKET_READY_CLOSED
		) {
			return
		}
		this.#code = code
		this.#reason = reason
		this.#readyState = WEBSOCKET_READY_CLOSING
		this.#detach()
		this.#write(WEBSOCKET_OPCODE_CLOSE, this.#encodeClose(code, reason))
		this.#socket.end(() => {
			if (!this.#socket.destroyed) this.#socket.destroy()
			// The normal flush path destroyed the socket already — clear the unref'd
			// fallback timer below so it doesn't linger `WEBSOCKET_FAIL_TIMEOUT_MS` holding
			// its closure alive for no reason.
			clearTimeout(this.#closeTimer)
			this.#closeTimer = undefined
		})
		this.#messageOpcode = undefined
		this.#fragments = []
		this.#fragmentBytes = 0
		this.#finish()
		this.#closeTimer = setTimeout(() => {
			if (!this.#socket.destroyed) this.#socket.destroy()
		}, WEBSOCKET_FAIL_TIMEOUT_MS)
		this.#closeTimer.unref()
	}

	// Drop only this wrapper's domain listeners and arm one durable terminal error sink.
	#detach(): void {
		if (this.#detached) return
		this.#detached = true
		this.#socket.off('data', this.#dataListener)
		this.#socket.off('close', this.#closeListener)
		this.#socket.off('error', this.#errorListener)
		// Keep a terminal socket safe from late peer errors after the domain listener is gone.
		this.#socket.on('error', () => undefined)
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

	// Validate and read a peer close-frame payload into `#code` / `#reason` (RFC 6455
	// §7.4.1). A bare close (0 bytes) is valid with no code/reason. A single stray byte
	// is a protocol error. 2+ bytes carry a code (must be a receivable close code) and
	// an optional UTF-8 reason. Returns `false` when a breach routed through `#fail`
	// (the caller must not also echo).
	#decodeClose(payload: Buffer): boolean {
		if (payload.length === 0) {
			this.#code = undefined
			this.#reason = undefined
			return true
		}
		if (payload.length === 1) {
			this.#fail(WEBSOCKET_CLOSE_PROTOCOL)
			return false
		}
		const code = payload.readUInt16BE(0)
		if (!isCloseCode(code)) {
			this.#fail(WEBSOCKET_CLOSE_PROTOCOL)
			return false
		}
		if (payload.length === 2) {
			this.#code = code
			this.#reason = undefined
			return true
		}
		const reason = parseUTF8(payload.subarray(2))
		if (reason === undefined) {
			this.#fail(WEBSOCKET_CLOSE_INVALID)
			return false
		}
		this.#code = code
		this.#reason = reason.length === 0 ? undefined : reason
		return true
	}

	// Transition to CLOSED once (idempotent), clear the close-handshake timer, and emit
	// the final `close` with the last known code/reason.
	#finish(): void {
		if (this.#readyState === WEBSOCKET_READY_CLOSED) return
		this.#detach()
		clearTimeout(this.#closeTimer)
		this.#closeTimer = undefined
		this.#signal?.removeEventListener('abort', this.#abortListener)
		this.#readyState = WEBSOCKET_READY_CLOSED
		this.#emitter.emit('close', this.#code, this.#reason)
	}

	// Append `bytes` to the accumulation buffer, then drain every complete frame. `#drain`
	// preflights canonical encoding and the declared payload cap on EACH iteration, so
	// every coalesced frame receives the same validation. Shared by `#handleData` and head replay.
	#ingest(bytes: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, bytes])
		this.#drain()
	}

	#handleData(chunk: unknown): void {
		if (this.#readyState === WEBSOCKET_READY_CLOSED) return
		const bytes = this.#bytes(chunk)
		if (bytes === undefined) return
		this.#ingest(bytes)
	}

	#handleError(error: unknown): void {
		this.#emitter.emit('error', error)
		this.destroy()
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
