# Run 5 — Sonnet · subscription-billing · bare vs harness · PLANNED
Pre-registered before either arm runs. Same domain as Run 4
(`docs/dogfood/subscription-billing-prompt.md`), **Sonnet throughout**, prompt **byte-identical
in both arms** — the only variable is the environment.

Layout: one repo, `~/dev/dogfood-billing`, two git worktrees on branches off a
shared baseline. Each arm has one setup commit; score its output as the diff
from that commit. Each arm carries an `AGENTS.md` with an **identical**
operational block (layout, toolchain, `npm run check` is the bar, no new
dependencies, don't commit) and exactly one differing line naming what that
environment offers — the method itself lives in the skill, never in
`AGENTS.md`, so an inadequate skill shows up as a result rather than being
papered over by the setup.

- **1 · bare** — `~/dev/dogfood-arm1-bare`. Claude Code, one agent, no skills.
  *"Nothing special. Build it with your ordinary tools, the way you think it
  should be built."*
- **3 · harness** — `~/dev/dogfood-arm3-harness`. pi, full `developer-stage`
  pipeline: three blind roles, deterministic gates, scaffolder, path gate.
  *"This project is built through the `developer-stage` skill. Invoke it and
  follow it."*

**A skill-only middle arm was planned and dropped before running.** The intent
was to decompose the bundle: does the quality come from the authoring skill or
from blindness? But the arm as built gave the single agent only
`ts-contract-authoring`, while most of the harness's guidance now lives in the
three agent definitions (the architect's design judgment, the test-writer's
enumeration method, the builder's craft rules). That arm would have carried
roughly a fifth of the harness's advice, understating the cheap intervention
and flattering blindness. **The decomposition question therefore remains
open.** A faithful version would hand a single agent the combined guidance
from all three agent defs with no blindness, gates or orchestration — worth
building for a later run.

Scored on Run 4's criteria, unchanged: per-rule coverage, adversarial probes
run against both arms, naked primitives at the boundary, invariants in types
vs prose, ports vs ambient time, `npm run check`, whether the tests graded
their own exam, and cost.

**Fixes in the harness since Run 4** (so arm 3 is not re-running known bugs):
verified gate invocations and a `sleep` ban in the orchestration skill;
`run_tests` non-convergence nudge; a builder dispute budget; orientation
guidance so no role opens with a blocked `ls .`; `no-naked-primitives` live
from the start; and the `developer-stage` skill description rewritten to
trigger on the task shape it serves.

**Aborted first attempts (kept as evidence, branches `arm1-void-firstattempt`
and `arm3-void-noskill`).** Arm 3's first attempt never loaded the
`developer-stage` skill: no subagent spawned, no gate run, no `.pi/` written.
It read `package.json`, said *"Project scaffold already exists. Now I'll build
the full implementation"*, and wrote `src/*.ts` directly — pi behaving as a
single agent. Cause: the skill's description (*"turn an approved plan into
tested code… use when driving a task from plan to green through the
architect/test-writer/builder pipeline"*) only matched a user who already knew
the pipeline existed. A skill that must be known about before it can be found
is not discoverable — the same class of defect as Run 1's silent scaffolder
bug, and visible only because the arms were given identical prompts.

**Known confound.** All three pipeline agent definitions gained personality and
method between Run 4 and Run 5. Run 4's test-writer produced its sharpest tests
with none of it, so any arm-3 improvement over Run 4 cannot be attributed to
blindness alone. Watch: whether arm 3's spec comes in under Run 4's 364 lines
without losing the tests that traced to it, and whether the builder disputes
promptly rather than stalling (Run 4 lost ~15 min there).

**Hygiene.** Arms share one repo, so run them concurrently or don't commit arm
output until scoring. Do not push to pi-harness main while arm 3 runs — it
resolves gates through `~/.pi/agent` → the live checkout, which is how Run 4's
harness arm got contaminated mid-flight.

**Result: the harness arm is decisively better on test quality, and the bare
arm's failure mode reproduced exactly.** Both shipped working, type-clean code
— arm 1 `31 tests / 3 files`, arm 3 `95 tests / 8 files` plus a 335-line spec.
Every behavioural probe passes identically on both (proration, idempotent
replay, back-dating, cross-currency, post-cancel rejection, invoice/line-item
consistency), and both leak the caller's `Plan` object by reference. On
*behaviour* they are equivalent. The differences are architectural and, above
all, in the tests.

**1. The tautological invariant reproduced.** Arm 1, independently and on a
different model session from Run 4's control, wrote the same self-confirming
test: it sums `invoice.total` into `summed`, then asserts `totalCharged`
equals it — and `totalCharged` is implemented as that same sum. It cannot
fail. Arm 3's equivalent derives every expected value by hand from the spec's
formula (`proratedAmount(1200, 31, 21) = floor(50431/62) = 813`) and asserts
literals, so a drift in the rounding rule breaks it. **Two bare runs, two
tautologies; two harness runs, none.** This is the clearest evidence yet that
the separation buys something prompting does not.

**2. Precondition ordering: tested by arm 3, absent from arm 1.** Arm 3's
`ordering.test.ts` pins which error wins when several checks would all fail —
*"renew on a cancelled subscription reports back-dated-operation, not
subscription-cancelled, when both would fail"*, and a three-way version. It
also covers replay-after-the-world-moved-on (*"changePlan replay succeeds
after the subscription has since been cancelled"*) and replay-with-different-
arguments. Arm 1 has none of these. This is the test-writer's new enumeration
method (*"one test per check, plus one where two would fail and the earlier
must win"*) firing in its first live run.

**3. Value objects.** Arm 3 branded the whole surface via a `Brand<T,B>`
helper — `CurrencyCode`, `MinorUnits`, `DayCount`, every id, `Description`,
and `CalendarDate` as a branded *string*. Arm 1 has zero branded types and
`export type CurrencyCode = string`, so `"usd" !== "USD"` and `""` is a valid
currency. Arm 1 did, however, avoid Run 4's catastrophic `Date` aliasing bug
by normalising dates on entry — a better bare run than Run 4's control.

**4. Errors as values, per operation.** Arm 3 returns
`{ok:true,…} | {ok:false,error}` with a *distinct* error union per operation
(`RenewError` ⊂ `ChangePlanError`), so the compiler enumerates exactly the
failures each call can produce — more precise than Run 4's single union. Arm 1
throws nine error classes; nothing makes a caller handle them.

**5. Every new mechanism earned its place.** `no-naked-primitives` blocked the
architect's first contract (issue #3's first live firing); the green gate
blocked with `route: builder` rather than declaring a false green (#7); the
`run_tests` non-convergence nudge fired `stuck=True` after the builder hit the
same two failures three times, and it was green one run later — against Run
4's 15-minute stall in the same situation. The red gate recorded a textbook
valid red: 95 NotImplemented failures, 0 passes.

**Cost.** Arm 3 took ~33 min against arm 1's ~19 min, but the harness time is
dominated by stalls, not work: the architect's first run was 446s of which
363s were gaps ≥30s (81% dead air), while its second run did 15 messages in
26s. Excluding stalls the pipeline moves at 3–4s per turn.

**Caveat, recorded plainly.** Arm 3 ran across a mid-run harness change: the
test-writer read-zone fix was synced while its orchestrator was stalled, after
its first test-writer had already died on the old zone. The arm is scoreable
— the fix restored intended behaviour rather than adding capability — but it
is not a clean run, and the value-object and test-quality findings should be
read as consistent with Run 4 rather than as independent confirmation.
