# @orkestrel/websocket

> The server-native bidirectional transport: a lean, typed wrapper over a raw upgraded
> `node:stream` Duplex socket that speaks only the RFC 6455 wire protocol, owning the
> handshake, the masked and unmasked frame codec, ping and pong, and the close handshake,
> and surfacing every message on an owned `emitter`.

Take the socket a `node:http` upgrade handler gives you, pass it to the
`createNodeWebSocket` function, and read every message off the returned handle's
`emitter`. Its sole runtime dependency is `@orkestrel/emitter`, which supplies that
typed emitter. Part of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/websocket
```

## Requirements

- Node.js >= 22.12.0
- Ships dual ESM + CommonJS builds (see `exports` in `package.json`)
- Server-only — a single Node-native surface

## Usage

```ts
import { createServer } from 'node:http'
import { createNodeWebSocket } from '@orkestrel/websocket'

// A node:http server hands every upgrade request a raw socket; this wrapper takes it
// from there. Passing the client's `sec-websocket-key` selects server mode — the
// wrapper writes the 101 handshake, marks the connection open, and decodes frames.
createServer().on('upgrade', (request, socket, head) => {
	const key = request.headers['sec-websocket-key']
	if (typeof key !== 'string') {
		socket.destroy()
		return
	}
	const ws = createNodeWebSocket({
		socket,
		key, // present => server mode + 101 handshake
		head, // any bytes that arrived bundled with the upgrade request
		on: { message: (text) => ws.send(`echo: ${text}`) }, // wire listeners at construction
	})

	ws.emitter.on('close', (code, reason) => console.log('closed', code, reason))
})
```

## Guide

The full API — factories, the `NodeWebSocket` class, the pure codec helpers,
constants, and types — is documented in
[`guides/websocket.md`](https://github.com/orkestrel/websocket/blob/main/guides/websocket.md).

## Package

Published as a single Node-only surface per the `exports` field in
`package.json` — one `.` entry backed by dual ESM (`.js`) and CommonJS
(`.cjs`) builds of `src/server`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
