# 2026-042: Projects provide adapters to selected packs

**Status:** accepted. Amends [ADR 2026-010](2026-010-project-configuration.md), [ADR 2026-030](2026-030-published-packs.md), [ADR 2026-039](2026-039-standalone-managed-pack-runtime.md) and [ADR 2026-040](2026-040-standalone-project-check.md).

## Decision

A project may provide adapters for selected packs' declared ports in `defineConfig({ packs, ports })`. Each entry is a nominal `Ports.provide(pack.ports.name, projectRoot => adapter)` value. This lets an author publish a pack and an adapter on declared package export paths while the consuming project chooses whether to use them. Installing a pack does not select it or discover an adapter automatically. A project may also provide a selected pack's optional port.

The configuration stores the list without opening factories. A shared pure validator composes the selected pack closure, rejects malformed lists or keys, validates each project provision against a selected pack's required or optional port, combines project and host provisions, rejects duplicate owner-and-name keys, then checks that every required port is present. A host's fixed provision for an unselected pack is allowed. The host opens only the validated union for actual lifecycle work. `bounded check` uses the same validator and does not call adapter factories.

Port identity is the pack id and port name declared by the selected pack. A project provision for an unselected or undeclared port refuses with the owner, port and correction. A missing required port refuses before lifecycle work. An adapter factory may run with the project's normal permissions when its port is used; check does not promise to sandbox project code in the configuration or its imports.
