// The fleet-wide helpers live in `@orkestrel/test`. What remains here is what is
// specific to this package: seeded randomness/text, the integration command
// vocabulary, and the browser WebSocket helpers.

import { waitForEvent } from '@orkestrel/test'

// ── Deterministic seeded randomness + text corpus (fuzz/property tests) ──────
//
// Fuzz, property, and limit tests need the SAME reproducible pseudo-random sequence
// across a run — `@orkestrel/contract`'s `seededRandom` — plus a deterministic
// BMP-safe text builder over it, shared by every node AND browser-side test.

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

// ── Browser WebSocket helpers (the platform `WebSocket` plus `@orkestrel/test`'s `waitForEvent` — no `node:*` API) ──────────────
//
// The integration project loads `setup.ts` into its platform-WebSocket client tests too,
// so these tiny WebSocket helpers live here rather than in a node-only
// setup file — they touch no `node:*` API.

// The elapsed-time limit `nextMessage` and `nextClose` give one event before they fail
// naming it. Sized from a contended `npm run test:integration` run on 2026-09-03 whose
// slowest case — the 2 MB round trip — took 802 ms end to end, and kept under the
// `integration` project's 5000 ms Vitest case timeout so the named-event failure is what a
// reader sees rather than the runner's anonymous one.
const NEXT_EVENT_BUDGET_MS = 4_000

/**
 * Open a `WebSocket` to `url` and resolve after it reaches the `open` state.
 *
 * @param url - The WebSocket URL to connect to
 * @returns A promise resolving to the opened socket
 * @remarks Rejects with the socket's own `error` event when the target refuses the
 *   connection, so a refusal surfaces immediately rather than as an elapsed budget.
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
 * @throws An `Error` naming the awaited event when no message arrives within
 *   `NEXT_EVENT_BUDGET_MS` (4000) milliseconds
 */
export async function nextMessage(ws: WebSocket): Promise<MessageEvent> {
	const [event] = await waitForEvent<[MessageEvent]>(
		(listener) => {
			ws.addEventListener('message', listener, { once: true })
			return () => ws.removeEventListener('message', listener)
		},
		'the next WebSocket message event',
		{ budget: NEXT_EVENT_BUDGET_MS },
	)
	return event
}

/**
 * Resolve with the next `close` event received on `ws`.
 *
 * @param ws - The socket to listen on
 * @returns A promise resolving to the next {@link CloseEvent}
 * @throws An `Error` naming the awaited event when no close arrives within
 *   `NEXT_EVENT_BUDGET_MS` (4000) milliseconds — the case a peer that drops the
 *   connection without dispatching `close` would otherwise leave hanging
 */
export async function nextClose(ws: WebSocket): Promise<CloseEvent> {
	const [event] = await waitForEvent<[CloseEvent]>(
		(listener) => {
			ws.addEventListener('close', listener, { once: true })
			return () => ws.removeEventListener('close', listener)
		},
		'the next WebSocket close event',
		{ budget: NEXT_EVENT_BUDGET_MS },
	)
	return event
}
