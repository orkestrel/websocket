# Guides

A dual-axis index into this repository's guides — by concept, and by
directory.

## By concept

| Concept   | Spec                           | Source                        | Tests                                     |
| --------- | ------------------------------ | ----------------------------- | ----------------------------------------- |
| WebSocket | [`websocket.md`](websocket.md) | [`src/server`](../src/server) | [`tests/src/server`](../tests/src/server) |

## By directory

| Directory    | Guide                          |
| ------------ | ------------------------------ |
| `src/server` | [`websocket.md`](websocket.md) |

## Dependency reference

[`emitter.md`](emitter.md) is a byte-identical mirror of the guide for
`@orkestrel/emitter` — this package's sole runtime dependency. It documents
**that package's** surface (the typed `Emitter` and its listener-error
isolation), not anything sourced in this repo; it is kept here so a reader of
this package can see the primitives it is built from without leaving this
guide set.

[`guide.md`](guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules, including the documentation parity contract.
