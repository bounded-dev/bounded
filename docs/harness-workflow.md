# Developing and reviewing the harness

Every non-trivial change to the harness itself runs through one light
lifecycle, per GitHub issue: plan, plan review, red-first tests, build, final
review, report (ADR 2026-068, extending the independent review of ADR
2026-038). Changes to behavior, enforcement, architecture or contributor
policy qualify; typographical fixes need only the driver's own review.

The lifecycle is for working **on this repository**. It does not recreate the
developer stage the harness gives target projects: no contracts, no frozen
design, no guard log. Its one mechanical check is the red-first check below.

## Roles

The work runs in subagents. The session that drives it, the
**orchestrator**, never writes code or tests: it briefs the roles, carries
questions to the user, runs the checks, and merges. On Claude Code the roles
are this repository's project agents in `.claude/agents/`, all on Opus:

| Role | Agent | Tools | Writes |
| --- | --- | --- | --- |
| Planner | `harness-planner` | read, search, Bash for reading, write | `.agent-state/<issue>/plan.md` only |
| Plan reviewer | `harness-plan-reviewer` | read, search | nothing |
| Builder | `harness-builder` | full, in its own worktree | its branch |
| Final reviewer | `harness-final-reviewer` | read, search | nothing |

The reviewers have no shell, so they cannot change anything; they give repros
for the builder to run. On another host, follow the same stages with that
host's read-only and write-capable roles (on pi, `scout` and `delegate`) and
the agent files above as their briefs.

## The stages

1. **Plan.** Brief `harness-planner` with the issue number. It reads the
   issue and the code, then grills the open decisions with one question:
   what here affects the longer-term architecture and is unclear? It takes
   obvious picks itself with a one-line reason and returns genuine questions.
   The orchestrator puts those to the user and resumes the planner with the
   answers. Output: `.agent-state/<issue>/plan.md`, covering approach, files,
   the tests to write, and the decisions taken.
2. **Plan review.** Brief a separate `harness-plan-reviewer` with the plan
   path. It checks the plan against `AGENTS.md`, the core/pack split, the ADRs
   and existing patterns. Resume the planner with the findings; it folds them
   in and logs each. Anything still unresolved goes to the user.
3. **Red commit.** Brief `harness-builder` with the plan path and base
   revision. In its own worktree it writes the plan's tests and commits them
   alone: test files and fixtures only, failing for the reasons the plan gives.
4. **Build.** The same builder implements until `cd agent && npm run check`
   is green, without weakening the red commit's tests, and reports its branch,
   red commit and check output.
5. **Final review.** The orchestrator runs the red-first check itself, saves
   the branch diff (`git diff main...<branch> > .agent-state/<issue>/final.diff`)
   and briefs a fresh `harness-final-reviewer` with the plan, diff, worktree
   path and both check outputs. It returns ranked findings with repros and a
   verdict. While the verdict is `fix`, resume the builder with the findings,
   re-run the checks, and brief a fresh final reviewer on the new diff; an
   earlier review does not cover later changes.
6. **Report and close.** On `Verdict: merge` with both checks green, the
   orchestrator merges the branch into local `main` with `git merge --no-ff`
   (never squash: the red commit is the evidence) and reports. The issue
   closes when `main` is pushed, under the trunk workflow in `AGENTS.md`.

## The red-first check

```bash
node scripts/workflow/red-first-check.ts <red-commit> [<branch>]
```

Run from a checkout with `agent/node_modules` installed; `<branch>` defaults
to `HEAD`. It exits 0 when all three checks pass, 1 with a `FAIL` line per
finding, and 2 on a usage or environment error.

- **Scope:** the red commit only adds or modifies `*.test.ts` / `*.test.tsx`
  files and fixtures under `testdata/`, `fixtures/`, `__fixtures__/` or
  `__snapshots__/`, and adds at least one runnable test file.
- **Red:** in a temporary worktree at the red commit, `npm test` in `agent/`
  scoped to those files fails for each of them (a failing test or a file that
  does not load). A new case that already passes inside a failing file is a
  note.
- **Preserved:** at the branch head, none of the red commit's added or changed
  cases is deleted, skipped (including `todo`, `skipIf`, `fails`, a skipped
  `describe` or a `.only` elsewhere), emptied, or left with fewer assertions.
  Renamed files are followed. Cases whose text changed at all are listed as
  notes for the final reviewer.

The comparison parses the files and executes nothing, so it has limits,
listed in the script's header: assertions inside helper functions are not
counted, a changed matcher or expected value is not detected, and a case moved
to another file or retitled reads as deleted. The final reviewer covers those.
Any checkout of the repository can run it, since worktrees share commits; it
adds and removes a temporary git worktree for the red run.

## What the final reviewer checks

- **Behavior:** does the change satisfy the issue, including invalid inputs,
  stale evidence, compatibility and failure paths? Do tests establish the
  requirement independently of the chosen implementation?
- **Extension boundaries:** core mechanisms name no technology; new sockets
  have consumers and ADRs; pack contributions use declared dependency edges.
  A project omitting a pack receives none of its behavior. Check code and
  data contributions, generated output and both host adapters where affected.
- **Enforcement:** refusal paths remain closed, role and path boundaries hold,
  and evidence cannot be reused across a changed design or test suite.
  Separate guarantees actually enforced from instructions that ask cooperation.
- **Documentation:** changed guards appear in the appropriate role briefs;
  command help, skills, ADRs and current-state claims agree with code. Preserve
  historical experiment results as historical evidence.
- **Repository rules:** no secrets or runtime state, no project-specific global
  configuration, no hand-edited package installation state, and no incidental
  changes to another contributor's work.

An empty finding list is valid when the reviewer states its scope and
remaining uncertainty. A review does not prove domain correctness.

## The record

Keep the plan, the review replies and the check outputs in `.agent-state/<issue>/`.
The orchestrator's report carries the minimum record:

```text
Issue and acceptance criteria:
Base revision, red commit and reviewed revision:
Plan review: findings and resolutions:
Final review: reviewer, findings and resolutions, verdict:
npm run check and red-first check: results and limitations:
Changes since the last review and any follow-up review:
```

Include it in the final handoff or, when publication is authorized, the issue
or PR. Do not put machine paths, transcripts containing credentials, or
private run state in tracked documents.

## First self-hosting experiment — planned, not executed

Test whether the developer stage can produce a useful harness component with
less corrective work than a briefed delegate. Start with a bounded pure
component, such as validating contribution manifests, with malformed input,
unknown fields and incompatible versions specified explicitly. Choose an
unimplemented slice after the current composition work settles; do not rebuild
an already completed ticket merely to label it self-hosted.

The harness repository as a whole is not currently arranged as a delivered
contract-based component. Its source is under `agent/`, while the stage's
scaffolding and delivery operate on a target's `src/`, `tests/`, contracts and
package scripts. Running delivery on the harness root is not the first trial.

1. Pin the harness revision and record the candidate issue, API boundary,
   dependency assumptions and common acceptance scenarios. Prepare two
   isolated target projects from the same baseline outside the live config
   home, with identical dependencies and only the required packs. Agree the
   model tiers, time and spend limits before launching paid sessions.
2. In the stage arm, launch `bounded ticket` in the target and use the existing
   developer-stage skill: architect-owned specification/contracts, independent
   design challenge, frozen design, blind test-writer and builder, shadow red,
   green, mutation measurement, sign-off and delivery. Verify the role loader
   and guard events actually enforce the boundaries. Do not claim that a
   generic delegate running gate commands has the same isolation.
3. In the comparison arm, give a briefed delegate the same requirements,
   dependencies and acceptance scenarios. Do not expose either arm's output
   to the other. Record the actual models and tools used; differing model
   assignments limit conclusions about the workflow itself.
4. Inspect both outputs against the same withheld acceptance checks, including
   invalid-input and integration cases. Record elapsed time, token/cost data
   where available, gate findings, manual interventions, defects and corrective
   edits. An independent reader evaluates both outputs and reports limitations.
5. Integrate the selected component into an isolated harness worktree, run
   `agent/`'s canonical check, and obtain the independent review above. Report
   adapter and integration work done outside the stage separately. Only that
   component has been developed through the stage; the whole repository has not.
6. For a subsequent change trial, preserve the delivered target's `.bounded/`
   state and use `bounded change-run` before a new architect session. Restart
   against a pinned harness revision rather than replacing loaded modules
   mid-session. A fresh clone without the manifest needs the adoption work in
   issue #14; do not bypass that gap by manufacturing passing gate evidence.

Record the result under `docs/dogfood/runs/` and link it from the experiment
index only after execution. A failed or interrupted trial is evidence too:
capture the boundary that blocked it and the remaining work. One component
trial cannot establish a general quality or cost advantage.
