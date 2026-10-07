# Developing and reviewing this project

Every non-trivial change runs through one light lifecycle, per work item (a
GitHub issue, or a named item such as `core`): plan, plan review, red-first
tests, build, final review, report (ADR 2026-001). Changes to behaviour,
refusals, architecture or contributor policy qualify; typographical fixes need
only the author's own review.

The lifecycle is adapted from the Bounded harness's own (its ADR 2026-068).
Its one mechanical check is the red-first check below.

## Roles

The work runs in subagents. The session that drives it, the
**orchestrator**, never writes code or tests: it briefs the roles, carries
questions to the user, runs the checks, and merges. On Claude Code the roles
are this repository's project agents in `.claude/agents/`:

| Role | Agent | Tools | Writes |
| --- | --- | --- | --- |
| Planner | `planner` | read, search, Bash for reading, write | `.agent-state/<item>/plan.md` only |
| Plan reviewer | `plan-reviewer` | read, search | nothing |
| Builder | `builder` | full, in its own worktree | its branch |
| Final reviewer | `final-reviewer` | read, search | nothing |

The reviewers have no shell, so they cannot change anything; they give repros
for the builder to run. The planner's limits are enforced, not only asked: a
PreToolUse hook in its definition (`scripts/workflow/planner-gate.ts`) allows
writes only under `.agent-state/` and Bash only as one plain read-only command
(`gh` issue and PR reads, read-only `git`, `ls`, `pwd`). On another agent
host, follow the same stages with that host's read-only and write-capable
roles and the agent files above as their briefs. A single developer can play
every role in turn, as long as the red commit and the checks stay mechanical.

## The stages

1. **Plan.** Brief `planner` with the item. It reads the item and the code,
   then grills the open decisions with one question: what here affects the
   longer-term architecture and is unclear? It takes obvious picks itself with
   a one-line reason and returns genuine questions. The orchestrator puts
   those to the user and resumes the planner with the answers. Output:
   `.agent-state/<item>/plan.md`, opening with the item's text copied verbatim
   (the reviewers have no shell to fetch it), then the approach, files, the
   tests to write, and the decisions taken.
2. **Plan review.** Brief a separate `plan-reviewer` with the plan path. It
   checks the plan against `AGENTS.md`, the core/pack split, the layer rules,
   the ADRs and existing patterns. Resume the planner with the findings; it
   folds them in and logs each. Anything still unresolved goes to the user.
3. **Red commit.** Brief `builder` with the plan path and base revision. In
   its own worktree it writes the plan's tests and commits them alone: test
   files, shared test code and fixtures only, failing for the reasons the plan
   gives.
4. **Build.** The same builder implements until `bun run check` is green,
   without weakening the red commit's tests, and reports its branch, red
   commit and check output.
5. **Final review.** The orchestrator runs the red-first check itself, saves
   the branch diff (`git diff main...<branch> > .agent-state/<item>/final.diff`)
   and briefs a fresh `final-reviewer` with the plan, diff, worktree path and
   both check outputs. It returns ranked findings with repros and a verdict.
   While the verdict is `fix`, resume the builder with the findings, re-run the
   checks, and brief a fresh final reviewer on the new diff; an earlier review
   does not cover later changes.
6. **Report and close.** On `Verdict: merge` with both checks green, the
   orchestrator merges the branch into local `main` with `git merge --no-ff`
   (never squash: the red commit is the evidence) and reports.

## The checks

`bun run check` is the project's whole check: `tsc` over every workspace
(strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Biome's
linter, and `bun test`, which includes the architecture test and the
compile-time fixtures that prove an undeclared contribution does not compile.
Mutation testing (StrykerJS, as `bun run mutate`) is planned for a later
slice; once it exists, run it before final review and give the reviewer the
surviving mutants.

## The red-first check

```bash
bun scripts/workflow/red-first-check.ts <red-commit> [<branch>]
```

Run from any checkout of the repository; `<branch>` defaults to `HEAD`. It
exits 0 when all four checks pass, 1 with a `FAIL` line per finding, and 2 on
a usage or environment error. It runs each commit in a temporary git worktree
after `bun install --frozen-lockfile`, so the workspace links point into that
tree.

- **Scope:** the red commit only adds or modifies `*.test.ts` / `*.test.tsx`
  files, `*.test-support.ts` files, fixtures under `testdata/`,
  `fixtures/`, `__fixtures__/` or `__snapshots__/` and `superseded-tests.json`,
  and adds at least one runnable test file.
- **Red:** at the red commit, `bun test` run on each of those test files
  alone fails (a failing test or a file that does not load). A new case that
  already passes inside a failing file is a note.
- **Preserved:** at the branch head, none of the red commit's added or changed
  cases is deleted, skipped (including `todo`, `if`, `skipIf`, `failing`, a
  skipped `describe` or a `.only` elsewhere), emptied, or left with fewer
  assertions. Renamed files are followed. Cases whose text changed at all are
  listed as notes for the final reviewer.
- **Head:** at the branch head, `bun test` on those files exits 0 and, by its
  JUnit report, collects, runs and passes every red case, and sees each make
  at least one assertion.

- **Superseded cases:** when a design change replaces a case an earlier red
  commit owns, the red commit of that change records it in
  `superseded-tests.json` (file, case, successor or `null`, reason). A
  recorded case is exempt from the two checks above; its successor must
  exist, run and pass at the head, and each record is printed as a note for
  the reviewer to judge. A red commit may delete a test file only when every
  case in it is recorded. A red commit that changes the compile-time
  fixtures also runs `compile-time.test.ts`, which must fail at the red commit.
  A record is refused when its case still exists at the head, when a case
  names itself as its successor, when the successor is a computed title (a
  table of cases generated in a loop), when the successor makes fewer
  assertions than the case it replaces, and when any commit after the red
  commit that changed the record is not test-only.

**What a supersession record cannot prove.** A record says a case was
replaced; the check confirms the successor exists, is a single named case,
makes at least as many assertions and passes, and that only test-only
commits changed the record. It cannot tell whether the successor tests the
same requirement, whether a record with no successor was justified, or
whether the reason is true. Assertions inside helpers and in loop tables are
invisible to its counts. Every record is printed as a note: the final
reviewer must read each one against the spec and the replaced case.

**The comparison counts assertions; it never reads them.** A red
`expect(add(1, 2)).toBe(3)` replaced by `expect(1).toBe(1)` passes every
check. So the final reviewer must read every "changed" note against the red
commit. Other limits, listed in the script's header: assertions inside helper
functions are not counted, a case moved to another file or retitled reads as
deleted, and a conformance suite in a `*.test-support.ts` file is checked only
through the test files that run it.

## What the final reviewer checks

- **Behaviour:** does the change satisfy the spec, including invalid inputs,
  every refusal and fail-closed path? Do tests establish the requirement
  independently of the chosen implementation?
- **Extension boundaries:** the core names no technology and holds no
  opinion; new extension points have consumers and ADRs; contributions use
  declared dependency edges, at compile time and at composition. A pack that
  is not selected leaves no trace.
- **Enforcement:** refusals remain closed; a failure is never read as
  "nothing to contribute".
- **Documentation:** README, AGENTS.md and ADRs agree with the code.
- **Repository rules:** no secrets or runtime state, no personal paths, no
  incidental changes to another contributor's work.

An empty finding list is valid when the reviewer states its scope and
remaining uncertainty. A review does not prove domain correctness.

## The record

Keep the plan, the review replies and the check outputs in
`.agent-state/<item>/` (gitignored). The orchestrator's report carries the
minimum record:

```text
Item and acceptance criteria:
Base revision, red commit and reviewed revision:
Plan review: findings and resolutions:
Final review: reviewer, findings and resolutions, verdict:
bun run check, red-first check and mutation score: results and limitations:
Changes since the last review and any follow-up review:
```
