# 2026-001: A development lifecycle

**Status:** accepted

## Decision

Non-trivial work on this repository runs, per work item, through six stages:
plan, plan review, red commit, build, final review, report.
[The workflow](../development-workflow.md) defines the stages and the record.
It is adapted from the Bounded harness's own lifecycle (that repository's
ADR 2026-068), which this library will later join.

The four roles are Claude Code project agents in `.claude/agents/`:
`planner` (writes only `.agent-state/<item>/plan.md`), `plan-reviewer` and
`final-reviewer` (read and search tools only), and `builder` (full tools, in
its own worktree).

The builder commits the plan's failing tests alone as the red commit.
`scripts/workflow/red-first-check.ts` checks mechanically that the red commit
touches only test files, shared test code and fixtures, that each of its test
files fails under `bun test` at that commit, and that at the branch head none
of its test cases is deleted, skipped, emptied or left with fewer assertions,
and each still runs, passes and makes an assertion. The planner's write and
shell limits are enforced by a PreToolUse hook in its definition
(`scripts/workflow/planner-gate.ts`). The orchestrator merges with `--no-ff`
so the red commit stays in history.

Both scripts are self-contained: they import nothing from the library, only
Node's built-ins and (for the red-first check) the TypeScript compiler, so a
broken build cannot open the planner's gate or fake a check.

## Why

A plan review catches architecture problems while they are cheap; the
red-first check turns "tests first, never weakened" from an instruction into a
check, in line with determinism over prompt instructions.

## Consequences

The lifecycle is a working agreement: the check is not a merge gate or a CI
job. It counts assertions and never reads them, so the final reviewer must
read every case it notes as changed. It also misses assertions inside helpers
and in `*.test-support.ts` conformance suites except through the test files
that run them, and reads a moved or retitled case as deleted; the script's
header lists these limits.
