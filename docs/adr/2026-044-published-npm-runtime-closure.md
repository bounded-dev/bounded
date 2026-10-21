# 2026-044: Prove the published npm runtime before restoring its hooks

**Status:** accepted. Complements [ADR 2026-033](2026-033-standalone-command-routing.md).

## Decision

Automatic restoration of old npm hooks requires an exact, recorded proof of the old installed runtime. The first supported source is the published `bounded@3.3.0` package in an npm v3 lock with the byte-identical default `bounded.config.ts` written by that release's `npx bounded init`. The project declares only `bounded@3.3.0`. Other old versions, package managers, edited configuration and third-party or local packs refuse automatic npm-hook restoration with a repair path.

`captureInstalledNpmClosure` verifies the installed `bounded` package and all three runtime dependencies (`@vscode/tree-sitter-wasm`, `picomatch`, `zod`) against their published file-tree digests. It checks package identities, exact declared dependency edges and npm lock records. A maintained JavaScript parser follows reachable literal imports from the Claude and Pi host entrypoints and the exact default configuration through Node package resolution. The published Bounded adapter bundle contains two computed imports: only its known bytes are admitted; the default configuration bytes prove the reachable project-config target, while the host-installer path is called by the old CLI and is outside restored hook execution. Pi's literal `bounded/hosts/pi` import must resolve into the inventoried package. An unresolved path, native addon, linked package file, or unsupported dependency form refuses.

The JSON snapshot records project-relative file sizes, modes and SHA-256 hashes; directory entry hashes; and package identities. It includes the project manifest, npm lock and default configuration. Recovery recaptures and compares the complete snapshot immediately before restoring an old hook. This check runs without npm, Node or Bun subprocesses. The update transaction separately checks that the old Claude command's `node` resolves to a compatible executable at restoration time; a snapshot cannot promise a future host PATH.

This helper sits at the `src/` package root beside the standalone runtime and installed-release verifier because the update transaction and recovery share it. It is not pack composition or a host adapter.

## Consequences

The standard published 3.3.0 npm installation can be migrated and recovered after the actual npm package tree is verified. A legitimate installation with other code or an edited config can require manual recovery or a later, separately reviewed proof. Inventory verification detects changed bytes and directory entries; it does not treat a version string or npm lock alone as proof of executable code.
