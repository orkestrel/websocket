// ── Call recorder (a real callback, not a mock) ──────────────────────────────
//
// AGENTS §16.1: when a test only needs to count calls or inspect arguments, use a
// recorder — a real listener that records every invocation — rather than a test-
// framework spy. `handler` is a genuine callback; `calls` is each invocation's
// argument tuple, in order.

/** A real call-recording callback over an argument tuple (AGENTS §16.1). */
export interface TestRecorderInterface<TArgs extends readonly unknown[]> {
	readonly calls: readonly TArgs[]
	readonly count: number
	readonly handler: (...args: TArgs) => void
	clear(): void
}

/**
 * Create a {@link TestRecorderInterface} — a real callback that records each
 * invocation's arguments, for asserting what fired and with what (AGENTS §16.1).
 *
 * @typeParam TArgs - The argument tuple the recorded handler receives
 * @returns A recorder whose `handler` records into `calls`
 */
export function createRecorder<TArgs extends readonly unknown[]>(): TestRecorderInterface<TArgs> {
	const calls: TArgs[] = []
	return {
		get calls() {
			return calls
		},
		get count() {
			return calls.length
		},
		handler(...args: TArgs) {
			calls.push(args)
		},
		clear() {
			calls.length = 0
		},
	}
}

// ── Deterministic seeded randomness + text corpus (fuzz/property tests) ──────
//
// AGENTS §16.1: fuzz/property/limit tests need the SAME reproducible pseudo-random
// sequence across a run — a seeded mulberry32 generator — plus a deterministic
// BMP-safe text builder over it, shared by every node AND browser-side test.

/**
 * Create a deterministic mulberry32 pseudo-random generator seeded by `seed`.
 *
 * @param seed - The 32-bit seed; the same seed always yields the same sequence
 * @returns A function returning the next pseudo-random number in `[0, 1)`
 */
export function createRandom(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/**
 * Build a deterministic, BMP-safe, guaranteed-valid-UTF-8 string of `length` code
 * points, sampling each from `rng` while avoiding the surrogate range.
 *
 * @param rng - A seeded generator (see {@link createRandom})
 * @param length - The number of code points to generate
 * @returns The generated string
 */
export function buildText(rng: () => number, length: number): string {
	let text = ''
	for (let index = 0; index < length; index += 1) {
		let point = Math.floor(rng() * 0xffff)
		if (point >= 0xd800 && point <= 0xdfff) point -= 0x800
		text += String.fromCodePoint(point)
	}
	return text
}

/**
 * Resolve after `ms` milliseconds — the §16.1 canonical delay helper, used instead
 * of an inline `setTimeout` promise wherever a test needs a short deterministic wait.
 *
 * @param ms - The delay in milliseconds
 * @returns A promise resolving once the delay elapses
 */
export function waitForDelay(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Return a required test value after narrowing away absence.
 *
 * @param value - The value an earlier assertion or fixture lookup expects to exist
 * @returns The present value
 * @throws When `value` is absent
 */
export function requireValue<T>(value: T | null | undefined): T {
	if (value === undefined || value === null) throw new Error('Expected test value to exist')
	return value
}

// The small command vocabulary used by the real-browser integration fixture. These
// strings are protocol data, so they are centralized rather than repeated as
// behavior-selecting literals across the Node server and browser tests.
export const INTEGRATION_CLOSE_NORMAL_REQUEST = 'close-me'
export const INTEGRATION_CLOSE_CUSTOM_REQUEST = 'close-4000'
export const INTEGRATION_COUNT_REQUEST = 'count'
export const INTEGRATION_COUNT_PREFIX = 'count: '

// ── Browser WebSocket helpers (pure — WebSocket + Promise only) ──────────────
//
// AGENTS §16.1: the integration project loads `setup.ts` into its headless-Chromium
// browser tests too, so these tiny, framework-free WebSocket helpers live here
// rather than in a node-only setup file — they touch no `node:*` API.

/**
 * Open a `WebSocket` to `url` and resolve once it reaches the `open` state.
 *
 * @param url - The WebSocket URL to connect to
 * @returns A promise resolving to the opened socket
 */
export function connect(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.addEventListener('open', () => resolve(ws), { once: true })
		ws.addEventListener('error', (event) => reject(event), { once: true })
	})
}

/**
 * Resolve with the next `message` event received on `ws`.
 *
 * @param ws - The socket to listen on
 * @returns A promise resolving to the next {@link MessageEvent}
 */
export function nextMessage(ws: WebSocket): Promise<MessageEvent> {
	return new Promise((resolve) => {
		ws.addEventListener('message', (event) => resolve(event), { once: true })
	})
}

/**
 * Resolve with the next `close` event received on `ws`.
 *
 * @param ws - The socket to listen on
 * @returns A promise resolving to the next {@link CloseEvent}
 */
export function nextClose(ws: WebSocket): Promise<CloseEvent> {
	return new Promise((resolve) => {
		ws.addEventListener('close', (event) => resolve(event), { once: true })
	})
}

/** Whether a repository-relative Vue SFC path belongs to the private browser application. */
export function isBrowserVuePath(path: string): boolean {
	const normalized = path.replaceAll('\\', '/')
	return normalized.startsWith('app/browser/')
}
