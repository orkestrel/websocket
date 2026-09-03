// Global setup for the `integration` project — runs ONCE in Node, before the client-side
// tests start, and stays out of the client-side test files entirely (they import nothing
// from `@src/*` or `node:*`). It starts the shared `createEchoServer` fixture from
// `tests/setupServer.ts`: a real `node:http` server that upgrades every request to a
// server-mode `createNodeWebSocket` (the package's own public factory — the same wiring
// shown in its TSDoc example) and echoes text frames back as `echo: <text>`, with a small
// centralized command vocabulary driving the close/count assertions. The listening URL is
// handed to the client side through `provide('wsUrl', …)`, read back with
// `inject('wsUrl')` in the test files.

import type { TestProject } from 'vitest/node'
import { createEchoServer } from './setupServer.js'

declare module 'vitest' {
	export interface ProvidedContext {
		wsUrl: string
	}
}

export async function setup({ provide }: TestProject): Promise<() => Promise<void>> {
	const fixture = await createEchoServer()
	provide('wsUrl', fixture.url)
	return async () => {
		await fixture.destroy()
	}
}
