# Releasing

`bounded` (`src`, ADR 2026-024) is released with the steps below; each
published pack (`src/published-packs/<name>`, ADR 2026-030) is released on
its own, as the last section says. `bounded` carries the CLI and
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
   the same version, and so does the prereqs status band's
   `src/hosts/claude-code/prereqs-status-band/.claude-plugin/plugin.json`
   (ADR 2026-027). The CLI reports
   its version from the package it runs in, and `bounded init` installs
   exactly that version. `src/test/packaging.test.ts` pins the version, so update its
   `VERSION` too. No `bun install` (plain, `--force` or `--lockfile-only`,
   bun 1.3.14) rewrites the workspaces' versions in `bun.lock`, and
   `--frozen-lockfile` does not notice them stale, so set the five
   `"version"` lines under `workspaces` in `bun.lock` by hand. A minor or
   major bump also moves every published pack's
   `peerDependencies.bounded` to `~<major>.<minor>.0` of the new version,
   in the same change: `src/test/published-pack-packaging.test.ts` fails
   until it does, and the packs' tests then run against the new `bounded`.
2. **Check.** Run `bun run check`. It builds `dist/`, then runs every test,
   including the packaging test (the tarball's contents) and the end-to-end
   test (`npx bounded init` and `npx bounded update --from` from the
   tarball, with bun and with npm without bun).
3. **Dry-run first.** In `src`, run `bun publish --dry-run`. Its
   prepack (`bun build-dist.ts && bun dist/cli.js catalog build`) builds
   `dist/` afresh, then the package catalogue, `bounded.catalog.json`
   ([ADR 2026-029](adr/2026-029-package-catalogue.md)), with bun
   ([ADR 2026-032](adr/2026-032-catalogue-build-on-bun.md)). Check the file list:
   - `dist/` (the library, its declarations in `dist/types/`, `dist/cli.js`
     and `dist/hosts/`, with the prereqs status band's plugin folder in
     `dist/hosts/claude-code/prereqs-status-band/`);
   - `core/` and `packs/`, the core's and the shipped packs' sources, without tests, test support (but
     the two conformance suites under `bounded/testing/*`) or fixtures;
   - `bounded.catalog.json`, generated (it is gitignored);
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

## Publishing a published pack

A published pack's package, `bounded-<name>` in `src/published-packs/<name>`
([ADR 2026-030](adr/2026-030-published-packs.md)), has its own version,
from `0.1.0`, independent of `bounded`'s. A package marked `"private": true`
is never published: remove the flag only when the pack is ready to release.
The fixture `bounded-example` stays private.

1. **Build and, if needed, release `bounded` first.** The package's prepack
   needs bounded's `dist/` (`bun src/build-dist.ts`, which `bun run check`
   runs). When the pack needs a newer `bounded` than npm has, release
   `bounded` first.
2. **Set the peer.** `peerDependencies.bounded` is exactly
   `~<major>.<minor>.0` of the `bounded` the pack was tested against, and
   the package's `version` is bumped.
3. **Check.** Run `bun run check`: it packs the package and installs it
   beside `bounded` (`src/test/published-pack-packaging.test.ts`).
4. **Dry-run, then publish, in the package's directory.** Run
   `bun publish --dry-run`, then `bun publish`. Its prepack
   (`bun ../../build-published-pack.ts && bun ../../dist/cli.js catalog build`)
   builds its `dist/` and its `bounded.catalog.json`; bun rewrites its
   `workspace:*` devDependency. The tarball holds `package.json`,
   `README.md`, `LICENSE`, `bounded.catalog.json`, `dist/` and its packs'
   sources and examples, without tests, test support or fixtures.
5. **Tag** the release commit `bounded-<name>@<version>` and record it in
   [flight state](flight-state.md).
