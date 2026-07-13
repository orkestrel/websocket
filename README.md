# @orkestrel/websocket

A dependency-light RFC 6455 WebSocket for Node — native handshake and framing
over duplex streams, with a typed emitter surface. Part of the `@orkestrel`
line. Its sole runtime dependency is `@orkestrel/emitter`, used for the typed
`emitter` every connection exposes.

## Install

```sh
npm install @orkestrel/websocket
```

## Requirements

- Node.js >= 24
- Ships dual ESM + CommonJS builds (see `exports` in `package.json`)
- Server-only — a single Node-native surface

## Usage

```ts
import { createServer } from 'node:http'
import { createNodeWebSocket } from '@orkestrel/websocket'

// A node:http server hands every upgrade request a raw socket; this wrapper takes it
// from there. Passing the client's `sec-websocket-key` selects SERVER mode — the
// wrapper writes the 101 handshake, marks the connection open, and decodes frames.
createServer().on('upgrade', (request, socket, head) => {
	const ws = createNodeWebSocket({
		socket,
		key: request.headers['sec-websocket-key'], // present => server mode + 101 handshake
		head, // any bytes that arrived bundled with the upgrade request
		on: { message: (text) => ws.send(`echo: ${text}`) }, // wire listeners at construction
	})

	ws.emitter.on('close', (code, reason) => console.log('closed', code, reason))
})
```

## Guide

The full API — factories, the `NodeWebSocket` class, the pure codec helpers,
constants, and types — is documented in
[`guides/src/websocket.md`](https://github.com/orkestrel/websocket/blob/main/guides/src/websocket.md).

## Package

Published as a single Node-only surface per the `exports` field in
`package.json` — one `.` entry backed by dual ESM (`.js`) and CommonJS
(`.cjs`) builds of `src/server`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
