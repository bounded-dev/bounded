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
touches only test files, shared test code, fixtures and shipped and
published packs' example scenarios, that each of its test files fails under `bun test` at that
commit, that at the branch head none of its test cases is deleted, skipped,
emptied or left with fewer assertions, and each still runs, passes and makes
an assertion, and that only test-only commits added, changed or deleted any
example scenarios since (amended by `red-first-scenarios` and
`red-first-published-scenarios`, below). The planner's write and
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
deterministically instead. Scenarios are tests, so they never ride in a
build commit: every example scenarios file that any commit after the red
commit adds, changes or deletes, whether or not the red commit touched it,
may be changed only by test-only commits, as the supersession record may. A
rename counts as both its paths, so a test-only move takes no file out of
the guard. A merge is judged only when its version of the file differs from
every parent's, by the paths it changed itself. The limits: the check never
reads a scenarios file, so a test-only commit may still change or delete
one; each one changed since the red commit is printed as a note, and the
final reviewer reads its diff from the red commit.

## Amended by `red-first-published-scenarios`

A published pack's example scenarios
(`src/published-packs/<name>/packs/<pack>/examples/<slug>.scenarios.ts`,
ADR 2026-030) are treated exactly as a shipped pack's: they may be in a red
commit, and afterwards only test-only commits may add, change or delete one.
A published pack is laid out exactly as a shipped pack, examples included,
so its scenarios are the same kind of expectation.

A scenarios file's verdicts are judged under its sibling configuration
(`<slug>.config.ts` beside it), which is shipped configuration a build commit
may change. Changing it can change what the scenarios mean without touching
them, so for every example scenarios file at the head, whether or not the red
commit touched it and wherever a move took it, the check prints a note naming
both when any commit after the red commit changed or deleted its sibling
configuration. It is a note, not a failure, and the final reviewer reads the
configuration's diff.
