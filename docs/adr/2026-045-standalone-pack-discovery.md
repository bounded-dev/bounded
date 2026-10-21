# 2026-045: The standalone executable discovers included and project-installed pack catalogues offline

**Status:** accepted for issue #67's installed pack discovery slice of issue #68. Amends [2026-029](2026-029-package-catalogue.md), [2026-034](2026-034-managed-pack-artifacts.md), [2026-035](2026-035-managed-pack-lock-verification.md) and [2026-036](2026-036-native-release-gate.md).

## Decision

`bounded packs` lists the packs in Bounded's own release catalogue and the catalogued pack packages in the nearest containing project's verified managed lock. A direct `bounded add` includes its exact pinned transitive dependency graph, so a dependency package's catalogue is listed if it ships packs. Files merely present in the global pack store and project `node_modules` are never searched. `bounded packs show <id>` prints the complete version-1 catalogue entry with its package name and exact version as JSON. Both commands are read only, offline, and never evaluate a pack or project configuration. They describe inclusion, not selection for a run or endorsement.

The native release build runs the existing `bounded catalog build` against built JavaScript and puts `share/catalog/bounded.catalog.json` in every archive. The release manifest requires this file, binds its size and digest, and archive verification checks its format and `bounded@<release version>` identity. The installed-release receipt and manifest reverify it before a command uses it. A missing or altered release catalogue is a reinstall refusal.

Published pack catalogues come only from `captureManagedPackRuntimeGraph`, which verifies the exact project lock, type projection receipt, complete content-addressed store and every package catalogue before returning copied bytes and parsed catalogue objects. The command rechecks the lock/receipt/journal boundary and update journal immediately before writing output. A mutation before capture refuses; a later store mutation cannot change the already captured response. A pending update or projection journal refuses discovery. Duplicate ids and an unknown requested id refuse; list rows are sorted by id. List output refuses control characters in displayed catalogue fields so each pack occupies one physical tab-separated row.

The CLI does not claim issue #68's npm search, guide, website, provenance attestation display, or official/reviewed labels. Those remain separate work.
