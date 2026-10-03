# Architecture Decision Records

Decisions about this harness are recorded here as ADRs.

## Scheme

- One file per decision: `YYYY-NNN-slug.md`
- `YYYY` — the year the decision was made
- `NNN` — three-digit number, incrementing, **resetting each year**
  (e.g. `2026-001`, `2026-002`, first of 2027 is `2027-001`)
- `slug` — short kebab-case summary

While the harness is young, rewrite and compact ADRs freely rather than
stacking supersession chains. Once decisions are load-bearing and shared,
prefer `superseded by` over rewriting.

## Format

Keep ADRs very concise. Record only what was actually decided and why:

```markdown
# YYYY-NNN: Title

**Status:** accepted | superseded by YYYY-NNN

## Decision
## Why
## Consequences
```

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [2026-001](2026-001-shared-harness.md) | Shared personal harness | accepted |
| [2026-002](2026-002-web-extension.md) | Custom web extension | accepted |
| [2026-003](2026-003-subagents.md) | Subagents via pi-subagents, builtins disabled | accepted |
| [2026-004](2026-004-browser.md) | Browser automation via betterwright | accepted |
| [2026-005](2026-005-harness-self-check.md) | Harness self-verification via `npm run check` + CI | accepted |
| [2026-006](2026-006-tracked-config-hygiene.md) | Tracked config stays portable, pinned, and tool-agnostic | accepted |
| [2026-007](2026-007-layer2.md) | Layer 2 — canonical commands, language packs, activation scope | accepted |
| [2026-008](2026-008-grill-me-skills.md) | grill-me skills — grilling + domain modeling, ported from mattpocock/skills | accepted |
| [2026-009](2026-009-expand-to-tn.md) | expand + to-tn — the idea-to-TN flow | accepted |
| [2026-010](2026-010-issue-tracking-skill.md) | Issue tracking — one global skill, agent-state convention | accepted |
| [2026-011](2026-011-agent-subdir.md) | pi config home moves to `agent/` subdirectory | accepted |
| [2026-012](2026-012-vendored-skills.md) | Vendor third-party skills; pin subagent skills by name | accepted |
| [2026-013](2026-013-developer-stage-pipeline.md) | Developer stage — three-role pipeline with deterministic enforcement | accepted |
| [2026-014](2026-014-structure-not-persona.md) | Agent guidance is structure and procedure, never persona | accepted |
| [2026-015](2026-015-nominal-class-value-objects.md) | Value objects are nominal classes; branded aliases are banned | superseded by 2026-059 |
| [2026-016](2026-016-no-escape-hatches.md) | The type checker cannot be switched off — no exemption list | accepted |
| [2026-017](2026-017-green-requires-red.md) | Green requires a red for the current contracts, mechanically | accepted |
| [2026-018](2026-018-guards-and-briefs-are-bidirectional.md) | Every guard is told to the role it binds — drift-tested | accepted |
| [2026-019](2026-019-composite-design-gate.md) | The design phase is one gate call, not four | accepted |
| [2026-020](2026-020-pre-freeze-design-review.md) | The design is challenged before it is frozen | accepted (amended 2026-09-11 — see Amendment) |
| [2026-021](2026-021-parallel-workers-shadow-red.md) | The workers run in parallel; the gate checks the spawn form | accepted |
| [2026-022](2026-022-model-tiers.md) | Two model tiers, named per project | accepted |
| [2026-023](2026-023-one-identity-per-value-object.md) | One class identity per value object; scaffold is a non-destructive sync | superseded by 2026-059 |
| [2026-024](2026-024-scratch-zone.md) | The architect has a scratch zone | accepted |
| [2026-025](2026-025-run-start-is-architect-only.md) | The run-start marker is the architect's, by role not by process | accepted |
| [2026-026](2026-026-value-objects-in-their-own-contract.md) | Value objects live in their own contract file | superseded by 2026-059 |
| [2026-027](2026-027-contract-shape-rules-at-purity.md) | Contract-shape checks belong at contract-purity, not scaffolder fail() | accepted |
| [2026-028](2026-028-change-run-boundary.md) | A change run is a new run — the guard log is the run boundary | accepted |
| [2026-029](2026-029-capability-tickets-blessed-stacks.md) | Tickets name capability; the harness binds the stack | accepted |
| [2026-030](2026-030-cqrs-wire-boundary.md) | CQRS at the wire — command/query value objects, writes return no data, ids are client-produced | accepted |
| [2026-031](2026-031-zod-inside-value-objects.md) | Zod is the engine inside value objects, never a public identity | accepted |
| [2026-032](2026-032-intake-strips-the-how.md) | Intake strips the how — every spec is reworked to "what is required" | accepted |
| [2026-033](2026-033-deliver-checks-socket.md) | `deliverChecks` — a pack-level socket for read-only checks at delivery | accepted |
| [2026-034](2026-034-host-portable-enforcement.md) | Enforcement is host-portable — artifact gates as a CLI, capability constraints per host | accepted |
| [2026-035](2026-035-bounded-state-dir-and-adapter-layout.md) | Harness state lives in `.bounded/`; every adapter lives in `hosts/<host>/` with its own install script | accepted |
| [2026-036](2026-036-project-pack-selection-and-delivery-obligations.md) | Project composition selects rules and delivery obligations | accepted |
| [2026-037](2026-037-explicit-model-deployment-smoke.md) | Explicit model deployment smoke at reset | accepted |
| [2026-038](2026-038-independent-harness-review.md) | Independent review for harness changes | accepted |
| [2026-039](2026-039-change-boundary-and-project-adoption.md) | Adopt projects and review changes against a delivery baseline | accepted |
| [2026-040](2026-040-project-local-init.md) | Initialize a project with a local harness | accepted |
| [2026-041](2026-041-local-cli-publish.md) | Install local CLI snapshots through npm | accepted |
| [2026-042](2026-042-repo-dogfood-commands.md) | Keep dogfood commands outside the CLI package | accepted |
| [2026-043](2026-043-product-first-init-and-additive-scaffolds.md) | Product-first initialization with additive scaffolds | accepted |
| [2026-044](2026-044-frozen-design-ticket-handoffs.md) | Frozen design releases dependent tickets | accepted |
| [2026-045](2026-045-project-init-host-guards.md) | Make initialized host guards usable and non-bypassable | accepted |
| [2026-046](2026-046-shadow-red-generated-support-and-forward-types.md) | Rebuild generated support in red shadows; verify forward types live | accepted |
| [2026-047](2026-047-composed-service-green-gates.md) | Keep composed service and web green gates consistent | accepted |
| [2026-048](2026-048-team-lead-project-entry.md) | Team lead as the project entry | accepted |
| [2026-049](2026-049-business-rule-ownership-review.md) | Review ownership of business rules | accepted |
| [2026-050](2026-050-ticket-numbered-technical-notes.md) | Ticket-numbered Technical Notes in target projects | accepted |
| [2026-051](2026-051-project-setup-socket.md) | Project dependency setup is a pack socket | accepted |
| [2026-052](2026-052-contract-file-suffix-socket.md) | Contract files reach the core through a pack socket | accepted; its architect config write access is superseded by 2026-054, and its src/-rooted contract globs by 2026-056 |
| [2026-053](2026-053-change-boundary-needs-final-delivery.md) | A change boundary opens only after final delivery | accepted |
| [2026-054](2026-054-generated-project-config.md) | Project config is generated from the packs, never written by a role | accepted |
| [2026-055](2026-055-drizzle-sqlite-persistence.md) | Versioned SQLite persistence capability | superseded by 2026-058 (migrations move inside the source tree) and 2026-062 (the pack is retired) |
| [2026-056](2026-056-source-roots-socket.md) | Source roots are a pack socket | accepted |
| [2026-057](2026-057-blindness-by-suffix.md) | Blindness is by file-name suffix, not directory | accepted |
| [2026-058](2026-058-generated-files-socket.md) | Generated files are a pack socket | accepted |
| [2026-059](2026-059-contract-owns-the-name.md) | The contract owns the name | accepted |
| [2026-060](2026-060-skeleton-emitters.md) | Skeleton emitters generate everything mechanical | accepted |
| [2026-061](2026-061-workspaces-from-design.md) | Workspaces are generated from the design | accepted |
| [2026-062](2026-062-bun-toolchain.md) | Bun is the TypeScript projects' toolchain | accepted |
| [2026-063](2026-063-hexagonal-and-adapter-packs.md) | The hexagonal pack and the adapter packs | accepted |
| [2026-064](2026-064-store-tests-need-docker-at-green.md) | Store tests need a container runtime only at green | accepted |
| [2026-065](2026-065-spec-first-init-by-product-surface.md) | Initialization reads the spec and selects by product surface | accepted |
| [2026-067](2026-067-generated-composition-roots.md) | Composition roots are generated, their dependencies grouped by area | accepted |
