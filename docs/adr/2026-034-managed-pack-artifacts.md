# 2026-034: Verify published pack artifacts before locking them

**Status:** accepted for the managed published-pack artifact slice of issue #67. Amends [ADR 2026-029](2026-029-package-catalogue.md), [ADR 2026-030](2026-030-published-packs.md) and [ADR 2026-032](2026-032-catalogue-build-on-bun.md). The project command, editor projection and runtime loader are separate slices.

## Context

A published pack is built by its author and distributed as an npm-compatible tarball. The standalone Bounded executable must install one without running npm, Node, Bun's package manager, package scripts or an authoring command on the user's machine. The package catalogue describes the pack, but does not authenticate the tarball or govern which JavaScript executes.

## Decision

- The installer accepts an exact `name@version`, resolves metadata and every dependency through HTTPS, and refuses an HTTP URL at any redirect hop. It checks registry SHA-512 integrity when supplied and records the tarball's SHA-256. The project lock has schema `bounded-packs-lock/1`, the exact Bounded version, a root node and an identity plus per-importer dependency edges for every resolved node. Different parents can point to different versions of one dependency.
- Its registry transport returns exactly one HTTP response per request. A production adapter must use manual redirects; an HTTP client that follows redirects internally would hide intermediate URLs from verification and is invalid for this port.
- A tarball is unpacked only after byte integrity succeeds. The installer rejects unsafe paths, duplicates including case-fold collisions, links, devices, excessive size or entry count, lifecycle install scripts, native addons and nonliteral dynamic imports. It does not execute package code while installing. Built JavaScript imports must stay within the package or name a declared dependency or the `bounded` peer. An unresolved import is a refusal.
- A pack's `package.json` must satisfy `PackageManifest`, require the running Bounded version as a peer, export built JavaScript for Node's ESM import conditions, and include a version 1 `PackageCatalog` whose package identity and complete pack/export list match the manifest. Every declared peer in the closure must be satisfied in the importing parent's resolved graph. A plain dependency does not need a Bounded catalogue. Export targets use the same Node resolver as the catalogue builder (ADR 2026-032), including conditions and subpath patterns. A `bounded/*` import must name an export the executable embeds.
- Each unpacked file is hashed in an inventory. A store directory is named by the tarball SHA-256, staged and verified before publication. Reuse verifies the full inventory again. An existing lock is replaced atomically only after every required store node has passed verification. Failure leaves the old lock intact. Hooks later reverify the pinned store before loading it.
- The consumer implementation uses Bun's runtime and semver service, `tar-stream` for tar parsing and Acorn for JavaScript syntax. When the CLI installer is wired into the standalone executable, its build must bundle these dependencies. Authors may use their own build CLI; the artifact contract is what Bounded consumes.

HTTPS, registry integrity and project digests establish transport integrity and exact installed bytes. They do not prove publisher identity or make pack code safe. A publisher-attestation requirement remains a separate release-policy decision.

## Scope and follow-up

This slice provides the installer contract and verified store. It does not expose `bounded add`, generate editor declarations, load the pack in a hook or migrate `init` and `update`. Those steps need their own red-first evidence and review before a standalone release.
