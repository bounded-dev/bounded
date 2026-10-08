# 2026-013: Developer stage — three-role pipeline with deterministic enforcement

**Status:** accepted

## Decision

The developer stage is a three-role subagent pipeline — architect (spec +
contract), test-writer (tests, blind to implementation), builder
(implementation, blind to tests) — orchestrated by a pi session. Every role
boundary and phase transition is enforced by deterministic machinery (tool
allowlists, a path-gate extension, zone ESLint rules, a generated skeleton,
red/green test gates), not prompt instructions. Design in TN-26-001.

## Why

- An agent that writes both tests and implementation grades its own exam;
  separate contexts with disjoint authority fix the incentive structure
  (research: Kannan multi-agent TDD loop, TDFlow, Böckeler).
- Determinism over minimalism (root AGENTS.md): enforcement layers are
  justified by deviation-proofing, not per-task need.
- Blindness is enforced by capability removal (builder has no `bash`; tests
  are simply unreachable), which is stronger than rules over general tools.
- Orchestration stays a composable skill; only the gates are mechanical —
  consistent with ADR 2026-009 (skills compose) read as orchestration
  guidance, not a limit on enforcement depth.

## Consequences

- Three new agent definitions join the roster — a deliberate exception to
  "roles added reluctantly" (ADR 2026-003), scoped to the developer-stage
  workflow, not general use.
- `packs/ts` gains its first content: `run_tests` tool, declaration-only
  lint rule, scaffolder, gate scripts (ADR 2026-007).
- Pipeline-managed components require `*.contract.ts` + separated `tests/`
  layout; the rest of a repo is untouched.
- Phase-gate mechanics get their own ADR when v1 lands (parked).

## Amendments

- **The orchestrator was folded into the architect** (issue #12, on five runs
  of evidence). The driving session *is* the architect; there is no separate
  orchestrating role, and the PLAN phase went with it.
- **A fourth role joined**: the read-only `reviewer`, which reads the design
  before the freeze and records what it found (ADR 2026-020).
- **The parked phase-gate ADR landed** as ADR 2026-021, which gates the spawn
  itself — and removes the ordering between the two workers, since the red is
  proven in a shadow project and green is bound to the tests it covered.
