---
number: 26-001
title: "Developer stage: architect / test-writer / builder pipeline"
kind: design
status: draft
issue: 1
---

# TN-26-001: Developer stage — architect / test-writer / builder pipeline

> **Superseded in part (2026-08-31).** This note records the pipeline as first
> designed and built: a separate orchestrator spawning three blind subagents,
> with a PLAN phase before DESIGN. Five dogfood runs showed the orchestrator
> and the plan phase cost more than they returned, so both were folded into
> the architect — see [issue #12](https://github.com/bounded-dev/the-bounded-harness/issues/12)
> and `docs/where-we-are.md` for the evidence. Everything here about
> blindness, the gates, the contract and the guard log still stands; the
> role *count* and the phase list do not.

## Summary

A pipeline for the developer stage of the agentic workflow: three write-capable
subagents with disjoint authority — **architect** (spec + contract, no
implementation), **test-writer** (tests only, blind to implementation),
**builder** (implementation only, blind to tests) — orchestrated by a pi
session, with every role boundary and phase transition enforced by
deterministic machinery (tool allowlists, a path gate, zone lint rules, a
scaffolder, test-runner gates) rather than prompt instructions.

Rationale: an agent that writes both tests and implementation grades its own
exam; tests fit the code instead of the requirements (see Appendix). The
separation is incentive structure, not prompting. Guiding principle:
**determinism over minimalism** (root `AGENTS.md`) — stack enforcement layers
even when one looks over-engineered.

## Roles and flow

```
ORCHESTRATOR (a pi session; interactive mode = main session)
  1. PLAN     orchestrator explores (scout) and writes the plan
              · checkpoint: user approves the plan (interactive mode)
  2. DESIGN   architect subagent: plan + codebase → spec + contract
              · gate: contract compiles, declaration-only lint passes
              · machine: scaffolder generates throwing skeletons in src/
  3. TEST     test-writer subagent (never sees src/): spec + contract → tests/
              · gate: suite runs RED, failing with NotImplemented only
  4. BUILD    builder subagent (never sees tests): spec + contract → src/
              · gate: orchestrator's own run of the suite is GREEN
  5. VERDICTS builder returns GREEN | BLOCKED | DISPUTE; disputes route
              test-writer → architect → user
```

**How it runs today.** The block above is the original design. The shape the
gates now enforce is shorter, and its middle is not a sequence:

```
ARCHITECT (a pi session bound to the role at launch, via bounded ticket)
  1. DESIGN   architect writes spec.md + *.contract.ts
              · reviewer subagent reads the design and records its findings
              · gate: design_gate — contract-purity → scaffold → typecheck →
                design-review → freeze, one call, one verdict
  2. WORK     test-writer and builder commissioned together and running in
              PARALLEL over disjoint write zones (tests/, src/); no ordering
              between them, each gated as it returns (ADR 2026-021)
              · gate: red_gate, run in a shadow project rebuilt from the
                contracts and the tests — so a valid red is establishable at
                any moment, whatever src/ currently holds
              · gate: green_gate, from the architect's own run, and only over
                a red that covers these contracts AND these tests
  3. VERDICTS builder returns GREEN | BLOCKED | DISPUTE; disputes route
              test-writer → architect → user; then sign_off, then deliver
```

DESIGN is the only phase; TEST and BUILD are two workers, so the critical path
is max(TEST, BUILD) rather than their sum. What makes that safe is where the
red gate runs: it copies contracts, tests and config into `.bounded/shadow-red`,
regenerates the skeletons there and runs that, copying no implementation file
at all. Green is bound to the red in both directions — the contract manifest
and a hash of the `tests/` tree — so a contract revision and a test edit each
void the red, and re-establishing one never touches `src/`.

- Only orchestrators hold the `subagent` tool; workers never orchestrate.
- Loop granularity is per component, not per feature.
- The plan proposes structure; the architect re-derives and decides it — plan
  review falls out of the architect doing its job in a fresh context.
- Plan = the route (approach, sequence, risks, scope; disposable after
  DESIGN). Spec + contract = the shape (behavior, edge cases, types, ports;
  load-bearing, committed).

## Blindness and enforcement

Each role may only write its own kind of artifact; "kind" is defined by lint
rules and path globs, never by trust.

| Role | Writes | Zone lint rule | Never reads |
| --- | --- | --- | --- |
| architect | `spec.md`, `src/**/*.contract.ts` | declarations only; no function bodies; no concrete infra imports | tests/, builder output |
| test-writer | `tests/**` | test files; imports limited to contract paths + test libs | `src/**` (always, including revision passes) |
| builder | `src/**` except `*.contract.ts` | implementation; no imports from `tests/**` | `tests/**` |

Enforcement layers:

1. **Tool removal** — the only layer that *prevents* rather than detects: a
   tool a role may not use is absent from its toolset, not refused when
   called. Builder: `read, write, edit, run_tests, typecheck` — no `bash`
   (shell access defeats all path rules). Subagents get this from their
   frontmatter allowlist. A session bound to a role directly gets it two ways:
   `bounded ticket` launches with `--exclude-tools`, dropping them from the
   registry, and the path-gate extension strips the role's forbidden tools
   from the visible toolset at `session_start`, logging one `tool-strip` guard
   event so a tool's absence stays distinguishable from a model not reaching
   for it. A refusal layer remains behind both as a backstop.
2. **Path-gate extension** — a `tool_call` hook blocking `read`/`edit`/
   `write`/`grep`/`find` outside the role's zones (modelled on pi's
   `protected-paths.ts` example). Exact glob matching; block reason feeds back
   to the agent.
3. **Custom tools** — `run_tests` executes the suite and returns failure names
   + assertion diffs only (code frames, stack traces, paths, and console
   capture stripped — failure output otherwise leaks test source). Same suite
   binary as the orchestrator's gates, different reporter.
4. **Zone ESLint rules** — run pre-write by the gate (fast feedback) and
   repo-wide as phase gates (authoritative; catches cross-file sins).
5. **Scaffolder** — skeletons (`throw new NotImplementedError()`) are
   *generated* from the contract by a script in `packs/ts/scripts/`, never
   written by an agent. The contract→implementation path mapping is a fixed
   naming rule: `foo.contract.ts` is implemented by sibling `foo.ts`.
6. **Test-runner gates** — red requires failure *because* NotImplemented
   (wrong-reason red, e.g. import errors, is rejected), and runs in a shadow
   project rebuilt from the contracts and the tests rather than against the
   live tree, which is what allows the two workers to run in parallel; green
   is asserted from the architect's own run, not the builder's say-so, and
   only over a red that covers both the current contracts and the current
   tests (the red records a `tests/` tree hash; a test edited afterwards voids
   it). Both gates also
   require a **type-clean project** — a passing suite that does not compile is
   a false green (issue #7, dogfood Run 3) — and both print one `route → role`
   line naming the furthest-upstream role whose write zone owns the failure,
   so a `tests/**` type error bounces to the test-writer rather than to a
   builder that is blind to it.

Contract files colocate with their component (`src/orders/orders.contract.ts`)
and live on as the component's typed public surface. Pipeline-managed
components require a separated `tests/` directory — blindness is structural or
it is nothing. Side effects sit behind ports declared in the contract;
test-writer writes fakes against ports.

## Dispute protocol

Frozen tests + a wrong test would deadlock the loop, so the builder has a
voice, not a pen:

- `GREEN` — suite passes. `BLOCKED` — tests can't run (bounce to test-writer).
- `DISPUTE(test, evidence)` — "this test contradicts the spec because…".
  Routes to the test-writer, which must fix the test or defend it with a spec
  citation. Two unresolved rounds escalate to the architect (a dispute is
  usually spec ambiguity; the architect clarifies the spec). Genuine product
  decisions reach the user.
- Contract wrong mid-loop: builder raises `CONTRACT-DISPUTE`; architect
  revises with a logged rationale; full red-gate re-run; test-writer repairs
  broken tests; loop resumes.
- Bounce budget is bounded; exhaustion escalates to the user with the dispute
  log. Never loop forever.
- Every gate failure and bounce produces a one-line, greppable reason in a
  progress log — a deterministic system that is opaque when it jams is just a
  deterministic jam.

## Placement

- **Harness (global, language-agnostic):** the three agent definitions, the
  `developer-stage` orchestration skill, the path-gate extension, the dispute
  protocol. Skills compose; they do not hard-code phase gates (ADR 2026-009).
- **`packs/ts` (per ADR 2026-007):** the vitest `run_tests` tool, the
  declaration-only lint rule, the scaffolder, red/green scripts keyed to the
  consuming project's canonical `test` command.

## v1 scope

In: three agents, one skill, path-gate extension, scaffolder, declaration-only
lint rule, red/green gates, dispute protocol, hardcoded zone globs,
interactive mode only, all agents inherit the parent model (ADR 2026-003).

Out (v2+, parked): autonomous team-lead mode, mutation floor (Stryker),
property-based tests (fast-check) from spec correctness properties,
integration-test role, harness-dictated directory structure. Two items have
since landed and left this list: the phase gate, which checks the spawn itself
and its form (ADR 2026-021), and per-role model tiering — two tiers,
`designModel` for the judgment seats and `workerModel` for the production
seats (ADR 2026-022).

## Decisions

- **Three roles with disjoint write zones** — fixes self-colluding tests by
  incentive structure (separate contexts), not prompts.
- **Builder is blind to test *source*, sees failure output** — prevents
  overfitting to tests while keeping debugging feasible; enforced by
  capability removal (no bash) + sanitized `run_tests`, not by rules.
- **Architect = separate subagent per task, not the orchestrator** — fresh
  context re-derives structure from the plan's intent; recovers plan review
  for free; team lead never architects (context pollution in fan-out).
- **Contract = `*.contract.ts` colocated with the component** — idiomatic TS;
  rejected a separate `contract/` source root and hand-written `.d.ts`
  (mainstream practice: `.d.ts` is generated, never hand-written, for your
  own code).
- **Skeletons are machine-generated, not agent-written** — nothing to police;
  red gate gets a reliable failure reason.
- **Orchestration is a skill; gates are commands** — probabilistic
  orchestration around deterministic cores. Orchestrator LLM judgment is used
  for planning and dispute routing, never for "did the gate pass".
- **Plan (route) vs spec+contract (shape)** — plan proposes, architect
  decides; the plan is scaffolding, spec+contract are load-bearing.

## Open questions

- **Phase-gate mechanics** between pipeline stages — deliberately parked; gets
  its own ADR when v1 lands.
- **Autonomous mode checkpoints** — where the user sits when a team lead runs
  many tasks; deferred with team-lead mode.
- **Mutation floor calibration** — score threshold and equivalent-mutant
  policy, decided when Stryker lands (v2).
- **Pilot feature** — which real repo/feature gets the first live run; choose
  before build Phase 4.

## Appendix

Research and prior art informing the design:

- **Ranjith Kannan, "Building a Multi-Agent TDD Loop"** (2026) —
  ranjithkannan.com/2026/04/10/multi-agent-tdd-loop/. Closest prior art:
  Test-Writer/Worker separation framed as game theory (principal-agent,
  mechanism design); worker forbidden from modifying test assertions; separate
  contexts make the incentives real; bounce-backs priced as lost iterations;
  Ralph-loop orchestration; per-role model tiering.
- **TDFlow** (arXiv 2510.23761) — LLMs resolve human-written tests at ~94%
  but degrade sharply on self-written tests: test *generation* is the
  bottleneck, implementation the strong link. Motivates quality gates on the
  test-writer's output, not just the builder's.
- **Böckeler (Thoughtworks/martinfowler.com), "TDD inside the agent loop"** —
  single-agent TDD showed no quality gain; winning runs did full up-front
  design, which strict red-green suppresses; even test-first agents wrote
  tautological tests (code checked against itself); red only proves something
  if someone checks *why* it went red. Motivates the architect role and the
  failure-reason red gate.
- **TDAD** (arXiv 2603.17973) — "TDD Prompting Paradox": procedural TDD
  instructions alone don't help.
- **MatrixFounder/Agentic-development** — Stub-First: tests written and run
  against stubs before implementation; Analyst→Architect→Planner→Developer
  pipeline with adversarial VDD agent.
- **Kiro / spec-kit** — spec-driven three-artifact flow (requirements,
  design.md with interfaces + correctness properties, tasks.md); Kiro
  generates property-based tests from correctness properties.
- **Hardware verification (ASIC/FPGA)** — decades-old precedent for the split:
  verification engineers work from the spec, black-box, in parallel with
  designers; functional coverage as the deterministic gate. TS analogs:
  Stryker (mutation testing) as test-quality floor; fast-check (property-based
  testing) to generate edge cases the LLM wouldn't enumerate.
- **ESLint-as-guardrail practice** — eslint-plugin-ai-guardrails; Steve
  Kinney ("write lint error messages like prompts; they're the first thing the
  agent reads"); Nx `enforce-module-boundaries` / eslint-plugin-boundaries as
  per-zone policy precedent.
- **pi mechanics** — `tool_call` hook can block (even pre-permission);
  `examples/extensions/protected-paths.ts` is the canonical gate pattern;
  subagent frontmatter `tools:` is a strict allowlist; `subagentOnlyExtensions`
  for role-specific tooling.

Alternatives considered and rejected: orchestrator-as-architect; builder with
bash + read rules (unpoliceable); separate git worktrees for blindness
(heavier than capability removal); hand-written `.d.ts` contracts;
single-context role-switching.
