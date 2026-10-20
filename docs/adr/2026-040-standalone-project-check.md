# 2026-040: Check a standalone project's selected configuration

**Status:** accepted for the standalone Claude Code release. Amends [ADR 2026-039](2026-039-standalone-managed-pack-runtime.md).

## Decision

`bounded check` requires the project's exact version pin and verifies the installed executable, release receipt and manifest. It refuses a pending managed-pack journal, incomplete lock or type receipt, changed store inventory, changed editor projection, and changed release declarations. It does not recover a transaction or make Bounded-owned network requests or project edits. Project configuration and pack JavaScript still run with the executable's normal permissions and may themselves perform I/O.

The release embeds TypeScript 5.9.3 standard libraries, `@types/node` 26.6.4, `undici-types` 8.9.0 and the external declaration closure needed by the standalone-supported Bounded public subpaths. Its verified release manifest lists a type-environment manifest with a SHA-256 for every embedded declaration. Check verifies those hashes before creating a TypeScript program and never resolves types from ambient `node_modules`. It uses the verified release's Bounded declaration tree, the pinned managed graph's declarations with importer-local dependency edges, and one captured project source graph. TypeScript errors fail with file, location and TS code; warnings are reported without failing.

The same captured project and managed module bytes feed the compiler and the runtime config loader. A framed SHA-256 digest also binds the verified release manifest and pinned graph for hosts that keep sessions. The loader validates selected managed objects against their locked catalogue before composition. A shared pure wiring function composes selected packs and checks required host ports without calling lifecycle, guards, tools or adapters. The standalone release currently recognizes Claude Code's installed hooks; check requires that host wiring and reports that host in success output. When another standalone host installer is shipped, check must validate every recognized installed host before reporting project success.

This check is a snapshot of a project at one point in time. A later change is validated again by the next hook or check. It does not sandbox project code or promise that arbitrary code in configuration is offline or read-only.
