// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.

import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import { createVitest } from 'vitest/node'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/websocket.md'
/** The package identity that binds its manifest, module map, and README pitch. */
const PACKAGE_NAME = '@orkestrel/websocket'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ [PACKAGE_NAME]: 'src/server', '@src/server': 'src/server' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

await new GuideCommand({
	root: new URL('../', import.meta.url),
	patterns: ['src/**/*.ts', 'tests/**/*.ts', 'guides/*.md', '*.md', 'package.json'],
	modules: MODULES,
	languages: FENCE_LANGUAGES,
	language: EXAMPLE_LANGUAGE,
	reader: readInventory,
	runner: createVitest,
}).execute(async ({ files, report, rows }) => {
	const { isRecord, parseJSON } = await import('@orkestrel/contract')
	const { computeSymbolKey, findMissingSymbols } = await import('@orkestrel/guide')
	const { createRecorder, requireValue } = await import('@orkestrel/test')
	const {
		computeWebSocketAccept,
		createNodeWebSocket,
		encodeWebSocketFrame,
		WEBSOCKET_OPCODE_CLOSE,
		WEBSOCKET_OPCODE_TEXT,
	} = await import('@src/server')
	const { duplexPair, flushSocket, readClientFrames } = await import('./setupServer.js')
	const { describe, expect, it } = await import('vitest')
	const manifest = parseJSON(requireValue(files['package.json'], 'Missing inventory: package.json'))
	if (!isRecord(manifest)) throw new Error('Invalid package manifest: package.json')

	it('manifest lists at least one guide', () => {
		expect(report.input).toEqual([])
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.map((row) => row.entry.spec)).toContain(GUIDE_SPEC)
	})

	// The example half of the equality case is silent over an empty population: with no
	// title on both sides `findDrift` compares no pair and the case passes on the summaries
	// alone. This pins the population this repository's own guide contributes, so removing
	// every `@example` title reddens the suite instead of quietly retiring half the gate.
	// The failure names both title sets, because a pin reporting only its own emptiness
	// leaves the reader to work out which side dropped the title.
	it('pairs at least one example title across the guide and the source', () => {
		expect(report.examples.titles.filter((finding) => finding.spec === GUIDE_SPEC)).toEqual([])
	})

	// The README's pitch and the guide's tagline are one text, each read as the blockquote
	// under its file's H1. `README.md` is outside the concept index, so the reader is
	// applied to it directly rather than through a manifest row. Each side is guarded
	// against `undefined` first, so a file that lost its blockquote reports that rather
	// than reporting two absences as agreement.
	it('opens the README with the guide tagline', () => {
		expect(manifest.name).toBe(PACKAGE_NAME)
		expect(report.pitch).toEqual([])
	})

	for (const { entry, guide, source } of rows) {
		describe(`${entry.concept}`, () => {
			it('uses only listed fence languages', () => {
				expect(report.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
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

			it('documents a populated method group', () => {
				expect(report.sections.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('keeps behavioral interfaces and implementing classes in parity', () => {
				expect(report.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			// The equality gate: a `Summary` cell against its export's description paragraph, a
			// titled fence against the `@example` of that title. `findDrift` owns the comparison
			// and names both sides; converge the two sides through the native entry, never by
			// weakening this assertion. `findDrift` pairs an example only where a title is
			// present on both sides, so an untitled `@example` block is outside this case. Each
			// collected line is the spec, the key, and each side's text or `absent` — the same
			// worklist the native entry prints. Select source authority with `--to guide`, or
			// guide authority with `--to source`.
			it('keeps every compared summary and example equal to its source', () => {
				expect(report.drift.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents an example for every Surface function', () => {
				expect(report.examples.functions.filter((finding) => finding.spec === entry.spec)).toEqual(
					[],
				)
			})

			it('documents an example for every method', () => {
				expect(report.examples.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('imports only real exports in every ```ts fence', () => {
				expect(report.imports.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('resolves every relative link', () => {
				expect(report.links.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})
			it('links only to test files that exist', () => {
				expect(report.tests.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})
		})
	}

	// The flagship fences of `guides/websocket.md`, transcribed and asserted on the values
	// their comments claim. Name resolution is not a behavioural proof, so a fence documenting
	// a value the code contradicts satisfies every parity assertion in this file; only an
	// executed transcription breaks on it. The `## Surface` and `## Patterns` fences take an
	// upgraded socket from a live `node:http` server, so they run here over the in-memory
	// Duplex pair `tests/setupServer.ts` builds, which is the same real bidirectional socket
	// without the listener. Change a fence, change the transcription beside it.

	// The canonical `Sec-WebSocket-Key` of RFC 6455 §1.3, standing in for the request header
	// each server-mode fence reads.
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

		it('the Patterns fence echoes from its construction hook and hands the same message to a second observer', async () => {
			const [server, client] = duplexPair()
			const collector = readClientFrames(client)
			const observed = createRecorder<readonly [message: string]>()

			const ws = createNodeWebSocket({
				socket: server,
				key: FENCE_KEY,
				on: { message: (text) => ws.send(`echo: ${text}`) }, // wired before the first frame arrives
			})
			ws.emitter.on('message', observed.handler) // a second observer of the same event
			await flushSocket()

			client.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'pattern', { masked: true }))
			await flushSocket()

			// One echo, not two: the fence's later listener observes the message and the
			// construction hook is what answers it.
			expect(collector.frames.map((frame) => frame.payload.toString('utf-8'))).toEqual([
				'echo: pattern',
			])
			expect(observed.calls).toEqual([['pattern']])
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
			expect(computeWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe(
				's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
			)
		})
	})
})
