# Releasing

`bounded` (`src`, ADR 2026-024) carries the CLI and
the Claude Code and pi adapters, built from the private apps `src/cli`,
`src/hosts/claude-code` and `src/hosts/pi` by its prepack
([ADR 2026-016](adr/2026-016-cli-app.md)), and the shell command reader,
built from the private context `src/lib/shell-command-reader` as
`bounded/shell-command-reader` ([ADR 2026-020](adr/2026-020-shell-command-reading.md)).
The apps and the reader's package are never published. Native executable
releases follow [ADR 2026-036](adr/2026-036-native-release-gate.md). The npm
compatibility package and each published pack have separate procedures below.

Only a maintainer publishes, and only when asked. This includes promoting a
native release draft and publishing to npm (AGENTS.md).

## Native executable release

1. **Review the version and targets on main.** Bump Bounded's version in
   lockstep as described below. `src/release-targets.json` names the sorted
   target subset for that exact version. The declared targets are provisional
   until every native job passes. For 3.3.0 they are macOS arm64 and x64,
   Linux x64 glibc, and Windows x64. Review a target change before tagging;
   the release cannot silently omit a failed target.
2. **Check the source.** Run `bun run check` on the release commit. A local
   `bun src/build-release.ts --target <native-target> --smoke --out <directory>`
   can exercise an unsigned development executable, but it is not stable
   release evidence. Keep the checkout clean for a stable build.
3. **Start the protected native gate.** Once the reviewed commit is on main,
   an authorized maintainer creates its `v<version>` tag. The `v*` tag starts
   `.github/workflows/release.yml`, which checks the exact package version,
   tagged commit, and main ancestry before building. Tag protection is
   external repository configuration; local workflow tests do not prove it
   is enabled.
4. **Require the native jobs.** Every declared runner runs `bun run check`,
   compiles and executes its own target, and tests the installer, launcher,
   and fail-closed hook without Node, Bun, or npm on the consumer PATH. The
   native archive carries `share/catalog/bounded.catalog.json` for offline
   `bounded packs` discovery, bound to the manifest and release version.
   Check its presence and digest in the verified archive. The macOS jobs
   sign the executable with a Developer ID identity before
   packaging, notarize the exact ZIP, then check Gatekeeper and an online
   first launch. The installed macOS process is also tested with network
   denied. The Linux and Windows jobs must pass on their native runners.
5. **Review the verified draft.** The workflow attests each final archive,
   assembles exactly the declared targets, and verifies the draft release's
   asset names, sizes, and digests. It leaves a private draft. A maintainer
   reviews the native run, signatures, notarization, and attestations, then
   publishes the draft manually. The workflow's installer smoke covers first
   install and failed reinstall preservation; successful clean-machine
   upgrade evidence must be gathered separately before publication. A local
   unsigned smoke run, structural tests, or a producer-written smoke record
   cannot replace that review. Process-level network denial after an online
   first launch does not prove a disconnected Mac can pass its first
   Gatekeeper check.

## npm compatibility package

The npm package is a separate compatibility distribution. Publishing it does
not satisfy the native executable gate. Only publish it when a maintainer asks.

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
5. **Record** the npm publication in [flight state](flight-state.md). The
   native `v<version>` tag belongs to the reviewed native release procedure
   above.

### Why Bun publishes the npm package

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
