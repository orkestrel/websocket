// Proof of `tests/setupGlobal.ts` — the Vitest global-setup module that starts the
// `integration` project's real WebSocket echo fixture before its client-side tests run.
//
// The module exports exactly one member, `setup(project)`, and every line of it acts on
// the live `TestProject` the runner owns (destructuring `provide` from it and calling it).
// There is no separable narrowing or pure helper to reach independently, unlike a module
// that also exports its own admission guard: `TestProject` is a large class imported from
// `vitest/node`, so constructing one to invoke `setup` directly would need a type
// assertion, which the non-negotiable rules refuse. The runner-driven half is proven by
// the projects that declare this module as their `globalSetup` — `vite.config.ts` names it
// for the `integration` project, so every `integration` run drives `setup`, its `provide`
// call, and the teardown it returns (the mcp visit set this precedent).
//
// What is proven here is the reachable contract instead: the module's export surface is
// exactly the single callable name Vitest's `globalSetup` loader requires, reached by a
// second route — a fixed expected-name list this file owns, not a re-derivation of the
// module's own keys.

import { describe, expect, it } from 'vitest'
import * as setupGlobalModule from './setupGlobal.js'

describe('setupGlobal module surface', () => {
	it('exports exactly the callable `setup` name the globalSetup loader requires', () => {
		const expectedNames = ['setup']

		expect(Object.keys(setupGlobalModule)).toEqual(expectedNames)
		expect(typeof setupGlobalModule.setup).toBe('function')
		expect(setupGlobalModule.setup.length).toBe(1)

		// Control: a name the module does not export must fail this same assertion, proving
		// the check would catch a renamed or removed `setup` export.
		const mutatedNames = [...expectedNames, 'teardown']
		expect(() => expect(Object.keys(setupGlobalModule)).toEqual(mutatedNames)).toThrow('expected')
	})
})
