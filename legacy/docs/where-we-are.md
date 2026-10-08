# Where we are, and what to keep

## Now (2026-10-01): the hexagonal monorepo

The harness builds TypeScript projects in the shape of a worked example: a Bun
monorepo of bounded contexts and apps, hexagonal layers inside each context,
tests beside the code (ADRs LEG-2026-056 to LEG-2026-064, TN-26-012). What the runs
below proved still holds and is what the rework keeps:

- **Blindness between tests and implementation** — now by file name rather
  than by folder, so tests can sit beside the code.
- **Deterministic gates and the guard log** — now also refusing drift in the
  many files generated from contracts.
- **The contract as the shared interface** — now in the example's
  "contract owns the name" form, with the feature contract also carrying the
  per-feature out ports whose order fixes the handler's constructor.

What is new is how much no agent writes: in adapters, command files, barrels,
config, law suites and app composition roots are generated, so the builder fills skeletons
and writes mappers. The next run (`docs/dogfood/pm-notes-prompt.md`) measures
how close a blind run lands to the example's structure; the structure
comparer in `scripts/dogfood/` is the ruler. [HANDOVER.md](HANDOVER.md) has
the details and the known gaps.

## Run 5 snapshot

> **Historical snapshot — superseded.** Written after dogfood Run 5; the
> numbers and conclusions below are that day's evidence, not the current
> state. For where the harness stands now see the six-cell experiment
> (Runs 10–12) in [the six-cell experiment](dogfood/runs/run-26-010-the-six-cell-experiment.md)
> and [TN-26-002](tn/TN-26-002-mechanism-vs-guidance.md), which measure
> mechanism against guidance across model tiers. Kept because
> [TN-26-001](tn/TN-26-001-developer-stage-pipeline.md) cites it as evidence.

Written after a full day of live runs. Five dogfood runs total, three of them
today on the same prompt (a subscription-billing component with proration,
idempotency and a cross-cutting invariant). Read this as: what did each part of
the harness actually buy?

## The three runs today

| | bare | harness (Sonnet) | harness (Kimi K2.7) |
|---|---|---|---|
| tests | 31 | **95** | 36 |
| test files | 3 | 8 | 1 |
| exported functions | 25 | 11 | **1** |
| ports to fake before testing | 0 | 0 | **5** |
| setup lines before first test | ~20 | 91 | **262** |
| wall clock | ~19 min | ~33 min | ~48 min |
| cost | ~$1 | $2.44 | $1.04 |
| result | green, type-clean | green, type-clean | green, type-clean |

All three produced working code. All three pass identical adversarial probes
(proration cap, idempotent replay, back-dating, cross-currency, post-cancel
rejection). **On behaviour there is nothing between them.** The differences are
in the tests and in the shape.

## What is PROVEN to add value

### 1. Separating the test author from the implementer — the strongest result

This is the finding the whole harness rests on, and it replicated.

Both bare arms independently wrote a **tautological invariant test**:

```js
const summed = sub.invoices.reduce((a, inv) => a + inv.total.amount, 0);
expect(sub.totalCharged.amount).toBe(summed);   // totalCharged IS that sum
```

It cannot fail. Two bare runs, two different sessions, two different days, same
failure. Neither harness arm did this — the harness arm derives expected values
by hand from the spec's formula and asserts literals, so a drift in the rounding
rule breaks the test.

The harness arm also wrote tests no self-testing agent produces:

- *"renew on a cancelled subscription reports back-dated-operation, not
  subscription-cancelled, when both would fail"* — precondition ordering
- *"changePlan replay succeeds after the subscription has since been cancelled"*
- *"changePlan replay ignores a different newPlan supplied on the replaying call"*

The bare arm has none of these. This is not a prompting gap; an agent that wrote
the implementation cannot independently check it. **This is where the value is.**

### 2. Deterministic gates — cheap, no LLM, high value

Every gate earned its place in a live run:

- **Green must include typecheck.** Caught a real false green (suite passing,
  project not compiling) and routed it to the role that could fix it.
- **Red-for-the-right-reason.** Recorded a textbook valid red: 95 failures, all
  NotImplemented, zero passes.
- **Non-convergence detection.** When the same failure set recurs three times,
  the test tool tells the builder to stop guessing and dispute. **It fired twice
  today — once on Sonnet, once on Kimi — and both times the very next run showed
  progress after twenty minutes of no movement.**
- **Contract checksums.** Caught a mid-loop contract revision in an earlier run.

These are scripts. They cost nothing, never stall, and are the highest
value-per-line in the whole system.

### 3. The guard log

Every gate and block writes one greppable line. It is the only reason any of
today's failures were diagnosable. Keep it, whatever else changes.

## What is INFRASTRUCTURE, not a quality win

### The contract

The contract did **not** make the behaviour better — the bare arm, with no
contract at all, produced behaviourally equivalent code.

What the contract does is make blindness *possible*: it is the shared interface
two agents that cannot see each other's work both build against. Without it they
have nothing to agree on. So it is load-bearing, but as **plumbing for the
separation**, not as a quality mechanism in its own right.

Corollary: keep it as small as it needs to be to serve that purpose. It does not
need to be beautiful, it needs to be shared.

### The spec

Also load-bearing, for a narrow reason: it carries what types cannot — execution
order, exact arithmetic with tie-breaking, identity guarantees. Every one of the
harness arm's sharpest tests traces to a spec section with no type-level
equivalent. Two blind agents cannot agree on "round to the nearest cent"; they
can agree on `floor((2n + d) / 2d)`.

But it must never restate the contract. And the separate **plan** step that runs
before it is pure duplication — the plan, the spec and the contract described the
same domain three times at decreasing altitude.

## What is NOT proven

### The architect as a source of design quality

Same architect instructions, two models, opposite outcomes:

- **Sonnet** produced pure functions, zero ports, branded value objects, a
  distinct error union per operation. Clean.
- **Kimi** produced five ports (repositories, a calendar, an idempotency store)
  and a single `createBillingService(ports)` factory over what the prompt
  describes as pure computation. One exported function; 262 lines of fake setup
  before a test can run. A cathedral over arithmetic.

The guidance explicitly warns against exactly this. It was ignored. **Design
quality tracked the model, not the role.** So the architect is needed as the
producer of the shared interface, but it is not yet a reliable source of good
design — and the prose guidance (personalities, design principles) is unproven.

### The value-object rule

It blocked one genuinely weak contract in a live run, which is real. But both
harness arms branded their types heavily, and the bare arm's naked `string`
currency caused no observed defect. Promising, not yet decisive.

## What actively cost us

- **The LLM orchestrator.** ~60 turns per run doing work that is a state machine:
  run gate, read exit code, spawn next role, route on failure — and the gates
  already emit the routing. It also ran `sleep 90` twice, sat in a wait for nine
  minutes, and told a blocked agent that the wall it hit was intentional.
- **The subagent framework.** Three void runs today, none of them because the
  idea was wrong: a skill that would not trigger, a permission rule that denied
  an agent the one file it needed, and multi-minute stalls. Stalls appear in
  100% of subagent transcripts and 0% of plain sessions, across two different
  model providers.
- **Observability.** There is no way to tell a working agent from a wedged one.
  Both look like "silent for six minutes". Most of today's anxiety was this.
- **Zone-policy complexity.** The rule is one sentence — *tests and
  implementation cannot see each other* — but it was encoded as glob arrays with
  per-role exceptions, and one empty array killed a run.

## Where to go

**Keep:** blindness between tests and implementation. The deterministic gates.
The guard log. A contract as the shared interface. A spec scoped strictly to
what types cannot express.

**Cut:** the plan phase. The LLM orchestrator — make the inner loop a script,
and reserve the model for genuine disputes. The unproven prose guidance, until
there is evidence it changes outcomes.

**Change:** enforce blindness at the filesystem rather than in policy config.
Work already happens in worktrees; a worktree the builder can see that simply
does not contain `tests/` is stronger than any rule, is model-agnostic, and
cannot be misconfigured into denying the wrong file.

**Fix:** progress visibility. A heartbeat, or partial output, so a long turn is
distinguishable from a hang.

**Open questions, in order of importance:**

1. **Where does design quality actually come from?** It is not coming from the
   role or the instructions. A reviewer role that attacks the finished work may
   be a better lever than more guidance to the architect.
2. **Integration.** Everything proven today is one component in one worktree.
   Parallel workers merging back is untested, and two tasks touching the same
   contract cannot run in parallel at all — that is a scheduling constraint the
   team lead must respect, and it is checkable deterministically from contract
   file overlap.
3. **The review role.** Not built. The natural shape is the adversary: it can
   see everything, and its job is to break the suite without touching the
   implementation. If it succeeds, the tests were inadequate.

## The one-line version

The separation is worth keeping and the gates are worth keeping. Nearly
everything else is either plumbing for those two things or overhead — and almost
all of the pain has come from the orchestration substrate, not from the idea.
