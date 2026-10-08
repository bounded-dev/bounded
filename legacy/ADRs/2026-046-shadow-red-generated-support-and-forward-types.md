# 2026-046: Rebuild generated support in red shadows; verify forward types live

**Status:** accepted

## Decision

The red gate reconstructs contract-triggered support files from the owning
pack's canonical source while building its shadow project. The ts pack defines
a `contractSupportFiles` socket, born with its two consumers (the scaffolder
and the red gate); a pack contributes each file's canonical source and target
rule. ts-service contributes the service runtime and owns its canonical copy,
so a project that has not composed ts-service gets no runtime in either tree.
The rest of the service behaviour follows the same rule: ts-service contributes
the `raw-framework-entry` lint through `lintSrcRules`, the `no-erased-router`
and `router-type-reexported` contract rules through `contractPurityOverrides`
(which may now carry the contributing pack's own plugin, here
`bounded-ts-service/`), and the runtime's framework
package as a dependency of its support file, which delivery pins.

A support file's targets come from a contributed function reading the
contract's imports, so both consumers check every target before writing
(`packs/ts/scripts/support-targets.ts`). A target must lie strictly inside the
project's `src/`, as written and after links are resolved. Otherwise the
scaffolder blocks, or the red gate fails, and names the contract and the
resolved path.

The gate never copies a live business implementation. A contract may import a
type from a value exported only by its sibling implementation. When the regenerated skeleton lacks that
export, the gate accepts only that exact missing-export diagnostic, only for a
type-only import of a value the live sibling exports, and only if the complete
live project typechecks. Every other shadow diagnostic still blocks red.

## Why

In the [project-local CRM dogfood run](../docs/dogfood/runs/run-26-030-project-local-crm-init.md),
a demonstration project built under the harness, a contract imported the
shipped service runtime and inferred a
router type from the implementation. The shadow omitted the runtime and the
router value, so it blocked a suite whose tests otherwise failed for
NotImplemented. The runtime is deterministic pack output. The inferred router
type cannot be honestly synthesized from a throwing skeleton.

## Consequences

Red remains independent of the builder for ordinary contracts. A contract
that borrows an implementation-only type must wait for a type-clean live tree
before red can pass. This is explicit coupling, not a permissive `any` stand-in
or a blanket suppression: the shadow suite still runs against only throwing
skeletons, and an import, test, or implementation error still blocks the gate.
