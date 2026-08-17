// The fleet-wide helpers live in `@orkestrel/test`. What remains here is what is
// specific to this package: seeded randomness/text, the integration command
// vocabulary, and the pure browser WebSocket helpers.

// ── Deterministic seeded randomness + text corpus (fuzz/property tests) ──────
//
// AGENTS §16.1: fuzz/property/limit tests need the SAME reproducible pseudo-random
// sequence across a run — `@orkestrel/contract`'s `seededRandom` — plus a
// deterministic BMP-safe text builder over it, shared by every node AND
// browser-side test.

/**
 * Build a deterministic, BMP-safe, guaranteed-valid-UTF-8 string of `length` code
 * points, sampling each from `rng` while avoiding the surrogate range.
 *
 * @param rng - A seeded generator (see `seededRandom` from `@orkestrel/contract`)
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

// The small command vocabulary used by the live-client integration fixture. These
// strings are protocol data, so they are centralized rather than repeated as
// behavior-selecting literals across the Node server and browser tests.
export const INTEGRATION_CLOSE_NORMAL_REQUEST = 'close-me'
export const INTEGRATION_CLOSE_CUSTOM_REQUEST = 'close-4000'
export const INTEGRATION_COUNT_REQUEST = 'count'
export const INTEGRATION_COUNT_PREFIX = 'count: '

// ── Browser WebSocket helpers (pure — WebSocket + Promise only) ──────────────
//
// AGENTS §16.1: the integration project loads `setup.ts` into its platform-WebSocket
// client tests too, so these tiny, framework-free WebSocket helpers live here
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
