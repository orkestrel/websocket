// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow are this
// package's own, and are the only part a sibling package changes. The flagship-fence
// transcriptions at the end of the file assert the values each fence's comments claim:
// change a fence, change the transcription beside it.

import { describe, expect, it } from 'vitest'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findMissing,
	findMissingSymbols,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide'
import { readFileSync } from 'node:fs'
import { requireValue } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'
import {
	computeWebSocketAccept,
	createNodeWebSocket,
	encodeWebSocketFrame,
	WEBSOCKET_OPCODE_CLOSE,
	WEBSOCKET_OPCODE_TEXT,
} from '@src/server'
import { duplexPair, flushSocket, readClientFrames } from './setupServer.js'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ '@orkestrel/websocket': 'src/server', '@src/server': 'src/server' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the `names no symbol internal that the barrel
 * already exports` assertion fails when a name here stops being stranded, so the list
 * cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

/** Root-level files this package's guides link to. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md'])

const root = new URL('../', import.meta.url)
const files: Record<string, string> = {
	...readInventory(root, ['src', 'guides', 'tests'], { extensions: ['.ts', '.md'] }),
}
for (const name of ROOT_FILES) files[name] = readFileSync(new URL(name, root), 'utf8')
const manifest = parseManifest(
	requireValue(files['guides/README.md'], 'Missing file: guides/README.md'),
	'guides',
)
const sources = createSourceManager({ files, modules: MODULES })

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

for (const entry of manifest) {
	const guide = createGuide(requireValue(files[entry.spec], `Missing file: ${entry.spec}`))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('uses only listed fence languages', () => {
			expect(findUnlisted(guide.fences(), FENCE_LANGUAGES)).toEqual([])
		})

		it('extracts a non-empty documented surface', () => {
			expect(guide.surface().length).toBeGreaterThan(0)
		})
		it('re-exports every direct declaration that is not named internal', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
		})
		it('names no symbol internal that the barrel already exports', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
		})
		it('re-exports only direct declarations', () => {
			expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
		})
		it('documents every barrel export', () => {
			expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
		})
		it('documents only barrel exports', () => {
			expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
		})

		it('exposes no hidden module-scope declarations', () => {
			expect(source.hidden().map(computeSymbolKey)).toEqual([])
		})

		for (const group of guide.methods()) {
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface ? [] : findMissing(source.methods(entity), group.methods)
					expect(extra).toEqual([])
				})
			})
		}

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.keyword === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
				})
			})
		}

		it('imports only real exports in every ```ts fence', () => {
			const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
			for (const fence of fences) {
				for (const { specifier, names } of extractFenceImports(fence.code)) {
					const imported = sources.source(specifier)
					if (imported === undefined) continue
					const surface = imported.surface().map((symbol) => symbol.name)
					expect(findMissing(names, surface)).toEqual([])
				}
			}
		})

		it('resolves every relative link', () => {
			const broken = guide
				.links()
				.filter((href) => !isExternalLink(href))
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(broken).toEqual([])
		})
		it('links only to test files that exist', () => {
			const missing = guide
				.tests()
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(missing).toEqual([])
		})
	})
}

// The flagship fences of `guides/websocket.md`, transcribed and asserted on the values
// their comments claim. Name resolution is not a behavioural proof, so a fence documenting
// a value the code contradicts satisfies every parity assertion in this file; only an
// executed transcription breaks on it. The `## Surface` and `## Patterns` fences take an
// upgraded socket from a live `node:http` server, so they run here over the in-memory
// Duplex pair `tests/setupServer.ts` builds, which is the same real bidirectional socket
// without the listener.

// The canonical `Sec-WebSocket-Key` of RFC 6455 §1.3, standing in for the request header
// the two server-mode fences read.
const FENCE_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

describe('flagship fences', () => {
	it('the Surface fence echoes a client text frame back as `echo: <text>`', async () => {
		const [server, client] = duplexPair()
		const collector = readClientFrames(client)
		const headers: Record<string, string | readonly string[] | undefined> = {
			'sec-websocket-key': FENCE_KEY,
		}

		const key = headers['sec-websocket-key']
		if (typeof key !== 'string') throw new Error('the fence narrows the header to a string key')
		const ws = createNodeWebSocket({
			socket: server,
			key, // present => server mode + 101 handshake
			on: { message: (text) => ws.send(`echo: ${text}`) },
		})
		const closes: Array<number | undefined> = []
		ws.emitter.on('close', (code) => closes.push(code))
		await flushSocket()

		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'hello', { masked: true }))
		await flushSocket()

		expect(collector.frames.map((frame) => frame.payload.toString('utf-8'))).toEqual([
			'echo: hello',
		])

		// The fence's `close` listener: the peer's close frame is echoed, the socket ends,
		// and the final `close` carries the peer's code.
		const closePayload = Buffer.alloc(2)
		closePayload.writeUInt16BE(1000, 0)
		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, closePayload, { masked: true }))
		await flushSocket()
		expect(closes).toEqual([1000])
	})

	it('the Patterns fence echoes through an `emitter` listener attached after construction', async () => {
		const [server, client] = duplexPair()
		const collector = readClientFrames(client)

		const ws = createNodeWebSocket({ socket: server, key: FENCE_KEY })
		ws.emitter.on('message', (text) => ws.send(`echo: ${text}`))
		await flushSocket()

		client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'pattern', { masked: true }))
		await flushSocket()

		expect(collector.frames.map((frame) => frame.payload.toString('utf-8'))).toEqual([
			'echo: pattern',
		])
		ws.destroy()
	})

	it('the encoder fence writes a server frame unmasked and a client frame masked', () => {
		const unmasked = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'hello')
		const masked = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'hello', { masked: true })

		// server→client: FIN + text opcode, the 7-bit length form, and the mask bit clear.
		expect([...unmasked]).toEqual([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])
		expect(unmasked.readUInt8(1) & 0x80).toBe(0)
		// client→server: the same header with the mask bit set, so the bytes differ.
		expect(masked.readUInt8(0)).toBe(0x81)
		expect(masked.readUInt8(1) & 0x80).toBe(0x80)
		expect(masked.equals(unmasked)).toBe(false)
	})

	it('the accept-token fence returns the RFC 6455 §1.3 worked example', () => {
		expect(computeWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
	})
})
