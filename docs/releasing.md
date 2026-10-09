# Releasing

One package is published: `bounded` (`src`, ADR 2026-024). It carries the CLI and
the Claude Code and pi adapters, built from the private apps `src/cli`,
`src/hosts/claude-code` and `src/hosts/pi` by its prepack
([ADR 2026-016](adr/2026-016-cli-app.md)), and the shell command reader,
built from the private context `src/lib/shell-command-reader` as
`bounded/shell-command-reader` ([ADR 2026-020](adr/2026-020-shell-command-reading.md)).
The apps and the reader's package are never published.

Only a maintainer publishes, and only when asked: pushing a release to npm is
an outward action (AGENTS.md).

## Steps

1. **Bump every version in lockstep.** `src`, `src/cli`,
   `src/hosts/claude-code`, `src/hosts/pi` and `src/lib/shell-command-reader` carry
   the same version. The CLI reports
   its version from the package it runs in, and `bounded init` installs
   exactly that version. `src/test/packaging.test.ts` pins the version, so update its
   `VERSION` too. No `bun install` (plain, `--force` or `--lockfile-only`,
   bun 1.3.14) rewrites the workspaces' versions in `bun.lock`, and
   `--frozen-lockfile` does not notice them stale, so set the five
   `"version"` lines under `workspaces` in `bun.lock` by hand.
2. **Check.** Run `bun run check`. It builds `dist/`, then runs every test,
   including the packaging test (the tarball's contents) and the end-to-end
   test (`npx bounded init` and `npx bounded update --from` from the
   tarball, with bun and with npm without bun).
3. **Dry-run first.** In `src`, run `bun publish --dry-run`. Its
   prepack (`bun build-dist.ts`) builds `dist/` afresh. Check the file list:
   - `dist/` (the library, its declarations in `dist/types/`, `dist/cli.js`
     and `dist/hosts/`);
   - `core/` and `packs/`, the core's and the shipped packs' sources, without tests, test support (but
     the two conformance suites under `bounded/testing/*`) or fixtures;
   - `README.md`, `LICENSE` and `package.json`.

   `bun pm pack` gives the same tarball, to install by hand
   (README, "From a checkout").
4. **Publish.** In `src`, run `bun publish`. bun rewrites any
   `workspace:*` (bounded has none) and runs the prepack, so the tarball
   always holds a fresh build. Publish only `bounded`.
5. **Tag** the release commit `v<version>` and record it in
   [flight state](flight-state.md).

## Why bun publishes

`bun publish` and `bun pm pack` run `bounded`'s prepack and honour its
`files` list as the packaging test checks it. `bun pm pack`, for example,
reads negated patterns but not a later re-inclusion, hence the brace-scoped
exclusions in `files`. Publishing with another tool would need its own
check of the file list.
