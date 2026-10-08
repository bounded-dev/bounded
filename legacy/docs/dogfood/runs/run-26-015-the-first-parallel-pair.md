# Run 15 (2026-09-09): the first parallel pair, and the deepest inspection yet
The first pair to run everything the r13/r14 wave built — parallel workers,
the shadow red, the stripped toolset, two model tiers — and the first pair
inspected line by line afterwards rather than graded from its timing block.
Both arms are harnessed; this is a mechanism run, not a harness-versus-guidance
comparison. Archive branches `r15-anthropic-harness`, `r15-kimi-harness`.

| | opus-5:high design / sonnet-5:medium workers | kimi-k3:high design / k2p7:medium workers |
|---|---|---|
| **Result** | **GREEN 180/180** in ~49 effective minutes | **GREEN 161/161** in ~69 effective minutes (76 live) |
| **Mutation score** (measured after the fact) | 95% | 80% |
| **Logged block** | design 55m27s, tests 8m38s, build 5m43s, wrap 1m10s; total 1h10m58s | design 1h19m55s, tests 5m35s, build 5m28s, wrap 1m44s; total 1h32m41s |
| **Unrouted blocks** | 4 (path-gate 2, lint-src 1, run_tests 1) | 31 (typecheck 13, run_tests 8, git 4, …) |
| **Sign-off findings** | 6, 0 blockers | 4, 0 blockers |

**Parallelism worked, and it is the one result to keep.** Both arms commissioned
the two workers in one turn and gated each as it returned. The opus arm revised
a contract *while the builder was building*, and it cost one `red_gate` call and
zero builder downtime — the shadow red is what makes that true. Note that the
timing blocks above cannot show the concurrency: the phases are defined
contiguously (TESTS runs freeze → first red, BUILD runs first red → first
green), so they never overlap in the analysis even when the workers do. The
`workers (tests ∥ build)` row exists for the day a boundary definition lets it
fire; on these logs it correctly did not.

**The logged design spans are wrong, and that is a finding.** Both arms lost
about fourteen minutes to a provider outage between the session opening and the
prompt landing, and DESIGN silently ate it: 55m and 80m logged for phases that
really took ~33m and ~58m. Neither log carries a run-start marker; the marker
was built because of this.

### What the deep inspection found

Twelve things, in rough order of how much they cost:

1. **Both delivered repos failed their own `npm run check`.** `deliver` added a
   `ts-morph` devDependency for the shipped surface checker and nothing ever
   installed it, so the first thing a colleague typed died on
   `ERR_MODULE_NOT_FOUND`. Nothing in the pipeline had ever run the project's
   own canonical command — `green_gate` runs its own tsc and its own vitest,
   which is not the same statement.
2. **The brand-identity impasse: ~44 of the kimi arm's 76 live minutes.** A
   contract reached a value object through another contract's
   `values.contract.js`, so the operations were declared over the ambient
   `declare class Money` while the only legal constructor — `Money.parse` in
   the implementation — returns a different, nominally distinct type. The
   shadow red came back with 41 `separate declarations of a private property
   '__brand'` errors over a value no test could build by any legal route. The
   architect eventually invented eight `parse*` boundary functions and re-froze
   mid-loop, and signed off recording "red-phase typecheck is unsatisfiable".
3. **That re-freeze then clobbered two finished implementations.** The scaffold
   step overwrote real code in both arms. One survived on a lucky `git add -A`;
   the other rebuilt 28 minutes of work.
4. **`typecheck` leaked past the blindness, and shaped shipped code.** The tool
   returned raw project-wide diagnostics to every caller, so it was a hole in
   the wall `run_tests` and the path gate build — and it leaked in both
   directions. The builder read `tests/billing.test.ts(5,3): … declares
   'CalendarDate' locally, but it is not exported`, reasoned that the tests must
   want a re-export, and added one; that shipped. The test-writer read the
   builder's in-progress implementation the same way ("the current
   `src/billing/billing.ts` is stale…").
5. **A surface-check false positive cost 4m19 and three worker bounces.** The
   check demanded a runtime export for a type-only contract export — an
   interface has no value to export, so it was an impossible instruction.
6. **The wedged reviewer, and `design_gate` used as a clock.** pi flags a child
   as needing attention after 60 seconds with no observed activity, and the flag
   does not clear on inspection: every later `subagent_wait` returned in
   milliseconds saying "attention required". The architect tried `all: true`,
   tried waiting again, and then reasoned — in its own words — "since I don't
   have a sleep mechanism, I'll use `design_gate` as my actual check since it's
   cheap and logged". Five full purity + scaffold + typecheck passes over
   unchanged bytes, each recorded in the guard log as a real design event. The
   reviewer was working fine the whole time.
7. **The sticky attention flag is an upstream pi bug**, and it is what made (6)
   look like the only option available.
8. **Provider outages, ~14 minutes per arm**, charged to DESIGN by a clock that
   started when the session opened rather than when the run did.
9. **Two composition defects shipped green — P2 and P9 in the inspection.** The
   sharpest: a monthly spend cap that a downgrade followed by an upgrade
   defeats, billing a 3000 month against a 1065 cap, with every individual step
   correct against its own clause. Nothing that reads operations one at a time
   can see it. A sibling defect crossed an enum instead of an operation pair —
   a plan change from a monthly interval to a yearly one prorated a year's price
   across a month — and a hole in a conflict payload shipped the same way. All
   of them were legible in the design, and the reviewer's checklist read every
   operation individually.
10. **The mutation survivors mapped onto the prompt's own headline rules.** Not
    obscure corners: the survivors sat on parse-and-guard logic the task
    description had called out by name, which is the useful property — a
    survivor is a specific claim that a shipped line can change with the suite
    still green.
11. **The dispute protocol had its first clean win.** A builder raised a
    dispute with spec evidence, the architect read both sides and settled it,
    and the loop continued. It has existed since v1; this is the first run where
    it did its job with nothing else going wrong around it.
12. **Sign-off confessions keep rising.** The kimi arm's sign-off findings ran
    0 (r13) → 1 (r14) → 4 (r15); the opus arm recorded 6. The gate has always
    accepted an empty list; what changed is that architects are using it.

### The fix wave this produced

Everything below landed after the pair, each motivated by a numbered finding
above:

- **One class identity per value object, and a scaffolder that cannot clobber**
  (ADR 2026-023, findings 2 and 3). A contract may not import types from — or
  re-export types from — another contract; it imports that contract's
  implementation module, which re-exports every type the contract declares. The
  scaffolder refuses anything else at scaffold time with the exact replacement
  import in the message. And the scaffold step writes a skeleton only where the
  target is absent or is itself generated: a file with real content is skipped
  loudly, never overwritten, so revising a contract mid-loop is now cheap.
- **`deliver` installs what it pins, and then asks the repo** (finding 1). The
  `ts-morph` pin is installed and verified, and a failed install is a block.
  The last step runs the target's own `npm run check` and blocks if it is red.
  The added dependency is deliberate and sanctioned: one checker copied verbatim
  from the pack beats an untested twin written to avoid an import.
- **`typecheck` is scoped by role** (finding 4). Workers and the reviewer see
  their own zone and the shared interface — contracts, `spec.md`, config — in
  full; everything else collapses to a count plus the owning role, with no path,
  line or symbol name, and visible lines are scrubbed of foreign path tokens.
  The verdict stays honest in the one shape that matters: "clean in your zone"
  is never rendered as "OK".
- **Surface-check accepts type-only satisfaction** (finding 5). A type-only
  contract export is satisfied type-only; only value declarations are asked for
  a runtime export.
- **`sleep`, and a rule about clocks** (findings 6 and 7). The architect gains a
  `sleep` tool (1–120s), and both its brief and the developer-stage skill now
  say plainly: wait with `subagent_wait`, then `sleep` — never fire a gate to
  pass the time.
- **`mutation_score`, advisory** (finding 10). The architect measures the suite
  before `sign_off` and carries every survivor into its findings. No threshold
  is enforced; the first job is to learn what real runs score.
- **The run starts at the first gated call** (finding 8). The path gate logs a
  `run-start` event at the first gated tool call of a session, and the timing
  block measures from there and names the time it started.
- **Friction and iteration are two counters** (see the r14 amendment above).
  Refusals keep the target of zero; worker red-loops print as the normal work
  they are. Overlapping workers render as one `workers (tests ∥ build)` row.
- **The reviewer's checklist grew three items** (finding 9): compose every
  operation pair, cross every enum-valued field, and run `typecheck` first —
  a tree that does not compile is a blocker, not something to review around.
  r15's cycle-4 reviewer recorded "no findings" while its own typecheck showed
  14 errors caused by the design under review.

### Caveats

Two arms, one task, one domain, both harnessed: mechanism evidence, not a
quality comparison. The mutation scores were measured after the fact by the
tool the run motivated, not during it, so they are a property of the delivered
suites rather than a reading either architect ever saw. And the timing blocks
above are the raw logged ones — the run-start marker that would correct them
did not exist yet.

---
