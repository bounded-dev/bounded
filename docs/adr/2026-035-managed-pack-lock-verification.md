# 2026-035: Bind managed pack inventories to a plural-root lock

**Status:** accepted for the internal managed-pack verification slice of issue #67. Amends [ADR 2026-034](2026-034-managed-pack-artifacts.md). Public `add`, editor projection and runtime loading remain separate work.

## Decision

The project lock uses `bounded-packs-lock/2`. Its `roots` map names every directly added package and its exact node id. Each node records `inventorySha256`, the SHA-256 of the exact `inventory.json` bytes written to the store, including the final newline. The offline verifier checks lock node to inventory bytes to the complete regular-file set, size and SHA-256 of every stored file. It refuses linked path components, malformed or unreachable nodes, duplicate package identities, missing or inconsistent dependency edges, package/catalogue/export disagreements and a Bounded version mismatch. Verification performs no network request or package execution. Refusals name a package and a re-add action.

An add fully verifies any existing lock before publishing a replacement. It keeps other directly added roots and their reachable dependencies; upgrading one root prunes only nodes no longer reachable from any root. A project writer directory serializes concurrent adds. The lock is atomically replaced last. An interrupted add can leave an unused verified store entry but preserves the prior lock. The unshipped single-root `bounded-packs-lock/1` cannot establish the archive digest from extracted bytes alone; it is refused with a re-add instruction. Migration requires re-verifying the original exact tarball bytes.

The project lock is the trust anchor for this internal store. A user who rewrites both lock and inventory can choose different bytes; these hashes establish consistency with the current lock, not publisher identity or the historical tarball. Registry integrity and artifact SHA-256 are checked at install time as in ADR 2026-034. The runtime loader and public check must reverify before use.
