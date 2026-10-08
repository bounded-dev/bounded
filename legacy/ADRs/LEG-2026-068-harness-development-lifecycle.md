# LEG-2026-068: A development lifecycle for harness work

**Status:** accepted

## Decision

Non-trivial work on this repository runs, per GitHub issue, through six
stages: plan, plan review, red commit, build, final review, report. Subagents
do all of it; the driving session only orchestrates and writes no code.
[The workflow](../docs/harness-workflow.md) defines the stages and the record.
This extends ADR LEG-2026-038: its independent review becomes the final stage, and
a plan review and a red-first discipline are added before it.

The four roles are Claude Code project agents in `.claude/agents/`, all on
Opus: `harness-planner` (writes only `.agent-state/<issue>/plan.md`),
`harness-plan-reviewer` and `harness-final-reviewer` (read and search tools
only), and `harness-builder` (full tools, in its own worktree). They are
tooling for developing this repository, not roles the harness ships, so the
shipped roster of ADR LEG-2026-003 is unchanged.

The builder commits the plan's failing tests alone as the red commit.
`scripts/workflow/red-first-check.ts` checks mechanically that the red commit
touches only test files and fixtures, that its test files fail under the
package's test command at that commit, and that at the branch head none of
its test cases is deleted, skipped, emptied or left with fewer assertions,
and each still runs, passes and makes an assertion under the same test
command. The planner's write and shell limits are enforced by a PreToolUse
hook in its definition (`scripts/workflow/planner-gate.ts`). The orchestrator runs it before final review and merges with `--no-ff` so the
red commit stays in history.

## Why

Issue #45, and part of issue #15. Harness changes landed through ad-hoc
briefed agents with review only at the end, so design mistakes surfaced after
the code existed, and nothing showed that tests were written first or survived
the build intact. The plan review catches architecture problems while they
are cheap; the red-first check turns "tests first, never weakened" from an
instruction into a check, in line with determinism over prompt instructions.

## Consequences

The lifecycle remains a working agreement: the check is not a merge gate or a
CI job, and nothing stops a direct push. The check counts assertions and
never reads them: a replaced, loosened or tautological assertion passes it,
so the final reviewer must read every case it notes as changed. It also misses
assertions inside helpers and reads a moved or retitled case as deleted; the
script's header lists these limits. The reviewers have no shell, so
their repros are run by the builder, which confirms each one fails before
fixing it. The role files are Claude Code's format; other hosts follow the
same stages with their own read-only and write-capable roles. This covers the
review half of issue #15, not developing the harness through its own
developer stage.
