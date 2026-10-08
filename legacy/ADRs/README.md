# Architecture Decision Records

Decisions about this harness are recorded here as ADRs.

## Scheme

- One file per decision: `YYYY-NNN-slug.md`
- `YYYY` — the year the decision was made
- `NNN` — three-digit number, incrementing, **resetting each year**
  (e.g. `LEG-2026-001`, `LEG-2026-002`, first of 2027 is `2027-001`)
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
| [LEG-2026-001](LEG-2026-001-shared-harness.md) | Shared personal harness | accepted |
| [LEG-2026-002](LEG-2026-002-web-extension.md) | Custom web extension | accepted |
| [LEG-2026-003](LEG-2026-003-subagents.md) | Subagents via pi-subagents, builtins disabled | accepted |
| [LEG-2026-004](LEG-2026-004-browser.md) | Browser automation via betterwright | accepted |
| [LEG-2026-005](LEG-2026-005-harness-self-check.md) | Harness self-verification via `npm run check` + CI | accepted |
| [LEG-2026-006](LEG-2026-006-tracked-config-hygiene.md) | Tracked config stays portable, pinned, and tool-agnostic | accepted |
| [LEG-2026-007](LEG-2026-007-layer2.md) | Layer 2 — canonical commands, language packs, activation scope | accepted |
| [LEG-2026-008](LEG-2026-008-grill-me-skills.md) | grill-me skills — grilling + domain modeling, ported from mattpocock/skills | accepted |
| [LEG-2026-009](LEG-2026-009-expand-to-tn.md) | expand + to-tn — the idea-to-TN flow | accepted |
| [LEG-2026-010](LEG-2026-010-issue-tracking-skill.md) | Issue tracking — one global skill, agent-state convention | accepted |
| [LEG-2026-011](LEG-2026-011-agent-subdir.md) | pi config home moves to `agent/` subdirectory | accepted |
| [LEG-2026-012](LEG-2026-012-vendored-skills.md) | Vendor third-party skills; pin subagent skills by name | accepted |
| [LEG-2026-013](LEG-2026-013-developer-stage-pipeline.md) | Developer stage — three-role pipeline with deterministic enforcement | accepted |
| [LEG-2026-014](LEG-2026-014-structure-not-persona.md) | Agent guidance is structure and procedure, never persona | accepted |
| [LEG-2026-015](LEG-2026-015-nominal-class-value-objects.md) | Value objects are nominal classes; branded aliases are banned | superseded by LEG-2026-059 |
| [LEG-2026-016](LEG-2026-016-no-escape-hatches.md) | The type checker cannot be switched off — no exemption list | accepted |
| [LEG-2026-017](LEG-2026-017-green-requires-red.md) | Green requires a red for the current contracts, mechanically | accepted |
| [LEG-2026-018](LEG-2026-018-guards-and-briefs-are-bidirectional.md) | Every guard is told to the role it binds — drift-tested | accepted |
| [LEG-2026-019](LEG-2026-019-composite-design-gate.md) | The design phase is one gate call, not four | accepted |
| [LEG-2026-020](LEG-2026-020-pre-freeze-design-review.md) | The design is challenged before it is frozen | accepted (amended 2026-09-11 — see Amendment) |
| [LEG-2026-021](LEG-2026-021-parallel-workers-shadow-red.md) | The workers run in parallel; the gate checks the spawn form | accepted |
| [LEG-2026-022](LEG-2026-022-model-tiers.md) | Two model tiers, named per project | accepted |
| [LEG-2026-023](LEG-2026-023-one-identity-per-value-object.md) | One class identity per value object; scaffold is a non-destructive sync | superseded by LEG-2026-059 |
| [LEG-2026-024](LEG-2026-024-scratch-zone.md) | The architect has a scratch zone | accepted |
| [LEG-2026-025](LEG-2026-025-run-start-is-architect-only.md) | The run-start marker is the architect's, by role not by process | accepted |
| [LEG-2026-026](LEG-2026-026-value-objects-in-their-own-contract.md) | Value objects live in their own contract file | superseded by LEG-2026-059 |
| [LEG-2026-027](LEG-2026-027-contract-shape-rules-at-purity.md) | Contract-shape checks belong at contract-purity, not scaffolder fail() | accepted |
| [LEG-2026-028](LEG-2026-028-change-run-boundary.md) | A change run is a new run — the guard log is the run boundary | accepted |
| [LEG-2026-029](LEG-2026-029-capability-tickets-blessed-stacks.md) | Tickets name capability; the harness binds the stack | accepted |
| [LEG-2026-030](LEG-2026-030-cqrs-wire-boundary.md) | CQRS at the wire — command/query value objects, writes return no data, ids are client-produced | accepted |
| [LEG-2026-031](LEG-2026-031-zod-inside-value-objects.md) | Zod is the engine inside value objects, never a public identity | accepted |
| [LEG-2026-032](LEG-2026-032-intake-strips-the-how.md) | Intake strips the how — every spec is reworked to "what is required" | accepted |
| [LEG-2026-033](LEG-2026-033-deliver-checks-socket.md) | `deliverChecks` — a pack-level socket for read-only checks at delivery | accepted |
| [LEG-2026-034](LEG-2026-034-host-portable-enforcement.md) | Enforcement is host-portable — artifact gates as a CLI, capability constraints per host | accepted; amended by LEG-2026-069, LEG-2026-073 |
| [LEG-2026-035](LEG-2026-035-bounded-state-dir-and-adapter-layout.md) | Harness state lives in `.bounded/`; every adapter lives in `hosts/<host>/` with its own install script | accepted |
| [LEG-2026-036](LEG-2026-036-project-pack-selection-and-delivery-obligations.md) | Project composition selects rules and delivery obligations | accepted |
| [LEG-2026-037](LEG-2026-037-explicit-model-deployment-smoke.md) | Explicit model deployment smoke at reset | accepted |
| [LEG-2026-038](LEG-2026-038-independent-harness-review.md) | Independent review for harness changes | accepted; extended by LEG-2026-068 |
| [LEG-2026-039](LEG-2026-039-change-boundary-and-project-adoption.md) | Adopt projects and review changes against a delivery baseline | accepted |
| [LEG-2026-040](LEG-2026-040-project-local-init.md) | Initialize a project with a local harness | accepted |
| [LEG-2026-041](LEG-2026-041-local-cli-publish.md) | Install local CLI snapshots through npm | accepted |
| [LEG-2026-042](LEG-2026-042-repo-dogfood-commands.md) | Keep dogfood commands outside the CLI package | accepted |
| [LEG-2026-043](LEG-2026-043-product-first-init-and-additive-scaffolds.md) | Product-first initialization with additive scaffolds | accepted |
| [LEG-2026-044](LEG-2026-044-frozen-design-ticket-handoffs.md) | Frozen design releases dependent tickets | accepted |
| [LEG-2026-045](LEG-2026-045-project-init-host-guards.md) | Make initialized host guards usable and non-bypassable | accepted |
| [LEG-2026-046](LEG-2026-046-shadow-red-generated-support-and-forward-types.md) | Rebuild generated support in red shadows; verify forward types live | accepted |
| [LEG-2026-047](LEG-2026-047-composed-service-green-gates.md) | Keep composed service and web green gates consistent | accepted |
| [LEG-2026-048](LEG-2026-048-team-lead-project-entry.md) | Team lead as the project entry | accepted; partly superseded by LEG-2026-066; amended by LEG-2026-069 |
| [LEG-2026-049](LEG-2026-049-business-rule-ownership-review.md) | Review ownership of business rules | accepted |
| [LEG-2026-050](LEG-2026-050-ticket-numbered-technical-notes.md) | Ticket-numbered Technical Notes in target projects | accepted |
| [LEG-2026-051](LEG-2026-051-project-setup-socket.md) | Project dependency setup is a pack socket | accepted |
| [LEG-2026-052](LEG-2026-052-contract-file-suffix-socket.md) | Contract files reach the core through a pack socket | accepted; its architect config write access is superseded by LEG-2026-054, and its src/-rooted contract globs by LEG-2026-056 |
| [LEG-2026-053](LEG-2026-053-change-boundary-needs-final-delivery.md) | A change boundary opens only after final delivery | accepted |
| [LEG-2026-054](LEG-2026-054-generated-project-config.md) | Project config is generated from the packs, never written by a role | accepted |
| [LEG-2026-055](LEG-2026-055-drizzle-sqlite-persistence.md) | Versioned SQLite persistence capability | superseded by LEG-2026-058 (migrations move inside the source tree) and LEG-2026-062 (the pack is retired) |
| [LEG-2026-056](LEG-2026-056-source-roots-socket.md) | Source roots are a pack socket | accepted |
| [LEG-2026-057](LEG-2026-057-blindness-by-suffix.md) | Blindness is by file-name suffix, not directory | accepted |
| [LEG-2026-058](LEG-2026-058-generated-files-socket.md) | Generated files are a pack socket | accepted |
| [LEG-2026-059](LEG-2026-059-contract-owns-the-name.md) | The contract owns the name | accepted |
| [LEG-2026-060](LEG-2026-060-skeleton-emitters.md) | Skeleton emitters generate everything mechanical | accepted |
| [LEG-2026-061](LEG-2026-061-workspaces-from-design.md) | Workspaces are generated from the design | accepted |
| [LEG-2026-062](LEG-2026-062-bun-toolchain.md) | Bun is the TypeScript projects' toolchain | accepted |
| [LEG-2026-063](LEG-2026-063-hexagonal-and-adapter-packs.md) | The hexagonal pack and the adapter packs | accepted |
| [LEG-2026-064](LEG-2026-064-store-tests-need-docker-at-green.md) | Store tests need a container runtime only at green | accepted |
| [LEG-2026-065](LEG-2026-065-spec-first-init-by-product-surface.md) | Initialization reads the spec and selects by product surface | accepted |
| [LEG-2026-066](LEG-2026-066-lead-on-main-ticket-worktrees.md) | The lead on main, a worktree per ticket, a board moved by gates | accepted; amended by LEG-2026-069, LEG-2026-073 |
| [LEG-2026-067](LEG-2026-067-generated-composition-roots.md) | Composition roots are generated, their dependencies grouped by area | accepted |
| [LEG-2026-068](LEG-2026-068-harness-development-lifecycle.md) | A development lifecycle for harness work | accepted |
| [LEG-2026-069](LEG-2026-069-claude-code-session-tools-and-own-output.md) | Claude Code's session tools, and a seat re-reading its own saved output | accepted |
| [LEG-2026-070](LEG-2026-070-mutation-measurement-survives-interruption.md) | The mutation measurement survives interruption, samples enough, and fits its host's time | accepted; amended by LEG-2026-073 |
| [LEG-2026-071](LEG-2026-071-a-later-ticket-takes-a-delivered-contract.md) | A later ticket takes a delivered ticket's contract | accepted |
| [LEG-2026-072](LEG-2026-072-no-harness-step-needs-the-user.md) | No harness step needs the user: fast engine refusals routed to the user, call-bounded preparation, apps' own test databases, the lead's sync-config and merge fast-forward | accepted |
| [LEG-2026-073](LEG-2026-073-long-gates-run-as-detached-jobs.md) | Long gates run as detached, resumable jobs; a RUNNING verdict | accepted |
