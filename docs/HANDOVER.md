# Handover — the Bounded Harness developer stage

2026-10-01 addendum (the hexagonal monorepo rework, ADRs 2026-056 to 2026-064,
TN-26-012 — read this one first): a TypeScript project is now built in the
shape of a worked example: a Bun monorepo of bounded contexts
(`contexts/<context>/src/{domain,application,adapters}`) and apps
(`apps/<app>/src`), with colocated `*.test.ts` files.

**What changed.**
- **Layout is pack content.** The core no longer knows `src/` or `tests/`:
  source roots, test-file suffixes and generated-file globs are pack data.
  Blindness is by file name: the builder may list test names but never read
  one, and a content search needs a glob that provably misses the other side
  (for the TypeScript suffixes, an inclusion glob such as `*.handler.ts`;
  `!*.test.ts` alone is refused).
- **The contract owns the name.** Domain contracts are `interface <Name>` plus
  `<Name>Factory` with `parse` returning `Result`; the implementation hides a
  `<Name>Impl` behind a fixed two-export tail. Feature contracts hold the
  input, command, in port and per-feature out ports.
- **Everything mechanical is generated** from contracts and two JSDoc tags
  (`@exposedVia` on the in port, `@implementedBy` on non-store out ports):
  barrels, command files, every in adapter (tRPC, MCP, Lambda), Drizzle
  config, and law suites. Handlers, stores, out adapters and composition roots
  are skeletons the builder fills. Apps are declared in the ticket TN's
  `workspaces:` map.
- **Bun is the project toolchain** (`bun install`, `bun test`,
  `bunx tsc -p tsconfig.json`); npm, Vitest, Vite and SQLite are retired for
  projects. The harness itself stays on Node and npm.
- **Store tests need Docker at green** (ADR 2026-064); red skips them with a
  logged reason.
- **`bounded init`** with no `--pack` composes every installed capability
  (`ts`, `ts-hexagonal`, `ts-trpc`, `ts-mcp`, `ts-lambda`, `ts-web`,
  `ts-desktop`, `ts-drizzle-postgres`) and names the package scope after the
  project directory (`@<project-dir>`). Its root files match the worked
  example's, apart from the harness's own.
- **The role briefs and skills** were rewritten for all of the above; the doc
  drift test pins each rule to the brief that must teach it and refuses the
  retired layout and toolchain in every role document.

**The next dogfood run.** `docs/dogfood/pm-notes-prompt.md` is the worked
example's product (projects and notes) in product language.
`scripts/dogfood/reset --init <host> --harnessed docs/dogfood/pm-notes-prompt.md`
builds the arm with `bounded init`; afterwards
`BOUNDED_EXAMPLE_PROJECT=<example> node scripts/dogfood/structure-compare.ts <arm>`
reports every structural delta against the example (the archive script writes
the same report into `.run/STRUCTURE.txt`).

**Known gaps going in.** The worked example itself is incomplete: no Drizzle
stores, in-memory composition roots, no tests beyond the architecture test,
and no `@accepts` examples on its value objects, so a faithful run will show
deltas the example, not the run, owns. Its web app seeds sample projects in a
`seed.ts` the prompt does not ask for. The gate scripts (red, green, deliver,
obligations) are being moved onto the monorepo in parallel; the briefs teach
the `Result`-based boundaries block, and the obligations gate's own message is
authoritative until that lands. The generated `AGENTS.md` does not yet carry
the example's Bun guidance.

---

2026-09-18 addendum (#16, ADR 2026-034 — read after the 09-11 one): enforcement
is now host-portable. Every artifact gate is one CLI, `bounded gates <gate>`
(`agent/src/gates-cli.ts` over the registry `agent/packs/ts/gates.ts`), and the
pi tools read the same registry; capability constraints live per host —
`agent/extensions/` for pi, `agent/hosts/claude-code/` for Claude Code (a
`PreToolUse` hook, generated agent definitions, a bash policy derived from
`ROLE_TOOLS`). Each run's guard log opens with a `host` line saying which host
ran it and what it enforced. The Claude Code adapter is verified by fixture
only; its first live run is the next dogfood entry, and its README lists the
honest limits.

Also fixed on the way: `npm run check` never completed on Linux. The
guard-log test's "unwritable path" was under `/proc`, where mkdir answers
ENOENT with the parent present and Node's recursive mkdir loops forever — a
hang, not a throw, invisible on macOS (no `/proc`). CI runs ubuntu-latest, so
every "main green" below was a local verdict; the test now uses a regular
file as the parent and the suite completes everywhere.

---

2026-09-11 addendum (r16–r19 — read this one first): state of `main` after four
harnessed pairs across three days. The arc and every number are in
[dogfooding.md](dogfooding.md) (Runs 16–19 section); this is the state it left.

**Where it landed.** r19 is the capstone: both arms delivered **headless**
(`pi -p`), **zero human intervention, zero escalations, zero restarts**, each
passing its own `npm run check`. anthropic (opus-5 / sonnet-5) GREEN 211/211,
design 20m08s / total 33m06s, mutation 90%, ONE review cycle. kimi (k3 / k2p7)
GREEN 208/208, design 15m09s / total 23m26s, mutation 100%, ONE review cycle, a
decomposed multi-file design — its first clean end-to-end run ever. Two very
different models delivered the same architectural shape: **cross-model
convergence** is the result to carry forward.

**Mechanisms that landed across these runs**, each motivated by a run:

1. **Green catches skeletons** (r16, commit `7729c3c`). `green_gate` now runs
   the dead-skeleton scan itself. r16's anthropic arm shipped a `billing.ts`
   whose exports no test imported, still `NotImplementedError`, and green passed
   it 179/179 twice — only `deliver`'s import census caught it. The backstop
   should not be the first thing to look.
2. **Run-start binds to the architect** (r16 → r19, commit `7729c3c`). r16's
   kimi run-start marker bound to a subagent session and skewed the phase card;
   the marker now binds to the architect's session.
3. **Value-object laws filter hostile inputs by base type** (r17, commit
   `215dc08`). The generated law suite asserted every VO rejects 0 and −1;
   numeric VOs whose ranges include them (Kelvin 0–80, Percent 0–100) must
   accept them. First bug found by a *real* application slice (the PKE
   heating-cockpit). The architect refused to bend `parse` to a wrong test and
   escalated, because the fix was in the pack.
4. **One-round-trip review** (r18, commit `0d1bdab`, amends ADR 2026-020).
   Review is a single fresh-eyes challenge, not a byte gate: across r15–r18 no
   later review cycle caught a defect the first pass missed, and byte-freshness
   policed the *trusted* architect's own edits. Freshness relaxed to the file
   SET. r18 anthropic spent ~20 of 43 design minutes in the polish loop; r19
   ran one cycle and design halved.
5. **`__conformance` is `Pick<…>` of the exports it carries** (r18, commit
   `b684e17`), and **value objects live in their own contract file** (ADR
   2026-026, lint `bounded-ts/value-objects-own-contract`). A single-file
   contract mixing value-object classes with functions scaffolded to
   non-compiling code (`__brand` clash); decomposition is now enforced as a
   contract-shape rule the architect meets up front. r18's kimi arm hit this and
   stalled; r19's kimi arm was steered multi-file proactively.

**Standing state.** `main` green. Both arms deliver headless and pass their own
`npm run check`. The mutation-score measure-loop (measure → add tests → re-red →
re-green) ran clean and headless to 100% on r19 kimi.

**What is still queued / unproven.**
- **Adversarial inspection of a clean run.** r19's code was NOT inspected line
  by line the way r15 was — its quality is asserted from green + mutation +
  sign-off, not a hostile read. r15's deep inspection found composition defects
  shipped green; r19 has had no equivalent. Green + high mutation is not proof of
  domain correctness. This is the highest-value next check.
- **The post-red suite adversary** (issue #13) — a reviewer over the tests once
  the red stands — remains unbuilt; ADR 2026-020 leaves it open.
- **Integration.** Still one component, one worktree, one language. Several
  components / architects / a merge is untested.
- **Timing hygiene.** r16 per-phase splits are unreliable (subagent-bound
  marker, now fixed); r17 cards carried no timing; verify the r19-era marker on
  the next batch.

---

2026-09-09 addendum (r15 wave): state of `main` after the
run-15 pair and the fix wave it produced. Run 15 is written up in
[dogfooding.md](dogfooding.md); the twelve numbered findings there are what
each of these closes.

1. **One class identity per value object** (ADR 2026-023). A contract imports
   cross-component types from the implementation module (`../values/values.js`),
   never from another `*.contract.ts`; the scaffolder refuses the
   contract-to-contract form at scaffold time and names the replacement import.
   r15 lost ~44 of one arm's 76 live minutes to the second identity.
2. **The scaffolder cannot clobber.** A skeleton is written only where the
   target is absent or is itself generated; a file with real content is skipped
   loudly. r15's mid-loop re-freeze overwrote two finished implementations, one
   of them 28 minutes of work. Revising a contract mid-loop is now cheap — it
   still voids the review and the red, and nothing else.
3. **`deliver` installs its `ts-morph` pin and then runs the target's own
   `npm run check`**, blocking on a failed install or a red check. Both r15
   repos shipped with a check that died on `ERR_MODULE_NOT_FOUND`. The
   dependency is a sanctioned exception to any target's no-new-deps rule: one
   checker copied verbatim beats an untested twin.
4. **`typecheck` is scoped by role.** Workers and the reviewer see their own
   zone plus the shared interface in full; everything else is a count and an
   owner. r15's builder shipped a re-export it inferred from a `tests/**`
   diagnostic. "Clean in your zone" is never rendered as "OK".
5. **Surface-check accepts type-only satisfaction** of type-only contract
   exports; only value declarations need a runtime export.
6. **Timing tells the truth about the clock and about blocks.** A `run-start`
   guard event at the first gated call starts the clock (both r15 arms charged
   ~14 minutes of provider outage to DESIGN); `friction:` counts refusals only,
   target 0; `iteration:` counts worker red-loops as the normal work they are;
   overlapping workers print as one `workers (tests ∥ build)` row.
7. **`sleep` and `mutation_score` join the architect's tools.** `sleep` (1–120s)
   is how you wait out a subagent when pi's attention flag sticks and
   `subagent_wait` stops blocking — r15 used `design_gate` as a clock five times
   for want of it. `mutation_score` is advisory and runs before `sign_off`; its
   survivors are carried into the sign-off findings.
8. **The reviewer's checklist is eight items, not five.** Compose every
   operation pair; cross every enum-valued field; run `typecheck` and call a
   non-compiling tree a blocker. r15 shipped two composition defects green and
   recorded a "no findings" review over a tree with 14 type errors.

**What r16 measures.** Whether the one-identity rule removes the impasse class
outright (the honest test is a design that *would* have reached for
`x.contract.js`); whether `deliver`'s final check ever blocks, and on what;
whether scoped typecheck changes what the workers ship, or only what they see;
the friction/iteration numbers under the new split, with friction expected at or
near 0; mutation scores as a standing measurement rather than two hand-graded
points; and whether the reviewer's two new crossing items catch the class of
defect that shipped green in r15. Set the arms with
`scripts/dogfood/reset --design-model … --worker-model …`.

---

2026-09-09 addendum: state of `main` after the r13/r14 mechanism wave. Six
changes landed, all with tests, all motivated by a numbered finding in
[dogfooding.md](dogfooding.md) (Runs 13–14 section):

1. **Red runs in a shadow project.** `red_gate` rebuilds `.bounded/shadow-red` from
   the contracts, tests and config, regenerates the skeletons there and proves
   red in it — never reading live `src/`. A valid red is therefore
   establishable at any moment.
2. **Green is bound to the red in both directions.** The standing red must be
   after the last freeze AND carry a `tests/` tree hash equal to the current
   one; a test edited after a red voids it, and that route is `→ test-writer`.
3. **The workers are parallel** (ADR 2026-021). No ordering between
   test-writer and builder; the phase gate refuses multi-spawn forms
   (`workflowScript`, `chain`, `parallel`) naming a pipeline role, and refuses
   `delegate` inside a pipeline session, so every spawn stays one readable
   child.
4. **Forbidden tools are stripped, not refused.** A bound session loses them
   from the visible toolset at `session_start` (`tool-strip` guard event);
   `bounded ticket` also excludes them at launch.
5. **Two model tiers.** `.bounded/dev-stage-models.json` names `designModel`
   (architect, reviewer) and `workerModel` (test-writer, builder), injected at
   spawn time, logged as `model-tier`, never fatal (ADR 2026-022).
6. **Scaffolder syncs, re-freezes fail fast, friction is printed.** Deleting a
   contract deletes what it generated (marker-gated; a blocked run prunes
   nothing); a re-freeze checks review freshness before spending a pass; every
   delivery timing block ends with a `friction:` line, target 0.

Standing state: `main` green at ~1,290 tests; every gate has fired live at least
once. Items 1–3 of "What is built but not finished" below are closed by this
wave — `redGateProjectPlan` is wired, the role-file route no longer shows
`bash`, and the skill now says the architect may override a route it can see is
wrong.

**What the next runs measure:** parallel workers (does max(TEST, BUILD) show up
as wall clock?) and the model tiers — opus-5/sonnet-5 in the judgment seats
against kimi-k3/k2.7 in the production seats, set per arm with
`scripts/dogfood/reset --design-model … --worker-model …`.

# Earlier handover — after dogfood Run 12

2026-09-04 addendum: Runs 7-12 are written up in docs/dogfooding.md (the
six-cell experiment section is the state of the evidence). Standing state:
main green at 877+ tests; every gate has fired live at least once; the
six-cell grid (opus/sonnet/kimi x harness/guidance) is archived as r10-*..r12-*
with gradings in the branch commit messages. The mutation matrix says blind
test-first buys ordering coverage, in-run adversarial pressure, and evidence —
not raw assertion quality. Open next: timing (target <20 min), composite
design gate, bounded ticket default, mutation-score gate.

# Original handover (Run 6) — the method below still holds

Written 2026-09-02. State: `main` at `2d2268b`, 598 tests green, live checkout
synced. Read `docs/dogfooding.md` (Run 6 section) and issue #12 first — this
file is the *method*, those are the *evidence*.

## Where the project actually stands

The developer stage works end to end. Run 6 reached green: 83 tests, 7
contracts, 25 exported functions, type-clean, on the third attempt. The two
voided attempts were both harness bugs of ours, not model failures.

**The honest state of the evidence** — this matters more than the feature list:

- **Proven and repeatable:** the deterministic gates, and value objects at the
  boundary (3 consecutive runs, decisive every time).
- **Weakened this run:** the tautological-invariant finding, which was the
  single strongest argument for blindness. Two bare arms wrote one in Runs 4
  and 5; Run 6's bare arm did not. It is now 2 of 3, and the write-up says so.
- **Newly measured:** the spec's unique contribution is **execution order**.
  83 tests written with no spec still covered replay and arithmetic well and
  contained *zero* precondition-ordering tests.
- **Still unproven:** the architect as a source of design quality. ADR 2026-014
  stands — taste did not survive a model change, procedure did.

Do not overstate the case for the harness in future write-ups. The most useful
thing this project produces is *measurements that can go against it*.

## The method that has worked

**1. Fix what is factually wrong before adding advice.** The single largest
design improvement all day came from correcting "one component contract" to "as
many files as the design needs" — the glossary, the glob, the scaffolder and
the manifest all said plural. One god-interface became 7 focused contracts,
same prompt, same model. No design guidance achieved anything comparable.

**2. Enforce with mechanism, never with prose.** Every rule that held was a
gate. Every rule that was only written down was skipped — the spec 4 times out
of 4, the "don't read your skill from ~/.pi" instruction every single run. When
you catch yourself writing "the skill should tell it to…", ask what would
refuse it instead.

**3. Guidance, when unavoidable, is a checklist anchored to a gate call.** Per
ADR 2026-014: give it a trigger ("before you run `design_gate`…"), a stop
condition, and greppable phrases so its fingerprint can be looked for in the
output later.

**4. Silent failure is the enemy.** Every void run today was silent: a `: ` in
YAML deleted a skill from every session; a contract with no runtime exports
passed four gates; case-sensitive globs refused `SPEC.md`. Nothing errored.
When a mechanism can fail invisibly, it gets a test — `skill-frontmatter.test.ts`
exists for exactly this reason.

**5. Verify agents' work independently.** Both subagents used today did good
work and one found a subtler root cause than briefed. Both were still checked
against a live repro before their commits landed.

## Mistakes to avoid repeating

- **Never declare an outcome from an intermediate state** — a supervising
  agent twice did: inferred a
  missing builder from an absent `_meta.json` (it just hadn't been written yet),
  and called a deadlock permanent while the architect was still working. It
  recovered. *List the directory; don't infer from an absent file.*
- **A unit test that passes can still prove nothing.** The first bound-role fix
  passed all six of its tests and changed nothing live, because the flag was in
  module scope and the two extensions load through different module registries.
  For anything crossing a process or extension boundary, the check is a live
  spawn, not a unit test.
- **Backticks in a `git commit -m "…"` string execute as command substitution.**
  Use `git commit -F -` with a quoted heredoc.
- **`.gitignore` silently swallowed `agent/bin/`.** `git add -A` reported
  success and the file stayed untracked. Check `git check-ignore` when a new
  file "doesn't appear".

## Working agreements

- Test-first. `npm run check` stays green. Work in the worktree.
- "Push" = `git push origin <branch>:main`, then in
  the live checkout (the target of `~/.pi/agent`): stash → `merge --ff-only
  origin/main` → stash pop. The live checkout may hold uncommitted local
  work — never clobber it.
- **Never push while a dogfood arm is running.** It resolves gates through
  `~/.pi/agent` → the live checkout. This contaminated Run 4.
- Pack-internal imports use `.ts` extensions. Never run bare `vitest`.
- Commit messages: what was wrong, why it mattered, what the evidence was.

## Running a dogfood arm

```bash
scripts/dogfood/reset         # both arms; --bare / --harnessed for one
cd ~/dev/bounded-harness-dogfood-2        # Claude Code, paste PROMPT.md
cd ~/dev/bounded-harness-dogfood-1   # pi --model sonnet, paste PROMPT.md
```

Three directories, forever (the paths above are the scripts' defaults;
`DOGFOOD_1`, `DOGFOOD_2` and `DOGFOOD_ARCHIVE` override them). The archive
repository holds every past run as a branch, pushed to a private remote. **Pin the model explicitly** — the
default is `kimi-k2p7-code` and it has silently claimed several runs.

Archiving is automatic: `scripts/dogfood/reset` auto-saves any arm holding output to
`auto/<arm>-<timestamp>` before wiping it, so a reset can no longer destroy a
run. To name a run yourself:

```bash
scripts/dogfood/archive r13-opus-harness --arm harnessed -m "one-line finding"
```

Either way the branch carries the produced tree plus `.run/` — the prompt used,
the session transcripts (pi, vanilla-config pi, and Claude Code), and
provenance. Keep prompts and transcripts out of the live arm: an agent that
reads its own prompt or a previous transcript mid-run is a contaminated run.

To run a gates-off (guidance-only) arm, point pi at a vanilla config dir:

```bash
export PI_CODING_AGENT_DIR=~/.pi-vanilla/agent   # auth + models symlinks only
```

## What is built but not finished

1. **`redGateProjectPlan` is not wired.** The plan and its tests are in
   `red-gate.ts`; `runRedGate` still runs against the live tree. Wiring it is
   what actually unlocks the test-writer and builder working in parallel
   (~10 min of a 30 min run). **This is the highest-value next task.**
2. **The role-file route still shows `bash`** to the model — blocked on call,
   about one wasted turn. Only a launch flag can strip it, so `bounded ticket` stays
   the stricter route. Decide whether to make it the default.
3. **The skill still says "do not improvise a target"** while Run 6 only
   escaped its deadlock *because* the architect ignored that. The green-gate
   reroute now handles the known case; the instruction should acknowledge that
   the architect may override a route it can see is wrong.

## Open questions, unchanged in priority

1. **Where does design quality come from?** Not the role, not the instructions.
   The reviewer is still the bet, and still unbuilt. If it fails too, the honest
   answer may be that quality comes from the model and should be bought.
2. **Integration.** Everything proven is one component in one worktree. Parallel
   workers merging back is untested.
3. **The review role's shape.** Natural form is the adversary: sees everything,
   tries to break the suite without touching the implementation.
