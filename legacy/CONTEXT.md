# The Bounded Harness

An agent-agnostic coding-agent harness (pi is the reference host; other agent frameworks attach via host adapters). Today it runs in developer mode as the live config home — `~/.pi/agent` symlinks here — a stopgap until the harness ships as packaged per-framework extensions. Global scope only: everything here applies to every project on the machine, and the root stays language-agnostic.

## Language

### Structure

**Harness**:
This repository itself — the agent-agnostic harness and its global configuration, symlinked to `~/.pi/agent`, live the moment it changes.
_Avoid_: config, dotfiles, setup

**Pack**:
A language-specific pi package under `packs/<lang>/` holding on-demand skills and scaffolder scripts — never extensions or root config.
_Avoid_: plugin, module, bundle

**Skill**:
A folder with a `SKILL.md` of on-demand instructions, loaded only when its description matches the task at hand.
_Avoid_: prompt, command, macro

**Extension**:
A TypeScript file in `hosts/pi/extensions/` (the pi adapter) that auto-loads on pi session start to add tools or behaviour.
_Avoid_: plugin, hook

### Working method

**Subagent roster**:
The deliberately minimal set of subagents in `agents/`: `scout` (read-only), `delegate` (write-capable worker), and `product-expert` — "the PM" (read-only + web, product judgment). No ad-hoc roles.
_Avoid_: agents (unqualified), roles, personas

**PM**:
The `product-expert` subagent — a product-domain expert instantiated for the current repo's domain, consulted during `expand` for independent product judgment.
_Avoid_: product manager agent, product persona

**Canonical commands**:
The script names every project declares — `check`, `test`, `build`, `lint` — which any agent session looks for first.
_Avoid_: scripts (unqualified), tasks

**Tool-managed**:
Extension files an external tool installs and rewrites under `extensions/`; untracked runtime state, never hand-edited (ADR 2026-006).

**Technical Note (TN)**:
The single document primitive for project thinking — numbered, statused, kinded, ticket-linked. The working surface where ideas develop before ratification into ADRs. Conventions live per-repo in `docs/tn/README.md`.
_Avoid_: spec doc, design doc, RFC

**Expand**:
The divergent first phase of feature work — research, cross-domain parallels, widened requirements, and experienced pushback — held entirely in conversation until synthesised into a TN by `to-tn`.
_Avoid_: brainstorm, discovery phase

**Trunk-based**:
The git workflow: work happens in worktrees on local branches tracking `main`, and "push" means push to remote `main` unless told otherwise.
_Avoid_: feature-branch workflow, gitflow

**Agent state**:
The per-repo, gitignored `.agent-state/` folder holding temporary agent working files — snapshots, workflow state, scratch. Never committed; every capability that writes transient files puts them here.
_Avoid_: .git/ stash, tmp dirs, hidden tool folders

### Developer stage

**Developer stage**:
The pipeline stage that turns a ticket into tested code: an architect that designs and drives, two blind write-capable subagents with disjoint authority — test-writer and builder (TN-26-001), commissioned together after the freeze and running in parallel — and a read-only reviewer that reads the design before it is frozen.
_Avoid_: dev phase, coding step

**Architect**:
The developer-stage role that owns one ticket end to end — designs it, writes the spec and contract, commissions the test-writer and builder, runs every gate, and arbitrates disputes. Reads everything in the project; writes only `spec.md` and `*.contract.ts`. Holds `subagent`, `git` and the gate tools, and no `bash`.
_Avoid_: designer, planner, orchestrator (retired — the architect drives)

**Test-writer**:
The developer-stage subagent that writes tests from spec + contract. Always blind to `src/`, including on revision passes. Runs in parallel with the builder — neither consumes the other's output — and every test it touches after a red voids that red. Its `typecheck` is scoped: `tests/**` and the shared interface in full, everything else a count and an owner.
_Avoid_: tester, QA agent

**Builder**:
The developer-stage subagent that implements to the contract. Blind to test source (no `bash`, no `git` — `git show HEAD:tests/x.ts` would defeat it in one call; sanitized `run_tests` tool); never edits tests or contract files. Runs in parallel with the test-writer: the red gate proves its verdict in a shadow project, so a half-written `src/` can neither spoil a red nor be spoiled by one. Its `typecheck` is scoped: `src/**` and the shared interface in full, everything else a count and an owner.
_Avoid_: developer (that's the stage), worker, coder

**Reviewer**:
The read-only developer-stage subagent commissioned on the spec and contracts before the freeze. Reads the design as the two blind roles will and records findings with `record_design_review`; holds no write zone at all, so its findings are claims for the architect to settle. Its `typecheck` is scoped like a worker's, which for a role that owns nothing means the design in full and every other zone as a count.
_Avoid_: critic, approver, gate (it decides nothing)

**Contract**:
The `*.contract.ts` files colocated with a component — exported interfaces, types, and ports; declaration-only by lint; implemented by the sibling module (`foo.contract.ts` → `foo.ts`). The load-bearing artifact both blind agents code against.
_Avoid_: stubs (that's the generated skeleton), interface file, API doc

**Team lead**:
The role above the architects — fans tickets out to one architect each, and holds no write rights of its own. v2; today a single architect is driven directly.
_Avoid_: manager agent, supervisor, orchestrator

**Gate tool**:
One of the named tools the architect runs a gate through (`contract_purity`, `design_gate`, `check_drift`, `red_gate`, `green_gate`, `sign_off`, `deliver`). Thin wiring over the same `run*` function the CLI calls, so a gate cannot differ by how it was invoked. They exist because the architect has no `bash`. Where several gates have exactly one legal order they are one tool: `design_gate` is purity → scaffold → typecheck → design-review → freeze. `sleep` and `mutation_score` sit in the same toolset and are **not** gates — one waits out a subagent, one measures the suite before sign-off; neither decides a transition, and firing a real gate to pass the time corrupts the run's own record.
_Avoid_: gate script (that's the CLI), command

**bounded ticket**:
The launcher (`bounded ticket`, a subcommand of the `bounded` CLI) that starts a pi session bound to the architect role. Run it in the project directory instead of `pi`. Role binding happens at launch, from outside the project, so nothing in the session can change it, and the architect's forbidden tools are excluded from the session's registry rather than merely refused when called.
_Avoid_: wrapper, alias

**Dispute**:
The builder's formal objection to a test (`DISPUTE`) or contract (`CONTRACT-DISPUTE`) — voice without a pen. Routes builder → test-writer → architect → user; the architect settles it, having read both the disputed test and the spec it cites.
_Avoid_: complaint, override

**Zone**:
A glob-defined region of the repo one role may write to, with a zone lint rule defining what content is legal there.
_Avoid_: folder, boundary

**Scaffolder**:
The machine step that generates the throwing skeleton from a contract (`packs/ts/scripts/scaffold-contract.ts`), run as the second step of `design_gate`. A sync, not an append: the generated set is a function of the contract set, so a skeleton whose contract was deleted is deleted too — the generated marker is the only deletion licence, and a blocked run prunes nothing. Never an agent; drift becomes a compile error, not an assertion.
_Avoid_: generator (unqualified), codegen

**Skeleton**:
The generated sibling implementation (`foo.ts`) whose every export throws `NotImplementedError` (from the shared errors module) until the builder replaces it. The red gate runs against a freshly regenerated copy in the shadow project, never against the one in the live tree.
_Avoid_: stub (use for a single throwing member), contract

**Shadow project**:
The throwaway project at `<project>/.bounded/shadow-red` the red gate builds and runs in — contracts, tests and config copied from the live tree, skeletons regenerated there, `node_modules` symlinked, no implementation file copied at all. Wiped and rebuilt on every red and left behind afterwards as postmortem evidence, until `deliver` removes it at the end of the run. It is what makes a valid red establishable at any moment, and therefore what makes the two workers parallel.
_Avoid_: sandbox, temp project, pristine project (retired)

**Tests-tree hash**:
The sha256 fingerprint of every file under `tests/` that a red-gate pass records and a green refuses to run without matching. It is the second half of green-requires-red: the first says a red exists for these contracts, this one says the red was measured over these tests.
_Avoid_: test checksum (that's the contract manifest's word), fingerprint (unqualified)

**Value object**:
A domain type that replaces a primitive at a contract's public boundary — in
TS a nominal class (private `__brand`, private constructor, `static parse`;
ADR 2026-015) or a string-literal union. Branded type aliases are banned.
Enforced by `no-naked-primitives` and `no-branded-aliases` inside the
contract-purity gate.
_Avoid_: newtype, wrapper type, DTO

**Naked primitive**:
A `string`/`number` used directly as a type on a contract's exported surface —
the design defect `no-naked-primitives` blocks. A bare alias (`type Isbn =
string`) is equally naked: it is assignable from every other string.
_Avoid_: raw type, stringly-typed (use for the symptom, not the check)

**Gate**:
A deterministic command that passes or fails a phase transition — e.g. contract-purity, red-with-right-reason, green. The architect's judgment routes; gates decide pass/fail.
_Avoid_: check (unqualified), lint (that's one gate's mechanism)

**False green**:
A suite that passes while the project does not typecheck. Green requires both, so red-gate and green-gate run `tsc` as well as the suite.
_Avoid_: flaky pass, soft green

**Route**:
The single `route → <role>` line a failing gate prints, naming the furthest-upstream role whose write zone owns the failure. The bounce target is derived from the path gate's own zones, so the named role can always actually make the fix. `route → architect` and `route → orchestrator` both land on the driving session; the latter means no pipeline zone owns the file at all (config, build files).
_Avoid_: assignee, owner (unqualified)

**Host**:
The agent runtime that loads the harness and runs a session in it — pi today, Claude Code as the second. The harness's logic never depends on which; only the host adapter does.
_Avoid_: platform, runtime (unqualified), IDE

**Host adapter**:
The thin, per-host layer that binds the harness's capability constraints to that host's own mechanisms — pi's extensions (`pi.setActiveTools`, the `tool_call` hook, `subagentOnlyExtensions`) or Claude Code's `hosts/claude-code/` (a `PreToolUse` hook, generated agent definitions with `tools:` allowlists and per-agent `hooks:`). Wires the same pure cores (`decide()`, `checkSubagentCall()`, `sessionRole()`); holds no policy of its own (ADR 2026-034).
_Avoid_: plugin, integration, port

**Artifact gate**:
A mechanism that inspects what exists in the tree — purity, design, drift, red, green, sign-off, deliver, mutation score, typecheck, the test run, the recorded review, surface check, scaffold — and so is host-independent by construction. Exposed once, as `bounded gates <gate> [cwd] [--json]`, over one result contract; the pi gate tools read the same registry. A CLI does not enforce who may run a gate: that is a capability constraint.
_Avoid_: check script, Tier A (the tier name is for the ADR, not the prose)

**Capability constraint**:
A mechanism that shapes what a role *can do* rather than what the tree contains — the tool strip, the path gate, the phase gate on spawns, the sanitized worker views. Needs host cooperation, so it can never be a shell command and is exposed per host through the host adapter. A host that cannot enforce one says so in the guard log at run start; gates alone are never reported as blindness.
_Avoid_: guard (that is the log's word for any mechanism), Tier B

**Guard log**:
The append-only JSONL at `<project>/.bounded/guard-log.jsonl` where every deterministic guard records blocks (drift caught) and passes (guard ran). Always on; `BOUNDED_GUARD_LOG=off` opts out.
_Avoid_: audit log, telemetry (unqualified)

**Model tier**:
One of the two per-project model settings in `<project>/.bounded/dev-stage-models.json` — `designModel` for the judgment seats (architect, reviewer), `workerModel` for the production seats (test-writer, builder). Injected as a spawn happens and logged as a `model-tier` guard event, and it beats a model the spawn call passed explicitly — the tier is policy, and the discarded value is recorded. An absent or malformed config only means "no override" and never stops anything; a tier the project DID set and the harness cannot resolve makes the phase gate refuse the spawn. A resume cannot be tiered at all — the tool refuses a model override — so a resumed seat keeps the tier of its launch and logs a note (ADR 2026-022).
_Avoid_: model override, per-agent model

**Friction**:
Tool calls the harness **refused** — the call did not happen: an out-of-zone read or write, a spawn the phase gate declined, a composite's inner step blocking with no route. Counted by the guard that refused them and printed on every delivery timing line, even at zero. Unlike bounces, the target is zero: a non-zero count usually means a zone or an affordance is wrong, not that a role misbehaved.
_Avoid_: blocks (unqualified), overhead, iteration (the other half of the old count)

**Iteration**:
Blocks a worker's own dev tool logged because the code was red — `typecheck`, `run_tests`, `lint-*`, and `git` exiting non-zero on a search that missed. The call happened and told the truth, so this is normal work with no target, printed only when non-zero. Kept apart from friction because one counter covering both made the headline lie: r15 printed 31 "unrouted blocks" of which exactly one was a refusal.
_Avoid_: friction (the refusals), churn, bounce (that's a routed hand-back)

**Change run**:
A new developer-stage run against a tree the stage already delivered — the
spec change edited into the existing `spec.md` and contracts, re-challenged,
re-frozen over the drift it creates, re-red, re-green, delivered as a delta.
Entered by opening the run boundary (ADR 2026-028); resuming an interrupted
run (`pi -c`) is not one.
_Avoid_: brownfield run, incremental run

**Run boundary**:
The driver-side act that ends one run and arms the next on the same tree:
`bounded change-run` archives the guard log (run state) while the manifest, role
binding and model tiers (tree state) survive. Every log-derived gate — review
freshness, the phase gate, green-requires-red, timing — is re-armed by it, and
it refuses to cut through an undelivered run without `--force`.
_Avoid_: log rotation (the mechanism, not the concept), reset

**Run-start**:
The guard event the path gate logs at the **first gated tool call of a session** — the first moment a run is demonstrably doing work. The timing block starts its clock there and names the time, so minutes between a session opening and the prompt landing are excluded instead of being charged to DESIGN. With several, the last one before the first phase marker wins; one appearing after belongs to a second run in a shared log and is ignored.
_Avoid_: session start (that's when the process opened), first event

**Scoped typecheck**:
The role-scoped view of the `typecheck` tool the two workers and the reviewer get: diagnostics in the caller's own zone and in the shared interface (`*.contract.ts`, `spec.md`, the project config) in full; every other diagnostic collapsed to a count plus the owning role, with no path, line or symbol name, and shown lines scrubbed of foreign path tokens. The architect's view is unscoped — it arbitrates and needs everything. "Clean in your zone" is a distinct verdict from "the project compiles", and the tool never prints `OK` over a red project.
_Avoid_: filtered typecheck, partial typecheck, sanitized (that's `run_tests`)

### Reference sets

**Socket**:
An extension point the core (or a foundational pack) defines together with
the machinery that consumes it — typed, owner-branded, born via ADR. The
fixed vocabulary packs plug into (TN-26-005).
_Avoid_: extension point (VS Code's word), hook

**Contribution**:
What a pack supplies to a socket: code-bearing via the typed registry
(`pack.ts`), data-only via `contrib.json`. Only legal across a declared
`dependsOnPacks` edge — the registry makes an undeclared edge a compile
error.
_Avoid_: plugin, registration

**Reference set**:
The fixed, deterministic structure a pack rolls out for one capability —
file layout, payload shapes, serialization, error taxonomy, gates — identical
in every run, so only the genuine design decisions vary. First instance: the
API-service set (TN-26-004).
_Avoid_: template, boilerplate, starter

**Obligation**:
A machine-checkable artifact a composed pack must deliver — existence,
wiring, and build — verified at deliver by a core-owned completeness gate.
Composing a pack is a commitment to produce its layer, not just permission to
use it; an undischarged obligation blocks delivery. Contributed like every
other pack content, via the socket model (TN-26-009).
_Avoid_: requirement (unqualified), acceptance criteria

**Reference component**:
One complete worked example — contract, value objects, tests, implementation
— in a neutral domain, built through the real gates in CI so it can never
demonstrate what the gates reject. Skills point an agent at it to copy the
shape (not the content) when a build begins; being gate-verified is what
keeps the example and the enforcement from drifting (TN-26-008).
_Avoid_: sample, snippet, fixture (that's a test's input)

**Blessed stack**:
The one framework a pack binds to a capability (tRPC for typed frontend
access, zod as schema engine), pack-pinned and pack-installed. Tickets name
capabilities; a ticket naming a different stack is challenged and escalated,
never obeyed (ADR 2026-029).
_Avoid_: default library, preferred stack

**How-stripping**:
The intake act of reworking an incoming spec to pure "what is required",
removing embedded implementation choices and recording what was removed. A
stripped "how" that is a real constraint routes to the user as a product
decision.
_Avoid_: requirement laundering, scope cleaning

**Command / Query (wire)**:
The single value object every mutation (Command) or query (Query) accepts as
its whole payload — nominal class, zod-backed parse, fields composed from
the domain's existing value objects (ADR 2026-030). Writes return an
acknowledgement, never data; ids inside commands are client-produced.
_Avoid_: DTO, request object, params

**Wire form**:
The raw JSON shape a value object emits from `toJSON()` and accepts back in
`parse` — the round-trip law `parse(toJSON(v)) ≡ v` is generated into its
law suite when the value crosses an API boundary.
_Avoid_: serialized form (unqualified), JSON representation

### Issue tracking

**Board**:
The GitHub Projects v2 board linked to a repo — one per repo, named after the repo.
_Avoid_: project (unqualified), github project

**Status**:
The board's single-select field an issue sits in (Backlog … Done). Distinct from the issue's GitHub state (open/closed).
_Avoid_: column, state

**Epic**:
A board single-select field grouping issues by theme.
_Avoid_: milestone, label

**Capture**:
Creating an issue fast — title, Status Backlog, no assignee. Everything else waits for triage.
_Avoid_: quick-add, jot

**Triage**:
The deliberate act of moving issues out of Backlog — deciding Status, Epic, and Priority.
_Avoid_: grooming, refinement
