# @orkestrel/sqlite

A typed, synchronous SQLite wrapper for the `@orkestrel` line — a thin skin
over Node's built-in `node:sqlite` (`DatabaseSync` / `StatementSync`) giving
prepared statements, transactions, and pragmas, with a single runtime
dependency: `@orkestrel/contract`, used for its boundary narrowing.

`node:sqlite` is experimental on current Node versions — importing this
package emits an `ExperimentalWarning` at runtime until Node stabilizes the
module.

## Install

```sh
npm install @orkestrel/sqlite
```

## Requirements

- Node.js >= 24
- `node:sqlite` (Node's built-in SQLite module)
- Server-only — no CommonJS/browser split, single Node-native surface

## Status

Pre-release. The public API documented in
[`guides/src/sqlite.md`](https://github.com/orkestrel/sqlite/blob/main/guides/src/sqlite.md)
is implemented and covered by tests, but the package has not yet reached a
stable `1.0` release.

## Package

Published as a single Node-only surface per the `exports` field in
`package.json` — one `.` entry backed by a CommonJS build of `src/server`
(required by `node:sqlite`'s CJS-only shape at this Node version).

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
