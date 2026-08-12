# Guides

A dual-axis index into this repository's guides — by concept, and by
directory (AGENTS §22).

## By concept

| Concept   | Spec                                   | Source                        | Tests                                     |
| --------- | -------------------------------------- | ----------------------------- | ----------------------------------------- |
| WebSocket | [`src/websocket.md`](src/websocket.md) | [`src/server`](../src/server) | [`tests/src/server`](../tests/src/server) |

## By directory

| Directory    | Guide                                  |
| ------------ | -------------------------------------- |
| `src/server` | [`src/websocket.md`](src/websocket.md) |

## Dependency reference

[`src/emitter.md`](src/emitter.md) is a byte-identical mirror of the guide for
`@orkestrel/emitter` — this package's sole runtime dependency. It documents
**that package's** surface (the typed `Emitter` and its listener-error
isolation), not anything sourced in this repo; it is kept here so a reader of
this package can see the primitives it is built from without leaving this
guide set.

[`src/guide.md`](src/guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
