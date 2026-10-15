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
touches only test files, shared test code, fixtures and shipped packs'
example scenarios, that each of its test files fails under `bun test` at that
commit, that at the branch head none of its test cases is deleted, skipped,
emptied or left with fewer assertions, and each still runs, passes and makes
an assertion, and that only test-only commits changed its example scenarios
since (amended by `red-first-scenarios`, below). The planner's write and
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

## Amended by `red-first-scenarios`

A shipped pack's example scenarios
(`src/packs/<name>/examples/<slug>.scenarios.ts`, one level deep, kebab-case
slug) may be in a red commit. A scenarios file states calls and the exact
verdict each must get under its sibling example's configuration; it is an
expectation the build must meet, so it is a test and belongs in the red
commit (the example scenarios themselves come with a later decision). The
example's `<slug>.config.ts` is shipped configuration and may not.

The check cannot count what a scenarios file asserts, so it guards it
deterministically instead: a scenarios file the red commit adds or changes
may afterwards be changed only by test-only commits, as the supersession
record may. A merge whose version of the file equals one parent's passes;
any other merge counts by the paths it changed itself. The limits: the check
never reads a scenarios file, so a test-only commit may still change or
delete one; each one changed since the red commit is printed as a note, and
the final reviewer reads its diff from the red commit. A rename is not
followed: a commit that moves the file touches it, and fails unless it is
test-only.
