import { describe, expect, it } from 'vitest'
import { isCloseCode, isWebSocketKey, isWebSocketProtocol } from '@src/server'

// The RFC 6455 boundary guards as pure units (no socket, AGENTS §16): total predicates
// over caller-supplied handshake and wire values, each pinned against canonical and
// malformed inputs.

describe('handshake value guards', () => {
	it('accepts only canonical 16-byte Sec-WebSocket-Key values', () => {
		expect(isWebSocketKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe(true)
		expect(isWebSocketKey('abc')).toBe(false)
		expect(isWebSocketKey('dGhlIHNhbXBsZSBub25jZQ=')).toBe(false)
		expect(isWebSocketKey('dGhlIHNhbXBsZSBub25jZQ==\r\n')).toBe(false)
	})

	it('accepts one HTTP token and rejects separators or header injection', () => {
		expect(isWebSocketProtocol('mcp.v1')).toBe(true)
		expect(isWebSocketProtocol('')).toBe(false)
		expect(isWebSocketProtocol('mcp, other')).toBe(false)
		expect(isWebSocketProtocol('mcp\r\nX-Injected: true')).toBe(false)
	})
})

describe('isCloseCode', () => {
	it('accepts valid RFC 6455 receivable codes', () => {
		expect(isCloseCode(1000)).toBe(true)
		expect(isCloseCode(1009)).toBe(true)
		expect(isCloseCode(3000)).toBe(true)
	})

	it('accepts the IANA-registered 1012-1014 interop extension', () => {
		expect(isCloseCode(1012)).toBe(true)
		expect(isCloseCode(1014)).toBe(true)
	})

	it('rejects reserved-for-local-use-only and unassigned codes', () => {
		expect(isCloseCode(1005)).toBe(false)
		expect(isCloseCode(1006)).toBe(false)
		expect(isCloseCode(999)).toBe(false)
		expect(isCloseCode(1004)).toBe(false)
		expect(isCloseCode(1000.5)).toBe(false)
	})
})

describe('codec properties — close-code classification', () => {
	it('classifies every code 999..5000 exactly per RFC 6455 §7.4.1 + the 1012-1014 extension', () => {
		for (let code = 999; code <= 5000; code += 1) {
			const expected =
				(code >= 1000 && code <= 1003) ||
				(code >= 1007 && code <= 1014) ||
				(code >= 3000 && code <= 4999)
			expect(isCloseCode(code)).toBe(expected)
		}
		// Explicit call-outs for the reserved-for-local-use-only / unassigned codes.
		for (const code of [1004, 1005, 1006, 1015]) expect(isCloseCode(code)).toBe(false)
		for (const code of [1016, 2000, 2999]) expect(isCloseCode(code)).toBe(false)
	})
})
