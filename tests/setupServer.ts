// Server-test setup — node-only helpers, loaded after `setup.ts` for the node
// `guides` (and future `src:server` / `app:server`) projects. `node:fs` /
// `node:path` imports belong here, never in `setup.ts`, which browser projects
// also load. Anchor every path to `WORKSPACE_ROOT` so the runner's cwd never
// matters (AGENTS §16.1).

import type { WebSocketFrame } from '@src/server'
import { request as httpRequest } from 'node:http'
import { Duplex, PassThrough } from 'node:stream'
import { afterEach } from 'vitest'
import { parseWebSocketFrame } from '@src/server'

// ── Teardown registrar (tracked-resource cleanup) ────────────────────────────
//
// AGENTS §16.1: the duplicated `const tracked = []` + `afterEach(dispose-all)` +
// `track(item)` trio every node-resource suite hand-rolls — the started-server `stop()`
// form (Server / http-helpers / mcp-factories) and the worker `destroy()` form
// (workers/helpers) — folded into one registrar. The caller supplies the disposer
// (`h => h.stop()` or `w => w.destroy()`); the registrar holds the tracked list AND wires
// its OWN `afterEach` to dispose every tracked item (awaiting async disposers), so no
// socket / thread leaks across a suite. A real cleanup wiring, not a mock.

/** A tracked-resource teardown registrar — see {@link createTeardown}. */
export interface TeardownInterface<T> {
	/** Register `item` for disposal at `afterEach`, returning it for inline use. */
	track<U extends T>(item: U): U
}

/**
 * Create a {@link TeardownInterface} that disposes every tracked item after each test —
 * the one general form of the `tracked[]` + `afterEach` + `track` pattern the server
 * suites repeat (AGENTS §16.1). Call it at a suite's top level: it registers its OWN
 * `afterEach` immediately, draining the tracked list and running `dispose` on each item
 * (awaiting a returned promise), so a started server is `stop()`ed and a worker
 * `destroy()`ed even when an assertion throws mid-test. The disposer is the caller's
 * (`(handle) => handle.stop()` / `(worker) => worker.destroy()`), so the registrar stays
 * agnostic to what it tears down.
 *
 * @typeParam T - The kind of item tracked (the disposer's parameter type)
 * @param dispose - How to dispose one tracked item (may be async)
 * @returns A registrar whose `track` enrolls an item and returns it
 */
export function createTeardown<T>(
	dispose: (item: T) => void | Promise<void>,
): TeardownInterface<T> {
	const tracked: T[] = []
	afterEach(async () => {
		for (const item of tracked.splice(0)) await dispose(item)
	})
	return {
		track(item) {
			tracked.push(item)
			return item
		},
	}
}

// ── Raw HTTP upgrade driver (the spine's upgrade-seam tests) ─────────────────
//
// AGENTS §16.1: the `Server.upgrade(...)` seam tests drive a REAL `node:http` protocol
// upgrade — a client request with `Connection: Upgrade` + `Upgrade: websocket` headers —
// and observe whether the server CLAIMED the socket (it answered `101` and the client's
// `'upgrade'` event fired) or DECLINED it (the spine destroyed the socket, so the client
// request errors / the socket closes with no response). Folded into one helper since
// every upgrade-seam test repeats it. A real socket exchange, no mock (§16).

/** The outcome of an {@link upgradeRequest} — whether the server claimed the upgrade. */
export interface UpgradeOutcome {
	/** `true` when the server answered `101 Switching Protocols` (a handler claimed the socket). */
	readonly claimed: boolean
	/** The `101` status when claimed, else `undefined` (the socket was destroyed un-upgraded). */
	readonly status: number | undefined
}

/**
 * Drive a real `node:http` protocol upgrade against `base` + `path` and resolve the
 * {@link UpgradeOutcome} — the shared upgrade-seam driver (AGENTS §16.1).
 *
 * @remarks
 * Sends `Connection: Upgrade` + `Upgrade: websocket` (plus any extra `headers`, e.g. a
 * `Sec-WebSocket-Key`) and waits for the exchange to settle. If a registered handler
 * CLAIMS the socket and answers `101`, the client's `'upgrade'` event fires →
 * `{ claimed: true, status: 101 }` (the client socket is destroyed to free it). If NO
 * handler claims it, the spine `socket.destroy()`s the un-upgraded connection, so the
 * client request emits `'error'` (or the socket closes) → `{ claimed: false }`. It is
 * TOTAL — the declined path is an expected outcome, never a rejection — so a test
 * asserts on the resolved shape unconditionally.
 *
 * @param base - The server's bound base URL (e.g. `http://127.0.0.1:<port>`)
 * @param path - The request path to upgrade (defaults to `'/'`)
 * @param headers - Extra request headers merged over the upgrade headers
 * @returns The {@link UpgradeOutcome}
 */
export function upgradeRequest(
	base: string,
	path = '/',
	headers?: Record<string, string>,
): Promise<UpgradeOutcome> {
	return new Promise<UpgradeOutcome>((resolve) => {
		let settled = false
		const finish = (outcome: UpgradeOutcome): void => {
			if (settled) return
			settled = true
			resolve(outcome)
		}
		const request = httpRequest(`${base}${path}`, {
			headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers },
		})
		// The server claimed it: it sent `101` and the socket is now the handler's. Read
		// nothing — just free the client end and report the claim.
		request.on('upgrade', (response, socket) => {
			socket.destroy()
			finish({ claimed: true, status: response.statusCode })
		})
		// The server declined: it destroyed the un-upgraded socket, so the request errors
		// (a socket hang-up) — an expected, non-fatal outcome of the decline path.
		request.on('error', () => finish({ claimed: false, status: undefined }))
		// A plain (non-101) response would also mean no upgrade happened.
		request.on('response', (response) => {
			response.resume()
			finish({ claimed: false, status: response.statusCode })
		})
		request.end()
	})
}

// ── In-memory WebSocket Duplex pair (the RFC 6455 wire + transport tests) ─────
//
// AGENTS §16.1: the cross-wired in-memory `node:stream` Duplex PAIR the WebSocket wrapper
// and its MCP transport tests drive — a REAL bidirectional socket (two PassThroughs, one
// per direction), NOT a mock (§16) — folded into one shared harness. The wrapper test
// (NodeWebSocket) and the transport test (WebSocketServerTransport) both stand up the same
// pair, so it lives here. `duplexPair` makes a `[server, client]`; `flushSocket` waits for
// synchronous frame writes to propagate across the pair; `readClientFrames` is the inverse
// of what a server writes (strip the 101 handshake, then decode every complete frame off the
// running buffer); `createClientWebSocket` wraps the client end as a CLIENT-mode
// NodeWebSocket (masks its frames) for a high-level `send` / `message` round-trip.

// One endpoint of a cross-wired in-memory socket pair: a real `Duplex` whose writes forward
// into the partner's inbound `PassThrough` and whose reads drain its OWN inbound one. Two of
// these, sharing each other's channel, form a genuine bidirectional stream — bytes written to
// one arrive as `data` on the other — exercising real Node stream I/O without a socket or a
// mock (AGENTS §16). Module-private (the runtime-self-contained §5 analogue: a test-only
// stream shim with no standalone reuse beyond `duplexPair`); the pair factory is the surface.
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

	override _read(): void {
		// Flow is push-driven by the inbound 'data' listener above; nothing to pull.
	}

	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error) => void,
	): void {
		this.#outbound.write(chunk)
		callback()
	}
}

/**
 * Create a cross-wired in-memory `node:stream` Duplex PAIR — a real bidirectional socket for
 * the WebSocket wrapper / transport tests (AGENTS §16.1). The server end gets `[0]`, the
 * client end `[1]`, sharing two `PassThrough` channels (one per direction); bytes written to
 * one arrive as `data` on the other. No socket, no mock — genuine Node stream I/O.
 *
 * @returns The `[server, client]` Duplex pair
 */
export function duplexPair(): readonly [Duplex, Duplex] {
	const toServer = new PassThrough()
	const toClient = new PassThrough()
	const server = new DuplexEnd(toServer, toClient)
	const client = new DuplexEnd(toClient, toServer)
	server.on('error', () => {})
	client.on('error', () => {})
	return [server, client]
}

/**
 * Resolve on the socket pair's next tick or two — long enough for synchronous frame writes to
 * propagate through the {@link duplexPair} PassThroughs (AGENTS §16.1). Deterministic (no real
 * timer dependence on load), so a WebSocket test awaits it after a `send` rather than polling.
 *
 * @returns A promise resolving after two `setImmediate` ticks
 */
export function flushSocket(): Promise<void> {
	return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

/**
 * Collect a {@link duplexPair} client end's incoming frames — FIRST stripping the server's
 * HTTP `101` handshake response (the leading text up to `\r\n\r\n`), THEN decoding every
 * complete frame off the running buffer with {@link parseWebSocketFrame} (AGENTS §16.1). The
 * real client reader: the inverse of what a server-mode wrapper writes (handshake then
 * frames). The returned `frames` array grows as the server sends.
 *
 * @param client - The client end of a {@link duplexPair}
 * @returns A handle whose `frames` accumulates each decoded {@link WebSocketFrame}
 */
export function readClientFrames(client: Duplex): { readonly frames: readonly WebSocketFrame[] } {
	const frames: WebSocketFrame[] = []
	let buffer = Buffer.alloc(0)
	let handshook = false
	const end = Buffer.from('\r\n\r\n')
	client.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk])
		if (!handshook) {
			const index = buffer.indexOf(end)
			if (index === -1) return // handshake not fully arrived yet
			buffer = buffer.subarray(index + end.length)
			handshook = true
		}
		for (;;) {
			const frame = parseWebSocketFrame(buffer)
			if (frame === undefined) break
			buffer = buffer.subarray(frame.consumed)
			frames.push(frame)
		}
	})
	return { frames }
}
